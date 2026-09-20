import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { webHandler } from "../src/http.ts";
import { fixture } from "./fixture.ts";

test("approval HTTP requires original host, browser cookie, origin and CSRF", async () => {
  const { broker } = fixture(),
    grant = broker.create(1000, "Connect remote", ["ssh:remote"], 60);
  const server = http.createServer(webHandler(broker));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const request = (
    path: string,
    method = "GET",
    headers: Record<string, string> = {},
    body?: unknown,
  ) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, path, method, headers: { Host: "hub.example", ...headers } },
          (response) => {
            let body = "";
            response.on("data", (bytes) => (body += bytes));
            response.on("end", () =>
              resolve({ status: response.statusCode!, headers: response.headers, body }),
            );
          },
        );
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      },
    );
  try {
    assert.equal(
      (await request(`/access/requests/${grant.id}`, "GET", { Host: "evil.example" })).status,
      403,
    );
    const page = await request(`/access/requests/${grant.id}`);
    assert.equal(page.status, 200);
    const cookie = page.headers["set-cookie"]![0]!.split(";", 1)[0]!;
    const state = JSON.parse(
      (await request(`/access/api/requests/${grant.id}`, "GET", { Cookie: cookie })).body,
    );
    const headers = {
      Cookie: cookie,
      Origin: "https://hub.example",
      "Content-Type": "application/json",
      "X-Hub-CSRF": state.csrf,
    };
    assert.equal(
      (
        await request(
          `/access/api/requests/${grant.id}/begin`,
          "POST",
          { ...headers, Origin: "https://evil.example" },
          { ttl_seconds: 60 },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          `/access/api/requests/${grant.id}/begin`,
          "POST",
          { ...headers, "X-Hub-CSRF": "wrong" },
          { ttl_seconds: 60 },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(`/access/api/requests/${grant.id}/begin`, "POST", headers, {
          ttl_seconds: 60,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/access/api/requests/${grant.id}/finish`, "POST", headers, {
          response: "verified-passkey",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/access/api/requests/${grant.id}/finish`, "POST", headers, {
          response: "verified-passkey",
        })
      ).status,
      403,
    );
    assert.equal(
      (await request(`/access/api/requests/${grant.id}/revoke`, "POST", headers, {})).status,
      200,
    );
    assert.equal(broker.status(1000, grant.id).state, "revoked");
  } finally {
    broker.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
