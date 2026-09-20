import { protectedPath } from "./protected-path.ts";
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import { createReadStream, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import type { ReleaseManifest, Artifact } from "./types.ts";
import { fields, record, text, integer, requireThat } from "./io.ts";

export function parseManifest(value: unknown): ReleaseManifest {
  const m = fields(value, [
    "schema",
    "baseline",
    "revision",
    "patchVersion",
    "protocol",
    "artifacts",
  ]);
  requireThat(
    m.schema === 1 &&
      m.protocol === 1 &&
      /^v\d+\.\d+\.\d+$/.test(text(m.baseline)) &&
      /^[a-f0-9]{40}$/.test(text(m.revision)) &&
      /^\d+\.\d+\.\d+$/.test(text(m.patchVersion)),
    "Invalid stable release manifest",
  );
  requireThat(
    Array.isArray(m.artifacts) && m.artifacts.length > 0 && m.artifacts.length <= 6,
    "Release artifacts required",
  );
  const seen = new Set<string>();
  for (const value of m.artifacts) {
    const artifact = fields(value, ["platform", "file", "sha256", "bytes"]);
    requireThat(
      /^(linux|darwin|win)-(arm64|x64)$/.test(text(artifact.platform)) &&
        !seen.has(text(artifact.platform)),
      "Invalid or duplicate platform",
    );
    seen.add(text(artifact.platform));
    requireThat(
      text(artifact.file) === basename(text(artifact.file)) &&
        /^[A-Za-z0-9_.-]+\.tar$/.test(text(artifact.file)) &&
        /^[a-f0-9]{64}$/.test(text(artifact.sha256)) &&
        integer(artifact.bytes) > 0 &&
        integer(artifact.bytes) <= 1024 ** 3,
      "Invalid release artifact",
    );
  }
  return m as unknown as ReleaseManifest;
}
export function loadManifest(directory: string) {
  const path = join(directory, "manifest.json"),
    info = lstatSync(path);
  protectedPath(path);
  requireThat(
    info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0 && info.size <= 65536,
    "Release manifest must be administrator-owned",
  );
  return parseManifest(JSON.parse(readFileSync(path, "utf8")));
}
export async function verifyArtifact(directory: string, artifact: Artifact, requireOwner = true) {
  const path = join(directory, artifact.file),
    info = lstatSync(path),
    root = realpathSync(directory);
  requireThat(
    info.isFile() &&
      (!requireOwner || info.uid === 0) &&
      (info.mode & 0o022) === 0 &&
      info.size === artifact.bytes &&
      realpathSync(path) === join(root, artifact.file),
    "Untrusted release artifact",
  );
  if (requireOwner) protectedPath(path);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  requireThat(hash.digest("hex") === artifact.sha256, "Artifact checksum mismatch");
  return path;
}
