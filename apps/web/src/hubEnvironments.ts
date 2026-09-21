import { useSyncExternalStore } from "react";
import * as Schema from "effect/Schema";
import { HubEnvironmentStatus } from "@t3tools/contracts";
import { requestHub } from "./hubApi";
import { resolvePrimaryEnvironmentHttpUrl } from "./environments/primary";
import type { EnvironmentPresentation } from "./state/environments";

const decodeRows = Schema.decodeUnknownSync(Schema.Array(HubEnvironmentStatus));
const decodeRow = Schema.decodeUnknownSync(HubEnvironmentStatus);
let snapshot: {
  environments: ReadonlyArray<HubEnvironmentStatus>;
  error: string | null;
  clientErrors: Readonly<Record<string, string>>;
  now: number;
} = {
  environments: [],
  error: null,
  clientErrors: {},
  now: Date.now(),
};
const listeners = new Set<() => void>();
export function publishHubEnvironments(change: Partial<typeof snapshot>) {
  snapshot = { ...snapshot, ...change };
  for (const listener of listeners) listener();
}
export function setHubClientError(alias: string, error: string | null) {
  const clientErrors = { ...snapshot.clientErrors };
  if (error) clientErrors[alias] = error;
  else delete clientErrors[alias];
  publishHubEnvironments({ clientErrors });
}
export function useHubEnvironments() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => snapshot,
  );
}
export async function refreshHubEnvironments() {
  const environments = decodeRows(await requestHub("environments/"));
  publishHubEnvironments({ environments, now: Date.now(), error: null });
  return environments;
}
/** Only explicit project creation / Connect / Retry actions call this; polling never does. */
export async function connectHubEnvironment(alias: string) {
  const row = decodeRow(
    await requestHub(`environments/${encodeURIComponent(alias)}/connect`, "POST"),
  );
  publishHubEnvironments({
    environments: snapshot.environments.map((value) => (value.alias === alias ? row : value)),
    error: null,
  });
  return row;
}
export async function disconnectHubEnvironment(alias: string) {
  await requestHub(`environments/${encodeURIComponent(alias)}/disconnect`, "POST");
  await refreshHubEnvironments();
}
export function hubAliasForEnvironment(
  environment: Pick<EnvironmentPresentation, "displayUrl"> | undefined,
): string | null {
  if (!environment?.displayUrl) return null;
  try {
    const url = new URL(environment.displayUrl);
    if (url.origin !== new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin) return null;
    return /^\/hub\/environments\/([A-Za-z0-9_.-]+)\/?$/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}
export function hubEnvironmentStatusText(row: HubEnvironmentStatus): string {
  if (row.detail && ["checking", "installing", "updating", "connecting"].includes(row.phase))
    return `${row.detail}${row.progress === undefined ? "" : ` (${row.progress}%)`}`;
  switch (row.phase) {
    case "unenrolled":
      return "Installs on first connection";
    case "locked":
      return "Access locked — approve to connect";
    case "pending":
      return "Waiting for passkey approval";
    case "checking":
      return "Checking remote setup";
    case "installing":
      return "Installing remote software";
    case "updating":
      return "Updating remote software";
    case "connecting":
      return "Connecting";
    case "active":
      return "Connected";
    case "error":
      return row.error ?? "Connection failed";
  }
}
