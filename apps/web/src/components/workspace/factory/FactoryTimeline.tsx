// FILE: FactoryTimeline.tsx
// Purpose: The Factory session timeline -- one swimlane per worker on a shared
// time axis, showing who worked when, for how long, and what they produced.
// Layer: Workspace UI
//
// A run is concurrent, and a list cannot show concurrency. Lanes can: at any x
// the operator reads what every worker was doing at that instant, which is the
// question being asked while a run is live ("what is the builder doing while the
// reviewer waits?") and the one a waterfall list answers worst.
//
// Nothing here decides state. Lanes, spans, and positions come from
// `buildFactoryTimeline` over the same raw facts the kernel's tests cover, so
// the picture cannot drift from what the kernel believes.

import type { NodeAttemptId, WorkflowNodeId } from "@vulcan/contracts";
import {
  buildFactoryTimeline,
  type FactoryLane,
  type FactoryPendingNode,
  type FactoryTimelineBlock,
} from "@vulcan/shared/factoryTimeline";
import type { RunSnapshot } from "@vulcan/shared/factoryKernel";
import { type CSSProperties, useMemo } from "react";

import { formatClockDuration } from "~/session-logic";
import { cn } from "~/lib/utils";

import { useLiveClock } from "./useLiveClock";

import {
  buildLaneTints,
  LANE_ICON,
  laneTintAlpha,
  STATUS_GLYPH,
  STATUS_LABEL,
  STATUS_TONE,
} from "./factoryLaneTheme";

/** Identifies the block or node whose evidence is open below the timeline. */
export interface FactorySelection {
  readonly key: string;
  readonly nodeId: WorkflowNodeId;
  readonly attemptId: NodeAttemptId | null;
}

export interface FactoryTimelineProps {
  readonly snapshot: RunSnapshot;
  readonly runStartedAtMs: number | null;
  readonly runEndedAtMs: number | null;
  readonly selection: FactorySelection | null;
  readonly onSelect: (selection: FactorySelection | null) => void;
}

/** Lane label column. Wide enough for a worker name plus its progress bar. */
const LANE_GRID = "grid grid-cols-[9.5rem_minmax(0,1fr)]";
/** Track height, sized so a block fits a title, a description, and its marks. */
const TRACK_CLASS = "relative h-[4.75rem] overflow-hidden";
const BLOCK_CLASS =
  "absolute top-2 flex h-[3.5rem] flex-col gap-0.5 overflow-hidden rounded-md border px-1.5 py-1 text-left transition-shadow";

export function FactoryTimeline({
  snapshot,
  runStartedAtMs,
  runEndedAtMs,
  selection,
  onSelect,
}: FactoryTimelineProps) {
  // A live run's blocks have to grow, and the pane's own poll is too slow to
  // read as motion. A finished run never re-renders for the clock.
  const isLive = runEndedAtMs === null;
  const nowMs = useLiveClock(isLive);

  const timeline = useMemo(
    () =>
      buildFactoryTimeline(snapshot, {
        nowMs,
        runStartedAtMs,
        runEndedAtMs,
      }),
    [snapshot, nowMs, runStartedAtMs, runEndedAtMs],
  );
  const tints = useMemo(() => buildLaneTints(timeline.lanes), [timeline.lanes]);

  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-border">
      <div className={cn(LANE_GRID, "border-b border-border bg-muted/40")}>
        <div className="truncate border-r border-border px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          {timeline.hasStarted ? "workers" : "planned workers"}
        </div>
        <div className="relative h-6">
          {timeline.ticks.map((tick) => (
            <span
              key={tick.offsetMs}
              className={cn(
                "absolute bottom-1 font-mono text-[10px] text-muted-foreground",
                // The end labels are pulled inside the track; centering them on
                // their own gridline would clip them against the pane's edge.
                tick.pct <= 1
                  ? "translate-x-0"
                  : tick.pct >= 99
                    ? "-translate-x-full"
                    : "-translate-x-1/2",
              )}
              style={{ left: `${tick.pct}%` }}
            >
              {formatClockDuration(tick.offsetMs)}
            </span>
          ))}
        </div>
      </div>

      {timeline.lanes.map((lane) => (
        <LaneRow
          key={lane.id}
          lane={lane}
          tint={tints.get(lane.id) ?? "var(--muted-foreground)"}
          tickPcts={timeline.ticks.map((tick) => tick.pct)}
          selection={selection}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function LaneRow({
  lane,
  tint,
  tickPcts,
  selection,
  onSelect,
}: {
  readonly lane: FactoryLane;
  readonly tint: string;
  readonly tickPcts: readonly number[];
  readonly selection: FactorySelection | null;
  readonly onSelect: (selection: FactorySelection | null) => void;
}) {
  const Icon = LANE_ICON[lane.kind];
  const nodeIds = new Set([
    ...lane.blocks.map((block) => block.node.id),
    ...lane.pending.map((item) => item.node.id),
  ]);
  const completedNodeIds = new Set(
    lane.blocks.filter((block) => block.status === "complete").map((block) => block.node.id),
  );
  const donePct = nodeIds.size === 0 ? 0 : (completedNodeIds.size / nodeIds.size) * 100;

  return (
    <div className={cn(LANE_GRID, "border-b border-border/60 last:border-b-0")}>
      <div className="flex min-w-0 flex-col justify-center gap-1 border-r border-border/60 px-2 py-2">
        <span
          className="flex min-w-0 items-center gap-1.5 text-xs font-medium"
          style={{ color: tint }}
        >
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{lane.label}</span>
        </span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">{lane.meta}</span>
        {/* Nodes done in this lane. It occupies the slot a context gauge would,
            and says something the run actually knows. */}
        <span className="flex items-center gap-1.5">
          <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full transition-[width] duration-220 ease-out motion-reduce:transition-none"
              style={{ width: `${donePct}%`, background: tint }}
            />
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {completedNodeIds.size}/{nodeIds.size}
          </span>
        </span>
      </div>

      <div className={TRACK_CLASS}>
        {tickPcts.map((pct) => (
          <span
            key={pct}
            className="absolute inset-y-0 border-l border-dashed border-border/70"
            style={{ left: `${pct}%` }}
          />
        ))}

        {lane.blocks.map((block) => (
          <TimelineBlock
            key={block.key}
            block={block}
            tint={tint}
            selected={selection?.key === block.key}
            onSelect={onSelect}
          />
        ))}

        <PendingStack pending={lane.pending} selection={selection} onSelect={onSelect} />
      </div>
    </div>
  );
}

function TimelineBlock({
  block,
  tint,
  selected,
  onSelect,
}: {
  readonly block: FactoryTimelineBlock;
  readonly tint: string;
  readonly selected: boolean;
  readonly onSelect: (selection: FactorySelection | null) => void;
}) {
  const failed = block.status === "failed";
  return (
    <button
      type="button"
      title={`${block.node.title} — ${STATUS_LABEL[block.status]}\n${block.description}`}
      aria-pressed={selected}
      onClick={() =>
        onSelect(
          selected ? null : { key: block.key, nodeId: block.node.id, attemptId: block.attempt.id },
        )
      }
      className={cn(
        BLOCK_CLASS,
        "hover:shadow-[0_0_0_1px_var(--lane-glow)]",
        selected && "ring-2 ring-ring",
        block.status === "running" && "animate-pulse motion-reduce:animate-none",
      )}
      style={
        {
          left: `${block.leftPct}%`,
          width: `${block.widthPct}%`,
          background: `linear-gradient(180deg, ${laneTintAlpha(tint, 18)}, ${laneTintAlpha(tint, 6)})`,
          borderColor: failed ? "var(--status-failure)" : laneTintAlpha(tint, 45),
          "--lane-glow": laneTintAlpha(tint, 55),
        } as CSSProperties
      }
    >
      <span className="flex min-w-0 items-baseline gap-1">
        <span className={cn("shrink-0 text-[10px] leading-none", STATUS_TONE[block.status])}>
          {STATUS_GLYPH[block.status]}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{block.node.title}</span>
        {/* Which trip round the loop this is; only shown once there is a loop. */}
        {block.attemptCount > 1 ? (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            #{block.attempt.attemptNumber}
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {formatClockDuration(block.durationMs)}
        </span>
      </span>
      <span className="min-w-0 truncate text-[10px] text-muted-foreground">
        {block.description}
      </span>
      {block.marks.map((mark) => (
        <span
          key={mark.artifactId}
          className="absolute bottom-1 h-1.5 w-0.5 rounded-[1px]"
          style={{
            left: `${mark.xPct}%`,
            background: mark.failed ? "var(--status-failure)" : tint,
            opacity: mark.failed ? 1 : 0.7,
          }}
        />
      ))}
    </button>
  );
}

/**
 * Work this lane has not started, fanned against the right edge.
 *
 * Shown rather than hidden: an operator has to be able to see the intended
 * factory before it executes. It sits outside the time axis because a node that
 * has not started has no time to be placed at.
 */
function PendingStack({
  pending,
  selection,
  onSelect,
}: {
  readonly pending: readonly FactoryPendingNode[];
  readonly selection: FactorySelection | null;
  readonly onSelect: (selection: FactorySelection | null) => void;
}) {
  const visible = pending.slice(0, 3);
  return (
    <>
      {visible.map((item, index) => {
        const selected = selection?.key === item.key;
        return (
          <button
            key={item.key}
            type="button"
            title={`${item.node.title} — ${STATUS_LABEL[item.status]}\n${item.description}`}
            aria-pressed={selected}
            onClick={() =>
              onSelect(selected ? null : { key: item.key, nodeId: item.node.id, attemptId: null })
            }
            className={cn(
              BLOCK_CLASS,
              "w-[7.5rem] border-dashed border-border bg-transparent text-muted-foreground",
              selected && "ring-2 ring-ring",
            )}
            style={{ right: `${0.375 + index * 0.75}rem`, zIndex: visible.length - index }}
          >
            <span className="flex min-w-0 items-baseline gap-1">
              <span className="shrink-0 text-[10px] leading-none">{STATUS_GLYPH[item.status]}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                {item.node.title}
              </span>
            </span>
            <span className="min-w-0 truncate text-[10px]">{STATUS_LABEL[item.status]}</span>
          </button>
        );
      })}
      {pending.length > visible.length ? (
        <span
          className="absolute bottom-2 right-1.5 font-mono text-[10px] text-muted-foreground"
          style={{ zIndex: 0 }}
        >
          +{pending.length - visible.length}
        </span>
      ) : null}
    </>
  );
}
