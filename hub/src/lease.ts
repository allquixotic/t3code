import { protectedPath } from "./protected-path.ts";
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import { sign, verify, createPrivateKey, createPublicKey } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { fields, record, text, integer, requireThat } from "./io.ts";
import { parseManifest } from "./artifacts.ts";
import type { ReleaseManifest } from "./types.ts";

export interface Lease {
  protocol: 1;
  alias: string;
  request_id: string;
  nonce: string;
  issued_at: number;
  expires_at: number;
  manifest: ReleaseManifest;
}
export function signLease(lease: Lease, keyPath: string) {
  protectedPath(keyPath);
  const info = lstatSync(keyPath);
  requireThat(
    info.isFile() && info.uid === 0 && (info.mode & 0o027) === 0 && info.size <= 4096,
    "Protected lease signing key required",
  );
  const bytes = readFileSync(keyPath);
  try {
    requireThat(
      createPrivateKey(bytes).asymmetricKeyType === "ed25519",
      "Ed25519 lease key required",
    );
    const payload = Buffer.from(JSON.stringify(lease));
    return {
      payload: payload.toString("base64url"),
      signature: sign(null, payload, createPrivateKey(bytes)).toString("base64url"),
    };
  } finally {
    bytes.fill(0);
  }
}
export function verifyLease(
  envelope: unknown,
  publicKey: string,
  alias: string,
  nonce: string,
  now = Date.now(),
): Lease {
  requireThat(
    createPublicKey(publicKey).asymmetricKeyType === "ed25519",
    "Ed25519 lease key required",
  );
  const data = fields(envelope, ["payload", "signature"]),
    payload = Buffer.from(text(data.payload), "base64url");
  requireThat(
    payload.length <= 16384 &&
      verify(null, payload, publicKey, Buffer.from(text(data.signature), "base64url")),
    "Lease signature invalid",
  );
  const lease = fields(JSON.parse(payload.toString()), [
    "protocol",
    "alias",
    "request_id",
    "nonce",
    "issued_at",
    "expires_at",
    "manifest",
  ]);
  requireThat(
    lease.protocol === 1 &&
      lease.alias === alias &&
      lease.nonce === nonce &&
      /^[a-f0-9]{64}$/.test(text(lease.request_id)),
    "Lease scope or nonce mismatch",
  );
  requireThat(
    integer(lease.issued_at) <= now + 5000 &&
      now - integer(lease.issued_at) <= 60000 &&
      integer(lease.expires_at) > now &&
      integer(lease.expires_at) - integer(lease.issued_at) <= 172800000,
    "Lease expired or outside allowed lifetime",
  );
  return { ...lease, manifest: parseManifest(lease.manifest) } as unknown as Lease;
}
