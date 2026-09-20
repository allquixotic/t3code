// @effect-diagnostics nodeBuiltinImport:off
import { request as nodeRequest } from "node:http";
import { AuthAccessWriteScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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
    const request = nodeRequest(
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
export const hubEnvironmentRoutes = HttpRouter.add(
  "*",
  "/api/hub/environments/*",
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
    const url = new URL(request.url, "http://hub"),
      suffix = url.pathname.slice("/api/hub/environments".length).replace(/\/$/, "");
    if (
      !/^\/(?:[A-Za-z0-9_.-]+(?:\/(connect|disconnect))?)?$/.test(suffix || "/") ||
      !["GET", "POST"].includes(request.method)
    )
      return HttpServerResponse.empty({ status: 404 });
    const result = yield* Effect.tryPromise({
      try: (signal) => brokerRequest(request.method, `/v1/environments${suffix}`, signal),
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
