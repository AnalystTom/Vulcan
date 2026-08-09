// FILE: factoryKernel.ts
// Purpose: The Software Factory kernel's decisions, as pure functions over run
// state -- which nodes are ready, which attempt transitions are legal, whether a
// gate passes, and what the supervisor should do about a stalled attempt.
// Layer: shared domain logic
//
// This is the narrow public interface the issue asks for. Everything here is a
// total function of values: no clock, no randomness, no I/O. Callers pass `now`
// explicitly. That is what makes the kernel's behaviour reproducible -- the same
// run state and the same instant always yield the same decision, so a controller
// crash and replay cannot produce a different schedule than the first pass.
//
// The kernel decides; it never acts. It returns "this node is ready on a target
// with these capabilities" or "retry this attempt", and the caller performs the
// side effect. Keeping the decision separable from the effect is what lets the
// whole scheduler be tested without a repository, a provider, or a machine.

import {
  ACTIVE_ATTEMPT_STATES,
  type Artifact,
  type ArtifactId,
  type ExecutionTarget,
  type ExecutionTargetId,
  type FactoryPolicy,
  type GateCheckResult,
  type GateNode,
  type GateResult,
  type GitRevision,
  type NodeAttempt,
  type NodeAttemptState,
  RECOVERY_LADDER,
  type RecoveryRung,
  type TargetLease,
  TERMINAL_ATTEMPT_STATES,
  type WaitingReason,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeId,
  type WorkflowRunState,
} from "@vulcan/contracts";

const TERMINAL = new Set<NodeAttemptState>(TERMINAL_ATTEMPT_STATES);
const ACTIVE = new Set<NodeAttemptState>(ACTIVE_ATTEMPT_STATES);

export const isTerminalAttemptState = (state: NodeAttemptState): boolean => TERMINAL.has(state);
export const isActiveAttemptState = (state: NodeAttemptState): boolean => ACTIVE.has(state);

// --- attempt state machine ---------------------------------------------------

/**
 * Legal successors for each attempt state.
 *
 * Written out rather than derived, because the point of a fail-closed machine is
 * that an unlisted transition is a bug and not an oversight. In particular there
 * is no edge out of any terminal state: an attempt that ended cannot be revived,
 * only superseded by a new attempt.
 */
const ATTEMPT_TRANSITIONS: Record<NodeAttemptState, readonly NodeAttemptState[]> = {
  queued: ["provisioning", "cancelled"],
  // Provisioning can fail outright (no compatible target) without ever running.
  provisioning: ["ready", "failed", "cancelled", "lost"],
  ready: ["running", "retrying", "failed", "cancelled", "lost"],
  // Deliberately no direct edge to `succeeded`. Acceptance is decided by tests
  // and gates over evidence, never by a process having exited cleanly, so every
  // attempt has to pass through `verifying` to claim an outcome.
  running: [
    "waiting-external",
    "waiting-agent",
    "waiting-human",
    "verifying",
    "failed",
    "cancelled",
    "lost",
  ],
  // Every waiting state can resume, be retried, or be lost. None can succeed
  // directly: work has to run again before it can claim an outcome.
  "waiting-external": ["running", "retrying", "failed", "cancelled", "lost"],
  "waiting-agent": ["running", "retrying", "failed", "cancelled", "lost"],
  "waiting-human": ["running", "retrying", "failed", "cancelled", "lost"],
  retrying: ["provisioning", "ready", "failed", "cancelled", "lost"],
  // Verification is the only path to success, so a node cannot claim completion
  // without its evidence having been looked at.
  verifying: ["succeeded", "failed", "cancelled", "lost"],
  succeeded: [],
  failed: [],
  cancelled: [],
  lost: [],
};

export function canTransitionAttempt(from: NodeAttemptState, to: NodeAttemptState): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

export function legalAttemptTransitions(from: NodeAttemptState): readonly NodeAttemptState[] {
  return ATTEMPT_TRANSITIONS[from];
}

/** Waiting states carry a reason; every other state must not. */
export function requiresWaitingReason(state: NodeAttemptState): boolean {
  return state === "waiting-external" || state === "waiting-agent" || state === "waiting-human";
}

export type AttemptTransitionResult =
  | { readonly ok: true; readonly attempt: NodeAttempt }
  | {
      readonly ok: false;
      readonly reason:
        | "illegal-transition"
        | "missing-waiting-reason"
        | "unexpected-waiting-reason";
    };

/**
 * Applies a state change, refusing anything the machine does not allow.
 *
 * The waiting-reason checks are here rather than at the call sites because a
 * waiting attempt with no reason is exactly the "waiting on something, unclear
 * what" state the product exists to eliminate.
 */
export function transitionAttempt(
  attempt: NodeAttempt,
  to: NodeAttemptState,
  options: {
    readonly now: string;
    readonly waitingReason?: WaitingReason | null;
    readonly failureSummary?: string | null;
  },
): AttemptTransitionResult {
  if (!canTransitionAttempt(attempt.state, to)) return { ok: false, reason: "illegal-transition" };

  const waitingReason = options.waitingReason ?? null;
  if (requiresWaitingReason(to) && waitingReason === null) {
    return { ok: false, reason: "missing-waiting-reason" };
  }
  if (!requiresWaitingReason(to) && waitingReason !== null) {
    return { ok: false, reason: "unexpected-waiting-reason" };
  }

  return {
    ok: true,
    attempt: {
      ...attempt,
      state: to,
      waitingReason,
      ...(to === "running" && attempt.startedAt === null ? { startedAt: options.now } : {}),
      ...(TERMINAL.has(to) ? { endedAt: options.now } : {}),
      ...(options.failureSummary !== undefined ? { failureSummary: options.failureSummary } : {}),
    },
  };
}

// --- run state ---------------------------------------------------------------

export interface RunSnapshot {
  readonly definition: WorkflowDefinition;
  readonly attempts: readonly NodeAttempt[];
  readonly artifacts: readonly Artifact[];
  readonly gateResults: readonly GateResult[];
  /** The workspace's current revision, which may have moved since a node ran. */
  readonly currentRevision: GitRevision;
}

const latestAttemptFor = (
  attempts: readonly NodeAttempt[],
  nodeId: WorkflowNodeId,
): NodeAttempt | null =>
  attempts
    .filter((attempt) => attempt.nodeId === nodeId)
    .reduce<NodeAttempt | null>(
      (best, attempt) =>
        best === null || attempt.attemptNumber > best.attemptNumber ? attempt : best,
      null,
    );

export function findLatestAttempt(
  snapshot: RunSnapshot,
  nodeId: WorkflowNodeId,
): NodeAttempt | null {
  return latestAttemptFor(snapshot.attempts, nodeId);
}

/**
 * Whether a node counts as done.
 *
 * A node is only satisfied by an attempt that succeeded *against the current
 * revision*. Once the workspace moves, work done against the old revision stops
 * counting, which is what forces changed code to be retested and rereviewed
 * rather than inheriting a stale pass.
 */
export function isNodeSatisfied(snapshot: RunSnapshot, nodeId: WorkflowNodeId): boolean {
  const attempt = latestAttemptFor(snapshot.attempts, nodeId);
  if (!attempt || attempt.state !== "succeeded") return false;
  return attempt.revision === snapshot.currentRevision;
}

export interface ReadyNode {
  readonly node: WorkflowNode;
  /** Attempt number the next attempt would take. */
  readonly nextAttemptNumber: number;
  readonly requiredCapabilities: readonly ExecutionTarget["capabilities"][number][];
}

/**
 * Nodes whose dependencies are satisfied and which have no live attempt.
 *
 * The controller schedules these without being asked, which is the whole point:
 * compatible work should never sit idle waiting for an operator to notice it.
 */
export function findReadyNodes(snapshot: RunSnapshot, policy: FactoryPolicy): ReadyNode[] {
  const ready: ReadyNode[] = [];
  for (const node of snapshot.definition.nodes) {
    if (isNodeSatisfied(snapshot, node.id)) continue;

    const attempt = latestAttemptFor(snapshot.attempts, node.id);
    // A node with a live attempt is already being worked on.
    if (attempt && ACTIVE.has(attempt.state)) continue;
    if (attempt && attempt.state === "queued") continue;
    // A node that exhausted its attempts is failed, not ready.
    if (
      attempt &&
      attempt.attemptNumber >= policy.maxAttemptsPerNode &&
      attempt.state === "failed"
    ) {
      continue;
    }
    if (attempt && attempt.state === "cancelled") continue;

    const dependenciesMet = node.dependsOn.every((dependency) =>
      isNodeSatisfied(snapshot, dependency),
    );
    if (!dependenciesMet) continue;

    ready.push({
      node,
      nextAttemptNumber: attempt ? attempt.attemptNumber + 1 : 1,
      requiredCapabilities: node.requiredCapabilities,
    });
  }
  return ready;
}

/**
 * The run's overall state.
 *
 * `blocked` is distinct from `running` because an operator needs to know the
 * difference between work in flight and a run that cannot progress without them.
 */
export function deriveRunState(snapshot: RunSnapshot, policy: FactoryPolicy): WorkflowRunState {
  const nodes = snapshot.definition.nodes;
  if (nodes.length === 0) return "succeeded";

  if (nodes.every((node) => isNodeSatisfied(snapshot, node.id))) return "succeeded";

  const attempts = snapshot.attempts;
  if (attempts.some((attempt) => attempt.state === "cancelled")) return "cancelled";

  const exhausted = nodes.some((node) => {
    const attempt = latestAttemptFor(attempts, node.id);
    return (
      attempt !== null &&
      (attempt.state === "failed" || attempt.state === "lost") &&
      attempt.attemptNumber >= policy.maxAttemptsPerNode
    );
  });
  if (exhausted) return "failed";

  if (attempts.some((attempt) => attempt.state === "waiting-human")) return "blocked";
  // Nothing has been dispatched yet, so the run has not started rather than
  // being in flight. Ready work is the controller's cue, not a run state.
  if (attempts.length === 0) return "pending";
  if (attempts.some((attempt) => ACTIVE.has(attempt.state))) return "running";
  if (findReadyNodes(snapshot, policy).length > 0) return "running";
  // Nothing running, nothing ready, nothing satisfied: dependencies cannot be
  // met, so the run is stuck rather than quietly idle.
  return "blocked";
}

// --- target routing ----------------------------------------------------------

export type TargetSelection =
  | { readonly kind: "selected"; readonly targetId: ExecutionTargetId }
  | { readonly kind: "none-available"; readonly reason: WaitingReason };

/**
 * Chooses a target for a node by capability, load, and lease availability.
 *
 * The distinction between `missing-capability` and `target-unavailable` matters:
 * the first will never resolve on its own and belongs in the Attention Inbox,
 * while the second is worth waiting for.
 */
export function selectTarget(
  requiredCapabilities: readonly ExecutionTarget["capabilities"][number][],
  targets: readonly ExecutionTarget[],
  leases: readonly TargetLease[],
): TargetSelection {
  const capable = targets.filter((target) =>
    requiredCapabilities.every((capability) => target.capabilities.includes(capability)),
  );
  if (capable.length === 0) return { kind: "none-available", reason: "missing-capability" };

  const online = capable.filter((target) => target.online);
  if (online.length === 0) return { kind: "none-available", reason: "target-unavailable" };

  const leaseCount = (targetId: ExecutionTargetId) =>
    leases.filter((lease) => lease.targetId === targetId).length;

  const free = online
    .filter((target) => leaseCount(target.id) < target.maxConcurrentLeases)
    // Least loaded first, then by id so the choice is deterministic and a replay
    // schedules identically.
    .toSorted((left, right) => {
      const delta = leaseCount(left.id) - leaseCount(right.id);
      return delta !== 0 ? delta : left.id.localeCompare(right.id);
    });

  const chosen = free[0];
  return chosen
    ? { kind: "selected", targetId: chosen.id }
    : { kind: "none-available", reason: "target-unavailable" };
}

// --- gates -------------------------------------------------------------------

/**
 * Evaluates a gate over the evidence that exists right now.
 *
 * Only Artifacts produced against the current revision are admissible. A check
 * with no admissible evidence fails -- absence of evidence is never a pass, which
 * is the rule that stops a gate from going green because a step was skipped.
 */
export function evaluateGate(
  gate: GateNode,
  snapshot: RunSnapshot,
  policy: FactoryPolicy,
  now: string,
): GateResult {
  const admissible = snapshot.artifacts.filter(
    (artifact) => artifact.revision === snapshot.currentRevision,
  );

  const checks: GateCheckResult[] = gate.checks.map((check) => {
    const evidence = admissible.filter((artifact) =>
      check.requiresArtifactKinds.includes(artifact.kind),
    );
    const missingKinds = check.requiresArtifactKinds.filter(
      (kind) => !evidence.some((artifact) => artifact.kind === kind),
    );
    const failing = evidence.filter((artifact) => artifact.outcome === "failed");

    const passed = missingKinds.length === 0 && failing.length === 0;
    const detail = passed
      ? `Satisfied by ${evidence.length} artifact(s) at ${snapshot.currentRevision}.`
      : missingKinds.length > 0
        ? `No evidence at ${snapshot.currentRevision} for: ${missingKinds.join(", ")}.`
        : `${failing.length} artifact(s) reported failure.`;

    return {
      name: check.name,
      passed,
      evidenceArtifactIds: evidence.map((artifact) => artifact.id),
      detail,
    };
  });

  return {
    nodeId: gate.id,
    runId: snapshot.attempts[0]?.runId ?? ("" as GateResult["runId"]),
    passed: checks.length > 0 && checks.every((check) => check.passed),
    revision: snapshot.currentRevision,
    policyVersion: policy.version,
    checks,
    evaluatedAt: now,
  };
}

/**
 * Gate Results invalidated by the workspace having moved on.
 *
 * Returned rather than deleted: an operator auditing a run should be able to see
 * that a gate passed at an earlier revision and that the pass no longer counts.
 */
export function findStaleGateResults(snapshot: RunSnapshot): GateResult[] {
  return snapshot.gateResults.filter((result) => result.revision !== snapshot.currentRevision);
}

/** Artifacts that no longer describe the current revision. */
export function findStaleArtifacts(snapshot: RunSnapshot): Artifact[] {
  return snapshot.artifacts.filter((artifact) => artifact.revision !== snapshot.currentRevision);
}

export function findArtifactsByIds(snapshot: RunSnapshot, ids: readonly ArtifactId[]): Artifact[] {
  const wanted = new Set<string>(ids);
  return snapshot.artifacts.filter((artifact) => wanted.has(artifact.id));
}

// --- supervision -------------------------------------------------------------

export type StallVerdict =
  | { readonly kind: "healthy" }
  | { readonly kind: "stalled"; readonly cause: "heartbeat-timeout" | "attempt-timeout" };

/**
 * Whether an attempt has stopped making progress.
 *
 * A live heartbeat is proof a process exists, not proof it is doing anything, so
 * the attempt timeout applies even while heartbeats keep arriving.
 *
 * `waiting-human` is never stalled: a person taking their time is the system
 * working as intended, and escalating it would produce exactly the noise the
 * Attention Inbox exists to avoid.
 */
export function detectStall(
  attempt: NodeAttempt,
  policy: FactoryPolicy,
  now: string,
): StallVerdict {
  if (!ACTIVE.has(attempt.state)) return { kind: "healthy" };
  if (attempt.state === "waiting-human") return { kind: "healthy" };

  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) return { kind: "healthy" };

  if (attempt.startedAt !== null) {
    const elapsed = (nowMs - Date.parse(attempt.startedAt)) / 1000;
    if (elapsed > policy.attemptTimeoutSeconds) {
      return { kind: "stalled", cause: "attempt-timeout" };
    }
  }

  // A rate-limited attempt is waiting on someone else's clock, so silence is
  // expected and is not evidence of a stall.
  if (attempt.waitingReason === "rate-limited") return { kind: "healthy" };

  const heartbeat = attempt.lastHeartbeatAt ?? attempt.startedAt;
  if (heartbeat === null) return { kind: "healthy" };
  const silence = (nowMs - Date.parse(heartbeat)) / 1000;
  return silence > policy.heartbeatTimeoutSeconds
    ? { kind: "stalled", cause: "heartbeat-timeout" }
    : { kind: "healthy" };
}

export interface RecoveryDecision {
  readonly rung: RecoveryRung;
  /** Why this rung and not the previous one, for the run's event stream. */
  readonly reason: string;
  /** Rungs already spent, carried onto an Attention Item if it comes to that. */
  readonly attempted: readonly RecoveryRung[];
}

/**
 * The next rung of the bounded recovery ladder.
 *
 * The ladder only ever moves forward, and it always ends at `raise-attention` --
 * so a stalled attempt can neither loop forever nor be silently abandoned. The
 * caller records which rungs it has spent; the kernel does not remember, because
 * remembering would make it stateful and unreplayable.
 */
export function planRecovery(
  attempt: NodeAttempt,
  policy: FactoryPolicy,
  attemptedRungs: readonly RecoveryRung[],
): RecoveryDecision {
  const attempted = [...attemptedRungs];
  const spent = new Set<RecoveryRung>(attempted);

  // A node out of attempts cannot be retried or reassigned, however little of the
  // ladder has been used: the budget, not the ladder, is the binding constraint.
  if (attempt.attemptNumber >= policy.maxAttemptsPerNode) {
    return {
      rung: "raise-attention",
      reason: `Attempt ${attempt.attemptNumber} of ${policy.maxAttemptsPerNode} is the last the policy allows.`,
      attempted,
    };
  }

  // A missing capability will never be resolved by trying again on the same kind
  // of machine, so the automatic rungs are skipped entirely.
  if (attempt.waitingReason === "missing-capability") {
    return {
      rung: "raise-attention",
      reason: "No enrolled target reports the capability this node requires.",
      attempted,
    };
  }

  for (const rung of RECOVERY_LADDER) {
    if (spent.has(rung)) continue;
    // Reassignment is meaningless for an attempt that never held a target.
    if (rung === "reassign-target" && attempt.targetId === null) continue;
    return { rung, reason: describeRung(rung), attempted };
  }

  return {
    rung: "raise-attention",
    reason: "Every automatic recovery step has been tried.",
    attempted,
  };
}

function describeRung(rung: RecoveryRung): string {
  switch (rung) {
    case "resume-same-session":
      return "Resuming the existing session is the cheapest recovery and preserves context.";
    case "retry-attempt":
      return "The session could not be resumed, so the attempt is retried from its last checkpoint.";
    case "reassign-target":
      return "Retrying on the same target failed, so the work moves to a compatible target.";
    case "checkpoint-handoff":
      return "Reassignment failed, so the work is handed off from its checkpoint.";
    case "raise-attention":
      return "Every automatic recovery step has been tried.";
  }
}

// --- definition validation ---------------------------------------------------

export type DefinitionProblem =
  | { readonly kind: "duplicate-node"; readonly nodeId: WorkflowNodeId }
  | {
      readonly kind: "unknown-dependency";
      readonly nodeId: WorkflowNodeId;
      readonly dependsOn: WorkflowNodeId;
    }
  | { readonly kind: "cycle"; readonly nodeIds: readonly WorkflowNodeId[] }
  | { readonly kind: "self-dependency"; readonly nodeId: WorkflowNodeId }
  | { readonly kind: "review-not-independent"; readonly nodeId: WorkflowNodeId }
  | { readonly kind: "gate-without-checks"; readonly nodeId: WorkflowNodeId };

/**
 * Everything wrong with a definition, checked before it is ever persisted.
 *
 * Returning all problems rather than the first keeps a YAML edit from becoming a
 * guessing game. A definition that fails here must not be stored: the product
 * guarantees the persisted plan is executable, and a graph with a cycle is not.
 */
export function validateDefinition(definition: WorkflowDefinition): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  const seen = new Set<WorkflowNodeId>();
  const byId = new Map<WorkflowNodeId, WorkflowNode>();

  for (const node of definition.nodes) {
    if (seen.has(node.id)) problems.push({ kind: "duplicate-node", nodeId: node.id });
    seen.add(node.id);
    byId.set(node.id, node);
  }

  for (const node of definition.nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.id) {
        problems.push({ kind: "self-dependency", nodeId: node.id });
        continue;
      }
      if (!byId.has(dependency)) {
        problems.push({ kind: "unknown-dependency", nodeId: node.id, dependsOn: dependency });
      }
    }
    if (node.kind === "gate" && node.checks.length === 0) {
      problems.push({ kind: "gate-without-checks", nodeId: node.id });
    }
    if (node.kind === "review") {
      // An "independent" review that reviews nothing it did not write is not a
      // second opinion; the declaration has to name what it is independent of.
      const independent = node.independentOf.length > 0;
      if (!independent) problems.push({ kind: "review-not-independent", nodeId: node.id });
    }
  }

  const cycle = findCycle(definition.nodes);
  if (cycle) problems.push({ kind: "cycle", nodeIds: cycle });

  return problems;
}

/** Depth-first search returning the first cycle found, for a readable error. */
function findCycle(nodes: readonly WorkflowNode[]): WorkflowNodeId[] | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<WorkflowNodeId>();
  const done = new Set<WorkflowNodeId>();
  const stack: WorkflowNodeId[] = [];

  const walk = (nodeId: WorkflowNodeId): WorkflowNodeId[] | null => {
    if (done.has(nodeId)) return null;
    if (visiting.has(nodeId)) {
      const start = stack.indexOf(nodeId);
      return stack.slice(start === -1 ? 0 : start);
    }
    visiting.add(nodeId);
    stack.push(nodeId);
    for (const dependency of byId.get(nodeId)?.dependsOn ?? []) {
      if (!byId.has(dependency)) continue;
      // Reported separately as `self-dependency`, which names the problem better
      // than a one-element cycle would.
      if (dependency === nodeId) continue;
      const found = walk(dependency);
      if (found) return found;
    }
    stack.pop();
    visiting.delete(nodeId);
    done.add(nodeId);
    return null;
  };

  for (const node of nodes) {
    const found = walk(node.id);
    if (found) return found;
  }
  return null;
}

/**
 * Execution order for display: dependencies before dependants.
 *
 * Used by the Factory waterfall so future nodes are visible before they run.
 * Returns null when the graph has a cycle, because there is no honest order to
 * show for one.
 */
export function topologicalOrder(definition: WorkflowDefinition): WorkflowNode[] | null {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  const remaining = new Map(
    definition.nodes.map((node) => [
      node.id,
      node.dependsOn.filter((dependency) => byId.has(dependency)).length,
    ]),
  );
  const ordered: WorkflowNode[] = [];
  // Ties broken by declaration order so the waterfall is stable between renders.
  const queue = definition.nodes.filter((node) => remaining.get(node.id) === 0).map((n) => n.id);

  while (queue.length > 0) {
    const nodeId = queue.shift() as WorkflowNodeId;
    const node = byId.get(nodeId);
    if (!node) continue;
    ordered.push(node);
    for (const candidate of definition.nodes) {
      if (!candidate.dependsOn.includes(nodeId)) continue;
      const count = (remaining.get(candidate.id) ?? 0) - 1;
      remaining.set(candidate.id, count);
      if (count === 0) queue.push(candidate.id);
    }
  }

  return ordered.length === definition.nodes.length ? ordered : null;
}
