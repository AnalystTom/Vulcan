// FILE: traceTheme.ts
// Purpose: How a factory trace looks -- lane tints, icons, status glyphs, wording.
// Layer: Workspace UI
//
// The factory declares a colour per agent in its own config, and that colour
// wins wherever it exists: an operator who set the builder to violet in
// `sssf.config.yaml` must see violet here, or the two views of the same run stop
// agreeing. A bot's own avatar colour comes next, for a lane Vulcan itself ran;
// Vulcan's palette is only the last fallback, for a worker nobody coloured.

import { IconRobot, IconTerminal2, IconUser, type IconProps } from "@tabler/icons-react";
import type { TracePhaseKind, TracePhaseStatus, TraceSessionStatus } from "@vulcan/contracts";
import { botColorHex } from "@vulcan/shared/botAppearance";
import type { FactoryTraceLane } from "@vulcan/shared/factoryTraceTimeline";
import type { ComponentType } from "react";

export const PHASE_STATUS_LABEL: Record<TracePhaseStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  success: "Success",
  fail: "Failed",
};

export const PHASE_STATUS_TONE: Record<TracePhaseStatus, string> = {
  queued: "text-muted-foreground",
  running: "text-sky-600 dark:text-sky-400",
  completed: "text-emerald-600 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-400",
  success: "text-emerald-600 dark:text-emerald-400",
  fail: "text-red-600 dark:text-red-400",
};

/** A single character, so a status survives a block squeezed to its minimum. */
export const PHASE_STATUS_GLYPH: Record<TracePhaseStatus, string> = {
  queued: "○",
  running: "●",
  completed: "✓",
  failed: "✗",
  success: "✓",
  fail: "✗",
};

export const SESSION_STATUS_TONE: Record<TraceSessionStatus, string> = {
  running: "border-sky-500/40 text-sky-600 dark:text-sky-400",
  completed: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  failed: "border-red-500/40 text-red-600 dark:text-red-400",
  success: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  fail: "border-red-500/40 text-red-600 dark:text-red-400",
};

export const LANE_ICON: Record<TracePhaseKind, ComponentType<IconProps>> = {
  engineer: IconUser,
  code: IconTerminal2,
  agent: IconRobot,
};

/** Tints for lanes the factory did not colour itself. */
const FALLBACK_AGENT_TINTS = [
  "var(--factory-lane-agent-1)",
  "var(--factory-lane-agent-2)",
  "var(--factory-lane-agent-3)",
  "var(--factory-lane-agent-4)",
] as const;

const KIND_TINTS: Record<TracePhaseKind, string> = {
  engineer: "var(--factory-lane-operator)",
  code: "var(--factory-lane-workspace)",
  agent: FALLBACK_AGENT_TINTS[0],
};

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

/**
 * One tint per lane, keyed by lane id.
 *
 * Assigned across the whole set so fallback tints cycle in lane order and stay
 * stable as later lanes appear -- a lane that changed colour mid-run would read
 * as a different worker.
 *
 * `identityTint` is the caller's chance to name a colour the trace itself does
 * not carry -- the current swatch of the bot a lane belongs to, which is what a
 * run recorded before the colour existed, or one recoloured since, would
 * otherwise lose.
 */
export function buildLaneTints(
  lanes: readonly FactoryTraceLane[],
  identityTint?: (lane: FactoryTraceLane) => string | null,
): Map<string, string> {
  const tints = new Map<string, string>();
  let agentIndex = 0;
  for (const lane of lanes) {
    if (lane.color !== null && HEX_COLOR.test(lane.color)) {
      // The factory's own swatch. Validated because it comes from a config file
      // we do not own, and an unchecked value here would land in a style prop.
      tints.set(lane.id, lane.color);
      continue;
    }
    const identity = identityTint?.(lane) ?? null;
    if (identity !== null && HEX_COLOR.test(identity)) {
      tints.set(lane.id, identity);
      continue;
    }
    if (lane.kind !== "agent") {
      tints.set(lane.id, KIND_TINTS[lane.kind]);
      continue;
    }
    tints.set(lane.id, FALLBACK_AGENT_TINTS[agentIndex % FALLBACK_AGENT_TINTS.length] as string);
    agentIndex += 1;
  }
  return tints;
}

/** The identity a lane draws under: a bot on the roster, matched by name. */
export interface LaneBot {
  readonly name: string;
  readonly avatar: { readonly color: string };
}

/**
 * The bot a lane belongs to, or null.
 *
 * Matched on `displayName` alone, never on the lane's label: an external factory
 * is free to call an agent "researcher", and drawing a coworker's face on
 * someone else's work would be a lie the operator cannot check. Only a trace
 * Vulcan wrote carries a display name at all.
 */
export function findLaneBot<Bot extends LaneBot>(
  lane: Pick<FactoryTraceLane, "displayName" | "kind">,
  bots: readonly Bot[],
): Bot | null {
  if (lane.kind !== "agent" || lane.displayName === null) return null;
  const name = lane.displayName.trim().toLocaleLowerCase();
  if (name === "") return null;
  return bots.find((bot) => bot.name.trim().toLocaleLowerCase() === name) ?? null;
}

/**
 * A bot's own swatch, for the lane it owns.
 *
 * The trace already carries the hex the server wrote, and `buildLaneTints`
 * honours it; this covers the lane whose row predates the colour -- a bot
 * recoloured since the run, or a trace written before the column existed.
 */
export const laneBotTint = (bot: LaneBot): string | null => botColorHex(bot.avatar.color);

/** Tint at an alpha, for fills and borders that must not compete with the copy. */
export const laneTintAlpha = (tint: string, percent: number): string =>
  `color-mix(in srgb, ${tint} ${percent}%, transparent)`;

/** Sub-1% occupancy is real and common; rounding it away reads as an empty bar. */
export const formatContextPercent = (percent: number): string =>
  percent < 1 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
