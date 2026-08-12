// FILE: factoryTrace.ts
// Purpose: The trace a software factory emits -- sessions, phases, events,
// envelopes, gate results, and agent sessions -- as Vulcan reads them.
// Layer: contract (schema only; the reader lives in apps/server/src/factoryTrace)
//
// This mirrors the Super Simple Software Factory's SQLite schema one table at a
// time (https://github.com/disler/super-simple-software-factory, MIT). Vulcan
// does not own the factory: an ADW process writes the trace while it works, and
// Vulcan reads it. Modelling their rows exactly is what keeps that honest -- a
// shape of our own invention here would mean a translation layer that can lie
// about what actually happened.
//
// Three of their rules are load bearing for everything downstream:
//
//   1. Nothing here is derived state. Phase durations, lane layout, and session
//      progress are computed where they are shown, never stored, so the trace
//      and the picture cannot drift apart.
//   2. A phase's `kind` plus `owner` *is* the lane. Three kinds -- engineer,
//      code, agent -- keep the human, the deterministic step, and the judgment
//      visually separate, which is the whole point of the swim lanes.
//   3. Success is earned. A phase defaults to `fail`; only a clean exit with a
//      parsed envelope and green gates makes it `success`.

import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

/** The run id an ADW mints, e.g. `d140d7dd`. Their `adw_id`. */
export const AdwId = TrimmedNonEmptyString.check(Schema.isMaxLength(120)).pipe(
  Schema.brand("AdwId"),
);
export type AdwId = typeof AdwId.Type;

export const PhaseId = TrimmedNonEmptyString.check(Schema.isMaxLength(200)).pipe(
  Schema.brand("PhaseId"),
);
export type PhaseId = typeof PhaseId.Type;

/** A run is running until it earns success. */
export const TraceSessionStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "success",
  "fail",
]);
export type TraceSessionStatus = typeof TraceSessionStatus.Type;

/** `queued` is only for declared phases not yet entered -- drawn dashed. */
export const TracePhaseStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "failed",
  "success",
  "fail",
]);
export type TracePhaseStatus = typeof TracePhaseStatus.Type;

/**
 * Which lane a phase draws in.
 *
 * `engineer` is the human, `code` is a deterministic step that stands on its own
 * (a commit, a test command), and `agent` is a bounded call with an envelope and
 * gates. A code step is never buried inside an agent phase, so the trace can say
 * exactly when code ran and when an agent was thinking.
 */
export const TracePhaseKind = Schema.Literals(["engineer", "code", "agent"]);
export type TracePhaseKind = typeof TracePhaseKind.Type;

/** The ten event types their tracer emits. */
export const TraceEventType = Schema.Literals([
  "phase_start",
  "phase_end",
  "agent_start",
  "agent_end",
  "tool_call",
  "handoff",
  "gate_pass",
  "gate_fail",
  "log",
  "error",
]);
export type TraceEventType = typeof TraceEventType.Type;

export const TraceSession = Schema.Struct({
  adwId: AdwId,
  /** The ADW script(s) that ran this session, e.g. `adw_plan + adw_build_test`. */
  adwName: Schema.NullOr(Schema.String),
  /** The engineer's ask, verbatim. */
  request: Schema.NullOr(Schema.String),
  status: Schema.NullOr(TraceSessionStatus),
  engineer: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  /** Billed tokens across the run: every turn, including re-read cache. */
  totalTokens: Schema.NullOr(NonNegativeInt),
  totalCost: Schema.NullOr(Schema.Number),
  /** Review triage -- a human has looked at this run. Not run state. */
  archived: Schema.Boolean,
});
export type TraceSession = typeof TraceSession.Type;

export const TracePhase = Schema.Struct({
  phaseId: PhaseId,
  adwId: AdwId,
  seq: Schema.NullOr(NonNegativeInt),
  name: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(TracePhaseKind),
  /** The worker: an agent name, `git`, or the engineer. With `kind`, the lane. */
  owner: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  status: Schema.NullOr(TracePhaseStatus),
  attempt: Schema.NullOr(NonNegativeInt),
  retries: Schema.NullOr(NonNegativeInt),
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
});
export type TracePhase = typeof TracePhase.Type;

export const TraceEvent = Schema.Struct({
  /** The SQLite rowid: monotonic, insertion-ordered, and the polling cursor. */
  rowid: NonNegativeInt,
  eventId: Schema.String,
  adwId: AdwId,
  phaseId: Schema.NullOr(PhaseId),
  /** Span nesting, so an agent phase expands into its tool calls. */
  parentId: Schema.NullOr(Schema.String),
  type: Schema.NullOr(TraceEventType),
  name: Schema.NullOr(Schema.String),
  /** Raw JSON as the tracer wrote it. Parsed at the point of display. */
  payloadJson: Schema.NullOr(Schema.String),
  tokens: Schema.NullOr(NonNegativeInt),
  startedAt: Schema.NullOr(IsoDateTime),
  /** Only a `tool_call` spans time; every other type leaves this null. */
  endedAt: Schema.NullOr(IsoDateTime),
});
export type TraceEvent = typeof TraceEvent.Type;

export const TraceEnvelope = Schema.Struct({
  envelopeId: Schema.String,
  adwId: AdwId,
  phaseId: Schema.NullOr(PhaseId),
  agent: Schema.NullOr(Schema.String),
  /** The type the agent's final JSON was parsed against. */
  outputType: Schema.NullOr(Schema.String),
  payloadJson: Schema.NullOr(Schema.String),
  valid: Schema.Boolean,
  attempt: Schema.NullOr(NonNegativeInt),
  createdAt: Schema.NullOr(IsoDateTime),
});
export type TraceEnvelope = typeof TraceEnvelope.Type;

/** One item a gate inspected. Evidence, so a green gate can say what it verified. */
export const TraceGateCheck = Schema.Struct({
  item: Schema.String,
  ok: Schema.Boolean,
  note: Schema.String,
});
export type TraceGateCheck = typeof TraceGateCheck.Type;

export const TraceGateResult = Schema.Struct({
  id: NonNegativeInt,
  adwId: AdwId,
  phaseId: Schema.NullOr(PhaseId),
  attempt: Schema.NullOr(NonNegativeInt),
  gate: Schema.NullOr(Schema.String),
  passed: Schema.Boolean,
  violations: Schema.Array(Schema.String),
  /**
   * Null means the trace predates recorded evidence -- "nothing was written
   * down", never "nothing was checked".
   */
  checks: Schema.NullOr(Schema.Array(TraceGateCheck)),
  createdAt: Schema.NullOr(IsoDateTime),
});
export type TraceGateResult = typeof TraceGateResult.Type;

/**
 * One agent under a session: which model it ran on and how full its context got.
 *
 * `contextTokens` is occupancy, not spend -- how full the window was when the
 * agent stopped, against the model's ceiling. Both null while an agent is still
 * running, in which case the lane draws no bar rather than a misleading empty one.
 */
export const TraceAgentSession = Schema.Struct({
  adwId: AdwId,
  agent: Schema.String,
  codingAgent: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  /** The lane swatch from their config, e.g. `#a78bfa`. */
  color: Schema.NullOr(Schema.String),
  contextTokens: Schema.NullOr(NonNegativeInt),
  contextWindow: Schema.NullOr(NonNegativeInt),
  createdAt: Schema.NullOr(IsoDateTime),
  lastUsedAt: Schema.NullOr(IsoDateTime),
});
export type TraceAgentSession = typeof TraceAgentSession.Type;

/**
 * What actually moved through a session, summed per agent.
 *
 * Deliberately not the billed total, which counts every cached re-read of the
 * same context.
 */
export const TraceSessionUsage = Schema.Struct({
  /** Prompt tokens read for the first time: new input plus cache writes. */
  read: NonNegativeInt,
  /** Tokens generated, each produced exactly once. */
  written: NonNegativeInt,
});
export type TraceSessionUsage = typeof TraceSessionUsage.Type;

/** A session in the list, with enough to draw its progress without a second read. */
export const TraceSessionSummary = Schema.Struct({
  session: TraceSession,
  phases: Schema.Array(TracePhase),
  agents: Schema.Array(TraceAgentSession),
});
export type TraceSessionSummary = typeof TraceSessionSummary.Type;

/** Everything needed to draw one session's swim lanes. */
export const TraceSessionDetail = Schema.Struct({
  session: TraceSession,
  usage: TraceSessionUsage,
  phases: Schema.Array(TracePhase),
  agents: Schema.Array(TraceAgentSession),
  events: Schema.Array(TraceEvent),
  envelopes: Schema.Array(TraceEnvelope),
  gates: Schema.Array(TraceGateResult),
  /** Highest rowid returned, to feed straight back as the next cursor. */
  cursor: NonNegativeInt,
});
export type TraceSessionDetail = typeof TraceSessionDetail.Type;

/**
 * Where a trace lives and whether it can be read.
 *
 * Reported rather than assumed: a workspace with no factory stamped into it is
 * the ordinary case, and the pane has to say so plainly instead of rendering an
 * empty timeline that looks like a run with no work in it.
 */
export const TraceSourceStatus = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("ready"),
    databasePath: Schema.String,
    journalMode: Schema.String,
    sessionCount: NonNegativeInt,
  }),
  Schema.Struct({
    state: Schema.Literal("absent"),
    /** Where we looked, so the operator can point us somewhere else. */
    databasePath: Schema.String,
  }),
  Schema.Struct({
    state: Schema.Literal("unreadable"),
    databasePath: Schema.String,
    reason: Schema.String,
  }),
  /** No workspace resolved yet, so there is nowhere to look. */
  Schema.Struct({ state: Schema.Literal("no-workspace") }),
]);
export type TraceSourceStatus = typeof TraceSourceStatus.Type;
