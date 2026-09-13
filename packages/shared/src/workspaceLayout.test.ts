import {
  type PaneId,
  type ThreadId,
  type PaneRowId,
  type WorkspaceId,
  type WorkspaceLayout,
  WORKSPACE_LAYOUT_MAX_PANES,
  WORKSPACE_LAYOUT_MIN_WEIGHT,
} from "@vulcan/contracts";
import { describe, expect, it } from "vitest";
import {
  addPane,
  collectPaneIdsInVisualOrder,
  countPanes,
  createPane,
  createWorkspaceLayout,
  findPane,
  findPaneInDirection,
  findPanePosition,
  focusPane,
  movePane,
  normalizeWeights,
  normalizeWorkspaceLayout,
  type PaneLayoutResult,
  planAutomationPlacement,
  readPaneAttachment,
  removePane,
  setCellWidthWeights,
  setPaneAttachment,
  setPaneMode,
  setPanePinned,
  setRowHeightWeights,
  splitPane,
} from "./workspaceLayout";

const workspaceId = "workspace-1" as WorkspaceId;
const paneId = (name: string) => name as PaneId;
const rowId = (name: string) => name as PaneRowId;

function expectAccepted(result: PaneLayoutResult): WorkspaceLayout {
  if (!result.ok) throw new Error(`expected acceptance, got rejection ${result.rejection}`);
  return result.layout;
}

function expectRejected(result: PaneLayoutResult): string {
  if (result.ok) throw new Error("expected rejection, got acceptance");
  return result.rejection;
}

const singlePaneLayout = () =>
  createWorkspaceLayout(workspaceId, rowId("row-1"), createPane(paneId("pane-1"), "agent"));

/** Adds panes until the requested count, mirroring how the "add pane" control behaves. */
function layoutWithPaneCount(count: number): WorkspaceLayout {
  let layout = singlePaneLayout();
  for (let index = 2; index <= count; index += 1) {
    layout = expectAccepted(
      addPane(layout, createPane(paneId(`pane-${index}`), "agent"), rowId(`row-${index}`)),
    );
  }
  return layout;
}

/** Every invariant normalization promises, asserted together so each test can check all of them. */
function expectLayoutInvariants(layout: WorkspaceLayout): void {
  expect(layout.rows.length).toBeLessThanOrEqual(3);
  expect(countPanes(layout)).toBeLessThanOrEqual(WORKSPACE_LAYOUT_MAX_PANES);

  const heights = layout.rows.reduce((total, row) => total + row.heightWeight, 0);
  if (layout.rows.length > 0) expect(heights).toBeCloseTo(1, 8);

  const placed = new Set<string>();
  for (const row of layout.rows) {
    expect(row.cells.length).toBeGreaterThan(0);
    expect(row.cells.length).toBeLessThanOrEqual(3);
    expect(row.heightWeight).toBeGreaterThanOrEqual(WORKSPACE_LAYOUT_MIN_WEIGHT - 1e-9);
    const widths = row.cells.reduce((total, cell) => total + cell.widthWeight, 0);
    expect(widths).toBeCloseTo(1, 8);
    for (const cell of row.cells) {
      expect(cell.widthWeight).toBeGreaterThanOrEqual(WORKSPACE_LAYOUT_MIN_WEIGHT - 1e-9);
      expect(placed.has(cell.paneId)).toBe(false);
      placed.add(cell.paneId);
      expect(findPane(layout, cell.paneId)).not.toBeNull();
    }
  }
  // Every declared pane is placed exactly once, and vice versa.
  expect(placed.size).toBe(layout.panes.length);
  if (layout.panes.length === 0) expect(layout.focusedPaneId).toBeNull();
  else expect(placed.has(layout.focusedPaneId as string)).toBe(true);
}

describe("workspace layout bounds", () => {
  it("fills to nine panes and refuses a tenth", () => {
    const layout = layoutWithPaneCount(WORKSPACE_LAYOUT_MAX_PANES);
    expect(countPanes(layout)).toBe(9);
    expect(layout.rows).toHaveLength(3);
    for (const row of layout.rows) expect(row.cells).toHaveLength(3);
    expectLayoutInvariants(layout);

    expect(
      expectRejected(addPane(layout, createPane(paneId("pane-10"), "agent"), rowId("row-10"))),
    ).toBe("pane-limit-reached");
  });

  it("fills rows evenly rather than growing one row then stacking", () => {
    // Four panes should be 3 + 1, not 3 across with a second row left empty of
    // the balance -- the fourth has nowhere else to go, and the fifth joins it.
    const layout = layoutWithPaneCount(5);
    expect(layout.rows.map((row) => row.cells.length)).toEqual([3, 2]);
    expectLayoutInvariants(layout);
  });

  it("refuses a fourth column and a fourth row", () => {
    let layout = singlePaneLayout();
    layout = expectAccepted(
      splitPane(layout, paneId("pane-1"), "right", createPane(paneId("b"), "agent"), rowId("r2")),
    );
    layout = expectAccepted(
      splitPane(layout, paneId("b"), "right", createPane(paneId("c"), "agent"), rowId("r3")),
    );
    expect(layout.rows[0]?.cells).toHaveLength(3);
    expect(
      expectRejected(
        splitPane(layout, paneId("c"), "right", createPane(paneId("d"), "agent"), rowId("r4")),
      ),
    ).toBe("column-limit-reached");

    layout = expectAccepted(
      splitPane(layout, paneId("c"), "below", createPane(paneId("e"), "agent"), rowId("r5")),
    );
    layout = expectAccepted(
      splitPane(layout, paneId("e"), "below", createPane(paneId("f"), "agent"), rowId("r6")),
    );
    expect(layout.rows).toHaveLength(3);
    expect(
      expectRejected(
        splitPane(layout, paneId("f"), "below", createPane(paneId("g"), "agent"), rowId("r7")),
      ),
    ).toBe("row-limit-reached");
  });
});

describe("workspace layout splitting", () => {
  it("places a right split directly beside its origin and takes width from it", () => {
    const layout = layoutWithPaneCount(2);
    const withSplit = expectAccepted(
      splitPane(layout, paneId("pane-1"), "right", createPane(paneId("new"), "agent"), rowId("r")),
    );
    expect(findPanePosition(withSplit, paneId("new"))).toEqual({ rowIndex: 0, columnIndex: 1 });
    // pane-2 was not resized to make room; the donor pane-1 was halved.
    const cells = withSplit.rows[0]?.cells ?? [];
    expect(cells.map((cell) => cell.paneId)).toEqual(["pane-1", "new", "pane-2"]);
    expect(cells[0]?.widthWeight).toBeCloseTo(cells[1]?.widthWeight ?? 0, 8);
    expectLayoutInvariants(withSplit);
  });

  it("places a below split in a new row under its origin", () => {
    const layout = layoutWithPaneCount(3);
    const withSplit = expectAccepted(
      splitPane(layout, paneId("pane-2"), "below", createPane(paneId("new"), "agent"), rowId("r")),
    );
    expect(withSplit.rows).toHaveLength(2);
    expect(findPanePosition(withSplit, paneId("new"))).toEqual({ rowIndex: 1, columnIndex: 0 });
    expectLayoutInvariants(withSplit);
  });
});

describe("workspace layout removal", () => {
  it("closes the gap and drops the row when its last pane leaves", () => {
    let layout = layoutWithPaneCount(4); // rows: [3, 1]
    layout = expectAccepted(removePane(layout, paneId("pane-4")));
    expect(layout.rows).toHaveLength(1);
    expect(collectPaneIdsInVisualOrder(layout)).toEqual(["pane-1", "pane-2", "pane-3"]);
    expectLayoutInvariants(layout);
  });

  it("moves focus to the next pane in visual order, then to the previous one", () => {
    let layout = layoutWithPaneCount(3);
    layout = expectAccepted(focusPane(layout, paneId("pane-2")));
    layout = expectAccepted(removePane(layout, paneId("pane-2")));
    expect(layout.focusedPaneId).toBe("pane-3");

    layout = expectAccepted(focusPane(layout, paneId("pane-3")));
    layout = expectAccepted(removePane(layout, paneId("pane-3")));
    expect(layout.focusedPaneId).toBe("pane-1");
  });

  it("leaves an empty but valid layout when the last pane is removed", () => {
    const layout = expectAccepted(removePane(singlePaneLayout(), paneId("pane-1")));
    expect(layout.rows).toHaveLength(0);
    expect(layout.panes).toHaveLength(0);
    expect(layout.focusedPaneId).toBeNull();
    expectLayoutInvariants(layout);
  });

  it("removes only the pane from the layout, never its attachment", () => {
    // Closing a pane is layout-only: the caller keeps the thread id it was showing
    // so it can reattach, and nothing here can terminate a session.
    let layout = singlePaneLayout();
    layout = expectAccepted(
      setPaneAttachment(layout, paneId("pane-1"), {
        mode: "agent",
        threadId: "thread-9" as ThreadId,
      }),
    );
    const pane = findPane(layout, paneId("pane-1"));
    expect(readPaneAttachment(pane!, "agent")?.threadId).toBe("thread-9");
    const after = expectAccepted(removePane(layout, paneId("pane-1")));
    expect(after.panes).toHaveLength(0);
  });
});

describe("workspace layout moving", () => {
  it("swaps two panes on a center drop, leaving the grid shape untouched", () => {
    const layout = layoutWithPaneCount(4);
    const shapeBefore = layout.rows.map((row) => row.cells.length);
    const moved = expectAccepted(
      movePane(layout, paneId("pane-1"), paneId("pane-4"), "center", rowId("r")),
    );
    expect(moved.rows.map((row) => row.cells.length)).toEqual(shapeBefore);
    expect(findPanePosition(moved, paneId("pane-1"))).toEqual({ rowIndex: 1, columnIndex: 0 });
    expect(findPanePosition(moved, paneId("pane-4"))).toEqual({ rowIndex: 0, columnIndex: 0 });
    expectLayoutInvariants(moved);
  });

  it("reorders within a row even when that row is already full", () => {
    const layout = layoutWithPaneCount(3); // one full row
    const moved = expectAccepted(
      movePane(layout, paneId("pane-3"), paneId("pane-1"), "left", rowId("r")),
    );
    expect(collectPaneIdsInVisualOrder(moved)).toEqual(["pane-3", "pane-1", "pane-2"]);
    expectLayoutInvariants(moved);
  });

  it("refuses a cross-row drop into a full row instead of dropping the pane", () => {
    const layout = layoutWithPaneCount(4); // rows: [3, 1]
    expect(
      expectRejected(movePane(layout, paneId("pane-4"), paneId("pane-1"), "left", rowId("r"))),
    ).toBe("column-limit-reached");
    // The pane is still exactly where it was.
    expect(findPanePosition(layout, paneId("pane-4"))).toEqual({ rowIndex: 1, columnIndex: 0 });
  });

  it("allows a vertical drop at the row limit when the source row empties", () => {
    // rows: [3, 3, 1] -- moving the lone pane of row 3 frees that row, so the
    // move is a reorder and must not be refused for hitting the row cap.
    const layout = layoutWithPaneCount(7);
    expect(layout.rows.map((row) => row.cells.length)).toEqual([3, 3, 1]);
    const moved = expectAccepted(
      movePane(layout, paneId("pane-7"), paneId("pane-1"), "above", rowId("r-new")),
    );
    expect(moved.rows).toHaveLength(3);
    expect(findPanePosition(moved, paneId("pane-7"))).toEqual({ rowIndex: 0, columnIndex: 0 });
    expectLayoutInvariants(moved);
  });

  it("refuses a vertical drop at the row limit when the source row survives", () => {
    const layout = layoutWithPaneCount(9);
    expect(
      expectRejected(movePane(layout, paneId("pane-9"), paneId("pane-1"), "above", rowId("r"))),
    ).toBe("row-limit-reached");
  });
});

describe("workspace layout resizing", () => {
  it("normalizes row heights and keeps every row reachable", () => {
    const layout = layoutWithPaneCount(4);
    const resized = expectAccepted(setRowHeightWeights(layout, [0.99, 0.01]));
    expect(resized.rows[1]?.heightWeight).toBeGreaterThanOrEqual(WORKSPACE_LAYOUT_MIN_WEIGHT);
    expectLayoutInvariants(resized);
  });

  it("normalizes cell widths within a row", () => {
    const layout = layoutWithPaneCount(3);
    const row = layout.rows[0];
    const resized = expectAccepted(
      setCellWidthWeights(layout, row?.rowId as PaneRowId, [5, 0, -2]),
    );
    expectLayoutInvariants(resized);
  });

  it("refuses a weight list that does not match the row", () => {
    const layout = layoutWithPaneCount(3);
    expect(expectRejected(setRowHeightWeights(layout, [0.5, 0.5]))).toBe("invalid-weights");
  });

  it("distributes to equal weights when the minimum cannot be honoured", () => {
    // Nine entries at the 0.12 minimum would need 1.08, so equal shares are the
    // only valid answer.
    const weights = normalizeWeights([9, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(weights).toHaveLength(9);
    for (const weight of weights) expect(weight).toBeCloseTo(1 / 9, 8);
  });
});

describe("workspace pane state", () => {
  it("does not advance the revision when focusing the focused pane", () => {
    const layout = singlePaneLayout();
    const result = focusPane(layout, paneId("pane-1"));

    expect(result).toEqual({ ok: true, layout });
  });

  it("keeps the previous mode's attachment so switching back resumes it", () => {
    let layout = singlePaneLayout();
    layout = expectAccepted(
      setPaneAttachment(layout, paneId("pane-1"), {
        mode: "agent",
        threadId: "thread-7" as ThreadId,
      }),
    );
    layout = expectAccepted(setPaneMode(layout, paneId("pane-1"), "herdrTerminal"));
    layout = expectAccepted(
      setPaneAttachment(layout, paneId("pane-1"), {
        mode: "herdrTerminal",
        sessionName: "herdr-session-1",
        fallbackTerminalId: null,
      }),
    );
    layout = expectAccepted(setPaneMode(layout, paneId("pane-1"), "agent"));

    const pane = findPane(layout, paneId("pane-1"));
    expect(pane?.mode).toBe("agent");
    expect(readPaneAttachment(pane!, "agent")?.threadId).toBe("thread-7");
    expect(readPaneAttachment(pane!, "herdrTerminal")?.sessionName).toBe("herdr-session-1");
  });

  it("keeps a native Hermes profile attached across mode switches", () => {
    let layout = singlePaneLayout();
    layout = expectAccepted(setPaneMode(layout, paneId("pane-1"), "hermesBot"));
    layout = expectAccepted(
      setPaneAttachment(layout, paneId("pane-1"), {
        mode: "hermesBot",
        profile: "research",
      }),
    );
    layout = expectAccepted(setPaneMode(layout, paneId("pane-1"), "agent"));
    layout = expectAccepted(setPaneMode(layout, paneId("pane-1"), "hermesBot"));

    const pane = findPane(layout, paneId("pane-1"));
    expect(readPaneAttachment(pane!, "hermesBot")?.profile).toBe("research");
  });

  it("records an accepted fallback terminal separately from a Herdr session", () => {
    // The product must never label a fallback terminal as Herdr, so the handle
    // and the fallback id are distinct fields rather than one overloaded value.
    let layout = singlePaneLayout();
    layout = expectAccepted(setPaneMode(layout, paneId("pane-1"), "herdrTerminal"));
    layout = expectAccepted(
      setPaneAttachment(layout, paneId("pane-1"), {
        mode: "herdrTerminal",
        sessionName: null,
        fallbackTerminalId: "terminal-3",
      }),
    );
    const attachment = readPaneAttachment(findPane(layout, paneId("pane-1"))!, "herdrTerminal");
    expect(attachment?.sessionName).toBeNull();
    expect(attachment?.fallbackTerminalId).toBe("terminal-3");
  });

  it("keeps pane identity stable across a move and a mode switch", () => {
    let layout = layoutWithPaneCount(4);
    const before = findPane(layout, paneId("pane-1"));
    layout = expectAccepted(
      movePane(layout, paneId("pane-1"), paneId("pane-4"), "center", rowId("r")),
    );
    layout = expectAccepted(setPaneMode(layout, paneId("pane-1"), "herdrTerminal"));
    const after = findPane(layout, paneId("pane-1"));
    expect(after?.paneId).toBe(before?.paneId);
    expect(after?.pinned).toBe(before?.pinned);
  });
});

describe("workspace layout keyboard navigation", () => {
  it("moves within a row and clamps to the nearest column across rows", () => {
    const layout = layoutWithPaneCount(4); // rows: [3, 1]
    expect(findPaneInDirection(layout, paneId("pane-1"), "right")).toBe("pane-2");
    expect(findPaneInDirection(layout, paneId("pane-1"), "left")).toBeNull();
    // Column 2 has no counterpart in a one-pane row, so it clamps to column 0.
    expect(findPaneInDirection(layout, paneId("pane-3"), "down")).toBe("pane-4");
    expect(findPaneInDirection(layout, paneId("pane-4"), "up")).toBe("pane-1");
    expect(findPaneInDirection(layout, paneId("pane-4"), "down")).toBeNull();
  });
});

describe("workspace layout automation placement", () => {
  it("focuses a pane already showing the mode", () => {
    let layout = layoutWithPaneCount(2);
    layout = expectAccepted(setPaneMode(layout, paneId("pane-2"), "herdrTerminal"));
    expect(planAutomationPlacement(layout, "herdrTerminal")).toEqual({
      kind: "focus-existing",
      paneId: "pane-2",
    });
  });

  it("adds a pane when the grid has capacity", () => {
    const layout = layoutWithPaneCount(2);
    expect(planAutomationPlacement(layout, "herdrTerminal")).toEqual({ kind: "add" });
  });

  it("reuses an unpinned pane when the grid is full, never the focused one", () => {
    let layout = layoutWithPaneCount(WORKSPACE_LAYOUT_MAX_PANES);
    layout = expectAccepted(focusPane(layout, paneId("pane-1")));
    const placement = planAutomationPlacement(layout, "herdrTerminal");
    expect(placement.kind).toBe("reuse");
    expect(placement).not.toEqual({ kind: "reuse", paneId: "pane-1" });
  });

  it("raises an attention item when the grid is full and every pane is pinned", () => {
    let layout = layoutWithPaneCount(WORKSPACE_LAYOUT_MAX_PANES);
    for (const id of collectPaneIdsInVisualOrder(layout)) {
      layout = expectAccepted(setPanePinned(layout, id, true));
    }
    expect(planAutomationPlacement(layout, "herdrTerminal")).toEqual({
      kind: "attention",
      rejection: "pane-limit-reached",
    });
  });
});

describe("workspace layout normalization", () => {
  it("repairs a layout that violates every invariant", () => {
    const corrupt: WorkspaceLayout = {
      workspaceId,
      revision: 4,
      rows: [
        // an empty row, a duplicate reference, a dangling reference, and zero weights
        { rowId: rowId("empty"), cells: [], heightWeight: 0 },
        {
          rowId: rowId("r1"),
          cells: [
            { paneId: paneId("a"), widthWeight: 0 },
            { paneId: paneId("a"), widthWeight: 0.5 },
            { paneId: paneId("ghost"), widthWeight: 0.5 },
            { paneId: paneId("b"), widthWeight: 0.5 },
          ],
          heightWeight: 99,
        },
      ],
      panes: [
        createPane(paneId("a"), "agent"),
        createPane(paneId("b"), "agent"),
        createPane(paneId("orphan"), "agent"), // declared but never placed
      ],
      focusedPaneId: paneId("ghost"),
    };

    const layout = normalizeWorkspaceLayout(corrupt);
    expect(layout.rows).toHaveLength(1);
    expect(collectPaneIdsInVisualOrder(layout)).toEqual(["a", "b"]);
    expect(layout.panes.map((pane) => pane.paneId)).toEqual(["a", "b"]);
    expect(layout.focusedPaneId).toBe("a");
    expectLayoutInvariants(layout);
  });

  it("truncates a layout that exceeds the grid bounds", () => {
    const oversized: WorkspaceLayout = {
      workspaceId,
      revision: 0,
      rows: Array.from({ length: 5 }, (_, rowIndex) => ({
        rowId: rowId(`r${rowIndex}`),
        cells: Array.from({ length: 5 }, (_, columnIndex) => ({
          paneId: paneId(`p${rowIndex}-${columnIndex}`),
          widthWeight: 0.2,
        })),
        heightWeight: 0.2,
      })),
      panes: Array.from({ length: 25 }, (_, index) =>
        createPane(paneId(`p${Math.floor(index / 5)}-${index % 5}`), "agent"),
      ),
      focusedPaneId: null,
    };

    const layout = normalizeWorkspaceLayout(oversized);
    expect(layout.rows).toHaveLength(3);
    expect(countPanes(layout)).toBe(9);
    expectLayoutInvariants(layout);
  });

  it("increments the revision when focus changes so stale writes can be rejected", () => {
    let layout = singlePaneLayout();
    layout = expectAccepted(addPane(layout, createPane(paneId("pane-2"), "agent"), rowId("row-2")));
    const next = expectAccepted(focusPane(layout, paneId("pane-1")));
    expect(next.revision).toBe(layout.revision + 1);
  });
});
