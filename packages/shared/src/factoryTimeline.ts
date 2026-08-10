// FILE: factoryTimeline.ts
// Purpose: Project a run's raw facts into per-agent swimlanes on a shared time
// axis -- who did what, when, for how long, and with what evidence.
// Layer: shared domain logic
//
// The Factory's waterfall answers "what is the plan and where is it". This
// answers a different question an operator asks constantly while a run is live:
// *which agent is working right now, and what is everyone else doing while it
// does*. A list cannot show that, because the thing being read is concurrency.
//
// Two rules shape everything here:
//
//   1. A lane is a worker, not a node. Every attempt an agent role makes lands in
//      that role's lane, so a repair loop reads as the same agent going round
//      again rather than as an unrelated row appearing further down a list.
//   2. Geometry is derived, not stored. Positions come from attempt timestamps
//      only; nothing is nudged to look tidy except a legibility floor on width,
//      and that floor is confined to the lane it happens in so lanes stay
//      comparable against the axis and against each other.
//
// Presentation (colour, icons, labels for durations) is deliberately not here.
// This module decides what is true; the pane decides what it looks like.

import type { AgentNode, Artifact, NodeAttempt, WorkflowNode } from "@vulcan/contracts";

import type { RunSnapshot } from "./factoryKernel";
import { buildFactoryWaterfall, type FactoryNodeStatus } from "./workItemProjection";

/**
 * What kind of worker a lane represents.
 *
 * Kept coarse on purpose: it exists so the UI can theme a lane and so an
 * operator can tell judgment (`agent`) apart from determinism (`workspace`,
 * `browser`), a human decision (`operator`), and a verdict (`gate`).
 */
export type FactoryLaneKind = "operator" | "workspace" | "browser" | "agent" | "gate";

export interface FactoryLane {
  readonly id: string;
  /** The worker's name, e.g. `builder`. */
  readonly label: string;
  readonly kind: FactoryLaneKind;
  /** One line under the name saying what this worker is. */
  readonly meta: string;
  /** Attempts that have a start time, left to right. */
  readonly blocks: readonly FactoryTimelineBlock[];
  /** Nodes assigned to this lane that have not started yet. */
  readonly pending: readonly FactoryPendingNode[];
}

export interface FactoryArtifactMark {
  readonly artifactId: string;
  /** Position inside the block, 0-100. */
  readonly xPct: number;
  readonly failed: boolean;
}

export interface FactoryTimelineBlock {
  /** Stable across polls: one attempt is one block forever. */
  readonly key: string;
  readonly node: WorkflowNode;
  readonly attempt: NodeAttempt;
  /** How many attempts this node has consumed in total, for spotting loops. */
  readonly attemptCount: number;
  readonly status: FactoryNodeStatus;
  readonly description: string;
  readonly startMs: number;
  /** Now for a running attempt; its start for one that ended without a time. */
  readonly endMs: number;
  readonly durationMs: number;
  /** Left edge in track-%, from the attempt's real start. */
  readonly leftPct: number;
  readonly widthPct: number;
  /** Artifacts this attempt produced, placed within the block's own span. */
  readonly marks: readonly FactoryArtifactMark[];
}

export interface FactoryPendingNode {
  readonly key: string;
  readonly node: WorkflowNode;
  readonly status: FactoryNodeStatus;
  readonly description: string;
}

export interface FactoryAxisTick {
  readonly pct: number;
  readonly offsetMs: number;
}

export interface FactoryTimeline {
  readonly lanes: readonly FactoryLane[];
  readonly startMs: number;
  readonly endMs: number;
  readonly spanMs: number;
  readonly ticks: readonly FactoryAxisTick[];
  /** False when nothing has started, so the pane can say so instead of drawing an empty grid. */
  readonly hasStarted: boolean;
}

export interface FactoryTimelineOptions {
  /** Clock used to extend running attempts. Passed in so the projection is pure. */
  readonly nowMs: number;
  /** When the run was created. The axis starts here so queueing time is visible. */
  readonly runStartedAtMs: number | null;
  /** When the run finished, if it has. A finished run's axis stops there. */
  readonly runEndedAtMs: number | null;
  /** Legibility floor for a block's width, in track-%. */
  readonly minBlockPct?: number;
  readonly maxTicks?: number;
}

const DEFAULT_MIN_BLOCK_PCT = 2.5;
const MIN_SPAN_MS = 1_000;
/** A hair of right margin so a block that runs to the end still shows its border. */
const TRACK_MARGIN_PCT = 0.5;

// --- lanes -------------------------------------------------------------------

const AGENT_ROLE_LABEL: Record<AgentNode["role"], string> = {
  plan: "planner",
  build: "builder",
  review: "reviewer",
  repair: "repairer",
};

interface LaneIdentity {
  readonly id: string;
  readonly label: string;
  readonly kind: FactoryLaneKind;
  readonly meta: string;
  /** Fixed rank between lane groups; agents are ordered by first appearance. */
  readonly group: number;
}

/**
 * Which worker owns a node.
 *
 * An independent `review` node shares the reviewer's lane with an agent whose
 * role is review, because they are the same worker in the operator's mental
 * model -- a second opinion -- and splitting them would suggest two reviewers
 * exist when only one does.
 */
export function factoryLaneOf(node: WorkflowNode): LaneIdentity {
  switch (node.kind) {
    case "agent":
      return {
        id: `agent:${node.role}`,
        label: AGENT_ROLE_LABEL[node.role],
        kind: "agent",
        meta: node.role,
        group: 3,
      };
    case "review":
      return {
        id: "agent:review",
        label: AGENT_ROLE_LABEL.review,
        kind: "agent",
        meta: "review",
        group: 3,
      };
    case "lavishReview":
      return {
        id: "agent:lavish",
        label: "lavish",
        kind: "agent",
        meta: "review surface",
        group: 3,
      };
    case "browserVerification":
      return { id: "browser", label: "browser", kind: "browser", meta: "verification", group: 2 };
    case "command":
    case "test":
      return { id: "workspace", label: "code", kind: "workspace", meta: "workspace", group: 1 };
    case "approval":
      return {
        id: "operator",
        label: "operator",
        kind: "operator",
        meta: "human decision",
        group: 0,
      };
    case "gate":
      return { id: "gate", label: "gate", kind: "gate", meta: "evidence", group: 4 };
  }
}

/**
 * The one-line description under a block's title.
 *
 * Every kind says the thing that makes its work checkable: the command that ran,
 * the journey that was walked, the question a person was asked. An agent node
 * shows the first sentence of its prompt, which is the closest thing it has to
 * an instruction an operator can hold it to.
 */
export function describeFactoryNode(node: WorkflowNode): string {
  switch (node.kind) {
    case "agent":
      return firstSentence(node.promptTemplate);
    case "command":
    case "test":
      return node.command;
    case "browserVerification":
      return `${node.startPath} · ${node.journey.length} step${node.journey.length === 1 ? "" : "s"}`;
    case "review":
      return node.independentOf.length > 0
        ? `independent of ${node.independentOf.join(", ")}`
        : "independent review";
    case "lavishReview":
      return "human review surface";
    case "approval":
      return node.question;
    case "gate":
      return `${node.checks.length} check${node.checks.length === 1 ? "" : "s"}`;
  }
}

function firstSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const stop = trimmed.search(/[.!?](\s|$)/);
  return stop === -1 ? trimmed : trimmed.slice(0, stop + 1);
}

// --- timeline ----------------------------------------------------------------

/**
 * Every lane, laid out against one axis.
 *
 * Attempts are the unit rather than nodes: a node that was tried three times is
 * three blocks in its lane, so the cost of a repair loop is visible as time
 * spent rather than hidden behind a counter.
 */
export function buildFactoryTimeline(
  snapshot: RunSnapshot,
  options: FactoryTimelineOptions,
): FactoryTimeline {
  const { nowMs, runStartedAtMs, runEndedAtMs } = options;
  const minBlockPct = options.minBlockPct ?? DEFAULT_MIN_BLOCK_PCT;

  const waterfall = buildFactoryWaterfall(snapshot);
  const artifactsByAttempt = groupArtifactsByAttempt(snapshot.artifacts);

  interface Draft {
    readonly identity: LaneIdentity;
    readonly appearance: number;
    readonly timed: {
      node: WorkflowNode;
      attempt: NodeAttempt;
      attemptCount: number;
      status: FactoryNodeStatus;
      startMs: number;
      endMs: number;
    }[];
    readonly pending: FactoryPendingNode[];
  }

  const drafts = new Map<string, Draft>();
  const draftFor = (node: WorkflowNode): Draft => {
    const identity = factoryLaneOf(node);
    const existing = drafts.get(identity.id);
    if (existing) return existing;
    const created: Draft = { identity, appearance: drafts.size, timed: [], pending: [] };
    drafts.set(identity.id, created);
    return created;
  };

  for (const entry of waterfall) {
    const draft = draftFor(entry.node);
    const attempts = snapshot.attempts
      .filter((attempt) => attempt.nodeId === entry.node.id)
      .toSorted((left, right) => left.attemptNumber - right.attemptNumber);

    // An attempt that ended without ever running still belongs on the axis: a
    // node refused at provisioning (no target reports the capability it needs)
    // has a real moment and a real outcome, and burying it in the not-started
    // stack would show a run that gave up three times as one node nobody tried.
    const started = attempts.filter(
      (attempt) => attempt.startedAt !== null || attempt.endedAt !== null,
    );
    for (const [index, attempt] of started.entries()) {
      const startMs = Date.parse(attempt.startedAt ?? attempt.endedAt ?? "");
      if (!Number.isFinite(startMs)) continue;
      // The newest attempt carries the node's status, which knows about
      // satisfaction and revision drift; older ones can only speak for themselves.
      const isLatest = index === started.length - 1 && attempt.id === entry.attempt?.id;
      draft.timed.push({
        node: entry.node,
        attempt,
        attemptCount: entry.attemptCount,
        status: isLatest ? entry.status : statusOfPastAttempt(attempt),
        startMs,
        endMs: resolveEndMs(attempt, startMs, nowMs),
      });
    }

    if (started.length === 0) {
      draft.pending.push({
        key: entry.node.id,
        node: entry.node,
        status: entry.status,
        description: describeFactoryNode(entry.node),
      });
    }
  }

  const timedBlocks = [...drafts.values()].flatMap((draft) => draft.timed);
  const hasStarted = timedBlocks.length > 0;

  const startMs = Math.min(
    ...[runStartedAtMs, ...timedBlocks.map((block) => block.startMs)].filter(
      (value): value is number => value !== null && Number.isFinite(value),
    ),
    // Falls back to the clock so an unstarted run still has a valid axis.
    nowMs,
  );
  const latestEnd = Math.max(
    ...timedBlocks.map((block) => block.endMs),
    runEndedAtMs ?? nowMs,
    startMs,
  );
  const endMs = Math.max(latestEnd, startMs + MIN_SPAN_MS);
  const spanMs = endMs - startMs;
  const available = 100 - TRACK_MARGIN_PCT;

  const lanes = [...drafts.values()]
    .toSorted(
      (left, right) =>
        left.identity.group - right.identity.group || left.appearance - right.appearance,
    )
    .map((draft): FactoryLane => {
      const ordered = draft.timed.toSorted((left, right) => left.startMs - right.startMs);
      const blocks: FactoryTimelineBlock[] = [];
      let previousEdge = 0;

      for (const item of ordered) {
        const width = Math.max(((item.endMs - item.startMs) / spanMs) * available, minBlockPct);
        // Widening a near-instant block must not park it on top of the block
        // before it, so it slides right within its own lane only. Lanes never
        // borrow space from each other, which is what keeps two lanes at the
        // same x comparable.
        const left = Math.min(
          Math.max(((item.startMs - startMs) / spanMs) * available, previousEdge),
          Math.max(available - width, 0),
        );
        previousEdge = left + width;
        blocks.push({
          key: `${item.node.id}#${item.attempt.attemptNumber}`,
          node: item.node,
          attempt: item.attempt,
          attemptCount: item.attemptCount,
          status: item.status,
          description: describeFactoryNode(item.node),
          startMs: item.startMs,
          endMs: item.endMs,
          durationMs: item.endMs - item.startMs,
          leftPct: left,
          widthPct: width,
          marks: buildMarks(
            artifactsByAttempt.get(item.attempt.id) ?? [],
            item.startMs,
            item.endMs,
          ),
        });
      }

      return {
        id: draft.identity.id,
        label: draft.identity.label,
        kind: draft.identity.kind,
        meta: draft.identity.meta,
        blocks,
        pending: draft.pending,
      };
    });

  return {
    lanes,
    startMs,
    endMs,
    spanMs,
    ticks: buildAxisTicks(spanMs, options.maxTicks ?? 6),
    hasStarted,
  };
}

function statusOfPastAttempt(attempt: NodeAttempt): FactoryNodeStatus {
  switch (attempt.state) {
    case "succeeded":
      return "complete";
    case "failed":
    case "lost":
    case "cancelled":
      return "failed";
    case "verifying":
      return "review";
    case "waiting-external":
    case "waiting-agent":
    case "waiting-human":
      return "waiting";
    case "running":
      return "running";
    default:
      return "queued";
  }
}

/**
 * When a block stops.
 *
 * A live attempt runs to the clock so its block grows while it works. An attempt
 * that ended without recording a time gets zero duration rather than an invented
 * one -- a block stretching to now would claim work that may not have happened.
 */
function resolveEndMs(attempt: NodeAttempt, startMs: number, nowMs: number): number {
  const ended = attempt.endedAt === null ? Number.NaN : Date.parse(attempt.endedAt);
  if (Number.isFinite(ended)) return Math.max(ended, startMs);
  const isLive =
    attempt.state !== "succeeded" &&
    attempt.state !== "failed" &&
    attempt.state !== "cancelled" &&
    attempt.state !== "lost";
  return isLive ? Math.max(nowMs, startMs) : startMs;
}

function groupArtifactsByAttempt(artifacts: readonly Artifact[]): Map<string, Artifact[]> {
  const map = new Map<string, Artifact[]>();
  for (const artifact of artifacts) {
    const bucket = map.get(artifact.producedByAttemptId);
    if (bucket) bucket.push(artifact);
    else map.set(artifact.producedByAttemptId, [artifact]);
  }
  return map;
}

function buildMarks(
  artifacts: readonly Artifact[],
  startMs: number,
  endMs: number,
): FactoryArtifactMark[] {
  const span = Math.max(endMs - startMs, 1);
  return artifacts
    .map((artifact) => ({ artifact, at: Date.parse(artifact.createdAt) }))
    .filter((item) => Number.isFinite(item.at))
    .toSorted((left, right) => left.at - right.at)
    .map(({ artifact, at }) => ({
      artifactId: artifact.id,
      // Clamped inside the block: an artifact recorded a beat after the attempt
      // closed still belongs to it, and must not float off the block.
      xPct: Math.min(Math.max(((at - startMs) / span) * 100, 2), 98),
      failed: artifact.outcome === "failed",
    }));
}

const TICK_STEPS_MS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1_800, 3_600, 7_200, 21_600,
].map((seconds) => seconds * 1_000);

/** Evenly stepped offsets across the axis, at most `maxTicks` of them. */
export function buildAxisTicks(spanMs: number, maxTicks: number): FactoryAxisTick[] {
  const span = Math.max(spanMs, 1);
  const step = TICK_STEPS_MS.find((candidate) => span / candidate <= maxTicks) ?? span;
  const ticks: FactoryAxisTick[] = [];
  for (let offset = 0; offset <= span; offset += step) {
    ticks.push({ pct: (offset / span) * 100, offsetMs: offset });
  }
  return ticks;
}
