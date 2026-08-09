// FILE: workspaceLayoutStore.ts
// Purpose: Client-side state for a Workspace's Pane grid, applying layout
// operations optimistically and reconciling them with the authoritative server
// copy.
// Layer: UI state
//
// The server owns the layout, but a drag has to feel immediate, so every
// operation is applied locally first and then written. Three consequences shape
// this store:
//
//   * Operations come from @vulcan/shared/workspaceLayout, the same module the
//     server persists through. The optimistic result and the stored result are
//     therefore computed by identical code, and a write that round-trips cannot
//     change what the operator already sees.
//   * A write carries the revision the local layout was derived from. If another
//     client moved first, the server returns the winning layout and this store
//     adopts it wholesale rather than merging. A pane grid is small, shared, and
//     directly manipulated -- adopting the winner is comprehensible, while a
//     three-way merge of two drags is not.
//   * Ids are minted here, not in the shared module, because that module is pure
//     and must stay replayable.

import {
  type PaneDropZone,
  type PaneId,
  type PaneLayoutRejection,
  type PaneMode,
  PaneRowId,
  type PaneSplitDirection,
  type ProjectId,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceLayout,
  type WorkspacePane,
} from "@vulcan/contracts";
import {
  addPane,
  createPane,
  createWorkspaceLayout,
  focusPane,
  movePane,
  type PaneLayoutResult,
  removePane,
  setCellWidthWeights,
  setPaneAttachment,
  setPaneMode,
  setPanePinned,
  setRowHeightWeights,
  splitPane,
} from "@vulcan/shared/workspaceLayout";
import { create } from "zustand";

import { ensureNativeApi } from "./nativeApi";

/** Ids are opaque to the domain; uniqueness is all that is required of them. */
const mintId = (prefix: string): string =>
  `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

const mintPaneId = () => mintId("pane") as PaneId;
const mintRowId = () => mintId("row") as PaneRowId;

export interface WorkspaceLayoutEntry {
  readonly layout: WorkspaceLayout;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  /** Revision the server last confirmed, used as the write precondition. */
  readonly syncedRevision: number | null;
  readonly status: "loading" | "ready" | "saving" | "error";
  /**
   * The last refusal, kept so a Pane header can explain why an action did
   * nothing instead of appearing to ignore the operator.
   */
  readonly lastRejection: PaneLayoutRejection | null;
  readonly errorMessage: string | null;
}

interface WorkspaceLayoutStoreState {
  readonly entries: Readonly<Record<string, WorkspaceLayoutEntry>>;

  /** Load a Workspace's layout, seeding a single Agent Pane the first time. */
  readonly open: (input: {
    workspaceId: WorkspaceId;
    projectId: ProjectId | null;
    threadId: ThreadId | null;
  }) => Promise<void>;

  readonly addPane: (workspaceId: WorkspaceId, mode: PaneMode) => Promise<void>;
  readonly splitPane: (
    workspaceId: WorkspaceId,
    paneId: PaneId,
    direction: PaneSplitDirection,
    mode: PaneMode,
  ) => Promise<void>;
  readonly movePane: (
    workspaceId: WorkspaceId,
    paneId: PaneId,
    targetPaneId: PaneId,
    zone: PaneDropZone,
  ) => Promise<void>;
  readonly removePane: (workspaceId: WorkspaceId, paneId: PaneId) => Promise<void>;
  readonly setPaneMode: (workspaceId: WorkspaceId, paneId: PaneId, mode: PaneMode) => Promise<void>;
  readonly setPaneAttachment: (
    workspaceId: WorkspaceId,
    paneId: PaneId,
    attachment: WorkspacePane["attachments"][number],
  ) => Promise<void>;
  readonly setPanePinned: (
    workspaceId: WorkspaceId,
    paneId: PaneId,
    pinned: boolean,
  ) => Promise<void>;
  readonly focusPane: (workspaceId: WorkspaceId, paneId: PaneId) => Promise<void>;
  readonly setRowHeights: (workspaceId: WorkspaceId, weights: readonly number[]) => Promise<void>;
  readonly setCellWidths: (
    workspaceId: WorkspaceId,
    rowId: PaneRowId,
    weights: readonly number[],
  ) => Promise<void>;
  readonly clearRejection: (workspaceId: WorkspaceId) => void;
}

export const useWorkspaceLayoutStore = create<WorkspaceLayoutStoreState>((set, get) => {
  const readEntry = (workspaceId: WorkspaceId): WorkspaceLayoutEntry | undefined =>
    get().entries[workspaceId];

  const patch = (workspaceId: WorkspaceId, changes: Partial<WorkspaceLayoutEntry>) => {
    set((state) => {
      const existing = state.entries[workspaceId];
      if (!existing) return state;
      return { entries: { ...state.entries, [workspaceId]: { ...existing, ...changes } } };
    });
  };

  /**
   * Persist the current local layout.
   *
   * A conflict is not an error: the server hands back what won, and the local
   * layout is replaced with it. The operator sees their change disappear, which
   * is honest -- it did not happen.
   */
  const persist = async (workspaceId: WorkspaceId): Promise<void> => {
    const entry = readEntry(workspaceId);
    if (!entry) return;
    patch(workspaceId, { status: "saving" });
    try {
      const result = await ensureNativeApi().workspaceLayouts.write({
        layout: entry.layout,
        projectId: entry.projectId,
        threadId: entry.threadId,
        expectedRevision: entry.syncedRevision,
      });
      if (result.outcome === "stored") {
        patch(workspaceId, {
          layout: result.stored.layout,
          syncedRevision: result.stored.layout.revision,
          status: "ready",
          errorMessage: null,
        });
        return;
      }
      patch(workspaceId, {
        layout: result.current.layout,
        syncedRevision: result.current.layout.revision,
        status: "ready",
        errorMessage: "Another client changed this workspace, so its layout was reloaded.",
      });
    } catch (cause) {
      // The local layout is kept. Losing the operator's arrangement because a
      // socket blipped would be worse than being briefly out of sync, and the
      // next successful write reconciles it.
      patch(workspaceId, {
        status: "error",
        errorMessage: cause instanceof Error ? cause.message : "Failed to save the pane layout.",
      });
    }
  };

  /** Applies a layout operation, saving it when accepted and recording the refusal when not. */
  const apply = async (
    workspaceId: WorkspaceId,
    operation: (layout: WorkspaceLayout) => PaneLayoutResult,
  ): Promise<void> => {
    const entry = readEntry(workspaceId);
    if (!entry) return;
    const result = operation(entry.layout);
    if (!result.ok) {
      patch(workspaceId, { lastRejection: result.rejection });
      return;
    }
    patch(workspaceId, { layout: result.layout, lastRejection: null });
    await persist(workspaceId);
  };

  return {
    entries: {},

    open: async ({ workspaceId, projectId, threadId }) => {
      const existing = readEntry(workspaceId);
      if (existing && existing.status !== "error") return;

      set((state) => ({
        entries: {
          ...state.entries,
          [workspaceId]: {
            layout: createWorkspaceLayout(
              workspaceId,
              mintRowId(),
              createPane(mintPaneId(), "agent"),
            ),
            projectId,
            threadId,
            syncedRevision: null,
            status: "loading",
            lastRejection: null,
            errorMessage: null,
          },
        },
      }));

      try {
        const stored = await ensureNativeApi().workspaceLayouts.read({ workspaceId });
        if (stored) {
          patch(workspaceId, {
            layout: stored.layout,
            projectId: stored.projectId,
            threadId: stored.threadId,
            syncedRevision: stored.layout.revision,
            status: "ready",
          });
          return;
        }
        // First time this Workspace has been opened. Seed it with one Agent Pane
        // and store that, so a reload restores the same grid rather than seeding
        // a second one.
        patch(workspaceId, { status: "ready" });
        await persist(workspaceId);
      } catch (cause) {
        patch(workspaceId, {
          status: "error",
          errorMessage: cause instanceof Error ? cause.message : "Failed to load the pane layout.",
        });
      }
    },

    addPane: (workspaceId, mode) =>
      apply(workspaceId, (layout) => addPane(layout, createPane(mintPaneId(), mode), mintRowId())),

    splitPane: (workspaceId, paneId, direction, mode) =>
      apply(workspaceId, (layout) =>
        splitPane(layout, paneId, direction, createPane(mintPaneId(), mode), mintRowId()),
      ),

    movePane: (workspaceId, paneId, targetPaneId, zone) =>
      apply(workspaceId, (layout) => movePane(layout, paneId, targetPaneId, zone, mintRowId())),

    removePane: (workspaceId, paneId) => apply(workspaceId, (layout) => removePane(layout, paneId)),

    setPaneMode: (workspaceId, paneId, mode) =>
      apply(workspaceId, (layout) => setPaneMode(layout, paneId, mode)),

    setPaneAttachment: (workspaceId, paneId, attachment) =>
      apply(workspaceId, (layout) => setPaneAttachment(layout, paneId, attachment)),

    setPanePinned: (workspaceId, paneId, pinned) =>
      apply(workspaceId, (layout) => setPanePinned(layout, paneId, pinned)),

    focusPane: (workspaceId, paneId) => apply(workspaceId, (layout) => focusPane(layout, paneId)),

    setRowHeights: (workspaceId, weights) =>
      apply(workspaceId, (layout) => setRowHeightWeights(layout, weights)),

    setCellWidths: (workspaceId, rowId, weights) =>
      apply(workspaceId, (layout) => setCellWidthWeights(layout, rowId, weights)),

    clearRejection: (workspaceId) => patch(workspaceId, { lastRejection: null }),
  };
});

export const selectWorkspaceLayout =
  (workspaceId: WorkspaceId | null) =>
  (state: WorkspaceLayoutStoreState): WorkspaceLayoutEntry | null =>
    workspaceId ? (state.entries[workspaceId] ?? null) : null;

/** Operator-facing explanation for each refusal, so a no-op is never unexplained. */
export function describePaneLayoutRejection(rejection: PaneLayoutRejection): string {
  switch (rejection) {
    case "row-limit-reached":
      return "This workspace already has three rows of panes.";
    case "column-limit-reached":
      return "That row already has three panes.";
    case "pane-limit-reached":
      return "This workspace already has nine panes. Close one to add another.";
    case "pane-pinned":
      return "That pane is pinned. Unpin it first.";
    case "pane-not-found":
    case "row-not-found":
      return "That pane is no longer part of this workspace.";
    case "duplicate-pane":
      return "That pane is already in this workspace.";
    case "invalid-weights":
      return "The requested sizes did not match the panes in that row.";
  }
}
