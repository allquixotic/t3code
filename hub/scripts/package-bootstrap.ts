import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hubOnly, root } from "./maintain.ts";

// Small first-enrollment transport using an administrator-owned Node runtime.
// The full runtime still arrives through the signed, timed native update protocol.
hubOnly();
const destination = resolve(process.argv[2] ?? "hub/bootstrap.tar");
const platform = process.argv[3] ?? "linux";
if (!["linux", "darwin"].includes(platform)) throw new Error("Choose linux or darwin bootstrap");
const node = platform === "darwin" ? "/var/lib/t3-hub/node/bin/node" : "/usr/bin/node";
const temporary = mkdtempSync(join(tmpdir(), "t3-hub-bootstrap-"));
try {
  const source = join(root, "hub/dist/src");
  mkdirSync(join(temporary, "src"));
  for (const name of [
    "remote",
    "archive",
    "artifacts",
    "agent-proxy",
    "peercred",
    "protocol",
    "lease",
    "io",
    "protected-path",
  ])
    cpSync(join(source, name + ".js"), join(temporary, "src", name + ".js"));
  writeFileSync(join(temporary, "package.json"), '{"type":"module"}\n');
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  writeFileSync(join(temporary, "bootstrap-revision"), revision + "\n");
  writeFileSync(
    join(temporary, "t3"),
    `#!/bin/sh\nexec ${node} "$(dirname -- "$0")/bootstrap.mjs" "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(temporary, "bootstrap.mjs"),
    `
import { readFileSync, lstatSync } from 'node:fs';
import { protectedPath } from './src/protected-path.js';
import { parseRemoteConfig, remoteConnect, remoteServer, superviseRemote } from './src/remote.js';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  console.log('T3 Hub enrollment supervisor ${revision}; full runtime requires a signed lease');
} else {
  if (process.platform !== '${platform}' || args.length !== 4 || args[0] !== '__hub-agent' || args[2] !== '--config')
    throw new Error('Only the ${platform} enrollment supervisor is available');
  protectedPath(process.execPath);
  const path = args[3], action = args[1], info = lstatSync(path);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error('Administrator-owned remote policy required');
  protectedPath(path);
  const policy = parseRemoteConfig(JSON.parse(readFileSync(path, 'utf8')));
  protectedPath(policy.root_directory);
  if (action === 'connect') await remoteConnect(policy.socket);
  else if (action === 'supervise') await superviseRemote(policy, path);
  else {
    if (action !== 'serve' || process.getuid() !== 0) throw new Error('Protected supervisor identity required');
    const service = remoteServer(policy);
    await new Promise((resolve, reject) => {
      service.server.once('error', reject);
      service.server.once('upgraded', resolve);
      const stop = () => { void service.close().then(resolve, reject); };
      process.once('SIGTERM', stop); process.once('SIGINT', stop);
    });
  }
}
`,
  );
  execFileSync(process.execPath, [join(temporary, "bootstrap.mjs"), "--version"], {
    stdio: "inherit",
  });
  execFileSync("tar", ["-cf", destination, "-C", temporary, "."]);
  console.log(
    JSON.stringify({
      file: destination,
      revision,
      sha256: createHash("sha256").update(readFileSync(destination)).digest("hex"),
    }),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
