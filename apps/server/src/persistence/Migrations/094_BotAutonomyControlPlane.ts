import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const botColumnExists = (columnName: string) =>
    sql<{ readonly exists: number }>`
      SELECT EXISTS(
        SELECT 1 FROM pragma_table_info('bots') WHERE name = ${columnName}
      ) AS "exists"
    `.pipe(Effect.map(([row]) => row?.exists === 1));

  const ensureBotColumn = (columnName: string, definition: string) =>
    Effect.gen(function* () {
      if (yield* botColumnExists(columnName)) return;
      yield* sql.unsafe(`ALTER TABLE bots ADD COLUMN ${definition}`);
    });

  yield* ensureBotColumn(
    "isolation_mode",
    "isolation_mode TEXT NOT NULL DEFAULT 'worktree' CHECK (isolation_mode IN ('workspace', 'worktree'))",
  );
  yield* ensureBotColumn(
    "autonomy_json",
    `autonomy_json TEXT NOT NULL DEFAULT '{"enabled":false,"maxActiveRuns":1}'`,
  );
  yield* ensureBotColumn(
    "capability_grants_json",
    `capability_grants_json TEXT NOT NULL DEFAULT '["thread.read","filesystem.read"]'`,
  );

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_runtime_state (
      bot_id TEXT PRIMARY KEY,
      phase TEXT NOT NULL CHECK (
        phase IN (
          'idle',
          'running',
          'waiting-for-approval',
          'takeover-requested',
          'human-control',
          'paused',
          'error'
        )
      ),
      active_thread_id TEXT,
      takeover_reason TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (bot_id) REFERENCES bots(bot_id)
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO bot_runtime_state (
      bot_id,
      phase,
      active_thread_id,
      takeover_reason,
      updated_at
    )
    SELECT bot_id, 'idle', NULL, NULL, updated_at
    FROM bots
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_action_audit (
      audit_entry_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      task_id TEXT,
      thread_id TEXT,
      capability TEXT NOT NULL,
      action TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (
        decision IN ('allowed', 'denied', 'approval-required', 'cancelled', 'failed')
      ),
      summary TEXT NOT NULL,
      detail_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (bot_id) REFERENCES bots(bot_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_action_audit_bot_created
    ON bot_action_audit (bot_id, created_at DESC, audit_entry_id DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_action_audit_thread
    ON bot_action_audit (thread_id, created_at DESC)
  `;
});
