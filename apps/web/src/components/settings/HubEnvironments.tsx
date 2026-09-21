import { useEffect, useRef } from "react";
import { environmentCatalog } from "~/connection/catalog";
import { useEnvironments } from "~/state/environments";
import {
  connectHubEnvironment,
  disconnectHubEnvironment,
  hubAliasForEnvironment,
  hubEnvironmentStatusText,
  publishHubEnvironments,
  refreshHubEnvironments,
  setHubClientError,
  useHubEnvironments,
} from "~/hubEnvironments";
import { connectPairing } from "~/connection/onboarding";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

/** Polling never asks for a grant. Reuse native credentials across timed connections. */
export function HubEnvironmentCoordinator() {
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const retry = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const enable = useAtomCommand(environmentCatalog.setEnabled, { reportFailure: false });
  const { environments } = useEnvironments();
  const latest = useRef(environments);
  useEffect(() => {
    latest.current = environments;
  }, [environments]);
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const rows = await refreshHubEnvironments();
        for (const row of rows) {
          if (stopped || row.phase !== "active" || !row.http_base_url) continue;
          const existing = latest.current.find(
            (item) => hubAliasForEnvironment(item) === row.alias,
          );
          const repairCredential =
            existing?.connection.phase === "error" &&
            existing.connection.blockedReason === "authentication";
          const key = `${row.alias}:${row.expires_at}:${repairCredential ? "pair" : "connect"}`;
          if (attempted.current.has(key)) continue;
          setHubClientError(row.alias, null);
          attempted.current.add(key);
          // A new lease normally reuses the native credential. Repair an invalid credential
          // at most once within that lease, without requesting or extending access.
          let succeeded = false;
          if (existing && !repairCredential) {
            const enabled = await enable({ environmentId: existing.environmentId, enabled: true });
            if (enabled._tag === "Success")
              succeeded = (await retry(existing.environmentId))._tag === "Success";
          } else if (row.pairing_code) {
            succeeded =
              (await connect({ host: row.http_base_url, pairingCode: row.pairing_code }))._tag ===
              "Success";
          }
          if (!succeeded)
            setHubClientError(
              row.alias,
              `Could not connect this client to ${row.label}. Cancel the connection and retry.`,
            );
        }
      } catch {
        if (!stopped) publishHubEnvironments({ error: "Hub connection service unavailable" });
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [connect, enable, retry]);
  return null;
}
export function HubEnvironments() {
  const { environments, error, now } = useHubEnvironments();
  const setError = (error: string | null) => publishHubEnvironments({ error });
  const refresh = refreshHubEnvironments;
  const start = async (alias: string) => {
    setError(null);
    const approval = window.open("about:blank", "_blank");
    if (approval) approval.opener = null;
    try {
      const row = await connectHubEnvironment(alias);
      if (row.approval_url && approval) approval.location.href = row.approval_url;
      else approval?.close();
      await refresh();
    } catch {
      approval?.close();
      setError("Could not request timed access");
    }
  };
  if (environments.length === 0) return null;
  return (
    <SettingsSection title="Hub environments">
      <p className="text-sm text-muted-foreground">
        Approve timed access with your passkey. Remote software updates automatically when you
        connect.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {environments.map((environment) => {
        const seconds = environment.expires_at
          ? Math.max(0, Math.ceil((Date.parse(environment.expires_at) - now) / 1000))
          : 0;
        const busy = ["checking", "installing", "connecting", "updating"].includes(
          environment.phase,
        );
        return (
          <div
            key={environment.alias}
            className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{environment.label}</p>
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {environment.phase === "active"
                  ? `Connected · ${Math.ceil(seconds / 60)} minutes remaining`
                  : hubEnvironmentStatusText(environment)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {environment.phase === "pending" && environment.approval_url && (
                <a
                  href={environment.approval_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm underline"
                >
                  Approve access
                </a>
              )}
              {["active", "pending"].includes(environment.phase) || busy ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void disconnectHubEnvironment(environment.alias)
                      .then(refresh)
                      .catch(() => setError("Could not revoke access"))
                  }
                >
                  Lock
                </Button>
              ) : (
                <Button size="sm" onClick={() => void start(environment.alias)}>
                  Connect
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </SettingsSection>
  );
}
