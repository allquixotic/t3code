// @effect-diagnostics nodeBuiltinImport:off globalDate:off - bounded, user-owned skill file replication.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { digest, record, text, requireThat } from "./io.ts";

export const SKILLS_LIMIT = 32 << 20;
const FILE_LIMIT = 4 << 20;
const ROOTS = [".codex/skills", ".agents/skills", ".claude/skills"] as const;
const OMIT = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".DS_Store",
  ".trash",
  "synced",
  ".t3-hub-skill.json",
]);
const secretName =
  /^(?:\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx|pyc))$/i;
interface SkillFile {
  path: string;
  data: string;
  executable: boolean;
}
interface SkillBundle {
  root: (typeof ROOTS)[number];
  name: string;
  files: SkillFile[];
}
export interface SkillsSnapshot {
  schema: 1;
  sourceHome: string;
  bundles: SkillBundle[];
}

function safePath(value: string) {
  requireThat(
    value.length > 0 &&
      value.length < 1024 &&
      value
        .split("/")
        .every(
          (part) =>
            /^[A-Za-z0-9_. @()+,-]+$/.test(part) &&
            part !== "." &&
            part !== ".." &&
            !part.endsWith(".") &&
            !part.endsWith(" ") &&
            !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ),
    "Unsafe skill path",
  );
  return value;
}
async function regularFile(path: string) {
  const handle = await NodeFS.promises.open(
    path,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    requireThat(
      stat.isFile() && stat.nlink === 1 && stat.size <= FILE_LIMIT,
      "Unsupported skill file",
    );
    return { bytes: await handle.readFile(), executable: (stat.mode & 0o111) !== 0 };
  } finally {
    await handle.close();
  }
}
async function directory(path: string, create = false) {
  if (create) await NodeFS.promises.mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await NodeFS.promises.lstat(path);
  requireThat(
    stat.isDirectory() && !stat.isSymbolicLink(),
    "Skill directory must not be a symlink",
  );
}
async function exists(path: string) {
  try {
    await NodeFS.promises.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Only actual installed personal bundles, never config/auth or plugin caches. */
export async function collectSkills(home: string): Promise<SkillsSnapshot> {
  const bundles: SkillBundle[] = [];
  let bytes = 0;
  for (const root of ROOTS) {
    const base = NodePath.join(home, root);
    if (!(await exists(base))) continue;
    await directory(base);
    const discover = async (path: string, prefix = "") => {
      for (const entry of (await NodeFS.promises.readdir(path, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        requireThat(!entry.isSymbolicLink(), "Skill bundles cannot be symlinks");
        if (
          !entry.isDirectory() ||
          OMIT.has(entry.name) ||
          (entry.name.startsWith(".") && entry.name !== ".system")
        )
          continue;
        const name = safePath(prefix + entry.name),
          bundleDir = NodePath.join(path, entry.name);
        if (entry.name === ".system") {
          await discover(bundleDir, ".system/");
          continue;
        }
        if (!(await exists(NodePath.join(bundleDir, "SKILL.md")))) continue;
        const files: SkillFile[] = [];
        const walk = async (dir: string, relative = "") => {
          await directory(dir);
          for (const file of (await NodeFS.promises.readdir(dir, { withFileTypes: true })).sort(
            (a, b) => a.name.localeCompare(b.name),
          )) {
            if (OMIT.has(file.name) || secretName.test(file.name)) continue;
            const rel = safePath(relative + file.name);
            requireThat(!file.isSymbolicLink(), "Skill bundles cannot contain symlinks");
            if (file.isDirectory()) await walk(NodePath.join(dir, file.name), rel + "/");
            else {
              const content = await regularFile(NodePath.join(dir, file.name));
              bytes += content.bytes.length;
              requireThat(
                bytes <= SKILLS_LIMIT / 2 && files.length < 4096,
                "Skill collection too large",
              );
              files.push({
                path: rel,
                data: content.bytes.toString("base64"),
                executable: content.executable,
              });
            }
          }
        };
        await walk(bundleDir);
        requireThat(
          files.some((f) => f.path === "SKILL.md"),
          "Skill entrypoint missing",
        );
        bundles.push({ root, name, files });
      }
    };
    await discover(base);
  }
  return { schema: 1, sourceHome: NodePath.resolve(home), bundles };
}

export function parseSkills(bytes: Buffer): SkillsSnapshot {
  requireThat(bytes.length <= SKILLS_LIMIT, "Skill collection too large");
  const value = record(JSON.parse(bytes.toString()));
  requireThat(
    value.schema === 1 && Array.isArray(value.bundles) && value.bundles.length <= 512,
    "Invalid skill snapshot",
  );
  const sourceHome = text(value.sourceHome);
  requireThat(sourceHome.startsWith("/") && sourceHome.length < 1024, "Invalid skill source home");
  const seen = new Set<string>();
  const bundles = value.bundles.map((item) => {
    const bundle = record(item),
      root = text(bundle.root) as (typeof ROOTS)[number],
      name = safePath(text(bundle.name));
    requireThat(
      ROOTS.includes(root) && /^(?:\.system\/)?[^/]+$/.test(name) && !OMIT.has(name),
      "Invalid skill destination",
    );
    const key = `${root}/${name}`.toLowerCase();
    requireThat(!seen.has(key), "Duplicate skill destination");
    seen.add(key);
    requireThat(
      Array.isArray(bundle.files) && bundle.files.length > 0 && bundle.files.length <= 4096,
      "Invalid skill files",
    );
    const paths = new Set<string>();
    const files = bundle.files.map((item) => {
      const f = record(item),
        path = safePath(text(f.path)),
        data = text(f.data);
      requireThat(
        !paths.has(path.toLowerCase()) &&
          typeof f.executable === "boolean" &&
          data.length <= Math.ceil(FILE_LIMIT / 3) * 4 &&
          Buffer.from(data, "base64").toString("base64") === data &&
          !path.split("/").some((p) => OMIT.has(p) || secretName.test(p)),
        "Invalid skill file",
      );
      paths.add(path.toLowerCase());
      return { path, data, executable: f.executable };
    });
    requireThat(
      files.some((f) => f.path === "SKILL.md"),
      "Skill entrypoint missing",
    );
    return { root, name, files };
  });
  return { schema: 1, sourceHome, bundles };
}

/** Runs as the enrolled runtime user, never as the privileged supervisor. */
export async function installSkills(bytes: Buffer, home: string) {
  const snapshot = parseSkills(bytes);
  const state = NodePath.join(home, ".t3-hub-skills");
  await directory(home);
  await directory(state, true);
  const backups = NodePath.join(state, "backups");
  await directory(backups, true);
  const installed: string[] = [];
  for (const bundle of snapshot.bundles) {
    // Check every destination ancestor before any writes; never follow a remote skill symlink.
    let parent = home;
    const segments = `${bundle.root}/${bundle.name}`.split("/");
    for (const segment of segments.slice(0, -1)) {
      parent = NodePath.join(parent, segment);
      if (await exists(parent)) await directory(parent);
      else await NodeFS.promises.mkdir(parent, { mode: 0o700 });
    }
    const target = NodePath.join(home, bundle.root, bundle.name);
    const files = bundle.files.map((file) => {
      let content = Buffer.from(file.data, "base64");
      // Rebase skill references only. Machine-specific workspace paths and hub-only rules stay intact.
      if (/\.(?:md|txt|json|ya?ml|toml|py|sh|js|ts)$/.test(file.path)) {
        let text = content.toString("utf8");
        if (Buffer.from(text).equals(content)) {
          for (const root of ROOTS)
            text = text.replaceAll(
              `${snapshot.sourceHome}/${root}/`,
              `${home.replaceAll("\\", "/")}/${root}/`,
            );
          content = Buffer.from(text);
        }
      }
      return { ...file, content };
    });
    const hash = digest(
      JSON.stringify(files.map((f) => [f.path, f.content.toString("base64"), f.executable])),
    );
    const marker = NodePath.join(target, ".t3-hub-skill.json");
    if (await exists(target)) {
      await directory(target);
      // Compare all managed files, so a local edit cannot masquerade as the current hub version.
      let same = false;
      try {
        const previous = JSON.parse((await regularFile(marker)).bytes.toString());
        same = previous.hash === hash;
        for (const file of files) {
          const current = await regularFile(NodePath.join(target, file.path));
          if (!current.bytes.equals(file.content) || current.executable !== file.executable)
            same = false;
        }
      } catch {
        same = false;
      }
      if (same) {
        installed.push(`${bundle.root}/${bundle.name}`);
        continue;
      }
    }
    const stage = await NodeFS.promises.mkdtemp(NodePath.join(parent, ".t3-skills-"));
    let backup: string | undefined;
    try {
      for (const file of files) {
        const path = NodePath.join(stage, file.path);
        await NodeFS.promises.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
        await NodeFS.promises.writeFile(path, file.content, {
          flag: "wx",
          mode: file.executable ? 0o700 : 0o600,
        });
      }
      await NodeFS.promises.writeFile(
        NodePath.join(stage, ".t3-hub-skill.json"),
        JSON.stringify({ hash }),
        {
          flag: "wx",
          mode: 0o600,
        },
      );
      if (await exists(target)) {
        backup = NodePath.join(backups, `${Date.now()}-${digest(target).slice(0, 16)}`);
        await NodeFS.promises.rename(target, backup);
      }
      try {
        await NodeFS.promises.rename(stage, target);
      } catch (error) {
        if (backup) await NodeFS.promises.rename(backup, target);
        throw error;
      }
      installed.push(`${bundle.root}/${bundle.name}`);
    } finally {
      await NodeFS.promises.rm(stage, { recursive: true, force: true });
    }
  }
  // Source absence is not deletion authority: remote-only or removed hub bundles remain recoverable.
  const receipt = NodePath.join(state, ".last-sync-next.json");
  await NodeFS.promises.rm(receipt, { force: true });
  await NodeFS.promises.writeFile(
    receipt,
    JSON.stringify({ revision: digest(bytes), installed, time: new Date().toISOString() }),
    { mode: 0o600, flag: "wx" },
  );
  await NodeFS.promises.rename(receipt, NodePath.join(state, "last-sync.json"));
  return { revision: digest(bytes), bundles: installed.length };
}
