// FILE: botComms.ts
// Purpose: Pure decision logic for bot-to-bot comms — the depth cap, the per-thread delegation
//          queue cap, target resolution, and the exact agent-facing prompt/result strings.
//          No I/O here so the rules are unit-testable and shared by ask_bot, delegate_bot and the
//          drainer.
// Layer: Server domain (bots)

import {
  BOT_MAX_COMMS_DEPTH,
  BOT_MAX_QUEUED_DELEGATIONS_PER_THREAD,
  BOT_COMMS_PREVIEW_MAX_CHARS,
  type Bot,
  type BotId,
  type BotRuntimeState,
} from "@vulcan/contracts";

/** Hard cap on how deep bot→bot chains may go. Depth 0 = human-started turn. */
export const MAX_COMMS_DEPTH = BOT_MAX_COMMS_DEPTH;
export const MAX_QUEUED_DELEGATIONS_PER_THREAD = BOT_MAX_QUEUED_DELEGATIONS_PER_THREAD;

/** How long an ask_bot caller waits for the peer's reply before giving up. */
export const ASK_BOT_WAIT_CEILING_MS = 4 * 60 * 1_000;
/** How long a peer-comms approval card stays open before it is treated as denied. */
export const PEER_APPROVAL_TIMEOUT_MS = 15 * 60 * 1_000;

export type PeerTargetResolution =
  | { readonly ok: true; readonly target: Bot }
  | { readonly ok: false; readonly code: "self" | "no_target" | "too_deep" };

export type DelegationQueueDecision =
  | { readonly ok: true; readonly target: Bot }
  | { readonly ok: false; readonly code: "self" | "no_target" | "too_deep" | "too_many" };

/** Bots the caller may see: live, not hidden (callers may always see themselves). */
export function visiblePeerBots(bots: ReadonlyArray<Bot>, selfId: BotId): ReadonlyArray<Bot> {
  return bots.filter((bot) => bot.archivedAt === null && (!bot.isHidden || bot.id === selfId));
}

export function findPeerBot(
  bots: ReadonlyArray<Bot>,
  selfId: BotId,
  rawTargetId: string,
): Bot | null {
  const wanted = rawTargetId.trim().replace(/^@/, "").toLowerCase();
  if (wanted.length === 0) return null;
  const visible = visiblePeerBots(bots, selfId);
  return (
    visible.find((bot) => bot.id.toLowerCase() === wanted) ??
    visible.find((bot) => bot.name.trim().toLowerCase() === wanted) ??
    null
  );
}

/** Shared between ask_bot and delegate_bot: self, unknown target, and depth cap. */
export function resolvePeerTarget(input: {
  readonly bots: ReadonlyArray<Bot>;
  readonly selfId: BotId;
  readonly rawTargetId: string;
  readonly callerDepth: number;
}): PeerTargetResolution {
  if (input.callerDepth >= MAX_COMMS_DEPTH) {
    return { ok: false, code: "too_deep" };
  }
  const target = findPeerBot(input.bots, input.selfId, input.rawTargetId);
  if (!target) return { ok: false, code: "no_target" };
  if (target.id === input.selfId) return { ok: false, code: "self" };
  return { ok: true, target };
}

export function decideDelegation(input: {
  readonly bots: ReadonlyArray<Bot>;
  readonly selfId: BotId;
  readonly rawTargetId: string;
  readonly callerDepth: number;
  readonly pendingForSourceThread: number;
}): DelegationQueueDecision {
  const resolved = resolvePeerTarget(input);
  if (!resolved.ok) return resolved;
  if (input.pendingForSourceThread >= MAX_QUEUED_DELEGATIONS_PER_THREAD) {
    return { ok: false, code: "too_many" };
  }
  return resolved;
}

export function peerFailureText(
  code: "self" | "no_target" | "too_deep" | "too_many",
  rawTargetId: string,
): string {
  switch (code) {
    case "self":
      return "You cannot message yourself.";
    case "no_target":
      return `No visible bot matches "${rawTargetId.trim()}". Use list_bots to see who is available.`;
    case "too_deep":
      return `Bot-to-bot messaging is limited to ${MAX_COMMS_DEPTH} hop${MAX_COMMS_DEPTH === 1 ? "" : "s"}; this turn was itself started by another bot, so reply to them directly instead.`;
    case "too_many":
      return `This turn already has ${MAX_QUEUED_DELEGATIONS_PER_THREAD} queued delegations. Let them run before delegating more.`;
  }
}

/** True when the target cannot accept a new peer turn right now. */
export function isBotBusy(input: {
  readonly runtime: Pick<BotRuntimeState, "phase"> | null;
  readonly latestTurnState: string | null | undefined;
}): boolean {
  const phase = input.runtime?.phase ?? "idle";
  if (phase !== "idle") return true;
  return input.latestTurnState === "running";
}

export function busyText(targetName: string, action: "ask" | "delegate"): string {
  return action === "ask"
    ? `@${targetName} is busy right now. Try again later or use delegate_bot so the work runs when they are free.`
    : `Delegation to @${targetName} canceled — @${targetName} is busy.`;
}

export function deniedText(targetName: string): string {
  return `Message to @${targetName} was denied by the user.`;
}

/** Turn prompt a peer sees when asked synchronously (reply goes back to the asker). */
export function buildAskPrompt(input: { readonly fromName: string; readonly message: string }) {
  return `[Message from @${input.fromName}, another bot in this Vulcan workspace. Reply to them.]\n\n${input.message}`;
}

/** Turn prompt a peer sees for an async delegation. */
export function buildDelegationPrompt(input: {
  readonly fromName: string;
  readonly message: string;
  readonly reason: string | null;
}) {
  const reason = input.reason?.trim();
  return `[Delegated by @${input.fromName}, another bot in this Vulcan workspace. Do the work and reply directly.]\n\n${input.message}${
    reason ? `\n\n[Reason: ${reason}]` : ""
  }`;
}

export function clipPreview(text: string, max: number = BOT_COMMS_PREVIEW_MAX_CHARS): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Status label for the "Messaged @X" activity chip shown in the source thread. */
export function commsActivitySummary(input: {
  readonly action: "ask" | "delegate";
  readonly targetName: string;
}): string {
  return input.action === "ask"
    ? `Messaged @${input.targetName}`
    : `Delegated to @${input.targetName}`;
}
