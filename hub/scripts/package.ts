import { spawnSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  readdirSync,
  statSync,
  chmodSync,
} from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { root, hubOnly, command, stableRelease } from "./maintain.ts";
import { extractTar } from "../src/archive.ts";
import { parseManifest } from "../src/artifacts.ts";
import type { Artifact, RuntimePlatform } from "../src/types.ts";

hubOnly();
if (command("git", ["status", "--porcelain"]))
  throw new Error("Package only a clean, committed fork revision");
const maintained = JSON.parse(readFileSync(join(root, "hub/release.json"), "utf8")) as {
  baseline: string;
  patchVersion: string;
};
const release = await stableRelease();
if (release.tag_name !== maintained.baseline)
  throw new Error("Upgrade the fork to latest stable before packaging");
if (command("git", ["diff", `${maintained.baseline}^{commit}`, "--", "pnpm-lock.yaml"]))
  throw new Error(
    "Native dependencies changed: engineer and verify hub-side target builds before packaging",
  );
const revision = command("git", ["rev-parse", "HEAD"]),
  version = maintained.baseline.slice(1);
for (const name of ["server", "web"])
  if (JSON.parse(readFileSync(join(root, `apps/${name}/package.json`), "utf8")).version !== version)
    throw new Error("Stamp package versions to the stable baseline before committing");
const targets = (
  process.argv.slice(2).length
    ? process.argv.slice(2)
    : ["linux-x64", "linux-arm64", "darwin-arm64", "win-x64", "win-arm64"]
) as RuntimePlatform[];
if (
  new Set(targets).size !== targets.length ||
  targets.some((target) => !/^(linux|darwin|win)-(x64|arm64)$/.test(target))
)
  throw new Error("Invalid or duplicate build target");
const output = join(root, "hub/artifacts", revision);
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), "t3-hub-package-"));
function build(binary: string, args: string[], cwd = root) {
  const result = spawnSync(binary, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: join(root, "node_modules/.bin") + ":" + process.env.PATH,
      GOMEMLIMIT: "3GiB",
      GOMAXPROCS: "3",
      NODE_OPTIONS: "--max-old-space-size=4096",
    },
  });
  if (result.status !== 0) throw new Error(`${binary} build failed`);
}
async function hash(path: string) {
  const h = createHash("sha256");
  for await (const bytes of createReadStream(path)) h.update(bytes);
  return h.digest("hex");
}
async function download(url: string, path: string) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    !parsed.pathname.startsWith(`/pingdotgg/t3code/releases/download/${maintained.baseline}/`)
  )
    throw new Error("Unexpected upstream artifact URL");
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error("Upstream artifact download failed");
  await pipeline(
    Readable.from(
      (async function* () {
        const reader = response.body!.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            yield chunk.value;
          }
        } finally {
          reader.releaseLock();
        }
      })(),
    ),
    createWriteStream(path, { flags: "wx", mode: 0o600 }),
  );
}
try {
  const sumsAsset = release.assets.find((a) => a.name === "SHA256SUMS");
  if (!sumsAsset) throw new Error("Upstream checksums unavailable");
  const sumsPath = join(temporary, "SHA256SUMS");
  await download(sumsAsset.browser_download_url, sumsPath);
  const sums = new Map(
    readFileSync(sumsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const parts = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line);
        if (!parts) throw new Error("Invalid checksums");
        return [parts[2]!, parts[1]!] as const;
      }),
  );
  build("node_modules/.bin/vp", ["run", "--filter", "@t3tools/web", "build"]);
  const artifacts: Artifact[] = [];
  for (const target of targets) {
    const upstreamTarget = target.replace(/^win-/, "win32-");
    const archiveName = `t3-${version}-${upstreamTarget}.${target.startsWith("win-") ? "zip" : "tar.gz"}`;
    const asset = release.assets.find((a) => a.name === archiveName),
      expected = sums.get(archiveName);
    if (!asset || !expected)
      throw new Error(`Stable upstream has no verified native runtime for ${target}`);
    const archive = join(temporary, archiveName);
    await download(asset.browser_download_url, archive);
    if ((await hash(archive)) !== expected) throw new Error("Upstream artifact checksum mismatch");
    const extracted = join(temporary, target);
    mkdirSync(extracted);
    if (target.startsWith("win-")) build("python3", ["-m", "zipfile", "-e", archive, extracted]);
    else await extractTar(archive, extracted, AbortSignal.timeout(120000), true);
    const entries = readdirSync(extracted);
    if (entries.length !== 1) throw new Error("Unexpected upstream archive layout");
    const stage = join(extracted, entries[0]!);
    const binary = target.startsWith("win-") ? "t3.exe" : "t3";
    if (!statSync(join(stage, binary)).isFile()) throw new Error("Upstream runtime missing");
    build("node", ["apps/server/scripts/cli.ts", "build-exe", "--target", target, "--verbose"]);
    const built = join(
      root,
      "apps/server/dist-exe",
      `t3-${target}${target.startsWith("win-") ? ".exe" : ""}`,
    );
    cpSync(built, join(stage, binary));
    chmodSync(join(stage, binary), 0o755);
    rmSync(join(stage, "client"), { recursive: true, force: true });
    cpSync(join(root, "apps/web/dist"), join(stage, "client"), { recursive: true });
    writeFileSync(
      join(stage, "hub-revision.json"),
      JSON.stringify({
        revision,
        baseline: maintained.baseline,
        patchVersion: maintained.patchVersion,
        protocol: 1,
      }),
    );
    const file = `t3-hub-${target}.tar`,
      packed = join(output, file);
    build("/usr/bin/tar", [
      "--owner=0",
      "--group=0",
      "--mode=u+rwX,go+rX,go-w",
      "-cf",
      packed,
      "-C",
      stage,
      ".",
    ]);
    artifacts.push({
      platform: target,
      file,
      bytes: statSync(packed).size,
      sha256: await hash(packed),
    });
  }
  // The manifest is written last: an interrupted build is never a publishable release.
  const manifest = parseManifest({
    schema: 1,
    protocol: 1,
    baseline: maintained.baseline,
    revision,
    patchVersion: maintained.patchVersion,
    artifacts,
  });
  writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(`Staged verified artifacts: ${output}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
