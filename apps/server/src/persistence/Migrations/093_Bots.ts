import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bots (
      bot_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      avatar_json TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      provider_options_json TEXT,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      default_working_directory TEXT,
      default_project_id TEXT,
      chief_of_staff INTEGER NOT NULL DEFAULT 0,
      approve_peer_comms INTEGER NOT NULL DEFAULT 0,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      active_task_id TEXT,
      workspace_dir TEXT NOT NULL,
      memory_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_tasks (
      task_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      pinned_project_id TEXT,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      FOREIGN KEY (bot_id) REFERENCES bots(bot_id)
    )
  `;

  // At most one chief-of-staff bot at a time.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_chief_of_staff
    ON bots (chief_of_staff)
    WHERE chief_of_staff = 1
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_tasks_bot
    ON bot_tasks (bot_id, archived_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_tasks_project
    ON bot_tasks (pinned_project_id)
  `;
});
