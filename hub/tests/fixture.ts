import assert from "node:assert/strict";
import { Broker } from "../src/broker.ts";
import type { Authenticator, Config, Credentials } from "../src/types.ts";
export function fixture(overrides: Partial<Credentials> = {}) {
  let now = Date.now();
  let preparations = 0;
  const config: Config = {
    origin: "https://hub.example",
    authelia_url: "https://hub.example/auth",
    authelia_version: "v4.39.27",
    rp_id: "hub.example",
    approvers: ["sean"],
    web_listen: "127.0.0.1:0",
    worker_socket: "/tmp/test-worker.sock",
    worker_uid: 1000,
    worker_label: "Shared user",
    audit_file: "/tmp/test-audit",
    signer_socket: "/tmp/test-signer",
    identity_file: "/tmp/test-public",
    known_hosts: "/tmp/test-known",
    bao_url: "",
    bao_username: "",
    bao_password_file: "",
    hosts: {
      remote: {
        hostname: "remote.example",
        user: "sean",
        port: 22,
        key_alias: "remote",
        fingerprints: ["SHA256:" + "a".repeat(43)],
      },
    },
    providers: {},
    environments: {
      remote: {
        host: "remote",
        supervisor: "/usr/local/bin/t3-hub-agent",
        label: "Remote",
        platform: "linux-x64",
      },
    },
  };
  const auth: Authenticator = {
    begin: async () => ({
      options: {},
      challenge: "challenge",
      deadline: now + 60000,
      finish: async (raw) => {
        assert.equal(raw, "verified-passkey");
        return "sean";
      },
      close: async () => {},
    }),
  };
  const credentials: Credentials = {
    prepare: async () => {
      preparations++;
      return "";
    },
    revoke: async () => {},
    checkSigner: async () => {},
    ...overrides,
  };
  const events: string[] = [];
  const broker = new Broker(
    config,
    auth,
    credentials,
    (event) => events.push(event),
    () => now,
  );
  return {
    broker,
    config,
    events,
    preparations: () => preparations,
    advance: (ms: number) => {
      now += ms;
      broker.reap();
    },
  };
}
