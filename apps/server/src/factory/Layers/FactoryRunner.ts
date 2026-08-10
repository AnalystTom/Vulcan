import { randomUUID } from "node:crypto";

import {
  type Artifact,
  ArtifactId,
  type AttentionItem,
  AttentionItemId,
  type ExecutionTarget,
  ExecutionTargetId,
  type NodeAttempt,
  NodeAttemptId,
  type RecoveryRung,
  type WorkflowNode,
  type WorkflowRun,
  WorkflowRunId,
} from "@vulcan/contracts";
import type { NodeOutcome } from "@vulcan/shared/factoryController";
import {
  deriveRunState,
  detectStall,
  evaluateGate,
  findReadyNodes,
  planRecovery,
  type RunSnapshot,
  selectTarget,
  transitionAttempt,
} from "@vulcan/shared/factoryKernel";
import { Cause, Duration, Effect, Layer, Schedule } from "effect";

import { createLogger } from "../../logger.ts";
import { FactoryStore } from "../../persistence/Services/FactoryStore.ts";
import { FactoryWorkspaces } from "../Services/FactoryWorkspaces.ts";
import { executeFactoryNode, readHeadRevision } from "../nodeExecutor.ts";
import {
  FactoryRunError,
  FactoryRunner,
  type FactoryRunnerShape,
  type StartRunInput,
  type TickReport,
} from "../Services/FactoryRunner.ts";

const logger = createLogger("factory");

/**
 * The local server's Execution Target.
 *
 * It reports exactly what this process can do: run shell commands, use git, and
 * run Node. Deliberately absent are `agent`, `browser`, `computer-use`, and
 * `lavish` -- those need integrations that are not wired, and claiming them would
 * make the scheduler dispatch work nothing can perform. A node requiring one gets
 * `missing-capability`, which the kernel routes straight to a person.
 */
const LOCAL_TARGET_ID = ExecutionTargetId.makeUnsafe("local");
const LOCAL_TARGET_CAPABILITIES: ExecutionTarget["capabilities"] = ["git", "shell", "node"];

/**
 * Concurrent nodes per tick on the local target.
 *
 * Bounded because these are real subprocesses on the machine hosting the UI; a
 * fan-out node could otherwise start dozens of test suites at once and make the
 * app unusable.
 */
const LOCAL_TARGET_MAX_LEASES = 4;

/**
 * How often the controller wakes.
 *
 * Fast enough that a run feels responsive, slow enough that an idle server is not
 * doing constant database work. Each tick is a handful of indexed reads when
 * nothing is active.
 */
export const FACTORY_TICK_INTERVAL_MS = 2_000;

const makeFactoryRunner = Effect.gen(function* () {
  const store = yield* FactoryStore;
  const workspaces = yield* FactoryWorkspaces;

  const localTarget: FactoryRunnerShape["localTarget"] = () =>
    Effect.gen(function* () {
      const target: ExecutionTarget = {
        id: LOCAL_TARGET_ID,
        label: "This machine",
        capabilities: LOCAL_TARGET_CAPABILITIES,
        maxConcurrentLeases: LOCAL_TARGET_MAX_LEASES,
        online: true,
        lastSeenAt: new Date().toISOString(),
      };
      yield* store.putTarget(target);
      return target;
    });

  const readWorkspaceRevision: FactoryRunnerShape["readWorkspaceRevision"] = (workspacePath) =>
    Effect.promise(() => readHeadRevision(workspacePath));

  /**
   * Where a run executes.
   *
   * Derived from the thread's workspace rather than stored on the run, using the
   * same resolver terminals, checkpoints, and the agent gateway already use. A
   * Run belongs to a Workspace and the Workspace owns its worktree, so copying
   * the path onto the run would duplicate a fact that can then disagree -- and a
   * thread handed off from local to a worktree would leave the run pointing at
   * the old checkout.
   *
   * It also means the path survives a restart for free: it is re-derived from
   * the projection every tick rather than remembered.
   */
  const readWorkspacePath: FactoryRunnerShape["readWorkspacePath"] = (runId) =>
    Effect.gen(function* () {
      const stored = yield* store.readRun(runId);
      const threadId = stored?.run.threadId ?? null;
      if (threadId === null) return null;
      return yield* workspaces.resolveThreadWorkspacePath(threadId);
    });

  const startRun: FactoryRunnerShape["startRun"] = (input: StartRunInput) =>
    Effect.gen(function* () {
      const workspacePath = yield* workspaces.resolveThreadWorkspacePath(input.threadId);
      if (workspacePath === null) {
        return yield* new FactoryRunError({
          message: `Thread ${input.threadId} has no materialized workspace yet, so there is nowhere to run.`,
        });
      }

      const revision = yield* readWorkspaceRevision(workspacePath);
      if (revision === null) {
        // A run with no revision could produce evidence pinned to nothing, which
        // would make every later gate meaningless. Refuse at the boundary.
        return yield* new FactoryRunError({
          message: `${workspacePath} is not a git checkout, so a run started there could not pin its evidence to a revision.`,
        });
      }

      yield* store.putDefinition(input.definition);

      const run: WorkflowRun = {
        id: WorkflowRunId.makeUnsafe(`run-${randomUUID()}`),
        definitionId: input.definition.id,
        definitionVersion: input.definition.version,
        workItemId: input.workItemId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        threadId: input.threadId,
        baseRevision: revision,
        policyVersion: input.definition.policy.version,
        state: "pending",
        createdAt: new Date().toISOString(),
        endedAt: null,
      };
      yield* store.createRun(run);
      yield* localTarget();
      return run;
    });

  /** Applies a kernel transition, treating a refusal as the controller bug it is. */
  const advance = (
    attempt: NodeAttempt,
    to: NodeAttempt["state"],
    options: {
      now: string;
      waitingReason?: NodeAttempt["waitingReason"];
      failureSummary?: string | null;
    },
  ): Effect.Effect<NodeAttempt, FactoryRunError> => {
    const result = transitionAttempt(attempt, to, options);
    return result.ok
      ? Effect.succeed(result.attempt)
      : Effect.fail(
          new FactoryRunError({
            message: `Illegal attempt transition ${attempt.state} -> ${to} (${result.reason}).`,
          }),
        );
  };

  const raiseAttention = (item: AttentionItem) => store.createAttentionItem(item);

  const newAttentionId = () => AttentionItemId.makeUnsafe(`attention-${randomUUID()}`);

  const runOneNode = Effect.fn("factory.dispatchNode")(function* (input: {
    runId: WorkflowRunId;
    snapshot: RunSnapshot;
    node: WorkflowNode;
    attemptNumber: number;
    workspacePath: string;
  }) {
    const policy = input.snapshot.definition.policy;
    const targets = yield* store.listTargets();
    const leases = yield* store.listLeases();
    const now = () => new Date().toISOString();

    let attempt: NodeAttempt = {
      id: NodeAttemptId.makeUnsafe(`attempt-${randomUUID()}`),
      runId: input.runId,
      nodeId: input.node.id,
      attemptNumber: input.attemptNumber,
      state: "queued",
      waitingReason: null,
      targetId: null,
      revision: input.snapshot.currentRevision,
      startedAt: null,
      lastHeartbeatAt: null,
      endedAt: null,
      failureSummary: null,
    };

    attempt = yield* advance(attempt, "provisioning", { now: now() });
    const selection = selectTarget(input.node.requiredCapabilities, targets, leases);

    if (selection.kind === "none-available") {
      attempt = yield* advance(attempt, "failed", {
        now: now(),
        failureSummary: `No execution target is available: ${selection.reason}.`,
      });
      yield* store.putAttempt({ attempt, attemptedRecovery: [] });

      const decision = planRecovery({ ...attempt, waitingReason: selection.reason }, policy, []);
      if (decision.rung !== "raise-attention") {
        // The ladder wants to try again; nothing to do now, the next tick will.
        return { dispatched: false, attentionRaised: false };
      }
      yield* raiseAttention({
        id: newAttentionId(),
        runId: input.runId,
        nodeId: input.node.id,
        attemptId: attempt.id,
        request: `"${input.node.title}" needs a target that reports ${input.node.requiredCapabilities.join(", ") || "no special capability"}, and none is available. ${decision.reason} How should this proceed?`,
        reason: selection.reason,
        attemptedRecovery: decision.attempted,
        workspaceId: null,
        createdAt: now(),
        resolvedAt: null,
      });
      return { dispatched: false, attentionRaised: true };
    }

    attempt = { ...attempt, targetId: selection.targetId };
    attempt = yield* advance(attempt, "ready", { now: now() });
    attempt = yield* advance(attempt, "running", { now: now() });
    yield* store.putAttempt({ attempt, attemptedRecovery: [] });
    yield* store.acquireLease({
      targetId: selection.targetId,
      attemptId: attempt.id,
      runId: input.runId,
      acquiredAt: now(),
      expiresAt: new Date(Date.now() + policy.attemptTimeoutSeconds * 1000).toISOString(),
    });

    const outcome: NodeOutcome = yield* Effect.promise(() =>
      executeFactoryNode(input.node, {
        workspacePath: input.workspacePath,
        timeoutSeconds: policy.attemptTimeoutSeconds,
      }),
    );

    // The lease goes back whatever happened; an ended attempt must not keep a
    // target reserved.
    yield* store.releaseLease(attempt.id);

    if (outcome.kind === "waiting") {
      const waitingState =
        outcome.reason === "approval-required" || outcome.reason === "login-required"
          ? "waiting-human"
          : outcome.reason === "provider-question"
            ? "waiting-agent"
            : "waiting-external";
      attempt = yield* advance(attempt, waitingState, {
        now: now(),
        waitingReason: outcome.reason,
      });
      yield* store.putAttempt({ attempt, attemptedRecovery: [] });

      if (waitingState !== "waiting-human") return { dispatched: true, attentionRaised: false };
      yield* raiseAttention({
        id: newAttentionId(),
        runId: input.runId,
        nodeId: input.node.id,
        attemptId: attempt.id,
        request:
          input.node.kind === "approval"
            ? input.node.question
            : `"${input.node.title}" is waiting on your decision.`,
        reason: outcome.reason,
        attemptedRecovery: [],
        workspaceId: null,
        createdAt: now(),
        resolvedAt: null,
      });
      return { dispatched: true, attentionRaised: true };
    }

    if (outcome.kind === "failed") {
      attempt = yield* advance(attempt, "failed", {
        now: now(),
        failureSummary: outcome.failureSummary,
      });
      yield* store.putAttempt({ attempt, attemptedRecovery: [] });
      return { dispatched: true, attentionRaised: false };
    }

    // The revision the executor reports wins: a node that committed has moved the
    // workspace, and everything verified before it is now stale.
    yield* store.setRunRevision({ runId: input.runId, revision: outcome.revision });
    const produced: Artifact[] = outcome.artifacts.map((draft) => ({
      id: ArtifactId.makeUnsafe(`artifact-${randomUUID()}`),
      kind: draft.kind,
      producedByNodeId: input.node.id,
      producedByAttemptId: attempt.id,
      revision: outcome.revision,
      createdAt: now(),
      outcome: draft.outcome,
      uri: draft.uri ?? null,
      summary: draft.summary,
    }));
    yield* store.appendArtifacts({ runId: input.runId, artifacts: produced });

    attempt = yield* advance({ ...attempt, revision: outcome.revision }, "verifying", {
      now: now(),
    });
    yield* store.putAttempt({ attempt, attemptedRecovery: [] });

    // Re-read rather than patching the in-memory snapshot: the gate must judge
    // exactly what is stored, including the artifacts just written.
    const refreshed = yield* store.readRunSnapshot(input.runId);
    let accepted = outcome.succeeded;
    if (input.node.kind === "gate" && refreshed) {
      const result = evaluateGate(input.node, refreshed, policy, now());
      yield* store.putGateResult({ ...result, runId: input.runId });
      accepted = result.passed;
    }

    attempt = accepted
      ? yield* advance(attempt, "succeeded", { now: now() })
      : yield* advance(attempt, "failed", {
          now: now(),
          failureSummary: outcome.failureSummary ?? "Verification did not pass.",
        });
    yield* store.putAttempt({ attempt, attemptedRecovery: [] });
    return { dispatched: true, attentionRaised: false };
  });

  /**
   * Supervise attempts that are in flight.
   *
   * This is where `detectStall` finally fires: the drive-to-standstill loop in
   * the shared controller awaits each node and so never has an in-flight attempt
   * to watch, but a poller does.
   */
  const superviseStalls = Effect.fn("factory.superviseStalls")(function* () {
    const active = yield* store.listActiveAttempts();
    const now = new Date().toISOString();
    let stalls = 0;
    let attention = 0;

    for (const attempt of active) {
      const stored = yield* store.readRun(attempt.runId);
      if (!stored) continue;
      const policy = stored.definition.policy;
      const verdict = detectStall(attempt, policy, now);
      if (verdict.kind === "healthy") continue;
      stalls += 1;

      const spent = yield* store.readAttemptedRecovery(attempt.id);
      const decision = planRecovery(attempt, policy, spent);
      const nextSpent: RecoveryRung[] = [...spent, decision.rung];

      if (decision.rung === "raise-attention") {
        // Mark the attempt lost rather than leaving it in flight forever: a
        // disconnected attempt must reconcile to an explicit outcome.
        const lost = transitionAttempt(attempt, "lost", {
          now,
          failureSummary: `Stalled (${verdict.cause}). ${decision.reason}`,
        });
        if (lost.ok)
          yield* store.putAttempt({ attempt: lost.attempt, attemptedRecovery: nextSpent });
        yield* store.releaseLease(attempt.id);
        yield* raiseAttention({
          id: newAttentionId(),
          runId: attempt.runId,
          nodeId: attempt.nodeId,
          attemptId: attempt.id,
          request: `"${attempt.nodeId}" stalled (${verdict.cause}) and automatic recovery is exhausted. What should happen next?`,
          reason: "recovery-exhausted",
          attemptedRecovery: decision.attempted,
          workspaceId: null,
          createdAt: now,
          resolvedAt: null,
        });
        attention += 1;
        continue;
      }

      // An automatic rung: end this attempt so the next tick schedules a fresh
      // one, and record the rung so the ladder cannot repeat itself.
      const failed = transitionAttempt(attempt, "failed", {
        now,
        failureSummary: `Stalled (${verdict.cause}). Recovery: ${decision.rung}.`,
      });
      if (failed.ok) {
        yield* store.putAttempt({ attempt: failed.attempt, attemptedRecovery: nextSpent });
      }
      yield* store.releaseLease(attempt.id);
    }

    return { stalls, attention };
  });

  const tick: FactoryRunnerShape["tick"] = () =>
    Effect.gen(function* () {
      const now = new Date().toISOString();

      // Reclaim first: a target held by a dead worker must be free before this
      // tick tries to schedule onto it.
      const expired = yield* store.listExpiredLeases(now);
      for (const lease of expired) yield* store.releaseLease(lease.attemptId);

      const supervision = yield* superviseStalls();

      const runs = yield* store.listActiveRuns();
      let dispatched = 0;
      let attention = supervision.attention;

      for (const stored of runs) {
        const snapshot = yield* store.readRunSnapshot(stored.run.id);
        if (!snapshot) continue;

        const workspacePath = yield* readWorkspacePath(stored.run.id);
        if (!workspacePath) {
          // A run whose thread has no materialized workspace yet (a worktree
          // still being created, say) has nowhere to execute. It is left for a
          // later tick rather than run somewhere arbitrary.
          continue;
        }

        const ready = findReadyNodes(snapshot, stored.definition.policy);
        for (const entry of ready) {
          const result = yield* runOneNode({
            runId: stored.run.id,
            snapshot,
            node: entry.node,
            attemptNumber: entry.nextAttemptNumber,
            workspacePath,
          });
          if (result.dispatched) dispatched += 1;
          if (result.attentionRaised) attention += 1;
        }

        const finalSnapshot = yield* store.readRunSnapshot(stored.run.id);
        if (finalSnapshot) {
          const state = deriveRunState(finalSnapshot, stored.definition.policy);
          if (state !== stored.run.state) {
            yield* store.setRunState({
              runId: stored.run.id,
              state,
              endedAt:
                state === "succeeded" || state === "failed" || state === "cancelled" ? now : null,
            });
          }
        }
      }

      return {
        runsExamined: runs.length,
        nodesDispatched: dispatched,
        stallsDetected: supervision.stalls,
        attentionItemsRaised: attention,
        leasesReclaimed: expired.length,
      } satisfies TickReport;
    });

  const runTickSafely = tick().pipe(
    Effect.tap((report) =>
      report.nodesDispatched > 0 || report.attentionItemsRaised > 0
        ? Effect.sync(() =>
            logger.info("factory tick", {
              runs: report.runsExamined,
              dispatched: report.nodesDispatched,
              stalls: report.stallsDetected,
              attention: report.attentionItemsRaised,
              leasesReclaimed: report.leasesReclaimed,
            }),
          )
        : Effect.void,
    ),
    // One bad run must not stop the controller supervising every other run.
    Effect.catchCause((cause) =>
      Effect.sync(() => logger.warn("factory tick failed", { cause: Cause.pretty(cause) })),
    ),
  );

  const start: FactoryRunnerShape["start"] = () =>
    Effect.forkScoped(
      localTarget().pipe(
        Effect.catchCause(() => Effect.void),
        Effect.andThen(
          runTickSafely.pipe(
            Effect.repeat(Schedule.spaced(Duration.millis(FACTORY_TICK_INTERVAL_MS))),
          ),
        ),
      ),
    ).pipe(Effect.asVoid);

  return {
    startRun,
    tick,
    readWorkspacePath,
    localTarget,
    readWorkspaceRevision,
    start,
  } satisfies FactoryRunnerShape;
});

export const FactoryRunnerLive = Layer.effect(FactoryRunner, makeFactoryRunner);
