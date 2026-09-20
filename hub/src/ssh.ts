// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Broker } from "./broker.ts";
import type { Config, Host } from "./types.ts";
import { run, requireThat } from "./io.ts";

export async function checkHostTrust(config: Config, host: Host, signal: AbortSignal) {
  const found = await run(
    "/usr/bin/ssh-keygen",
    ["-F", host.key_alias, "-f", config.known_hosts],
    signal,
  );
  requireThat(found.exit_code === 0, "SSH host has no verified trust entry");
  const fingerprints = new Set<string>();
  for (const line of found.stdout.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.trim().split(/\s+/);
    requireThat(
      parts.length >= 3 && !parts[0]!.startsWith("@"),
      "SSH trust markers require administrator review",
    );
    fingerprints.add(
      "SHA256:" +
        createHash("sha256")
          .update(Buffer.from(parts[2]!, "base64"))
          .digest("base64")
          .replace(/=+$/, ""),
    );
  }
  requireThat(
    JSON.stringify([...fingerprints].sort()) === JSON.stringify([...host.fingerprints].sort()),
    "SSH trust changed; administrator review required",
  );
}
export function sshArgs(config: Config, host: Host, command: string) {
  return [
    "-F",
    "/dev/null",
    "-T",
    ...[
      "BatchMode=yes",
      "PasswordAuthentication=no",
      "KbdInteractiveAuthentication=no",
      "PreferredAuthentications=publickey",
      "IdentitiesOnly=yes",
      `IdentityAgent=${config.signer_socket}`,
      "StrictHostKeyChecking=yes",
      `UserKnownHostsFile=${config.known_hosts}`,
      "GlobalKnownHostsFile=/dev/null",
      `HostKeyAlias=${host.key_alias}`,
      "ForwardAgent=no",
      "ForwardX11=no",
      "ClearAllForwardings=yes",
      "ControlMaster=no",
      "ControlPath=none",
      "ConnectTimeout=10",
      "ServerAliveInterval=15",
      "ServerAliveCountMax=2",
      "PermitLocalCommand=no",
      "ProxyCommand=none",
    ].flatMap((option) => ["-o", option]),
    "-i",
    config.identity_file,
    "-p",
    String(host.port),
    "-l",
    host.user,
    "--",
    host.hostname,
    command,
  ];
}
export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export async function checkSigner(config: Config, signal: AbortSignal) {
  const result = await run("/usr/bin/ssh-add", ["-L"], signal, {
    SSH_AUTH_SOCK: config.signer_socket,
  });
  const expected = readFileSync(config.identity_file, "utf8")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
  requireThat(
    expected.split(" ").length === 2 &&
      result.exit_code === 0 &&
      result.stdout
        .split("\n")
        .some((line) => line.trim().split(/\s+/).slice(0, 2).join(" ") === expected),
    "SSH signer locked; fresh passkey approval required",
  );
}
export async function sshExec(
  broker: Broker,
  uid: number,
  input: { grant: string; host: string; command: string; timeout_seconds?: number },
  signal: AbortSignal,
) {
  const host = broker.config.hosts[input.host],
    timeout = input.timeout_seconds ?? 300;
  requireThat(
    host &&
      input.command.length > 0 &&
      input.command.length <= 65536 &&
      Number.isSafeInteger(timeout) &&
      timeout > 0 &&
      timeout <= 3600,
    "Invalid SSH operation",
  );
  return broker.operation(
    uid,
    input.grant,
    `ssh:${input.host}`,
    signal,
    async (operationSignal) => {
      const bounded = AbortSignal.any([operationSignal, AbortSignal.timeout(timeout * 1000)]);
      await checkHostTrust(broker.config, host, bounded);
      return run("/usr/bin/ssh", sshArgs(broker.config, host, input.command), bounded);
    },
  );
}
