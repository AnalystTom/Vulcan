// FILE: FactoryRunStrip.tsx
// Purpose: The one-line answer to "what is this session and how is it going" --
// the request, its state, and the totals an operator checks before looking closer.
// Layer: Workspace UI
//
// Every number here is counted from the run's own facts. Nothing that the run
// does not record is shown: a strip with an empty cost or token field would
// suggest the factory is measuring something it is not.

import type { FactoryRunDetail, WorkflowRunState } from "@vulcan/contracts";
import { buildFactoryActivityBoard } from "@vulcan/shared/workItemProjection";
import { IconAlertTriangle, IconClock, IconGitCommit, IconStack2 } from "@tabler/icons-react";
import { type ReactNode, useMemo } from "react";

import { formatClockDuration } from "~/session-logic";
import { cn } from "~/lib/utils";

import { useLiveClock } from "./useLiveClock";

const RUN_STATE_TONE: Record<WorkflowRunState, string> = {
  pending: "border-border text-muted-foreground",
  running: "border-sky-500/40 text-sky-600 dark:text-sky-400",
  blocked: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  succeeded: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  failed: "border-red-500/40 text-red-600 dark:text-red-400",
  cancelled: "border-border text-muted-foreground",
};

export function FactoryRunStrip({ detail }: { readonly detail: FactoryRunDetail }) {
  const endedAtMs = detail.run.endedAt === null ? null : Date.parse(detail.run.endedAt);
  const nowMs = useLiveClock(endedAtMs === null);
  const startedAtMs = Date.parse(detail.run.createdAt);
  const elapsedMs = (endedAtMs ?? nowMs) - startedAtMs;

  const board = useMemo(
    () =>
      buildFactoryActivityBoard({
        definition: detail.definition,
        attempts: detail.attempts,
        artifacts: detail.artifacts,
        gateResults: detail.gateResults,
        currentRevision: detail.currentRevision,
      }),
    [detail],
  );
  const openAttention = detail.attentionItems.filter((item) => item.resolvedAt === null).length;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-xs font-medium" title={detail.definition.name}>
        {detail.definition.description || detail.definition.name}
      </span>

      <span
        className={cn(
          "shrink-0 rounded border px-1.5 py-0.5 text-[10px]",
          RUN_STATE_TONE[detail.run.state],
        )}
      >
        {detail.run.state}
      </span>

      <Stat icon={<IconClock className="size-3" aria-hidden />} title="Elapsed">
        {formatClockDuration(Math.max(elapsedMs, 0))}
      </Stat>
      <Stat icon={<IconStack2 className="size-3" aria-hidden />} title="Nodes complete">
        {board.complete.length}/{detail.definition.nodes.length}
      </Stat>
      {/* The revision every verdict in this session is judged against. */}
      <Stat icon={<IconGitCommit className="size-3" aria-hidden />} title="Current revision" mono>
        {detail.currentRevision.slice(0, 7)}
      </Stat>
      {openAttention > 0 ? (
        <Stat
          icon={<IconAlertTriangle className="size-3" aria-hidden />}
          title="Decisions waiting on you"
          tone="text-amber-600 dark:text-amber-400"
        >
          {openAttention}
        </Stat>
      ) : null}
    </div>
  );
}

function Stat({
  icon,
  title,
  mono,
  tone,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly mono?: boolean;
  readonly tone?: string;
  readonly children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px]",
        mono && "font-mono",
        tone ?? "text-muted-foreground",
      )}
    >
      {icon}
      {children}
    </span>
  );
}
