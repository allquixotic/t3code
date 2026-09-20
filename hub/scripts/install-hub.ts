import { hostname } from "node:os";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  chownSync,
  readdirSync,
  lstatSync,
  renameSync,
  symlinkSync,
  readlinkSync,
  rmSync,
  lchownSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { join, resolve } from "node:path";
import { parseConfig } from "../src/config.ts";
import { parseManifest, verifyArtifact } from "../src/artifacts.ts";

if (hostname().split(".")[0] !== "t3code" || process.getuid?.() !== 0)
  throw new Error("Administrator installation must run on t3code");
const [bundleArg, artifactsArg, environmentsArg] = process.argv.slice(2);
if (!bundleArg || !artifactsArg || !environmentsArg)
  throw new Error(
    "Usage: node install-hub.ts BROKER_BUNDLE ARTIFACT_DIRECTORY ENVIRONMENT_POLICY_JSON",
  );
const bundle = resolve(bundleArg),
  artifacts = resolve(artifactsArg);
const manifest = parseManifest(JSON.parse(readFileSync(join(artifacts, "manifest.json"), "utf8")));
const policyPath = "/etc/hub-broker/config.json";
const original = JSON.parse(readFileSync(policyPath, "utf8"));
const additions = JSON.parse(readFileSync(environmentsArg, "utf8"));
if (
  !additions.environments ||
  Object.keys(additions).some((key) => !["environments"].includes(key))
)
  throw new Error("Enrollment file must contain only the environments mapping");
const policy = parseConfig({
  ...original,
  environments: additions.environments,
  artifact_directory: "/var/lib/t3-hub-artifacts/current",
  lease_signing_key: "/etc/hub-broker/lease-ed25519.pem",
});
if (!policy.unlock_socket) throw new Error("Preserved independent passkey unlocker required");
for (const environment of Object.values(policy.environments!))
  if (!manifest.artifacts.some((a) => a.platform === environment.platform))
    throw new Error("Artifact coverage is incomplete for enrolled environments");
for (const artifact of manifest.artifacts) await verifyArtifact(artifacts, artifact, false);
if (!existsSync(join(bundle, "src/main.js")) || !existsSync(join(bundle, "native/peercred.node")))
  throw new Error("Compiled broker bundle missing");
const group = (name: string) =>
  Number(execFileSync("getent", ["group", name], { encoding: "utf8" }).split(":")[2]);
const brokerGroup = group("hub-broker");
const stamp = new Date().toISOString().replace(/[^0-9]/g, "");
const backup = `/var/backups/t3-hub/${stamp}`;
mkdirSync(backup, { recursive: true, mode: 0o700 });
const paths = [
  policyPath,
  "/home/sean/bin/hub-access",
  "/usr/local/lib/hub-broker/hub-access",
  "/etc/systemd/system/hub-broker.service.d/90-typescript.conf",
  "/etc/systemd/system/hub-unlocker.service.d/90-typescript.conf",
  "/etc/systemd/system/t3code.service.d/90-hub.conf",
];
const saved = paths.map((path, index) => {
  const exists = existsSync(path);
  if (exists) cpSync(path, join(backup, String(index)), { dereference: false });
  return { path, copy: String(index), exists };
});
const oldT3 = readlinkSync("/opt/t3/current");
writeFileSync(join(backup, "restore.json"), JSON.stringify({ saved, oldT3 }, null, 2), {
  mode: 0o600,
});
function rootTree(path: string, treeRoot = path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) {
    const target = realpathSync(path);
    if (!target.startsWith(treeRoot + "/"))
      throw new Error("Release symlink escapes protected tree");
    lchownSync(path, 0, 0);
    return;
  }
  chownSync(path, 0, 0);
  if (!info.isSymbolicLink()) {
    chmodSync(path, info.isDirectory() ? 0o755 : info.mode & 0o111 ? 0o755 : 0o644);
    if (info.isDirectory())
      for (const name of readdirSync(path)) rootTree(join(path, name), treeRoot);
  }
}
function switchLink(link: string, target: string) {
  const next = link + ".next";
  try {
    rmSync(next);
  } catch {}
  symlinkSync(target, next);
  renameSync(next, link);
}
const release = `/usr/local/lib/hub-broker-ts/releases/${manifest.revision}`;
if (existsSync(release))
  throw new Error("Broker revision already installed; inspect instead of overwriting it");
mkdirSync(release, { recursive: true });
cpSync(bundle, release, { recursive: true });
writeFileSync(join(release, "package.json"), '{"type":"module"}\n');
rootTree(release);
const published = `/var/lib/t3-hub-artifacts/${manifest.revision}`;
if (existsSync(published)) throw new Error("Artifact revision already published");
mkdirSync(published, { recursive: true });
cpSync(artifacts, published, { recursive: true });
rootTree(published);
for (const artifact of manifest.artifacts) await verifyArtifact(published, artifact);
if (!existsSync(policy.lease_signing_key!)) {
  const pair = generateKeyPairSync("ed25519");
  const key = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  try {
    writeFileSync(policy.lease_signing_key!, key, { mode: 0o440, flag: "wx" });
    chownSync(policy.lease_signing_key!, 0, brokerGroup);
  } finally {
    key.fill(0);
  }
  writeFileSync(
    "/etc/hub-broker/lease-ed25519.pub",
    pair.publicKey.export({ type: "spki", format: "pem" }),
    { mode: 0o644, flag: "wx" },
  );
}
const hostArtifact = manifest.artifacts.find((a) => a.platform === `linux-${process.arch}`);
if (!hostArtifact) throw new Error("Hub runtime artifact missing");
const t3Release = `/opt/t3/releases/hub-${manifest.revision}`;
mkdirSync(t3Release, { recursive: true });
execFileSync("/usr/bin/tar", [
  "-xf",
  join(published, hostArtifact.file),
  "-C",
  t3Release,
  "--no-same-owner",
]);
rootTree(t3Release);
const node = process.execPath;
const wrapper = `#!/bin/sh\nHUB_INVOKED_AS=\$(basename -- \"$0\")\nexport HUB_INVOKED_AS\nexec ${node} --jitless ${release}/src/main.js \"$@\"\n`;
const overrides = [
  [
    "hub-broker",
    `[Service]\nType=simple\nExecStart=\nExecStart=${node} --jitless ${release}/src/main.js serve --config ${policyPath}\n`,
  ],
  [
    "hub-unlocker",
    `[Service]\nType=simple\nExecStart=\nExecStart=${node} --jitless ${release}/src/main.js unlocker --config /etc/hub-unlocker/config.json\n`,
  ],
  ["t3code", "[Service]\nEnvironment=T3_HUB_BROKER_SOCKET=/run/hub-broker/worker.sock\n"],
] as const;
// Recovery metadata is retained before any live service, policy or client changes.
console.log(`Recovery metadata: ${backup}/restore.json`);
execFileSync("systemctl", ["stop", "hub-broker.service", "hub-unlocker.service"], {
  stdio: "inherit",
});
try {
  switchLink("/var/lib/t3-hub-artifacts/current", published);
  writeFileSync(policyPath + ".next", JSON.stringify(policy, null, 2) + "\n", { mode: 0o640 });
  chownSync(policyPath + ".next", 0, brokerGroup);
  renameSync(policyPath + ".next", policyPath);
  for (const [service, body] of overrides) {
    const directory = `/etc/systemd/system/${service}.service.d`;
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, service === "t3code" ? "90-hub.conf" : "90-typescript.conf"),
      body,
      { mode: 0o644 },
    );
  }
  for (const [index, path] of [
    "/home/sean/bin/hub-access",
    "/usr/local/lib/hub-broker/hub-access",
  ].entries()) {
    const next = join(backup, `client-${index}`);
    writeFileSync(next, wrapper, { mode: 0o755, flag: "wx" });
    renameSync(next, path);
  }
  switchLink("/opt/t3/current", t3Release);
  execFileSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
  execFileSync("systemctl", ["start", "hub-unlocker.service", "hub-broker.service"], {
    stdio: "inherit",
  });
  // Restart T3 only after broker services have started; the operator's current agent may disconnect.
  execFileSync("systemctl", ["restart", "t3code.service"], { stdio: "inherit" });
  console.log(
    `Installed ${manifest.baseline} / ${manifest.revision}. Approve a new timed connection for the first live test.`,
  );
} catch (error) {
  execFileSync("systemctl", ["stop", "hub-broker.service", "hub-unlocker.service"], {
    stdio: "inherit",
  });
  for (const item of saved) {
    if (item.exists) cpSync(join(backup, item.copy), item.path, { dereference: false });
    else rmSync(item.path, { force: true });
  }
  switchLink("/opt/t3/current", oldT3);
  execFileSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
  execFileSync("systemctl", ["start", "hub-unlocker.service", "hub-broker.service"], {
    stdio: "inherit",
  });
  throw error;
}
