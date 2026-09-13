import { assert, it } from "@effect/vitest";
import {
  PaneId,
  PaneRowId,
  ProjectId,
  ThreadId,
  WorkspaceId,
  WORKSPACE_LAYOUT_MAX_PANES,
  type WorkspaceLayout,
} from "@vulcan/contracts";
import {
  addPane,
  createPane,
  createWorkspaceLayout,
  setPaneAttachment,
  setPaneMode,
} from "@vulcan/shared/workspaceLayout";
import { Effect, Layer } from "effect";

import { WorkspaceLayouts } from "../Services/WorkspaceLayouts.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { WorkspaceLayoutsLive } from "./WorkspaceLayouts.ts";

const layer = it.layer(WorkspaceLayoutsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const projectA = ProjectId.makeUnsafe("project-a");
const threadA = ThreadId.makeUnsafe("thread-a");

const seed = (name: string): WorkspaceLayout =>
  createWorkspaceLayout(
    WorkspaceId.makeUnsafe(name),
    PaneRowId.makeUnsafe(`${name}-row`),
    createPane(PaneId.makeUnsafe(`${name}-pane`), "agent"),
  );

const accepted = (result: { ok: boolean; layout?: WorkspaceLayout }): WorkspaceLayout => {
  if (!result.ok || !result.layout) throw new Error("layout operation was rejected");
  return result.layout;
};

layer("WorkspaceLayouts", (it) => {
  it.effect("returns null for a workspace that has never been opened", () =>
    Effect.gen(function* () {
      const layouts = yield* WorkspaceLayouts;
      assert.strictEqual(yield* layouts.read(WorkspaceId.makeUnsafe("absent")), null);
    }),
  );

  it.effect("round-trips a layout with its panes, modes, and attachments", () =>
    Effect.gen(function* () {
      const layouts = yield* WorkspaceLayouts;
      let layout = seed("round-trip");
      layout = accepted(setPaneMode(layout, PaneId.makeUnsafe("round-trip-pane"), "herdrTerminal"));
      layout = accepted(
        setPaneAttachment(layout, PaneId.makeUnsafe("round-trip-pane"), {
          mode: "herdrTerminal",
          sessionName: "vulcan-round-trip",
          fallbackTerminalId: null,
        }),
      );

      yield* layouts.upsert({
        layout,
        projectId: projectA,
        threadId: threadA,
        expectedRevision: null,
      });

      const stored = yield* layouts.read(layout.workspaceId);
      assert.isNotNull(stored);
      assert.strictEqual(stored?.projectId, projectA);
      assert.strictEqual(stored?.threadId, threadA);
      assert.deepStrictEqual(stored?.layout.panes, layout.panes);
      assert.deepStrictEqual(stored?.layout.rows, layout.rows);
      assert.strictEqual(stored?.layout.focusedPaneId, layout.focusedPaneId);
    }),
  );

  it.effect("round-trips a native Hermes profile attachment", () =>
    Effect.gen(function* () {
      const layouts = yield* WorkspaceLayouts;
      const pane = PaneId.makeUnsafe("hermes-profile-pane");
      let layout = seed("hermes-profile");
      layout = accepted(setPaneMode(layout, pane, "hermesBot"));
      layout = accepted(
        setPaneAttachment(layout, pane, {
          mode: "hermesBot",
          profile: "research",
        }),
      );

      yield* layouts.upsert({
        layout,
        projectId: projectA,
        threadId: null,
        expectedRevision: null,
      });

      const stored = yield* layouts.read(layout.workspaceId);
      assert.deepStrictEqual(stored?.layout.panes, layout.panes);
    }),
  );

  it.effect("stores a full nine-pane grid", () =>
    Effect.gen(function* () {
      const layouts = yield* WorkspaceLayouts;
      let layout = seed("full");
      for (let index = 2; index <= WORKSPACE_LAYOUT_MAX_PANES; index += 1) {
        layout = accepted(
          addPane(
            layout,
            createPane(PaneId.makeUnsafe(`full-pane-${index}`), "agent"),
            PaneRowId.makeUnsafe(`full-row-${index}`),
          ),
        );
      }

      yield* layouts.upsert({
        layout,
        projectId: projectA,
        threadId: null,
        expectedRevision: null,
      });

      const stored = yield* layouts.read(layout.workspaceId);
      assert.strictEqual(stored?.layout.panes.length, WORKSPACE_LAYOUT_MAX_PANES);
      assert.strictEqual(stored?.layout.rows.length, 3);
    }),
  );

  it.effect("refuses a write whose revision has moved on, and reports what won", () =>
    Effect.gen(function* () {
      const layouts = yield* WorkspaceLayouts;
      const base = seed("conflict");
      yield* layouts.upsert({
        layout: base,
        projectId: projectA,
        threadId: null,
        expectedRevision: null,
      });

      // One client advances the layout.
      const winner = accepted(
        addPane(
          base,
          createPane(PaneId.makeUnsafe("conflict-winner"), "agent"),
          PaneRowId.makeUnsafe("conflict-row-2"),
        ),
      );
      yield* layouts.upsert({
        layout: winner,
        projectId: projectA,
        threadId: null,
        expectedRevision: base.revision,
      });

      // A second client still holding the base revision must lose.
      const loser = accepted(
        addPane(
          base,
          createPane(PaneId.makeUnsafe("conflict-loser"), "agent"),
          PaneRowId.makeUnsafe("conflict-row-3"),
        ),
      );
      const outcome = yield* Effect.result(
        layouts.upsert({
          layout: loser,
          projectId: projectA,
          threadId: null,
          expectedRevision: base.revision,
        }),
      );

      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag !== "Failure") return;
      const failure = outcome.failure;
      if (failure._tag !== "WorkspaceLayoutConflictError") {
        throw new Error(`expected a conflict, got ${failure._tag}`);
      }
      assert.strictEqual(failure.expectedRevision, base.revision);
      // The loser is told what won so it can rebase rather than guess.
      assert.strictEqual(failure.actualRevision, winner.revision);

      // The winner's pane survived and the loser's was not applied.
      const stored = yield* layouts.read(base.workspaceId);
      const paneIds: readonly string[] = stored?.layout.panes.map((pane) => pane.paneId) ?? [];
      assert.isTrue(paneIds.includes("conflict-winner"));
      assert.isFalse(paneIds.includes("conflict-loser"));
    }),
  );

  it.effect("accepts a write that carries the current revision", () =>
    Effect.gen(function* () {
      const layouts = yield* WorkspaceLayouts;
      const base = seed("sequential");
      const first = yield* layouts.upsert({
        layout: base,
        projectId: projectA,
        threadId: null,
        expectedRevision: null,
      });

      const next = accepted(
        addPane(
          first.layout,
          createPane(PaneId.makeUnsafe("sequential-2"), "agent"),
          PaneRowId.makeUnsafe("sequential-row-2"),
        ),
      );
      const second = yield* layouts.upsert({
        layout: next,
        projectId: projectA,
        threadId: null,
        expectedRevision: first.layout.revision,
      });
      assert.strictEqual(second.layout.panes.length, 2);
    }),
  );

  it.effect("lists a project's workspaces and forgets a deleted one", () =>
    Effect.gen(function* () {
      const layouts = yield* WorkspaceLayouts;
      const listProject = ProjectId.makeUnsafe("project-list");
      for (const name of ["list-a", "list-b"]) {
        yield* layouts.upsert({
          layout: seed(name),
          projectId: listProject,
          threadId: null,
          expectedRevision: null,
        });
      }

      const listed = yield* layouts.listByProject(listProject);
      assert.strictEqual(listed.length, 2);

      yield* layouts.remove(WorkspaceId.makeUnsafe("list-a"));
      const remaining = yield* layouts.listByProject(listProject);
      assert.deepStrictEqual(
        remaining.map((entry) => entry.layout.workspaceId),
        ["list-b"],
      );
    }),
  );

  it.effect("repairs a stored layout that violates the grid invariants", () =>
    Effect.gen(function* () {
      // Simulates a row written by an older build or restored from a backup: the
      // read path must still hand back something renderable.
      const layouts = yield* WorkspaceLayouts;
      const corrupt: WorkspaceLayout = {
        workspaceId: WorkspaceId.makeUnsafe("corrupt"),
        revision: 3,
        rows: [
          { rowId: PaneRowId.makeUnsafe("empty"), cells: [], heightWeight: 1 },
          {
            rowId: PaneRowId.makeUnsafe("r1"),
            cells: [{ paneId: PaneId.makeUnsafe("ghost"), widthWeight: 1 }],
            heightWeight: 1,
          },
        ],
        panes: [createPane(PaneId.makeUnsafe("real"), "agent")],
        focusedPaneId: PaneId.makeUnsafe("ghost"),
      };

      yield* layouts.upsert({
        layout: corrupt,
        projectId: null,
        threadId: null,
        expectedRevision: null,
      });

      const stored = yield* layouts.read(corrupt.workspaceId);
      // The dangling cell and the empty row are gone, and with no placed pane the
      // layout is empty rather than pointing at something that cannot render.
      assert.strictEqual(stored?.layout.rows.length, 0);
      assert.strictEqual(stored?.layout.panes.length, 0);
      assert.strictEqual(stored?.layout.focusedPaneId, null);
    }),
  );
});
