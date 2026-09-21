import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
// oxlint-disable-next-line t3code/namespace-node-imports -- Node's ESM once export needs a named import in the standalone emitter.
import { once } from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { webHandler, workerHandler } from "../src/http.ts";
import { Bao } from "../src/credentials.ts";
import { fixture } from "./fixture.ts";
import { EnvironmentManager } from "../src/environments.ts";
import { publishSkills } from "../src/skills-publisher.ts";

NodeTest.test(
  "user-side skill publication crosses only the authenticated worker socket and does not request remote access",
  async () => {
    const f = fixture();
    f.config.worker_uid = process.getuid!();
    const manager = new EnvironmentManager(f.broker);
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hub-skill-publish-"));
    const socketPath = NodePath.join(directory, "worker.sock");
    const server = NodeHttp.createServer(workerHandler(f.broker, new Bao(f.config), manager));
    server.listen(socketPath);
    await once(server, "listening");
    try {
      const skill = NodePath.join(directory, ".codex/skills/example");
      await NodeFSP.mkdir(skill, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(skill, "SKILL.md"), "fixture");
      await publishSkills(socketPath, AbortSignal.timeout(5000), directory);
      NodeAssert.equal(f.broker.requests.size, 0);
      f.config.worker_uid++;
      await NodeAssert.rejects(
        publishSkills(socketPath, AbortSignal.timeout(5000), directory),
        /could not be published/,
      );
      NodeAssert.equal(f.broker.requests.size, 0);
    } finally {
      manager.close();
      f.broker.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);

NodeTest.test("worker approval feed enforces Unix identity and excludes host policy", async () => {
  const { broker, config } = fixture();
  config.worker_uid = process.getuid!();
  const grant = broker.create(config.worker_uid, "Connect remote", ["ssh:remote"], 60);
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hub-approval-feed-"));
  const socketPath = NodePath.join(directory, "worker.sock");
  const server = NodeHttp.createServer(workerHandler(broker, new Bao(config)));
  server.listen(socketPath);
  await once(server, "listening");
  const request = (headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = NodeHttp.request({ socketPath, path: "/v1/approvals", headers }, (response) => {
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
    NodeAssert.equal(feed.status, 200);
    NodeAssert.deepEqual(JSON.parse(feed.body), [
      {
        id: grant.id,
        purpose: grant.purpose,
        capabilities: grant.capabilities,
        approval_url: grant.approval_url,
        request_expires_at: grant.request_expires_at,
      },
    ]);
    NodeAssert.equal((await request({ origin: "https://hub.example" })).status, 403);
    config.worker_uid++;
    NodeAssert.equal((await request({ "x-worker-uid": String(config.worker_uid) })).status, 403);
  } finally {
    broker.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

NodeTest.test("approval HTTP requires original host, browser cookie, origin and CSRF", async () => {
  const { broker } = fixture(),
    grant = broker.create(1000, "Connect remote", ["ssh:remote"], 60);
  const server = NodeHttp.createServer(webHandler(broker));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const request = (
    path: string,
    method = "GET",
    headers: Record<string, string> = {},
    body?: unknown,
  ) =>
    new Promise<{ status: number; headers: NodeHttp.IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        const req = NodeHttp.request(
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
    NodeAssert.equal(
      (await request(`/access/requests/${grant.id}`, "GET", { Host: "evil.example" })).status,
      403,
    );
    const page = await request(`/access/requests/${grant.id}`);
    NodeAssert.equal(page.status, 200);
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
    NodeAssert.equal(
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
    NodeAssert.equal(
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
    NodeAssert.equal(
      (
        await request(`/access/api/requests/${grant.id}/begin`, "POST", headers, {
          ttl_seconds: 60,
        })
      ).status,
      200,
    );
    NodeAssert.equal(
      (
        await request(`/access/api/requests/${grant.id}/finish`, "POST", headers, {
          response: "verified-passkey",
        })
      ).status,
      200,
    );
    NodeAssert.equal(
      (
        await request(`/access/api/requests/${grant.id}/finish`, "POST", headers, {
          response: "verified-passkey",
        })
      ).status,
      403,
    );
    NodeAssert.equal(
      (await request(`/access/api/requests/${grant.id}/revoke`, "POST", headers, {})).status,
      200,
    );
    NodeAssert.equal(broker.status(1000, grant.id).state, "revoked");
  } finally {
    broker.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
