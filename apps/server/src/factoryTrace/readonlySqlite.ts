// FILE: readonlySqlite.ts
// Purpose: A minimal read-only SQLite handle that works under both Bun and Node.
// Layer: Server factory trace
//
// The factory's trace is a file another process is actively writing. Vulcan's
// own persistence layer is the wrong tool for it: that stack owns a database,
// runs migrations against it, and assumes it may write. Here we must do the
// opposite -- open someone else's file, never write, and never block their
// inserts -- so this is a handful of lines rather than a client layer.
//
// `busy_timeout` is taken but `journal_mode` is only *read*: WAL is set by the
// tracer when it creates the database, and a read-only connection cannot change
// it. Reporting the mode we found lets the pane say why reads might stall,
// rather than silently pretending the file is well configured.

import { existsSync } from "node:fs";

import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";

export interface ReadonlyDatabase extends Omit<SqliteDatabase, "run"> {
  /** Rows for a SELECT, with positional parameters. */
  readonly journalMode: string;
}

export class MissingTraceDatabase extends Error {
  constructor(readonly path: string) {
    super(`No factory trace database at ${path}`);
    this.name = "MissingTraceDatabase";
  }
}

/**
 * Opens a trace database read-only.
 *
 * Throws `MissingTraceDatabase` when the file is absent, which is the ordinary
 * state of a workspace with no factory stamped into it and must be told apart
 * from a corrupt or unreadable one.
 */
export async function openReadonlyDatabase(path: string): Promise<ReadonlyDatabase> {
  if (!existsSync(path)) throw new MissingTraceDatabase(path);

  const handle = await openSqliteDatabase(path, { readonly: true });

  handle.exec("PRAGMA busy_timeout = 5000");
  const [mode] = handle.all<{ journal_mode?: string }>("PRAGMA journal_mode");
  return {
    all: handle.all,
    exec: handle.exec,
    close: handle.close,
    journalMode: mode?.journal_mode ?? "unknown",
  };
}
