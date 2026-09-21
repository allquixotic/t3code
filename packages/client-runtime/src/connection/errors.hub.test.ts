import { expect, it } from "vite-plus/test";
import { RemoteEnvironmentAuthUndeclaredStatusError } from "../rpc/http.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
it("stops retrying an intentionally locked hub endpoint until the next approved lease", () => {
  const failure = mapRemoteEnvironmentError(
    new RemoteEnvironmentAuthUndeclaredStatusError(
      "https://hub.example/hub/environments/mbp/.well-known/t3/environment",
      423,
    ),
  );
  expect(failure._tag).toBe("ConnectionBlockedError");
  expect(failure.message).not.toContain("423");
  expect(failure.detail).toContain("Approve access");
});
it("preserves upstream retry behavior for unrelated statuses and ordinary remote servers", () => {
  for (const [url, status] of [
    ["https://remote.example/.well-known/t3/environment", 423],
    ["https://hub.example/hub/environments/mbp/.well-known/t3/environment", 503],
  ] as const)
    expect(
      mapRemoteEnvironmentError(new RemoteEnvironmentAuthUndeclaredStatusError(url, status))._tag,
    ).toBe("ConnectionTransientError");
});

it("presents the blocked reason so clients distinguish expired access from invalid pairing credentials", async () => {
  const { presentConnectionState } = await import("./presentation.ts");
  const failure = mapRemoteEnvironmentError(
    new RemoteEnvironmentAuthUndeclaredStatusError(
      "https://hub.example/hub/environments/mbp/.well-known/t3/environment",
      423,
    ),
  );
  expect(
    presentConnectionState({
      desired: true,
      network: "online",
      phase: "blocked",
      stage: null,
      attempt: 1,
      generation: 1,
      lastFailure: failure,
      retryAt: null,
    }),
  ).toMatchObject({ phase: "error", blockedReason: "permission" });
});
