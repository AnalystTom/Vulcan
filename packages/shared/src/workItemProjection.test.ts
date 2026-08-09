import {
  type AttentionItem,
  type AttentionItemId,
  DEFAULT_FACTORY_POLICY,
  type GateResult,
  type GitRevision,
  type NodeAttempt,
  type NodeAttemptId,
  type WorkflowDefinition,
  type WorkflowDefinitionId,
  type WorkflowNodeId,
  type WorkflowRunId,
  type WorkItem,
  type WorkItemId,
} from "@vulcan/contracts";
import { describe, expect, it } from "vitest";

import type { RunSnapshot } from "./factoryKernel";
import { TRACER_BULLET_WORKFLOW_YAML } from "./tracerBulletWorkflow";
import { parseWorkflowYaml } from "./workflowYaml";
import {
  buildFactoryActivityBoard,
  buildFactoryWaterfall,
  placeWorkItem,
} from "./workItemProjection";

const REV_A = "aaaaaaa" as GitRevision;
const REV_B = "bbbbbbb" as GitRevision;
const runId = "run-1" as WorkflowRunId;
const nodeId = (id: string) => id as WorkflowNodeId;

const parsed = parseWorkflowYaml(TRACER_BULLET_WORKFLOW_YAML);
if (!parsed.ok) throw new Error("tracer bullet workflow must parse");
const definition: WorkflowDefinition = parsed.definition;

const workItem = (intent: WorkItem["intent"] = "captured"): WorkItem => ({
  id: "item-1" as WorkItemId,
  title: "Add the thing",
  body: "",
  source: { kind: "local", externalId: null, url: null },
  projectId: null,
  workspaceId: null,
  intent,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
});

function attemptOf(
  node: string,
  state: NodeAttempt["state"],
  overrides: Partial<NodeAttempt> = {},
): NodeAttempt {
  return {
    id: `attempt-${node}` as NodeAttemptId,
    runId,
    nodeId: nodeId(node),
    attemptNumber: 1,
    state,
    waitingReason: state === "waiting-human" ? "approval-required" : null,
    targetId: null,
    revision: REV_A,
    startedAt: null,
    lastHeartbeatAt: null,
    endedAt: null,
    failureSummary: null,
    ...overrides,
  };
}

const snapshotOf = (overrides: Partial<RunSnapshot> = {}): RunSnapshot => ({
  definition,
  attempts: [],
  artifacts: [],
  gateResults: [],
  currentRevision: REV_A,
  ...overrides,
});

const gatePass = (revision: GitRevision, passed = true): GateResult => ({
  nodeId: nodeId("pr-ready"),
  runId,
  passed,
  revision,
  policyVersion: DEFAULT_FACTORY_POLICY.version,
  checks: [],
  evaluatedAt: "2026-08-09T00:00:00.000Z",
});

const attention = (request: string): AttentionItem => ({
  id: "attn-1" as AttentionItemId,
  runId,
  nodeId: null,
  attemptId: null,
  request,
  reason: "recovery-exhausted",
  attemptedRecovery: [],
  workspaceId: null,
  createdAt: "2026-08-09T00:00:00.000Z",
  resolvedAt: null,
});

const place = (input: Partial<Parameters<typeof placeWorkItem>[0]> = {}) =>
  placeWorkItem({
    workItem: workItem(),
    snapshot: null,
    deliveryGateNodeId: nodeId("pr-ready"),
    openAttentionItems: [],
    ...input,
  });

describe("kanban placement", () => {
  it("starts in inbox and moves to ready on operator intent", () => {
    expect(place().column).toBe("inbox");
    expect(place({ workItem: workItem("ready") }).column).toBe("ready");
  });

  it("shows cancellation ahead of everything else", () => {
    expect(
      place({
        workItem: workItem("cancelled"),
        snapshot: snapshotOf({ attempts: [attemptOf("build", "running")] }),
      }).column,
    ).toBe("cancelled");
  });

  it("moves to running while nodes execute", () => {
    expect(
      place({ snapshot: snapshotOf({ attempts: [attemptOf("plan", "running")] }) }).column,
    ).toBe("running");
  });

  it("is done only when the configured delivery gate passed at the current revision", () => {
    // This is the rule that stops the board from being a place where completion
    // can be asserted: nothing here reads a stored column.
    expect(place({ snapshot: snapshotOf({ gateResults: [gatePass(REV_A)] }) }).column).toBe("done");

    // A pass from a revision the workspace has left is history, not delivery.
    expect(
      place({
        snapshot: snapshotOf({ currentRevision: REV_B, gateResults: [gatePass(REV_A)] }),
      }).column,
    ).not.toBe("done");

    // A failing verdict is not a pass.
    expect(
      place({ snapshot: snapshotOf({ gateResults: [gatePass(REV_A, false)] }) }).column,
    ).not.toBe("done");

    // No configured gate means delivery cannot be claimed at all.
    expect(
      place({
        deliveryGateNodeId: null,
        snapshot: snapshotOf({ gateResults: [gatePass(REV_A)] }),
      }).column,
    ).not.toBe("done");
  });

  it("puts anything needing a person in blocked, ahead of activity", () => {
    const withAttention = place({
      snapshot: snapshotOf({ attempts: [attemptOf("build", "running")] }),
      openAttentionItems: [attention("Approve the migration?")],
    });
    expect(withAttention.column).toBe("blocked");
    // A single item names the decision rather than saying "something happened".
    expect(withAttention.reason).toBe("Approve the migration?");

    expect(
      place({ snapshot: snapshotOf({ attempts: [attemptOf("approve", "waiting-human")] }) }).column,
    ).toBe("blocked");
  });

  it("summarises when several decisions are waiting", () => {
    const placement = place({
      snapshot: snapshotOf({ attempts: [attemptOf("build", "running")] }),
      openAttentionItems: [attention("First?"), attention("Second?")],
    });
    expect(placement.reason).toContain("2 decisions");
  });

  it("moves to review when the work is finished but unjudged", () => {
    const done = ["plan", "build", "test", "browser-verification"].map((node) =>
      attemptOf(node, "succeeded"),
    );
    expect(place({ snapshot: snapshotOf({ attempts: done }) }).column).toBe("review");
  });

  it("calls a run that cannot progress blocked rather than quietly idle", () => {
    const stuck = [attemptOf("plan", "failed")];
    expect(place({ snapshot: snapshotOf({ attempts: stuck }) }).column).toBe("blocked");
  });
});

describe("factory waterfall", () => {
  it("shows the whole plan including nodes that have not run", () => {
    const waterfall = buildFactoryWaterfall(snapshotOf());
    expect(waterfall).toHaveLength(definition.nodes.length);
    expect(waterfall[0]?.node.id).toBe("plan");
    expect(waterfall[0]?.status).toBe("not-started");
    // Everything downstream is visibly later rather than merely absent.
    expect(waterfall[1]?.status).toBe("blocked-by-dependency");
  });

  it("separates agent judgment from deterministic work", () => {
    const waterfall = buildFactoryWaterfall(snapshotOf());
    const agentIds = waterfall.filter((entry) => entry.isAgentWork).map((entry) => entry.node.id);
    expect(agentIds).toEqual(["plan", "build", "review"]);
  });

  it("counts attempts so a repair loop is visible", () => {
    const snapshot = snapshotOf({
      attempts: [
        attemptOf("plan", "succeeded"),
        attemptOf("build", "failed", { attemptNumber: 1, id: "a1" as NodeAttemptId }),
        attemptOf("build", "running", { attemptNumber: 2, id: "a2" as NodeAttemptId }),
      ],
    });
    const build = buildFactoryWaterfall(snapshot).find((entry) => entry.node.id === "build");
    expect(build?.attemptCount).toBe(2);
    expect(build?.status).toBe("running");
  });

  it("stops showing a verification node as complete once the revision moves under it", () => {
    const snapshot = snapshotOf({
      currentRevision: REV_B,
      attempts: [
        attemptOf("plan", "succeeded", { revision: REV_A }),
        attemptOf("build", "succeeded", { revision: REV_A }),
        attemptOf("test", "succeeded", { revision: REV_A }),
      ],
    });
    const waterfall = buildFactoryWaterfall(snapshot);
    const statusOf = (id: string) => waterfall.find((entry) => entry.node.id === id)?.status;
    // The work that produced the revision stays done; the checking of it does not.
    expect(statusOf("plan")).toBe("complete");
    expect(statusOf("build")).toBe("complete");
    expect(statusOf("test")).toBe("not-started");
  });

  it("stays inspectable for a definition whose graph is cyclic", () => {
    const cyclic: WorkflowDefinition = {
      ...definition,
      id: "cyclic" as WorkflowDefinitionId,
      nodes: [
        {
          kind: "agent",
          id: nodeId("a"),
          title: "A",
          dependsOn: [nodeId("b")],
          requiredCapabilities: [],
          role: "build",
          promptTemplate: "x",
        },
        {
          kind: "agent",
          id: nodeId("b"),
          title: "B",
          dependsOn: [nodeId("a")],
          requiredCapabilities: [],
          role: "build",
          promptTemplate: "x",
        },
      ],
    };
    expect(buildFactoryWaterfall(snapshotOf({ definition: cyclic }))).toHaveLength(2);
  });
});

describe("factory activity board", () => {
  it("groups live work and leaves future nodes to the waterfall", () => {
    const snapshot = snapshotOf({
      attempts: [
        attemptOf("plan", "succeeded"),
        attemptOf("build", "running"),
        attemptOf("test", "waiting-external", { waitingReason: "rate-limited" }),
      ],
    });
    const board = buildFactoryActivityBoard(snapshot);
    expect(board.complete.map((entry) => entry.node.id)).toEqual(["plan"]);
    expect(board.running.map((entry) => entry.node.id)).toEqual(["build"]);
    expect(board.waiting.map((entry) => entry.node.id)).toEqual(["test"]);
    // Nodes that have not started are not activity.
    const total = Object.values(board).flat().length;
    expect(total).toBe(3);
  });

  it("shows a verifying node as review, not as running", () => {
    const snapshot = snapshotOf({ attempts: [attemptOf("test", "verifying")] });
    expect(buildFactoryActivityBoard(snapshot).review.map((e) => e.node.id)).toEqual(["test"]);
  });

  it("groups a lost attempt with failures rather than dropping it", () => {
    // A disconnected attempt must be visible as an explicit outcome, never
    // silently absent from the board.
    const snapshot = snapshotOf({ attempts: [attemptOf("build", "lost")] });
    expect(buildFactoryActivityBoard(snapshot).failed.map((e) => e.node.id)).toEqual(["build"]);
  });
});

describe("kanban and factory agree", () => {
  it("derive the same reality from one snapshot", () => {
    // Two projections over one set of facts: if the board says running, the
    // factory must have something running.
    const snapshot = snapshotOf({
      attempts: [attemptOf("plan", "succeeded"), attemptOf("build", "running")],
    });
    expect(place({ snapshot }).column).toBe("running");
    expect(buildFactoryActivityBoard(snapshot).running).toHaveLength(1);
  });

  it("agree that a passed delivery gate means done and everything is complete", () => {
    const attempts = definition.nodes.map((node) => attemptOf(node.id, "succeeded"));
    const snapshot = snapshotOf({ attempts, gateResults: [gatePass(REV_A)] });
    expect(place({ snapshot }).column).toBe("done");
    const board = buildFactoryActivityBoard(snapshot);
    expect(board.complete).toHaveLength(definition.nodes.length);
    expect(board.running).toHaveLength(0);
  });
});
