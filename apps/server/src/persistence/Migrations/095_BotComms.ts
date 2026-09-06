import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Phase 2 peer comms: mirrored bot⇄bot DM channels, the async delegation queue, and
 * the per-thread comms depth ledger that stops A→B→C chains.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_comms_channels (
      channel_id TEXT PRIMARY KEY,
      bot_a_id TEXT NOT NULL,
      bot_b_id TEXT NOT NULL,
      last_message_preview TEXT,
      last_message_at TEXT,
      unread INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (bot_a_id < bot_b_id),
      UNIQUE (bot_a_id, bot_b_id),
      FOREIGN KEY (bot_a_id) REFERENCES bots(bot_id),
      FOREIGN KEY (bot_b_id) REFERENCES bots(bot_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_comms_messages (
      message_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      from_bot_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('text', 'activity')),
      text TEXT NOT NULL,
      source_thread_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (channel_id) REFERENCES bot_comms_channels(channel_id),
      FOREIGN KEY (from_bot_id) REFERENCES bots(bot_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_comms_messages_channel
    ON bot_comms_messages (channel_id, created_at, message_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_delegations (
      delegation_id TEXT PRIMARY KEY,
      source_bot_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      target_bot_id TEXT NOT NULL,
      target_thread_id TEXT,
      prompt TEXT NOT NULL,
      reason TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'done', 'failed', 'rejected')
      ),
      result TEXT,
      channel_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (source_bot_id) REFERENCES bots(bot_id),
      FOREIGN KEY (target_bot_id) REFERENCES bots(bot_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_delegations_source_status
    ON bot_delegations (source_thread_id, status, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_delegations_bots
    ON bot_delegations (source_bot_id, target_bot_id, created_at DESC)
  `;

  // One row per thread whose *current* turn was started by another bot. Written
  // before the peer turn is dispatched, cleared when that turn settles, and wiped
  // at startup (a depth row cannot outlive the process that set it).
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_comms_depth (
      thread_id TEXT PRIMARY KEY,
      depth INTEGER NOT NULL,
      source_bot_id TEXT,
      set_at TEXT NOT NULL
    )
  `;
});
