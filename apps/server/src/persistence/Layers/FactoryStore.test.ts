import { assert, it } from "@effect/vitest";
import {
  ArtifactId,
  AttentionItemId,
  DEFAULT_FACTORY_POLICY,
  ExecutionTargetId,
  GitRevision,
  NodeAttemptId,
  WorkflowNodeId,
  WorkflowRunId,
  WorkItemId,
  type Artifact,
  type GateResult,
  type NodeAttempt,
  type WorkflowDefinition,
  type WorkflowRun,
} from "@vulcan/contracts";
import { findReadyNodes, isNodeSatisfied } from "@vulcan/shared/factoryKernel";
import { TRACER_BULLET_WORKFLOW_YAML } from "@vulcan/shared/tracerBulletWorkflow";
import { parseWorkflowYaml } from "@vulcan/shared/workflowYaml";
import { Effect, Layer } from "effect";

import { FactoryStore } from "../Services/FactoryStore.ts";
import { FactoryStoreLive } from "./FactoryStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(FactoryStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const parsed = parseWorkflowYaml(TRACER_BULLET_WORKFLOW_YAML);
if (!parsed.ok) throw new Error("tracer bullet workflow must parse");
const definition: WorkflowDefinition = parsed.definition;

const REV_A = GitRevision.makeUnsafe("a".repeat(40));
const REV_B = GitRevision.makeUnsafe("b".repeat(40));
const nodeId = (id: string) => WorkflowNodeId.makeUnsafe(id);

// `it.layer` shares one in-memory database across the block, so each test mints
// its own run rather than colliding on a fixed id.
let runCounter = 0;
const nextRunId = () => WorkflowRunId.makeUnsafe(`run-${(runCounter += 1)}`);

const runOf = (runId: WorkflowRunId, overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: runId,
  definitionId: definition.id,
  definitionVersion: definition.version,
  workItemId: WorkItemId.makeUnsafe("item-1"),
  workspaceId: null,
  projectId: null,
  threadId: null,
  baseRevision: REV_A,
  policyVersion: DEFAULT_FACTORY_POLICY.version,
  state: "pending",
  createdAt: "2026-08-10T00:00:00.000Z",
  endedAt: null,
  ...overrides,
});

const attemptOf = (
  runId: WorkflowRunId,
  node: string,
  state: NodeAttempt["state"],
  overrides: Partial<NodeAttempt> = {},
): NodeAttempt => ({
  id: NodeAttemptId.makeUnsafe(`${runId}-attempt-${node}-${overrides.attemptNumber ?? 1}`),
  runId,
  nodeId: nodeId(node),
  attemptNumber: 1,
  state,
  waitingReason: null,
  targetId: null,
  revision: REV_A,
  startedAt: null,
  lastHeartbeatAt: null,
  endedAt: null,
  failureSummary: null,
  ...overrides,
});

const artifactOf = (id: string, kind: string, revision = REV_A): Artifact => ({
  id: ArtifactId.makeUnsafe(id),
  kind,
  producedByNodeId: nodeId("build"),
  producedByAttemptId: NodeAttemptId.makeUnsafe("attempt-build-1"),
  revision,
  createdAt: "2026-08-10T00:00:00.000Z",
  outcome: "passed",
  uri: null,
  summary: "",
});

const seedRun = Effect.gen(function* () {
  const store = yield* FactoryStore;
  const runId = nextRunId();
  yield* store.putDefinition(definition);
  yield* store.createRun(runOf(runId));
  return { store, runId };
});

layer("FactoryStore", (it) => {
  it.effect("keeps a definition version immutable once a run is pinned to it", () =>
    Effect.gen(function* () {
      const { store } = yield* seedRun;
      // A second write of the same version must not change what the run executed.
      yield* store.putDefinition({ ...definition, name: "tampered", nodes: [] });

      const stored = yield* store.readDefinition(definition.id, definition.version);
      assert.strictEqual(stored?.name, definition.name);
      assert.strictEqual(stored?.nodes.length, definition.nodes.length);
    }),
  );

  it.effect("stores a new version alongside the old one rather than replacing it", () =>
    Effect.gen(function* () {
      const { store } = yield* seedRun;
      yield* store.putDefinition({ ...definition, version: 2, name: "v2" });

      assert.strictEqual((yield* store.readDefinition(definition.id, 1))?.name, definition.name);
      assert.strictEqual((yield* store.readDefinition(definition.id, 2))?.name, "v2");
    }),
  );

  it.effect("rebuilds the exact snapshot the kernel consumes", () =>
    Effect.gen(function* () {
      // This is the property the whole layer exists for: a controller that
      // restarts reads this and continues with nothing lost.
      const store = yield* FactoryStore;
      const runId = nextRunId();
      yield* store.putDefinition(definition);
      yield* store.createRun(runOf(runId));

      yield* store.putAttempt({
        attempt: attemptOf(runId, "plan", "succeeded"),
        attemptedRecovery: [],
      });
      yield* store.putAttempt({
        attempt: attemptOf(runId, "build", "running", {
          targetId: ExecutionTargetId.makeUnsafe("t1"),
        }),
        attemptedRecovery: ["resume-same-session"],
      });
      yield* store.appendArtifacts({
        runId,
        artifacts: [
          artifactOf(`${runId}-a1`, "test-results"),
          artifactOf(`${runId}-a2`, "screenshot"),
        ],
      });
      const gate: GateResult = {
        nodeId: nodeId("pr-ready"),
        runId,
        passed: false,
        revision: REV_A,
        policyVersion: DEFAULT_FACTORY_POLICY.version,
        checks: [
          {
            name: "Tests passed",
            passed: true,
            evidenceArtifactIds: [ArtifactId.makeUnsafe(`${runId}-a1`)],
            detail: "ok",
          },
        ],
        evaluatedAt: "2026-08-10T00:01:00.000Z",
      };
      yield* store.putGateResult(gate);

      const snapshot = yield* store.readRunSnapshot(runId);
      assert.isNotNull(snapshot);
      if (!snapshot) return;

      assert.strictEqual(snapshot.definition.id, definition.id);
      assert.strictEqual(snapshot.attempts.length, 2);
      assert.strictEqual(snapshot.artifacts.length, 2);
      assert.strictEqual(snapshot.currentRevision, REV_A);
      // Booleans survive the 0/1 round trip.
      assert.strictEqual(snapshot.gateResults[0]?.passed, false);
      assert.deepStrictEqual(snapshot.gateResults[0]?.checks, gate.checks);

      // And the kernel can act on it directly, which is the real assertion.
      assert.isTrue(isNodeSatisfied(snapshot, nodeId("plan")));
      assert.deepStrictEqual(
        findReadyNodes(snapshot, definition.policy).map((entry) => entry.node.id),
        [],
      );
    }),
  );

  it.effect("carries the recovery ladder across a restart so it cannot loop", () =>
    Effect.gen(function* () {
      const { store, runId } = yield* seedRun;
      const attempt = attemptOf(runId, "build", "running");
      yield* store.putAttempt({
        attempt,
        attemptedRecovery: ["resume-same-session", "retry-attempt"],
      });
      assert.deepStrictEqual(yield* store.readAttemptedRecovery(attempt.id), [
        "resume-same-session",
        "retry-attempt",
      ]);
    }),
  );

  it.effect("updates an attempt in place rather than accumulating rows", () =>
    Effect.gen(function* () {
      const { store, runId } = yield* seedRun;
      const attempt = attemptOf(runId, "build", "running");
      yield* store.putAttempt({ attempt, attemptedRecovery: [] });
      yield* store.putAttempt({
        attempt: { ...attempt, state: "succeeded", endedAt: "2026-08-10T00:05:00.000Z" },
        attemptedRecovery: [],
      });

      const snapshot = yield* store.readRunSnapshot(runId);
      assert.strictEqual(snapshot?.attempts.length, 1);
      assert.strictEqual(snapshot?.attempts[0]?.state, "succeeded");
    }),
  );

  it.effect("keeps a superseded gate verdict when the revision moves", () =>
    Effect.gen(function* () {
      const { store, runId } = yield* seedRun;
      const base: GateResult = {
        nodeId: nodeId("pr-ready"),
        runId,
        passed: true,
        revision: REV_A,
        policyVersion: 1,
        checks: [],
        evaluatedAt: "2026-08-10T00:01:00.000Z",
      };
      yield* store.putGateResult(base);
      yield* store.putGateResult({ ...base, revision: REV_B, passed: false });

      const snapshot = yield* store.readRunSnapshot(runId);
      // Two rows, not one: an audit can see the pass existed and no longer counts.
      assert.strictEqual(snapshot?.gateResults.length, 2);
      const atA = snapshot?.gateResults.find((result) => result.revision === REV_A);
      assert.strictEqual(atA?.passed, true);
    }),
  );

  it.effect("re-judging at the same revision replaces the verdict", () =>
    Effect.gen(function* () {
      const { store, runId } = yield* seedRun;
      const base: GateResult = {
        nodeId: nodeId("pr-ready"),
        runId,
        passed: false,
        revision: REV_A,
        policyVersion: 1,
        checks: [],
        evaluatedAt: "2026-08-10T00:01:00.000Z",
      };
      yield* store.putGateResult(base);
      yield* store.putGateResult({ ...base, passed: true });

      const snapshot = yield* store.readRunSnapshot(runId);
      assert.strictEqual(snapshot?.gateResults.length, 1);
      assert.strictEqual(snapshot?.gateResults[0]?.passed, true);
    }),
  );

  it.effect("moving the revision invalidates verification but not the work that moved it", () =>
    Effect.gen(function* () {
      const { store, runId } = yield* seedRun;
      yield* store.putAttempt({
        attempt: attemptOf(runId, "plan", "succeeded"),
        attemptedRecovery: [],
      });
      yield* store.putAttempt({
        attempt: attemptOf(runId, "build", "succeeded"),
        attemptedRecovery: [],
      });
      yield* store.putAttempt({
        attempt: attemptOf(runId, "test", "succeeded"),
        attemptedRecovery: [],
      });
      yield* store.setRunRevision({ runId, revision: REV_B });

      const snapshot = yield* store.readRunSnapshot(runId);
      assert.isNotNull(snapshot);
      if (!snapshot) return;
      assert.strictEqual(snapshot.currentRevision, REV_B);
      assert.isTrue(isNodeSatisfied(snapshot, nodeId("build")));
      assert.isFalse(isNodeSatisfied(snapshot, nodeId("test")));
    }),
  );

  it.effect("lists only runs the controller should still work on", () =>
    Effect.gen(function* () {
      const { store, runId } = yield* seedRun;
      const finishedId = nextRunId();
      yield* store.createRun(runOf(finishedId, { state: "succeeded" }));
      const active = yield* store.listActiveRuns();
      // Only the pending run; the finished one is not the controller's problem.
      assert.isTrue(active.some((entry) => entry.run.id === runId));
      assert.isFalse(active.some((entry) => entry.run.id === finishedId));
    }),
  );

  it.effect("finds in-flight attempts across every run for the stall sweep", () =>
    Effect.gen(function* () {
      const { store, runId } = yield* seedRun;
      yield* store.putAttempt({
        attempt: attemptOf(runId, "plan", "succeeded"),
        attemptedRecovery: [],
      });
      yield* store.putAttempt({
        attempt: attemptOf(runId, "build", "running"),
        attemptedRecovery: [],
      });
      yield* store.putAttempt({
        attempt: attemptOf(runId, "review", "waiting-human", {
          waitingReason: "approval-required",
        }),
        attemptedRecovery: [],
      });

      // The sweep is deliberately cross-run -- one tick supervises every run -- so
      // this asserts on its own run's slice of the result.
      const active = yield* store.listActiveAttempts();
      assert.deepStrictEqual(
        active
          .filter((attempt) => attempt.runId === runId)
          .map((attempt) => attempt.nodeId)
          .toSorted(),
        ["build", "review"],
      );
      // A settled attempt is never in flight.
      assert.isFalse(
        active.some((attempt) => attempt.runId === runId && attempt.nodeId === "plan"),
      );
    }),
  );

  it.effect("records a heartbeat without touching anything else", () =>
    Effect.gen(function* () {
      const { store, runId } = yield* seedRun;
      const attempt = attemptOf(runId, "build", "running");
      yield* store.putAttempt({ attempt, attemptedRecovery: [] });
      yield* store.recordHeartbeat({ attemptId: attempt.id, at: "2026-08-10T00:09:00.000Z" });

      const snapshot = yield* store.readRunSnapshot(runId);
      assert.strictEqual(snapshot?.attempts[0]?.lastHeartbeatAt, "2026-08-10T00:09:00.000Z");
      assert.strictEqual(snapshot?.attempts[0]?.state, "running");
    }),
  );

  it.effect("opens and resolves attention items", () =>
    Effect.gen(function* () {
      const { store, runId } = yield* seedRun;
      const id = AttentionItemId.makeUnsafe(`${runId}-attn-1`);
      yield* store.createAttentionItem({
        id,
        runId,
        nodeId: nodeId("build"),
        attemptId: null,
        request: "Approve the migration?",
        reason: "recovery-exhausted",
        attemptedRecovery: ["resume-same-session", "retry-attempt"],
        workspaceId: null,
        createdAt: "2026-08-10T00:02:00.000Z",
        resolvedAt: null,
      });

      const open = yield* store.listOpenAttentionItems();
      assert.strictEqual(open.length, 1);
      // The rungs already tried travel with the item, so the operator can see
      // what was attempted before they were asked.
      assert.deepStrictEqual(open[0]?.attemptedRecovery, ["resume-same-session", "retry-attempt"]);

      yield* store.resolveAttentionItem({
        attentionItemId: id,
        resolution: "retried by hand",
        at: "2026-08-10T00:03:00.000Z",
      });
      assert.deepStrictEqual(yield* store.listOpenAttentionItems(), []);
    }),
  );

  it.effect("reclaims a lease whose deadline passed", () =>
    Effect.gen(function* () {
      // A target held by a worker that died must free itself rather than stay
      // reserved by an attempt nobody can reach.
      const { store, runId } = yield* seedRun;
      const targetId = ExecutionTargetId.makeUnsafe(`${runId}-t1`);
      yield* store.putTarget({
        id: targetId,
        label: "main",
        capabilities: ["shell", "git"],
        maxConcurrentLeases: 2,
        online: true,
        lastSeenAt: null,
      });
      const attemptId = NodeAttemptId.makeUnsafe(`${runId}-attempt-build-1`);
      yield* store.acquireLease({
        attemptId,
        targetId,
        runId,
        acquiredAt: "2026-08-10T00:00:00.000Z",
        expiresAt: "2026-08-10T00:10:00.000Z",
      });

      assert.strictEqual((yield* store.listExpiredLeases("2026-08-10T00:05:00.000Z")).length, 0);
      assert.strictEqual((yield* store.listExpiredLeases("2026-08-10T00:20:00.000Z")).length, 1);

      yield* store.releaseLease(attemptId);
      assert.deepStrictEqual(yield* store.listLeases(), []);
    }),
  );

  it.effect("round-trips a target's reported capabilities and online flag", () =>
    Effect.gen(function* () {
      const store = yield* FactoryStore;
      yield* store.putTarget({
        id: ExecutionTargetId.makeUnsafe("mac"),
        label: "laptop",
        capabilities: ["shell", "browser"],
        maxConcurrentLeases: 1,
        online: false,
        lastSeenAt: "2026-08-10T00:00:00.000Z",
      });
      const targets = yield* store.listTargets();
      assert.strictEqual(targets[0]?.online, false);
      assert.deepStrictEqual(targets[0]?.capabilities, ["shell", "browser"]);
    }),
  );

  it.effect("returns null for a run that does not exist", () =>
    Effect.gen(function* () {
      const store = yield* FactoryStore;
      assert.strictEqual(yield* store.readRunSnapshot(WorkflowRunId.makeUnsafe("absent")), null);
    }),
  );
});
