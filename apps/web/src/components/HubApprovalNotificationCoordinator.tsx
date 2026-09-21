import { HubPendingApproval } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef } from "react";

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary";
import { useClientSettings } from "../hooks/useSettings";
import { requestHub } from "../hubApi";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../threadNotifications";
import { toastManager } from "./ui/toast";

const storageKey = "t3.hub.approval-notifications";
const decodeSeen = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Finite));
const decodeApprovals = Schema.decodeUnknownSync(Schema.Array(HubPendingApproval));

/** Share non-secret request IDs/deadlines across polls, reloads and other open hub tabs. */
function readSeen(seen: Map<string, number>) {
  try {
    for (const [id, expires] of Object.entries(
      decodeSeen(JSON.parse(localStorage.getItem(storageKey) ?? "{}")),
    ))
      seen.set(id, expires);
  } catch {
    // Memory deduplication still works when browser storage is unavailable.
  }
  for (const [id, expires] of seen) if (expires <= Date.now()) seen.delete(id);
}

export function HubApprovalNotificationCoordinator() {
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inApp = useClientSettings((settings) => settings.inAppNotificationsEnabled);
  const seen = useRef(new Map<string, number>());

  useEffect(() => {
    if (mode === "off" && !inApp) return;
    const controller = new AbortController();
    const alerts = new Map<string, () => void>();
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const clearAlerts = () => {
      for (const close of alerts.values()) close();
      alerts.clear();
    };

    const poll = async () => {
      try {
        const rows = decodeApprovals(await requestHub("approvals", "GET", controller.signal));
        if (controller.signal.aborted) return;
        readSeen(seen.current);
        const pending = new Set(rows.map((row) => row.id));
        for (const [id, close] of alerts) if (!pending.has(id)) close();
        for (const row of rows) {
          const expires = Date.parse(row.request_expires_at);
          if (!Number.isFinite(expires) || expires <= Date.now() || seen.current.has(row.id))
            continue;
          const url = new URL(row.approval_url);
          if (
            url.protocol !== "https:" ||
            url.origin !== new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin ||
            url.pathname !== `/access/requests/${row.id}` ||
            url.search ||
            url.hash ||
            url.username ||
            url.password
          )
            continue;
          const focused = document.visibilityState === "visible" && document.hasFocus();
          const toastEnabled = focused && inApp;
          const desktopEnabled =
            !toastEnabled &&
            hasDesktopNotifications(mode) &&
            typeof Notification !== "undefined" &&
            Notification.permission === "granted";
          const soundEnabled = hasNotificationSound(mode);
          if (!toastEnabled && !desktopEnabled && !soundEnabled) continue;

          let notification: Notification | undefined;
          let toastId: string | undefined;
          let expiryTimer: ReturnType<typeof setTimeout> | undefined;
          const close = () => {
            notification?.close();
            if (toastId) toastManager.close(toastId);
            clearTimeout(expiryTimer);
            alerts.delete(row.id);
          };
          const open = () => {
            const stillPending = alerts.has(row.id) && Date.now() < expires;
            close();
            if (stillPending) window.open(url.href, "_blank", "noopener,noreferrer");
          };
          const description = `${row.capabilities.join(", ")} — ${row.purpose}`;
          if (toastEnabled) {
            toastId = toastManager.add({
              type: "warning",
              title: "Passkey approval needed",
              description,
              timeout: 0,
              data: { hideCopyButton: true },
              actionProps: { children: "Review approval", onClick: open },
            });
          } else if (desktopEnabled) {
            try {
              notification = new Notification("Passkey approval needed", {
                body: description,
                tag: `hub-approval:${row.id}`,
                silent: true,
              });
              notification.addEventListener("click", open);
            } catch {
              // Some browsers expose Notification but reject desktop presentation.
            }
          }
          if (!toastId && !notification && !soundEnabled) continue;
          alerts.set(row.id, close);
          expiryTimer = setTimeout(close, Math.min(expires - Date.now(), 2_147_483_647));
          seen.current.set(row.id, expires);
          try {
            localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(seen.current)));
          } catch {
            // Never store capabilities, purpose, credentials or the approval URL.
          }
          if (soundEnabled)
            void playNotificationSound(
              "input",
              () => !controller.signal.aborted && alerts.has(row.id) && Date.now() < expires,
            );
        }
      } catch {
        // Auth loss, broker outages and old/unmanaged servers must not leave stale alerts.
        clearAlerts();
      } finally {
        if (!controller.signal.aborted) pollTimer = setTimeout(() => void poll(), 2_000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(pollTimer);
      clearAlerts();
    };
  }, [mode, inApp]);

  return null;
}
