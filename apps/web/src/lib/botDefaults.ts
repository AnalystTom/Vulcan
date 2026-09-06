import {
  DEFAULT_BOT_AUTONOMY,
  DEFAULT_BOT_AVATAR_SHAPE,
  DEFAULT_BOT_CAPABILITY_GRANTS,
  DEFAULT_BOT_ISOLATION_MODE,
  type Bot,
  type BotAutonomyConfig,
  type BotAvatar,
  type BotAvatarShape,
  type BotCapability,
  type BotIsolationMode,
  type BotListResult,
  type BotRuntimeState,
} from "@vulcan/contracts";

/**
 * Fields added to `Bot` after the first release decode with defaults on the server, but the
 * contract's TS type keeps them optional. Resolve them once here so UI code never re-derives
 * the fallbacks.
 */
export function resolveBotAutonomy(bot: Pick<Bot, "autonomy">): BotAutonomyConfig {
  return { ...DEFAULT_BOT_AUTONOMY, ...bot.autonomy };
}

export function resolveBotCapabilityGrants(
  bot: Pick<Bot, "capabilityGrants">,
): ReadonlyArray<BotCapability> {
  return bot.capabilityGrants ?? DEFAULT_BOT_CAPABILITY_GRANTS;
}

export function resolveBotIsolationMode(bot: Pick<Bot, "isolationMode">): BotIsolationMode {
  return bot.isolationMode ?? DEFAULT_BOT_ISOLATION_MODE;
}

export function resolveBotRuntimeStates(
  result: Pick<BotListResult, "runtimeStates">,
): ReadonlyArray<BotRuntimeState> {
  return result.runtimeStates ?? [];
}

export function resolveBotAvatarShape(avatar: BotAvatar): BotAvatarShape {
  return avatar.shape ?? DEFAULT_BOT_AVATAR_SHAPE;
}

/**
 * Stable identity for an avatar, so dirty checks compare what the user actually chose
 * rather than object references.
 */
export function botAvatarKey(avatar: BotAvatar): string {
  return [
    avatar.kind,
    resolveBotAvatarShape(avatar),
    avatar.color,
    avatar.imageAttachmentId ?? "",
  ].join("|");
}
