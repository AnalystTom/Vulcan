import { PROVIDER_KINDS, type ProviderRuntimeEvent } from "@vulcan/contracts";
import { describe, expect, it } from "vitest";

import { FactoryTraceMapper } from "./traceMapping.ts";

const metadata = {
  title: "Implement trace writing",
  request: "Write the trace from this user message",
  model: "gpt-5.6",
  providerSessionId: "s-1",
  bot: null,
};
const botMetadata = { ...metadata, bot: { name: "Ada", color: "#10b981" } };
const event = (value: Record<string, unknown>) =>
  ({
    eventId: `event-${value.type}`,
    provider: "codex",
    threadId: "thread-1",
    createdAt: "2026-08-12T10:00:00.000Z",
    payload: {},
    ...value,
  }) as ProviderRuntimeEvent;

describe("FactoryTraceMapper", () => {
  it("creates a trace session as soon as a native provider session starts", () => {
    const operations = new FactoryTraceMapper().map(
      event({
        type: "session.started",
        providerRefs: { providerThreadId: "native-session" },
      }),
      metadata,
    );
    expect(operations.map((operation) => operation.kind)).toEqual([
      "session.ensure",
      "agent.upsert",
    ]);
    expect(operations[0]?.values).toMatchObject({
      adw_name: "vulcan",
      request: "Write the trace from this user message",
      status: "running",
      total_tokens: null,
      total_cost: null,
    });
  });

  it("brackets a turn, emits tools, and preserves the reader's usage split", () => {
    const mapper = new FactoryTraceMapper();
    const started = mapper.map(
      event({
        type: "turn.started",
        turnId: "turn-1",
        payload: { model: "gpt-5.6" },
      }),
      metadata,
    );
    const tool = mapper.map(
      event({
        type: "item.completed",
        eventId: "tool-1",
        turnId: "turn-1",
        itemId: "item-1",
        payload: {
          itemType: "command_execution",
          title: "Run tests",
          detail: "vitest passed",
        },
      }),
      metadata,
    );
    const ended = mapper.map(
      event({
        type: "turn.completed",
        eventId: "turn-end",
        turnId: "turn-1",
        payload: {
          state: "completed",
          usage: {
            input_tokens: 120,
            output_tokens: 30,
            cache_write_tokens: 5,
          },
        },
      }),
      metadata,
    );

    expect(started.map((operation) => operation.kind)).toEqual([
      "session.ensure",
      "session.update",
      "phase.insert",
      "event.insert",
      "event.insert",
      "agent.upsert",
    ]);
    expect(tool[0]?.values).toMatchObject({
      type: "tool_call",
      name: "Run tests",
    });
    const agentEnd = ended.find(
      (operation) => operation.kind === "event.insert" && operation.values.type === "agent_end",
    );
    expect(JSON.parse(String(agentEnd?.values.payload_json))).toEqual({
      usage: { input_tokens: 120, output_tokens: 30, cache_write_tokens: 5 },
    });
    expect(ended.find((operation) => operation.kind === "session.update")?.values).toMatchObject({
      status: "completed",
      total_cost: null,
    });
  });

  it("keeps unknown usage null and emits errors for aborts and runtime failures", () => {
    const mapper = new FactoryTraceMapper();
    mapper.map(event({ type: "turn.started", turnId: "turn-1" }), {
      title: null,
      request: null,
      model: null,
      providerSessionId: null,
      bot: null,
    });
    const aborted = mapper.map(
      event({
        type: "turn.aborted",
        eventId: "abort",
        turnId: "turn-1",
        payload: { reason: "stop" },
      }),
      metadata,
    );
    const failure = mapper.map(
      event({
        type: "runtime.error",
        eventId: "failure",
        payload: { message: "transport died" },
      }),
      metadata,
    );
    expect(aborted.some((operation) => operation.values.type === "error")).toBe(true);
    expect(
      aborted.find((operation) => operation.kind === "session.update")?.values.total_tokens,
    ).toBe(null);
    expect(failure.find((operation) => operation.kind === "session.update")?.values.status).toBe(
      "failed",
    );
  });

  it("maps token snapshots into nullable session and agent occupancy updates", () => {
    const mapper = new FactoryTraceMapper();
    const operations = mapper.map(
      event({
        type: "thread.token-usage.updated",
        payload: {
          usage: {
            usedTokens: 400,
            maxTokens: 2_000,
            totalProcessedTokens: 900,
          },
        },
      }),
      metadata,
    );
    expect(operations[0]?.values.total_tokens).toBe(900);
    expect(operations[1]?.values).toMatchObject({
      context_tokens: 400,
      context_window: 2_000,
    });
  });

  it("names a bot's lane after the bot, keeping the provider as the coding agent", () => {
    const mapper = new FactoryTraceMapper();
    const operations = mapper.map(
      event({
        type: "turn.started",
        turnId: "turn-1",
        payload: { model: "gpt-5.6" },
      }),
      botMetadata,
    );
    expect(operations.find((operation) => operation.kind === "phase.insert")?.values.owner).toBe(
      "Ada",
    );
    expect(operations.find((operation) => operation.kind === "agent.upsert")?.values).toMatchObject(
      {
        agent: "Ada",
        display_name: "Ada",
        coding_agent: "codex",
        color: "#10b981",
      },
    );
    const started = operations.find(
      (operation) => operation.kind === "event.insert" && operation.values.type === "agent_start",
    );
    expect(started?.values.name).toBe("Ada");
    expect(JSON.parse(String(started?.values.payload_json))).toMatchObject({
      display_name: "Ada",
      color: "#10b981",
    });
  });

  it("keeps a bot's lane after a lookup that could not answer mid-turn", () => {
    const mapper = new FactoryTraceMapper();
    mapper.map(event({ type: "turn.started", turnId: "turn-1" }), botMetadata);
    const operations = mapper.map(
      event({
        type: "turn.completed",
        eventId: "turn-end",
        turnId: "turn-1",
        payload: { state: "completed" },
      }),
      metadata,
    );
    expect(operations.find((operation) => operation.kind === "agent.upsert")?.values.agent).toBe(
      "Ada",
    );
  });

  it.each(PROVIDER_KINDS)("maps %s through the same provider-neutral turn path", (provider) => {
    const operations = new FactoryTraceMapper().map(
      { ...event({ type: "turn.started", turnId: "turn-1" }), provider },
      metadata,
    );
    expect(operations.find((operation) => operation.kind === "phase.insert")?.values.owner).toBe(
      provider,
    );
    expect(
      operations.find((operation) => operation.kind === "agent.upsert")?.values.coding_agent,
    ).toBe(provider);
  });
});
