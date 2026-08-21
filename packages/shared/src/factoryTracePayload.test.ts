import type { TraceEvent } from "@vulcan/contracts";
import { describe, expect, it } from "vitest";

import {
  parseAgentSpawn,
  parseEventMessage,
  parsePhaseUsage,
  parseToolCall,
} from "./factoryTracePayload";

const eventOf = (overrides: Partial<TraceEvent> & { eventId: string }): TraceEvent => ({
  rowid: 1 as TraceEvent["rowid"],
  adwId: "run-1" as TraceEvent["adwId"],
  phaseId: "phase-1" as TraceEvent["phaseId"],
  parentId: null,
  type: "log",
  name: null,
  payloadJson: null,
  tokens: null,
  startedAt: null,
  endedAt: null,
  ...overrides,
});

const agentEnd = (
  eventId: string,
  usage: Record<string, number>,
  tokens: number | null,
): TraceEvent =>
  eventOf({
    eventId,
    type: "agent_end",
    payloadJson: JSON.stringify({ usage }),
    tokens: tokens as TraceEvent["tokens"],
  });

describe("parsePhaseUsage", () => {
  it("sums read as input plus cache writes, and written as output", () => {
    const usage = parsePhaseUsage([
      agentEnd("e1", { input_tokens: 100, output_tokens: 40, cache_write_tokens: 10 }, 150),
    ]);
    expect(usage).toEqual({ read: 110, written: 40, billed: 150 });
  });

  it("sums across every agent_end, so a retried phase reads as its whole cost", () => {
    const usage = parsePhaseUsage([
      agentEnd("e1", { input_tokens: 100, output_tokens: 40 }, 140),
      agentEnd("e2", { input_tokens: 50, output_tokens: 10 }, 60),
    ]);
    expect(usage).toEqual({ read: 150, written: 50, billed: 200 });
  });

  it("returns null when no agent_end recorded any usage", () => {
    expect(parsePhaseUsage([eventOf({ eventId: "e1", type: "tool_call" })])).toBeNull();
    expect(parsePhaseUsage([agentEnd("e1", {}, null)])).toBeNull();
  });

  it("ignores a malformed payload rather than throwing", () => {
    const usage = parsePhaseUsage([
      eventOf({
        eventId: "e1",
        type: "agent_end",
        payloadJson: "{not json",
        tokens: 5 as TraceEvent["tokens"],
      }),
    ]);
    expect(usage).toEqual({ read: null, written: null, billed: 5 });
  });
});

describe("parseAgentSpawn", () => {
  it("reads the model and session from the first agent_start", () => {
    const spawn = parseAgentSpawn([
      eventOf({
        eventId: "e1",
        type: "agent_start",
        payloadJson: JSON.stringify({ model: "claude-opus-5", session_id: "abc" }),
      }),
    ]);
    expect(spawn).toEqual({ model: "claude-opus-5", sessionId: "abc" });
  });

  it("returns null when there is no agent_start or it carried nothing", () => {
    expect(parseAgentSpawn([eventOf({ eventId: "e1", type: "tool_call" })])).toBeNull();
    expect(
      parseAgentSpawn([eventOf({ eventId: "e1", type: "agent_start", payloadJson: "{}" })]),
    ).toBeNull();
  });
});

describe("parseToolCall", () => {
  it("reads the tool, summary, and failure verdict", () => {
    expect(parseToolCall(JSON.stringify({ tool: "bash", summary: "ls -la", ok: false }))).toEqual({
      tool: "bash",
      summary: "ls -la",
      failed: true,
    });
  });

  it("counts a payload without ok as not failed", () => {
    expect(parseToolCall(JSON.stringify({ tool: "bash" })).failed).toBe(false);
    expect(parseToolCall(null)).toEqual({ tool: null, summary: null, failed: false });
  });
});

describe("parseEventMessage", () => {
  it("pulls a message out, or null when absent or malformed", () => {
    expect(parseEventMessage(JSON.stringify({ message: "boom" }))).toBe("boom");
    expect(parseEventMessage(JSON.stringify({ other: "x" }))).toBeNull();
    expect(parseEventMessage("not json")).toBeNull();
  });
});
