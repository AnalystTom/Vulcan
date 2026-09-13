// FILE: workspaceLayoutStore.test.ts
// Purpose: Verify the store's automation placement, which is what turns pinning
// from a label into a guarantee.
//
// The placement *policy* is the kernel's and is tested there. What is tested here
// is that the store applies it faithfully: automation must never end up holding a
// pinned Pane, however full the grid is.

import {
  PaneId,
  PaneRowId,
  ThreadId,
  WORKSPACE_LAYOUT_MAX_PANES,
  WS_STREAM_LIMITS,
  WorkspaceId,
  type WorkspaceLayout,
} from "@vulcan/contracts";
import { createPane, createWorkspaceLayout } from "@vulcan/shared/workspaceLayout";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveWorkspaceThreadIds, useWorkspaceLayoutStore } from "./workspaceLayoutStore";

const workspaceId = "workspace-automation" as WorkspaceId;

const native = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
}));

// The store persists through the native API; these tests control its timing and
// compare-and-set responses to exercise the local ordering guarantees.
vi.mock("./nativeApi", () => ({
  ensureNativeApi: () => ({
    workspaceLayouts: {
      read: native.read,
      write: native.write,
    },
  }),
}));

const store = () => useWorkspaceLayoutStore.getState();
const layoutOf = () => store().entries[workspaceId]?.layout;

async function openWorkspace() {
  useWorkspaceLayoutStore.setState({ entries: {} });
  await store().open({ workspaceId, projectId: null, threadId: null });
}

function stored(input: { layout: WorkspaceLayout }) {
  return {
    outcome: "stored" as const,
    stored: {
      layout: input.layout,
      projectId: null,
      threadId: null,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    },
  };
}

describe("automation pane placement", () => {
  beforeEach(async () => {
    native.read.mockResolvedValue(null);
    native.write.mockImplementation(async (input: { layout: WorkspaceLayout }) => stored(input));
    await openWorkspace();
  });

  it("admits the focused conversation when nine Agent panes exceed the stream budget", async () => {
    for (let index = 1; index < WORKSPACE_LAYOUT_MAX_PANES; index += 1) {
      await store().addPane(workspaceId, "agent");
    }
    const panes = layoutOf()!.panes;
    for (const [index, pane] of panes.entries()) {
      await store().setPaneAttachment(workspaceId, pane.paneId, {
        mode: "agent",
        threadId: ThreadId.makeUnsafe(`chat-${index}`),
      });
    }
    await store().focusPane(workspaceId, panes[0]!.paneId);
    const before = resolveWorkspaceThreadIds(layoutOf()!, null);
    expect(before).toHaveLength(WORKSPACE_LAYOUT_MAX_PANES);
    expect(before.slice(0, WS_STREAM_LIMITS.threadPerClient)).not.toContain("chat-8");

    await store().focusPane(workspaceId, panes[8]!.paneId);
    const after = resolveWorkspaceThreadIds(layoutOf()!, null);
    expect(after[0]).toBe("chat-8");
    expect(after.slice(0, WS_STREAM_LIMITS.threadPerClient)).toContain("chat-8");
  });

  it("does not write when focusing the focused pane again", async () => {
    native.write.mockClear();
    const focusedPaneId = layoutOf()?.focusedPaneId;
    expect(focusedPaneId).not.toBeNull();

    await store().focusPane(workspaceId, focusedPaneId!);

    expect(native.write).not.toHaveBeenCalled();
  });

  it("serializes concurrent focus and mode writes without a same-client conflict", async () => {
    await store().addPane(workspaceId, "agent");
    native.write.mockClear();
    let serverRevision = layoutOf()?.revision ?? 0;
    let persisted = layoutOf();
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let resolveWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      resolveWriteStarted = resolve;
    });
    let writeCount = 0;
    native.write.mockImplementation(
      async (input: { layout: WorkspaceLayout; expectedRevision: number | null }) => {
        writeCount += 1;
        if (writeCount === 1) {
          resolveWriteStarted();
          await firstWrite;
        }
        if (input.expectedRevision !== serverRevision) {
          return {
            outcome: "conflict" as const,
            expectedRevision: input.expectedRevision ?? 0,
            current: stored({ layout: persisted! }).stored,
          };
        }
        serverRevision = input.layout.revision;
        persisted = input.layout;
        return stored(input);
      },
    );

    const panes = layoutOf()?.panes ?? [];
    const paneId = panes[0]?.paneId;
    expect(paneId).toBeDefined();
    const focus = store().focusPane(workspaceId, paneId!);
    const mode = store().setPaneMode(workspaceId, paneId!, "hermesBot");
    await writeStarted;
    releaseFirst();
    await Promise.all([focus, mode]);

    expect(writeCount).toBe(2);
    expect(layoutOf()?.panes.find((pane) => pane.paneId === paneId)?.mode).toBe("hermesBot");
    expect(persisted?.panes.find((pane) => pane.paneId === paneId)?.mode).toBe("hermesBot");
    expect(store().entries[workspaceId]?.errorMessage).toBeNull();
  });

  it("rechecks automation placement after a queued pin change", async () => {
    while ((layoutOf()?.panes.length ?? 0) < WORKSPACE_LAYOUT_MAX_PANES) {
      await store().addPane(workspaceId, "agent");
    }
    const focusedId = layoutOf()?.focusedPaneId;
    const spare = layoutOf()?.panes.find((pane) => pane.paneId !== focusedId);
    expect(spare).toBeDefined();
    for (const pane of layoutOf()?.panes ?? []) {
      if (pane.paneId !== spare?.paneId) {
        await store().setPanePinned(workspaceId, pane.paneId, true);
      }
    }

    let releasePinWrite!: () => void;
    const pinWrite = new Promise<void>((resolve) => {
      releasePinWrite = resolve;
    });
    let resolvePinWriteStarted!: () => void;
    const pinWriteStarted = new Promise<void>((resolve) => {
      resolvePinWriteStarted = resolve;
    });
    native.write.mockClear();
    native.write.mockImplementation(async (input: { layout: WorkspaceLayout }) => {
      resolvePinWriteStarted();
      await pinWrite;
      return stored(input);
    });

    const pinning = store().setPanePinned(workspaceId, spare!.paneId, true);
    await pinWriteStarted;
    const requesting = store().requestPaneForMode(workspaceId, "factory");
    releasePinWrite();
    const [, outcome] = await Promise.all([pinning, requesting]);

    expect(outcome).toBe("attention");
    const finalSpare = layoutOf()?.panes.find((pane) => pane.paneId === spare?.paneId);
    expect(finalSpare?.pinned).toBe(true);
    expect(finalSpare?.mode).toBe("agent");
    expect(store().entries[workspaceId]?.lastRejection).toBe("pane-limit-reached");
  });

  it("waits for the authoritative read before applying an early mode change", async () => {
    useWorkspaceLayoutStore.setState({ entries: {} });
    const existing = createWorkspaceLayout(
      workspaceId,
      PaneRowId.makeUnsafe("stored-row"),
      createPane(PaneId.makeUnsafe("stored-pane"), "agent"),
    );
    let resolveRead!: (value: unknown) => void;
    let resolveReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      resolveReadStarted = resolve;
    });
    native.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
          resolveReadStarted();
        }),
    );
    native.write.mockClear();

    const opening = store().open({ workspaceId, projectId: null, threadId: null });
    const changing = store().setPaneMode(
      workspaceId,
      PaneId.makeUnsafe("stored-pane"),
      "hermesBot",
    );
    await readStarted;
    resolveRead({
      layout: existing,
      projectId: null,
      threadId: null,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    });
    await Promise.all([opening, changing]);

    expect(layoutOf()?.panes[0]?.paneId).toBe("stored-pane");
    expect(layoutOf()?.panes[0]?.mode).toBe("hermesBot");
    expect(native.write).toHaveBeenCalledTimes(1);
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
