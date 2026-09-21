import { extractTar } from "./archive.ts";
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import net from "node:net";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  existsSync,
  chmodSync,
  openSync,
  closeSync,
  writeSync,
  lstatSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { once } from "node:events";
import { frame } from "./agent-proxy.ts";
import { Protocol } from "./protocol.ts";
import { verifyLease, type Lease } from "./lease.ts";
import { fields, record, text, integer, requireThat, id, run, HubError } from "./io.ts";
import type { Artifact } from "./types.ts";

export interface RemoteConfig {
  alias: string;
  socket: string;
  public_key: string;
  ssh_user: string;
  runtime_user: string;
  runtime_home: string;
  root_directory: string;
  base_directory: string;
  runtime_uid?: number;
  runtime_gid?: number;
  runtime_path?: string;
}
export function parseRemoteConfig(value: unknown): RemoteConfig {
  const c = fields(value, [
    "alias",
    "socket",
    "public_key",
    "ssh_user",
    "runtime_user",
    "runtime_home",
    "root_directory",
    "base_directory",
    "runtime_uid",
    "runtime_gid",
    "runtime_path",
  ]);
  requireThat(
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(text(c.alias)) &&
      /^[A-Za-z0-9_.-]+$/.test(text(c.runtime_user)) &&
      /^[A-Za-z0-9_.-]+$/.test(text(c.ssh_user)),
    "Invalid remote identity",
  );
  for (const key of ["root_directory", "base_directory", "runtime_home"])
    requireThat(isAbsolute(text(c[key])), "Absolute remote policy paths required");
  requireThat(
    text(c.public_key).includes("BEGIN PUBLIC KEY") && text(c.socket).length > 0,
    "Remote trust key and socket required",
  );
  if (process.platform !== "win32")
    requireThat(
      Number.isSafeInteger(c.runtime_uid) &&
        integer(c.runtime_uid) >= 0 &&
        Number.isSafeInteger(c.runtime_gid) &&
        integer(c.runtime_gid) >= 0,
      "Remote runtime UID/GID required",
    );
  return c as unknown as RemoteConfig;
}
export class RemoteSession {
  readonly nonce = id();
  readonly channels = new Map<number, net.Socket>();
  readonly abort = new AbortController();
  private lease?: Lease;
  private heartbeat?: NodeJS.Timeout;
  private deadline?: NodeJS.Timeout;
  private child?: ChildProcess;
  private port?: number;
  private unit?: string;
  private closed = false;
  private transitioning = false;
  private readonly paused = new Set<number>();
  private readonly sending = new Set<number>();
  private upload?: {
    directory: string;
    file: string;
    fd: number;
    artifact: Artifact;
    bytes: number;
    hash: ReturnType<typeof createHash>;
  };
  readonly config: RemoteConfig;
  readonly protocol: Protocol;
  readonly reserve: (session: RemoteSession) => void;
  readonly release: () => void;
  constructor(
    config: RemoteConfig,
    protocol: Protocol,
    reserve: (session: RemoteSession) => void,
    release: () => void,
  ) {
    this.config = config;
    this.protocol = protocol;
    this.reserve = reserve;
    this.release = release;
    protocol.handler = (type, payload) => this.handle(type, payload);
    protocol.once("closed", () => {
      void this.close();
    });
    protocol.on("pause", (payload) =>
      this.event(() => {
        const channel = integer(payload);
        this.paused.add(channel);
        this.channels.get(channel)?.pause();
      }),
    );
    protocol.on("resume", (payload) =>
      this.event(() => {
        const channel = integer(payload);
        this.paused.delete(channel);
        if (!this.sending.has(channel)) this.channels.get(channel)?.resume();
      }),
    );
    protocol.on("end", (payload) => this.event(() => this.channels.get(integer(payload))?.end()));
    protocol.on("close", (payload) =>
      this.event(() => this.channels.get(integer(payload))?.destroy()),
    );
    // An unauthenticated client cannot retain a supervisor slot indefinitely.
    this.heartbeat = setTimeout(() => {
      void this.close();
    }, 10000);
  }
  private event(work: () => unknown) {
    try {
      this.authorized();
      work();
    } catch {
      void this.close();
    }
  }
  private authorized() {
    requireThat(
      !this.closed &&
        this.lease &&
        Date.now() < this.lease.expires_at &&
        !this.abort.signal.aborted,
      "Remote lease locked",
    );
    return this.lease;
  }
  private touch() {
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.heartbeat = setTimeout(() => {
      void this.close();
    }, 12000);
  }
  private revision() {
    try {
      return text(
        record(JSON.parse(readFileSync(join(this.config.root_directory, "current.json"), "utf8")))
          .revision,
      );
    } catch {
      return null;
    }
  }
  async handle(type: string, payload: unknown): Promise<unknown> {
    const transition = [
      "lease",
      "install-begin",
      "install-chunk",
      "install-finish",
      "start",
    ].includes(type);
    if (transition) {
      requireThat(!this.transitioning, "Remote lifecycle operation in progress");
      this.transitioning = true;
    }
    try {
      return await this.perform(type, payload);
    } finally {
      if (transition) this.transitioning = false;
    }
  }
  private async perform(type: string, payload: unknown): Promise<unknown> {
    if (type === "hello")
      return {
        protocol: 1,
        nonce: this.nonce,
        platform: `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`,
        hostname: os.hostname(),
        ssh_user: this.config.ssh_user,
        revision: this.revision(),
      };
    if (type === "lease") {
      requireThat(!this.lease && !this.closed, "Lease is immutable");
      const lease = verifyLease(payload, this.config.public_key, this.config.alias, this.nonce);
      requireThat(
        lease.manifest.artifacts.some(
          (a) =>
            a.platform ===
            `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`,
        ),
        "No matching artifact",
      );
      this.reserve(this);
      this.lease = lease;
      this.touch();
      this.deadline = setTimeout(() => {
        void this.close();
      }, lease.expires_at - Date.now());
      return { active: true };
    }
    const lease = this.authorized();
    if (type === "heartbeat") {
      this.touch();
      return { active: true, expires_at: lease.expires_at };
    }
    if (type === "install-begin") {
      requireThat(!this.child && !this.upload, "Runtime update already in progress");
      const artifact = record(record(payload).artifact);
      const approved = lease.manifest.artifacts.find(
        (a) =>
          a.platform ===
          `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`,
      )!;
      requireThat(
        ["platform", "file", "sha256", "bytes"].every(
          (key) => artifact[key] === (approved as unknown as Record<string, unknown>)[key],
        ),
        "Artifact outside signed lease",
      );
      mkdirSync(this.config.root_directory, { recursive: true, mode: 0o755 });
      const directory = mkdtempSync(join(this.config.root_directory, ".incoming-")),
        file = join(directory, "runtime.tar");
      this.upload = {
        directory,
        file,
        fd: openSync(file, "wx", 0o600),
        artifact: approved,
        bytes: 0,
        hash: createHash("sha256"),
      };
      return { ready: true };
    }
    if (type === "install-chunk") {
      const upload = this.upload;
      requireThat(upload, "No update in progress");
      const bytes = Buffer.from(text(record(payload).data), "base64");
      requireThat(
        bytes.length > 0 &&
          bytes.length <= 65536 &&
          upload.bytes + bytes.length <= upload.artifact.bytes,
        "Invalid artifact chunk",
      );
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(upload.fd, bytes, offset);
      upload.hash.update(bytes);
      upload.bytes += bytes.length;
      return { received: upload.bytes };
    }
    if (type === "install-finish") {
      const upload = this.upload;
      requireThat(upload, "No update in progress");
      requireThat(
        upload.bytes === upload.artifact.bytes &&
          upload.hash.digest("hex") === upload.artifact.sha256,
        "Artifact checksum mismatch",
      );
      closeSync(upload.fd);
      upload.fd = -1;
      const directory = join(upload.directory, "runtime");
      mkdirSync(directory, { mode: 0o755 });
      chmodSync(directory, 0o755);
      await extractTar(upload.file, directory, this.abort.signal);
      this.authorized();
      const binary = join(directory, process.platform === "win32" ? "t3.exe" : "t3");
      requireThat(
        lstatSync(binary).isFile() && !lstatSync(binary).isSymbolicLink(),
        "Patched runtime missing",
      );
      if (process.platform === "darwin") {
        const signed = await run(
          "/usr/bin/codesign",
          ["--force", "--sign", "-", binary],
          this.abort.signal,
        );
        requireThat(signed.exit_code === 0, "Remote executable ad-hoc signing failed");
      }
      const version = await run(binary, ["--version"], this.abort.signal);
      requireThat(
        version.exit_code === 0 && version.stdout.includes(lease.manifest.baseline.slice(1)),
        "Runtime version mismatch",
      );
      const destination = join(this.config.root_directory, lease.manifest.revision);
      this.authorized();
      if (!existsSync(destination)) renameSync(directory, destination);
      const next = join(this.config.root_directory, `.current-${id()}.json`);
      writeFileSync(
        next,
        JSON.stringify({ revision: lease.manifest.revision, baseline: lease.manifest.baseline }),
        { mode: 0o644, flag: "wx" },
      );
      this.authorized();
      renameSync(next, join(this.config.root_directory, "current.json"));
      rmSync(upload.directory, { recursive: true });
      delete this.upload;
      return { revision: lease.manifest.revision };
    }
    if (type === "start") {
      requireThat(
        !this.child && !this.upload && this.revision() === lease.manifest.revision,
        "Patched runtime not installed",
      );
      const base = new URL(text(record(payload).public_base_url));
      requireThat(
        base.protocol === "https:" &&
          base.pathname === `/hub/environments/${this.config.alias}` &&
          !base.username &&
          !base.password &&
          !base.search &&
          !base.hash,
        "Invalid hub endpoint",
      );
      const port = await freePort();
      this.authorized();
      this.port = port;
      const binary = join(
        this.config.root_directory,
        lease.manifest.revision,
        process.platform === "win32" ? "t3.exe" : "t3",
      );
      const args = [
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--base-dir",
        this.config.base_directory,
      ];
      const env = {
        PATH:
          this.config.runtime_path ??
          (process.platform === "win32"
            ? process.env.PATH
            : `${this.config.runtime_home}/.local/bin:${this.config.runtime_home}/.bun/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`),
        HOME: this.config.runtime_home,
        USER: this.config.runtime_user,
        LOGNAME: this.config.runtime_user,
        T3_HUB_MANAGED: "1",
        T3_HUB_PUBLIC_BASE_URL: base.href,
        T3_HUB_REVISION: lease.manifest.revision,
        ...(process.platform === "win32"
          ? { SystemRoot: process.env.SystemRoot, USERPROFILE: this.config.runtime_home }
          : {}),
      };
      if (process.platform === "linux") {
        this.unit = `t3-hub-${lease.request_id.slice(0, 32)}`;
        this.child = spawn(
          "/usr/bin/systemd-run",
          [
            "--quiet",
            "--pipe",
            "--wait",
            "--collect",
            `--unit=${this.unit}`,
            "--service-type=exec",
            `--property=User=${this.config.runtime_user}`,
            `--property=WorkingDirectory=${this.config.runtime_home}`,
            "--property=KillMode=control-group",
            "--property=TimeoutStopSec=3",
            `--property=RuntimeMaxSec=${Math.max(1, Math.floor((lease.expires_at - Date.now()) / 1000))}`,
            ...Object.entries(env).flatMap(([key, value]) =>
              value === undefined ? [] : [`--setenv=${key}=${value}`],
            ),
            binary,
            ...args,
          ],
          { env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
        );
      } else {
        if (process.platform === "win32")
          requireThat(
            os.userInfo().username.toLowerCase() === this.config.runtime_user.toLowerCase(),
            "Windows supervisor must use the enrolled runtime identity",
          );
        this.child = spawn(binary, args, {
          env,
          cwd: this.config.runtime_home,
          detached: true,
          ...(process.platform === "win32"
            ? {}
            : { uid: this.config.runtime_uid, gid: this.config.runtime_gid }),
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
      const child = this.child;
      child.once("error", () => {
        void this.close();
      });
      child.once("exit", () => {
        void this.close();
      });
      child.stderr?.resume();
      const code = await new Promise<string>((resolve, reject) => {
        let buffered = "";
        let settled = false;
        const abort = () => {
          if (!settled) {
            settled = true;
            reject(new HubError("Remote startup interrupted"));
          }
        };
        this.abort.signal.addEventListener("abort", abort, { once: true });
        child.stdout?.on("data", (bytes: Buffer) => {
          if (settled) return;
          buffered += bytes.toString();
          if (buffered.length >= 1 << 20) {
            abort();
            void this.close();
            return;
          }
          const match = /(?:^|\n)Token:\s*([^\s]+)\s*\n/.exec(buffered);
          if (match) {
            settled = true;
            buffered = "";
            this.abort.signal.removeEventListener("abort", abort);
            resolve(match[1]!);
          }
        });
      });
      this.authorized();
      return { revision: lease.manifest.revision, pairing_code: code };
    }
    if (type === "write") {
      const value = record(payload),
        socket = this.channels.get(integer(value.channel));
      requireThat(socket, "Unknown channel");
      const bytes = Buffer.from(text(value.data), "base64");
      requireThat(bytes.length > 0 && bytes.length <= 65536, "Invalid channel frame");
      if (!socket.write(bytes)) await once(socket, "drain", { signal: this.abort.signal });
      return { written: bytes.length };
    }
    if (type === "open") {
      requireThat(this.child && this.port && this.channels.size < 128, "Runtime unavailable");
      const channel = integer(record(payload).channel);
      requireThat(channel > 0 && !this.channels.has(channel), "Invalid channel");
      const socket = net.createConnection({ host: "127.0.0.1", port: this.port });
      this.channels.set(channel, socket);
      socket.on("data", (bytes) => {
        socket.pause();
        this.sending.add(channel);
        void (async () => {
          for (let i = 0; i < bytes.length; i += 65536)
            await this.protocol.send({
              type: "data",
              payload: { channel, data: bytes.subarray(i, i + 65536).toString("base64") },
            });
        })().then(
          () => {
            this.sending.delete(channel);
            if (!this.paused.has(channel)) socket.resume();
          },
          () => socket.destroy(),
        );
      });
      socket.on("end", () => {
        void this.protocol.send({ type: "end", payload: channel }).catch(() => {});
      });
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        this.channels.delete(channel);
        this.sending.delete(channel);
        this.paused.delete(channel);
        void this.protocol.send({ type: "close", payload: channel }).catch(() => {});
      });
      await once(socket, "connect");
      return { open: true };
    }
    throw new HubError("Unknown remote operation");
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    if (this.heartbeat) clearTimeout(this.heartbeat);
    if (this.deadline) clearTimeout(this.deadline);
    for (const socket of this.channels.values()) socket.destroy();
    this.channels.clear();
    this.protocol.close();
    if (this.unit)
      await run("/usr/bin/systemctl", ["stop", this.unit], AbortSignal.timeout(10000)).catch(
        () => {},
      );
    if (this.child?.pid) {
      if (process.platform === "win32")
        await run(
          "C:\\Windows\\System32\\taskkill.exe",
          ["/PID", String(this.child.pid), "/T", "/F"],
          AbortSignal.timeout(10000),
        ).catch(() => {});
      else
        try {
          process.kill(-this.child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
    }
    if (this.upload) {
      if (this.upload.fd >= 0) closeSync(this.upload.fd);
      rmSync(this.upload.directory, { recursive: true, force: true });
      delete this.upload;
    }
    this.release();
  }
}
async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  requireThat(address && typeof address !== "string", "No loopback port available");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
export function remoteServer(config: RemoteConfig) {
  const installedRevision = () => {
    try {
      return record(JSON.parse(readFileSync(join(config.root_directory, "current.json"), "utf8")))
        .revision;
    } catch {
      return null;
    }
  };
  const initialRevision = installedRevision();
  let active: RemoteSession | undefined;
  const sessions = new Set<RemoteSession>();
  const server = net.createServer((socket) => {
    if (sessions.size >= 32) {
      socket.destroy();
      return;
    }
    const protocol = new Protocol(socket, socket);
    const session = new RemoteSession(
      config,
      protocol,
      (next) => {
        requireThat(!active, "Environment already leased");
        active = next;
      },
      () => {
        if (active === session) active = undefined;
        sessions.delete(session);
        // Re-exec the protected supervisor from the newly verified revision after the lease closes.
        if (sessions.size === 0 && installedRevision() !== initialRevision) {
          server.close();
          server.emit("upgraded");
        }
      },
    );
    sessions.add(session);
    void protocol.start();
    socket.on("error", () => {
      void session.close();
    });
  });
  server.listen(config.socket, () => {
    if (process.platform !== "win32") chmodSync(config.socket, 0o660);
  });
  return {
    server,
    close: async () => {
      server.close();
      await Promise.all([...sessions].map((session) => session.close()));
    },
  };
}
export async function remoteConnect(socketPath: string) {
  process.stdout.write(
    frame(
      Buffer.from(
        JSON.stringify({
          type: "identity",
          payload: { user: os.userInfo().username, hostname: os.hostname(), cwd: process.cwd() },
        }),
      ),
    ),
  );
  const socket = net.createConnection(socketPath);

  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  process.stdin.once("end", () => socket.end());
  socket.once("close", () => process.stdin.destroy());
  await once(socket, "close");
}

/** The first enrolled executable is only a selector; new sessions use the approved revision. */
export async function superviseRemote(config: RemoteConfig, configPath: string) {
  let revision = "bootstrap";
  try {
    revision = text(
      record(JSON.parse(readFileSync(join(config.root_directory, "current.json"), "utf8")))
        .revision,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  requireThat(
    revision === "bootstrap" || /^[a-f0-9]{40}$/.test(revision),
    "Invalid installed supervisor revision",
  );
  const binary = join(
    config.root_directory,
    revision,
    process.platform === "win32" ? "t3.exe" : "t3",
  );
  const child = spawn(binary, ["__hub-agent", "serve", "--config", configPath], {
    stdio: "inherit",
  });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const [code] = await once(child, "exit");
    requireThat(code === 0, "Protected supervisor exited unsuccessfully");
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
