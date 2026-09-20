// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
export interface Host {
  hostname: string;
  user: string;
  port: number;
  key_alias: string;
  fingerprints: string[];
}
export interface Provider {
  description: string;
  base_url: string;
  policy: string;
  kv_path: string;
  field: string;
  header: "Authorization" | "X-API-Key";
  prefix: string;
  methods: string[];
  path_pattern: string;
}
export interface Config {
  origin: string;
  authelia_url: string;
  authelia_version: string;
  rp_id: string;
  approvers: string[];
  user_handles?: Record<string, string>;
  web_listen: string;
  worker_socket: string;
  worker_uid: number;
  worker_label: string;
  audit_file: string;
  signer_socket: string;
  unlock_socket?: string;
  identity_file: string;
  known_hosts: string;
  bao_url: string;
  bao_username: string;
  bao_password_file: string;
  hosts: Record<string, Host>;
  providers: Record<string, Provider>;
  environments?: Record<string, EnvironmentPolicy>;
  artifact_directory?: string;
  lease_signing_key?: string;
}
export type RuntimePlatform =
  | "linux-x64"
  | "linux-arm64"
  | "darwin-x64"
  | "darwin-arm64"
  | "win-x64"
  | "win-arm64";
export type EnvironmentPolicy = { host: string; label: string } & (
  | { enrolled: false }
  | { enrolled?: true; supervisor: string; platform: RuntimePlatform }
);
export type GrantState =
  | "pending"
  | "authenticating"
  | "verifying"
  | "active"
  | "expired"
  | "revoked";
export interface Grant {
  id: string;
  worker: string;
  purpose: string;
  capabilities: string[];
  scope: Record<string, unknown>;
  requested_seconds: number;
  granted_seconds?: number;
  created_at: string;
  request_expires_at: string;
  grant_expires_at?: string;
  state: GrantState;
  approver?: string;
  approval_url: string;
}
export interface Ceremony {
  options: Record<string, unknown>;
  deadline: number;
  challenge: string;
  finish(assertion: unknown, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
}
export interface Authenticator {
  begin(request: Grant, ttl: number, signal: AbortSignal): Promise<Ceremony>;
}
export interface Credentials {
  prepare(capabilities: string[], seconds: number, signal: AbortSignal): Promise<string>;
  revoke(token: string): Promise<void>;
  checkSigner(signal: AbortSignal): Promise<void>;
}
export interface Artifact {
  platform: RuntimePlatform;
  file: string;
  sha256: string;
  bytes: number;
}
export interface ReleaseManifest {
  schema: 1;
  baseline: string;
  revision: string;
  patchVersion: string;
  protocol: 1;
  artifacts: Artifact[];
}
export interface EnvironmentStatus {
  alias: string;
  label: string;
  phase: "unenrolled" | "locked" | "pending" | "updating" | "connecting" | "active" | "error";
  approval_url?: string;
  expires_at?: string;
  error?: string;
  http_base_url?: string;
  pairing_code?: string;
  revision?: string;
}
