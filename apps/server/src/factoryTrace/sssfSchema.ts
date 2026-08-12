// FILE: sssfSchema.ts
// Purpose: Keep the upstream SSSF SQLite schema authoritative for both test
// fixtures and Vulcan-created traces.
// Layer: Server factory trace

/** The seven tables, transcribed from SSSF's observability contract. */
export const SSSF_SCHEMA = `
CREATE TABLE sessions (
  adw_id TEXT PRIMARY KEY,
  adw_name TEXT,
  request TEXT,
  status TEXT,
  engineer TEXT,
  started_at TEXT,
  ended_at TEXT,
  total_tokens INTEGER,
  total_cost REAL,
  archived INTEGER DEFAULT 0
);
CREATE TABLE phases (
  phase_id TEXT PRIMARY KEY,
  adw_id TEXT REFERENCES sessions,
  seq INTEGER,
  name TEXT, kind TEXT, owner TEXT, description TEXT,
  status TEXT DEFAULT 'fail',
  attempt INTEGER DEFAULT 0, retries INTEGER DEFAULT 0,
  error TEXT,
  started_at TEXT, ended_at TEXT
);
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  adw_id TEXT REFERENCES sessions,
  phase_id TEXT REFERENCES phases,
  parent_id TEXT,
  type TEXT,
  name TEXT,
  payload_json TEXT,
  tokens INTEGER,
  started_at TEXT, ended_at TEXT
);
CREATE TABLE envelopes (
  envelope_id TEXT PRIMARY KEY,
  adw_id TEXT REFERENCES sessions,
  phase_id TEXT REFERENCES phases,
  agent TEXT,
  output_type TEXT,
  payload_json TEXT,
  valid INTEGER,
  attempt INTEGER,
  created_at TEXT
);
CREATE TABLE gate_results (
  id INTEGER PRIMARY KEY,
  adw_id TEXT REFERENCES sessions,
  phase_id TEXT REFERENCES phases,
  attempt INTEGER,
  gate TEXT,
  passed INTEGER,
  violations_json TEXT,
  checks_json TEXT,
  created_at TEXT
);
CREATE TABLE processes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id TEXT REFERENCES sessions,
  kind TEXT, name TEXT, pid INTEGER, command TEXT,
  started_at TEXT, ended_at TEXT
);
CREATE TABLE agent_sessions (
  adw_id TEXT REFERENCES sessions,
  agent TEXT,
  coding_agent TEXT, model TEXT, color TEXT,
  session_id TEXT,
  context_tokens INTEGER,
  context_window INTEGER,
  created_at TEXT, last_used_at TEXT,
  PRIMARY KEY (adw_id, agent)
);
`;

/** Schema produced before optional SSSF migrations landed. */
export const SSSF_LEGACY_SCHEMA = SSSF_SCHEMA.replace("  adw_name TEXT,\n", "")
  .replace("  archived INTEGER DEFAULT 0\n", "  total_cost_placeholder INTEGER\n")
  .replace("  coding_agent TEXT, model TEXT, color TEXT,", "  coding_agent TEXT, model TEXT,")
  .replace("  context_tokens INTEGER,\n  context_window INTEGER,\n", "")
  .replace("  violations_json TEXT,\n  checks_json TEXT,", "  violations_json TEXT,");
