// FILE: traceMapping.ts
// Purpose: Translate provider-neutral runtime events into provider-neutral SSSF row operations.
// Layer: Server factory trace

import { createHash } from "node:crypto";

import { isToolLifecycleItemType, type ProviderRuntimeEvent } from "@vulcan/contracts";

/**
 * Who a thread belongs to, when it belongs to a bot.
 *
 * A bot task is an ordinary thread, so the trace would otherwise record the lane
 * as the provider that happened to run it -- "codex" three times over for three
 * different coworkers. The name is the lane key as well as its label, which is
 * what keeps one bot's work in one lane across a restart.
 */
export interface TraceBotIdentity {
  readonly name: string;
  /** The bot's avatar swatch, so the lane is the colour the roster shows. */
  readonly color: string | null;
}

export interface TraceThreadMetadata {
  readonly title: string | null;
  readonly request: string | null;
  readonly model: string | null;
  readonly providerSessionId: string | null;
  /** Null for an ordinary thread, and for a lookup that could not be answered. */
  readonly bot: TraceBotIdentity | null;
}

export type TraceWriteOperation =
  | {
      readonly kind: "session.ensure";
      readonly values: Record<string, string | number | null>;
    }
  | {
      readonly kind: "session.update";
      readonly values: Record<string, string | number | null>;
    }
  | {
      readonly kind: "phase.insert";
      readonly values: Record<string, string | number | null>;
    }
  | {
      readonly kind: "phase.update";
      readonly values: Record<string, string | number | null>;
    }
  | {
      readonly kind: "event.insert";
      readonly values: Record<string, string | number | null>;
    }
  | {
      readonly kind: "agent.upsert";
      readonly values: Record<string, string | number | null>;
    };

interface ThreadState {
  seq: number;
  activeTurns: Set<string>;
  model: string | null;
  providerSessionId: string | null;
  latestUsage: Usage;
  /**
   * Sticky: once a thread is known to be a bot's, an event that arrives without
   * the identity (a lookup that failed, say) must not fall back to the provider
   * name, or the run would split across two lanes mid-turn.
   */
  bot: TraceBotIdentity | null;
}

interface Usage {
  input: number | null;
  output: number | null;
  cacheWrite: number | null;
  total: number | null;
  context: number | null;
  window: number | null;
}

const emptyUsage = (): Usage => ({
  input: null,
  output: null,
  cacheWrite: null,
  total: null,
  context: null,
  window: null,
});

const digest = (value: string, length: number) =>
  createHash("sha256").update(value).digest("hex").slice(0, length);

export const traceAdwId = (threadId: string): string => digest(threadId, 8);
const phaseId = (threadId: string, turnId: string): string =>
  `vulcan-${digest(`${threadId}:${turnId}`, 24)}`;
const eventId = (event: ProviderRuntimeEvent, suffix: string): string =>
  `vulcan-${digest(`${event.eventId}:${suffix}`, 24)}`;
const shorten = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const count = (...values: unknown[]): number | null => {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
};

const usageFrom = (value: unknown): Usage => {
  const source = record(value) ?? {};
  const input = count(source.input_tokens, source.inputTokens, source.lastInputTokens);
  const output = count(source.output_tokens, source.outputTokens, source.lastOutputTokens);
  const cacheWrite = count(source.cache_write_tokens, source.cacheWriteTokens);
  return {
    input,
    output,
    cacheWrite,
    total: count(source.total_tokens, source.totalTokens, source.totalProcessedTokens),
    context: count(source.usedTokens, source.context_tokens, source.contextTokens),
    window: count(source.maxTokens, source.context_window, source.contextWindow),
  };
};

const agentEndPayload = (usage: Usage) => {
  const split: Record<string, number> = {};
  if (usage.input !== null) split.input_tokens = usage.input;
  if (usage.output !== null) split.output_tokens = usage.output;
  if (usage.cacheWrite !== null) split.cache_write_tokens = usage.cacheWrite;
  return JSON.stringify({ usage: split });
};

export class FactoryTraceMapper {
  private readonly threads = new Map<string, ThreadState>();

  map(event: ProviderRuntimeEvent, metadata: TraceThreadMetadata): readonly TraceWriteOperation[] {
    const state = this.threads.get(event.threadId) ?? {
      seq: 0,
      activeTurns: new Set<string>(),
      model: metadata.model,
      providerSessionId: metadata.providerSessionId,
      latestUsage: emptyUsage(),
      bot: metadata.bot,
    };
    this.threads.set(event.threadId, state);
    if (metadata.bot !== null) state.bot = metadata.bot;
    const adwId = traceAdwId(event.threadId);
    const worker = state.bot?.name ?? event.provider;

    if (event.type === "session.started") {
      state.providerSessionId = event.providerRefs?.providerThreadId ?? state.providerSessionId;
      return [
        {
          kind: "session.ensure",
          values: {
            adw_id: adwId,
            adw_name: "vulcan",
            request: shorten(metadata.request ?? metadata.title ?? "(untitled)", 500),
            status: "running",
            engineer: process.env.USER?.trim() || null,
            started_at: event.createdAt,
            ended_at: null,
            total_tokens: null,
            total_cost: null,
            archived: 0,
          },
        },
        this.agentOperation(event, state, adwId),
      ];
    }
    if (event.type === "session.configured") {
      const config = event.payload.config;
      state.model = typeof config.model === "string" ? config.model : state.model;
      state.providerSessionId =
        typeof config.sessionId === "string"
          ? config.sessionId
          : typeof config.session_id === "string"
            ? config.session_id
            : state.providerSessionId;
      return [this.agentOperation(event, state, adwId)];
    }
    if (event.type === "thread.started") {
      state.providerSessionId = event.payload.providerThreadId ?? state.providerSessionId;
      return [this.agentOperation(event, state, adwId)];
    }
    if (event.type === "thread.token-usage.updated") {
      state.latestUsage = usageFrom(event.payload.usage);
      return [
        {
          kind: "session.update",
          values: {
            adw_id: adwId,
            total_tokens: state.latestUsage.total,
          },
        },
        this.agentOperation(event, state, adwId),
      ];
    }
    if (event.type === "turn.started" && event.turnId !== undefined) {
      state.seq += 1;
      state.activeTurns.add(event.turnId);
      state.model = event.payload.model ?? state.model;
      const id = phaseId(event.threadId, event.turnId);
      const label = metadata.title ? shorten(metadata.title, 80) : `Turn ${state.seq}`;
      const base = {
        adw_id: adwId,
        adw_name: "vulcan",
        request: shorten(metadata.request ?? metadata.title ?? "(untitled)", 500),
        status: "running",
        engineer: process.env.USER?.trim() || null,
        started_at: event.createdAt,
        ended_at: null,
        total_tokens: state.latestUsage.total,
        total_cost: null,
        archived: 0,
      };
      return [
        { kind: "session.ensure", values: base },
        {
          kind: "session.update",
          values: {
            adw_id: adwId,
            request: shorten(metadata.request ?? metadata.title ?? "(untitled)", 500),
            status: "running",
            ended_at: null,
          },
        },
        {
          kind: "phase.insert",
          values: {
            phase_id: id,
            adw_id: adwId,
            seq: state.seq,
            name: label,
            kind: "agent",
            owner: worker,
            description: null,
            status: "running",
            attempt: 1,
            retries: 0,
            error: null,
            started_at: event.createdAt,
            ended_at: null,
          },
        },
        this.eventOperation(event, adwId, id, "phase_start", label, null, null, "phase-start"),
        this.eventOperation(
          event,
          adwId,
          id,
          "agent_start",
          worker,
          // Read back as the lane's identity while the turn is still open, before
          // any `agent_sessions` row exists to carry it.
          JSON.stringify({
            model: state.model,
            session_id: state.providerSessionId,
            display_name: state.bot?.name ?? null,
            color: state.bot?.color ?? null,
          }),
          null,
          "agent-start",
        ),
        this.agentOperation(event, state, adwId),
      ];
    }
    if (
      (event.type === "turn.completed" || event.type === "turn.aborted") &&
      event.turnId !== undefined
    ) {
      const failed =
        event.type === "turn.aborted" ||
        (event.type === "turn.completed" && event.payload.state !== "completed");
      const message =
        event.type === "turn.aborted" ? event.payload.reason : (event.payload.errorMessage ?? null);
      const turnUsage =
        event.type === "turn.completed" && event.payload.usage !== undefined
          ? usageFrom(event.payload.usage)
          : state.latestUsage;
      state.activeTurns.delete(event.turnId);
      const id = phaseId(event.threadId, event.turnId);
      const status = failed ? "failed" : "completed";
      const totalCost =
        event.type === "turn.completed"
          ? (event.payload.cumulativeCostUsd ?? event.payload.totalCostUsd ?? null)
          : null;
      const operations: TraceWriteOperation[] = [
        {
          kind: "phase.update",
          values: {
            phase_id: id,
            adw_id: adwId,
            status,
            error: message,
            ended_at: event.createdAt,
          },
        },
        this.eventOperation(
          event,
          adwId,
          id,
          "agent_end",
          worker,
          agentEndPayload(turnUsage),
          turnUsage.total,
          "agent-end",
        ),
        this.eventOperation(event, adwId, id, "phase_end", status, null, null, "phase-end"),
        {
          kind: "session.update",
          values: {
            adw_id: adwId,
            status: failed ? "failed" : state.activeTurns.size === 0 ? "completed" : "running",
            ended_at: state.activeTurns.size === 0 ? event.createdAt : null,
            total_tokens: turnUsage.total,
            total_cost: totalCost,
          },
        },
        this.agentOperation(event, { ...state, latestUsage: turnUsage }, adwId),
      ];
      if (failed && message)
        operations.push(
          this.eventOperation(
            event,
            adwId,
            id,
            "error",
            "Turn failed",
            JSON.stringify({ message }),
            null,
            "error",
          ),
        );
      return operations;
    }
    if (
      event.type === "item.completed" &&
      event.turnId !== undefined &&
      isToolLifecycleItemType(event.payload.itemType)
    ) {
      const summary = event.payload.detail ?? event.payload.title ?? event.payload.itemType;
      return [
        this.eventOperation(
          event,
          adwId,
          phaseId(event.threadId, event.turnId),
          "tool_call",
          event.payload.title ?? event.payload.itemType,
          JSON.stringify({
            tool: event.payload.itemType,
            summary: shorten(summary, 500),
          }),
          null,
          "tool",
        ),
      ];
    }
    if (event.type === "runtime.error") {
      const id = event.turnId ? phaseId(event.threadId, event.turnId) : null;
      const operations: TraceWriteOperation[] = [
        this.eventOperation(
          event,
          adwId,
          id,
          "error",
          "Runtime error",
          JSON.stringify({ message: event.payload.message }),
          null,
          "runtime-error",
        ),
        {
          kind: "session.update",
          values: {
            adw_id: adwId,
            status: "failed",
            ended_at: event.createdAt,
          },
        },
      ];
      if (id !== null) {
        operations.push({
          kind: "phase.update",
          values: {
            phase_id: id,
            adw_id: adwId,
            status: "failed",
            error: event.payload.message,
            ended_at: event.createdAt,
          },
        });
      }
      return operations;
    }
    return [];
  }

  private agentOperation(
    event: ProviderRuntimeEvent,
    state: ThreadState,
    adwId: string,
  ): TraceWriteOperation {
    return {
      kind: "agent.upsert",
      values: {
        adw_id: adwId,
        // The lane key. A bot's name rather than its provider, because the
        // coworker is the worker here; the provider stays on `coding_agent`.
        agent: state.bot?.name ?? event.provider,
        display_name: state.bot?.name ?? null,
        coding_agent: event.provider,
        model: state.model,
        color: state.bot?.color ?? null,
        session_id: state.providerSessionId,
        context_tokens: state.latestUsage.context,
        context_window: state.latestUsage.window,
        created_at: event.createdAt,
        last_used_at: event.createdAt,
      },
    };
  }

  private eventOperation(
    event: ProviderRuntimeEvent,
    adwId: string,
    tracePhaseId: string | null,
    type: string,
    name: string,
    payload: string | null,
    tokens: number | null,
    suffix: string,
  ): TraceWriteOperation {
    return {
      kind: "event.insert",
      values: {
        event_id: eventId(event, suffix),
        adw_id: adwId,
        phase_id: tracePhaseId,
        parent_id: null,
        type,
        name,
        payload_json: payload,
        tokens,
        started_at: event.createdAt,
        ended_at: event.createdAt,
      },
    };
  }
}
