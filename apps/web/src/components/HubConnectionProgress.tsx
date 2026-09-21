import { useState, type ReactNode } from "react";
import type { EnvironmentId, HubEnvironmentStatus } from "@t3tools/contracts";
import { Button } from "./ui/button";
import { useEnvironments } from "../state/environments";
import {
  connectHubEnvironment,
  disconnectHubEnvironment,
  hubAliasForEnvironment,
  hubEnvironmentStatusText,
  useHubEnvironments,
} from "../hubEnvironments";

export function HubConnectionProgress({ environment }: { environment: HubEnvironmentStatus }) {
  const { clientErrors } = useHubEnvironments();
  const { environments: clients } = useEnvironments();
  const client = clients.find((row) => hubAliasForEnvironment(row) === environment.alias);
  const clientError =
    clientErrors[environment.alias] ??
    (client?.connection.phase === "error" && environment.phase === "active"
      ? client.connection.error
      : undefined);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const busy = ["checking", "installing", "updating", "connecting"].includes(environment.phase);
  const connect = async () => {
    setRequesting(true);
    setError(null);
    // Open during the click so a browser popup blocker cannot swallow the passkey page.
    const approval = window.open("about:blank", "_blank");
    if (approval) approval.opener = null;
    try {
      const row = await connectHubEnvironment(environment.alias);
      if (row.approval_url && approval) approval.location.href = row.approval_url;
      else approval?.close();
    } catch {
      approval?.close();
      setError(
        "Could not request access. Your project is saved; try again when the hub is available.",
      );
    } finally {
      setRequesting(false);
    }
  };
  return (
    <div className="space-y-4" aria-live="polite">
      <p className="font-medium">{hubEnvironmentStatusText(environment)}</p>
      <ol
        className="space-y-2 text-sm text-muted-foreground"
        aria-label="Remote connection progress"
      >
        <li>1. Approve timed access with your passkey</li>
        <li>2. Check the machine and install or update T3 if needed</li>
        <li>3. Connect and open the project on {environment.label}</li>
      </ol>
      {environment.progress !== undefined && (
        <progress
          className="w-full"
          max={100}
          value={environment.progress}
          aria-label="Remote software transfer"
        />
      )}
      {environment.phase === "active" && (
        <p className="text-sm text-muted-foreground">
          Connecting this client to the remote workspace…
        </p>
      )}
      {clientError && (
        <p role="alert" className="text-sm text-destructive">
          {clientError} Cancel the connection and approve again to retry.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        {environment.phase === "pending" && environment.approval_url ? (
          <a
            className="text-sm underline"
            href={environment.approval_url}
            target="_blank"
            rel="noreferrer"
          >
            Approve with passkey
          </a>
        ) : (
          !busy &&
          environment.phase !== "active" && (
            <Button disabled={requesting} onClick={() => void connect()}>
              {requesting ? "Requesting access…" : "Approve access and connect"}
            </Button>
          )
        )}
        {(busy || ["pending", "active"].includes(environment.phase)) && (
          <Button
            variant="outline"
            onClick={() =>
              void disconnectHubEnvironment(environment.alias).catch(() =>
                setError("Could not cancel the connection"),
              )
            }
          >
            Cancel connection
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Access closes when the approval expires. Your project remains available to reconnect.
      </p>
    </div>
  );
}

/** Existing projects stay navigable after expiry; the gate replaces a misleading reconnect loop. */
export function HubEnvironmentGate({
  environmentId,
  children,
}: {
  environmentId: EnvironmentId;
  children: ReactNode;
}) {
  const { environments: native } = useEnvironments();
  const { environments, error } = useHubEnvironments();
  const connected = native.find((row) => row.environmentId === environmentId);
  const alias = hubAliasForEnvironment(connected);
  const environment = environments.find((row) => row.alias === alias);
  if (!alias) return children;
  if (!environment)
    return (
      <div className="m-auto max-w-xl p-8" role="status">
        {error ?? "Checking remote access…"}
      </div>
    );
  if (environment.phase === "active" && connected?.connection.phase === "connected")
    return children;
  return (
    <section className="m-auto w-full max-w-xl space-y-6 p-8">
      <h1 className="text-xl font-semibold">{environment.label}</h1>
      <HubConnectionProgress environment={environment} />
    </section>
  );
}
