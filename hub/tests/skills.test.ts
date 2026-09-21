import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { collectSkills, parseSkills, installSkills } from "../src/skills.ts";
import { EnvironmentManager } from "../src/environments.ts";
import { fixture } from "./fixture.ts";

async function put(root: string, path: string, data: string, mode = 0o600) {
  const target = NodePath.join(root, path);
  await NodeFS.promises.mkdir(NodePath.join(target, ".."), { recursive: true });
  await NodeFS.promises.writeFile(target, data, { mode });
}
NodeTest.test(
  "complete provider bundles sync, rebase skill paths, update automatically, and preserve remote-only skills and backups",
  async () => {
    const temp = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hub-skills-"));
    const source = NodePath.join(temp, "hub"),
      remote = NodePath.join(temp, "remote");
    await NodeFS.promises.mkdir(remote);
    try {
      await put(
        source,
        ".codex/skills/example/SKILL.md",
        `${source}/.codex/skills/example/scripts/run.sh\nHub-only path: /home/sean/workspaces/hub`,
      );
      await put(source, ".codex/skills/example/scripts/run.sh", "#!/bin/sh\ntrue\n", 0o700);
      await put(source, ".codex/skills/example/references/help.md", "reference");
      await put(source, ".codex/skills/example/.env", "fixture secret");
      await put(source, ".codex/skills/.system/builtin/SKILL.md", "bundled");
      await put(source, ".codex/auth.json", "fixture credential");
      await put(source, ".claude/skills/example/SKILL.md", "Claude-specific variant");
      await put(source, ".claude/skills/synced/account/private/SKILL.md", "provider-managed");
      await put(remote, ".codex/skills/local/SKILL.md", "remote only");
      await put(remote, ".codex/skills/example/SKILL.md", "remote original");
      const snapshot = await collectSkills(source),
        bytes = Buffer.from(JSON.stringify(snapshot));
      NodeAssert.equal(snapshot.bundles.length, 3);
      NodeAssert.ok(
        !bytes.includes(Buffer.from("fixture secret")) &&
          !bytes.includes(Buffer.from("fixture credential")),
      );
      await installSkills(bytes, remote);
      NodeAssert.equal(
        await NodeFS.promises.readFile(
          NodePath.join(remote, ".claude/skills/example/SKILL.md"),
          "utf8",
        ),
        "Claude-specific variant",
      );
      NodeAssert.ok(
        (
          await NodeFS.promises.readFile(
            NodePath.join(remote, ".codex/skills/example/SKILL.md"),
            "utf8",
          )
        ).startsWith(`${remote}/.codex/skills/`),
      );
      NodeAssert.equal(
        (await NodeFS.promises.stat(NodePath.join(remote, ".codex/skills/example/scripts/run.sh")))
          .mode & 0o777,
        0o700,
      );
      const backups = NodePath.join(remote, ".t3-hub-skills/backups");
      NodeAssert.equal((await NodeFS.promises.readdir(backups)).length, 1);
      await installSkills(bytes, remote);
      NodeAssert.equal(
        (await NodeFS.promises.readdir(backups)).length,
        1,
        "unchanged files do not generate backups",
      );
      await put(source, ".codex/skills/example/SKILL.md", "new hub version");
      await installSkills(Buffer.from(JSON.stringify(await collectSkills(source))), remote);
      NodeAssert.equal(
        await NodeFS.promises.readFile(
          NodePath.join(remote, ".codex/skills/example/SKILL.md"),
          "utf8",
        ),
        "new hub version",
      );
      NodeAssert.equal((await NodeFS.promises.readdir(backups)).length, 2);
      NodeAssert.equal(
        await NodeFS.promises.readFile(
          NodePath.join(remote, ".codex/skills/local/SKILL.md"),
          "utf8",
        ),
        "remote only",
      );
      await NodeFS.promises.rm(NodePath.join(source, ".codex/skills/example"), { recursive: true });
      await installSkills(Buffer.from(JSON.stringify(await collectSkills(source))), remote);
      NodeAssert.equal(
        await NodeFS.promises.readFile(
          NodePath.join(remote, ".codex/skills/example/SKILL.md"),
          "utf8",
        ),
        "new hub version",
      );
    } finally {
      await NodeFS.promises.rm(temp, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "skill paths, symlinks, collisions and secrets cannot redirect synchronization",
  async () => {
    const temp = await NodeFS.promises.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "hub-skills-safety-"),
    );
    try {
      await put(temp, ".codex/skills/example/SKILL.md", "fixture");
      const snapshot = await collectSkills(temp);
      for (const path of [
        "../../auth.json",
        "/tmp/escape",
        "C:\\escape",
        "file:stream",
        "CON",
        "a/../b",
        ".env",
        ".t3-hub-skill.json",
      ]) {
        const bad = structuredClone(snapshot);
        bad.bundles[0]!.files.push({ path, data: "", executable: false });
        NodeAssert.throws(() => parseSkills(Buffer.from(JSON.stringify(bad))));
      }
      const collision = structuredClone(snapshot);
      collision.bundles.push({ ...collision.bundles[0]!, name: "EXAMPLE" });
      NodeAssert.throws(() => parseSkills(Buffer.from(JSON.stringify(collision))), /Duplicate/);
      await NodeFS.promises.symlink(
        NodePath.join(temp, ".codex/skills/example/SKILL.md"),
        NodePath.join(temp, ".codex/skills/example/link"),
      );
      await NodeAssert.rejects(collectSkills(temp), /symlink/);
      const remote = NodePath.join(temp, "remote");
      await NodeFS.promises.mkdir(remote);
      await NodeFS.promises.symlink(NodePath.join(temp, ".codex"), NodePath.join(remote, ".codex"));
      await NodeAssert.rejects(
        installSkills(Buffer.from(JSON.stringify(snapshot)), remote),
        /symlink/,
      );
    } finally {
      await NodeFS.promises.rm(temp, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "publishing skills never grants access, connects, or changes a fixed deadline",
  async () => {
    const f = fixture(),
      manager = new EnvironmentManager(f.broker);
    const bytes = Buffer.from(JSON.stringify({ schema: 1, sourceHome: "/fixture", bundles: [] }));
    try {
      manager.publishSkills(bytes);
      await manager.tick();
      NodeAssert.equal(f.broker.requests.size, 0);
      await NodeAssert.rejects(manager.open("remote"), /locked/);
      manager.connect(1000, "remote", 60);
      const before = f.broker.list(1000).requests[0]!;
      manager.publishSkills(bytes);
      NodeAssert.deepEqual(f.broker.list(1000).requests[0], before);
      await NodeAssert.rejects(manager.open("remote"), /locked/);
    } finally {
      manager.close();
      f.broker.close();
    }
  },
);
