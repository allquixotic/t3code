import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.ts";
import { parseConfig } from "../src/config.ts";
import { EnvironmentManager } from "../src/environments.ts";

test("diagnostics can request a short approval without changing an existing request", () => {
  const f = fixture();
  const manager = new EnvironmentManager(f.broker);
  const status = manager.connect(1000, "remote", 60);
  assert.equal(f.broker.list(1000).requests[0]!.requested_seconds, 60);
  assert.deepEqual(manager.connect(1000, "remote", 300), status);
  assert.equal(f.broker.list(1000).requests[0]!.requested_seconds, 60);
  manager.close();
});

test("uninstalled destinations request approval only after an explicit connection; polling never installs or renews", async () => {
  const f = fixture();
  f.config.environments = { remote: { host: "remote", label: "Later", enrolled: false } };
  f.config.artifact_directory = "/var/lib/test-artifacts";
  f.config.lease_signing_key = "/etc/test-key.pem";
  assert.equal(parseConfig(f.config).environments!.remote!.enrolled, false);
  const manager = new EnvironmentManager(f.broker);
  assert.equal(manager.list()[0]!.phase, "unenrolled");
  await manager.tick();
  assert.equal(f.broker.requests.size, 0);
  const pending = manager.connect(1000, "remote", 60);
  assert.equal(pending.phase, "pending");
  assert.ok(pending.approval_url);
  assert.equal(
    manager.status("remote").http_base_url,
    `${f.config.origin}/hub/environments/remote`,
  );
  await manager.tick();
  assert.equal(manager.list()[0]!.phase, "pending");
  assert.equal(f.broker.requests.size, 1);
  assert.equal(f.broker.list(1000).requests[0]!.requested_seconds, 60);
  manager.disconnect(1000, "remote");
  await manager.tick();
  assert.equal(manager.list()[0]!.phase, "unenrolled");
  assert.equal(f.broker.list(1000).requests[0]!.state, "revoked");
  assert.equal(f.broker.requests.size, 1);
  await assert.rejects(manager.open("remote"), /locked/);
  manager.close();
});
test("deferred policy rejects invented platform details and enrolled policy requires them", () => {
  const f = fixture();
  f.config.artifact_directory = "/var/lib/test-artifacts";
  f.config.lease_signing_key = "/etc/test-key.pem";
  const original = f.config.environments!.remote!;
  assert.throws(
    () => parseConfig({ ...f.config, environments: { remote: { ...original, enrolled: false } } }),
    /unverified/,
  );
  assert.throws(() =>
    parseConfig({
      ...f.config,
      environments: { remote: { host: "remote", label: "Missing", enrolled: true } },
    }),
  );
});
