// FILE: ActiveAgentPanel.logic.ts
// Purpose: Pure view-model builder for the sidebar's live agent panel.
// Exports: active-agent filtering, ordering, and lightweight presentation helpers.

import type { ProjectId, ThreadId } from "@vulcan/contracts";

import { isThreadActivelyWorking, resolveThreadProjectLabel } from "./Sidebar.logic";
import type { Project, SidebarThreadSummary, ThreadSession } from "../types";

export type ActiveAgentState = "working" | "connecting";

export interface ActiveAgentViewModel {
  thread: SidebarThreadSummary;
  projectLabel: string;
  state: ActiveAgentState;
  updatedAtMs: number;
}

export function isActiveAgentThread(
  thread: Pick<
    SidebarThreadSummary,
    "archivedAt" | "hasLiveTailWork" | "latestTurn" | "parentThreadId" | "session"
  >,
): boolean {
  if (thread.archivedAt != null) return false;
  if (thread.parentThreadId) return false;
  return isThreadActivelyWorking(thread) || thread.session?.status === "connecting";
}

function parseTimestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function resolveActiveAgentState(
  thread: Pick<SidebarThreadSummary, "hasLiveTailWork" | "latestTurn" | "session">,
): ActiveAgentState {
  return isThreadActivelyWorking(thread) ? "working" : "connecting";
}

function resolveActiveAgentUpdatedAtMs(
  thread: Pick<SidebarThreadSummary, "latestTurn" | "session" | "updatedAt" | "createdAt">,
): number {
  return Math.max(
    parseTimestampMs(thread.latestTurn?.startedAt),
    parseTimestampMs(thread.latestTurn?.requestedAt),
    parseTimestampMs(thread.session?.updatedAt),
    parseTimestampMs(thread.updatedAt),
    parseTimestampMs(thread.createdAt),
  );
}

export function buildActiveAgentViewModel(input: {
  threads: readonly SidebarThreadSummary[];
  projectById: ReadonlyMap<ProjectId, Project>;
}): ActiveAgentViewModel[] {
  return input.threads
    .filter(isActiveAgentThread)
    .map((thread) => ({
      thread,
      projectLabel: resolveThreadProjectLabel(input.projectById.get(thread.projectId)),
      state: resolveActiveAgentState(thread),
      updatedAtMs: resolveActiveAgentUpdatedAtMs(thread),
    }))
    .toSorted((left, right) => {
      const timestampDelta = right.updatedAtMs - left.updatedAtMs;
      if (timestampDelta !== 0) return timestampDelta;
      return left.thread.id.localeCompare(right.thread.id);
    });
}

export function activeAgentAriaLabel(agentCount: number): string {
  return `${agentCount} active ${agentCount === 1 ? "agent" : "agents"}`;
}

export function activeAgentStatusLabel(input: {
  state: ActiveAgentState;
  session: ThreadSession | null;
}): string {
  if (input.state === "connecting") return "Connecting";
  return input.session?.activeTurnId ? "Working" : "Live";
}

export function collectActiveAgentThreadIds(
  agents: readonly Pick<ActiveAgentViewModel, "thread">[],
): ThreadId[] {
  return agents.map((agent) => agent.thread.id);
}
