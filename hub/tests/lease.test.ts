import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { verifyLease } from "../src/lease.ts";
import { validateAssertion } from "../src/authelia.ts";
import { agentRequestAllowed, packets, frame } from "../src/agent-proxy.ts";
import { Readable } from "node:stream";

test("signed lease pins nonce, host, artifact, deadline and stable baseline", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const now = Date.now();
  const value = {
    protocol: 1,
    alias: "remote",
    request_id: "a".repeat(64),
    nonce: "nonce",
    issued_at: now,
    expires_at: now + 60000,
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
  const envelope = () => {
    const bytes = Buffer.from(JSON.stringify(value));
    return {
      payload: bytes.toString("base64url"),
      signature: sign(null, bytes, privateKey).toString("base64url"),
    };
  };
  const key = publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.equal(verifyLease(envelope(), key, "remote", "nonce", now).manifest.baseline, "v0.0.42");
  assert.throws(() => verifyLease(envelope(), key, "other", "nonce", now), /scope/);
  assert.throws(
    () => verifyLease(envelope(), key, "remote", "replayed-on-other-connection", now),
    /nonce/,
  );
  assert.throws(() => verifyLease(envelope(), key, "remote", "nonce", now + 61000), /expired/);
  value.expires_at = now + 49 * 3600000;
  assert.throws(() => verifyLease(envelope(), key, "remote", "nonce", now), /lifetime/);
  value.expires_at = now + 60000;
  value.manifest.baseline = "v0.0.43-nightly";
  assert.throws(() => verifyLease(envelope(), key, "remote", "nonce", now), /stable/);
});
test("WebAuthn binding checks require origin, RP, user verification and fresh challenge", () => {
  const now = Date.now(),
    origin = "https://hub.example",
    rp = "hub.example",
    challenge = Buffer.alloc(32, 1).toString("base64url");
  const auth = Buffer.concat([
    createHash("sha256").update(rp).digest(),
    Buffer.from([5, 0, 0, 0, 0]),
  ]);
  const client = { type: "webauthn.get", origin, challenge, crossOrigin: false };
  const assertion = {
    id: "aWQ",
    rawId: "aWQ",
    type: "public-key",
    response: {
      clientDataJSON: Buffer.from(JSON.stringify(client)).toString("base64url"),
      authenticatorData: auth.toString("base64url"),
      signature: "c2ln",
      userHandle: "dXNlcg",
    },
  };
  assert.equal(validateAssertion(assertion, challenge, now + 1000, origin, rp, now), "dXNlcg");
  assert.throws(() => validateAssertion(assertion, challenge, now, origin, rp, now), /expired/);
  assert.throws(
    () => validateAssertion(assertion, challenge, now + 1000, "https://wrong.example", rp, now),
    /origin/,
  );
  auth[32] = 1;
  assertion.response.authenticatorData = auth.toString("base64url");
  assert.throws(
    () => validateAssertion(assertion, challenge, now + 1000, origin, rp, now),
    /verification/,
  );
});
test("signer proxy rejects identity mutation and enforces bounded complete frames", async () => {
  assert.equal(agentRequestAllowed(Buffer.from([11])), true);
  assert.equal(agentRequestAllowed(Buffer.from([13, 0])), true);
  for (const command of [17, 18, 19, 20, 22, 23, 25, 26])
    assert.equal(agentRequestAllowed(Buffer.from([command])), false);
  const bytes = frame(Buffer.from([11]));
  const found: Buffer[] = [];
  for await (const packet of packets(Readable.from([bytes.subarray(0, 2), bytes.subarray(2)])))
    found.push(packet);
  assert.deepEqual(found, [Buffer.from([11])]);
  await assert.rejects(async () => {
    for await (const _ of packets(Readable.from([bytes.subarray(0, 4)]))) {
    }
  }, /Truncated/);
});
