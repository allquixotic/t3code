import * as Schema from "effect/Schema";

export const HubEnvironmentStatus = Schema.Struct({
  alias: Schema.String,
  label: Schema.String,
  phase: Schema.Literals(["locked", "pending", "updating", "connecting", "active", "error"]),
  approval_url: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  http_base_url: Schema.optional(Schema.String),
  pairing_code: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.String),
});
export type HubEnvironmentStatus = typeof HubEnvironmentStatus.Type;
