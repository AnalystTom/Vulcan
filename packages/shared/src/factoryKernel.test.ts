import {
  type Artifact,
  type ArtifactId,
  DEFAULT_FACTORY_POLICY,
  type ExecutionTarget,
  type ExecutionTargetId,
  type FactoryPolicy,
  type GateNode,
  type GateResult,
  type GitRevision,
  type NodeAttempt,
  type NodeAttemptId,
  type NodeAttemptState,
  type TargetLease,
  type WorkflowDefinition,
  type WorkflowDefinitionId,
  type WorkflowNode,
  type WorkflowNodeId,
  type WorkflowRunId,
} from "@vulcan/contracts";
import { describe, expect, it } from "vitest";

import {
  canTransitionAttempt,
  detectStall,
  deriveRunState,
  evaluateGate,
  findReadyNodes,
  findStaleArtifacts,
  findStaleGateResults,
  isNodeSatisfied,
  legalAttemptTransitions,
  planRecovery,
  type RunSnapshot,
  selectTarget,
  topologicalOrder,
  transitionAttempt,
  validateDefinition,
} from "./factoryKernel";

const nodeId = (id: string) => id as WorkflowNodeId;
const runId = "run-1" as WorkflowRunId;
const REV_A = "aaaaaaa" as GitRevision;
const REV_B = "bbbbbbb" as GitRevision;

const agentNode = (id: string, dependsOn: string[] = []): WorkflowNode => ({
  kind: "agent",
  id: nodeId(id),
  title: id,
  dependsOn: dependsOn.map(nodeId),
  requiredCapabilities: [],
  role: "build",
  promptTemplate: "do the thing",
});

const testNode = (id: string, dependsOn: string[] = []): WorkflowNode => ({
  kind: "test",
  id: nodeId(id),
  title: id,
  dependsOn: dependsOn.map(nodeId),
  requiredCapabilities: ["shell"],
  command: "bun run test",
});

const gateNode = (id: string, dependsOn: string[], kinds: string[]): GateNode => ({
  kind: "gate",
  id: nodeId(id),
  title: id,
  dependsOn: dependsOn.map(nodeId),
  requiredCapabilities: [],
  checks: [{ name: `${id}-check`, requiresArtifactKinds: kinds }],
});

function definitionOf(
  nodes: WorkflowNode[],
  policy: FactoryPolicy = DEFAULT_FACTORY_POLICY,
): WorkflowDefinition {
  return {
    id: "def-1" as WorkflowDefinitionId,
    version: 1,
    name: "test workflow",
    description: "",
    nodes,
    policy,
    source: "",
  };
}

function attemptOf(overrides: Partial<NodeAttempt> & { nodeId: WorkflowNodeId }): NodeAttempt {
  return {
    id: `attempt-${overrides.nodeId}-${overrides.attemptNumber ?? 1}` as NodeAttemptId,
    runId,
    attemptNumber: 1,
    state: "succeeded",
    waitingReason: null,
    targetId: null,
    revision: REV_A,
    startedAt: null,
    lastHeartbeatAt: null,
    endedAt: null,
    failureSummary: null,
    ...overrides,
  };
}

function artifactOf({
  id,
  kind,
  ...overrides
}: Omit<Partial<Artifact>, "id" | "kind"> & { kind: string; id: string }): Artifact {
  return {
    producedByNodeId: nodeId("build"),
    producedByAttemptId: "attempt-1" as NodeAttemptId,
    revision: REV_A,
    createdAt: "2026-08-09T00:00:00.000Z",
    outcome: "passed",
    uri: null,
    summary: "",
    ...overrides,
    id: id as ArtifactId,
    kind,
  };
}

function snapshotOf(input: Partial<RunSnapshot> & { definition: WorkflowDefinition }): RunSnapshot {
  return {
    attempts: [],
    artifacts: [],
    gateResults: [],
    currentRevision: REV_A,
    ...input,
  };
}

describe("attempt state machine", () => {
  it("never leaves a terminal state", () => {
    for (const terminal of ["succeeded", "failed", "cancelled", "lost"] as NodeAttemptState[]) {
      expect(legalAttemptTransitions(terminal)).toEqual([]);
    }
  });

  it("only reaches success through verification", () => {
    const reachSucceeded = (
      [
        "queued",
        "provisioning",
        "ready",
        "running",
        "waiting-external",
        "waiting-agent",
        "waiting-human",
        "retrying",
        "verifying",
      ] as NodeAttemptState[]
    ).filter((state) => canTransitionAttempt(state, "succeeded"));
    // A node cannot claim completion without its evidence having been looked at.
    expect(reachSucceeded).toEqual(["verifying"]);
  });

  it("lets every active state be lost, so a dead process is never assumed successful", () => {
    const active: NodeAttemptState[] = [
      "provisioning",
      "ready",
      "running",
      "waiting-external",
      "waiting-agent",
      "waiting-human",
      "retrying",
      "verifying",
    ];
    for (const state of active) expect(canTransitionAttempt(state, "lost")).toBe(true);
  });

  it("refuses an illegal transition rather than applying it", () => {
    const attempt = attemptOf({ nodeId: nodeId("build"), state: "queued" });
    const result = transitionAttempt(attempt, "succeeded", { now: "2026-08-09T00:00:00.000Z" });
    expect(result).toEqual({ ok: false, reason: "illegal-transition" });
  });

  it("requires a waiting reason for every waiting state and forbids one elsewhere", () => {
    const running = attemptOf({ nodeId: nodeId("build"), state: "running" });
    expect(transitionAttempt(running, "waiting-agent", { now: "t" })).toEqual({
      ok: false,
      reason: "missing-waiting-reason",
    });
    expect(
      transitionAttempt(running, "verifying", { now: "t", waitingReason: "rate-limited" }),
    ).toEqual({ ok: false, reason: "unexpected-waiting-reason" });

    const waited = transitionAttempt(running, "waiting-human", {
      now: "t",
      waitingReason: "approval-required",
    });
    expect(waited.ok).toBe(true);
    if (waited.ok) expect(waited.attempt.waitingReason).toBe("approval-required");
  });

  it("stamps start and end times exactly once", () => {
    const queued = attemptOf({ nodeId: nodeId("build"), state: "ready", startedAt: null });
    const started = transitionAttempt(queued, "running", { now: "2026-08-09T01:00:00.000Z" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.attempt.startedAt).toBe("2026-08-09T01:00:00.000Z");

    const verifying = transitionAttempt(started.attempt, "verifying", { now: "t2" });
    expect(verifying.ok).toBe(true);
    if (!verifying.ok) return;
    // Re-entering running must not reset the original start time.
    expect(verifying.attempt.startedAt).toBe("2026-08-09T01:00:00.000Z");

    const done = transitionAttempt(verifying.attempt, "succeeded", {
      now: "2026-08-09T02:00:00.000Z",
    });
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.attempt.endedAt).toBe("2026-08-09T02:00:00.000Z");
  });
});

describe("scheduling", () => {
  const definition = definitionOf([
    agentNode("plan"),
    agentNode("build", ["plan"]),
    testNode("test", ["build"]),
  ]);

  it("offers only nodes whose dependencies are satisfied", () => {
    const snapshot = snapshotOf({ definition });
    expect(findReadyNodes(snapshot, DEFAULT_FACTORY_POLICY).map((r) => r.node.id)).toEqual([
      "plan",
    ]);
  });

  it("advances as each node succeeds", () => {
    const snapshot = snapshotOf({
      definition,
      attempts: [attemptOf({ nodeId: nodeId("plan"), state: "succeeded" })],
    });
    expect(findReadyNodes(snapshot, DEFAULT_FACTORY_POLICY).map((r) => r.node.id)).toEqual([
      "build",
    ]);
  });

  it("does not re-offer a node that already has a live attempt", () => {
    const snapshot = snapshotOf({
      definition,
      attempts: [attemptOf({ nodeId: nodeId("plan"), state: "running" })],
    });
    expect(findReadyNodes(snapshot, DEFAULT_FACTORY_POLICY)).toEqual([]);
  });

  it("offers a failed node again with the next attempt number, until the budget runs out", () => {
    const policy = { ...DEFAULT_FACTORY_POLICY, maxAttemptsPerNode: 2 };
    const first = snapshotOf({
      definition,
      attempts: [attemptOf({ nodeId: nodeId("plan"), state: "failed", attemptNumber: 1 })],
    });
    expect(findReadyNodes(first, policy)[0]?.nextAttemptNumber).toBe(2);

    const exhausted = snapshotOf({
      definition,
      attempts: [attemptOf({ nodeId: nodeId("plan"), state: "failed", attemptNumber: 2 })],
    });
    expect(findReadyNodes(exhausted, policy)).toEqual([]);
  });

  it("re-runs verification when the revision moves, but not the work that moved it", () => {
    // The pinning rule applies to checking, not to doing. Invalidating the build
    // would make every build invalidate itself -- it commits, which moves the
    // revision -- and the run would never converge.
    const snapshot = snapshotOf({
      definition,
      currentRevision: REV_B,
      attempts: [
        attemptOf({ nodeId: nodeId("plan"), state: "succeeded", revision: REV_A }),
        attemptOf({ nodeId: nodeId("build"), state: "succeeded", revision: REV_A }),
        attemptOf({ nodeId: nodeId("test"), state: "succeeded", revision: REV_A }),
      ],
    });
    expect(isNodeSatisfied(snapshot, nodeId("plan"))).toBe(true);
    expect(isNodeSatisfied(snapshot, nodeId("build"))).toBe(true);
    expect(isNodeSatisfied(snapshot, nodeId("test"))).toBe(false);
    expect(findReadyNodes(snapshot, DEFAULT_FACTORY_POLICY).map((r) => r.node.id)).toEqual([
      "test",
    ]);
  });
});

describe("run state", () => {
  const definition = definitionOf([agentNode("build"), testNode("test", ["build"])]);

  it("is pending before anything runs and succeeded when every node is satisfied", () => {
    expect(deriveRunState(snapshotOf({ definition }), DEFAULT_FACTORY_POLICY)).toBe("pending");
    expect(
      deriveRunState(
        snapshotOf({
          definition,
          attempts: [attemptOf({ nodeId: nodeId("build") }), attemptOf({ nodeId: nodeId("test") })],
        }),
        DEFAULT_FACTORY_POLICY,
      ),
    ).toBe("succeeded");
  });

  it("distinguishes waiting for a person from work in flight", () => {
    const blocked = snapshotOf({
      definition,
      attempts: [
        attemptOf({
          nodeId: nodeId("build"),
          state: "waiting-human",
          waitingReason: "approval-required",
        }),
      ],
    });
    expect(deriveRunState(blocked, DEFAULT_FACTORY_POLICY)).toBe("blocked");

    const running = snapshotOf({
      definition,
      attempts: [attemptOf({ nodeId: nodeId("build"), state: "running" })],
    });
    expect(deriveRunState(running, DEFAULT_FACTORY_POLICY)).toBe("running");
  });

  it("fails once a node exhausts its attempts", () => {
    const policy = { ...DEFAULT_FACTORY_POLICY, maxAttemptsPerNode: 1 };
    const snapshot = snapshotOf({
      definition,
      attempts: [attemptOf({ nodeId: nodeId("build"), state: "failed", attemptNumber: 1 })],
    });
    expect(deriveRunState(snapshot, policy)).toBe("failed");
  });
});

describe("target routing", () => {
  const target = (
    id: string,
    capabilities: ExecutionTarget["capabilities"],
    online = true,
    maxConcurrentLeases = 2,
  ): ExecutionTarget => ({
    id: id as ExecutionTargetId,
    label: id,
    capabilities,
    maxConcurrentLeases,
    online,
    lastSeenAt: null,
  });

  it("picks the least loaded capable target, deterministically", () => {
    const targets = [target("b", ["shell"]), target("a", ["shell"])];
    const leases: TargetLease[] = [
      {
        targetId: "a" as ExecutionTargetId,
        attemptId: "x" as NodeAttemptId,
        runId,
        acquiredAt: "t",
        expiresAt: "t",
      },
    ];
    expect(selectTarget(["shell"], targets, leases)).toEqual({ kind: "selected", targetId: "b" });
    // With equal load the tie breaks by id, so a replay schedules identically.
    expect(selectTarget(["shell"], targets, [])).toEqual({ kind: "selected", targetId: "a" });
  });

  it("separates a capability nobody has from a target that is merely busy or offline", () => {
    // The distinction decides whether waiting is worthwhile or whether a person
    // has to enrol a machine.
    expect(selectTarget(["computer-use"], [target("a", ["shell"])], [])).toEqual({
      kind: "none-available",
      reason: "missing-capability",
    });
    expect(selectTarget(["shell"], [target("a", ["shell"], false)], [])).toEqual({
      kind: "none-available",
      reason: "target-unavailable",
    });
    const busy = target("a", ["shell"], true, 1);
    const leases: TargetLease[] = [
      {
        targetId: "a" as ExecutionTargetId,
        attemptId: "x" as NodeAttemptId,
        runId,
        acquiredAt: "t",
        expiresAt: "t",
      },
    ];
    expect(selectTarget(["shell"], [busy], leases)).toEqual({
      kind: "none-available",
      reason: "target-unavailable",
    });
  });
});

describe("gates", () => {
  const gate = gateNode("pr-ready", ["test"], ["test-results", "screenshot"]);
  const definition = definitionOf([testNode("test"), gate]);

  it("passes only when every required kind has passing evidence at the current revision", () => {
    const snapshot = snapshotOf({
      definition,
      artifacts: [
        artifactOf({ id: "a1", kind: "test-results" }),
        artifactOf({ id: "a2", kind: "screenshot" }),
      ],
    });
    const result = evaluateGate(gate, snapshot, DEFAULT_FACTORY_POLICY, "now");
    expect(result.passed).toBe(true);
    expect(result.revision).toBe(REV_A);
    expect(result.policyVersion).toBe(DEFAULT_FACTORY_POLICY.version);
    expect(result.checks[0]?.evidenceArtifactIds as readonly string[]).toEqual(["a1", "a2"]);
  });

  it("fails when evidence is missing rather than treating absence as a pass", () => {
    const snapshot = snapshotOf({
      definition,
      artifacts: [artifactOf({ id: "a1", kind: "test-results" })],
    });
    const result = evaluateGate(gate, snapshot, DEFAULT_FACTORY_POLICY, "now");
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.detail).toContain("screenshot");
  });

  it("fails when any admissible artifact reports failure", () => {
    const snapshot = snapshotOf({
      definition,
      artifacts: [
        artifactOf({ id: "a1", kind: "test-results", outcome: "failed" }),
        artifactOf({ id: "a2", kind: "screenshot" }),
      ],
    });
    expect(evaluateGate(gate, snapshot, DEFAULT_FACTORY_POLICY, "now").passed).toBe(false);
  });

  it("ignores evidence produced against a different revision", () => {
    const snapshot = snapshotOf({
      definition,
      currentRevision: REV_B,
      artifacts: [
        artifactOf({ id: "a1", kind: "test-results", revision: REV_A }),
        artifactOf({ id: "a2", kind: "screenshot", revision: REV_A }),
      ],
    });
    const result = evaluateGate(gate, snapshot, DEFAULT_FACTORY_POLICY, "now");
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.evidenceArtifactIds as readonly string[]).toEqual([]);
  });

  it("reports which evidence and which past verdicts a revision change invalidated", () => {
    const stalePass: GateResult = {
      nodeId: nodeId("pr-ready"),
      runId,
      passed: true,
      revision: REV_A,
      policyVersion: 1,
      checks: [],
      evaluatedAt: "t",
    };
    const snapshot = snapshotOf({
      definition,
      currentRevision: REV_B,
      artifacts: [artifactOf({ id: "a1", kind: "test-results", revision: REV_A })],
      gateResults: [stalePass],
    });
    expect(findStaleArtifacts(snapshot).map((a) => a.id as string)).toEqual(["a1"]);
    // Kept rather than deleted, so an audit can see the pass no longer counts.
    expect(findStaleGateResults(snapshot)).toEqual([stalePass]);
  });
});

describe("stall detection", () => {
  const policy: FactoryPolicy = {
    ...DEFAULT_FACTORY_POLICY,
    attemptTimeoutSeconds: 600,
    heartbeatTimeoutSeconds: 60,
  };
  const start = "2026-08-09T00:00:00.000Z";
  const at = (seconds: number) => new Date(Date.parse(start) + seconds * 1000).toISOString();

  it("treats silence beyond the heartbeat timeout as a stall", () => {
    const attempt = attemptOf({
      nodeId: nodeId("build"),
      state: "running",
      startedAt: start,
      lastHeartbeatAt: start,
    });
    expect(detectStall(attempt, policy, at(30))).toEqual({ kind: "healthy" });
    expect(detectStall(attempt, policy, at(120))).toEqual({
      kind: "stalled",
      cause: "heartbeat-timeout",
    });
  });

  it("times out a long attempt even while heartbeats keep arriving", () => {
    // A live process is not proof of useful progress, which is exactly the
    // failure mode an operator otherwise has to notice by hand.
    const attempt = attemptOf({
      nodeId: nodeId("build"),
      state: "running",
      startedAt: start,
      lastHeartbeatAt: at(700),
    });
    expect(detectStall(attempt, policy, at(700))).toEqual({
      kind: "stalled",
      cause: "attempt-timeout",
    });
  });

  it("never calls a person slow to answer a stall", () => {
    const attempt = attemptOf({
      nodeId: nodeId("approve"),
      state: "waiting-human",
      waitingReason: "approval-required",
      startedAt: start,
      lastHeartbeatAt: start,
    });
    expect(detectStall(attempt, policy, at(100_000))).toEqual({ kind: "healthy" });
  });

  it("does not call a rate-limited attempt stalled for being quiet", () => {
    const attempt = attemptOf({
      nodeId: nodeId("build"),
      state: "waiting-external",
      waitingReason: "rate-limited",
      startedAt: start,
      lastHeartbeatAt: start,
    });
    expect(detectStall(attempt, policy, at(120))).toEqual({ kind: "healthy" });
    // The attempt timeout still applies, so it cannot wait forever either.
    expect(detectStall(attempt, policy, at(700))).toEqual({
      kind: "stalled",
      cause: "attempt-timeout",
    });
  });
});

describe("recovery ladder", () => {
  const attempt = attemptOf({
    nodeId: nodeId("build"),
    state: "running",
    targetId: "target-a" as ExecutionTargetId,
  });

  it("climbs the ladder in order and ends at attention", () => {
    const order = [];
    let attempted: ReturnType<typeof planRecovery>["attempted"] = [];
    for (let step = 0; step < 6; step += 1) {
      const decision = planRecovery(attempt, DEFAULT_FACTORY_POLICY, attempted);
      order.push(decision.rung);
      attempted = [...attempted, decision.rung];
    }
    expect(order).toEqual([
      "resume-same-session",
      "retry-attempt",
      "reassign-target",
      "checkpoint-handoff",
      "raise-attention",
      "raise-attention",
    ]);
  });

  it("skips reassignment for an attempt that never held a target", () => {
    const untargeted = { ...attempt, targetId: null };
    const decision = planRecovery(untargeted, DEFAULT_FACTORY_POLICY, [
      "resume-same-session",
      "retry-attempt",
    ]);
    expect(decision.rung).toBe("checkpoint-handoff");
  });

  it("goes straight to attention when the attempt budget is spent", () => {
    const last = { ...attempt, attemptNumber: DEFAULT_FACTORY_POLICY.maxAttemptsPerNode };
    const decision = planRecovery(last, DEFAULT_FACTORY_POLICY, []);
    expect(decision.rung).toBe("raise-attention");
    expect(decision.reason).toContain("last the policy allows");
  });

  it("does not retry a missing capability, which retrying cannot fix", () => {
    const blocked = { ...attempt, waitingReason: "missing-capability" as const };
    expect(planRecovery(blocked, DEFAULT_FACTORY_POLICY, []).rung).toBe("raise-attention");
  });

  it("carries the rungs already spent so an attention item can show them", () => {
    const decision = planRecovery(attempt, DEFAULT_FACTORY_POLICY, ["resume-same-session"]);
    expect(decision.attempted).toEqual(["resume-same-session"]);
  });
});

describe("definition validation", () => {
  it("accepts a well-formed graph and orders it for display", () => {
    const definition = definitionOf([
      agentNode("plan"),
      agentNode("build", ["plan"]),
      testNode("test", ["build"]),
      gateNode("pr-ready", ["test"], ["test-results"]),
    ]);
    expect(validateDefinition(definition)).toEqual([]);
    expect(topologicalOrder(definition)?.map((n) => n.id)).toEqual([
      "plan",
      "build",
      "test",
      "pr-ready",
    ]);
  });

  it("reports every problem rather than only the first", () => {
    const definition = definitionOf([
      agentNode("build", ["ghost"]),
      agentNode("build", []),
      gateNode("empty", [], []),
    ]);
    const problems = validateDefinition({
      ...definition,
      nodes: [...definition.nodes, { ...(gateNode("empty2", [], []) as GateNode), checks: [] }],
    });
    const kinds = problems.map((problem) => problem.kind);
    expect(kinds).toContain("duplicate-node");
    expect(kinds).toContain("unknown-dependency");
    expect(kinds).toContain("gate-without-checks");
  });

  it("rejects a cycle and refuses to invent an order for it", () => {
    const definition = definitionOf([agentNode("a", ["b"]), agentNode("b", ["a"])]);
    const problems = validateDefinition(definition);
    expect(problems.some((problem) => problem.kind === "cycle")).toBe(true);
    expect(topologicalOrder(definition)).toBeNull();
  });

  it("rejects a self-dependency", () => {
    const definition = definitionOf([agentNode("a", ["a"])]);
    expect(validateDefinition(definition)).toEqual([{ kind: "self-dependency", nodeId: "a" }]);
  });

  it("requires a review node to declare what it is independent of", () => {
    const review: WorkflowNode = {
      kind: "review",
      id: nodeId("review"),
      title: "review",
      dependsOn: [nodeId("build")],
      requiredCapabilities: [],
      independentOf: [],
    };
    const definition = definitionOf([agentNode("build"), review]);
    expect(validateDefinition(definition)).toEqual([
      { kind: "review-not-independent", nodeId: "review" },
    ]);
  });
});
