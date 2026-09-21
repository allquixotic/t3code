import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeStream from "node:stream";
import { RemoteSession, type RemoteConfig } from "../src/remote.ts";
import { Protocol } from "../src/protocol.ts";
import type { Lease } from "../src/lease.ts";

function fixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hub-remote-test-"));
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519");
  const protocol = new Protocol(new NodeStream.PassThrough(), new NodeStream.PassThrough());
  const config: RemoteConfig = {
    alias: "fixture",
    socket: NodePath.join(directory, "socket"),
    public_key: publicKey.export({ format: "pem", type: "spki" }).toString(),
    ssh_user: "fixture",
    runtime_user: "fixture",
    runtime_home: directory,
    root_directory: NodePath.join(directory, "releases"),
    base_directory: NodePath.join(directory, "state"),
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
      signature: NodeCrypto.sign(null, bytes, privateKey).toString("base64url"),
    });
  };
  return {
    session,
    lease,
    activate,
    envelope: (value: Lease) => {
      const bytes = Buffer.from(JSON.stringify(value));
      return {
        payload: bytes.toString("base64url"),
        signature: NodeCrypto.sign(null, bytes, privateKey).toString("base64url"),
      };
    },
    directory,
    config,
    reserved: () => reserved,
    released: () => released,
    cleanup: async () => {
      await session.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
}
NodeTest.test("remote rejects replay/scope changes and locks on absolute expiry", async () => {
  const f = fixture();
  try {
    await NodeAssert.rejects(f.session.handle("install-begin", {}), /locked/);
    f.lease.expires_at = Date.now() + 60;
    await f.activate();
    NodeAssert.equal(f.reserved(), true);
    await NodeAssert.rejects(f.activate(), /immutable/);
    await new Promise((resolve) => setTimeout(resolve, 85));
    NodeAssert.equal(f.released(), true);
    await NodeAssert.rejects(f.session.handle("heartbeat", {}), /locked/);
    NodeAssert.equal(NodeFS.existsSync(f.config.root_directory), false);
  } finally {
    await f.cleanup();
  }
});

NodeTest.test(
  "skill transfers require the existing signed lease and exact content without extending expiry",
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture();
    try {
      const bytes = Buffer.from(JSON.stringify({ schema: 1, sourceHome: "/fixture", bundles: [] }));
      const approved: Lease = {
        ...f.lease,
        skills: {
          bytes: bytes.length,
          sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        },
      };
      await NodeAssert.rejects(f.session.handle("skills-begin", f.envelope(approved)), /locked/);
      await f.activate();
      NodeFS.mkdirSync(f.config.root_directory, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(f.config.root_directory, "current.json"),
        JSON.stringify({ revision: f.lease.manifest.revision }),
      );
      await NodeAssert.rejects(
        f.session.handle(
          "skills-begin",
          f.envelope({ ...approved, expires_at: approved.expires_at + 1000 }),
        ),
        /outside current lease/,
      );
      await NodeAssert.rejects(
        f.session.handle("skills-begin", f.envelope({ ...approved, request_id: "d".repeat(64) })),
        /outside current lease/,
      );
      await NodeAssert.rejects(
        f.session.handle("skills-begin", f.envelope({ ...approved, nonce: "wrong" })),
        /nonce/,
      );
      NodeAssert.deepEqual(await f.session.handle("skills-begin", f.envelope(approved)), {
        unchanged: false,
      });
      await NodeAssert.rejects(f.session.handle("skills-finish", {}), /Incomplete/);
      await NodeAssert.rejects(
        f.session.handle("skills-chunk", {
          data: Buffer.alloc(bytes.length + 1).toString("base64"),
        }),
        /Invalid/,
      );
      await f.session.handle("skills-chunk", {
        data: Buffer.alloc(bytes.length).toString("base64"),
      });
      await NodeAssert.rejects(f.session.handle("skills-finish", {}), /checksum/);
      t.mock.timers.tick(60001);
      await Promise.resolve();
      await NodeAssert.rejects(
        f.session.handle("skills-chunk", { data: bytes.toString("base64") }),
        /locked/,
      );
      NodeAssert.equal(NodeFS.existsSync(NodePath.join(f.directory, ".codex")), false);
    } finally {
      await f.cleanup();
    }
  },
);
NodeTest.test("remote lost-heartbeat closes its lease without approval renewal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    await f.activate();
    t.mock.timers.tick(12001);
    await Promise.resolve();
    NodeAssert.equal(f.released(), true);
    await NodeAssert.rejects(f.session.handle("heartbeat", {}), /locked/);
  } finally {
    await f.cleanup();
  }
});
NodeTest.test("interrupted or corrupt updates never replace the installed revision", async () => {
  const f = fixture();
  try {
    await f.activate();
    const artifact = f.lease.manifest.artifacts[0]!;
    await NodeAssert.rejects(
      f.session.handle("install-begin", { artifact: { ...artifact, sha256: "d".repeat(64) } }),
      /signed lease/,
    );
    await f.session.handle("install-begin", { artifact });
    await f.session.handle("install-chunk", { data: Buffer.alloc(100).toString("base64") });
    await NodeAssert.rejects(f.session.handle("install-finish", {}), /checksum/);
    NodeAssert.equal(
      NodeFS.existsSync(NodePath.join(f.config.root_directory, "current.json")),
      false,
    );
    await f.session.close();
    NodeAssert.deepEqual(NodeFS.readdirSync(f.config.root_directory), []);
  } finally {
    await f.cleanup();
  }
});
NodeTest.test("verified artifact installs atomically with the exact signed revision", async () => {
  const f = fixture();
  const mask = process.umask(0o027);
  try {
    const binary = NodePath.join(f.directory, "t3");
    NodeFS.writeFileSync(binary, "#!/bin/sh\nprintf '0.0.42\\n'\n");
    NodeFS.chmodSync(binary, 0o755);
    const archive = NodePath.join(f.directory, "runtime.tar");
    NodeChildProcess.execFileSync("/usr/bin/tar", ["-cf", archive, "-C", f.directory, "t3"]);
    const bytes = NodeFS.readFileSync(archive),
      artifact = f.lease.manifest.artifacts[0]!;
    artifact.bytes = bytes.length;
    artifact.sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    await f.activate();
    await f.session.handle("install-begin", { artifact });
    await f.session.handle("install-chunk", { data: bytes.toString("base64") });
    NodeAssert.deepEqual(await f.session.handle("install-finish", {}), {
      revision: f.lease.manifest.revision,
    });
    NodeAssert.equal(
      JSON.parse(
        NodeFS.readFileSync(NodePath.join(f.config.root_directory, "current.json"), "utf8"),
      ).revision,
      f.lease.manifest.revision,
    );
    NodeAssert.equal(
      NodeFS.statSync(NodePath.join(f.config.root_directory, f.lease.manifest.revision)).mode &
        0o777,
      0o755,
    );
    NodeAssert.deepEqual(
      NodeFS.readdirSync(f.config.root_directory).sort(),
      [f.lease.manifest.revision, "current.json"].sort(),
    );
  } finally {
    process.umask(mask);
    await f.cleanup();
  }
});
