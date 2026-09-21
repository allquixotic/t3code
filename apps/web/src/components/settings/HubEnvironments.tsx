import { useCallback, useEffect, useSyncExternalStore } from "react";
import * as Schema from "effect/Schema";
import { HubEnvironmentStatus } from "@t3tools/contracts";
import { connectPairing } from "~/connection/onboarding";
import { useAtomCommand } from "~/state/use-atom-command";
import { requestHub } from "~/hubApi";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

const request = (path: string, method = "GET") => requestHub(`environments/${path}`, method);
let snapshot: {
  environments: ReadonlyArray<HubEnvironmentStatus>;
  error: string | null;
  now: number;
} = { environments: [], error: null, now: Date.now() };
const listeners = new Set<() => void>();
const paired = new Set<string>();
const publish = (change: Partial<typeof snapshot>) => {
  snapshot = { ...snapshot, ...change };
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
async function refreshRows() {
  const rows = Schema.decodeUnknownSync(Schema.Array(HubEnvironmentStatus))(await request(""));
  publish({ environments: rows, now: Date.now() });
  return rows;
}
/** Keep approvals and automatic pairing progressing when Settings is closed. */
export function HubEnvironmentCoordinator() {
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const refresh = useCallback(async () => {
    for (const row of await refreshRows()) {
      if (row.phase !== "active" || !row.http_base_url || !row.pairing_code) continue;
      const key = `${row.alias}:${row.expires_at}`;
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(`t3.hub.paired.${row.alias}`);
      } catch {
        /* Memory state is sufficient when storage is unavailable. */
      }
      if (paired.has(key) || saved === key) continue;
      paired.add(key);
      const result = await connect({ host: row.http_base_url, pairingCode: row.pairing_code });
      if (result._tag === "Failure")
        publish({ error: `Could not pair ${row.label}. Lock and reconnect to try again.` });
      else
        try {
          localStorage.setItem(`t3.hub.paired.${row.alias}`, key);
        } catch {
          /* No credentials are stored here. */
        }
    }
  }, [connect]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!stopped) await refresh();
      } catch {
        if (!stopped) publish({ error: "Hub connection service unavailable" });
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [refresh]);
  return null;
}
export function HubEnvironments() {
  const { environments, error, now } = useSyncExternalStore(subscribe, () => snapshot);
  const setError = (error: string | null) => publish({ error });
  const refresh = refreshRows;
  const start = async (alias: string) => {
    setError(null);
    const approval = window.open("about:blank", "_blank");
    if (approval) approval.opener = null;
    try {
      const row = Schema.decodeUnknownSync(HubEnvironmentStatus)(
        await request(`${encodeURIComponent(alias)}/connect`, "POST"),
      );
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
        const busy = ["connecting", "updating"].includes(environment.phase);
        return (
          <div
            key={environment.alias}
            className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{environment.label}</p>
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {environment.phase === "unenrolled"
                  ? "Setup required"
                  : environment.phase === "active"
                    ? `Connected · ${Math.ceil(seconds / 60)} minutes remaining`
                    : environment.phase === "pending"
                      ? "Waiting for passkey approval"
                      : environment.phase === "updating"
                        ? "Updating remote software…"
                        : environment.phase === "connecting"
                          ? "Connecting…"
                          : (environment.error ?? "Locked")}
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
                    void request(`${environment.alias}/disconnect`, "POST")
                      .then(refresh)
                      .catch(() => setError("Could not revoke access"))
                  }
                >
                  Lock
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={environment.phase === "unenrolled"}
                  onClick={() => void start(environment.alias)}
                >
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
