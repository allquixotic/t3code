import * as Schema from "effect/Schema";

/** Notification metadata only: never credentials, host policy or pairing codes. */
export const HubPendingApproval = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  purpose: Schema.String,
  capabilities: Schema.Array(Schema.String),
  approval_url: Schema.String,
  request_expires_at: Schema.String,
});
export type HubPendingApproval = typeof HubPendingApproval.Type;

export const HubEnvironmentStatus = Schema.Struct({
  alias: Schema.String,
  label: Schema.String,
  phase: Schema.Literals([
    "unenrolled",
    "locked",
    "pending",
    "updating",
    "connecting",
    "active",
    "error",
  ]),
  approval_url: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  http_base_url: Schema.optional(Schema.String),
  pairing_code: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.String),
});
export type HubEnvironmentStatus = typeof HubEnvironmentStatus.Type;
