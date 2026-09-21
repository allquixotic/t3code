import { hostname } from "node:os";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  chownSync,
  statSync,
  existsSync,
  rmSync,
  renameSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { managedProxyConfig } from "./proxy-config.ts";

if (hostname().split(".")[0] !== "t3code" || process.getuid?.() !== 0)
  throw new Error("Run proxy installation as administrator on t3code");
const path = "/etc/caddy/Caddyfile",
  snippetPath = "/etc/caddy/t3-hub-remote.caddy";
const original = readFileSync(path, "utf8"),
  updated = managedProxyConfig(original);
const snippet = readFileSync(
  fileURLToPath(new URL("../deploy/t3-hub-remote.caddy", import.meta.url)),
  "utf8",
);
const priorSnippet = existsSync(snippetPath) ? readFileSync(snippetPath, "utf8") : undefined;
if (original === updated && snippet === priorSnippet) {
  console.log("Managed proxy routing already installed.");
} else {
  const backup = `/var/backups/t3-hub/proxy-${new Date().toISOString().replace(/[^0-9]/g, "")}`;
  mkdirSync(backup, { mode: 0o700 });
  writeFileSync(backup + "/Caddyfile", original, { mode: 0o600 });
  if (priorSnippet !== undefined) writeFileSync(backup + "/snippet", priorSnippet, { mode: 0o600 });
  const metadata = statSync(path);
  function publish(target: string, value: string) {
    writeFileSync(target + ".hub-next", value, { flag: "wx", mode: 0o644 });
    chownSync(target + ".hub-next", metadata.uid, metadata.gid);
    chmodSync(target + ".hub-next", target === path ? metadata.mode & 0o7777 : 0o644);
    renameSync(target + ".hub-next", target);
  }
  try {
    publish(snippetPath, snippet);
    publish(path, updated);
    // Never print an adapted configuration: its existing primary credential is intentionally private.
    execFileSync("/usr/bin/caddy", ["validate", "--config", path, "--adapter", "caddyfile"], {
      stdio: "pipe",
    });
    execFileSync("systemctl", ["reload", "caddy.service"], { stdio: "pipe" });
    console.log(
      `Installed managed remote proxy routing; primary/passkey routes preserved. Backup: ${backup}`,
    );
  } catch {
    publish(path, original);
    if (priorSnippet !== undefined) publish(snippetPath, priorSnippet);
    else rmSync(snippetPath, { force: true });
    execFileSync("systemctl", ["reload", "caddy.service"], { stdio: "pipe" });
    throw new Error(
      "Proxy installation failed; previous routing restored; diagnostic output withheld",
    );
  }
}
