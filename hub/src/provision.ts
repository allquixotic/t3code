// @effect-diagnostics nodeBuiltinImport:off - protected broker I/O, never executed by the model or a remote T3 runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { loadManifest, verifyArtifact } from "./artifacts.ts";
import { record, requireThat, run, text } from "./io.ts";
import { shellQuote, sshArgs } from "./ssh.ts";
import type { Config, EnvironmentPolicy, RuntimePlatform } from "./types.ts";
import type { RemoteConfig } from "./remote.ts";

export interface RemoteProbe {
  platform: RuntimePlatform;
  hostname: string;
  user: string;
  cwd: string;
  home: string;
  uid?: number;
  gid?: number;
  existing?: Record<string, unknown>;
}
const posixProbe = `set -eu
os=$(uname -s); arch=$(uname -m)
printf '%s\\n' "$os" "$arch" "$(hostname)" "$(id -un)" "$(pwd -P)" "$HOME" "$(id -u)" "$(id -g)"
if [ -e /etc/t3-hub/remote.json ]; then
  # Validate the existing trust anchor and launcher before reusing an enrollment.
  protected() {
    test ! -L "$1" || exit 41
    p=$1
    while :; do
      if [ "$os" = Darwin ]; then owner=$(stat -f %u "$p"); mode=$(stat -f %Lp "$p"); else owner=$(stat -c %u "$p"); mode=$(stat -c %a "$p"); fi
      test "$owner" = 0 && test "$((0$mode & 022))" = 0 || exit 41
      test "$p" != / || break
      p=$(cd -P "$(dirname "$p")" && pwd)
    done
  }
  protected /etc/t3-hub/remote.json
  if [ "$os" = Darwin ]; then protected /var/lib/t3-hub/connect; else protected /usr/local/bin/t3-hub-agent; fi
  protected /var/lib/t3-hub/releases/bootstrap/t3
  base64 < /etc/t3-hub/remote.json | tr -d '\\r\\n'
else printf MISSING; fi
printf '\\n'
`;
const powershell = (source: string) =>
  `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(source, "utf16le").toString("base64")}`;
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const windowsProbe = `
$ErrorActionPreference = 'Stop'
$existing = $null
$root = 'C:\\ProgramData\\t3-hub'
if (Test-Path "$root\\remote.json") {
  foreach ($path in @($root, "$root\\remote.json", "$root\\connect.ps1", "$root\\releases", "$root\\releases\\bootstrap", "$root\\releases\\bootstrap\\t3.exe")) {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Untrusted enrollment path' }
    $acl = Get-Acl -LiteralPath $path
    $owner = (New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin @('S-1-5-18','S-1-5-32-544')) { throw 'Untrusted enrollment owner' }
    foreach ($ace in $acl.Access) {
      $sid = $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if ($ace.AccessControlType -eq 'Allow' -and $sid -notin @('S-1-5-18','S-1-5-32-544') -and ([int]$ace.FileSystemRights -band 0xD0156)) { throw 'Untrusted enrollment permissions' }
    }
  }
  $existing = Get-Content -Raw "$root\\remote.json" | ConvertFrom-Json
}
@{ os='Windows'; arch=[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); hostname=[Net.Dns]::GetHostName(); user=[Environment]::UserName; cwd=(Get-Location).Path; home=$env:USERPROFILE; existing=$existing } | ConvertTo-Json -Depth 8 -Compress
`;

export function parseProbe(value: string, windows: boolean, expectedUser: string): RemoteProbe {
  let raw: Record<string, unknown>;
  if (windows) raw = record(JSON.parse(value.trim()));
  else {
    const lines = value.trim().split(/\r?\n/);
    requireThat(lines.length === 9, "Remote setup identity probe failed");
    raw = {
      os: lines[0],
      arch: lines[1],
      hostname: lines[2],
      user: lines[3],
      cwd: lines[4],
      home: lines[5],
      uid: Number(lines[6]),
      gid: Number(lines[7]),
      existing:
        lines[8] === "MISSING" ? null : JSON.parse(Buffer.from(lines[8]!, "base64").toString()),
    };
  }
  const os =
    raw.os === "Linux"
      ? "linux"
      : raw.os === "Darwin"
        ? "darwin"
        : raw.os === "Windows"
          ? "win"
          : "";
  const arch = /^(x86_64|amd64|x64)$/i.test(text(raw.arch))
    ? "x64"
    : /^(aarch64|arm64)$/i.test(text(raw.arch))
      ? "arm64"
      : "";
  requireThat(
    os && arch,
    "This destination's operating system or architecture is not supported by T3",
  );
  requireThat(
    raw.user === expectedUser,
    "Remote setup account does not match the selected SSH destination",
  );
  for (const key of ["hostname", "user", "cwd", "home"])
    requireThat(
      typeof raw[key] === "string" && raw[key].length > 0 && !/[\r\n\0]/.test(raw[key]),
      "Remote setup identity is incomplete",
    );
  requireThat(
    windows ? /^[A-Za-z]:\\/.test(text(raw.home)) : text(raw.home).startsWith("/"),
    "Remote home must be an absolute path",
  );
  if (!windows)
    requireThat(
      Number.isSafeInteger(raw.uid) &&
        Number(raw.uid) >= 0 &&
        Number.isSafeInteger(raw.gid) &&
        Number(raw.gid) >= 0,
      "Remote numeric identity is invalid",
    );
  return {
    platform: `${os}-${arch}` as RuntimePlatform,
    hostname: text(raw.hostname),
    user: text(raw.user),
    cwd: text(raw.cwd),
    home: text(raw.home),
    ...(!windows ? { uid: Number(raw.uid), gid: Number(raw.gid) } : {}),
    ...(raw.existing ? { existing: record(raw.existing) } : {}),
  };
}

export function remoteSetupConfig(
  alias: string,
  identity: RemoteProbe,
  publicKey: string,
): RemoteConfig {
  const win = identity.platform.startsWith("win-");
  return {
    alias,
    public_key: publicKey,
    ssh_user: identity.user,
    runtime_user: identity.user,
    runtime_home: identity.home,
    root_directory: win ? "C:\\ProgramData\\t3-hub\\releases" : "/var/lib/t3-hub/releases",
    base_directory: win ? "C:\\ProgramData\\t3-hub\\state" : "/var/lib/t3-hub/state",
    socket: win
      ? "\\\\.\\pipe\\t3-hub-supervisor"
      : identity.platform.startsWith("darwin-")
        ? "/var/lib/t3-hub/run/supervisor.sock"
        : "/run/t3-hub/supervisor.sock",
    ...(!win
      ? {
          runtime_uid: identity.uid!,
          runtime_gid: identity.gid!,
          runtime_path: `${identity.home}/.local/bin:${identity.home}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
        }
      : {}),
  };
}
export function validateExistingSetup(identity: RemoteProbe, expected: RemoteConfig) {
  requireThat(identity.existing, "Remote enrollment was not created");
  for (const key of [
    "alias",
    "public_key",
    "ssh_user",
    "runtime_user",
    "runtime_home",
    "root_directory",
    "base_directory",
    "socket",
    ...(!identity.platform.startsWith("win-") ? ["runtime_uid", "runtime_gid"] : []),
  ] as const)
    requireThat(
      identity.existing[key] === expected[key as keyof RemoteConfig],
      "Existing remote enrollment does not match this hub, destination, or account. Administrator review is required; no files were replaced.",
    );
}

/** Called only inside broker.operation after approval, signer preparation and pinned host-key verification. */
export async function provisionEnvironment(
  config: Config,
  alias: string,
  signal: AbortSignal,
  progress: (phase: "checking" | "installing", detail: string, percent?: number) => void,
): Promise<Extract<EnvironmentPolicy, { supervisor: string }>> {
  const policy = config.environments![alias]!;
  const host = config.hosts[policy.host]!;
  const ssh = async (command: string, input?: Buffer) => {
    signal.throwIfAborted();
    const result = await run("/usr/bin/ssh", sshArgs(config, host, command), signal, {}, input);
    signal.throwIfAborted();
    return result;
  };
  progress("checking", "Checking remote identity and software");
  const posix = await ssh(`/bin/sh -c ${shellQuote(posixProbe)}`);
  // An existing but untrusted enrollment must never be treated as a fresh install.
  requireThat(
    posix.exit_code !== 41,
    "Existing remote enrollment is not administrator protected. Administrator review is required.",
  );
  const windows = posix.exit_code !== 0;
  const result = windows ? await ssh(powershell(windowsProbe)) : posix;
  requireThat(
    result.exit_code === 0 && !result.truncated,
    "Could not verify remote identity and enrollment. Check SSH access and the destination's setup.",
  );
  const identity = parseProbe(result.stdout, windows, host.user);
  const publicKey = NodeCrypto.createPublicKey(NodeFS.readFileSync(config.lease_signing_key!))
    .export({ type: "spki", format: "pem" })
    .toString();
  const expected = remoteSetupConfig(alias, identity, publicKey);
  const enrolled = {
    host: policy.host,
    label: policy.label,
    enrolled: true as const,
    platform: identity.platform,
    supervisor: windows
      ? "C:\\ProgramData\\t3-hub\\connect.ps1"
      : identity.platform.startsWith("darwin-")
        ? "/var/lib/t3-hub/connect"
        : "/usr/local/bin/t3-hub-agent",
  };
  if (identity.existing) {
    validateExistingSetup(identity, expected);
    return enrolled;
  }
  const manifest = loadManifest(config.artifact_directory!);
  const artifact = manifest.artifacts.find((row) => row.platform === identity.platform);
  requireThat(
    artifact,
    `The hub has no published runtime for ${identity.platform}. Publish this platform and retry; your project is saved.`,
  );
  const file = await verifyArtifact(config.artifact_directory!, artifact);
  const admin = windows
    ? powershell(
        "if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 1 }",
      )
    : "/bin/sh -c 'test $(id -u) -eq 0 || sudo -n /usr/bin/true'";
  requireThat(
    (await ssh(admin)).exit_code === 0,
    "First connection needs administrator installation on this destination. The SSH account needs noninteractive administrator access for enrollment. Your project is saved; complete administrator setup and retry.",
  );
  progress("installing", "Preparing the protected remote installation");
  const stagingResult = await ssh(
    windows
      ? powershell(
          "$p = Join-Path $env:TEMP ('t3-hub-enroll.' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory $p | Out-Null; Write-Output $p",
        )
      : "umask 077; mktemp -d /tmp/t3-hub-enroll.XXXXXXXX",
  );
  const staging = stagingResult.stdout.trim();
  requireThat(
    stagingResult.exit_code === 0 &&
      (windows
        ? /^[A-Za-z]:\\[^\r\n\0]+\\t3-hub-enroll\.[a-f0-9]{32}$/.test(staging)
        : /^\/tmp\/t3-hub-enroll\.[A-Za-z0-9]+$/.test(staging)),
    "Could not prepare remote installation staging",
  );
  const asset = (name: string) => {
    const bundled = NodePath.join(import.meta.dirname, "../deploy", name);
    return NodeFS.readFileSync(
      NodeFS.existsSync(bundled) ? bundled : NodePath.join(import.meta.dirname, "../scripts", name),
    );
  };
  const upload = async (name: string, bytes: Buffer) => {
    const target = windows ? `${staging}\\${name}` : `${staging}/${name}`;
    const command = windows
      ? powershell(
          `$ErrorActionPreference='Stop'; $f=[IO.File]::Create(${psQuote(target)}); try { [Console]::OpenStandardInput().CopyTo($f) } finally { $f.Dispose() }`,
        )
      : `cat > ${shellQuote(target)}`;
    requireThat(
      (await ssh(command, bytes)).exit_code === 0,
      "Remote upload interrupted. Reconnect to check installation status before retrying.",
    );
    return target;
  };
  try {
    progress("installing", "Transferring the current T3 runtime");
    const archive = await upload("runtime.tar", NodeFS.readFileSync(file));
    const configBytes = Buffer.from(JSON.stringify(expected));
    const configPath = await upload("remote.json", configBytes);
    const hash = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    progress("installing", "Installing the protected supervisor and runtime");
    let installed;
    if (windows) {
      const script = asset("enroll-windows.ps1").toString();
      installed = await ssh(
        powershell(
          `& { ${script} } -Archive ${psQuote(archive)} -ArchiveHash '${artifact.sha256}' -ConfigPath ${psQuote(configPath)} -ConfigHash '${hash(configBytes)}' -ExpectedHostname ${psQuote(identity.hostname)}`,
        ),
      );
    } else {
      const mac = identity.platform.startsWith("darwin-");
      const unitBytes = asset(mac ? "org.allquixotic.t3-hub.plist" : "t3-hub-remote.service");
      const unit = await upload("service", unitBytes);
      const args = [
        archive,
        artifact.sha256,
        configPath,
        hash(configBytes),
        unit,
        hash(unitBytes),
        identity.hostname,
        ...(mac ? ["native"] : []),
      ]
        .map(shellQuote)
        .join(" ");
      installed = await ssh(
        `${identity.uid === 0 ? "" : "sudo -n "}/bin/sh -s -- ${args}`,
        asset(mac ? "enroll-macos.sh" : "enroll-linux.sh"),
      );
    }
    requireThat(
      installed.exit_code === 0,
      "Remote administrator installation did not complete. Your project is saved. Inspect the destination's enrollment/service and rollback script before retrying; existing files are never overwritten automatically.",
    );
    progress("checking", "Verifying the installed supervisor");
    const verified = await ssh(
      windows ? powershell(windowsProbe) : `/bin/sh -c ${shellQuote(posixProbe)}`,
    );
    requireThat(verified.exit_code === 0, "Remote enrollment verification failed");
    validateExistingSetup(parseProbe(verified.stdout, windows, host.user), expected);
    return enrolled;
  } finally {
    // Expiry forbids even cleanup SSH. A later approved attempt inspects enrollment before writes.
    if (!signal.aborted)
      await ssh(
        windows
          ? powershell(`Remove-Item -LiteralPath ${psQuote(staging)} -Recurse -Force`)
          : `rm -rf -- ${shellQuote(staging)}`,
      ).catch(() => {});
  }
}
