import { protectedPath } from "./protected-path.ts";
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import { readFileSync, lstatSync } from "node:fs";
import { isAbsolute, win32 } from "node:path";
import { isIP } from "node:net";
import type { Config, Host, Provider, EnvironmentPolicy } from "./types.ts";
import { fields, record, text, integer, requireThat } from "./io.ts";

const name = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const strings = (value: unknown) => {
  requireThat(
    Array.isArray(value) && value.every((v) => typeof v === "string"),
    "String array required",
  );
  return value as string[];
};
export function parseConfig(value: unknown): Config {
  const c = fields(value, [
    "origin",
    "authelia_url",
    "authelia_version",
    "rp_id",
    "approvers",
    "user_handles",
    "web_listen",
    "worker_socket",
    "worker_uid",
    "worker_label",
    "audit_file",
    "signer_socket",
    "unlock_socket",
    "identity_file",
    "known_hosts",
    "bao_url",
    "bao_username",
    "bao_password_file",
    "hosts",
    "providers",
    "environments",
    "artifact_directory",
    "lease_signing_key",
  ]);
  const origin = new URL(text(c.origin));
  requireThat(
    origin.protocol === "https:" && origin.origin === c.origin && c.rp_id === origin.hostname,
    "Approval origin and RP mismatch",
  );
  const authelia = new URL(text(c.authelia_url));
  requireThat(
    authelia.origin === origin.origin &&
      !authelia.username &&
      !authelia.password &&
      !authelia.search &&
      !authelia.hash &&
      !authelia.href.endsWith("/"),
    "Invalid Authelia origin",
  );
  requireThat(c.authelia_version === "v4.39.27", "Authelia adapter version must be v4.39.27");
  const approvers = strings(c.approvers);
  requireThat(approvers.length > 0 && approvers.every((v) => name.test(v)), "Invalid approvers");
  if (c.user_handles !== undefined)
    for (const [user, handle] of Object.entries(record(c.user_handles)))
      requireThat(
        approvers.includes(user) && text(handle).length > 0,
        "Invalid pinned user handle",
      );
  const listener = new URL(`http://${text(c.web_listen)}`);
  requireThat(
    ["127.0.0.1", "[::1]"].includes(listener.hostname) && listener.port !== "",
    "Web listener must use explicit loopback",
  );
  for (const key of [
    "worker_socket",
    "audit_file",
    "signer_socket",
    "identity_file",
    "known_hosts",
  ])
    requireThat(isAbsolute(text(c[key])), "Absolute policy paths required");
  requireThat(
    integer(c.worker_uid) > 0 && text(c.worker_label).length > 0,
    "Non-root worker required",
  );
  if (c.unlock_socket)
    requireThat(
      isAbsolute(text(c.unlock_socket)) &&
        c.unlock_socket !== c.worker_socket &&
        c.unlock_socket !== c.signer_socket,
      "Separate unlock socket required",
    );
  const hosts: Record<string, Host> = {};
  for (const [alias, value] of Object.entries(record(c.hosts))) {
    const h = fields(value, ["hostname", "user", "port", "key_alias", "fingerprints"]);
    requireThat(
      name.test(alias) &&
        name.test(text(h.user)) &&
        name.test(text(h.key_alias)) &&
        integer(h.port) > 0 &&
        integer(h.port) <= 65535,
      "Invalid SSH host",
    );
    requireThat(
      text(h.hostname).length > 0 && !/^[-]|[\s/@%\\]/.test(text(h.hostname)),
      "Invalid SSH hostname",
    );
    requireThat(
      strings(h.fingerprints).length > 0 &&
        strings(h.fingerprints).every((v) => /^SHA256:[A-Za-z0-9+/]{43}$/.test(v)),
      "Verified fingerprints required",
    );
    hosts[alias] = h as unknown as Host;
  }
  const providers: Record<string, Provider> = {};
  for (const [alias, value] of Object.entries(record(c.providers))) {
    const p = fields(value, [
      "description",
      "base_url",
      "policy",
      "kv_path",
      "field",
      "header",
      "prefix",
      "methods",
      "path_pattern",
    ]);
    const url = new URL(text(p.base_url));
    requireThat(
      name.test(alias) &&
        name.test(text(p.policy)) &&
        text(p.description).length > 0 &&
        text(p.field).length > 0,
      "Invalid provider",
    );
    requireThat(
      url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash,
      "Invalid provider URL",
    );
    requireThat(
      text(p.kv_path).startsWith("hub/data/") && !/[?%#\\]|\.\./.test(text(p.kv_path)),
      "Invalid secret path",
    );
    requireThat(
      ["Authorization", "X-API-Key"].includes(text(p.header)) && !/[\r\n]/.test(text(p.prefix)),
      "Invalid provider header",
    );
    requireThat(
      strings(p.methods).length > 0 &&
        strings(p.methods).every((m) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(m)),
      "Invalid provider methods",
    );
    requireThat(
      text(p.path_pattern).startsWith("^") && text(p.path_pattern).endsWith("$"),
      "Anchored provider policy required",
    );
    new RegExp(text(p.path_pattern));
    providers[alias] = p as unknown as Provider;
  }
  const environments: Record<string, EnvironmentPolicy> = {};
  for (const [alias, value] of Object.entries(record(c.environments ?? {}))) {
    const p = fields(value, ["host", "supervisor", "platform", "label", "enrolled"]);
    requireThat(
      name.test(alias) && hosts[text(p.host)] && text(p.label).length > 0,
      "Invalid environment host",
    );
    requireThat(
      p.enrolled === undefined || typeof p.enrolled === "boolean",
      "Invalid enrollment state",
    );
    if (p.enrolled === false) {
      requireThat(
        p.platform === undefined && p.supervisor === undefined,
        "Deferred environment must not specify an unverified platform or supervisor",
      );
      environments[alias] = { host: text(p.host), label: text(p.label), enrolled: false };
      continue;
    }
    requireThat(
      /^(linux|darwin|win)-(x64|arm64)$/.test(text(p.platform)),
      "Unsupported environment platform",
    );
    requireThat(
      (text(p.platform).startsWith("win-")
        ? win32.isAbsolute(text(p.supervisor))
        : isAbsolute(text(p.supervisor))) && !/[\r\n\0]/.test(text(p.supervisor)),
      "Absolute supervisor path required",
    );
    environments[alias] = p as unknown as EnvironmentPolicy;
  }
  if (Object.keys(environments).length)
    requireThat(
      isAbsolute(text(c.artifact_directory)) && isAbsolute(text(c.lease_signing_key)),
      "Artifact directory and protected lease signing key required",
    );
  if (Object.keys(providers).length) {
    const bao = new URL(text(c.bao_url));
    requireThat(
      (bao.protocol === "https:" ||
        (bao.protocol === "http:" && isIP(bao.hostname) !== 0 && bao.hostname === "127.0.0.1")) &&
        bao.origin === c.bao_url &&
        !bao.username &&
        !bao.password,
      "Invalid OpenBao URL",
    );
    requireThat(
      name.test(text(c.bao_username)) && isAbsolute(text(c.bao_password_file)),
      "OpenBao identity required",
    );
  }
  return { ...c, hosts, providers, environments } as unknown as Config;
}
export function loadConfig(path: string): Config {
  protectedPath(path);
  const info = lstatSync(path);
  requireThat(
    info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0 && info.size < 1 << 20,
    "Administrator-owned policy required",
  );
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}
