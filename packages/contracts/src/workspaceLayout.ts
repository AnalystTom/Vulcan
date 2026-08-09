// FILE: workspaceLayout.ts
// Purpose: Schemas for a Workspace's persistent Pane layout -- the 3x3 grid, each
// Pane's stable identity, its selected Pane Mode, and the per-mode attachments
// that survive a mode switch.
// Layer: contract (schema only; the operations live in @vulcan/shared/workspaceLayout)
//
// Why a grid of rows rather than a binary split tree
// --------------------------------------------------
// The product bound is "no more than three rows, three columns, or nine visible
// Panes". A binary tree cannot express a three-column row without nesting, and
// once it nests, the bound has to be re-derived from depth on every operation --
// which is how the inherited split view ended up capped at 2x2 with two separate
// depth checks. Rows of cells encode the bound directly: `rows.length <= 3`,
// `row.cells.length <= 3`. Removal closes the gap by construction, and resizing
// is a weight per row plus a weight per cell rather than a ratio per interior
// node.
//
// Panes are stored beside the grid, not inside it. A Pane's identity, mode, and
// attachments must not change when it moves, so the grid only ever holds a
// `paneId`.

import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PaneId,
  PaneRowId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  WorkspaceId,
} from "./baseSchemas";

/** Hard layout bounds. The scheduler, the UI, and persistence all read these. */
export const WORKSPACE_LAYOUT_MAX_ROWS = 3;
export const WORKSPACE_LAYOUT_MAX_COLUMNS = 3;
export const WORKSPACE_LAYOUT_MAX_PANES = 9;

/**
 * Smallest share of a row's width, or of the grid's height, a cell may hold.
 * Enforced on every resize and on every normalization pass so a drag can never
 * produce a zero-size, unreachable region. Three cells at the minimum still
 * leave 64% to distribute.
 */
export const WORKSPACE_LAYOUT_MIN_WEIGHT = 0.12;

/**
 * The Pane Modes a Pane can display.
 *
 * `agent` and `herdrTerminal` are implemented. The rest are declared here so the
 * registry, persistence, and automation share one taxonomy as they are built --
 * the mode picker only offers the implemented ones, and an unimplemented mode
 * renders an explicit unavailable surface rather than an empty Pane.
 */
export const PaneMode = Schema.Literals([
  "agent",
  "herdrTerminal",
  "browser",
  "diff",
  "factory",
  "trace",
  "lavishReview",
]);
export type PaneMode = typeof PaneMode.Type;

export const IMPLEMENTED_PANE_MODES = [
  "agent",
  "herdrTerminal",
] as const satisfies readonly PaneMode[];

/**
 * What a Pane is attached to in a given mode.
 *
 * Keyed by mode and kept for every mode the Pane has ever shown, because
 * switching modes must be reversible: switching away and back has to resume the
 * same Agent Session or terminal rather than start a new one.
 */
export const AgentPaneAttachment = Schema.Struct({
  mode: Schema.Literal("agent"),
  threadId: Schema.NullOr(ThreadId),
});
export type AgentPaneAttachment = typeof AgentPaneAttachment.Type;

/**
 * A durable Herdr terminal. `sessionName` is Herdr's own handle, kept so the
 * Pane can reattach to a still-running terminal after a restart or reconnect.
 *
 * `fallback` records that the user accepted the built-in terminal because Herdr
 * was unavailable. It is deliberately a separate field rather than a different
 * mode: the product must never label or record a fallback terminal as Herdr, and
 * a boolean beside the handle makes that impossible to lose in a projection.
 */
export const HerdrTerminalPaneAttachment = Schema.Struct({
  mode: Schema.Literal("herdrTerminal"),
  sessionName: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  fallbackTerminalId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type HerdrTerminalPaneAttachment = typeof HerdrTerminalPaneAttachment.Type;

/** A mode that has no attachment state yet; carried so the mode is still remembered. */
export const UnattachedPaneAttachment = Schema.Struct({
  mode: Schema.Literals(["browser", "diff", "factory", "trace", "lavishReview"]),
});
export type UnattachedPaneAttachment = typeof UnattachedPaneAttachment.Type;

export const PaneAttachment = Schema.Union([
  AgentPaneAttachment,
  HerdrTerminalPaneAttachment,
  UnattachedPaneAttachment,
]);
export type PaneAttachment = typeof PaneAttachment.Type;

/**
 * A Pane's identity and state, independent of where it sits in the grid.
 *
 * `pinned` protects a Pane from being repurposed by factory automation. Automation
 * may open or focus a Pane Mode, but it must reuse an unpinned Pane, add one, or
 * raise an Attention Item -- never take a pinned Pane away from the operator.
 */
export const WorkspacePane = Schema.Struct({
  paneId: PaneId,
  mode: PaneMode,
  attachments: Schema.Array(PaneAttachment).check(Schema.isMaxLength(16)),
  pinned: Schema.Boolean,
});
export type WorkspacePane = typeof WorkspacePane.Type;

/** One Pane's slot in a row. `widthWeight` is its share of that row's width. */
export const WorkspaceLayoutCell = Schema.Struct({
  paneId: PaneId,
  widthWeight: Schema.Number.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(1)),
});
export type WorkspaceLayoutCell = typeof WorkspaceLayoutCell.Type;

/** One row of the grid. `heightWeight` is its share of the grid's height. */
export const WorkspaceLayoutRow = Schema.Struct({
  rowId: PaneRowId,
  cells: Schema.Array(WorkspaceLayoutCell).check(Schema.isMaxLength(WORKSPACE_LAYOUT_MAX_COLUMNS)),
  heightWeight: Schema.Number.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(1)),
});
export type WorkspaceLayoutRow = typeof WorkspaceLayoutRow.Type;

/**
 * A Workspace's complete Pane layout.
 *
 * `revision` increments on every accepted change. It is the concurrency token:
 * the desktop, a paired mobile client, and the controller can all hold the same
 * Workspace open, and a write carrying a stale revision is rejected rather than
 * silently clobbering another client's layout.
 */
export const WorkspaceLayout = Schema.Struct({
  workspaceId: WorkspaceId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  rows: Schema.Array(WorkspaceLayoutRow).check(Schema.isMaxLength(WORKSPACE_LAYOUT_MAX_ROWS)),
  panes: Schema.Array(WorkspacePane).check(Schema.isMaxLength(WORKSPACE_LAYOUT_MAX_PANES)),
  focusedPaneId: Schema.NullOr(PaneId),
});
export type WorkspaceLayout = typeof WorkspaceLayout.Type;

/**
 * Where a dragged Pane lands relative to the Pane it was dropped on.
 * `center` swaps the two Panes; the edges insert beside or above/below.
 */
export const PaneDropZone = Schema.Literals(["left", "right", "above", "below", "center"]);
export type PaneDropZone = typeof PaneDropZone.Type;

/** Which way a split grows: a new column beside the Pane, or a new row under it. */
export const PaneSplitDirection = Schema.Literals(["right", "below"]);
export type PaneSplitDirection = typeof PaneSplitDirection.Type;

/**
 * Why a layout operation was refused.
 *
 * Every refusal is typed rather than a thrown string, because the caller has to
 * distinguish them: a full layout makes factory automation raise an Attention
 * Item, while a pinned Pane makes it look for a different Pane instead.
 */
export const PaneLayoutRejection = Schema.Literals([
  "row-limit-reached",
  "column-limit-reached",
  "pane-limit-reached",
  "pane-not-found",
  "row-not-found",
  "pane-pinned",
  "duplicate-pane",
  "invalid-weights",
]);
export type PaneLayoutRejection = typeof PaneLayoutRejection.Type;

/** A persisted layout plus the Workspace's place in the project/thread graph. */
export const StoredWorkspaceLayout = Schema.Struct({
  layout: WorkspaceLayout,
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type StoredWorkspaceLayout = typeof StoredWorkspaceLayout.Type;

export const WorkspaceLayoutWriteInput = Schema.Struct({
  layout: WorkspaceLayout,
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  /**
   * The revision the client believed was current, or null to create. A write
   * carrying a stale revision is refused rather than applied.
   */
  expectedRevision: Schema.NullOr(NonNegativeInt),
});
export type WorkspaceLayoutWriteInput = typeof WorkspaceLayoutWriteInput.Type;

/**
 * A conflict is a success, not an error.
 *
 * Two clients editing one Workspace is ordinary, and the loser needs the winning
 * layout to rebase onto. Modelling that as an RPC error would force the client to
 * dig a value out of an error channel it otherwise treats as a failure to report.
 */
export const WorkspaceLayoutWriteResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("stored"), stored: StoredWorkspaceLayout }),
  Schema.Struct({
    outcome: Schema.Literal("conflict"),
    expectedRevision: NonNegativeInt,
    current: StoredWorkspaceLayout,
  }),
]);
export type WorkspaceLayoutWriteResult = typeof WorkspaceLayoutWriteResult.Type;
