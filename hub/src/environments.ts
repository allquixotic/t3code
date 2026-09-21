// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
// oxlint-disable-next-line t3code/namespace-node-imports -- Node's ESM once export needs a named import in the standalone emitter.
import { once } from "node:events";
import * as NodeStream from "node:stream";
import { Broker } from "./broker.ts";
import { Protocol, Channel } from "./protocol.ts";
import { loadManifest, verifyArtifact } from "./artifacts.ts";
import { checkHostTrust, sshArgs, shellQuote } from "./ssh.ts";
import { record, text, integer, requireThat, message, HubError, digest } from "./io.ts";
import type { EnvironmentStatus } from "./types.ts";
import { signLease } from "./lease.ts";
import * as NodeTimersPromises from "node:timers/promises";
import { parseSkills } from "./skills.ts";
import type { Lease } from "./lease.ts";
import { provisionEnvironment } from "./provision.ts";

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
  private skills?: Buffer;
  publishSkills(bytes: Buffer) {
    parseSkills(bytes);
    this.skills = bytes;
    return digest(bytes);
  }
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
            if (this.broker.status(this.broker.config.worker_uid, grantId).state === "active")
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
    return {
      ...structuredClone(entry.status),
      http_base_url: `${this.broker.config.origin}/hub/environments/${alias}`,
    };
  }
  connect(uid: number, alias: string, requestedSeconds = 1800) {
    const entry = this.entry(alias);
    if (
      entry.active ||
      ["pending", "checking", "installing", "connecting", "updating", "active"].includes(
        entry.status.phase,
      )
    )
      return this.status(alias);
    // An explicit connect action is the only request-creation path. Polling and reconnects never re-authorize.
    const grant = this.broker.create(
      uid,
      `Connect to ${entry.status.label}; install the hub's patched runtime and synchronize skills if needed`,
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
    const configured = this.broker.config.environments![alias]!,
      host = this.broker.config.hosts[configured.host]!;
    await this.broker.operation(
      this.broker.config.worker_uid,
      entry.grant!,
      `environment:${alias}`,
      new AbortController().signal,
      async (signal, grant) => {
        await checkHostTrust(this.broker.config, host, signal);
        signal.throwIfAborted();
        const policy =
          configured.enrolled === false
            ? await provisionEnvironment(
                this.broker.config,
                alias,
                signal,
                (phase, detail, progress) => {
                  entry.status.phase = phase;
                  entry.status.detail = detail;
                  if (progress === undefined) delete entry.status.progress;
                  else entry.status.progress = progress;
                },
              )
            : configured;
        const manifest = loadManifest(this.broker.config.artifact_directory!);
        const artifact = manifest.artifacts.find((a) => a.platform === policy.platform);
        requireThat(artifact, "No patched artifact for this platform");
        const file = await verifyArtifact(this.broker.config.artifact_directory!, artifact);
        entry.status.phase = "connecting";
        entry.status.detail = "Starting the protected remote connection";
        delete entry.status.progress;
        const command = policy.platform.startsWith("win-")
          ? `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(`& '${policy.supervisor.replaceAll("'", "''")}' connect`, "utf16le").toString("base64")}`
          : `${shellQuote(policy.supervisor)} connect`;
        let upgrading = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          if (attempt > 0) await NodeTimersPromises.setTimeout(1000, undefined, { signal });
          signal.throwIfAborted();
          const child = NodeChildProcess.spawn(
            "/usr/bin/ssh",
            sshArgs(this.broker.config, host, command),
            {
              detached: true,
              env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" },
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
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
          let skillTimer: NodeJS.Timeout | undefined;
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
              entry.status.detail = "Installing the current T3 runtime";
              let sent = 0;
              await protocol.request("install-begin", { artifact });
              for await (const bytes of NodeFS.createReadStream(file, { highWaterMark: 65536 })) {
                signal.throwIfAborted();
                await protocol.request("install-chunk", {
                  data: (bytes as Buffer).toString("base64"),
                });
                sent += (bytes as Buffer).length;
                entry.status.progress = Math.floor((sent * 100) / artifact.bytes);
              }
              await protocol.request("install-finish", {}, 120000);
            }
            if (hello.skills_version !== 1) {
              requireThat(
                hello.revision !== manifest.revision,
                "Installed supervisor lacks skill synchronization",
              );
              // Closing this transport makes the protected service re-exec the verified revision.
              upgrading = true;
              continue;
            }
            upgrading = false;
            requireThat(this.skills, "Hub skill source is not ready; retry the connection");
            const lease: Lease = {
              protocol: 1,
              alias,
              request_id: grant.id,
              issued_at: Date.now(),
              expires_at: deadline,
              nonce: text(hello.nonce),
              manifest,
            };
            const synchronize = async () => {
              const bytes = this.skills!;
              signal.throwIfAborted();
              const result = record(
                await protocol.request(
                  "skills-begin",
                  signLease(
                    {
                      ...lease,
                      issued_at: Date.now(),
                      skills: { sha256: digest(bytes), bytes: bytes.length },
                    },
                    this.broker.config.lease_signing_key!,
                  ),
                ),
              );
              if (result.unchanged === true) return;
              for (let offset = 0; offset < bytes.length; offset += 65536) {
                signal.throwIfAborted();
                await protocol.request("skills-chunk", {
                  data: bytes.subarray(offset, offset + 65536).toString("base64"),
                });
              }
              await protocol.request("skills-finish", {}, 120000);
            };
            entry.status.detail = "Synchronizing skills from the hub";
            delete entry.status.progress;
            await synchronize();
            signal.throwIfAborted();
            entry.status.phase = "connecting";
            entry.status.detail = "Starting T3 on the remote machine";
            delete entry.status.progress;
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
            // Source updates only use this already-approved transport; no grant is created or extended.
            let syncing = false;
            skillTimer = setInterval(() => {
              if (syncing) return;
              syncing = true;
              void synchronize()
                .catch(stop)
                .finally(() => {
                  syncing = false;
                });
            }, 30000);
            skillTimer.unref();
            await closed;
            return;
          } catch (error) {
            if (!upgrading || attempt === 9 || signal.aborted) throw error;
          } finally {
            if (skillTimer) clearInterval(skillTimer);
            if (heartbeat) clearInterval(heartbeat);
            signal.removeEventListener("abort", stop);
            stop();
            if (!upgrading || signal.aborted) this.lock(entry);
          }
        }
        throw new HubError("Remote supervisor update did not become ready");
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
  async open(alias: string): Promise<NodeStream.Duplex> {
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
