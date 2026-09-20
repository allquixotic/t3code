import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { hubOnly, root, command } from "./maintain.ts";

hubOnly();
const grant = process.argv[2];
const stageOnly = process.argv[3] === "--stage-only";
if (process.argv.length > (stageOnly ? 4 : 3)) throw new Error("Unexpected publication arguments");
if (!grant || !/^[a-f0-9]{64}$/.test(grant))
  throw new Error("Supply this task's active ssh:mbp broker grant ID");
const broker = "/home/sean/bin/hub-access";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function active() {
  const value = JSON.parse(execFileSync(broker, ["status", grant!], { encoding: "utf8" }));
  if (
    value.state !== "active" ||
    Date.parse(value.grant_expires_at) <= Date.now() ||
    !value.capabilities.includes("ssh:mbp")
  )
    throw new Error("Publishing grant is locked or expired");
}
function remote(script: string, timeout = 120) {
  active();
  const value = JSON.parse(
    execFileSync(
      broker,
      [
        "ssh-exec",
        "--grant",
        grant!,
        "--host",
        "mbp",
        "--timeout",
        String(timeout),
        "--command",
        "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; export PATH; " +
          script,
      ],
      { encoding: "utf8", maxBuffer: 4 << 20 },
    ),
  );
  if (value.exit_code !== 0 || value.interrupted || value.truncated)
    throw new Error(
      `Remote publication command failed; check outcome before retrying. ${value.stderr ?? ""}`,
    );
  return String(value.stdout).trim();
}
if (command("git", ["status", "--porcelain"]))
  throw new Error("Publish only a clean committed branch");
if (command("git", ["branch", "--show-current"]) !== "hub-passkey")
  throw new Error("Select hub-passkey before publishing");
const preflight = remote(
  "hostname && id -un && pwd" + (stageOnly ? "" : " && gh api user --jq .login"),
).split("\n");
if (!["mbp", "mbp.local", "MacBook-Pro.local"].includes(preflight[0] ?? ""))
  throw new Error("Remote hostname mismatch");
if (
  preflight[1] !== "sean" ||
  preflight[2] !== "/Users/sean" ||
  (!stageOnly && preflight[3] !== "allquixotic")
)
  throw new Error("Unexpected SSH or GitHub identity");
console.log(
  `Verified mbp, SSH user ${preflight[1]}, directory ${preflight[2]}${stageOnly ? "" : `, GitHub account ${preflight[3]}`}`,
);
const metadata = JSON.parse(readFileSync(join(root, "hub/release.json"), "utf8"));
const revision = command("git", ["rev-parse", "hub-passkey"]),
  baseline = command("git", ["rev-parse", `${metadata.baseline}^{commit}`]);
const temporary = mkdtempSync(join(tmpdir(), "t3-hub-publish-")),
  bundle = join(temporary, "branch.bundle");
let staging: string | undefined;
let retained = false;
try {
  command("git", ["bundle", "create", bundle, "hub-passkey", `^${baseline}`]);
  const bytes = readFileSync(bundle),
    sha = createHash("sha256").update(bytes).digest("hex");
  // A fork may already be private. gh is the credential holder; its token never crosses SSH.
  const repositoryCommand =
    "if gh api repos/allquixotic/t3code --jq .full_name 2>/dev/null; then :; else gh repo fork pingdotgg/t3code --clone=false --remote=false >/dev/null && gh api repos/allquixotic/t3code --jq .full_name; fi";
  if (!stageOnly && remote(repositoryCommand) !== "allquixotic/t3code")
    throw new Error("GitHub repository mismatch");
  staging = remote("mktemp -d /private/tmp/t3-hub-publish.XXXXXXXX");
  if (!/^\/private\/tmp\/t3-hub-publish\.[A-Za-z0-9]+$/.test(staging))
    throw new Error("Unexpected remote staging path");
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    const chunk = bytes.subarray(offset, offset + 32768).toString("base64");
    remote(
      `cd ${quote(staging)} && test "$(test -f branch.bundle && wc -c < branch.bundle | tr -d ' ' || printf 0)" = ${offset} && printf %s ${quote(chunk)} | base64 -D >> branch.bundle`,
    );
  }
  const actual = remote(`cd ${quote(staging)} && shasum -a 256 branch.bundle | cut -d ' ' -f 1`);
  if (actual !== sha) throw new Error("Transport checksum mismatch");
  remote(
    `cd ${quote(staging)} && git init --bare repository.git >/dev/null && git -C repository.git fetch --filter=blob:none --depth=1 https://github.com/pingdotgg/t3code.git ${quote(metadata.baseline)} >/dev/null && git -C repository.git bundle verify ../branch.bundle && git -C repository.git fetch ../branch.bundle hub-passkey:refs/heads/hub-passkey`,
    300,
  );
  if (stageOnly) {
    const script = `#!/bin/sh\nset -eu\nPATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin\nexport PATH\ntest "$(id -un)" = sean\ntest "$(gh api user --jq .login)" = allquixotic\ncd ${quote(staging)}\ntest "$(git -C repository.git rev-parse refs/heads/hub-passkey)" = ${quote(revision)}\ntest "$( ${repositoryCommand} )" = allquixotic/t3code\ngit -C repository.git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push https://github.com/allquixotic/t3code.git refs/heads/hub-passkey:refs/heads/hub-passkey\ntest "$(gh api repos/allquixotic/t3code/git/ref/heads/hub-passkey --jq .object.sha)" = ${quote(revision)}\nprintf '%s\\n' ${quote(`Published and verified ${revision}`)}\ncd /\nrm -rf ${quote(staging)}\n`;
    remote(
      `printf %s ${quote(Buffer.from(script).toString("base64"))} | base64 -D > ${quote(staging + "/publish.sh")} && chmod 700 ${quote(staging + "/publish.sh")}`,
    );
    retained = true;
    console.log(
      `Staged verified revision ${revision}. Run in your local mbp terminal: /bin/sh ${quote(staging + "/publish.sh")}`,
    );
  } else {
    remote(
      `cd ${quote(staging)} && git -C repository.git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push https://github.com/allquixotic/t3code.git refs/heads/hub-passkey:refs/heads/hub-passkey`,
      300,
    );
    const published = remote(
      "gh api repos/allquixotic/t3code/git/ref/heads/hub-passkey --jq .object.sha",
    );
    if (published !== revision) throw new Error("Published branch verification failed");
    console.log(
      `Published and verified https://github.com/allquixotic/t3code/tree/hub-passkey at ${revision}`,
    );
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
  if (staging && !retained)
    try {
      remote(`rm -rf -- ${quote(staging)}`);
    } catch {
      console.error(
        `Publication staging remains on mbp: ${staging}. Clean it up under a fresh scoped grant; do not assume an interrupted push failed.`,
      );
    }
}
