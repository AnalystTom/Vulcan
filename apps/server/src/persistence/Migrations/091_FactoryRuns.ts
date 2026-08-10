// FILE: 091_FactoryRuns.ts
// Purpose: Durable storage for the Software Factory -- Workflow Definitions,
// Workflow Runs, Node Attempts, Artifacts, Gate Results, Attention Items, and the
// Execution Targets and leases that runs are scheduled onto.
//
// Shape notes
// -----------
// A Workflow Definition is immutable and keyed by (id, version), not by id alone.
// Editing a workflow inserts a new version, so a Run's results stay reproducible
// against exactly the plan it executed rather than against whatever the workflow
// later became.
//
// Attempts, artifacts, and gate results are separate tables rather than a blob on
// the run. Unlike a pane layout -- which is small, bounded, and always read whole
// -- these are queried by their interior: attempts by state for the supervisor,
// artifacts by revision for gate admissibility, attention items by whether they
// are still open. A JSON document would make every one of those a full scan and a
// rewrite.
//
// Every artifact and gate result carries its revision as a column. That is what
// makes "evidence produced against a revision the workspace has left" a query
// rather than a post-filter, and it is the rule the product's completion claims
// rest on.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS factory_workflow_definitions (
      definition_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      -- The canonical YAML, verbatim. An audit reads what the author wrote.
      source TEXT NOT NULL,
      -- Parsed nodes and policy, so a run never re-parses to schedule.
      nodes_json TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (definition_id, version)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS factory_runs (
      run_id TEXT PRIMARY KEY,
      definition_id TEXT NOT NULL,
      definition_version INTEGER NOT NULL,
      work_item_id TEXT NOT NULL,
      workspace_id TEXT,
      project_id TEXT,
      thread_id TEXT,
      -- Revision the run started from; the live revision lives on attempts.
      base_revision TEXT NOT NULL,
      current_revision TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      ended_at TEXT
    )
  `;

  // The supervisor's hot path is "which runs are still going", so state is
  // indexed rather than scanned on every tick.
  yield* sql`
    CREATE INDEX IF NOT EXISTS factory_runs_state_idx ON factory_runs (state)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS factory_runs_work_item_idx ON factory_runs (work_item_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS factory_node_attempts (
      attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      state TEXT NOT NULL,
      waiting_reason TEXT,
      target_id TEXT,
      revision TEXT,
      started_at TEXT,
      last_heartbeat_at TEXT,
      ended_at TEXT,
      failure_summary TEXT,
      -- Recovery rungs already spent for this attempt's node, so the ladder
      -- survives a restart instead of starting over and looping.
      attempted_recovery_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE (run_id, node_id, attempt_number)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS factory_node_attempts_run_idx ON factory_node_attempts (run_id)
  `;
  // The stall sweep reads in-flight attempts across every run.
  yield* sql`
    CREATE INDEX IF NOT EXISTS factory_node_attempts_state_idx ON factory_node_attempts (state)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS factory_artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      produced_by_node_id TEXT NOT NULL,
      produced_by_attempt_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'informational')),
      uri TEXT,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  // Gate admissibility is "artifacts for this run at this revision", so both
  // columns are in one index.
  yield* sql`
    CREATE INDEX IF NOT EXISTS factory_artifacts_run_revision_idx
    ON factory_artifacts (run_id, revision)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS factory_gate_results (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      passed INTEGER NOT NULL,
      policy_version INTEGER NOT NULL,
      checks_json TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      -- One verdict per gate per revision. Re-evaluating at the same revision
      -- replaces it; a new revision is a new row, so superseded verdicts are
      -- retained rather than overwritten and an audit can see the history.
      PRIMARY KEY (run_id, node_id, revision)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS factory_gate_results_run_idx ON factory_gate_results (run_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS factory_attention_items (
      attention_item_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT,
      attempt_id TEXT,
      request TEXT NOT NULL,
      reason TEXT NOT NULL,
      attempted_recovery_json TEXT NOT NULL,
      workspace_id TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution TEXT
    )
  `;
  // The inbox is "everything still open", ordered oldest first.
  yield* sql`
    CREATE INDEX IF NOT EXISTS factory_attention_items_open_idx
    ON factory_attention_items (resolved_at, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS factory_execution_targets (
      target_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      -- Capabilities the target has actually reported. Never inferred from the
      -- target merely being reachable.
      capabilities_json TEXT NOT NULL,
      max_concurrent_leases INTEGER NOT NULL,
      online INTEGER NOT NULL,
      last_seen_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS factory_target_leases (
      attempt_id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      -- Bounded so a target lost mid-run frees itself rather than being held
      -- forever by an attempt nobody can reach.
      expires_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS factory_target_leases_target_idx
    ON factory_target_leases (target_id)
  `;
});
