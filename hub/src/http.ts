// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import http from "node:http";
import { readFileSync, chmodSync } from "node:fs";
import { Broker } from "./broker.ts";
import { Bao, providerRequest } from "./credentials.ts";
import { peerUid } from "./peercred.ts";
import { sshExec } from "./ssh.ts";
import {
  fields,
  record,
  text,
  integer,
  id,
  digest,
  equal,
  requireThat,
  json,
  jsonBody,
  message,
  requestBytes,
} from "./io.ts";
import type { EnvironmentManager } from "./environments.ts";

const COOKIE = "__Host-hub-approval";
interface Browser {
  csrf: string;
  expires: number;
  approver?: string;
}
const securityHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "permissions-policy": "publickey-credentials-get=(self)",
};
export function webHandler(broker: Broker) {
  const browsers = new Map<string, Browser>();
  const cookieValue = (request: http.IncomingMessage) =>
    request.headers.cookie
      ?.split(/;\s*/)
      .find((v) => v.startsWith(COOKIE + "="))
      ?.slice(COOKIE.length + 1);
  const cookie = (response: http.ServerResponse, value: string, seconds: number) =>
    response.setHeader(
      "set-cookie",
      `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`,
    );
  const browser = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    create = false,
  ): [string, Browser] => {
    const value = cookieValue(request);
    if (value) {
      const key = digest(value),
        session = browsers.get(key);
      if (session && session.expires > Date.now()) return [key, session];
    }
    requireThat(create, "Approval browser session expired; reload the page");
    for (const [key, session] of browsers) if (session.expires <= Date.now()) browsers.delete(key);
    requireThat(browsers.size < 512, "Browser session limit reached");
    const token = id(),
      key = digest(token),
      session = { csrf: id(), expires: Date.now() + 7200000 };
    browsers.set(key, session);
    cookie(response, token, 7200);
    return [key, session];
  };
  return async (request: http.IncomingMessage, response: http.ServerResponse) => {
    for (const [key, value] of Object.entries(securityHeaders)) response.setHeader(key, value);
    try {
      const path = new URL(request.url!, broker.config.origin).pathname;
      requireThat(
        path === "/access/health" || request.headers.host === new URL(broker.config.origin).host,
        "Approval host mismatch",
      );
      if (request.method === "GET" && path === "/access/health") {
        json(response, 200, {
          status: "ok",
          version: "1.0.0-ts",
          grants_persist_across_restart: false,
        });
        return;
      }
      const asset = /^\/access\/static\/(app\.js|style\.css)$/.exec(path);
      if (request.method === "GET" && asset) {
        response.setHeader(
          "content-type",
          asset[1]!.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
        );
        response.end(readFileSync(new URL(`../web/${asset[1]}`, import.meta.url)));
        return;
      }
      const page = /^\/access\/requests\/([a-f0-9]{64})$/.exec(path);
      if (request.method === "GET" && page) {
        broker.status(-1, page[1]!);
        browser(request, response, true);
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(readFileSync(new URL("../web/index.html", import.meta.url)));
        return;
      }
      const api = /^\/access\/api\/requests\/([a-f0-9]{64})(?:\/(begin|finish|revoke))?$/.exec(
        path,
      );
      requireThat(api, "Route not found");
      const [key, session] = browser(request, response);
      if (request.method === "GET" && !api[2]) {
        json(response, 200, { request: broker.status(-1, api[1]!), csrf: session.csrf });
        return;
      }
      requireThat(
        request.method === "POST" &&
          request.headers.origin === broker.config.origin &&
          equal(String(request.headers["x-hub-csrf"] ?? ""), session.csrf),
        "Approval origin or CSRF mismatch",
      );
      const signal = connectionSignal(request, response);
      if (api[2] === "begin") {
        const body = fields(await jsonBody(request), ["ttl_seconds"]);
        const ceremony = await broker.begin(api[1]!, key, integer(body.ttl_seconds), signal);
        json(response, 200, {
          publicKey: ceremony.options,
          expires_at: new Date(ceremony.deadline).toISOString(),
        });
      } else if (api[2] === "finish") {
        const body = fields(await jsonBody(request), ["response"]);
        const grant = await broker.finish(api[1]!, key, body.response, signal);
        session.approver = grant.approver!;
        session.expires = Math.max(session.expires, Date.parse(grant.grant_expires_at!) + 3600000);
        cookie(response, cookieValue(request)!, Math.ceil((session.expires - Date.now()) / 1000));
        json(response, 200, grant);
      } else if (api[2] === "revoke") {
        broker.revoke(-1, api[1]!, session.approver);
        json(response, 200, { state: "revoked" });
      } else json(response, 404, { error: "Route not found" });
    } catch (error) {
      if (!response.headersSent) json(response, 403, { error: message(error) });
      else response.destroy();
    }
  };
}
export function connectionSignal(request: http.IncomingMessage, response: http.ServerResponse) {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableFinished) controller.abort();
  });
  return controller.signal;
}
export function workerHandler(broker: Broker, bao: Bao, environments?: EnvironmentManager) {
  return async (request: http.IncomingMessage, response: http.ServerResponse) => {
    try {
      const uid = peerUid(request.socket);
      requireThat(uid === broker.config.worker_uid && !request.headers.origin, "Worker denied");
      const url = new URL(request.url!, "http://hub-worker"),
        path = url.pathname,
        signal = connectionSignal(request, response);
      if (request.method === "GET" && path === "/v1/catalog") {
        json(response, 200, broker.catalog());
        return;
      }
      if (request.method === "GET" && path === "/v1/requests") {
        json(
          response,
          200,
          broker.list(
            uid,
            url.searchParams.get("state") ?? undefined,
            url.searchParams.get("capability") ?? undefined,
          ),
        );
        return;
      }
      if (request.method === "GET" && path === "/v1/diagnostics") {
        let signer = "locked",
          unlocker = "unavailable",
          openbao = "unavailable";
        try {
          await bao.checkSigner(AbortSignal.timeout(2000));
          signer = "ready";
        } catch {
          /* diagnostics only */
        }
        if (broker.config.unlock_socket)
          try {
            const r = await requestBytes("GET", "http://hub-unlocker/health", undefined, {
              socketPath: broker.config.unlock_socket,
              signal: AbortSignal.timeout(2000),
            });
            if (r.status === 200) unlocker = "ready";
          } catch {
            /* diagnostics only */
          }
        if (broker.config.bao_url)
          try {
            const r = await requestBytes(
              "GET",
              `${broker.config.bao_url}/v1/sys/health`,
              undefined,
              { signal: AbortSignal.timeout(2000) },
            );
            if (r.status === 200) openbao = "ready";
          } catch {
            /* diagnostics only */
          }
        json(response, 200, {
          version: "1.0.0-ts",
          isolation: "unix_uid_shared",
          checks: { broker: "ready", signer, unlocker, openbao, providers: "require_grant" },
        });
        return;
      }
      if (request.method === "POST" && path === "/v1/requests") {
        const body = fields(await jsonBody(request), ["purpose", "capabilities", "ttl_seconds"]);
        requireThat(
          Array.isArray(body.capabilities) && body.capabilities.every((c) => typeof c === "string"),
          "Capabilities required",
        );
        json(
          response,
          201,
          broker.create(
            uid,
            text(body.purpose),
            body.capabilities as string[],
            body.ttl_seconds === undefined ? 1800 : integer(body.ttl_seconds),
          ),
        );
        return;
      }
      const grantPath = /^\/v1\/requests\/([a-f0-9]{64})(\/revoke)?$/.exec(path);
      if (grantPath && request.method === "GET" && !grantPath[2]) {
        json(response, 200, broker.status(uid, grantPath[1]!));
        return;
      }
      if (grantPath && request.method === "POST" && grantPath[2]) {
        broker.revoke(uid, grantPath[1]!);
        json(response, 200, { state: "revoked" });
        return;
      }
      if (path === "/v1/ssh/exec" && request.method === "POST") {
        const b = fields(await jsonBody(request), ["grant", "host", "command", "timeout_seconds"]);
        json(
          response,
          200,
          await sshExec(
            broker,
            uid,
            {
              grant: text(b.grant),
              host: text(b.host),
              command: text(b.command),
              ...(b.timeout_seconds === undefined
                ? {}
                : { timeout_seconds: integer(b.timeout_seconds) }),
            },
            signal,
          ),
        );
        return;
      }
      if (path === "/v1/provider/request" && request.method === "POST") {
        const b = fields(await jsonBody(request), [
          "grant",
          "provider",
          "method",
          "path",
          "query",
          "body",
        ]);
        const query =
          b.query === undefined
            ? undefined
            : Object.fromEntries(Object.entries(record(b.query)).map(([k, v]) => [k, text(v)]));
        json(
          response,
          200,
          await providerRequest(
            broker,
            bao,
            uid,
            {
              grant: text(b.grant),
              provider: text(b.provider),
              method: text(b.method),
              path: text(b.path),
              ...(query ? { query } : {}),
              ...(b.body === undefined ? {} : { body: b.body }),
            },
            signal,
          ),
        );
        return;
      }
      if (environments && request.method === "GET" && path === "/v1/environments") {
        json(response, 200, environments.list());
        return;
      }
      const envPath = /^\/v1\/environments\/([A-Za-z0-9_.-]+)(?:\/(connect|disconnect))?$/.exec(
        path,
      );
      if (environments && envPath) {
        if (request.method === "GET" && !envPath[2]) {
          json(response, 200, environments.status(envPath[1]!));
          return;
        }
        if (request.method === "POST" && envPath[2] === "connect") {
          json(response, 200, environments.connect(uid, envPath[1]!));
          return;
        }
        if (request.method === "POST" && envPath[2] === "disconnect") {
          environments.disconnect(uid, envPath[1]!);
          json(response, 200, { state: "locked" });
          return;
        }
      }
      json(response, 404, { error: "Route not found" });
    } catch (error) {
      if (!response.headersSent) json(response, 403, { error: message(error) });
      else response.destroy();
    }
  };
}
export async function listenUnix(server: http.Server, path: string) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      chmodSync(path, 0o660);
      resolve();
    });
  });
}
