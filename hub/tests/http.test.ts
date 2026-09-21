import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { webHandler, workerHandler } from "../src/http.ts";
import { Bao } from "../src/credentials.ts";
import { fixture } from "./fixture.ts";

test("worker approval feed enforces Unix identity and excludes host policy", async () => {
  const { broker, config } = fixture();
  config.worker_uid = process.getuid!();
  const grant = broker.create(config.worker_uid, "Connect remote", ["ssh:remote"], 60);
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hub-approval-feed-"));
  const socketPath = NodePath.join(directory, "worker.sock");
  const server = http.createServer(workerHandler(broker, new Bao(config)));
  server.listen(socketPath);
  await once(server, "listening");
  const request = (headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ socketPath, path: "/v1/approvals", headers }, (response) => {
        let body = "";
        response.on("data", (bytes) => {
          body += bytes;
        });
        response.on("end", () => resolve({ status: response.statusCode!, body }));
      });
      req.on("error", reject);
      req.end();
    });
  try {
    const feed = await request();
    assert.equal(feed.status, 200);
    assert.deepEqual(JSON.parse(feed.body), [
      {
        id: grant.id,
        purpose: grant.purpose,
        capabilities: grant.capabilities,
        approval_url: grant.approval_url,
        request_expires_at: grant.request_expires_at,
      },
    ]);
    assert.equal((await request({ origin: "https://hub.example" })).status, 403);
    config.worker_uid++;
    assert.equal((await request({ "x-worker-uid": String(config.worker_uid) })).status, 403);
  } finally {
    broker.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

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
