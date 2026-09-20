import { hostname } from "node:os";
import { readFileSync, cpSync, rmSync, symlinkSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
if (hostname().split(".")[0] !== "t3code" || process.getuid?.() !== 0)
  throw new Error("Run recovery as administrator on t3code");
const backup = resolve(process.argv[2] ?? "");
if (!/^\/var\/backups\/t3-hub\/\d+$/.test(backup))
  throw new Error("Select one concrete protected backup directory");
const state = JSON.parse(readFileSync(join(backup, "restore.json"), "utf8")) as {
  saved: { path: string; copy: string; exists: boolean }[];
  oldT3: string;
};
execFileSync("systemctl", ["stop", "hub-broker.service", "hub-unlocker.service"], {
  stdio: "inherit",
});
for (const item of state.saved) {
  if (item.exists) cpSync(join(backup, item.copy), item.path, { dereference: false });
  else rmSync(item.path, { force: true });
}
const link = "/opt/t3/current";
rmSync(link + ".rollback", { force: true });
symlinkSync(state.oldT3, link + ".rollback");
renameSync(link + ".rollback", link);
execFileSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
execFileSync("systemctl", ["start", "hub-unlocker.service", "hub-broker.service"], {
  stdio: "inherit",
});
execFileSync("systemctl", ["restart", "t3code.service"], { stdio: "inherit" });
console.log(
  "Previous services restored. Existing in-memory grants ended; request fresh timed approval.",
);
