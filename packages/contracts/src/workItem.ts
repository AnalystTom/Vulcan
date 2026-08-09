// FILE: workItem.ts
// Purpose: The Work Item -- one canonical unit of work, however it arrived --
// and the Kanban columns it is projected into.
// Layer: contract (schema only; the projections live in @vulcan/shared/workItemProjection)
//
// A Work Item is the join point between planning and execution. It keeps a link
// back to wherever it came from (Linear, Hermes, local intake, a phone) without
// letting any of those become a second runtime authority: Vulcan owns execution
// state, and the source owns its own planning metadata.
//
// The column a card sits in is derived, never stored. That is the rule that stops
// a Kanban board from being a place where completion can be asserted rather than
// earned.

import { Schema } from "effect";
import { IsoDateTime, ProjectId, TrimmedNonEmptyString, WorkspaceId } from "./baseSchemas";
import { WorkItemId, WorkflowRunId } from "./factory";

/**
 * Where a Work Item came from.
 *
 * `local` and `mobile` are Vulcan's own intake surfaces; the rest are external
 * systems that keep owning their planning metadata.
 */
export const WorkItemSourceKind = Schema.Literals(["local", "mobile", "linear", "hermes"]);
export type WorkItemSourceKind = typeof WorkItemSourceKind.Type;

/**
 * The link back to the originating system.
 *
 * Retained for the life of the Work Item so external context is never lost, and
 * deliberately inert: nothing here can drive execution.
 */
export const WorkItemSource = Schema.Struct({
  kind: WorkItemSourceKind,
  /** The id in the source system, e.g. a Linear issue identifier. */
  externalId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  url: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type WorkItemSource = typeof WorkItemSource.Type;

/**
 * Operator intent, distinct from execution state.
 *
 * The board's columns come from execution; these are the two things a person can
 * assert directly. `cancelled` is intent because only a person cancels work;
 * `ready` means "I have decided this should run".
 */
export const WorkItemIntent = Schema.Literals(["captured", "ready", "cancelled"]);
export type WorkItemIntent = typeof WorkItemIntent.Type;

export const WorkItem = Schema.Struct({
  id: WorkItemId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  body: Schema.String.check(Schema.isMaxLength(50_000)),
  source: WorkItemSource,
  projectId: Schema.NullOr(ProjectId),
  workspaceId: Schema.NullOr(WorkspaceId),
  intent: WorkItemIntent,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkItem = typeof WorkItem.Type;

/**
 * The coarse columns of the board.
 *
 * Deliberately few. Fine-grained execution state belongs in Factory; Kanban
 * exists to answer "what is happening across everything" at a glance.
 */
export const KanbanColumn = Schema.Literals([
  "inbox",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
  "cancelled",
]);
export type KanbanColumn = typeof KanbanColumn.Type;

export const KANBAN_COLUMNS = [
  "inbox",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
  "cancelled",
] as const satisfies readonly KanbanColumn[];

/**
 * A card: the Work Item plus everything needed to get from the overview to the
 * evidence without a second query.
 */
export const KanbanCard = Schema.Struct({
  workItem: WorkItem,
  column: KanbanColumn,
  /** Why the card is in this column, in the operator's terms. */
  reason: Schema.String.check(Schema.isMaxLength(500)),
  runId: Schema.NullOr(WorkflowRunId),
  workspaceId: Schema.NullOr(WorkspaceId),
  /** How many Attention Items are open against this item's run. */
  openAttentionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pullRequestUrl: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type KanbanCard = typeof KanbanCard.Type;
