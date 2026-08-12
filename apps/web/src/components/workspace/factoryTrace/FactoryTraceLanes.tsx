// FILE: FactoryTraceLanes.tsx
// Purpose: A factory session drawn as swim lanes -- one per worker, on one time
// axis, with each phase as a block and its tool calls marked inside it.
// Layer: Workspace UI
//
// A run is concurrent and a list cannot show concurrency. Lanes can: at any x
// the operator reads what every worker was doing at that instant, which is the
// question asked while a run is live and the one a list answers worst.
//
// Nothing here decides state. Lanes, spans, and positions come from
// `buildFactoryTraceTimeline` over the trace's own rows, so the picture cannot
// drift from what the factory recorded.

import type { TracePhase } from "@vulcan/contracts";
import {
  buildFactoryTraceTimeline,
  type FactoryTraceBlock,
  type FactoryTraceLane,
} from "@vulcan/shared/factoryTraceTimeline";
import { type CSSProperties, useMemo } from "react";

import { formatClockDuration } from "~/session-logic";
import { cn } from "~/lib/utils";

import {
  buildLaneTints,
  formatContextPercent,
  LANE_ICON,
  laneTintAlpha,
  PHASE_STATUS_GLYPH,
  PHASE_STATUS_LABEL,
  PHASE_STATUS_TONE,
} from "./traceTheme";
import { useLiveClock } from "./useLiveClock";

export interface FactoryTraceLanesProps {
  readonly input: Omit<Parameters<typeof buildFactoryTraceTimeline>[0], "nowMs">;
  /** True while the session can still change, which is what makes blocks grow. */
  readonly isLive: boolean;
  readonly selectedPhaseId: string | null;
  readonly onSelectPhase: (phaseId: string | null) => void;
}

/** Lane label column, wide enough for a worker, its model, and a context bar. */
const LANE_GRID = "grid grid-cols-[10.5rem_minmax(0,1fr)]";
const TRACK_CLASS = "relative h-[4.75rem] overflow-hidden";
const BLOCK_CLASS =
  "absolute top-2 flex h-[3.5rem] flex-col gap-0.5 overflow-hidden rounded-md border px-1.5 py-1 text-left transition-shadow";

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export function FactoryTraceLanes({
  input,
  isLive,
  selectedPhaseId,
  onSelectPhase,
}: FactoryTraceLanesProps) {
  // A live session's blocks have to grow, and the pane's own poll is too slow to
  // read as motion. A finished session never re-renders for the clock.
  const nowMs = useLiveClock(isLive);
  const timeline = useMemo(() => buildFactoryTraceTimeline({ ...input, nowMs }), [input, nowMs]);
  const tints = useMemo(() => buildLaneTints(timeline.lanes), [timeline.lanes]);

  if (timeline.lanes.length === 0) {
    return (
      <p className="p-4 text-center text-sm text-muted-foreground">
        This session recorded no phases.
      </p>
    );
  }

  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-border">
      <div className={cn(LANE_GRID, "border-b border-border bg-muted/40")}>
        <div className="truncate border-r border-border px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          {timeline.hasStarted ? "workers" : "declared workers"}
        </div>
        <div className="relative h-6">
          {timeline.ticks.map((tick) => (
            <span
              key={tick.offsetMs}
              className={cn(
                "absolute bottom-1 font-mono text-[10px] text-muted-foreground",
                // End labels are pulled inside the track; centring them on their
                // own gridline would clip them against the pane's edge.
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
          selectedPhaseId={selectedPhaseId}
          onSelectPhase={onSelectPhase}
        />
      ))}
    </div>
  );
}

function LaneRow({
  lane,
  tint,
  tickPcts,
  selectedPhaseId,
  onSelectPhase,
}: {
  readonly lane: FactoryTraceLane;
  readonly tint: string;
  readonly tickPcts: readonly number[];
  readonly selectedPhaseId: string | null;
  readonly onSelectPhase: (phaseId: string | null) => void;
}) {
  const Icon = LANE_ICON[lane.kind];

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
        {/* The model is the lane's whole story when the trace recorded one. */}
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {lane.model ?? lane.kind}
        </span>
        {lane.context ? (
          <span
            className="flex flex-col gap-1"
            title={`${NUMBER_FORMAT.format(lane.context.used)} of ${NUMBER_FORMAT.format(lane.context.window)} tokens used`}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                context
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {formatContextPercent(lane.context.percent)}
              </span>
            </span>
            <span className="h-1 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full transition-[width] duration-220 ease-out motion-reduce:transition-none"
                // A non-zero occupancy always shows: the exact figure rides in
                // the label, and a bar that reads empty would contradict it.
                style={{ width: `${Math.max(lane.context.percent, 2)}%`, background: tint }}
              />
            </span>
          </span>
        ) : null}
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
          <PhaseBlock
            key={block.key}
            block={block}
            tint={tint}
            selected={selectedPhaseId === block.phase.phaseId}
            onSelectPhase={onSelectPhase}
          />
        ))}

        <QueuedStack
          phases={lane.pending}
          selectedPhaseId={selectedPhaseId}
          onSelectPhase={onSelectPhase}
        />
      </div>
    </div>
  );
}

function PhaseBlock({
  block,
  tint,
  selected,
  onSelectPhase,
}: {
  readonly block: FactoryTraceBlock;
  readonly tint: string;
  readonly selected: boolean;
  readonly onSelectPhase: (phaseId: string | null) => void;
}) {
  const status = block.phase.status ?? "queued";
  return (
    <button
      type="button"
      title={`${block.phase.name ?? block.phase.phaseId} — ${PHASE_STATUS_LABEL[status]}${
        block.phase.description ? `\n${block.phase.description}` : ""
      }`}
      aria-pressed={selected}
      onClick={() => onSelectPhase(selected ? null : block.phase.phaseId)}
      className={cn(
        BLOCK_CLASS,
        "hover:shadow-[0_0_0_1px_var(--lane-glow)]",
        selected && "ring-2 ring-ring",
        status === "running" && "animate-pulse motion-reduce:animate-none",
      )}
      style={
        {
          left: `${block.leftPct}%`,
          width: `${block.widthPct}%`,
          background: `linear-gradient(180deg, ${laneTintAlpha(tint, 18)}, ${laneTintAlpha(tint, 6)})`,
          borderColor: status === "fail" ? "var(--status-failure)" : laneTintAlpha(tint, 45),
          "--lane-glow": laneTintAlpha(tint, 55),
        } as CSSProperties
      }
    >
      <span className="flex min-w-0 items-baseline gap-1">
        <span className={cn("shrink-0 text-[10px] leading-none", PHASE_STATUS_TONE[status])}>
          {PHASE_STATUS_GLYPH[status]}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
          {block.phase.name ?? block.phase.phaseId}
        </span>
        {/* Retries are the correction loop made visible. */}
        {block.phase.retries !== null && block.phase.retries > 0 ? (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            ↻{block.phase.retries}
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {formatClockDuration(block.durationMs)}
        </span>
      </span>
      <span className="min-w-0 truncate text-[10px] text-muted-foreground">
        {block.phase.description ?? ""}
      </span>
      {block.marks.map((mark) => (
        <span
          key={mark.eventId}
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
 * Phases this worker has not entered, fanned against the right edge.
 *
 * Shown rather than hidden: the factory declares its phases up front, and the
 * operator has to see the intended run before it executes. They sit outside the
 * axis because a phase that has not started has no time to be placed at.
 */
function QueuedStack({
  phases,
  selectedPhaseId,
  onSelectPhase,
}: {
  readonly phases: readonly TracePhase[];
  readonly selectedPhaseId: string | null;
  readonly onSelectPhase: (phaseId: string | null) => void;
}) {
  const visible = phases.slice(0, 3);
  return (
    <>
      {visible.map((phase, index) => {
        const selected = selectedPhaseId === phase.phaseId;
        return (
          <button
            key={phase.phaseId}
            type="button"
            title={`${phase.name ?? phase.phaseId} — queued`}
            aria-pressed={selected}
            onClick={() => onSelectPhase(selected ? null : phase.phaseId)}
            className={cn(
              BLOCK_CLASS,
              "w-[7.5rem] border-dashed border-border bg-transparent text-muted-foreground",
              selected && "ring-2 ring-ring",
            )}
            style={{ right: `${0.375 + index * 0.75}rem`, zIndex: visible.length - index }}
          >
            <span className="flex min-w-0 items-baseline gap-1">
              <span className="shrink-0 text-[10px] leading-none">○</span>
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                {phase.name ?? phase.phaseId}
              </span>
            </span>
            <span className="min-w-0 truncate text-[10px]">queued</span>
          </button>
        );
      })}
      {phases.length > visible.length ? (
        <span
          className="absolute bottom-2 right-1.5 font-mono text-[10px] text-muted-foreground"
          style={{ zIndex: 0 }}
        >
          +{phases.length - visible.length}
        </span>
      ) : null}
    </>
  );
}
