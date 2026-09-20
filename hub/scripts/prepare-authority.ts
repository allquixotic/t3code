import { hostname } from "node:os";
import { existsSync, readFileSync, writeFileSync, chownSync, lstatSync, chmodSync } from "node:fs";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { protectedPath } from "../src/protected-path.ts";

if (hostname().split(".")[0] !== "t3code" || process.getuid?.() !== 0)
  throw new Error("Run authority preparation as administrator on t3code");
protectedPath("/etc/hub-broker");
const keyPath = "/etc/hub-broker/lease-ed25519.pem",
  publicPath = "/etc/hub-broker/lease-ed25519.pub";
const group = Number(
  execFileSync("getent", ["group", "hub-broker"], { encoding: "utf8" }).split(":")[2],
);
if (!Number.isSafeInteger(group) || group <= 0) throw new Error("Broker group unavailable");
if (!existsSync(keyPath)) {
  const pair = generateKeyPairSync("ed25519");
  const bytes = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  try {
    writeFileSync(keyPath, bytes, { flag: "wx", mode: 0o440 });
    chownSync(keyPath, 0, group);
    chmodSync(keyPath, 0o440);
  } finally {
    bytes.fill(0);
  }
}
protectedPath(keyPath);
const info = lstatSync(keyPath);
if (!info.isFile() || info.gid !== group || (info.mode & 0o777) !== 0o440)
  throw new Error("Lease key ownership or mode mismatch");
const bytes = readFileSync(keyPath);
try {
  const key = createPublicKey(bytes);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 authority required");
  const pem = key.export({ type: "spki", format: "pem" }).toString();
  if (existsSync(publicPath)) {
    protectedPath(publicPath);
    if (readFileSync(publicPath, "utf8") !== pem)
      throw new Error("Existing public authority mismatch; do not rotate enrolled trust");
  } else {
    writeFileSync(publicPath, pem, { flag: "wx", mode: 0o644 });
    chmodSync(publicPath, 0o644);
  }
} finally {
  bytes.fill(0);
}
console.log(
  `Authority ready. Only the public key ${publicPath} may be copied to remote enrollment bundles.`,
);
