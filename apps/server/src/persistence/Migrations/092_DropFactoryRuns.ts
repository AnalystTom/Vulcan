// FILE: 092_DropFactoryRuns.ts
// Purpose: Drop the in-repo software factory's tables. Vulcan no longer runs a
// factory; it reads the trace of one that runs outside it.
//
// Migration 091 stays where it is rather than being edited away. Lineage is
// checked by id, so a database that already applied it must still see it in the
// list -- removing a migration retroactively is how a working install starts
// failing its own consistency check. Dropping forward is the only safe shape.
//
// Nothing is preserved. These tables recorded runs of a control plane that no
// longer exists, and the factory that replaces it keeps its own trace beside the
// checkout it works in, which is the single source of truth from here on.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Leases and attempts reference runs, so children go before parents even
  // though SQLite would not complain either way.
  yield* sql`DROP TABLE IF EXISTS factory_target_leases`;
  yield* sql`DROP TABLE IF EXISTS factory_attention_items`;
  yield* sql`DROP TABLE IF EXISTS factory_gate_results`;
  yield* sql`DROP TABLE IF EXISTS factory_artifacts`;
  yield* sql`DROP TABLE IF EXISTS factory_node_attempts`;
  yield* sql`DROP TABLE IF EXISTS factory_runs`;
  yield* sql`DROP TABLE IF EXISTS factory_execution_targets`;
  yield* sql`DROP TABLE IF EXISTS factory_workflow_definitions`;
});
