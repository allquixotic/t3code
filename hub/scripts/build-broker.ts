import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { hubOnly, root } from "./maintain.ts";
hubOnly();
for (const [binary, args] of [
  [
    "node_modules/.bin/tsc",
    [
      "-p",
      "hub/tsconfig.json",
      "--noEmit",
      "false",
      "--rewriteRelativeImportExtensions",
      "--outDir",
      "hub/dist",
    ],
  ],
  [
    "gcc",
    [
      "-shared",
      "-fPIC",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      `-I${resolve(realpathSync(process.execPath), "../../include/node")}`,
      "hub/native/peercred.c",
      "-o",
      "hub/native/peercred.node",
    ],
  ],
] as const) {
  const result = spawnSync(binary, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, GOMEMLIMIT: "1GiB", GOMAXPROCS: "2" },
  });
  if (result.status !== 0) throw new Error("Broker build failed");
}
for (const path of ["web", "native"]) {
  mkdirSync(resolve(root, "hub/dist", path), { recursive: true });
  cpSync(resolve(root, "hub", path), resolve(root, "hub/dist", path), { recursive: true });
}
writeFileSync(resolve(root, "hub/dist/package.json"), '{"type":"module"}\n');
console.log(`Staged TypeScript broker: ${resolve(root, "hub/dist")}`);
