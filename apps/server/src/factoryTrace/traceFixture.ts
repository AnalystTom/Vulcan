// FILE: traceFixture.ts
// Purpose: Build a real `sssf.db` -- their schema, their column names -- so the
// reader is tested against the file it will actually be handed.
// Layer: Server factory trace (test support)
//
// Deliberately raw SQL rather than a helper that mirrors our own types: the
// point of these tests is that we read *their* file correctly, and a fixture
// built from our own understanding of the schema would pass even if that
// understanding were wrong. The DDL below is transcribed from their
// `references/observability.md`.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { SSSF_LEGACY_SCHEMA, SSSF_SCHEMA } from "./sssfSchema.ts";

interface WritableDatabase {
  exec: (sql: string) => void;
  close: () => void;
}

async function openWritable(path: string): Promise<WritableDatabase> {
  mkdirSync(dirname(path), { recursive: true });
  if (process.versions.bun === undefined) {
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string) => WritableDatabase;
    };
    return new DatabaseSync(path);
  }
  const { Database } = (await import("bun:sqlite")) as {
    Database: new (path: string) => WritableDatabase;
  };
  return new Database(path);
}

const quote = (value: string | number | null): string =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${value.replace(/'/g, "''")}'`;

export interface FixtureRow {
  readonly [column: string]: string | number | null;
}

export interface TraceFixture {
  readonly sessions?: readonly FixtureRow[];
  readonly phases?: readonly FixtureRow[];
  readonly events?: readonly FixtureRow[];
  readonly envelopes?: readonly FixtureRow[];
  readonly gateResults?: readonly FixtureRow[];
  readonly agentSessions?: readonly FixtureRow[];
  /** Write the schema an older tracer produced, without the migrated columns. */
  readonly legacy?: boolean;
}

/** Writes a trace database at `path` and returns it closed, ready to be read. */
export async function writeTraceFixture(path: string, fixture: TraceFixture): Promise<void> {
  const database = await openWritable(path);
  try {
    // WAL because that is what their tracer sets, and reading through a writer's
    // inserts is the property the whole polling contract depends on.
    database.exec("PRAGMA journal_mode = WAL");
    database.exec(fixture.legacy === true ? SSSF_LEGACY_SCHEMA : SSSF_SCHEMA);

    const insert = (table: string, rows: readonly FixtureRow[] | undefined) => {
      for (const row of rows ?? []) {
        const columns = Object.keys(row);
        database.exec(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
            .map((column) => quote(row[column] ?? null))
            .join(", ")})`,
        );
      }
    };

    insert("sessions", fixture.sessions);
    insert("phases", fixture.phases);
    insert("events", fixture.events);
    insert("envelopes", fixture.envelopes);
    insert("gate_results", fixture.gateResults);
    insert("agent_sessions", fixture.agentSessions);
  } finally {
    database.close();
  }
}
