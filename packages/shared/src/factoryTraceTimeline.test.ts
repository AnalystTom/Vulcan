import type { TraceAgentSession, TraceEvent, TracePhase } from "@vulcan/contracts";
import { describe, expect, it } from "vitest";

import {
  buildAxisTicks,
  buildFactoryTraceTimeline,
  countPhaseProgress,
  laneIdFor,
  toolCallFailed,
} from "./factoryTraceTimeline";

const T0 = Date.parse("2026-08-10T12:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1_000).toISOString();

const phaseId = (id: string) => id as TracePhase["phaseId"];

const phaseOf = (
  overrides: Partial<Omit<TracePhase, "phaseId">> & { phaseId: string },
): TracePhase => ({
  adwId: "run-1" as TracePhase["adwId"],
  seq: 0,
  name: overrides.phaseId,
  kind: "agent",
  owner: "planner",
  description: "",
  status: "success",
  attempt: 1,
  retries: 0,
  error: null,
  startedAt: null,
  endedAt: null,
  ...overrides,
  phaseId: phaseId(overrides.phaseId),
});

const agentOf = (overrides: Partial<TraceAgentSession> & { agent: string }): TraceAgentSession => ({
  adwId: "run-1" as TraceAgentSession["adwId"],
  codingAgent: "pi",
  model: null,
  sessionId: null,
  color: null,
  contextTokens: null,
  contextWindow: null,
  createdAt: null,
  lastUsedAt: null,
  ...overrides,
});

const toolCall = (phase: string, eventId: string, seconds: number, ok = true): TraceEvent => ({
  rowid: seconds,
  eventId,
  adwId: "run-1" as TraceEvent["adwId"],
  phaseId: phase as TraceEvent["phaseId"],
  parentId: null,
  type: "tool_call",
  name: "bash: ls",
  payloadJson: JSON.stringify({ tool: "bash", ok }),
  tokens: null,
  startedAt: at(seconds),
  endedAt: at(seconds + 1),
});

const timelineOf = (input: Partial<Parameters<typeof buildFactoryTraceTimeline>[0]> = {}) =>
  buildFactoryTraceTimeline({
    phases: [],
    agents: [],
    events: [],
    sessionStartedAt: at(0),
    sessionEndedAt: null,
    nowMs: T0 + 600_000,
    ...input,
  });

const laneById = (timeline: ReturnType<typeof buildFactoryTraceTimeline>, id: string) => {
  const lane = timeline.lanes.find((candidate) => candidate.id === id);
  if (!lane) throw new Error(`expected lane ${id}, saw ${timeline.lanes.map((l) => l.id)}`);
  return lane;
};

describe("lanes", () => {
  it("makes a lane of a phase's kind and owner, which is the worker", () => {
    expect(laneIdFor(phaseOf({ phaseId: "p1", kind: "agent", owner: "builder" }))).toBe(
      "agent:builder",
    );
    expect(laneIdFor(phaseOf({ phaseId: "p2", kind: "code", owner: "git" }))).toBe("code:git");
  });

  it("keeps the engineer, code, and agents in that order", () => {
    const timeline = timelineOf({
      phases: [
        phaseOf({ phaseId: "plan", kind: "agent", owner: "planner", startedAt: at(10) }),
        phaseOf({ phaseId: "commit", kind: "code", owner: "git", startedAt: at(20) }),
        phaseOf({ phaseId: "request", kind: "engineer", owner: "dan", startedAt: at(0) }),
        phaseOf({ phaseId: "build", kind: "agent", owner: "builder", startedAt: at(30) }),
      ],
    });
    expect(timeline.lanes.map((lane) => lane.id)).toEqual([
      "engineer:dan",
      "code:git",
      "agent:planner",
      "agent:builder",
    ]);
  });

  it("takes the model, colour, and context the factory recorded", () => {
    const timeline = timelineOf({
      phases: [phaseOf({ phaseId: "plan", startedAt: at(0) })],
      agents: [
        agentOf({
          agent: "planner",
          model: "claude-opus-5",
          color: "#a78bfa",
          contextTokens: 12_000,
          contextWindow: 200_000,
        }),
      ],
    });
    const lane = laneById(timeline, "agent:planner");
    expect(lane.model).toBe("claude-opus-5");
    expect(lane.color).toBe("#a78bfa");
    expect(lane.context?.percent).toBeCloseTo(6, 1);
  });

  it("draws no context bar while an agent is still running", () => {
    // Occupancy is only known once a turn closes; a bar against an unknown
    // ceiling would be decoration rather than data.
    const timeline = timelineOf({
      phases: [phaseOf({ phaseId: "plan", status: "running", startedAt: at(0) })],
      agents: [agentOf({ agent: "planner", model: "claude-opus-5" })],
    });
    expect(laneById(timeline, "agent:planner").context).toBeNull();
  });
});

describe("geometry", () => {
  it("places a phase at its real offset and width", () => {
    const timeline = timelineOf({
      phases: [phaseOf({ phaseId: "plan", startedAt: at(300), endedAt: at(600) })],
      sessionEndedAt: at(600),
    });
    const block = laneById(timeline, "agent:planner").blocks[0]!;
    expect(timeline.spanMs).toBe(600_000);
    expect(block.leftPct).toBeCloseTo(49.75, 1);
    expect(block.widthPct).toBeCloseTo(49.75, 1);
    expect(block.durationMs).toBe(300_000);
  });

  it("grows a running phase to the clock and stops a finished one at its end", () => {
    const timeline = timelineOf({
      phases: [
        phaseOf({ phaseId: "build", owner: "builder", status: "running", startedAt: at(0) }),
        phaseOf({ phaseId: "plan", startedAt: at(0), endedAt: at(60) }),
      ],
      nowMs: T0 + 120_000,
    });
    expect(laneById(timeline, "agent:builder").blocks[0]!.durationMs).toBe(120_000);
    expect(laneById(timeline, "agent:planner").blocks[0]!.durationMs).toBe(60_000);
  });

  it("does not stretch a phase that ended without recording a time", () => {
    const timeline = timelineOf({
      phases: [phaseOf({ phaseId: "plan", status: "fail", startedAt: at(0) })],
    });
    expect(laneById(timeline, "agent:planner").blocks[0]!.durationMs).toBe(0);
  });

  it("widens a near-instant phase without letting it sit on the one before it", () => {
    const timeline = timelineOf({
      phases: [
        phaseOf({ phaseId: "c1", kind: "code", owner: "git", startedAt: at(0), endedAt: at(1) }),
        phaseOf({ phaseId: "c2", kind: "code", owner: "git", startedAt: at(2), endedAt: at(3) }),
      ],
    });
    const [first, second] = laneById(timeline, "code:git").blocks;
    expect(first!.widthPct).toBeGreaterThanOrEqual(2.5);
    expect(second!.leftPct).toBeGreaterThanOrEqual(first!.leftPct + first!.widthPct - 0.001);
  });

  it("never overlaps blocks, even when a lane is too crowded to hold them all", () => {
    // Enough near-instant phases that their minimum widths sum past the track:
    // the old right-edge clamp piled the tail on one spot, so assert every block
    // still starts at or past where the one before it ended.
    const phases = Array.from({ length: 60 }, (_unused, index) =>
      phaseOf({
        phaseId: `c${index}`,
        kind: "code",
        owner: "git",
        startedAt: at(index),
        endedAt: at(index),
      }),
    );
    const blocks = laneById(timelineOf({ phases }), "code:git").blocks;
    expect(blocks).toHaveLength(60);
    for (let index = 1; index < blocks.length; index += 1) {
      const previous = blocks[index - 1]!;
      expect(blocks[index]!.leftPct).toBeGreaterThanOrEqual(
        previous.leftPct + previous.widthPct - 0.001,
      );
    }
  });

  it("pulls a block that ends at the axis edge back inside the track", () => {
    const timeline = timelineOf({
      phases: [phaseOf({ phaseId: "tail", kind: "code", owner: "git", startedAt: at(600) })],
    });
    const block = laneById(timeline, "code:git").blocks[0]!;
    // Zero-duration block at the far edge widens to its minimum and stays inside.
    expect(block.leftPct + block.widthPct).toBeLessThanOrEqual(99.5 + 0.001);
  });

  it("keeps lanes aligned, because one lane never borrows another's space", () => {
    const timeline = timelineOf({
      phases: [
        phaseOf({ phaseId: "c1", kind: "code", owner: "git", startedAt: at(0), endedAt: at(1) }),
        phaseOf({ phaseId: "c2", kind: "code", owner: "git", startedAt: at(1), endedAt: at(2) }),
        phaseOf({ phaseId: "plan", startedAt: at(300), endedAt: at(301) }),
      ],
    });
    expect(laneById(timeline, "agent:planner").blocks[0]!.leftPct).toBeCloseTo(49.75, 1);
  });

  it("holds a queued phase out of the axis but keeps it visible", () => {
    const timeline = timelineOf({
      phases: [phaseOf({ phaseId: "document", owner: "documenter", status: "queued" })],
    });
    const lane = laneById(timeline, "agent:documenter");
    expect(lane.blocks).toEqual([]);
    expect(lane.pending.map((phase) => phase.phaseId)).toEqual(["document"]);
    expect(timeline.hasStarted).toBe(false);
  });
});

describe("tool calls", () => {
  it("marks each call where it happened inside its own phase", () => {
    const timeline = timelineOf({
      phases: [phaseOf({ phaseId: "plan", startedAt: at(0), endedAt: at(100) })],
      events: [toolCall("plan", "e1", 50, false), toolCall("plan", "e2", 25)],
    });
    const marks = laneById(timeline, "agent:planner").blocks[0]!.marks;
    expect(marks.map((mark) => Math.round(mark.xPct))).toEqual([25, 50]);
    expect(marks.map((mark) => mark.failed)).toEqual([false, true]);
  });

  it("clamps a call recorded after its phase closed into the block", () => {
    const timeline = timelineOf({
      phases: [phaseOf({ phaseId: "plan", startedAt: at(0), endedAt: at(10) })],
      events: [toolCall("plan", "e1", 45)],
    });
    expect(laneById(timeline, "agent:planner").blocks[0]!.marks[0]!.xPct).toBe(98);
  });

  it("treats a payload with no ok key, or an unreadable one, as fine", () => {
    // Older tracers wrote no `ok`; only an explicit false is a tool error.
    expect(toolCallFailed(JSON.stringify({ tool: "bash" }))).toBe(false);
    expect(toolCallFailed("{not json")).toBe(false);
    expect(toolCallFailed(null)).toBe(false);
    expect(toolCallFailed(JSON.stringify({ ok: false }))).toBe(true);
  });

  it("ignores events that are not tool calls", () => {
    const timeline = timelineOf({
      phases: [phaseOf({ phaseId: "plan", startedAt: at(0), endedAt: at(100) })],
      events: [{ ...toolCall("plan", "e1", 50), type: "agent_end" }],
    });
    expect(laneById(timeline, "agent:planner").blocks[0]!.marks).toEqual([]);
  });
});

describe("progress and axis", () => {
  it("counts only succeeded phases as done, over every declared phase", () => {
    expect(
      countPhaseProgress([
        phaseOf({ phaseId: "a", status: "success" }),
        phaseOf({ phaseId: "b", status: "fail" }),
        phaseOf({ phaseId: "c", status: "queued" }),
      ]),
    ).toEqual({ done: 1, total: 3 });
  });

  it("steps a short session in seconds and a long one in minutes", () => {
    expect(buildAxisTicks(60_000, 6).map((tick) => tick.offsetMs)).toEqual([
      0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000,
    ]);
    expect(buildAxisTicks(1_800_000, 6).at(1)?.offsetMs).toBe(300_000);
  });

  it("never divides the axis into more than the asked-for number of intervals", () => {
    for (const span of [1_000, 45_000, 400_000, 9_000_000, 90_000_000]) {
      expect(buildAxisTicks(span, 6).length).toBeLessThanOrEqual(7);
    }
  });
});
