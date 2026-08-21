// FILE: factoryTraceTimeline.ts
// Purpose: Project a factory session's trace into per-worker swim lanes on a
// shared time axis -- who worked when, for how long, and what they did inside.
// Layer: shared domain logic
//
// The lane model is the factory's own: a phase's `kind` plus `owner` *is* the
// lane, so the engineer, each deterministic code step, and each agent stay
// visually separate. That separation is the point of the trace -- an agent phase
// and a `bun test` phase are different kinds of claim, and a picture that mixed
// them would hide which one failed.
//
// Two rules from the trace itself carry through here:
//
//   1. Nothing is stored. Durations, positions, and lane membership are derived
//      from timestamps on every render, so the picture cannot disagree with the
//      rows it came from.
//   2. Layout never invents time. Positions come from `started_at`/`ended_at`
//      only; the sole cosmetic liberty is a minimum block width, and it is
//      confined to the lane it happens in so two lanes at the same x stay
//      comparable.

import type {
  TraceAgentSession,
  TraceEvent,
  TracePhase,
  TracePhaseKind,
  TracePhaseStatus,
} from "@vulcan/contracts";

export interface FactoryTraceLane {
  /** `kind:owner`, e.g. `agent:builder`. */
  readonly id: string;
  /** The worker's name as the factory knows it. */
  readonly label: string;
  readonly kind: TracePhaseKind;
  /** The model this worker ran on, when the trace recorded one. */
  readonly model: string | null;
  /** The lane swatch the factory's own config declared, if any. */
  readonly color: string | null;
  /** Window occupancy after the worker's last turn. Null while it is running. */
  readonly context: FactoryTraceContext | null;
  /** Phases with a start time, left to right. */
  readonly blocks: readonly FactoryTraceBlock[];
  /** Declared phases this worker has not entered yet. */
  readonly pending: readonly TracePhase[];
}

export interface FactoryTraceContext {
  readonly used: number;
  readonly window: number;
  /** 0-100. Kept unrounded; the label decides how to show a sub-1% figure. */
  readonly percent: number;
}

/** A tool call inside a block, placed within that block's own span. */
export interface FactoryTraceMark {
  readonly eventId: string;
  readonly xPct: number;
  readonly failed: boolean;
}

export interface FactoryTraceBlock {
  readonly key: string;
  readonly phase: TracePhase;
  readonly startMs: number;
  /** Now for a running phase; its start for one that ended without a time. */
  readonly endMs: number;
  readonly durationMs: number;
  readonly leftPct: number;
  readonly widthPct: number;
  readonly marks: readonly FactoryTraceMark[];
}

export interface FactoryTraceAxisTick {
  readonly pct: number;
  readonly offsetMs: number;
}

export interface FactoryTraceTimeline {
  readonly lanes: readonly FactoryTraceLane[];
  readonly startMs: number;
  readonly endMs: number;
  readonly spanMs: number;
  readonly ticks: readonly FactoryTraceAxisTick[];
  /** False when no phase has started, so the pane can say so. */
  readonly hasStarted: boolean;
}

export interface FactoryTraceTimelineInput {
  readonly phases: readonly TracePhase[];
  readonly agents: readonly TraceAgentSession[];
  readonly events: readonly TraceEvent[];
  readonly sessionStartedAt: string | null;
  readonly sessionEndedAt: string | null;
  /** Clock used to grow running phases. Passed in so the projection is pure. */
  readonly nowMs: number;
  readonly minBlockPct?: number;
  readonly maxTicks?: number;
}

const DEFAULT_MIN_BLOCK_PCT = 2.5;
const MIN_SPAN_MS = 1_000;
/** A hair of right margin, so a block running to the end still shows its border. */
const TRACK_MARGIN_PCT = 0.5;

const LANE_GROUP: Record<TracePhaseKind, number> = { engineer: 0, code: 1, agent: 2 };

const parseTime = (value: string | null): number =>
  value === null ? Number.NaN : Date.parse(value);

/** The lane a phase belongs to. `kind` plus `owner` is the worker's identity. */
export const laneIdFor = (phase: TracePhase): string =>
  `${phase.kind ?? "code"}:${phase.owner ?? phase.kind ?? "unknown"}`;

/**
 * Occupancy for an agent lane, or null unless both numbers are real.
 *
 * A bar against an unknown ceiling would be decoration rather than data, which
 * is why a running agent shows nothing instead of an empty bar.
 */
function contextOf(agent: TraceAgentSession | undefined): FactoryTraceContext | null {
  const used = agent?.contextTokens ?? 0;
  const window = agent?.contextWindow ?? 0;
  if (used === 0 || window === 0) return null;
  return { used, window, percent: Math.min(100, (used / window) * 100) };
}

/**
 * Every lane, laid out against one axis.
 *
 * Phases are the unit: a phase retried after a failed gate is one block per
 * attempt row the factory wrote, so the cost of a correction reads as time
 * spent rather than as a number tucked in a corner.
 */
export function buildFactoryTraceTimeline(input: FactoryTraceTimelineInput): FactoryTraceTimeline {
  const { nowMs } = input;
  const minBlockPct = input.minBlockPct ?? DEFAULT_MIN_BLOCK_PCT;

  const marksByPhase = groupToolCalls(input.events);

  interface Draft {
    readonly id: string;
    readonly label: string;
    readonly kind: TracePhaseKind;
    readonly order: number;
    readonly timed: { phase: TracePhase; startMs: number; endMs: number }[];
    readonly pending: TracePhase[];
  }

  const drafts = new Map<string, Draft>();
  for (const phase of input.phases) {
    const id = laneIdFor(phase);
    let draft = drafts.get(id);
    if (!draft) {
      draft = {
        id,
        label: phase.owner ?? phase.kind ?? "unknown",
        kind: phase.kind ?? "code",
        order: drafts.size,
        timed: [],
        pending: [],
      };
      drafts.set(id, draft);
    }

    const startMs = parseTime(phase.startedAt);
    if (Number.isFinite(startMs)) {
      draft.timed.push({ phase, startMs, endMs: resolveEndMs(phase, startMs, nowMs) });
    } else {
      draft.pending.push(phase);
    }
  }

  const timed = [...drafts.values()].flatMap((draft) => draft.timed);
  const hasStarted = timed.length > 0;

  const sessionStart = parseTime(input.sessionStartedAt);
  const startMs = Math.min(
    ...[sessionStart, ...timed.map((block) => block.startMs)].filter((value) =>
      Number.isFinite(value),
    ),
    // Falls back to the clock so a session with nothing started still has an axis.
    nowMs,
  );
  const sessionEnd = parseTime(input.sessionEndedAt);
  const endMs = Math.max(
    ...timed.map((block) => block.endMs),
    Number.isFinite(sessionEnd) ? sessionEnd : nowMs,
    startMs + MIN_SPAN_MS,
  );
  const spanMs = endMs - startMs;
  const available = 100 - TRACK_MARGIN_PCT;

  const lanes = [...drafts.values()]
    .toSorted(
      (left, right) => LANE_GROUP[left.kind] - LANE_GROUP[right.kind] || left.order - right.order,
    )
    .map((draft): FactoryTraceLane => {
      const agent = input.agents.find((candidate) => candidate.agent === draft.label);
      const ordered = draft.timed.toSorted((left, right) => left.startMs - right.startMs);
      const blocks: FactoryTraceBlock[] = [];
      let previousEdge = 0;

      for (const item of ordered) {
        const width = Math.max(((item.endMs - item.startMs) / spanMs) * available, minBlockPct);
        // Widening a near-instant block must not park it on top of the one
        // before it, so it slides right inside its own lane only. Lanes never
        // borrow space from each other, which is what keeps two lanes at the
        // same x comparable.
        const ideal = Math.max(((item.startMs - startMs) / spanMs) * available, previousEdge);
        // Pull a block back inside the track so one running to the end still
        // shows its border -- but never past `previousEdge`, or the pull would
        // land it on top of its neighbour. When a lane is too crowded to hold
        // every block, an honest overflow (the track clips it) beats an overlap
        // that hides which block is which and steals the other's clicks.
        const left = Math.min(ideal, Math.max(available - width, previousEdge));
        previousEdge = left + width;
        blocks.push({
          key: item.phase.phaseId,
          phase: item.phase,
          startMs: item.startMs,
          endMs: item.endMs,
          durationMs: item.endMs - item.startMs,
          leftPct: left,
          widthPct: width,
          marks: placeMarks(marksByPhase.get(item.phase.phaseId) ?? [], item.startMs, item.endMs),
        });
      }

      return {
        id: draft.id,
        label: draft.label,
        kind: draft.kind,
        model: agent?.model ?? null,
        color: agent?.color ?? null,
        context: contextOf(agent),
        blocks,
        pending: draft.pending,
      };
    });

  return {
    lanes,
    startMs,
    endMs,
    spanMs,
    ticks: buildAxisTicks(spanMs, input.maxTicks ?? 6),
    hasStarted,
  };
}

/**
 * When a block stops.
 *
 * A running phase grows to the clock so its block widens while it works. A phase
 * that ended without recording a time gets zero duration rather than an invented
 * one: stretching it to now would claim work that may never have happened.
 */
function resolveEndMs(phase: TracePhase, startMs: number, nowMs: number): number {
  const ended = parseTime(phase.endedAt);
  if (Number.isFinite(ended)) return Math.max(ended, startMs);
  return phase.status === "running" ? Math.max(nowMs, startMs) : startMs;
}

/**
 * Tool calls, per phase.
 *
 * A `tool_call` is the one event that spans time, and its own row carries the
 * real start, so nothing here parses `payload_json` for layout. The payload is
 * read for exactly one thing: whether the call failed.
 */
function groupToolCalls(events: readonly TraceEvent[]): Map<string, TraceEvent[]> {
  const byPhase = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (event.type !== "tool_call" || event.phaseId === null) continue;
    const bucket = byPhase.get(event.phaseId);
    if (bucket) bucket.push(event);
    else byPhase.set(event.phaseId, [event]);
  }
  return byPhase;
}

/** `ok: false` marks a tool error; a payload without the key predates it and counts as fine. */
export function toolCallFailed(payloadJson: string | null): boolean {
  if (payloadJson === null) return false;
  try {
    const payload = JSON.parse(payloadJson) as { ok?: unknown };
    return (
      payload !== null && typeof payload === "object" && "ok" in payload && payload.ok === false
    );
  } catch {
    return false;
  }
}

function placeMarks(
  events: readonly TraceEvent[],
  startMs: number,
  endMs: number,
): FactoryTraceMark[] {
  const span = Math.max(endMs - startMs, 1);
  return events
    .map((event) => ({ event, at: parseTime(event.startedAt) }))
    .filter((item) => Number.isFinite(item.at))
    .toSorted((left, right) => left.at - right.at)
    .map(({ event, at }) => ({
      eventId: event.eventId,
      // Clamped inside the block: a call recorded a beat after the phase closed
      // still belongs to it and must not float off the end.
      xPct: Math.min(Math.max(((at - startMs) / span) * 100, 2), 98),
      failed: toolCallFailed(event.payloadJson),
    }));
}

const TICK_STEPS_MS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1_800, 3_600, 7_200, 21_600,
].map((seconds) => seconds * 1_000);

/** Evenly stepped offsets across the axis, dividing it at most `maxTicks` ways. */
export function buildAxisTicks(spanMs: number, maxTicks: number): FactoryTraceAxisTick[] {
  const span = Math.max(spanMs, 1);
  const step = TICK_STEPS_MS.find((candidate) => span / candidate <= maxTicks) ?? span;
  const ticks: FactoryTraceAxisTick[] = [];
  for (let offset = 0; offset <= span; offset += step) {
    ticks.push({ pct: (offset / span) * 100, offsetMs: offset });
  }
  return ticks;
}

/**
 * How far through its declared phases a session is.
 *
 * Counted rather than stored, and `queued` phases count in the denominator so a
 * session that has not started reads as 0 of its real size rather than 0 of 0.
 */
export function countPhaseProgress(phases: readonly TracePhase[]): {
  readonly done: number;
  readonly total: number;
} {
  const done = phases.filter((phase) => phase.status === "success").length;
  return { done, total: phases.length };
}

/** Statuses that mean a phase can still change. */
export const isPhaseSettled = (status: TracePhaseStatus | null): boolean =>
  status === "success" || status === "fail";
