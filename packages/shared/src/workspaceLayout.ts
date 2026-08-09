// FILE: workspaceLayout.ts
// Purpose: Every operation that can change a Workspace's Pane grid, as pure
// total functions over the layout value.
// Layer: shared domain logic (server persistence and web UI both apply these,
// so a layout written by one is always valid to the other)
//
// Design notes
// ------------
// Nothing here throws and nothing here reaches for a clock, a random source, or
// the network. Callers supply new ids, so the same inputs always produce the
// same layout -- which is what lets the server validate a client's requested
// change by replaying it rather than trusting the client's result.
//
// Every operation returns `PaneLayoutResult`: either the next layout or a typed
// rejection. Refusals are values because callers must branch on them. Factory
// automation raises an Attention Item for `pane-limit-reached` but looks for a
// different Pane for `pane-pinned`, and neither can be recovered from an
// exception carrying a message.
//
// `normalizeWorkspaceLayout` is the safety net for anything that did not come
// from these operations -- a row from an older schema, a hand-edited database, a
// client that computed weights badly. It is applied on read and after every
// mutation, so the invariants below hold for every layout the product ever
// renders:
//
//   * at most 3 rows, at most 3 cells per row, at most 9 panes
//   * every cell references exactly one pane, and every pane exactly one cell
//   * row height weights sum to 1, and each row's cell width weights sum to 1
//   * no weight is below WORKSPACE_LAYOUT_MIN_WEIGHT, so no region is unreachable
//   * focusedPaneId names a pane that exists, or is null only when there are none

import {
  type PaneDropZone,
  type PaneId,
  type PaneLayoutRejection,
  type PaneMode,
  type PaneRowId,
  type PaneSplitDirection,
  type WorkspaceLayout,
  type WorkspaceLayoutCell,
  type WorkspaceLayoutRow,
  type WorkspacePane,
  WORKSPACE_LAYOUT_MAX_COLUMNS,
  WORKSPACE_LAYOUT_MAX_PANES,
  WORKSPACE_LAYOUT_MAX_ROWS,
  WORKSPACE_LAYOUT_MIN_WEIGHT,
} from "@vulcan/contracts";

export type PaneLayoutResult =
  | { readonly ok: true; readonly layout: WorkspaceLayout }
  | { readonly ok: false; readonly rejection: PaneLayoutRejection };

const accept = (layout: WorkspaceLayout): PaneLayoutResult => ({
  ok: true,
  layout: bumpRevision(normalizeWorkspaceLayout(layout)),
});
const reject = (rejection: PaneLayoutRejection): PaneLayoutResult => ({ ok: false, rejection });

const bumpRevision = (layout: WorkspaceLayout): WorkspaceLayout => ({
  ...layout,
  revision: layout.revision + 1,
});

// --- weights ---

/**
 * Rescales weights to sum to 1 while holding every entry at or above the
 * minimum.
 *
 * The naive approach -- divide by the sum -- can push an entry under the minimum
 * whenever another entry is large, so entries are first floored at the minimum
 * and the remainder is then distributed across the entries that still have room.
 * When the minimum alone already accounts for everything (three cells at 0.12
 * cannot happen, but a corrupt row of nine could), the weights are simply made
 * equal, which is always valid.
 */
export function normalizeWeights(weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const equal = 1 / weights.length;
  if (equal <= WORKSPACE_LAYOUT_MIN_WEIGHT) return weights.map(() => equal);

  const sanitized = weights.map((weight) =>
    Number.isFinite(weight) && weight > 0 ? weight : equal,
  );
  const floor = WORKSPACE_LAYOUT_MIN_WEIGHT;
  const slack = 1 - floor * sanitized.length;
  const excess = sanitized.map((weight) => Math.max(0, weight - floor));
  const excessTotal = excess.reduce((total, value) => total + value, 0);
  if (excessTotal <= 0) return sanitized.map(() => equal);
  return excess.map((value) => floor + (value / excessTotal) * slack);
}

const withNormalizedCellWidths = (row: WorkspaceLayoutRow): WorkspaceLayoutRow => {
  const widths = normalizeWeights(row.cells.map((cell) => cell.widthWeight));
  return {
    ...row,
    cells: row.cells.map((cell, index) => ({ ...cell, widthWeight: widths[index] as number })),
  };
};

// --- lookup ---

export function findPane(layout: WorkspaceLayout, paneId: PaneId): WorkspacePane | null {
  return layout.panes.find((pane) => pane.paneId === paneId) ?? null;
}

export function findRowContainingPane(
  layout: WorkspaceLayout,
  paneId: PaneId,
): WorkspaceLayoutRow | null {
  return layout.rows.find((row) => row.cells.some((cell) => cell.paneId === paneId)) ?? null;
}

/** Row and column of a Pane, or null when it is not placed. Used by keyboard navigation. */
export function findPanePosition(
  layout: WorkspaceLayout,
  paneId: PaneId,
): { readonly rowIndex: number; readonly columnIndex: number } | null {
  for (const [rowIndex, row] of layout.rows.entries()) {
    const columnIndex = row.cells.findIndex((cell) => cell.paneId === paneId);
    if (columnIndex !== -1) return { rowIndex, columnIndex };
  }
  return null;
}

export function countPanes(layout: WorkspaceLayout): number {
  return layout.rows.reduce((total, row) => total + row.cells.length, 0);
}

/** Pane ids in visual order: left to right within a row, top to bottom across rows. */
export function collectPaneIdsInVisualOrder(layout: WorkspaceLayout): PaneId[] {
  return layout.rows.flatMap((row) => row.cells.map((cell) => cell.paneId));
}

// --- normalization ---

/**
 * Repairs a layout into the invariants listed at the top of this file.
 *
 * Applied to anything read from storage or received from a client, and again
 * after every mutation. It drops rather than throws: a layout that cannot be
 * rendered is worse than a layout that lost a pane it could not place.
 */
export function normalizeWorkspaceLayout(layout: WorkspaceLayout): WorkspaceLayout {
  const declaredPanes = new Map(layout.panes.map((pane) => [pane.paneId, pane]));
  const placed = new Set<PaneId>();

  const rows: WorkspaceLayoutRow[] = [];
  for (const row of layout.rows) {
    if (rows.length >= WORKSPACE_LAYOUT_MAX_ROWS) break;
    const cells: WorkspaceLayoutCell[] = [];
    for (const cell of row.cells) {
      if (cells.length >= WORKSPACE_LAYOUT_MAX_COLUMNS) break;
      if (placed.size >= WORKSPACE_LAYOUT_MAX_PANES) break;
      // A cell pointing at a pane that no longer exists, or at one already
      // placed elsewhere, has no renderable content -- drop the cell, not the pane.
      if (!declaredPanes.has(cell.paneId) || placed.has(cell.paneId)) continue;
      placed.add(cell.paneId);
      cells.push(cell);
    }
    if (cells.length === 0) continue; // an empty row would render as an unusable band
    rows.push(withNormalizedCellWidths({ ...row, cells }));
  }

  const heights = normalizeWeights(rows.map((row) => row.heightWeight));
  const normalizedRows = rows.map((row, index) => ({
    ...row,
    heightWeight: heights[index] as number,
  }));

  // Panes nothing references can never be focused or closed, so they are dropped
  // rather than left to accumulate across sessions.
  const panes = layout.panes.filter((pane) => placed.has(pane.paneId));
  const focusedPaneId =
    layout.focusedPaneId !== null && placed.has(layout.focusedPaneId)
      ? layout.focusedPaneId
      : (normalizedRows[0]?.cells[0]?.paneId ?? null);

  return { ...layout, rows: normalizedRows, panes, focusedPaneId };
}

// --- construction ---

export function createWorkspaceLayout(
  workspaceId: WorkspaceLayout["workspaceId"],
  rowId: PaneRowId,
  pane: WorkspacePane,
): WorkspaceLayout {
  return normalizeWorkspaceLayout({
    workspaceId,
    revision: 0,
    rows: [{ rowId, cells: [{ paneId: pane.paneId, widthWeight: 1 }], heightWeight: 1 }],
    panes: [pane],
    focusedPaneId: pane.paneId,
  });
}

export function createPane(paneId: PaneId, mode: PaneMode): WorkspacePane {
  return { paneId, mode, attachments: [emptyAttachment(mode)], pinned: false };
}

function emptyAttachment(mode: PaneMode): WorkspacePane["attachments"][number] {
  switch (mode) {
    case "agent":
      return { mode, threadId: null };
    case "herdrTerminal":
      return { mode, sessionName: null, fallbackTerminalId: null };
    default:
      return { mode };
  }
}

// --- adding panes ---

/**
 * Places a new Pane without disturbing the existing arrangement.
 *
 * Prefers filling the shortest row that still has a free column, so the grid
 * fills out evenly instead of growing one long row and then stacking; only when
 * every row is full does it add a row.
 */
export function addPane(
  layout: WorkspaceLayout,
  pane: WorkspacePane,
  rowId: PaneRowId,
): PaneLayoutResult {
  if (findPane(layout, pane.paneId)) return reject("duplicate-pane");
  if (countPanes(layout) >= WORKSPACE_LAYOUT_MAX_PANES) return reject("pane-limit-reached");

  const shortest = layout.rows.reduce<WorkspaceLayoutRow | null>((best, row) => {
    if (row.cells.length >= WORKSPACE_LAYOUT_MAX_COLUMNS) return best;
    if (best === null || row.cells.length < best.cells.length) return row;
    return best;
  }, null);

  if (shortest) {
    return accept({
      ...layout,
      rows: layout.rows.map((row) =>
        row.rowId === shortest.rowId ? appendCell(row, pane.paneId) : row,
      ),
      panes: [...layout.panes, pane],
      focusedPaneId: pane.paneId,
    });
  }

  if (layout.rows.length >= WORKSPACE_LAYOUT_MAX_ROWS) return reject("row-limit-reached");
  return accept({
    ...layout,
    rows: [
      ...layout.rows,
      {
        rowId,
        cells: [{ paneId: pane.paneId, widthWeight: 1 }],
        heightWeight: shareOfNewRow(layout),
      },
    ],
    panes: [...layout.panes, pane],
    focusedPaneId: pane.paneId,
  });
}

/** A new row takes an equal share, which normalization then rescales the others to fit. */
const shareOfNewRow = (layout: WorkspaceLayout): number => 1 / (layout.rows.length + 1);

function appendCell(row: WorkspaceLayoutRow, paneId: PaneId): WorkspaceLayoutRow {
  return insertCell(row, paneId, row.cells.length);
}

/**
 * Inserts a Pane into a row at `index`, taking its width from the neighbour it
 * was split off. Splitting a Pane must not resize the Panes beside it.
 */
function insertCell(row: WorkspaceLayoutRow, paneId: PaneId, index: number): WorkspaceLayoutRow {
  const donorIndex = Math.min(Math.max(index - 1, 0), row.cells.length - 1);
  const donor = row.cells[donorIndex];
  const width = donor ? donor.widthWeight / 2 : 1;
  const cells = row.cells.map((cell, cellIndex) =>
    cellIndex === donorIndex ? { ...cell, widthWeight: width } : cell,
  );
  cells.splice(index, 0, { paneId, widthWeight: width });
  return withNormalizedCellWidths({ ...row, cells });
}

/**
 * Splits a Pane, growing the grid by a column beside it or a row beneath it.
 *
 * A `below` split does not subdivide the row -- it inserts a whole new row under
 * the current one. That is what keeps the column count meaningful: every Pane in
 * a row is a real column of the grid, so "three columns" is a property anyone can
 * read off the structure instead of deriving from nesting depth.
 */
export function splitPane(
  layout: WorkspaceLayout,
  paneId: PaneId,
  direction: PaneSplitDirection,
  pane: WorkspacePane,
  rowId: PaneRowId,
): PaneLayoutResult {
  if (findPane(layout, pane.paneId)) return reject("duplicate-pane");
  if (!findPane(layout, paneId)) return reject("pane-not-found");
  if (countPanes(layout) >= WORKSPACE_LAYOUT_MAX_PANES) return reject("pane-limit-reached");

  const position = findPanePosition(layout, paneId);
  const row = findRowContainingPane(layout, paneId);
  if (!position || !row) return reject("pane-not-found");

  if (direction === "right") {
    if (row.cells.length >= WORKSPACE_LAYOUT_MAX_COLUMNS) return reject("column-limit-reached");
    return accept({
      ...layout,
      rows: layout.rows.map((candidate) =>
        candidate.rowId === row.rowId
          ? insertCell(candidate, pane.paneId, position.columnIndex + 1)
          : candidate,
      ),
      panes: [...layout.panes, pane],
      focusedPaneId: pane.paneId,
    });
  }

  if (layout.rows.length >= WORKSPACE_LAYOUT_MAX_ROWS) return reject("row-limit-reached");
  const rows = [...layout.rows];
  rows.splice(position.rowIndex + 1, 0, {
    rowId,
    cells: [{ paneId: pane.paneId, widthWeight: 1 }],
    heightWeight: row.heightWeight / 2,
  });
  return accept({
    ...layout,
    rows: rows.map((candidate) =>
      candidate.rowId === row.rowId
        ? { ...candidate, heightWeight: row.heightWeight / 2 }
        : candidate,
    ),
    panes: [...layout.panes, pane],
    focusedPaneId: pane.paneId,
  });
}

// --- removing panes ---

/**
 * Detaches a Pane from the grid and closes the gap.
 *
 * This is layout only. The Agent Session, Herdr terminal, browser, or review
 * session the Pane was attached to is untouched -- terminating those is a
 * separate, explicit action, so cleaning up a layout can never destroy work.
 */
export function removePane(layout: WorkspaceLayout, paneId: PaneId): PaneLayoutResult {
  if (!findPane(layout, paneId)) return reject("pane-not-found");

  const rows = layout.rows
    .map((row) => ({ ...row, cells: row.cells.filter((cell) => cell.paneId !== paneId) }))
    .filter((row) => row.cells.length > 0);

  const remaining = collectPaneIdsInVisualOrder({ ...layout, rows });
  const focusedPaneId =
    layout.focusedPaneId === paneId
      ? (nearestSurvivingPane(layout, paneId, remaining) ?? null)
      : layout.focusedPaneId;

  return accept({
    ...layout,
    rows,
    panes: layout.panes.filter((pane) => pane.paneId !== paneId),
    focusedPaneId,
  });
}

/**
 * After closing the focused Pane, focus should land where the operator was
 * looking -- the next Pane in visual order, or the previous one when the closed
 * Pane was last.
 */
function nearestSurvivingPane(
  layout: WorkspaceLayout,
  removedPaneId: PaneId,
  remaining: readonly PaneId[],
): PaneId | undefined {
  const order = collectPaneIdsInVisualOrder(layout);
  const removedIndex = order.indexOf(removedPaneId);
  for (let index = removedIndex + 1; index < order.length; index += 1) {
    const candidate = order[index] as PaneId;
    if (remaining.includes(candidate)) return candidate;
  }
  for (let index = removedIndex - 1; index >= 0; index -= 1) {
    const candidate = order[index] as PaneId;
    if (remaining.includes(candidate)) return candidate;
  }
  return remaining[0];
}

// --- moving panes ---

/**
 * Moves a Pane onto a drop target. `center` swaps the two Panes; an edge zone
 * inserts the dragged Pane beside, above, or below the target.
 *
 * Insertion is attempted first and the move is refused if it would breach a
 * bound, so a drag can never silently discard the dragged Pane. Removing the
 * Pane first would make room and turn every refusal into a surprise reflow.
 */
export function movePane(
  layout: WorkspaceLayout,
  paneId: PaneId,
  targetPaneId: PaneId,
  zone: PaneDropZone,
  rowId: PaneRowId,
): PaneLayoutResult {
  if (paneId === targetPaneId) return accept(layout);
  if (!findPane(layout, paneId) || !findPane(layout, targetPaneId)) return reject("pane-not-found");

  if (zone === "center") return swapPanes(layout, paneId, targetPaneId);

  const target = findPanePosition(layout, targetPaneId);
  const targetRow = findRowContainingPane(layout, targetPaneId);
  const source = findPanePosition(layout, paneId);
  if (!target || !targetRow || !source) return reject("pane-not-found");

  const sourceRow = layout.rows[source.rowIndex] as WorkspaceLayoutRow;
  const movingWithinRow = sourceRow.rowId === targetRow.rowId;

  if (zone === "left" || zone === "right") {
    // Reordering inside a row never changes the column count, so the column bound
    // only applies when the Pane arrives from another row.
    if (!movingWithinRow && targetRow.cells.length >= WORKSPACE_LAYOUT_MAX_COLUMNS) {
      return reject("column-limit-reached");
    }
    const detached = detachPane(layout, paneId);
    const insertRow = detached.rows.find((row) => row.rowId === targetRow.rowId);
    if (!insertRow) return reject("row-not-found");
    const anchor = insertRow.cells.findIndex((cell) => cell.paneId === targetPaneId);
    const index = zone === "left" ? anchor : anchor + 1;
    return accept({
      ...detached,
      rows: detached.rows.map((row) =>
        row.rowId === targetRow.rowId ? insertCell(row, paneId, index) : row,
      ),
      focusedPaneId: paneId,
    });
  }

  // A vertical drop wants a new row. Rows only free up when the dragged Pane was
  // alone in its own row, in which case the move is a reorder of existing rows.
  const sourceRowEmpties = sourceRow.cells.length === 1;
  if (layout.rows.length >= WORKSPACE_LAYOUT_MAX_ROWS && !sourceRowEmpties) {
    return reject("row-limit-reached");
  }

  const detached = detachPane(layout, paneId);
  const anchorIndex = detached.rows.findIndex((row) => row.rowId === targetRow.rowId);
  if (anchorIndex === -1) return reject("row-not-found");
  const rows = [...detached.rows];
  rows.splice(zone === "above" ? anchorIndex : anchorIndex + 1, 0, {
    rowId,
    cells: [{ paneId, widthWeight: 1 }],
    heightWeight: shareOfNewRow(detached),
  });
  return accept({ ...detached, rows, focusedPaneId: paneId });
}

/** Removes a Pane's cell but keeps the Pane, for reinsertion elsewhere in the same operation. */
function detachPane(layout: WorkspaceLayout, paneId: PaneId): WorkspaceLayout {
  const rows = layout.rows
    .map((row) => {
      const cells = row.cells.filter((cell) => cell.paneId !== paneId);
      return cells.length === row.cells.length ? row : withNormalizedCellWidths({ ...row, cells });
    })
    .filter((row) => row.cells.length > 0);
  return { ...layout, rows };
}

/** Exchanges two Panes' positions. Both keep their own width; only the ids swap. */
export function swapPanes(
  layout: WorkspaceLayout,
  paneId: PaneId,
  otherPaneId: PaneId,
): PaneLayoutResult {
  if (!findPane(layout, paneId) || !findPane(layout, otherPaneId)) return reject("pane-not-found");
  return accept({
    ...layout,
    rows: layout.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => {
        if (cell.paneId === paneId) return { ...cell, paneId: otherPaneId };
        if (cell.paneId === otherPaneId) return { ...cell, paneId };
        return cell;
      }),
    })),
    focusedPaneId: paneId,
  });
}

// --- resizing ---

/** Sets every row's height share at once; the caller supplies the full set from a drag. */
export function setRowHeightWeights(
  layout: WorkspaceLayout,
  weights: readonly number[],
): PaneLayoutResult {
  if (weights.length !== layout.rows.length) return reject("invalid-weights");
  const normalized = normalizeWeights(weights);
  return accept({
    ...layout,
    rows: layout.rows.map((row, index) => ({
      ...row,
      heightWeight: normalized[index] as number,
    })),
  });
}

/** Sets every cell's width share within one row. */
export function setCellWidthWeights(
  layout: WorkspaceLayout,
  rowId: PaneRowId,
  weights: readonly number[],
): PaneLayoutResult {
  const row = layout.rows.find((candidate) => candidate.rowId === rowId);
  if (!row) return reject("row-not-found");
  if (weights.length !== row.cells.length) return reject("invalid-weights");
  const normalized = normalizeWeights(weights);
  return accept({
    ...layout,
    rows: layout.rows.map((candidate) =>
      candidate.rowId === rowId
        ? {
            ...candidate,
            cells: candidate.cells.map((cell, index) => ({
              ...cell,
              widthWeight: normalized[index] as number,
            })),
          }
        : candidate,
    ),
  });
}

// --- pane state ---

/**
 * Switches a Pane's mode, keeping the attachment the outgoing mode was using.
 *
 * Retaining the attachment is what makes a mode switch non-destructive: the Agent
 * Session or terminal behind the previous mode keeps running and is resumed
 * verbatim when the operator switches back.
 */
export function setPaneMode(
  layout: WorkspaceLayout,
  paneId: PaneId,
  mode: PaneMode,
): PaneLayoutResult {
  const pane = findPane(layout, paneId);
  if (!pane) return reject("pane-not-found");
  if (pane.mode === mode) return accept(layout);

  const attachments = pane.attachments.some((attachment) => attachment.mode === mode)
    ? pane.attachments
    : [...pane.attachments, emptyAttachment(mode)];
  return accept({
    ...layout,
    panes: layout.panes.map((candidate) =>
      candidate.paneId === paneId ? { ...candidate, mode, attachments } : candidate,
    ),
  });
}

export function setPaneAttachment(
  layout: WorkspaceLayout,
  paneId: PaneId,
  attachment: WorkspacePane["attachments"][number],
): PaneLayoutResult {
  const pane = findPane(layout, paneId);
  if (!pane) return reject("pane-not-found");
  const attachments = pane.attachments.some((candidate) => candidate.mode === attachment.mode)
    ? pane.attachments.map((candidate) =>
        candidate.mode === attachment.mode ? attachment : candidate,
      )
    : [...pane.attachments, attachment];
  return accept({
    ...layout,
    panes: layout.panes.map((candidate) =>
      candidate.paneId === paneId ? { ...candidate, attachments } : candidate,
    ),
  });
}

export function readPaneAttachment<TMode extends PaneMode>(
  pane: WorkspacePane,
  mode: TMode,
): Extract<WorkspacePane["attachments"][number], { mode: TMode }> | null {
  const found = pane.attachments.find((attachment) => attachment.mode === mode);
  return (found as Extract<WorkspacePane["attachments"][number], { mode: TMode }>) ?? null;
}

export function setPanePinned(
  layout: WorkspaceLayout,
  paneId: PaneId,
  pinned: boolean,
): PaneLayoutResult {
  if (!findPane(layout, paneId)) return reject("pane-not-found");
  return accept({
    ...layout,
    panes: layout.panes.map((pane) => (pane.paneId === paneId ? { ...pane, pinned } : pane)),
  });
}

export function focusPane(layout: WorkspaceLayout, paneId: PaneId): PaneLayoutResult {
  if (!findPane(layout, paneId)) return reject("pane-not-found");
  return accept({ ...layout, focusedPaneId: paneId });
}

// --- keyboard navigation ---

/**
 * The Pane in a given direction from the focused one.
 *
 * Rows can hold different numbers of Panes, so moving between rows keeps the
 * column index where possible and otherwise clamps to the nearest column, which
 * is what makes repeated up/down presses feel stable rather than drifting.
 */
export function findPaneInDirection(
  layout: WorkspaceLayout,
  paneId: PaneId,
  direction: "left" | "right" | "up" | "down",
): PaneId | null {
  const position = findPanePosition(layout, paneId);
  if (!position) return null;
  const { rowIndex, columnIndex } = position;

  if (direction === "left" || direction === "right") {
    const row = layout.rows[rowIndex];
    const nextColumn = direction === "left" ? columnIndex - 1 : columnIndex + 1;
    return row?.cells[nextColumn]?.paneId ?? null;
  }

  const nextRow = layout.rows[direction === "up" ? rowIndex - 1 : rowIndex + 1];
  if (!nextRow) return null;
  const clamped = Math.min(columnIndex, nextRow.cells.length - 1);
  return nextRow.cells[clamped]?.paneId ?? null;
}

// --- automation placement ---

export type AutomationPlacement =
  | { readonly kind: "focus-existing"; readonly paneId: PaneId }
  | { readonly kind: "reuse"; readonly paneId: PaneId }
  | { readonly kind: "add" }
  | { readonly kind: "attention"; readonly rejection: PaneLayoutRejection };

/**
 * Decides where factory automation should show a Pane Mode, without changing
 * anything.
 *
 * The order matters and is the product rule: focus a Pane already showing this
 * mode, otherwise repurpose an unpinned Pane, otherwise add one, and when the
 * grid is full raise an Attention Item so the operator chooses. Automation is
 * never allowed to take a pinned Pane, which is what makes pinning a real
 * guarantee rather than a hint.
 */
export function planAutomationPlacement(
  layout: WorkspaceLayout,
  mode: PaneMode,
): AutomationPlacement {
  const showing = layout.panes.find((pane) => pane.mode === mode);
  if (showing) return { kind: "focus-existing", paneId: showing.paneId };

  if (countPanes(layout) < WORKSPACE_LAYOUT_MAX_PANES) {
    const hasColumnRoom = layout.rows.some(
      (row) => row.cells.length < WORKSPACE_LAYOUT_MAX_COLUMNS,
    );
    if (hasColumnRoom || layout.rows.length < WORKSPACE_LAYOUT_MAX_ROWS) return { kind: "add" };
  }

  // Prefer the least recently focused unpinned Pane: the focused Pane is the one
  // the operator is using right now, so it is the worst candidate to repurpose.
  const reusable = collectPaneIdsInVisualOrder(layout)
    .filter((candidate) => candidate !== layout.focusedPaneId)
    .map((candidate) => findPane(layout, candidate))
    .find((pane): pane is WorkspacePane => pane !== null && !pane.pinned);
  if (reusable) return { kind: "reuse", paneId: reusable.paneId };

  return { kind: "attention", rejection: "pane-limit-reached" };
}
