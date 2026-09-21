// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import type { Duplex } from "node:stream";
import { Broker } from "./broker.ts";
import { Protocol, Channel } from "./protocol.ts";
import { loadManifest, verifyArtifact } from "./artifacts.ts";
import { checkHostTrust, sshArgs, shellQuote } from "./ssh.ts";
import { record, text, integer, requireThat, message, HubError } from "./io.ts";
import type { EnvironmentStatus } from "./types.ts";
import { signLease } from "./lease.ts";

interface Entry {
  status: EnvironmentStatus;
  grant?: string;
  protocol?: Protocol;
  active?: Promise<void>;
  channels: Map<number, Channel>;
  nextChannel: number;
}
export class EnvironmentManager {
  readonly entries = new Map<string, Entry>();
  readonly broker: Broker;
  constructor(broker: Broker) {
    this.broker = broker;
    for (const [alias, policy] of Object.entries(broker.config.environments ?? {}))
      this.entries.set(alias, {
        status: {
          alias,
          label: policy.label,
          phase: policy.enrolled === false ? "unenrolled" : "locked",
        },
        channels: new Map(),
        nextChannel: 0,
      });
    broker.stopped.add((grant) => {
      for (const entry of this.entries.values()) if (entry.grant === grant.id) this.lock(entry);
    });
  }
  private entry(alias: string) {
    const entry = this.entries.get(alias);
    requireThat(entry, "Environment not enrolled");
    return entry;
  }
  list() {
    return [...this.entries.keys()].map((alias) => this.status(alias));
  }
  status(alias: string): EnvironmentStatus {
    const entry = this.entry(alias);
    if (entry.grant) {
      const grant = this.broker.status(this.broker.config.worker_uid, entry.grant);
      if (grant.state === "active" && entry.status.phase === "pending" && !entry.active) {
        entry.status.phase = "connecting";
        entry.status.expires_at = grant.grant_expires_at!;
        const grantId = entry.grant;
        let failure: string | undefined;
        const operation = this.activate(alias, entry)
          .catch((error) => {
            failure = message(error);
          })
          .finally(() => {
            if (entry.grant === grantId) {
              this.broker.revoke(this.broker.config.worker_uid, grantId);
              delete entry.grant;
            }
            delete entry.active;
            if (failure) {
              entry.status.phase = "error";
              entry.status.error = failure;
            }
          });
        entry.active = operation;
      }
    }
    return structuredClone(entry.status);
  }
  connect(uid: number, alias: string, requestedSeconds = 1800) {
    requireThat(
      this.broker.config.environments![alias]?.enrolled !== false,
      "Environment setup required",
    );
    const entry = this.entry(alias);
    if (
      entry.active ||
      ["pending", "connecting", "updating", "active"].includes(entry.status.phase)
    )
      return this.status(alias);
    // An explicit connect action is the only request-creation path. Polling and reconnects never re-authorize.
    const grant = this.broker.create(
      uid,
      `Connect to ${entry.status.label}; install the hub's patched runtime if needed`,
      [`environment:${alias}`],
      requestedSeconds,
    );
    entry.grant = grant.id;
    entry.status = {
      alias,
      label: entry.status.label,
      phase: "pending",
      approval_url: grant.approval_url,
    };
    return this.status(alias);
  }
  disconnect(uid: number, alias: string) {
    const entry = this.entry(alias);
    if (entry.grant) this.broker.revoke(uid, entry.grant);
    this.lock(entry);
  }
  private lock(entry: Entry) {
    entry.protocol?.close();
    delete entry.protocol;
    for (const channel of entry.channels.values()) channel.destroy();
    entry.channels.clear();
    entry.status = {
      alias: entry.status.alias,
      label: entry.status.label,
      phase:
        this.broker.config.environments![entry.status.alias]!.enrolled === false
          ? "unenrolled"
          : "locked",
    };
  }
  async tick() {
    for (const alias of this.entries.keys()) this.status(alias);
  }
  private async activate(alias: string, entry: Entry) {
    const policy = this.broker.config.environments![alias]!,
      host = this.broker.config.hosts[policy.host]!;
    requireThat(policy.enrolled !== false, "Environment setup required");
    const manifest = loadManifest(this.broker.config.artifact_directory!);
    const artifact = manifest.artifacts.find((a) => a.platform === policy.platform);
    requireThat(artifact, "No patched artifact for this platform");
    const file = await verifyArtifact(this.broker.config.artifact_directory!, artifact);
    await this.broker.operation(
      this.broker.config.worker_uid,
      entry.grant!,
      `environment:${alias}`,
      new AbortController().signal,
      async (signal, grant) => {
        await checkHostTrust(this.broker.config, host, signal);
        signal.throwIfAborted();
        const command = policy.platform.startsWith("win-")
          ? `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(`& '${policy.supervisor.replaceAll("'", "''")}' connect`, "utf16le").toString("base64")}`
          : `${shellQuote(policy.supervisor)} connect`;
        const child = spawn("/usr/bin/ssh", sshArgs(this.broker.config, host, command), {
          detached: true,
          env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        // Child stderr can contain remote runtime credentials. It is deliberately not retained or logged.
        child.stderr.resume();
        const protocol = new Protocol(child.stdout, child.stdin);
        entry.protocol = protocol;
        const stop = () => {
          protocol.close();
          if (child.pid)
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* already exited */
            }
        };
        signal.addEventListener("abort", stop, { once: true });
        child.on("error", stop);
        let heartbeat: NodeJS.Timeout | undefined;
        try {
          const closed = once(protocol, "closed");
          let identity: Record<string, unknown> | undefined;
          protocol.once("identity", (value) => {
            identity = record(value);
          });
          void protocol.start();
          const hello = record(await protocol.request("hello", {}));
          requireThat(
            hello.protocol === 1 &&
              hello.platform === policy.platform &&
              hello.ssh_user === host.user,
            "Remote identity or protocol mismatch",
          );
          requireThat(
            typeof hello.hostname === "string" && hello.hostname.length > 0,
            "Remote hostname unavailable",
          );
          requireThat(
            identity &&
              identity.user === host.user &&
              typeof identity.hostname === "string" &&
              identity.hostname === hello.hostname &&
              typeof identity.cwd === "string" &&
              identity.cwd.length > 0,
            "Remote account or working directory preflight failed",
          );
          this.broker.audit("environment_identity", {
            alias,
            hostname: identity.hostname,
            user: identity.user,
            cwd: identity.cwd,
          });
          // SSH host keys pin the machine; the account and working directory are verified before writes.
          const deadline = Date.parse(grant.grant_expires_at!);
          await protocol.request(
            "lease",
            signLease(
              {
                protocol: 1,
                alias,
                request_id: grant.id,
                issued_at: Date.now(),
                expires_at: deadline,
                nonce: text(hello.nonce),
                manifest,
              },
              this.broker.config.lease_signing_key!,
            ),
          );
          heartbeat = setInterval(() => {
            void protocol.request("heartbeat", {}, 5000).catch(stop);
          }, 3000);
          heartbeat.unref();
          if (hello.revision !== manifest.revision) {
            entry.status.phase = "updating";
            await protocol.request("install-begin", { artifact });
            for await (const bytes of createReadStream(file, { highWaterMark: 65536 })) {
              signal.throwIfAborted();
              await protocol.request("install-chunk", {
                data: (bytes as Buffer).toString("base64"),
              });
            }
            await protocol.request("install-finish", {}, 120000);
          }
          signal.throwIfAborted();
          entry.status.phase = "connecting";
          const ready = record(
            await protocol.request(
              "start",
              { public_base_url: `${this.broker.config.origin}/hub/environments/${alias}` },
              120000,
            ),
          );
          requireThat(
            ready.revision === manifest.revision && typeof ready.pairing_code === "string",
            "Remote runtime revision mismatch",
          );
          this.attachChannels(entry, protocol);
          entry.status = {
            alias,
            label: policy.label,
            phase: "active",
            expires_at: grant.grant_expires_at!,
            http_base_url: `${this.broker.config.origin}/hub/environments/${alias}`,
            pairing_code: ready.pairing_code,
            revision: manifest.revision,
          };
          await closed;
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          signal.removeEventListener("abort", stop);
          stop();
          this.lock(entry);
        }
      },
    );
  }
  private attachChannels(entry: Entry, protocol: Protocol) {
    protocol.on("data", (payload) => {
      try {
        const value = record(payload),
          channel = entry.channels.get(integer(value.channel));
        requireThat(channel, "Unknown channel");
        const data = Buffer.from(text(value.data), "base64");
        requireThat(data.length <= 65536, "Channel frame too large");
        if (!channel.push(data))
          void protocol
            .send({ type: "pause", payload: channel.channelId })
            .catch(() => protocol.close());
      } catch {
        protocol.close();
      }
    });
    protocol.on("end", (payload) => {
      entry.channels.get(integer(payload))?.push(null);
    });
    protocol.on("close", (payload) => {
      entry.channels.get(integer(payload))?.destroy();
    });
  }
  async open(alias: string): Promise<Duplex> {
    const entry = this.entry(alias);
    this.status(alias);
    requireThat(
      entry.status.phase === "active" && entry.protocol && entry.channels.size < 128,
      "Environment locked or unavailable",
    );
    const channelId = ++entry.nextChannel,
      channel = new Channel(entry.protocol, channelId);
    entry.channels.set(channelId, channel);
    channel.once("close", () => entry.channels.delete(channelId));
    try {
      await entry.protocol.request("open", { channel: channelId });
      return channel;
    } catch (error) {
      channel.destroy();
      throw error;
    }
  }
  close() {
    for (const entry of this.entries.values()) this.lock(entry);
  }
}
