import type { ClientSettings } from "@t3tools/contracts/settings";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "notifications" as ClientSettings["notificationMode"],
  inApp: true,
  focused: false,
  request: vi.fn(),
  sound: vi.fn(),
  toast: vi.fn((_options: { title: string; actionProps: { onClick: () => void } }) => "toast-1"),
  closeToast: vi.fn(),
  open: vi.fn(),
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    select: (s: Pick<ClientSettings, "notificationMode" | "inAppNotificationsEnabled">) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: state.inApp }),
}));
vi.mock("../hubApi", () => ({ requestHub: state.request }));
vi.mock("../environments/primary", () => ({
  resolvePrimaryEnvironmentHttpUrl: (path: string) => `https://hub.example${path}`,
}));
vi.mock("../threadNotifications", async (original) => ({
  ...(await original<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.toast, close: state.closeToast } }));

import { HubApprovalNotificationCoordinator } from "./HubApprovalNotificationCoordinator";

class TestNotification extends EventTarget {
  static permission = "granted";
  static sent: TestNotification[] = [];
  static requestPermission = vi.fn();
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    TestNotification.sent.push(this);
  }
}
let renderer: ReactTestRenderer | undefined;
const row = () => ({
  id: "a".repeat(64),
  purpose: "Publish the maintained fork",
  capabilities: ["ssh:mbp"],
  approval_url: `https://hub.example/access/requests/${"a".repeat(64)}`,
  request_expires_at: new Date(Date.now() + 600_000).toISOString(),
});
async function render() {
  await act(async () => {
    if (renderer) renderer.update(<HubApprovalNotificationCoordinator />);
    else renderer = create(<HubApprovalNotificationCoordinator />);
  });
}
async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T03:00:00Z"));
  Object.assign(state, { mode: "notifications", inApp: true, focused: false });
  state.request.mockReset().mockResolvedValue([row()]);
  TestNotification.permission = "granted";
  TestNotification.sent = [];
  const storage = new Map<string, string>();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", TestNotification);
  vi.stubGlobal("window", { open: state.open });
  vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => state.focused });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("notifies an already-pending approval once across polls and reloads, and opens its passkey page", async () => {
  await render();
  await poll();
  expect(TestNotification.sent).toHaveLength(1);
  expect(TestNotification.sent[0]).toMatchObject({
    title: "Passkey approval needed",
    options: {
      body: "ssh:mbp — Publish the maintained fork",
      tag: `hub-approval:${row().id}`,
      silent: true,
    },
  });
  TestNotification.sent[0]!.dispatchEvent(new Event("click"));
  expect(state.open).toHaveBeenCalledWith(row().approval_url, "_blank", "noopener,noreferrer");
  expect(TestNotification.sent[0]!.close).toHaveBeenCalled();
  await act(async () => renderer?.unmount());
  renderer = undefined;
  await render();
  expect(TestNotification.sent).toHaveLength(1);
  const saved = localStorage.getItem("t3.hub.approval-notifications")!;
  expect(Object.keys(JSON.parse(saved))).toEqual([row().id]);
  expect(saved).not.toContain("mbp");
  expect(TestNotification.requestPermission).not.toHaveBeenCalled();
});

it("closes resolved approvals, ignores stale clicks, and alerts for a new request", async () => {
  await render();
  const old = TestNotification.sent[0]!;
  state.request.mockResolvedValue([]);
  await poll();
  expect(old.close).toHaveBeenCalled();
  old.dispatchEvent(new Event("click"));
  expect(state.open).not.toHaveBeenCalled();
  const next = row();
  next.id = "b".repeat(64);
  next.approval_url = `https://hub.example/access/requests/${next.id}`;
  state.request.mockResolvedValue([next]);
  await poll();
  expect(TestNotification.sent).toHaveLength(2);
});

it("expires alerts even when a poll is stuck, then cancels outstanding work on unmount", async () => {
  state.request.mockResolvedValue([
    { ...row(), request_expires_at: new Date(Date.now() + 3_000).toISOString() },
  ]);
  await render();
  state.request.mockReturnValue(new Promise(() => {}));
  await poll();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(TestNotification.sent[0]!.close).toHaveBeenCalled();
  await act(async () => renderer?.unmount());
  renderer = undefined;
  expect(state.request.mock.lastCall?.[2].aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("uses a persistent in-app review action while focused and cleans it up on approval", async () => {
  state.focused = true;
  state.mode = "notifications-and-sound";
  await render();
  await poll();
  expect(state.toast).toHaveBeenCalledOnce();
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.sound).toHaveBeenCalledWith("input", expect.any(Function));
  state.toast.mock.calls[0]![0].actionProps.onClick();
  expect(state.open).toHaveBeenCalledWith(row().approval_url, "_blank", "noopener,noreferrer");
  expect(state.closeToast).toHaveBeenCalledWith("toast-1");
  state.request.mockResolvedValue([]);
  await poll();
  expect(state.sound.mock.calls[0]![1]()).toBe(false);
});

it.each(["off", "denied", "unsupported", "expired", "other-origin", "script-url"])(
  "does not present browser notifications when %s",
  async (condition) => {
    if (condition === "off") state.mode = "off";
    if (condition === "denied") TestNotification.permission = "denied";
    if (condition === "unsupported") vi.stubGlobal("Notification", undefined);
    if (condition === "expired")
      state.request.mockResolvedValue([
        { ...row(), request_expires_at: new Date(Date.now() - 1).toISOString() },
      ]);
    if (condition === "other-origin")
      state.request.mockResolvedValue([
        { ...row(), approval_url: row().approval_url.replace("hub.example", "other.example") },
      ]);
    if (condition === "script-url")
      state.request.mockResolvedValue([{ ...row(), approval_url: "javascript:alert(1)" }]);
    await render();
    expect(TestNotification.sent).toHaveLength(0);
    expect(TestNotification.requestPermission).not.toHaveBeenCalled();
  },
);

it("allows opting into a still-pending request, and closes alerts when disabled", async () => {
  state.mode = "off";
  state.inApp = false;
  await render();
  expect(state.request).not.toHaveBeenCalled();
  state.mode = "notifications";
  await render();
  expect(TestNotification.sent).toHaveLength(1);
  state.mode = "off";
  await render();
  expect(TestNotification.sent[0]!.close).toHaveBeenCalled();
});

it("recovers from a broker outage without replaying alerts", async () => {
  await render();
  state.request.mockRejectedValue(new Error("Broker unavailable"));
  await poll();
  expect(TestNotification.sent[0]!.close).toHaveBeenCalled();
  state.request.mockResolvedValue([row()]);
  await poll();
  expect(TestNotification.sent).toHaveLength(1);
});

it("keeps deduplication when storage is blocked", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  });
  await render();
  await poll();
  expect(TestNotification.sent).toHaveLength(1);
});

it("still shows a browser alert while focused when in-app alerts are disabled", async () => {
  state.focused = true;
  state.inApp = false;
  await render();
  expect(TestNotification.sent).toHaveLength(1);
  expect(state.toast).not.toHaveBeenCalled();
});
