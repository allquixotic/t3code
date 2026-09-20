// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import { createHash } from "node:crypto";
import type { Authenticator, Ceremony, Config, Grant } from "./types.ts";
import { call, equal, record, text, integer, requireThat } from "./io.ts";

function decode(value: unknown): Buffer {
  const encoded = text(value);
  requireThat(/^[A-Za-z0-9_-]+$/.test(encoded), "Invalid passkey encoding");
  const bytes = Buffer.from(encoded, "base64url");
  requireThat(bytes.toString("base64url") === encoded, "Noncanonical passkey encoding");
  return bytes;
}
export function validateAssertion(
  raw: unknown,
  challenge: string,
  deadline: number,
  origin: string,
  rp: string,
  now = Date.now(),
): string {
  requireThat(now < deadline, "Passkey challenge expired");
  const value = record(raw),
    response = record(value.response);
  requireThat(value.type === "public-key" && value.id === value.rawId, "Invalid passkey assertion");
  const id = decode(value.id),
    signature = decode(response.signature),
    handle = decode(response.userHandle);
  requireThat(
    id.length > 0 &&
      id.length <= 1024 &&
      signature.length > 0 &&
      handle.length > 0 &&
      handle.length <= 64,
    "Invalid passkey assertion size",
  );
  const client = record(JSON.parse(decode(response.clientDataJSON).toString()));
  requireThat(
    client.type === "webauthn.get" &&
      client.origin === origin &&
      !client.crossOrigin &&
      !client.topOrigin &&
      equal(decode(client.challenge), decode(challenge)),
    "Passkey origin or challenge mismatch",
  );
  const auth = decode(response.authenticatorData);
  requireThat(
    auth.length >= 37 &&
      equal(auth.subarray(0, 32), createHash("sha256").update(rp).digest()) &&
      (auth[32]! & 5) === 5,
    "Passkey RP, presence, or verification mismatch",
  );
  // Binding checks complement, never replace, Authelia's cryptographic verification.
  return text(response.userHandle);
}
export class Authelia implements Authenticator {
  readonly config: Config;
  constructor(config: Config) {
    this.config = config;
  }
  async begin(_request: Grant, _ttl: number, signal: AbortSignal): Promise<Ceremony> {
    const cookies = new Map<string, string>();
    const api = async (method: string, path: string, body: unknown, signal: AbortSignal) => {
      const env = record(
        await call(method, this.config.authelia_url + path, body, {
          signal,
          cookies,
          headers: { Origin: this.config.origin },
        }),
      );
      requireThat(env.status === "OK", "Authelia refused authentication");
      return env.data;
    };
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        await api("POST", "/api/logout", {}, AbortSignal.timeout(3000));
      } catch {
        /* fresh session is discarded */
      }
      cookies.clear();
    };
    try {
      const state = record(await api("GET", "/api/state", undefined, signal));
      requireThat(
        !state.username && state.authentication_level === 0,
        "Fresh anonymous authentication session required",
      );
      const options = record(
        record(await api("GET", "/api/firstfactor/passkey", undefined, signal)).publicKey,
      );
      const challenge = text(options.challenge);
      requireThat(
        decode(challenge).length >= 16 &&
          options.rpId === this.config.rp_id &&
          options.userVerification === "required",
        "Authelia challenge contract changed",
      );
      const timeout = integer(options.timeout);
      requireThat(timeout >= 1000 && timeout <= 120_000, "Invalid passkey challenge lifetime");
      const deadline = Date.now() + timeout;
      let consumed = false;
      return {
        options,
        challenge,
        deadline,
        close,
        finish: async (raw, signal) => {
          requireThat(!consumed && !closed, "Passkey ceremony already consumed");
          consumed = true;
          try {
            const handle = validateAssertion(
              raw,
              challenge,
              deadline,
              this.config.origin,
              this.config.rp_id,
            );
            await api(
              "POST",
              "/api/firstfactor/passkey",
              { response: raw, keepMeLoggedIn: false },
              signal,
            );
            const state = record(await api("GET", "/api/state", undefined, signal));
            const username = text(state.username);
            requireThat(
              this.config.approvers.includes(username) &&
                integer(state.authentication_level) >= 1 &&
                !state.factor_knowledge,
              "Passkey user is not an allowed approver",
            );
            const pinned = this.config.user_handles?.[username];
            requireThat(!pinned || pinned === handle, "Approver identity changed");
            signal.throwIfAborted();
            requireThat(Date.now() < deadline, "Passkey challenge expired");
            return username;
          } finally {
            await close();
          }
        },
      };
    } catch (error) {
      await close();
      throw error;
    }
  }
}
