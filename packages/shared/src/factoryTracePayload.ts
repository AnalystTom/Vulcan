// FILE: factoryTracePayload.ts
// Purpose: Read the few facts the detail panel shows out of a trace event's raw
// `payload_json` -- token usage, the model a phase spawned on, a tool call's
// summary, an error message.
// Layer: shared domain logic
//
// The trace stores payloads as opaque JSON the tracer wrote (see
// `factoryTrace.ts`), so parsing is confined here rather than smeared across the
// UI: every reader gets the same guesses about key names and the same guard
// against a payload that is missing, malformed, or shaped unlike we expect. A
// value we cannot read is null, never an invented zero -- "not recorded" and
// "recorded as nothing" are different claims and the panel says which.

import type { TraceEvent } from "@vulcan/contracts";

const asRecord = (raw: string | null): Record<string, unknown> | null => {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const asCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** What actually moved through one phase, read from its `agent_end` event(s). */
export interface FactoryPhaseUsage {
  /** Prompt tokens read for the first time: fresh input plus cache writes. */
  readonly read: number | null;
  /** Tokens the model generated. */
  readonly written: number | null;
  /** The billed total the tracer recorded on the event, if any. */
  readonly billed: number | null;
}

const hasUsage = (usage: FactoryPhaseUsage): boolean =>
  usage.read !== null || usage.written !== null || usage.billed !== null;

/**
 * Token usage for a phase, summed across its `agent_end` events, or null when
 * the trace recorded none.
 *
 * `read` mirrors the session-level split (`input + cache_write`) rather than the
 * billed total, which double-counts every cached re-read of the same context.
 * A retried phase writes one `agent_end` per attempt, so summing is what makes
 * the number the phase's whole cost rather than only its last try.
 */
export function parsePhaseUsage(events: readonly TraceEvent[]): FactoryPhaseUsage | null {
  let read: number | null = null;
  let written: number | null = null;
  let billed: number | null = null;
  const add = (accumulator: number | null, next: number | null): number | null =>
    next === null ? accumulator : (accumulator ?? 0) + next;

  for (const event of events) {
    if (event.type !== "agent_end") continue;
    const usage = asRecord(event.payloadJson)?.usage;
    const source =
      typeof usage === "object" && usage !== null ? (usage as Record<string, unknown>) : {};
    const input = asCount(source.input_tokens);
    const cacheWrite = asCount(source.cache_write_tokens);
    if (input !== null || cacheWrite !== null) read = add(read, (input ?? 0) + (cacheWrite ?? 0));
    written = add(written, asCount(source.output_tokens));
    billed = add(billed, event.tokens);
  }

  const usage: FactoryPhaseUsage = { read, written, billed };
  return hasUsage(usage) ? usage : null;
}

/** The model and provider session a phase spawned on, from its `agent_start`. */
export interface FactoryAgentSpawn {
  readonly model: string | null;
  readonly sessionId: string | null;
}

/**
 * How a phase's worker was spawned, read from its first `agent_start` event.
 *
 * The lane already shows the worker's current model; this is the model *this*
 * phase ran on, which can differ across a run, plus the provider session id that
 * ties the phase back to the underlying agent conversation.
 */
export function parseAgentSpawn(events: readonly TraceEvent[]): FactoryAgentSpawn | null {
  const start = events.find((event) => event.type === "agent_start");
  if (!start) return null;
  const payload = asRecord(start.payloadJson);
  const model = asString(payload?.model);
  const sessionId = asString(payload?.session_id);
  if (model === null && sessionId === null) return null;
  return { model, sessionId };
}

/** A tool call's parsed payload: the tool name, a one-line summary, and its verdict. */
export interface FactoryToolCall {
  readonly tool: string | null;
  readonly summary: string | null;
  /** False only when the payload explicitly recorded `ok: false`. */
  readonly failed: boolean;
}

export function parseToolCall(payloadJson: string | null): FactoryToolCall {
  const payload = asRecord(payloadJson);
  return {
    tool: asString(payload?.tool),
    summary: asString(payload?.summary),
    failed: payload !== null && "ok" in payload && payload.ok === false,
  };
}

/** The human-readable message an `error` (or failed turn) event carried. */
export function parseEventMessage(payloadJson: string | null): string | null {
  return asString(asRecord(payloadJson)?.message);
}
