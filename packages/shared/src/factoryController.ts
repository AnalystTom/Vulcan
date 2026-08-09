// FILE: factoryController.ts
// Purpose: Drive a Workflow Run: dispatch ready nodes, apply their outcomes,
// evaluate gates, supervise stalls, and stop when there is nothing left to do.
// Layer: shared domain logic
//
// The controller is the loop; the kernel is the decisions. Everything the loop
// needs from the outside world -- running a node, reading the clock, minting ids
// -- arrives through `ControllerEnvironment`, so the same loop runs against real
// agents and real git in production and against deterministic executors in a
// test, with no branch anywhere saying which it is.
//
// This loop awaits each node, so it has no in-flight attempt to supervise: stall
// detection (`detectStall` in the kernel) belongs to the long-running controller
// that polls attempts between turns, and is deliberately not wired here rather
// than being called somewhere it could never fire.
//
// Two properties are load-bearing and are what the injected seam buys:
//
//   * The loop never decides an outcome. It asks the executor what happened and
//     the kernel what that means. A node "succeeds" only by passing through
//     verification, and a gate passes only over evidence that exists.
//   * Every artifact is stamped with the revision the executor reports *after*
//     doing its work, not the one it started from. That is what makes evidence
//     pinning real rather than decorative: a build that commits moves the
//     revision, and everything judged before it stops counting.

import type {
  Artifact,
  ArtifactId,
  AttentionItem,
  AttentionItemId,
  ExecutionTarget,
  GateResult,
  GitRevision,
  NodeAttempt,
  NodeAttemptId,
  RecoveryRung,
  TargetLease,
  WaitingReason,
  WorkflowNode,
  WorkflowRunId,
  WorkflowRunState,
} from "@vulcan/contracts";

import {
  deriveRunState,
  evaluateGate,
  findReadyNodes,
  planRecovery,
  type RunSnapshot,
  selectTarget,
  transitionAttempt,
} from "./factoryKernel";

/** What an executor reports back after running one node. */
export type NodeOutcome =
  | {
      readonly kind: "produced";
      /** Revision the workspace is at now, which the node may have moved. */
      readonly revision: GitRevision;
      /** Artifacts, without ids or revisions -- the controller stamps both. */
      readonly artifacts: readonly NodeArtifactDraft[];
      /** False when the work ran but did not succeed, e.g. a failing test suite. */
      readonly succeeded: boolean;
      readonly failureSummary?: string;
    }
  | { readonly kind: "waiting"; readonly reason: WaitingReason }
  | { readonly kind: "failed"; readonly failureSummary: string };

export interface NodeArtifactDraft {
  readonly kind: string;
  readonly outcome: Artifact["outcome"];
  readonly summary: string;
  readonly uri?: string | null;
}

export interface ControllerEnvironment {
  /** Runs one node. The only place real work happens. */
  readonly executeNode: (input: {
    readonly node: WorkflowNode;
    readonly attempt: NodeAttempt;
    readonly snapshot: RunSnapshot;
  }) => Promise<NodeOutcome>;
  readonly now: () => string;
  readonly nextAttemptId: () => NodeAttemptId;
  readonly nextArtifactId: () => ArtifactId;
  readonly nextAttentionItemId: () => AttentionItemId;
  readonly targets: readonly ExecutionTarget[];
  /** Current revision at the moment the run starts. */
  readonly initialRevision: GitRevision;
}

export interface ControllerResult {
  readonly snapshot: RunSnapshot;
  readonly state: WorkflowRunState;
  readonly leases: readonly TargetLease[];
  readonly attentionItems: readonly AttentionItem[];
  /** Turns the loop took, for spotting a workflow that churns. */
  readonly turns: number;
}

/**
 * A hard ceiling on loop iterations.
 *
 * Policy already bounds attempts per node, so hitting this means the loop itself
 * is not converging -- a bug, not a slow workflow. Stopping is better than
 * spinning, and the returned state makes it visible.
 */
const MAX_TURNS = 500;

/**
 * Runs a workflow to a standstill.
 *
 * "Standstill" is deliberately not "completion": the loop stops when nothing is
 * ready, which covers success, failure, and blocked-on-a-person alike. The caller
 * reads `state` to find out which, rather than the loop deciding it is finished.
 */
export async function driveRun(
  runId: WorkflowRunId,
  definition: RunSnapshot["definition"],
  environment: ControllerEnvironment,
): Promise<ControllerResult> {
  const policy = definition.policy;
  let snapshot: RunSnapshot = {
    definition,
    attempts: [],
    artifacts: [],
    gateResults: [],
    currentRevision: environment.initialRevision,
  };
  let leases: TargetLease[] = [];
  const attentionItems: AttentionItem[] = [];
  // Recovery rungs already spent, per node. Held by the loop rather than the
  // kernel so the kernel stays a pure function of the values it is handed.
  const spentRungs = new Map<string, RecoveryRung[]>();

  let turns = 0;
  while (turns < MAX_TURNS) {
    turns += 1;

    const ready = findReadyNodes(snapshot, policy);
    if (ready.length === 0) break;

    let progressed = false;
    for (const entry of ready) {
      const now = environment.now();
      const selection = selectTarget(entry.requiredCapabilities, environment.targets, leases);

      let attempt: NodeAttempt = {
        id: environment.nextAttemptId(),
        runId,
        nodeId: entry.node.id,
        attemptNumber: entry.nextAttemptNumber,
        state: "queued",
        waitingReason: null,
        targetId: null,
        revision: snapshot.currentRevision,
        startedAt: null,
        lastHeartbeatAt: null,
        endedAt: null,
        failureSummary: null,
      };

      attempt = applyTransition(attempt, "provisioning", { now });

      if (selection.kind === "none-available") {
        // Provisioning failed before any work began. Recorded as a failed attempt
        // with the reason, so the supervisor can decide whether waiting helps.
        attempt = applyTransition(attempt, "failed", {
          now,
          failureSummary: `No execution target is available: ${selection.reason}.`,
        });
        snapshot = { ...snapshot, attempts: [...snapshot.attempts, attempt] };
        const item = superviseFailure(
          runId,
          attempt,
          selection.reason,
          policy,
          spentRungs,
          environment,
        );
        if (item) attentionItems.push(item);
        progressed = true;
        continue;
      }

      attempt = { ...attempt, targetId: selection.targetId };
      leases = [
        ...leases,
        {
          targetId: selection.targetId,
          attemptId: attempt.id,
          runId,
          acquiredAt: now,
          expiresAt: addSeconds(now, policy.attemptTimeoutSeconds),
        },
      ];

      attempt = applyTransition(attempt, "ready", { now });
      attempt = applyTransition(attempt, "running", { now: environment.now() });
      snapshot = { ...snapshot, attempts: [...snapshot.attempts, attempt] };

      const outcome = await environment.executeNode({ node: entry.node, attempt, snapshot });
      const completedAt = environment.now();

      // Whatever happened, the lease is released here: an attempt that ends must
      // not keep a target reserved.
      leases = leases.filter((lease) => lease.attemptId !== attempt.id);

      let next: NodeAttempt;
      if (outcome.kind === "waiting") {
        const waitingState =
          outcome.reason === "approval-required" || outcome.reason === "login-required"
            ? "waiting-human"
            : outcome.reason === "provider-question"
              ? "waiting-agent"
              : "waiting-external";
        next = applyTransition(attempt, waitingState, {
          now: completedAt,
          waitingReason: outcome.reason,
        });
      } else if (outcome.kind === "failed") {
        next = applyTransition(attempt, "failed", {
          now: completedAt,
          failureSummary: outcome.failureSummary,
        });
      } else {
        // The revision the executor reports wins. A build that committed has
        // moved the workspace, and everything judged before it is now stale.
        snapshot = { ...snapshot, currentRevision: outcome.revision };
        const produced = outcome.artifacts.map(
          (draft): Artifact => ({
            id: environment.nextArtifactId(),
            kind: draft.kind,
            producedByNodeId: entry.node.id,
            producedByAttemptId: attempt.id,
            revision: outcome.revision,
            createdAt: completedAt,
            outcome: draft.outcome,
            uri: draft.uri ?? null,
            summary: draft.summary,
          }),
        );
        snapshot = { ...snapshot, artifacts: [...snapshot.artifacts, ...produced] };

        // Verification is not a formality: a gate node is judged here, and any
        // other node's own evidence is what decides whether it succeeded.
        const verifying = applyTransition({ ...attempt, revision: outcome.revision }, "verifying", {
          now: completedAt,
        });

        let accepted = outcome.succeeded;
        if (entry.node.kind === "gate") {
          const result = evaluateGate(entry.node, snapshot, policy, completedAt);
          snapshot = { ...snapshot, gateResults: [...snapshot.gateResults, result] };
          accepted = result.passed;
        }

        next = accepted
          ? applyTransition(verifying, "succeeded", { now: completedAt })
          : applyTransition(verifying, "failed", {
              now: completedAt,
              failureSummary: outcome.failureSummary ?? "Verification did not pass.",
            });
      }

      snapshot = {
        ...snapshot,
        attempts: snapshot.attempts.map((candidate) =>
          candidate.id === attempt.id ? next : candidate,
        ),
      };

      if (next.state === "failed" || next.state === "lost") {
        const item = superviseFailure(runId, next, null, policy, spentRungs, environment);
        if (item) attentionItems.push(item);
      }
      // A node waiting on a person cannot be advanced by the loop; raising the
      // Attention Item is what hands it over rather than spinning on it.
      if (next.state === "waiting-human") {
        attentionItems.push({
          id: environment.nextAttentionItemId(),
          runId,
          nodeId: entry.node.id,
          attemptId: next.id,
          request: describeWaitingRequest(entry.node, next.waitingReason),
          reason: next.waitingReason ?? "approval-required",
          attemptedRecovery: [],
          workspaceId: null,
          createdAt: completedAt,
          resolvedAt: null,
        });
      }

      progressed = true;
    }

    if (!progressed) break;
  }

  return {
    snapshot,
    state: deriveRunState(snapshot, policy),
    leases,
    attentionItems,
    turns,
  };
}

/**
 * Applies a transition the loop believes is legal.
 *
 * The kernel refuses illegal transitions as values; the loop only ever makes
 * legal ones, so a refusal here is a controller bug and throwing surfaces it in a
 * test rather than letting a run continue in a state nobody designed.
 */
function applyTransition(
  attempt: NodeAttempt,
  to: NodeAttempt["state"],
  options: { now: string; waitingReason?: WaitingReason | null; failureSummary?: string | null },
): NodeAttempt {
  const result = transitionAttempt(attempt, to, options);
  if (!result.ok) {
    throw new Error(
      `Controller attempted an illegal transition ${attempt.state} -> ${to} (${result.reason}).`,
    );
  }
  return result.attempt;
}

/**
 * Runs the recovery ladder for a failed attempt, producing an Attention Item only
 * once the automatic rungs are spent.
 */
function superviseFailure(
  runId: WorkflowRunId,
  attempt: NodeAttempt,
  waitingReason: WaitingReason | null,
  policy: RunSnapshot["definition"]["policy"],
  spentRungs: Map<string, RecoveryRung[]>,
  environment: ControllerEnvironment,
): AttentionItem | null {
  const key = attempt.nodeId;
  const spent = spentRungs.get(key) ?? [];
  const decision = planRecovery(
    waitingReason ? { ...attempt, waitingReason } : attempt,
    policy,
    spent,
  );
  spentRungs.set(key, [...spent, decision.rung]);

  if (decision.rung !== "raise-attention") return null;
  return {
    id: environment.nextAttentionItemId(),
    runId,
    nodeId: attempt.nodeId,
    attemptId: attempt.id,
    request: `${attempt.nodeId} could not be completed automatically. ${decision.reason} What should happen next?`,
    reason: waitingReason ?? "recovery-exhausted",
    attemptedRecovery: decision.attempted,
    workspaceId: null,
    createdAt: environment.now(),
    resolvedAt: null,
  };
}

function describeWaitingRequest(node: WorkflowNode, reason: WaitingReason | null): string {
  if (node.kind === "approval") return node.question;
  return reason === "login-required"
    ? `${node.title} needs you to sign in to continue.`
    : `${node.title} is waiting on your decision.`;
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

/** Gate Results for a node, newest last. Used by callers projecting delivery. */
export function gateResultsFor(snapshot: RunSnapshot, nodeId: WorkflowNode["id"]): GateResult[] {
  return snapshot.gateResults.filter((result) => result.nodeId === nodeId);
}
