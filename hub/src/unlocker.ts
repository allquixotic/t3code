// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import { readFileSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import type { Config, Ceremony, Authenticator, Grant } from "./types.ts";
import { call, record, text, integer, requireThat, id, digest, run } from "./io.ts";
import { Authelia } from "./authelia.ts";
import { checkHostTrust, checkSigner } from "./ssh.ts";

export interface UnlockConfig {
  policy: Config;
  broker_uid: number;
  socket: string;
  agent_socket: string;
  key_file: string;
  audit_file: string;
}
const sorted = <T>(value: Record<string, T>) =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
/** Preserve the Go v0.3 policy digest so staged upgrades can verify policy parity. */
export function policyDigest(c: Config) {
  const identity = readFileSync(c.identity_file, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
  requireThat(identity.split(" ").length === 2, "SSH public identity unavailable");
  const hosts = Object.fromEntries(
    Object.entries(sorted(c.hosts)).map(([key, h]) => [
      key,
      {
        hostname: h.hostname,
        user: h.user,
        port: h.port,
        key_alias: h.key_alias,
        fingerprints: h.fingerprints,
      },
    ]),
  );
  return digest(
    JSON.stringify({
      Origin: c.origin,
      RP: c.rp_id,
      AutheliaURL: c.authelia_url,
      Version: c.authelia_version,
      Identity: identity,
      Approvers: c.approvers,
      UserHandles: c.user_handles ? sorted(c.user_handles) : null,
      Hosts: hosts,
    }),
  );
}
export class UnlockClient implements Authenticator {
  readonly fallback: Authelia;
  readonly config: Config;
  constructor(config: Config) {
    this.config = config;
    this.fallback = new Authelia(config);
  }
  private api(path: string, body: unknown, signal: AbortSignal) {
    requireThat(this.config.unlock_socket, "Protected unlocker socket required");
    return call("POST", "http://hub-unlocker" + path, body, {
      socketPath: this.config.unlock_socket,
      signal,
    });
  }
  async begin(request: Grant, ttl: number, signal: AbortSignal): Promise<Ceremony> {
    const hosts = [
      ...new Set(
        request.capabilities.flatMap((cap) =>
          cap.startsWith("ssh:")
            ? [cap.slice(4)]
            : cap.startsWith("environment:")
              ? [this.config.environments![cap.slice(12)]!.host]
              : [],
        ),
      ),
    ];
    if (!hosts.length) return this.fallback.begin(request, ttl, signal);
    const response = record(
      await this.api(
        "/begin",
        {
          request_id: request.id,
          hosts,
          ttl_seconds: ttl,
          policy_digest: policyDigest(this.config),
        },
        signal,
      ),
    );
    const options = record(response.publicKey),
      remoteId = text(response.id),
      deadline = Date.parse(text(response.expires_at));
    requireThat(
      /^[a-f0-9]{64}$/.test(remoteId) &&
        deadline > Date.now() &&
        deadline - Date.now() <= 120000 &&
        options.rpId === this.config.rp_id &&
        options.userVerification === "required",
      "Invalid unlock-service challenge",
    );
    const close = async () => {
      await this.api("/cancel", { id: remoteId }, AbortSignal.timeout(3000)).catch(() => {});
    };
    return {
      options,
      challenge: text(options.challenge),
      deadline,
      close,
      finish: async (assertion, signal) => {
        try {
          const result = record(
            await this.api("/finish", { id: remoteId, response: assertion }, signal),
          );
          const approver = text(result.approver);
          requireThat(this.config.approvers.includes(approver), "Unlock service approver denied");
          return approver;
        } finally {
          await close();
        }
      },
    };
  }
}
export class Unlocker {
  readonly attempts = new Map<
    string,
    { requestId: string; hosts: string[]; ttl: number; ceremony: Ceremony; timer: NodeJS.Timeout }
  >();
  private slots = 0;
  private signerUntil = 0;
  private loading: Promise<void> = Promise.resolve();
  readonly config: UnlockConfig;
  readonly auth: Authenticator;
  readonly audit: (event: string, fields: Record<string, unknown>) => void;
  readonly load: (seconds: number, signal: AbortSignal) => Promise<void>;
  constructor(
    config: UnlockConfig,
    auth: Authenticator,
    audit: (event: string, fields: Record<string, unknown>) => void,
    load: (seconds: number, signal: AbortSignal) => Promise<void>,
  ) {
    this.config = config;
    this.auth = auth;
    this.audit = audit;
    this.load = load;
  }
  async begin(input: unknown, signal: AbortSignal) {
    const request = record(input),
      hosts = request.hosts;
    requireThat(
      /^[a-f0-9]{64}$/.test(text(request.request_id)) &&
        request.policy_digest === policyDigest(this.config.policy) &&
        integer(request.ttl_seconds) >= 60 &&
        integer(request.ttl_seconds) <= 172800 &&
        Array.isArray(hosts) &&
        hosts.length > 0 &&
        hosts.length <= 20 &&
        new Set(hosts).size === hosts.length &&
        hosts.every(
          (host) => typeof host === "string" && Object.hasOwn(this.config.policy.hosts, host),
        ),
      "Unlock scope or policy mismatch",
    );
    requireThat(this.slots < 32, "Unlock ceremony limit reached");
    this.slots++;
    try {
      const ceremony = await this.auth.begin(
        { id: text(request.request_id) } as Grant,
        integer(request.ttl_seconds),
        signal,
      );
      signal.throwIfAborted();
      requireThat(
        ceremony.deadline > Date.now() && ceremony.deadline - Date.now() <= 120000,
        "Invalid unlock deadline",
      );
      const requestId = id();
      const timer = setTimeout(() => {
        void this.cancel(requestId);
      }, ceremony.deadline - Date.now());
      timer.unref();
      this.attempts.set(requestId, {
        requestId: text(request.request_id),
        hosts: hosts as string[],
        ttl: integer(request.ttl_seconds),
        ceremony,
        timer,
      });
      return {
        id: requestId,
        publicKey: ceremony.options,
        expires_at: new Date(ceremony.deadline).toISOString(),
      };
    } catch (error) {
      this.slots--;
      throw error;
    }
  }
  private take(requestId: string) {
    const attempt = this.attempts.get(requestId);
    if (attempt) {
      this.attempts.delete(requestId);
      clearTimeout(attempt.timer);
    }
    return attempt;
  }
  async cancel(requestId: string) {
    const attempt = this.take(requestId);
    if (attempt) {
      this.slots--;
      await attempt.ceremony.close();
    }
  }
  async finish(requestId: string, assertion: unknown, signal: AbortSignal) {
    const attempt = this.take(requestId);
    requireThat(attempt, "Unlock challenge unavailable or consumed");
    const bounded = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, attempt.ceremony.deadline - Date.now())),
    ]);
    try {
      const approver = await attempt.ceremony.finish(assertion, bounded);
      requireThat(this.config.policy.approvers.includes(approver), "Unlock approver denied");
      const load = this.loading.then(async () => {
        bounded.throwIfAborted();
        const until = Math.max(
          this.signerUntil,
          Date.now() + Math.max(28800, attempt.ttl + 120) * 1000,
        );
        const seconds = Math.ceil((until - Date.now()) / 1000);
        this.audit("signer_unlock_authorized", {
          request_id: attempt.requestId,
          approver,
          hosts: attempt.hosts,
          granted_seconds: attempt.ttl,
          signer_ttl_seconds: seconds,
        });
        await this.load(seconds, bounded);
        this.signerUntil = until;
        bounded.throwIfAborted();
        this.audit("signer_unlocked", { request_id: attempt.requestId, approver });
      });
      this.loading = load.catch(() => {});
      await load;
      return { approver };
    } finally {
      this.slots--;
      await attempt.ceremony.close();
    }
  }
  async close() {
    await Promise.all([...this.attempts.keys()].map((key) => this.cancel(key)));
  }
}
export async function loadStoredSigner(c: UnlockConfig, seconds: number, signal: AbortSignal) {
  const group = await run("/usr/bin/getent", ["group", "hub-unlocker"], signal);
  const expectedGroup = Number(group.stdout.trim().split(":")[2]);
  requireThat(
    group.exit_code === 0 && Number.isSafeInteger(expectedGroup) && expectedGroup > 0,
    "Unlock service group unavailable",
  );
  const info = lstatSync(c.key_file),
    parent = lstatSync(dirname(c.key_file));
  requireThat(
    info.isFile() &&
      info.uid === 0 &&
      info.gid === expectedGroup &&
      (info.mode & 0o777) === 0o640 &&
      info.size > 0 &&
      info.size <= 65536 &&
      parent.isDirectory() &&
      parent.uid === 0 &&
      parent.gid === info.gid &&
      (parent.mode & 0o027) === 0,
    "Stored SSH key metadata invalid",
  );
  for (const host of Object.values(c.policy.hosts)) await checkHostTrust(c.policy, host, signal);
  const env = { SSH_AUTH_SOCK: c.policy.signer_socket, SSH_ASKPASS_REQUIRE: "never" };
  const probe = await run("/usr/bin/ssh-keygen", ["-y", "-P", "", "-f", c.key_file], signal, env);
  const expected = readFileSync(c.policy.identity_file, "utf8")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
  requireThat(
    probe.exit_code === 0 && probe.stdout.trim().split(/\s+/).slice(0, 2).join(" ") === expected,
    "Stored identity mismatch",
  );
  const args = ["-t", `${seconds}s`, "-H", c.policy.known_hosts];
  for (const host of Object.values(c.policy.hosts))
    args.push("-h", `${host.user}@${host.key_alias}`);
  args.push(c.key_file);
  requireThat(
    (await run("/usr/bin/ssh-add", args, signal, env)).exit_code === 0,
    "Stored SSH key loading failed",
  );
  await checkSigner(c.policy, signal);
}
