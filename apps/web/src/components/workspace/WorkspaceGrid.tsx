// FILE: WorkspaceGrid.tsx
// Purpose: Renders a Workspace's Pane grid -- rows of cells, draggable dividers,
// and the per-Pane content supplied by the caller.
// Layer: Workspace UI
//
// The grid is a pure projection of the layout value. It holds no layout state of
// its own: every drag, resize, and drop calls back into the store, which applies
// the same shared operations the server persists. That is what keeps what the
// operator sees and what is stored from drifting apart.
//
// Panes are rendered through a `renderPane` prop rather than a mode switch here,
// so the grid never needs to know what an Agent Session or a terminal is, and a
// new Pane Mode does not touch this file.

import {
  type PaneDropZone,
  type PaneId,
  type PaneRowId,
  type PaneSplitDirection,
  type PaneMode,
  type WorkspaceLayout,
  type WorkspacePane,
  WORKSPACE_LAYOUT_MAX_PANES,
} from "@vulcan/contracts";
import { countPanes, findPane } from "@vulcan/shared/workspaceLayout";
import { type ReactNode, useCallback, useRef } from "react";

import { cn } from "~/lib/utils";

import { PaneFrame } from "./PaneFrame";

export interface WorkspaceGridProps {
  readonly layout: WorkspaceLayout;
  readonly renderPane: (pane: WorkspacePane, context: { isFocused: boolean }) => ReactNode;
  /** Optional per-pane header status, e.g. provider or session state. */
  readonly describePaneStatus?: (pane: WorkspacePane) => {
    label: string | null;
    needsAttention: boolean;
  };
  readonly onFocusPane: (paneId: PaneId) => void;
  readonly onSelectMode: (paneId: PaneId, mode: PaneMode) => void;
  readonly onSplitPane: (paneId: PaneId, direction: PaneSplitDirection) => void;
  readonly onTogglePinned: (paneId: PaneId) => void;
  readonly onClosePane: (paneId: PaneId) => void;
  /** Null for panes that only reference a session rather than owning one. */
  readonly resolveTerminateSession: (pane: WorkspacePane) => (() => void) | null;
  readonly onMovePane: (paneId: PaneId, targetPaneId: PaneId, zone: PaneDropZone) => void;
  readonly onSetRowHeights: (weights: readonly number[]) => void;
  readonly onSetCellWidths: (rowId: PaneRowId, weights: readonly number[]) => void;
}

export function WorkspaceGrid({
  layout,
  renderPane,
  describePaneStatus,
  onFocusPane,
  onSelectMode,
  onSplitPane,
  onTogglePinned,
  onClosePane,
  resolveTerminateSession,
  onMovePane,
  onSetRowHeights,
  onSetCellWidths,
}: WorkspaceGridProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const paneCount = countPanes(layout);

  const handleDropPane = useCallback(
    (targetPaneId: PaneId, draggedPaneId: string, zone: PaneDropZone) => {
      if (draggedPaneId === targetPaneId) return;
      onMovePane(draggedPaneId as PaneId, targetPaneId, zone);
    },
    [onMovePane],
  );

  if (layout.rows.length === 0) {
    return (
      <div
        ref={containerRef}
        className="flex h-full w-full items-center justify-center text-muted-foreground text-sm"
      >
        This workspace has no panes. Add one to start working.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-workspace-grid
      data-pane-count={paneCount}
      className="flex h-full w-full min-h-0 min-w-0 flex-col gap-1 p-1"
    >
      {layout.rows.map((row, rowIndex) => (
        <div key={row.rowId} className="contents">
          <div
            data-workspace-row={row.rowId}
            className="flex min-h-0 min-w-0 flex-row gap-1"
            // flexBasis carries the weight and flexGrow/Shrink are pinned so a
            // pane's share is exactly its weight regardless of its content size.
            // Without this a long transcript would win space from a terminal.
            style={{ flexBasis: `${row.heightWeight * 100}%`, flexGrow: 0, flexShrink: 1 }}
          >
            {row.cells.map((cell, columnIndex) => {
              const pane = findPane(layout, cell.paneId);
              if (!pane) return null;
              const isFocused = layout.focusedPaneId === pane.paneId;
              const status = describePaneStatus?.(pane);
              return (
                <div key={cell.paneId} className="contents">
                  <div
                    className="flex min-h-0 min-w-0 flex-col"
                    style={{ flexBasis: `${cell.widthWeight * 100}%`, flexGrow: 0, flexShrink: 1 }}
                  >
                    <PaneFrame
                      pane={pane}
                      isFocused={isFocused}
                      statusLabel={status?.label ?? null}
                      needsAttention={status?.needsAttention ?? false}
                      // The last pane is still closable; an empty workspace is a
                      // valid state with its own add-a-pane affordance.
                      canClose={paneCount > 0}
                      onTerminateSession={resolveTerminateSession(pane)}
                      onFocus={() => onFocusPane(pane.paneId)}
                      onSelectMode={(mode) => onSelectMode(pane.paneId, mode)}
                      onSplit={(direction) => onSplitPane(pane.paneId, direction)}
                      onTogglePinned={() => onTogglePinned(pane.paneId)}
                      onClose={() => onClosePane(pane.paneId)}
                      onDropPane={(draggedPaneId, zone) =>
                        handleDropPane(pane.paneId, draggedPaneId, zone)
                      }
                    >
                      {renderPane(pane, { isFocused })}
                    </PaneFrame>
                  </div>
                  {columnIndex < row.cells.length - 1 ? (
                    <GridDivider
                      orientation="vertical"
                      label={`Resize columns in row ${rowIndex + 1}`}
                      onResize={(delta, containerSize) => {
                        const weights = row.cells.map((candidate) => candidate.widthWeight);
                        onSetCellWidths(
                          row.rowId,
                          shiftWeights(weights, columnIndex, delta / containerSize),
                        );
                      }}
                      measure={() => containerRef.current?.clientWidth ?? 1}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
          {rowIndex < layout.rows.length - 1 ? (
            <GridDivider
              orientation="horizontal"
              label="Resize rows"
              onResize={(delta, containerSize) => {
                const weights = layout.rows.map((candidate) => candidate.heightWeight);
                onSetRowHeights(shiftWeights(weights, rowIndex, delta / containerSize));
              }}
              measure={() => containerRef.current?.clientHeight ?? 1}
            />
          ) : null}
        </div>
      ))}
      {paneCount >= WORKSPACE_LAYOUT_MAX_PANES ? null : null}
    </div>
  );
}

/**
 * Moves `fraction` of the total from one neighbour to the next.
 *
 * Only the two adjacent entries change, so dragging one divider never nudges
 * panes elsewhere in the row. Clamping is left to the shared normalizer, which
 * owns the minimum-size rule for both the client and the server.
 */
export function shiftWeights(
  weights: readonly number[],
  index: number,
  fraction: number,
): number[] {
  const next = [...weights];
  const before = next[index];
  const after = next[index + 1];
  if (before === undefined || after === undefined) return next;
  next[index] = before + fraction;
  next[index + 1] = after - fraction;
  return next;
}

/**
 * A divider that resizes on drag and on arrow keys.
 *
 * The keyboard path is not a nicety: without it the grid could only be resized
 * with a pointer, which would make a nine-pane workspace unusable for anyone who
 * does not use one.
 */
function GridDivider({
  orientation,
  label,
  onResize,
  measure,
}: {
  orientation: "horizontal" | "vertical";
  label: string;
  onResize: (deltaPixels: number, containerSize: number) => void;
  measure: () => number;
}) {
  const dragOrigin = useRef<number | null>(null);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOrigin.current = orientation === "vertical" ? event.clientX : event.clientY;
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragOrigin.current === null) return;
    const position = orientation === "vertical" ? event.clientX : event.clientY;
    const delta = position - dragOrigin.current;
    if (delta === 0) return;
    dragOrigin.current = position;
    onResize(delta, measure());
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragOrigin.current === null) return;
    dragOrigin.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    const decrease = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
    const increase = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
    if (event.key === decrease) {
      event.preventDefault();
      onResize(-step, measure());
      return;
    }
    if (event.key === increase) {
      event.preventDefault();
      onResize(step, measure());
    }
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      className={cn(
        "shrink-0 rounded-full bg-transparent transition-colors hover:bg-primary/40 focus-visible:bg-primary/60 focus-visible:outline-none",
        orientation === "vertical" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
      )}
    />
  );
}
