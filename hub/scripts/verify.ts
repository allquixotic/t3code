import { spawnSync } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubOnly, root } from "./maintain.ts";

hubOnly();
const logs = resolve(root, "hub/.test-state", new Date().toISOString().replace(/[^0-9]/g, ""));
mkdirSync(logs, { recursive: true });
const steps: [string, string, string[]][] = [
  [
    "native",
    "gcc",
    [
      "-shared",
      "-fPIC",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      `-I${resolve(process.execPath, "../../include/node")}`,
      "hub/native/peercred.c",
      "-o",
      "hub/native/peercred.node",
    ],
  ],
  ["hub-types", "node_modules/.bin/tsc", ["-p", "hub/tsconfig.json"]],
  ["hub-tests", "node", ["--test", "hub/tests/*.test.ts"]],
  ["server-types", "node_modules/.bin/vp", ["run", "--filter", "t3", "typecheck"]],
  ["web-types", "node_modules/.bin/vp", ["run", "--filter", "@t3tools/web", "typecheck"]],
  [
    "shared-tests",
    "node_modules/.bin/vp",
    [
      "test",
      "run",
      "packages/shared/src/remote.test.ts",
      "packages/shared/src/hubEndpoint.test.ts",
      "packages/client-runtime/src/environment/endpoint.test.ts",
      "packages/client-runtime/src/authorization/remote.test.ts",
      "packages/client-runtime/src/connection/resolver.test.ts",
      "apps/server/src/auth/dpop.test.ts",
    ],
  ],
];
for (const [name, binary, args] of steps) {
  const file = resolve(logs, `${name}.log`),
    fd = openSync(file, "w", 0o600);
  console.log(`Checking ${name}…`);
  const result = spawnSync(binary, args, {
    cwd: root,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, GOMEMLIMIT: "3GiB", GOMAXPROCS: "3" },
  });
  closeSync(fd);
  if (result.status !== 0) {
    console.error(
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !line.includes("suggestion TS"))
        .slice(-100)
        .join("\n"),
    );
    throw new Error(`${name} failed; inspect ${file}`);
  }
  console.log(`Passed ${name}: ${file}`);
}
console.log(
  "Validation complete. No live service, browser, passkey or remote-host test was performed by this script.",
);
