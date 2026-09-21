// @effect-diagnostics nodeBuiltinImport:off - exercise the real Unix-socket adapter with isolated fixture I/O.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpRouter } from "effect/unstable/http";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { hubRoutes } from "./http.ts";

const credential = "isolated-test-hub-credential-not-a-real-secret";
const config = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    return {
      ...(yield* ServerConfig.ServerConfig),
      mode: "web" as const,
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(credential),
    };
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-hub-http-test-" })));
const auth = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(config),
);
class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}
const routes = Layer.mergeAll(
  hubRoutes,
  HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide(authHttpApiLayer),
    Layer.provide(environmentAuthenticatedAuthLayer),
  ),
).pipe(
  Layer.provideMerge(auth),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(config),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(Etag.layerWeak),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

let directory: string;
let worker: NodeHttp.Server;
const makeApp = () => HttpRouter.toWebHandler(routes, { disableLogger: true });
let app: ReturnType<typeof makeApp>;
const calls: string[] = [];
const approval = {
  id: "a".repeat(64),
  purpose: "Connect Mac",
  capabilities: ["environment:mbp"],
  approval_url: `https://hub.example/access/requests/${"a".repeat(64)}`,
  request_expires_at: "2026-09-21T04:00:00Z",
};
beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-hub-notification-"));
  calls.length = 0;
  worker = NodeHttp.createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/v1/approvals" ? [approval] : []));
  });
  const socket = NodePath.join(directory, "worker.sock");
  await new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.listen(socket, resolve);
  });
  vi.stubEnv("T3_HUB_BROKER_SOCKET", socket);
  app = makeApp();
});
afterEach(async () => {
  await app.dispose();
  worker.closeAllConnections();
  await new Promise<void>((resolve) => worker.close(() => resolve()));
  await NodeFSP.rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const request = (path: string, token = credential, method = "GET") =>
  app.handler(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );

it("requires authentication and proxies only the no-store approval feed", async () => {
  expect((await request("/api/hub/approvals", "")).status).toBe(401);
  expect(calls).toEqual([]);
  const response = await request("/api/hub/approvals?state=active");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual([approval]);
  expect(calls).toEqual(["GET /v1/approvals"]);
  expect((await request("/api/hub/approvals", credential, "POST")).status).toBe(404);
  expect((await request("/api/hub/requests")).status).toBe(404);
  expect(calls).toHaveLength(1);
});

it("requires orchestration read scope and preserves the environment route", async () => {
  const pairing = await app.handler(
    new Request("http://127.0.0.1/api/auth/pairing-token", {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["access:write"] }),
    }),
  );
  expect(pairing.status).toBe(200);
  const { credential: restricted } = (await pairing.json()) as { credential: string };
  const session = await app.handler(
    new Request("http://127.0.0.1/api/auth/browser-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: restricted }),
    }),
  );
  expect(session.status).toBe(200);
  const cookie = session.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const denied = await app.handler(
    new Request("http://127.0.0.1/api/hub/approvals", { headers: { cookie } }),
  );
  expect(denied.status).toBe(403);
  expect(calls).toEqual([]);
  expect((await request("/api/hub/environments/")).status).toBe(200);
  expect(calls).toEqual(["GET /v1/environments"]);
});

it("is inert on unmanaged servers and reports an unavailable broker", async () => {
  vi.stubEnv("T3_HUB_BROKER_SOCKET", "");
  expect(await (await request("/api/hub/approvals")).json()).toEqual([]);
  vi.stubEnv("T3_HUB_BROKER_SOCKET", NodePath.join(directory, "missing.sock"));
  expect((await request("/api/hub/approvals")).status).toBe(503);
  expect(calls).toEqual([]);
});
