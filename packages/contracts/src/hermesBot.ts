import { Schema } from "effect";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

const HermesBotString = Schema.String.check(Schema.isMaxLength(2_048));
const HermesBotParams = Schema.Record(Schema.String, Schema.Json).check(
  Schema.isMaxProperties(128),
);

/** RPCs exposed through the bounded Hermes Bot bridge. */
export const HERMES_BOT_METHODS = [
  "profiles.list",
  "profiles.create",
  "profiles.describe",
  "profiles.configure",
  "profiles.set_asset",
  "profiles.get_asset",
  "session.list",
  "session.create",
  "session.resume",
  "session.title",
  "session.history",
  "prompt.submit",
  "session.interrupt",
  "approval.respond",
  "clarify.respond",
  "groups.capabilities",
  "groups.list",
  "groups.create",
  "groups.state",
  "groups.send",
  "groups.log",
  "groups.rename",
  "groups.stop",
  "groups.retry",
  "groups.approve",
  "cron.manage",
  "model.options",
  "model.check",
  "mcp.catalog",
  "mcp.servers.list",
  "mcp.servers.add",
  "mcp.servers.test",
  "mcp.servers.remove",
  "mcp.servers.oauth.start",
  "mcp.servers.oauth.poll",
  "mcp.servers.oauth.cancel",
  "mcp.servers.oauth.callback",
  "vulcan.accounts.list",
  "vulcan.accounts.save",
  "vulcan.accounts.remove",
  "vulcan.accounts.check",
  "vulcan.accounts.grant",
  "vulcan.accounts.revoke",
] as const;

export const HermesBotMethod = Schema.Literals(HERMES_BOT_METHODS);
export type HermesBotMethod = typeof HermesBotMethod.Type;

export const HermesBotCapabilities = Schema.Struct({
  protocol_version: NonNegativeInt,
  driver: Schema.Boolean,
  persistent_process: Schema.Boolean,
  methods: Schema.Array(HermesBotString),
  features: Schema.Array(HermesBotString),
});
export type HermesBotCapabilities = typeof HermesBotCapabilities.Type;

export const HermesBotStatus = Schema.Struct({
  configured: Schema.Boolean,
  connected: Schema.Boolean,
  endpoint: Schema.NullOr(HermesBotString),
  message: Schema.NullOr(HermesBotString),
  capabilities: Schema.NullOr(HermesBotCapabilities),
});
export type HermesBotStatus = typeof HermesBotStatus.Type;

export const HermesBotConnectInput = Schema.Struct({
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  token: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
});
export type HermesBotConnectInput = typeof HermesBotConnectInput.Type;

export const HermesBotRequest = Schema.Struct({
  method: HermesBotMethod,
  params: HermesBotParams,
});
export type HermesBotRequest = typeof HermesBotRequest.Type;

/** Read-only report content from the owner-configured Hermes gateway. */
export const HermesBotReadFileInput = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
});
export type HermesBotReadFileInput = typeof HermesBotReadFileInput.Type;

export const HermesBotReadFileResult = Schema.Struct({
  name: HermesBotString,
  path: HermesBotString,
  size: NonNegativeInt,
  mimeType: HermesBotString,
  contents: Schema.String,
});
export type HermesBotReadFileResult = typeof HermesBotReadFileResult.Type;

export const HermesBotEvent = Schema.Struct({
  type: HermesBotString,
  payload: HermesBotParams,
});
export type HermesBotEvent = typeof HermesBotEvent.Type;
