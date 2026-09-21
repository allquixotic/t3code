import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { parseProbe, remoteSetupConfig, validateExistingSetup } from "../src/provision.ts";

const posix = (os = "Darwin", arch = "arm64", config = "MISSING") =>
  [os, arch, "MacBook-Pro.local", "sean", "/Users/sean", "/Users/sean", "501", "20", config].join(
    "\n",
  );
NodeTest.test(
  "first connection discovers actual platform and identity without assuming SSH alias is hostname",
  () => {
    const identity = parseProbe(posix(), false, "sean");
    NodeAssert.equal(identity.platform, "darwin-arm64");
    NodeAssert.equal(identity.hostname, "MacBook-Pro.local");
    const config = remoteSetupConfig("mbp", identity, "public-key");
    NodeAssert.equal(config.alias, "mbp");
    NodeAssert.equal(config.runtime_home, "/Users/sean");
    NodeAssert.equal(config.runtime_uid, 501);
    NodeAssert.equal(config.socket, "/var/lib/t3-hub/run/supervisor.sock");
    NodeAssert.throws(() => parseProbe(posix(), false, "someone-else"), /account/);
    NodeAssert.throws(() => parseProbe(posix("Linux", "mips"), false, "sean"), /not supported/);
    NodeAssert.throws(
      () => parseProbe(posix().replace("501", "NaN"), false, "sean"),
      /numeric identity/,
    );
  },
);
NodeTest.test(
  "reconnect reuses only enrollment pinned to the same hub, host alias and runtime account",
  () => {
    const identity = parseProbe(posix("Linux", "aarch64"), false, "sean");
    const config = remoteSetupConfig("remote", identity, "public-key");
    const existing = { ...identity, existing: { ...config } };
    validateExistingSetup(existing, config);
    for (const key of [
      "alias",
      "public_key",
      "runtime_home",
      "runtime_uid",
      "ssh_user",
      "root_directory",
      "socket",
    ])
      NodeAssert.throws(
        () =>
          validateExistingSetup(
            { ...existing, existing: { ...config, [key]: "tampered" } },
            config,
          ),
        /no files were replaced/,
      );
  },
);
NodeTest.test(
  "Windows setup uses the actual enrolled account and protected ProgramData paths",
  () => {
    const identity = parseProbe(
      JSON.stringify({
        os: "Windows",
        arch: "X64",
        hostname: "winbox",
        user: "sean",
        cwd: "C:\\Users\\sean",
        home: "C:\\Users\\sean",
      }),
      true,
      "sean",
    );
    const config = remoteSetupConfig("winbox", identity, "public-key");
    NodeAssert.equal(identity.platform, "win-x64");
    NodeAssert.equal(config.runtime_user, "sean");
    NodeAssert.equal(config.root_directory, "C:\\ProgramData\\t3-hub\\releases");
    NodeAssert.equal(config.runtime_uid, undefined);
    NodeAssert.equal(config.socket, "\\\\.\\pipe\\t3-hub-supervisor");
  },
);
