// FILE: workItemProjection.ts
// Purpose: Derive the Kanban column of a Work Item, and the Factory view's
// waterfall and activity board, from the same run state.
// Layer: shared domain logic
//
// Kanban and Factory are two projections over one set of facts, not two stores.
// Kanban answers "what is happening across everything"; Factory answers "what is
// happening inside this run". Neither holds state, so they cannot disagree.
//
// The load-bearing rule is that `done` is derived from the configured delivery
// gate having passed at the current revision. There is no way to put a card in
// `done` by moving it, because nothing here reads a stored column -- which is
// what stops a board from being a place where completion is asserted rather than
// earned.

import type {
  AttentionItem,
  GateResult,
  KanbanColumn,
  NodeAttempt,
  WorkflowNode,
  WorkflowNodeId,
  WorkItem,
} from "@vulcan/contracts";

import {
  findLatestAttempt,
  isActiveAttemptState,
  isNodeSatisfied,
  type RunSnapshot,
  topologicalOrder,
} from "./factoryKernel";

export interface KanbanProjectionInput {
  readonly workItem: WorkItem;
  /** Null when no run has been started for this item yet. */
  readonly snapshot: RunSnapshot | null;
  /**
   * The gate whose pass means delivered. Naming it per project is what lets one
   * team's "done" require a Lavish review and another's not, without either
   * being able to skip its own rule.
   */
  readonly deliveryGateNodeId: WorkflowNodeId | null;
  readonly openAttentionItems: readonly AttentionItem[];
}

export interface KanbanPlacement {
  readonly column: KanbanColumn;
  readonly reason: string;
}

/**
 * Which column a Work Item belongs in right now.
 *
 * The order of these checks is the product's precedence, and it is deliberate:
 * cancellation beats everything, delivery beats activity, and needing a person
 * beats being busy -- because an operator scanning the board needs the thing that
 * requires them to be the thing they see.
 */
export function placeWorkItem(input: KanbanProjectionInput): KanbanPlacement {
  const { workItem, snapshot } = input;

  if (workItem.intent === "cancelled") {
    return { column: "cancelled", reason: "Cancelled by the operator." };
  }

  if (snapshot === null) {
    return workItem.intent === "ready"
      ? { column: "ready", reason: "Ready to run; no workflow run has started yet." }
      : { column: "inbox", reason: "Captured, not yet marked ready." };
  }

  // Delivery is checked before activity so a run that has passed its gate reads
  // as done even if a trailing notification node is still going.
  const delivery = findDeliveryGateResult(input);
  if (delivery?.passed === true) {
    return {
      column: "done",
      reason: `Delivery gate passed at ${delivery.revision}.`,
    };
  }

  if (input.openAttentionItems.length > 0) {
    const first = input.openAttentionItems[0];
    return {
      column: "blocked",
      reason:
        input.openAttentionItems.length === 1 && first
          ? first.request
          : `${input.openAttentionItems.length} decisions are waiting on you.`,
    };
  }

  const attempts = snapshot.attempts;
  if (attempts.some((attempt) => attempt.state === "waiting-human")) {
    return { column: "blocked", reason: "Waiting for a human decision." };
  }

  // "Review" is a column rather than a state: it is where an operator looks for
  // work that is finished but unjudged.
  if (isAwaitingReview(snapshot)) {
    return { column: "review", reason: "Work is complete and waiting on review." };
  }

  if (attempts.some((attempt) => isActiveAttemptState(attempt.state))) {
    return { column: "running", reason: "Nodes are executing." };
  }

  if (attempts.length === 0) {
    return { column: "ready", reason: "A run exists but no node has been dispatched." };
  }

  // Nothing running, nothing waiting, delivery not passed: the run cannot make
  // progress on its own, which is a blocked state and not a quiet one.
  return {
    column: "blocked",
    reason: "No node can run and the delivery gate has not passed.",
  };
}

function findDeliveryGateResult(input: KanbanProjectionInput): GateResult | null {
  const { snapshot, deliveryGateNodeId } = input;
  if (!snapshot || deliveryGateNodeId === null) return null;
  // Only a verdict reached at the current revision counts. A pass from before the
  // last commit is history, not delivery.
  const current = snapshot.gateResults.filter(
    (result) =>
      result.nodeId === deliveryGateNodeId && result.revision === snapshot.currentRevision,
  );
  return current.at(-1) ?? null;
}

/**
 * True when every non-review node is satisfied but a review or approval node is
 * not, i.e. the work is done and a judgement is outstanding.
 */
function isAwaitingReview(snapshot: RunSnapshot): boolean {
  const judgementKinds = new Set(["review", "lavishReview", "approval", "gate"]);
  const judgement = snapshot.definition.nodes.filter((node) => judgementKinds.has(node.kind));
  if (judgement.length === 0) return false;

  const work = snapshot.definition.nodes.filter((node) => !judgementKinds.has(node.kind));
  const workDone = work.every((node) => isNodeSatisfied(snapshot, node.id));
  const judgementPending = judgement.some((node) => !isNodeSatisfied(snapshot, node.id));
  return workDone && judgementPending;
}

// --- Factory view ------------------------------------------------------------

/**
 * How a node is doing, for the Factory waterfall and activity board.
 *
 * `not-started` is distinct from `blocked-by-dependency` so the graph can show
 * what is genuinely next versus what is merely later.
 */
export type FactoryNodeStatus =
  | "not-started"
  | "blocked-by-dependency"
  | "queued"
  | "running"
  | "waiting"
  | "review"
  | "failed"
  | "complete";

export interface FactoryWaterfallEntry {
  readonly node: WorkflowNode;
  readonly status: FactoryNodeStatus;
  readonly attempt: NodeAttempt | null;
  /** How many attempts this node has consumed, for spotting repair loops. */
  readonly attemptCount: number;
  /** True for nodes whose output is judgment rather than a determinate result. */
  readonly isAgentWork: boolean;
}

/**
 * The whole graph in execution order, including nodes that have not run.
 *
 * Future nodes are included deliberately: the operator must be able to see the
 * intended factory before it executes, not reconstruct it afterwards. A cyclic
 * definition returns declaration order rather than nothing, because a broken
 * graph still has to be inspectable.
 */
export function buildFactoryWaterfall(snapshot: RunSnapshot): FactoryWaterfallEntry[] {
  const ordered = topologicalOrder(snapshot.definition) ?? [...snapshot.definition.nodes];
  const agentKinds = new Set(["agent", "review"]);

  return ordered.map((node) => {
    const attempt = findLatestAttempt(snapshot, node.id);
    const attemptCount = snapshot.attempts.filter(
      (candidate) => candidate.nodeId === node.id,
    ).length;
    return {
      node,
      attempt,
      attemptCount,
      isAgentWork: agentKinds.has(node.kind),
      status: resolveNodeStatus(snapshot, node, attempt),
    };
  });
}

function resolveNodeStatus(
  snapshot: RunSnapshot,
  node: WorkflowNode,
  attempt: NodeAttempt | null,
): FactoryNodeStatus {
  if (isNodeSatisfied(snapshot, node.id)) return "complete";

  if (attempt) {
    switch (attempt.state) {
      case "queued":
      case "provisioning":
      case "ready":
        return "queued";
      case "running":
        return "running";
      case "waiting-external":
      case "waiting-agent":
      case "waiting-human":
        return "waiting";
      case "verifying":
        return "review";
      case "retrying":
        return "queued";
      case "failed":
      case "lost":
        return "failed";
      case "cancelled":
        return "failed";
      case "succeeded":
        // Succeeded but not satisfied means the revision moved underneath it, so
        // the work has to happen again rather than reading as complete.
        return "not-started";
    }
  }

  const dependenciesMet = node.dependsOn.every((dependency) =>
    isNodeSatisfied(snapshot, dependency),
  );
  return dependenciesMet ? "not-started" : "blocked-by-dependency";
}

/** The activity board's groups, in the order the issue specifies. */
export const FACTORY_ACTIVITY_GROUPS = [
  "queued",
  "running",
  "waiting",
  "review",
  "failed",
  "complete",
] as const;
export type FactoryActivityGroup = (typeof FACTORY_ACTIVITY_GROUPS)[number];

export type FactoryActivityBoard = Record<FactoryActivityGroup, FactoryWaterfallEntry[]>;

/**
 * The waterfall regrouped for scanning.
 *
 * Nodes that have not started and nodes blocked by a dependency are omitted:
 * the board is for what is happening, and the waterfall is where the full plan
 * lives.
 */
export function buildFactoryActivityBoard(snapshot: RunSnapshot): FactoryActivityBoard {
  const board: FactoryActivityBoard = {
    queued: [],
    running: [],
    waiting: [],
    review: [],
    failed: [],
    complete: [],
  };
  for (const entry of buildFactoryWaterfall(snapshot)) {
    if (entry.status === "not-started" || entry.status === "blocked-by-dependency") continue;
    board[entry.status].push(entry);
  }
  return board;
}
