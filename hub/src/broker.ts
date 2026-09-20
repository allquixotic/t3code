// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import type { Authenticator, Ceremony, Config, Credentials, Grant, GrantState } from "./types.ts";
import { id, requireThat, HubError } from "./io.ts";

interface LiveGrant {
  value: Grant;
  uid: number;
  abort: AbortController;
  ceremony?: Ceremony;
  browser?: string;
  token: string;
  busy: number;
}
export class Broker {
  readonly requests = new Map<string, LiveGrant>();
  readonly stopped = new Set<(grant: Grant) => void>();
  readonly revocations = new Set<Promise<void>>();
  readonly config: Config;
  readonly auth: Authenticator;
  readonly credentials: Credentials;
  readonly audit: (event: string, details: Record<string, unknown>) => void;
  readonly now: typeof Date.now;
  constructor(
    config: Config,
    auth: Authenticator,
    credentials: Credentials,
    audit: (event: string, details: Record<string, unknown>) => void,
    now = Date.now,
  ) {
    this.config = config;
    this.auth = auth;
    this.credentials = credentials;
    this.audit = audit;
    this.now = now;
  }
  catalog() {
    const capabilities: Record<string, unknown> = {};
    for (const [alias, host] of Object.entries(this.config.hosts))
      capabilities[`ssh:${alias}`] = host;
    for (const [alias, p] of Object.entries(this.config.providers))
      capabilities[`provider:${alias}`] = {
        description: p.description,
        base_url: p.base_url,
        methods: p.methods,
        path_pattern: p.path_pattern,
      };
    for (const [alias, p] of Object.entries(this.config.environments ?? {})) {
      if (p.enrolled === false) continue;
      capabilities[`environment:${alias}`] = {
        ...this.config.hosts[p.host],
        label: p.label,
        updates: "Patched runtime installed automatically from this hub",
      };
    }
    return {
      worker: this.config.worker_label,
      isolation: "unix_uid_shared",
      max_ttl_seconds: 3600,
      max_approval_ttl_seconds: 172800,
      capabilities,
    };
  }
  create(uid: number, purpose: string, caps: string[], ttl = 1800): Grant {
    requireThat(uid === this.config.worker_uid, "Worker denied");
    purpose = purpose.trim();
    requireThat(
      purpose.length >= 3 && purpose.length <= 1000 && caps.length >= 1 && caps.length <= 20,
      "Purpose and 1–20 capabilities required",
    );
    requireThat(
      Number.isSafeInteger(ttl) && ttl >= 60 && ttl <= 3600,
      "Requested duration must be 60–3600 seconds",
    );
    const scope: Record<string, unknown> = {},
      catalog = this.catalog().capabilities;
    for (const cap of caps) {
      requireThat(
        Object.hasOwn(catalog, cap) && !Object.hasOwn(scope, cap),
        "Unknown or duplicate capability",
      );
      scope[cap] = catalog[cap];
    }
    this.reap();
    const recent = [...this.requests.values()].filter(
      (r) => this.now() - Date.parse(r.value.created_at) < 60000,
    ).length;
    const live = [...this.requests.values()].filter(
      (r) => !["expired", "revoked"].includes(r.value.state),
    ).length;
    requireThat(recent < 10 && live < 32 && this.requests.size < 256, "Request limit reached");
    const requestId = id();
    const value: Grant = {
      id: requestId,
      worker: this.config.worker_label,
      purpose,
      capabilities: [...caps].sort(),
      scope,
      requested_seconds: ttl,
      created_at: new Date(this.now()).toISOString(),
      request_expires_at: new Date(this.now() + 600000).toISOString(),
      state: "pending",
      approval_url: `${this.config.origin}/access/requests/${requestId}`,
    };
    this.audit("request_created", {
      request_id: requestId,
      uid,
      capabilities: caps,
      ttl_seconds: ttl,
    });
    this.requests.set(requestId, { value, uid, abort: new AbortController(), token: "", busy: 0 });
    return structuredClone(value);
  }
  private get(uid: number, requestId: string) {
    const r = this.requests.get(requestId);
    requireThat(r && (uid < 0 || uid === r.uid), "Request not found");
    this.expire(r);
    return r;
  }
  status(uid: number, requestId: string) {
    return structuredClone(this.get(uid, requestId).value);
  }
  list(uid: number, state?: string, capability?: string) {
    requireThat(uid === this.config.worker_uid, "Worker denied");
    this.reap();
    return {
      worker: this.config.worker_label,
      isolation: "unix_uid_shared",
      requests: [...this.requests.values()]
        .filter(
          (r) =>
            r.uid === uid &&
            (!state || r.value.state === state) &&
            (!capability || r.value.capabilities.includes(capability)),
        )
        .map((r) => structuredClone(r.value))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    };
  }
  async begin(
    requestId: string,
    browser: string,
    ttl: number,
    signal: AbortSignal,
  ): Promise<Ceremony> {
    const r = this.get(-1, requestId);
    requireThat(
      r.value.state === "pending" && Number.isSafeInteger(ttl) && ttl >= 60 && ttl <= 172800,
      "Request unavailable or duration outside 1 minute–48 hours",
    );
    r.value.state = "authenticating";
    r.value.granted_seconds = ttl;
    r.browser = browser;
    try {
      const ceremony = await this.auth.begin(
        structuredClone(r.value),
        ttl,
        AbortSignal.any([signal, r.abort.signal]),
      );
      this.expire(r);
      if (r.value.state !== "authenticating") {
        await ceremony.close();
        throw new HubError("Request expired or cancelled");
      }
      r.ceremony = ceremony;
      return ceremony;
    } catch (error) {
      if (r.value.state === "authenticating") r.value.state = "pending";
      throw error;
    }
  }
  async finish(
    requestId: string,
    browser: string,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<Grant> {
    const r = this.get(-1, requestId);
    requireThat(
      r.value.state === "authenticating" && r.browser === browser && r.ceremony,
      "Approval transaction unavailable or consumed",
    );
    const ceremony = r.ceremony;
    delete r.ceremony;
    r.value.state = "verifying";
    const operationSignal = AbortSignal.any([
      signal,
      r.abort.signal,
      AbortSignal.timeout(Math.max(1, ceremony.deadline - this.now())),
    ]);
    let token = "";
    let expiry = this.now();
    try {
      const approver = await ceremony.finish(raw, operationSignal);
      requireThat(this.config.approvers.includes(approver), "Approver denied");
      this.expire(r);
      requireThat(r.value.state === "verifying", "Approval expired or cancelled");
      expiry = this.now() + r.value.granted_seconds! * 1000;
      token = await this.credentials.prepare(
        this.credentialCapabilities(r.value.capabilities),
        Math.min(r.value.granted_seconds!, 60),
        operationSignal,
      );
      // Provider secrets are obtained with fresh short leases per operation; no provider lease is retained by a grant.
      if (token) {
        this.revokeEventually(token, Math.min(expiry, this.now() + 60000));
        token = "";
      }
      this.expire(r);
      operationSignal.throwIfAborted();
      requireThat(
        r.value.state === "verifying" && this.now() < expiry,
        "Approval expired or cancelled",
      );
      this.audit("grant_approved", {
        request_id: requestId,
        uid: r.uid,
        approver,
        requested_seconds: r.value.requested_seconds,
        granted_seconds: r.value.granted_seconds,
        expires_at: new Date(expiry).toISOString(),
        capabilities: r.value.capabilities,
      });
      r.value.state = "active";
      r.value.approver = approver;
      r.value.grant_expires_at = new Date(expiry).toISOString();
      return structuredClone(r.value);
    } catch (error) {
      if (token) this.revokeEventually(token, expiry);
      if (r.value.state === "verifying") r.value.state = "pending";
      try {
        this.audit("approval_failed", { request_id: requestId });
      } catch {
        /* authorization remains locked */
      }
      throw error;
    } finally {
      await ceremony.close();
    }
  }
  credentialCapabilities(caps: string[]) {
    return [
      ...new Set(
        caps.map((cap) =>
          cap.startsWith("environment:")
            ? `ssh:${this.config.environments![cap.slice(12)]!.host}`
            : cap,
        ),
      ),
    ];
  }
  revoke(uid: number, requestId: string, approver?: string) {
    const r = this.get(uid, requestId);
    requireThat(
      uid >= 0 || (approver && approver === r.value.approver),
      "Use the browser that approved this grant",
    );
    this.stop(r, "revoked");
  }
  async operation<T>(
    uid: number,
    requestId: string,
    capability: string,
    parent: AbortSignal,
    work: (signal: AbortSignal, grant: Grant) => Promise<T>,
  ): Promise<T> {
    const r = this.get(uid, requestId);
    requireThat(
      r.value.state === "active" &&
        !r.abort.signal.aborted &&
        r.value.capabilities.includes(capability),
      "Authorization locked",
    );
    requireThat(r.busy < 4, "Grant concurrency limit reached");
    this.audit("operation_started", { request_id: requestId, uid, capability });
    r.busy++;
    const deadline = AbortSignal.timeout(
      Math.max(1, Date.parse(r.value.grant_expires_at!) - this.now()),
    );
    try {
      return await work(
        AbortSignal.any([parent, r.abort.signal, deadline]),
        structuredClone(r.value),
      );
    } finally {
      r.busy--;
      this.audit("operation_finished", { request_id: requestId, capability });
    }
  }
  private expire(r: LiveGrant) {
    if (["revoked", "expired"].includes(r.value.state)) return;
    const deadline =
      r.value.state === "active" ? r.value.grant_expires_at! : r.value.request_expires_at;
    if (this.now() >= Date.parse(deadline)) this.stop(r, "expired");
  }
  private stop(r: LiveGrant, state: GrantState) {
    if (["expired", "revoked"].includes(r.value.state)) return;
    r.value.state = state;
    r.abort.abort();
    if (r.ceremony) {
      void r.ceremony.close();
      delete r.ceremony;
    }
    for (const listener of this.stopped) listener(structuredClone(r.value));
    this.audit(`grant_${state}`, { request_id: r.value.id, uid: r.uid });
  }
  reap() {
    for (const [key, r] of this.requests) {
      this.expire(r);
      if (r.value.state === "authenticating" && r.ceremony && this.now() >= r.ceremony.deadline) {
        void r.ceremony.close();
        delete r.ceremony;
        r.value.state = "pending";
      }
      if (
        ["revoked", "expired"].includes(r.value.state) &&
        !r.busy &&
        this.now() - Date.parse(r.value.created_at) > 7200000
      )
        this.requests.delete(key);
    }
  }
  async monitorSigner() {
    const active = [...this.requests.values()].filter(
      (r) =>
        r.value.state === "active" &&
        this.credentialCapabilities(r.value.capabilities).some((c) => c.startsWith("ssh:")),
    );
    if (!active.length) return;
    try {
      await this.credentials.checkSigner(AbortSignal.timeout(2000));
    } catch {
      for (const r of active) if (r.value.state === "active") this.stop(r, "revoked");
    }
  }
  close() {
    for (const r of this.requests.values()) this.stop(r, "revoked");
  }
  revokeEventually(token: string, until: number) {
    const task = (async () => {
      do {
        try {
          await this.credentials.revoke(token);
          return;
        } catch {
          /* nonrenewable TTL bounds failure */
        }
        if (this.now() >= until) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          timer.unref();
        });
      } while (this.now() < until);
    })();
    this.revocations.add(task);
    void task.finally(() => this.revocations.delete(task));
  }
}
