// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import { readFileSync } from "node:fs";
import type { Config, Credentials, Provider } from "./types.ts";
import type { Broker } from "./broker.ts";
import { call, requestBytes, record, text, integer, requireThat } from "./io.ts";
import { checkHostTrust, checkSigner } from "./ssh.ts";

export class Bao implements Credentials {
  readonly config: Config;
  constructor(config: Config) {
    this.config = config;
  }
  private api(method: string, path: string, token: string, body: unknown, signal: AbortSignal) {
    return call(method, `${this.config.bao_url}/v1/${path}`, body, {
      signal,
      headers: token ? { "X-Vault-Token": token } : {},
    });
  }
  checkSigner(signal: AbortSignal) {
    return checkSigner(this.config, signal);
  }
  async prepare(caps: string[], seconds: number, signal: AbortSignal) {
    const deadline = Date.now() + seconds * 1000;
    const policies = new Set<string>();
    if (caps.some((c) => c.startsWith("ssh:"))) await this.checkSigner(signal);
    for (const cap of caps) {
      if (cap.startsWith("ssh:"))
        await checkHostTrust(this.config, this.config.hosts[cap.slice(4)]!, signal);
      if (cap.startsWith("provider:")) policies.add(this.config.providers[cap.slice(9)]!.policy);
    }
    if (!policies.size) return "";
    const password = readFileSync(this.config.bao_password_file);
    let login: Record<string, unknown>;
    try {
      login = record(
        record(
          await this.api(
            "POST",
            `auth/userpass/login/${this.config.bao_username}`,
            "",
            { password: password.toString().trim() },
            signal,
          ),
        ).auth,
      );
    } finally {
      password.fill(0);
    }
    const parent = text(login.client_token);
    requireThat(parent.length > 0, "OpenBao returned no token");
    let token = "";
    try {
      requireThat(
        Array.isArray(login.policies) &&
          login.policies.length === 1 &&
          login.policies[0] === "hub-broker",
        "Unexpected OpenBao machine policy",
      );
      const remaining = Math.floor((deadline - Date.now()) / 1000) - 1;
      requireThat(remaining >= 1 && remaining <= 3600, "Invalid remaining provider duration");
      const requested = [...policies].sort();
      const child = record(
        record(
          await this.api(
            "POST",
            "auth/token/create/hub-session",
            parent,
            {
              policies: requested,
              ttl: `${remaining}s`,
              explicit_max_ttl: `${remaining}s`,
              renewable: false,
              no_default_policy: true,
            },
            signal,
          ),
        ).auth,
      );
      token = text(child.client_token);
      requireThat(
        token &&
          !child.renewable &&
          integer(child.lease_duration) > 0 &&
          integer(child.lease_duration) <= Math.floor((deadline - Date.now()) / 1000) &&
          integer(child.lease_duration) <= remaining &&
          Array.isArray(child.policies) &&
          JSON.stringify([...child.policies].sort()) === JSON.stringify(requested),
        "Provider lease exceeded policy",
      );
      for (const cap of caps)
        if (cap.startsWith("provider:"))
          await this.secret(token, this.config.providers[cap.slice(9)]!, signal);
      return token;
    } catch (error) {
      if (token) await this.revoke(token).catch(() => {});
      throw error;
    } finally {
      await this.revoke(parent).catch(() => {});
    }
  }
  async revoke(token: string) {
    if (token)
      await this.api("POST", "auth/token/revoke-self", token, {}, AbortSignal.timeout(5000));
  }
  async secret(token: string, provider: Provider, signal: AbortSignal) {
    requireThat(token, "Provider authorization locked");
    const value = text(
      record(
        record(record(await this.api("GET", provider.kv_path, token, undefined, signal)).data).data,
      )[provider.field],
    );
    requireThat(value.length > 0 && !/[\r\n]/.test(value), "Invalid provider secret field");
    return value;
  }
}
export async function providerRequest(
  broker: Broker,
  bao: Bao,
  uid: number,
  input: {
    grant: string;
    provider: string;
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: unknown;
  },
  signal: AbortSignal,
) {
  const p = broker.config.providers[input.provider];
  requireThat(
    p &&
      p.methods.includes(input.method) &&
      new RegExp(p.path_pattern).test(input.path) &&
      input.path.startsWith("/") &&
      !input.path.startsWith("//") &&
      !/[%\\?#\r\n]/.test(input.path) &&
      !input.path.split("/").some((s) => s === ".." || s === "."),
    "Provider request outside configured capability",
  );
  const url = new URL(p.base_url);
  url.pathname = url.pathname.replace(/\/$/, "") + input.path;
  if (input.query)
    for (const [key, value] of Object.entries(input.query)) url.searchParams.set(key, value);
  return broker.operation(
    uid,
    input.grant,
    `provider:${input.provider}`,
    signal,
    async (operationSignal, grant) => {
      const seconds = Math.min(
        60,
        Math.floor((Date.parse(grant.grant_expires_at!) - Date.now()) / 1000),
      );
      const token = await bao.prepare([`provider:${input.provider}`], seconds, operationSignal);
      try {
        const secret = await bao.secret(token, p, operationSignal);
        const result = await requestBytes(
          input.method,
          url.href,
          input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body)),
          {
            signal: operationSignal,
            headers: { [p.header]: p.prefix + secret },
          },
        );
        const body = result.body.toString().replaceAll(secret, "[REDACTED]");
        return { status: result.status, content_type: "application/json", body, truncated: false };
      } finally {
        broker.revokeEventually(token, Date.now() + seconds * 1000);
      }
    },
  );
}
