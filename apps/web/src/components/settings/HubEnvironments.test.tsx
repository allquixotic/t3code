import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  request: vi.fn(),
  pair: vi.fn(),
  retry: vi.fn(),
  enable: vi.fn(),
  native: [] as Array<{
    environmentId: string;
    displayUrl: string;
    connection: { phase: string; blockedReason?: string };
  }>,
}));
vi.mock("~/hubApi", () => ({ requestHub: state.request }));
vi.mock("~/environments/primary", () => ({
  resolvePrimaryEnvironmentHttpUrl: (path: string) => `https://hub.example${path}`,
}));
vi.mock("~/connection/catalog", () => ({
  environmentCatalog: { retryNow: "retry", setEnabled: "enable" },
}));
vi.mock("~/connection/onboarding", () => ({ connectPairing: "pair" }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: state.native }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: "pair" | "retry" | "enable") => state[command],
}));
import { HubEnvironmentCoordinator } from "./HubEnvironments";
import { publishHubEnvironments } from "~/hubEnvironments";
let renderer: ReactTestRenderer | undefined;
const active = {
  alias: "mbp",
  label: "Mac",
  phase: "active",
  expires_at: "2026-09-21T05:00:00Z",
  http_base_url: "https://hub.example/hub/environments/mbp",
  pairing_code: "test-only-startup-code",
};
async function render() {
  await act(async () => {
    if (renderer) renderer.update(<HubEnvironmentCoordinator />);
    else renderer = create(<HubEnvironmentCoordinator />);
  });
}
async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.native = [];
  state.request.mockResolvedValue([]);
  for (const fn of [state.pair, state.retry, state.enable])
    fn.mockResolvedValue({ _tag: "Success" });
  publishHubEnvironments({ environments: [], error: null, clientErrors: {} });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("polling locked, pending and uninstalled remotes never creates grants or pairs", async () => {
  for (const phase of ["locked", "pending", "unenrolled"]) {
    state.request.mockResolvedValue([{ ...active, phase }]);
    if (renderer) await poll();
    else await render();
  }
  expect(state.pair).not.toHaveBeenCalled();
  expect(state.retry).not.toHaveBeenCalled();
  expect(
    state.request.mock.calls.every((args) => args.length === 1 && args[0] === "environments/"),
  ).toBe(true);
});
it("pairs once for a new approved remote and reuses native credentials on later leases", async () => {
  state.request.mockResolvedValue([active]);
  await render();
  await poll();
  expect(state.pair).toHaveBeenCalledTimes(1);
  state.native = [
    {
      environmentId: "native-mbp",
      displayUrl: active.http_base_url,
      connection: { phase: "error", blockedReason: "permission" },
    },
  ];
  await render();
  state.request.mockResolvedValue([{ ...active, expires_at: "2026-09-21T06:00:00Z" }]);
  await poll();
  await poll();
  expect(state.pair).toHaveBeenCalledTimes(1);
  expect(state.enable).toHaveBeenCalledExactlyOnceWith({
    environmentId: "native-mbp",
    enabled: true,
  });
  expect(state.retry).toHaveBeenCalledExactlyOnceWith("native-mbp");
});
it("repairs invalid native credentials only once per lease without asking for additional access", async () => {
  state.native = [
    {
      environmentId: "native-mbp",
      displayUrl: active.http_base_url,
      connection: { phase: "error", blockedReason: "authentication" },
    },
  ];
  state.request.mockResolvedValue([active]);
  state.pair.mockResolvedValue({ _tag: "Failure" });
  await render();
  await poll();
  await poll();
  expect(state.pair).toHaveBeenCalledTimes(1);
  expect(state.retry).not.toHaveBeenCalled();
  expect(state.request.mock.calls.every((args) => args[0] === "environments/")).toBe(true);
});
