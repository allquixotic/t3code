import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { RemoteSession, type RemoteConfig } from "../src/remote.ts";
import { Protocol } from "../src/protocol.ts";
import type { Lease } from "../src/lease.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hub-remote-test-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const protocol = new Protocol(new PassThrough(), new PassThrough());
  const config: RemoteConfig = {
    alias: "fixture",
    socket: join(directory, "socket"),
    public_key: publicKey.export({ format: "pem", type: "spki" }).toString(),
    ssh_user: "fixture",
    runtime_user: "fixture",
    runtime_home: directory,
    root_directory: join(directory, "releases"),
    base_directory: join(directory, "state"),
    runtime_uid: 1000,
    runtime_gid: 1000,
  };
  let reserved = false,
    released = false;
  const session = new RemoteSession(
    config,
    protocol,
    () => {
      reserved = true;
    },
    () => {
      released = true;
    },
  );
  const lease: Lease = {
    protocol: 1,
    alias: "fixture",
    request_id: "a".repeat(64),
    nonce: session.nonce,
    issued_at: Date.now(),
    expires_at: Date.now() + 60000,
    manifest: {
      schema: 1,
      protocol: 1,
      baseline: "v0.0.42",
      revision: "b".repeat(40),
      patchVersion: "1.0.0",
      artifacts: [
        { platform: "linux-x64", file: "runtime.tar", sha256: "c".repeat(64), bytes: 100 },
      ],
    },
  };
  const activate = () => {
    const bytes = Buffer.from(JSON.stringify(lease));
    return session.handle("lease", {
      payload: bytes.toString("base64url"),
      signature: sign(null, bytes, privateKey).toString("base64url"),
    });
  };
  return {
    session,
    lease,
    activate,
    directory,
    config,
    reserved: () => reserved,
    released: () => released,
    cleanup: async () => {
      await session.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("remote rejects replay/scope changes and locks on absolute expiry", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.session.handle("install-begin", {}), /locked/);
    f.lease.expires_at = Date.now() + 60;
    await f.activate();
    assert.equal(f.reserved(), true);
    await assert.rejects(f.activate(), /immutable/);
    await new Promise((resolve) => setTimeout(resolve, 85));
    assert.equal(f.released(), true);
    await assert.rejects(f.session.handle("heartbeat", {}), /locked/);
    assert.equal(existsSync(f.config.root_directory), false);
  } finally {
    await f.cleanup();
  }
});
test("remote lost-heartbeat closes its lease without approval renewal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    await f.activate();
    t.mock.timers.tick(12001);
    await Promise.resolve();
    assert.equal(f.released(), true);
    await assert.rejects(f.session.handle("heartbeat", {}), /locked/);
  } finally {
    await f.cleanup();
  }
});
test("interrupted or corrupt updates never replace the installed revision", async () => {
  const f = fixture();
  try {
    await f.activate();
    const artifact = f.lease.manifest.artifacts[0]!;
    await assert.rejects(
      f.session.handle("install-begin", { artifact: { ...artifact, sha256: "d".repeat(64) } }),
      /signed lease/,
    );
    await f.session.handle("install-begin", { artifact });
    await f.session.handle("install-chunk", { data: Buffer.alloc(100).toString("base64") });
    await assert.rejects(f.session.handle("install-finish", {}), /checksum/);
    assert.equal(existsSync(join(f.config.root_directory, "current.json")), false);
    await f.session.close();
    assert.deepEqual(readdirSync(f.config.root_directory), []);
  } finally {
    await f.cleanup();
  }
});
test("verified artifact installs atomically with the exact signed revision", async () => {
  const f = fixture();
  try {
    const binary = join(f.directory, "t3");
    writeFileSync(binary, "#!/bin/sh\nprintf '0.0.42\\n'\n");
    chmodSync(binary, 0o755);
    const archive = join(f.directory, "runtime.tar");
    execFileSync("/usr/bin/tar", ["-cf", archive, "-C", f.directory, "t3"]);
    const bytes = readFileSync(archive),
      artifact = f.lease.manifest.artifacts[0]!;
    artifact.bytes = bytes.length;
    artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
    await f.activate();
    await f.session.handle("install-begin", { artifact });
    await f.session.handle("install-chunk", { data: bytes.toString("base64") });
    assert.deepEqual(await f.session.handle("install-finish", {}), {
      revision: f.lease.manifest.revision,
    });
    assert.equal(
      JSON.parse(readFileSync(join(f.config.root_directory, "current.json"), "utf8")).revision,
      f.lease.manifest.revision,
    );
    assert.deepEqual(
      readdirSync(f.config.root_directory).sort(),
      [f.lease.manifest.revision, "current.json"].sort(),
    );
  } finally {
    await f.cleanup();
  }
});
