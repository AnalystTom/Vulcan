// FILE: factory.ts
// Purpose: The Software Factory kernel's contract -- Workflow Definitions,
// Workflow Runs, Node Attempts, typed envelopes, immutable Artifacts, Gate
// Results, target leases, and Attention Items.
// Layer: contract (schema only; the kernel logic lives in @vulcan/shared/factory)
//
// The shape of this contract encodes three product rules that the rest of the
// system depends on and cannot re-derive:
//
//   1. The whole plan is written down before anything runs. A Workflow Definition
//      is immutable and versioned, so an operator can see future nodes, branches,
//      joins, gates, loops, and approvals before they execute -- not reconstruct
//      them from a transcript afterwards.
//   2. Judgment and determinism are different kinds of work. Agent nodes are a
//      distinct variant from command, test, git, browser, review, approval,
//      deploy, and notification nodes, so acceptance never rests on "the agent
//      said it was fine".
//   3. Nothing is complete without evidence. A Gate Result cites the exact
//      Artifacts and the exact git revision it judged, which is what makes a
//      completion claim auditable and what makes stale evidence detectable when
//      the revision moves.

import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  WorkspaceId,
} from "./baseSchemas";

const makeFactoryId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.check(Schema.isMaxLength(200)).pipe(Schema.brand(brand));

export const WorkflowDefinitionId = makeFactoryId("WorkflowDefinitionId");
export type WorkflowDefinitionId = typeof WorkflowDefinitionId.Type;
export const WorkflowRunId = makeFactoryId("WorkflowRunId");
export type WorkflowRunId = typeof WorkflowRunId.Type;
export const WorkflowNodeId = makeFactoryId("WorkflowNodeId");
export type WorkflowNodeId = typeof WorkflowNodeId.Type;
export const NodeAttemptId = makeFactoryId("NodeAttemptId");
export type NodeAttemptId = typeof NodeAttemptId.Type;
export const ArtifactId = makeFactoryId("ArtifactId");
export type ArtifactId = typeof ArtifactId.Type;
export const WorkItemId = makeFactoryId("WorkItemId");
export type WorkItemId = typeof WorkItemId.Type;
export const ExecutionTargetId = makeFactoryId("ExecutionTargetId");
export type ExecutionTargetId = typeof ExecutionTargetId.Type;
export const AttentionItemId = makeFactoryId("AttentionItemId");
export type AttentionItemId = typeof AttentionItemId.Type;

/** A git revision. Evidence is meaningless without one, so it is never optional. */
export const GitRevision = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type GitRevision = typeof GitRevision.Type;

// --- policy ------------------------------------------------------------------

/**
 * The bounds a Run executes under.
 *
 * Versioned because a Gate Result records the policy it was judged against: the
 * same evidence can pass under one policy and fail under a stricter one, and an
 * audit has to be able to tell which applied.
 */
export const FactoryPolicy = Schema.Struct({
  version: PositiveInt,
  /** Attempts per node, including the first. 1 means no retries. */
  maxAttemptsPerNode: PositiveInt.check(Schema.isLessThanOrEqualTo(20)),
  /** How many times a repair loop (test -> fix -> test) may go round. */
  maxRepairLoops: NonNegativeInt.check(Schema.isLessThanOrEqualTo(20)),
  /** Wall-clock ceiling for a single attempt before it is declared stalled. */
  attemptTimeoutSeconds: PositiveInt,
  /** Silence from a target or provider beyond this is not progress. */
  heartbeatTimeoutSeconds: PositiveInt,
  /** Total spend ceiling for the Run, in whole cents; null means unbounded. */
  costBudgetCents: Schema.NullOr(NonNegativeInt),
  /**
   * Whether a UI-affecting change must pass a Lavish Review before PR-ready.
   * Default-on; a Workflow Definition may make it stricter, and only an explicit
   * policy decision waives it.
   */
  requireLavishReviewForUiChanges: Schema.Boolean,
});
export type FactoryPolicy = typeof FactoryPolicy.Type;

export const DEFAULT_FACTORY_POLICY: FactoryPolicy = {
  version: 1,
  maxAttemptsPerNode: 3,
  maxRepairLoops: 3,
  attemptTimeoutSeconds: 1_800,
  heartbeatTimeoutSeconds: 300,
  costBudgetCents: null,
  requireLavishReviewForUiChanges: true,
};

// --- node kinds --------------------------------------------------------------

/**
 * What a target must be able to do to run a node.
 *
 * Routing is by capability rather than by host, so adding a machine or a sandbox
 * never means editing node definitions. A capability that a target has not
 * confirmed is absent -- never inferred from the target being reachable.
 */
export const TargetCapability = Schema.Literals([
  "git",
  "shell",
  "node",
  "browser",
  "computer-use",
  "docker",
  "lavish",
]);
export type TargetCapability = typeof TargetCapability.Type;

const NodeBase = Schema.Struct({
  id: WorkflowNodeId,
  /** Human label shown in the graph and the waterfall. */
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  /** Nodes that must succeed before this one is ready. */
  dependsOn: Schema.Array(WorkflowNodeId).check(Schema.isMaxLength(50)),
  requiredCapabilities: Schema.Array(TargetCapability).check(Schema.isMaxLength(10)),
});

/**
 * A node whose output is judgment: an agent decides what to do.
 *
 * Deliberately separate from every deterministic kind. An agent node can produce
 * an Artifact and can be wrong; it can never be the thing that decides a gate.
 */
export const AgentNode = Schema.Struct({
  ...NodeBase.fields,
  kind: Schema.Literal("agent"),
  /** Which provider capability profile the node needs, not a specific provider. */
  role: Schema.Literals(["plan", "build", "review", "repair"]),
  promptTemplate: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
});
export type AgentNode = typeof AgentNode.Type;

/** A deterministic command. Its exit code is evidence, not a verdict. */
export const CommandNode = Schema.Struct({
  ...NodeBase.fields,
  kind: Schema.Literal("command"),
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  /** Working directory relative to the workspace root. */
  workingDirectory: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(1_000))),
});
export type CommandNode = typeof CommandNode.Type;

export const TestNode = Schema.Struct({
  ...NodeBase.fields,
  kind: Schema.Literal("test"),
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
});
export type TestNode = typeof TestNode.Type;

/**
 * Browser Verification as a first-class node.
 *
 * It discovers or starts the real preview, runs the declared new-user journey,
 * captures evidence, and leaves the verified surface open -- so proving a UI
 * change is part of the workflow rather than a follow-up instruction.
 */
export const BrowserVerificationNode = Schema.Struct({
  ...NodeBase.fields,
  kind: Schema.Literal("browserVerification"),
  /** Ordered steps of the new-user journey, in plain language. */
  journey: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(500))).check(
    Schema.isMaxLength(50),
  ),
  /** Route to start from, relative to the preview origin. */
  startPath: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
});
export type BrowserVerificationNode = typeof BrowserVerificationNode.Type;

export const ReviewNode = Schema.Struct({
  ...NodeBase.fields,
  kind: Schema.Literal("review"),
  /** An independent review must not be performed by the node that built it. */
  independentOf: Schema.Array(WorkflowNodeId).check(Schema.isMaxLength(50)),
});
export type ReviewNode = typeof ReviewNode.Type;

export const LavishReviewNode = Schema.Struct({
  ...NodeBase.fields,
  kind: Schema.Literal("lavishReview"),
});
export type LavishReviewNode = typeof LavishReviewNode.Type;

/** A node that waits for a person. Its waiting reason is `waiting-human`. */
export const ApprovalNode = Schema.Struct({
  ...NodeBase.fields,
  kind: Schema.Literal("approval"),
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
});
export type ApprovalNode = typeof ApprovalNode.Type;

/**
 * A gate. Not work -- a judgement over evidence already produced.
 *
 * Its checks name the Artifacts they read, so a Gate Result can cite them and so
 * a revision change can be detected as invalidating.
 */
export const GateNode = Schema.Struct({
  ...NodeBase.fields,
  kind: Schema.Literal("gate"),
  checks: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
      /** Artifact kinds that must be present and passing for this check. */
      requiresArtifactKinds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(20)),
    }),
  ).check(Schema.isMaxLength(50)),
});
export type GateNode = typeof GateNode.Type;

export const WorkflowNode = Schema.Union([
  AgentNode,
  CommandNode,
  TestNode,
  BrowserVerificationNode,
  ReviewNode,
  LavishReviewNode,
  ApprovalNode,
  GateNode,
]);
export type WorkflowNode = typeof WorkflowNode.Type;

export type WorkflowNodeKind = WorkflowNode["kind"];

/** Kinds whose result is judgment rather than a determinate outcome. */
export const AGENT_NODE_KINDS = ["agent", "review"] as const;

/**
 * Kinds whose output is a verdict about the code as it stands.
 *
 * Only these are invalidated when the revision moves. The distinction is load
 * bearing: a build that commits changes the revision, so treating production
 * work the same way would make every build invalidate itself and the run would
 * never converge. What has to be redone after a change is the *checking* --
 * tests, browser verification, review, and the gates over them.
 */
export const VERIFICATION_NODE_KINDS = [
  "test",
  "browserVerification",
  "review",
  "lavishReview",
  "gate",
] as const satisfies readonly WorkflowNodeKind[];

export const isVerificationNodeKind = (kind: WorkflowNodeKind): boolean =>
  (VERIFICATION_NODE_KINDS as readonly string[]).includes(kind);

// --- definition --------------------------------------------------------------

/**
 * The complete, immutable plan.
 *
 * Persisted before the first node runs. `version` plus `id` identify it forever:
 * editing a workflow produces a new version, never a mutation, so a Run's results
 * always remain reproducible against exactly what it executed.
 */
export const WorkflowDefinition = Schema.Struct({
  id: WorkflowDefinitionId,
  version: PositiveInt,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  description: Schema.String.check(Schema.isMaxLength(2_000)),
  nodes: Schema.Array(WorkflowNode).check(Schema.isMaxLength(200)),
  policy: FactoryPolicy,
  /** The canonical YAML this definition was parsed from, kept verbatim for audit. */
  source: Schema.String.check(Schema.isMaxLength(200_000)),
});
export type WorkflowDefinition = typeof WorkflowDefinition.Type;

// --- artifacts and envelopes -------------------------------------------------

/**
 * An immutable output.
 *
 * Pinned to the revision it was produced against. That pin is what makes stale
 * evidence detectable: when the workspace moves to a new revision, every Artifact
 * produced against the old one stops counting.
 */
export const Artifact = Schema.Struct({
  id: ArtifactId,
  /** Free-form kind, e.g. "test-results", "screenshot", "review", "diff". */
  kind: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  producedByNodeId: WorkflowNodeId,
  producedByAttemptId: NodeAttemptId,
  revision: GitRevision,
  createdAt: IsoDateTime,
  /** Whether the artifact represents a passing or failing outcome. */
  outcome: Schema.Literals(["passed", "failed", "informational"]),
  /** Where the content lives; the kernel never inlines large payloads. */
  uri: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
  summary: Schema.String.check(Schema.isMaxLength(4_000)),
});
export type Artifact = typeof Artifact.Type;

/**
 * A typed handoff between nodes.
 *
 * Nodes exchange envelopes rather than reading each other's transcripts, so a
 * downstream node never depends on an agent having phrased something a
 * particular way.
 */
export const NodeEnvelope = Schema.Struct({
  fromNodeId: WorkflowNodeId,
  toNodeId: WorkflowNodeId,
  artifactIds: Schema.Array(ArtifactId).check(Schema.isMaxLength(100)),
  /** Structured summary the receiving node can rely on. */
  summary: Schema.String.check(Schema.isMaxLength(8_000)),
  revision: GitRevision,
});
export type NodeEnvelope = typeof NodeEnvelope.Type;

// --- attempts ----------------------------------------------------------------

/**
 * Every state a Node Attempt can occupy.
 *
 * Fail-closed: there is no state meaning "probably fine". `lost` exists because
 * a disconnected attempt must be reconciled into an explicit outcome rather than
 * assumed successful, and the four `waiting-*` states exist because "waiting" on
 * its own does not tell an operator whether anyone needs to do anything.
 */
export const NodeAttemptState = Schema.Literals([
  "queued",
  "provisioning",
  "ready",
  "running",
  "waiting-external",
  "waiting-agent",
  "waiting-human",
  "retrying",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
]);
export type NodeAttemptState = typeof NodeAttemptState.Type;

/** Terminal states. Nothing leaves these. */
export const TERMINAL_ATTEMPT_STATES = [
  "succeeded",
  "failed",
  "cancelled",
  "lost",
] as const satisfies readonly NodeAttemptState[];

/** States in which an attempt holds a target lease. */
export const ACTIVE_ATTEMPT_STATES = [
  "provisioning",
  "ready",
  "running",
  "waiting-external",
  "waiting-agent",
  "waiting-human",
  "retrying",
  "verifying",
] as const satisfies readonly NodeAttemptState[];

/**
 * Why an attempt is waiting.
 *
 * Typed so the supervisor and the Attention Inbox can distinguish a provider
 * question (an operator can answer it) from a rate limit (waiting is correct)
 * from a missing capability (nothing will ever unblock it).
 */
export const WaitingReason = Schema.Literals([
  "provider-question",
  "approval-required",
  "login-required",
  "rate-limited",
  "external-check",
  "missing-capability",
  "target-unavailable",
]);
export type WaitingReason = typeof WaitingReason.Type;

export const NodeAttempt = Schema.Struct({
  id: NodeAttemptId,
  runId: WorkflowRunId,
  nodeId: WorkflowNodeId,
  /** 1-based; compared against policy.maxAttemptsPerNode. */
  attemptNumber: PositiveInt,
  state: NodeAttemptState,
  waitingReason: Schema.NullOr(WaitingReason),
  targetId: Schema.NullOr(ExecutionTargetId),
  /** Revision the attempt is executing against; artifacts inherit it. */
  revision: Schema.NullOr(GitRevision),
  startedAt: Schema.NullOr(IsoDateTime),
  /** Last proof of life from the target or provider, not proof of progress. */
  lastHeartbeatAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  failureSummary: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))),
});
export type NodeAttempt = typeof NodeAttempt.Type;

// --- gates -------------------------------------------------------------------

export const GateCheckResult = Schema.Struct({
  name: TrimmedNonEmptyString,
  passed: Schema.Boolean,
  /** Exactly which Artifacts this check read. Empty means it had no evidence. */
  evidenceArtifactIds: Schema.Array(ArtifactId).check(Schema.isMaxLength(100)),
  detail: Schema.String.check(Schema.isMaxLength(2_000)),
});
export type GateCheckResult = typeof GateCheckResult.Type;

/**
 * A completion claim with its receipts.
 *
 * Records the revision and the policy version it was judged under, so it can be
 * re-checked later and so a revision change invalidates it rather than silently
 * carrying forward.
 */
export const GateResult = Schema.Struct({
  nodeId: WorkflowNodeId,
  runId: WorkflowRunId,
  passed: Schema.Boolean,
  revision: GitRevision,
  policyVersion: PositiveInt,
  checks: Schema.Array(GateCheckResult).check(Schema.isMaxLength(50)),
  evaluatedAt: IsoDateTime,
});
export type GateResult = typeof GateResult.Type;

// --- runs --------------------------------------------------------------------

export const WorkflowRunState = Schema.Literals([
  "pending",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
]);
export type WorkflowRunState = typeof WorkflowRunState.Type;

/**
 * One execution of one Workflow Definition version.
 *
 * Pinned to the definition version, the Work Item, the repository revision it
 * started from, and the policy version, because a result that cannot be tied to
 * all four is not reproducible.
 */
export const WorkflowRun = Schema.Struct({
  id: WorkflowRunId,
  definitionId: WorkflowDefinitionId,
  definitionVersion: PositiveInt,
  workItemId: WorkItemId,
  workspaceId: Schema.NullOr(WorkspaceId),
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  /** Revision the run started from. The current revision lives on attempts. */
  baseRevision: GitRevision,
  policyVersion: PositiveInt,
  state: WorkflowRunState,
  createdAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});
export type WorkflowRun = typeof WorkflowRun.Type;

// --- targets and leases ------------------------------------------------------

export const ExecutionTarget = Schema.Struct({
  id: ExecutionTargetId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  /** Capabilities the target has actually reported. Never inferred. */
  capabilities: Schema.Array(TargetCapability).check(Schema.isMaxLength(20)),
  /** Attempts this target may hold at once. */
  maxConcurrentLeases: PositiveInt,
  online: Schema.Boolean,
  lastSeenAt: Schema.NullOr(IsoDateTime),
});
export type ExecutionTarget = typeof ExecutionTarget.Type;

/**
 * A time-bounded claim on a target.
 *
 * Bounded so a target lost mid-run frees itself instead of being held forever by
 * an attempt nobody can reach.
 */
export const TargetLease = Schema.Struct({
  targetId: ExecutionTargetId,
  attemptId: NodeAttemptId,
  runId: WorkflowRunId,
  acquiredAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type TargetLease = typeof TargetLease.Type;

// --- supervision -------------------------------------------------------------

/**
 * The bounded recovery ladder, in the order the supervisor must try it.
 *
 * Each rung is cheaper and less disruptive than the next, and the operator is
 * only involved once every automatic option is spent -- which is the difference
 * between a supervisor and a notifier.
 */
export const RecoveryRung = Schema.Literals([
  "resume-same-session",
  "retry-attempt",
  "reassign-target",
  "checkpoint-handoff",
  "raise-attention",
]);
export type RecoveryRung = typeof RecoveryRung.Type;

export const RECOVERY_LADDER = [
  "resume-same-session",
  "retry-attempt",
  "reassign-target",
  "checkpoint-handoff",
  "raise-attention",
] as const satisfies readonly RecoveryRung[];

/**
 * One thing a person has to decide.
 *
 * Carries the exact decision requested and where to go, because an inbox of
 * "something needs attention" is a notification, not a control plane.
 */
export const AttentionItem = Schema.Struct({
  id: AttentionItemId,
  runId: WorkflowRunId,
  nodeId: Schema.NullOr(WorkflowNodeId),
  attemptId: Schema.NullOr(NodeAttemptId),
  /** The decision being asked for, phrased as a question. */
  request: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  reason: Schema.Union([WaitingReason, Schema.Literal("recovery-exhausted")]),
  /** Rungs already tried, so the operator knows what has been attempted. */
  attemptedRecovery: Schema.Array(RecoveryRung).check(Schema.isMaxLength(10)),
  workspaceId: Schema.NullOr(WorkspaceId),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type AttentionItem = typeof AttentionItem.Type;
