import {
  type Artifact,
  type ArtifactId,
  type GitRevision,
  type NodeAttempt,
  type NodeAttemptId,
  type WorkflowDefinition,
  type WorkflowNodeId,
  type WorkflowRunId,
} from "@vulcan/contracts";
import { describe, expect, it } from "vitest";

import type { RunSnapshot } from "./factoryKernel";
import { buildAxisTicks, buildFactoryTimeline, factoryLaneOf } from "./factoryTimeline";
import { TRACER_BULLET_WORKFLOW_YAML } from "./tracerBulletWorkflow";
import { parseWorkflowYaml } from "./workflowYaml";

const REV = "aaaaaaa" as GitRevision;
const runId = "run-1" as WorkflowRunId;
const nodeId = (id: string) => id as WorkflowNodeId;

const parsed = parseWorkflowYaml(TRACER_BULLET_WORKFLOW_YAML);
if (!parsed.ok) throw new Error("tracer bullet workflow must parse");
const definition: WorkflowDefinition = parsed.definition;

const T0 = Date.parse("2026-08-09T12:00:00.000Z");
const at = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1_000).toISOString();

function attemptOf(
  node: string,
  state: NodeAttempt["state"],
  overrides: Partial<NodeAttempt> = {},
): NodeAttempt {
  return {
    id: `attempt-${node}-${overrides.attemptNumber ?? 1}` as NodeAttemptId,
    runId,
    nodeId: nodeId(node),
    attemptNumber: 1,
    state,
    waitingReason: null,
    targetId: null,
    revision: REV,
    startedAt: null,
    lastHeartbeatAt: null,
    endedAt: null,
    failureSummary: null,
    ...overrides,
  };
}

const artifactOf = (attemptId: string, node: string, overrides: Partial<Artifact> = {}): Artifact =>
  ({
    id: `artifact-${attemptId}-${overrides.kind ?? "log"}` as ArtifactId,
    kind: "log",
    producedByNodeId: nodeId(node),
    producedByAttemptId: attemptId as NodeAttemptId,
    revision: REV,
    createdAt: at(0),
    outcome: "informational",
    uri: null,
    summary: "",
    ...overrides,
  }) satisfies Artifact;

const snapshotOf = (overrides: Partial<RunSnapshot> = {}): RunSnapshot => ({
  definition,
  attempts: [],
  artifacts: [],
  gateResults: [],
  currentRevision: REV,
  ...overrides,
});

const timelineOf = (
  snapshot: RunSnapshot,
  options: Partial<Parameters<typeof buildFactoryTimeline>[1]> = {},
) =>
  buildFactoryTimeline(snapshot, {
    nowMs: T0 + 600_000,
    runStartedAtMs: T0,
    runEndedAtMs: null,
    ...options,
  });

const laneById = (
  timeline: ReturnType<typeof buildFactoryTimeline>,
  id: string,
): NonNullable<ReturnType<typeof buildFactoryTimeline>["lanes"][number]> => {
  const lane = timeline.lanes.find((candidate) => candidate.id === id);
  if (!lane) throw new Error(`expected a ${id} lane, saw ${timeline.lanes.map((l) => l.id)}`);
  return lane;
};

describe("lane assignment", () => {
  it("gives every agent role its own worker lane", () => {
    const roles = definition.nodes.filter((node) => node.kind === "agent");
    expect(new Set(roles.map((node) => factoryLaneOf(node).id)).size).toBeGreaterThan(1);
    expect(factoryLaneOf(roles[0]!).kind).toBe("agent");
  });

  it("keeps an independent review in the reviewer's lane rather than inventing a worker", () => {
    const review = definition.nodes.find((node) => node.kind === "review");
    expect(review).toBeDefined();
    expect(factoryLaneOf(review!).id).toBe("agent:review");
  });

  it("separates deterministic work, browser evidence, and gates from judgment", () => {
    const kindOf = (id: string) =>
      factoryLaneOf(definition.nodes.find((node) => node.id === id)!).kind;
    expect(kindOf("test")).toBe("workspace");
    expect(kindOf("browser-verification")).toBe("browser");
    expect(kindOf("pr-ready")).toBe("gate");
  });

  it("orders lanes with deterministic work above the agents and the gate last", () => {
    const timeline = timelineOf(
      snapshotOf({
        attempts: [
          attemptOf("plan", "succeeded", { startedAt: at(0), endedAt: at(10) }),
          attemptOf("test", "succeeded", { startedAt: at(20), endedAt: at(30) }),
          attemptOf("pr-ready", "succeeded", { startedAt: at(40), endedAt: at(41) }),
        ],
      }),
    );
    expect(timeline.lanes.map((lane) => lane.id)).toEqual([
      "workspace",
      "browser",
      "agent:plan",
      "agent:build",
      "agent:review",
      "agent:lavish",
      "gate",
    ]);
  });
});

describe("timeline geometry", () => {
  it("places a block at its real offset and width on the axis", () => {
    const timeline = timelineOf(
      snapshotOf({
        attempts: [attemptOf("plan", "succeeded", { startedAt: at(300), endedAt: at(600) })],
      }),
      { nowMs: T0 + 600_000, runEndedAtMs: T0 + 600_000 },
    );
    const block = laneById(timeline, "agent:plan").blocks[0]!;
    expect(timeline.spanMs).toBe(600_000);
    expect(block.leftPct).toBeCloseTo(49.75, 1);
    expect(block.widthPct).toBeCloseTo(49.75, 1);
    expect(block.durationMs).toBe(300_000);
  });

  it("grows a running attempt to the clock and stops a finished one at its end", () => {
    const snapshot = snapshotOf({
      attempts: [
        attemptOf("build", "running", { startedAt: at(0) }),
        attemptOf("plan", "succeeded", { startedAt: at(0), endedAt: at(60) }),
      ],
    });
    const timeline = timelineOf(snapshot, { nowMs: T0 + 120_000 });
    expect(laneById(timeline, "agent:build").blocks[0]!.durationMs).toBe(120_000);
    expect(laneById(timeline, "agent:plan").blocks[0]!.durationMs).toBe(60_000);
  });

  it("does not stretch an attempt that ended without recording a time", () => {
    const timeline = timelineOf(
      snapshotOf({ attempts: [attemptOf("plan", "failed", { startedAt: at(0) })] }),
    );
    expect(laneById(timeline, "agent:plan").blocks[0]!.durationMs).toBe(0);
  });

  it("widens a near-instant block without letting it sit on the block before it", () => {
    const timeline = timelineOf(
      snapshotOf({
        attempts: [
          attemptOf("test", "failed", { attemptNumber: 1, startedAt: at(0), endedAt: at(1) }),
          attemptOf("test", "succeeded", { attemptNumber: 2, startedAt: at(2), endedAt: at(3) }),
        ],
      }),
    );
    const [first, second] = laneById(timeline, "workspace").blocks;
    expect(first!.widthPct).toBeGreaterThanOrEqual(2.5);
    expect(second!.leftPct).toBeGreaterThanOrEqual(first!.leftPct + first!.widthPct - 0.001);
  });

  it("keeps concurrent lanes aligned, because a lane never borrows another's space", () => {
    const timeline = timelineOf(
      snapshotOf({
        attempts: [
          // A lane full of near-instant blocks accumulates inflation; the lane
          // next to it must still sit at its own true offset.
          attemptOf("test", "failed", { attemptNumber: 1, startedAt: at(0), endedAt: at(1) }),
          attemptOf("test", "succeeded", { attemptNumber: 2, startedAt: at(1), endedAt: at(2) }),
          attemptOf("review", "succeeded", { startedAt: at(300), endedAt: at(301) }),
        ],
      }),
    );
    expect(laneById(timeline, "agent:review").blocks[0]!.leftPct).toBeCloseTo(49.75, 1);
  });

  it("reports nothing started when no attempt has a start time", () => {
    const timeline = timelineOf(snapshotOf({ attempts: [attemptOf("plan", "queued")] }));
    expect(timeline.hasStarted).toBe(false);
    expect(laneById(timeline, "agent:plan").pending.map((item) => item.key)).toEqual(["plan"]);
  });

  it("puts an attempt refused before it ran on the axis, not in the pending stack", () => {
    // What the runner actually produces when no target reports `agent`: three
    // attempts that ended without ever starting. They have to read as a worker
    // that tried and gave up, not as work nobody has reached yet.
    const timeline = timelineOf(
      snapshotOf({
        attempts: [1, 2, 3].map((attemptNumber) =>
          attemptOf("plan", "failed", {
            attemptNumber,
            startedAt: null,
            endedAt: at(attemptNumber),
            failureSummary: "No execution target is available: missing-capability.",
          }),
        ),
      }),
    );
    const lane = laneById(timeline, "agent:plan");
    expect(lane.blocks.map((block) => block.status)).toEqual(["failed", "failed", "failed"]);
    expect(lane.blocks.every((block) => block.durationMs === 0)).toBe(true);
    expect(lane.pending).toEqual([]);
  });
});

describe("attempts and evidence", () => {
  it("shows a repair loop as the same worker going round again", () => {
    const timeline = timelineOf(
      snapshotOf({
        attempts: [
          attemptOf("build", "failed", {
            attemptNumber: 1,
            startedAt: at(0),
            endedAt: at(60),
            failureSummary: "tests failed",
          }),
          attemptOf("build", "running", { attemptNumber: 2, startedAt: at(90) }),
        ],
      }),
    );
    const lane = laneById(timeline, "agent:build");
    expect(lane.blocks.map((block) => block.status)).toEqual(["failed", "running"]);
    expect(lane.blocks.map((block) => block.key)).toEqual(["build#1", "build#2"]);
    expect(lane.blocks[0]!.attemptCount).toBe(2);
  });

  it("marks each artifact where it landed inside its own attempt", () => {
    const timeline = timelineOf(
      snapshotOf({
        attempts: [attemptOf("test", "failed", { startedAt: at(0), endedAt: at(100) })],
        artifacts: [
          artifactOf("attempt-test-1", "test", { createdAt: at(50), outcome: "failed" }),
          artifactOf("attempt-test-1", "test", { kind: "log2", createdAt: at(25) }),
        ],
      }),
    );
    const marks = laneById(timeline, "workspace").blocks[0]!.marks;
    expect(marks.map((mark) => Math.round(mark.xPct))).toEqual([25, 50]);
    expect(marks.map((mark) => mark.failed)).toEqual([false, true]);
  });

  it("clamps an artifact recorded after its attempt closed into the block", () => {
    const timeline = timelineOf(
      snapshotOf({
        attempts: [attemptOf("test", "succeeded", { startedAt: at(0), endedAt: at(10) })],
        artifacts: [artifactOf("attempt-test-1", "test", { createdAt: at(45) })],
      }),
    );
    expect(laneById(timeline, "workspace").blocks[0]!.marks[0]!.xPct).toBe(98);
  });
});

describe("axis ticks", () => {
  it("steps a short run in seconds and a long one in minutes", () => {
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
