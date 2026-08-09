// FILE: 090_WorkspaceLayouts.ts
// Purpose: Durable storage for each Workspace's Pane layout, so a Workspace
// restores its grid, Pane identities, modes, attachments, sizes, focus, and pin
// state after a restart, a reconnect, or a move to another client.
//
// The layout is stored as one JSON document per Workspace rather than as
// normalized row/cell tables. The whole grid is read and written atomically on
// every operation, is bounded to nine panes by contract, and is never queried by
// its interior -- so decomposing it would buy nothing and would let a partial
// write leave a Workspace with a grid that cannot be rendered.
//
// `revision` is stored as a column, not just inside the document, because it is
// the optimistic-concurrency token. Writes are conditional on it, which is what
// stops a stale desktop client from clobbering a layout a mobile client just
// changed.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_layouts (
      workspace_id TEXT PRIMARY KEY,
      project_id TEXT,
      thread_id TEXT,
      revision INTEGER NOT NULL,
      layout_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Workspaces are listed per project in the Workspace switcher, and looked up
  // by thread when an Agent Session needs the Workspace it belongs to.
  yield* sql`
    CREATE INDEX IF NOT EXISTS workspace_layouts_project_id_idx
    ON workspace_layouts (project_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS workspace_layouts_thread_id_idx
    ON workspace_layouts (thread_id)
  `;
});
