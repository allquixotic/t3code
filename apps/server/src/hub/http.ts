// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import { AuthAccessWriteScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { publishSkills } from "../../../../hub/src/skills-publisher.ts";
class HubTransportError extends Schema.TaggedError<HubTransportError>()("HubTransportError", {}) {}
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";

function brokerRequest(
  method: string,
  path: string,
  signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socketPath = process.env.T3_HUB_BROKER_SOCKET;
    if (!socketPath) {
      resolve({ status: 200, body: "[]" });
      return;
    }
    const request = NodeHttp.request(
      { socketPath, method, path, signal, timeout: 10000 },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 1 << 20) request.destroy();
        });
        response.once("end", () => resolve({ status: response.statusCode ?? 502, body }));
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", reject);
    request.end();
  });
}
export const hubRoutes = HttpRouter.add(
  "*",
  "/api/hub/*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    const scope = request.method === "GET" ? AuthOrchestrationReadScope : AuthAccessWriteScope;
    if (!session.scopes.includes(scope)) return yield* failEnvironmentScopeRequired(scope);
    const url = new URL(request.url, "http://hub");
    let path: string;
    if (url.pathname === "/api/hub/approvals" && request.method === "GET") {
      path = "/v1/approvals";
    } else {
      if (
        url.pathname !== "/api/hub/environments" &&
        !url.pathname.startsWith("/api/hub/environments/")
      )
        return HttpServerResponse.empty({ status: 404 });
      const suffix = url.pathname.slice("/api/hub/environments".length).replace(/\/$/, "");
      if (
        !/^\/(?:[A-Za-z0-9_.-]+(?:\/(connect|disconnect))?)?$/.test(suffix || "/") ||
        !["GET", "POST"].includes(request.method)
      )
        return HttpServerResponse.empty({ status: 404 });
      path = `/v1/environments${suffix}`;
    }
    const result = yield* Effect.tryPromise({
      try: async (signal) => {
        if (
          request.method === "POST" &&
          path.endsWith("/connect") &&
          process.env.T3_HUB_BROKER_SOCKET
        )
          await publishSkills(process.env.T3_HUB_BROKER_SOCKET, signal);
        return brokerRequest(request.method, path, signal);
      },
      catch: () => new HubTransportError(),
    }).pipe(
      Effect.orElseSucceed(() => ({ status: 503, body: '{"error":"Hub broker unavailable"}' })),
    );
    return HttpServerResponse.text(result.body, {
      status: result.status,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
