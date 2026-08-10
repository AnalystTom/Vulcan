// FILE: factoryLaneTheme.ts
// Purpose: How a Factory lane and a node status look -- tint, icon, glyph, wording.
// Layer: Workspace UI
//
// Every surface that shows factory state (the session timeline, the node detail,
// the activity counts) reads its colour and wording from here, so a status that
// is amber in one place is never green in another.
//
// The tints are CSS variables rather than Tailwind classes because a lane's hue
// is data-driven: agent lanes take the next tint in the cycle, which no static
// class list can express.

import {
  IconBrowser,
  IconRobot,
  IconShieldCheck,
  IconTerminal2,
  IconUser,
  type IconProps,
} from "@tabler/icons-react";
import type { FactoryLane, FactoryLaneKind } from "@vulcan/shared/factoryTimeline";
import type { FactoryNodeStatus } from "@vulcan/shared/workItemProjection";
import type { ComponentType } from "react";

export const STATUS_LABEL: Record<FactoryNodeStatus, string> = {
  "not-started": "Not started",
  "blocked-by-dependency": "Waiting on an earlier node",
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  review: "Verifying",
  failed: "Failed",
  complete: "Complete",
};

export const STATUS_TONE: Record<FactoryNodeStatus, string> = {
  "not-started": "text-muted-foreground",
  "blocked-by-dependency": "text-muted-foreground",
  queued: "text-sky-600 dark:text-sky-400",
  running: "text-sky-600 dark:text-sky-400",
  waiting: "text-amber-600 dark:text-amber-400",
  review: "text-violet-600 dark:text-violet-400",
  failed: "text-red-600 dark:text-red-400",
  complete: "text-emerald-600 dark:text-emerald-400",
};

/** A single character, so a status survives a block squeezed to its minimum width. */
export const STATUS_GLYPH: Record<FactoryNodeStatus, string> = {
  "not-started": "○",
  "blocked-by-dependency": "·",
  queued: "○",
  running: "●",
  waiting: "◑",
  review: "◆",
  failed: "✗",
  complete: "✓",
};

export const LANE_ICON: Record<FactoryLaneKind, ComponentType<IconProps>> = {
  operator: IconUser,
  workspace: IconTerminal2,
  browser: IconBrowser,
  agent: IconRobot,
  gate: IconShieldCheck,
};

const AGENT_TINTS = [
  "var(--factory-lane-agent-1)",
  "var(--factory-lane-agent-2)",
  "var(--factory-lane-agent-3)",
  "var(--factory-lane-agent-4)",
] as const;

const FIXED_TINTS: Partial<Record<FactoryLaneKind, string>> = {
  operator: "var(--factory-lane-operator)",
  workspace: "var(--factory-lane-workspace)",
  browser: "var(--factory-lane-browser)",
  gate: "var(--factory-lane-gate)",
};

/**
 * One tint per lane, keyed by lane id.
 *
 * Assigned over the whole set rather than per lane so agent tints cycle in lane
 * order and stay stable while a run adds lanes underneath the ones already on
 * screen -- a lane that changed colour mid-run would read as a different worker.
 */
export function buildLaneTints(lanes: readonly FactoryLane[]): Map<string, string> {
  const tints = new Map<string, string>();
  let agentIndex = 0;
  for (const lane of lanes) {
    const fixed = FIXED_TINTS[lane.kind];
    if (fixed) {
      tints.set(lane.id, fixed);
      continue;
    }
    tints.set(lane.id, AGENT_TINTS[agentIndex % AGENT_TINTS.length] as string);
    agentIndex += 1;
  }
  return tints;
}

/** Tint at an alpha, for fills and borders that must not compete with the copy. */
export const laneTintAlpha = (tint: string, percent: number): string =>
  `color-mix(in srgb, ${tint} ${percent}%, transparent)`;
