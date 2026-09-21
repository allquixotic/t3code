import { test } from "node:test";
import assert from "node:assert/strict";
import { Broker } from "../src/broker.ts";
import type { Authenticator, Config, Credentials } from "../src/types.ts";

import { fixture } from "./fixture.ts";
const signal = () => new AbortController().signal;
async function approve(broker: Broker, id: string, ttl = 60) {
  await broker.begin(id, "browser", ttl, signal());
  return broker.finish(id, "browser", "verified-passkey", signal());
}

test("approval notifications expose only pending metadata, without granting or extending access", async () => {
  const { broker, advance, preparations } = fixture();
  const ssh = broker.create(1000, "Publish fork", ["ssh:remote"], 60);
  const remote = broker.create(1000, "Connect environment", ["environment:remote"], 60);
  assert.throws(() => broker.pendingApprovals(1001), /denied/);
  assert.deepEqual(
    new Set(broker.pendingApprovals(1000).map((row) => row.id)),
    new Set([ssh.id, remote.id]),
  );
  assert.deepEqual(Object.keys(broker.pendingApprovals(1000)[0]!).sort(), [
    "approval_url",
    "capabilities",
    "id",
    "purpose",
    "request_expires_at",
  ]);
  await broker.begin(ssh.id, "browser", 60, signal());
  assert.equal(broker.pendingApprovals(1000).length, 2);
  assert.equal(preparations(), 0);
  await broker.finish(ssh.id, "browser", "verified-passkey", signal());
  assert.deepEqual(
    broker.pendingApprovals(1000).map((row) => row.id),
    [remote.id],
  );
  broker.revoke(1000, remote.id);
  assert.deepEqual(broker.pendingApprovals(1000), []);
  const expiring = broker.create(1000, "Unanswered request", ["ssh:remote"], 60);
  advance(600_000);
  assert.deepEqual(broker.pendingApprovals(1000), []);
  assert.equal(broker.status(1000, expiring.id).state, "expired");
  assert.equal(broker.status(1000, expiring.id).request_expires_at, expiring.request_expires_at);
  broker.close();
});

test("approval is bound to browser, immutable scope and human-selected duration", async () => {
  const { broker } = fixture();
  const grant = broker.create(1000, "Connect remote", ["environment:remote"], 60);
  await assert.rejects(
    broker.operation(1000, grant.id, "environment:remote", signal(), async () => 1),
    /locked/,
  );
  await broker.begin(grant.id, "browser", 28800, signal());
  await assert.rejects(
    broker.finish(grant.id, "different-browser", "verified-passkey", signal()),
    /transaction/,
  );
  const active = await broker.finish(grant.id, "browser", "verified-passkey", signal());
  assert.equal(active.granted_seconds, 28800);
  assert.equal(active.requested_seconds, 60);
  await assert.rejects(
    broker.operation(1000, grant.id, "ssh:remote", signal(), async () => 1),
    /locked/,
  );
  await assert.rejects(broker.begin(grant.id, "browser", 172800, signal()), /unavailable/);
  broker.close();
});
test("expiry aborts an existing operation and rejects new access", async () => {
  const { broker, advance } = fixture();
  const grant = broker.create(1000, "Connect remote", ["environment:remote"], 60);
  await approve(broker, grant.id);
  let observed: AbortSignal | undefined;
  const operation = broker.operation(
    1000,
    grant.id,
    "environment:remote",
    signal(),
    async (running) => {
      observed = running;
      return new Promise<void>((resolve) =>
        running.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  );
  advance(61000);
  await operation;
  assert.equal(observed!.aborted, true);
  assert.equal(broker.status(1000, grant.id).state, "expired");
  await assert.rejects(
    broker.operation(1000, grant.id, "environment:remote", signal(), async () => 1),
    /locked/,
  );
});
test("revocation during credential preparation cannot activate a grant", async () => {
  let release: (() => void) | undefined;
  const { broker } = fixture({
    prepare: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "";
    },
  });
  const grant = broker.create(1000, "Connect remote", ["ssh:remote"], 60);
  await broker.begin(grant.id, "browser", 60, signal());
  const finishing = broker.finish(grant.id, "browser", "verified-passkey", signal());
  await Promise.resolve();
  await Promise.resolve();
  broker.revoke(1000, grant.id);
  release!();
  await assert.rejects(finishing);
  assert.equal(broker.status(1000, grant.id).state, "revoked");
});
test("credential failure, failed audit, wrong UID and unknown capability stay locked", async () => {
  const { broker } = fixture({
    prepare: async () => {
      throw new Error("fixture failure");
    },
  });
  assert.throws(() => broker.create(1001, "Connect remote", ["ssh:remote"], 60), /denied/);
  assert.throws(() => broker.create(1000, "Connect remote", ["ssh:other"], 60), /Unknown/);
  const grant = broker.create(1000, "Connect remote", ["ssh:remote"], 60);
  await assert.rejects(approve(broker, grant.id));
  assert.equal(broker.status(1000, grant.id).state, "pending");
  const broken = new Broker(broker.config, broker.auth, broker.credentials, () => {
    throw new Error("audit failed");
  });
  assert.throws(() => broken.create(1000, "Connect remote", ["ssh:remote"], 60));
  assert.equal(broken.requests.size, 0);
});
test("lost signer revokes only active SSH-dependent grants", async () => {
  const { broker } = fixture({
    checkSigner: async () => {
      throw new Error("locked");
    },
  });
  const grant = broker.create(1000, "Connect remote", ["environment:remote"], 60);
  await approve(broker, grant.id);
  await broker.monitorSigner();
  assert.equal(broker.status(1000, grant.id).state, "revoked");
});
