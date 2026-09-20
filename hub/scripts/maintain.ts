import { hostname, userInfo } from "node:os";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function hubOnly() {
  if (hostname().split(".")[0] !== "t3code")
    throw new Error("Run this skill and all builds on t3code, never a remote environment.");
  console.log(JSON.stringify({ hostname: hostname(), user: userInfo().username, directory: root }));
}
export function command(binary: string, args: string[], cwd = root) {
  return execFileSync(binary, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 16 << 20,
  }).trim();
}
export async function stableRelease() {
  const response = await fetch("https://api.github.com/repos/pingdotgg/t3code/releases/latest", {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Public release lookup failed (${response.status})`);
  const release = (await response.json()) as {
    tag_name: string;
    prerelease: boolean;
    draft: boolean;
    html_url: string;
    assets: { name: string; browser_download_url: string }[];
  };
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name))
    throw new Error("Upstream latest is not a stable release");
  return {
    tag_name: release.tag_name,
    prerelease: release.prerelease,
    draft: release.draft,
    html_url: release.html_url,
    assets: release.assets.map(({ name, browser_download_url }) => ({
      name,
      browser_download_url,
    })),
  };
}
async function main() {
  hubOnly();
  const action = process.argv[2];
  if (action === "check") {
    console.log(
      JSON.stringify(
        {
          maintained: JSON.parse(readFileSync(resolve(root, "hub/release.json"), "utf8")),
          latest: await stableRelease(),
          branch: command("git", ["branch", "--show-current"]),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (action !== "prepare") throw new Error("Usage: node hub/scripts/maintain.ts check|prepare");
  const lock = resolve(root, ".git-hub-upgrade-lock");
  mkdirSync(lock); // An interrupted run leaves a visible lock; inspect its owner before removing it.
  writeFileSync(
    resolve(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
  );
  try {
    if (command("git", ["status", "--porcelain"]))
      throw new Error("Commit or preserve the current work before preparing an upgrade");
    if (
      command("git", ["remote", "get-url", "upstream"]) !==
      "https://github.com/pingdotgg/t3code.git"
    )
      throw new Error("Unexpected upstream remote");
    const release = await stableRelease();
    const current = JSON.parse(readFileSync(resolve(root, "hub/release.json"), "utf8")) as {
      baseline: string;
    };
    if (release.tag_name === current.baseline) {
      console.log(
        `Already based on ${release.tag_name}; review existing validation before promoting.`,
      );
      return;
    }
    const semver = (tag: string) => tag.slice(1).split(".").map(Number);
    const latest = semver(release.tag_name),
      old = semver(current.baseline);
    const comparison = latest.map((part, i) => part - old[i]!).find((part) => part !== 0) ?? 0;
    if (comparison < 0) throw new Error("Refusing automatic baseline downgrade");
    command("git", [
      "fetch",
      "--no-tags",
      "upstream",
      `refs/tags/${release.tag_name}:refs/tags/${release.tag_name}`,
    ]);
    const commit = command("git", ["rev-parse", `${release.tag_name}^{commit}`]);
    const stamp = new Date().toISOString().replace(/[^0-9]/g, "");
    const branch = `hub-upgrade/${release.tag_name}-${stamp}`;
    const worktree = resolve(dirname(root), `t3code-hub-upgrade-${stamp}`);
    command("git", ["worktree", "add", "-b", branch, worktree, "hub-passkey"]);
    let conflicts = false;
    try {
      command("git", ["merge", "--no-commit", "--no-ff", commit], worktree);
    } catch {
      conflicts = true;
    }
    console.log(
      JSON.stringify(
        {
          worktree,
          branch,
          stable: release.tag_name,
          commit,
          conflicts,
          next: "Adapt the patch and hub/release.json in this local worktree, verify, commit, package, then fast-forward hub-passkey. Read hub/skill/SKILL.md.",
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(lock, { recursive: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
