// FILE: workspaceLayoutStore.test.ts
// Purpose: Verify the store's automation placement, which is what turns pinning
// from a label into a guarantee.
//
// The placement *policy* is the kernel's and is tested there. What is tested here
// is that the store applies it faithfully: automation must never end up holding a
// pinned Pane, however full the grid is.

import { WORKSPACE_LAYOUT_MAX_PANES, type WorkspaceId } from "@vulcan/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceLayoutStore } from "./workspaceLayoutStore";

const workspaceId = "workspace-automation" as WorkspaceId;

// The store persists through the native API; these tests are about the local
// layout decision, so the write is stubbed to echo what it was given.
vi.mock("./nativeApi", () => ({
  ensureNativeApi: () => ({
    workspaceLayouts: {
      read: async () => null,
      write: async (input: { layout: unknown }) => ({
        outcome: "stored",
        stored: {
          layout: input.layout,
          projectId: null,
          threadId: null,
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
        },
      }),
    },
  }),
}));

const store = () => useWorkspaceLayoutStore.getState();
const layoutOf = () => store().entries[workspaceId]?.layout;

async function openWorkspace() {
  useWorkspaceLayoutStore.setState({ entries: {} });
  await store().open({ workspaceId, projectId: null, threadId: null });
}

describe("automation pane placement", () => {
  beforeEach(async () => {
    await openWorkspace();
  });

  it("adds a pane for a mode that is not showing", async () => {
    const before = layoutOf()?.panes.length ?? 0;
    const outcome = await store().requestPaneForMode(workspaceId, "factory");
    expect(outcome).toBe("add");
    expect(layoutOf()?.panes.length).toBe(before + 1);
    expect(layoutOf()?.panes.some((pane) => pane.mode === "factory")).toBe(true);
  });

  it("focuses an existing pane instead of adding a second one", async () => {
    await store().requestPaneForMode(workspaceId, "factory");
    const afterFirst = layoutOf()?.panes.length ?? 0;

    const outcome = await store().requestPaneForMode(workspaceId, "factory");
    expect(outcome).toBe("focus-existing");
    // No duplicate surface for the same mode.
    expect(layoutOf()?.panes.length).toBe(afterFirst);
    const focused = layoutOf()?.panes.find((pane) => pane.paneId === layoutOf()?.focusedPaneId);
    expect(focused?.mode).toBe("factory");
  });

  it("never takes a pinned pane, even when the grid is full", async () => {
    // Fill the grid and pin every pane. Automation now has nowhere to go that
    // does not belong to the operator.
    while ((layoutOf()?.panes.length ?? 0) < WORKSPACE_LAYOUT_MAX_PANES) {
      await store().addPane(workspaceId, "agent");
    }
    for (const pane of layoutOf()?.panes ?? []) {
      await store().setPanePinned(workspaceId, pane.paneId, true);
    }
    const before = layoutOf()?.panes.map((pane) => ({ id: pane.paneId, mode: pane.mode }));

    const outcome = await store().requestPaneForMode(workspaceId, "factory");

    expect(outcome).toBe("attention");
    // Nothing was repurposed and nothing was added.
    expect(layoutOf()?.panes.map((pane) => ({ id: pane.paneId, mode: pane.mode }))).toEqual(before);
    // The refusal is recorded so a surface can explain it rather than appearing
    // to ignore the request.
    expect(store().entries[workspaceId]?.lastRejection).toBe("pane-limit-reached");
  });

  it("repurposes an unpinned pane when the grid is full, and never the focused one", async () => {
    while ((layoutOf()?.panes.length ?? 0) < WORKSPACE_LAYOUT_MAX_PANES) {
      await store().addPane(workspaceId, "agent");
    }
    const panes = layoutOf()?.panes ?? [];
    const focusedId = layoutOf()?.focusedPaneId;
    // Pin everything except one pane that is not the focused one.
    const spare = panes.find((pane) => pane.paneId !== focusedId);
    for (const pane of panes) {
      if (pane.paneId !== spare?.paneId) {
        await store().setPanePinned(workspaceId, pane.paneId, true);
      }
    }

    const outcome = await store().requestPaneForMode(workspaceId, "factory");
    expect(outcome).toBe("reuse");
    expect(layoutOf()?.panes.length).toBe(WORKSPACE_LAYOUT_MAX_PANES);

    const changed = layoutOf()?.panes.filter((pane) => pane.mode === "factory") ?? [];
    expect(changed).toHaveLength(1);
    expect(changed[0]?.paneId).toBe(spare?.paneId);
    // Every pinned pane kept its mode.
    for (const pane of layoutOf()?.panes ?? []) {
      if (pane.pinned) expect(pane.mode).toBe("agent");
    }
  });
});
