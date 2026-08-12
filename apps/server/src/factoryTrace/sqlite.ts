// FILE: sqlite.ts
// Purpose: Normalize Bun and Node's SQLite APIs for SSSF trace readers and writers.
// Layer: Server factory trace

export type SqliteParameter = string | number | null;

export interface SqliteDatabase {
  readonly all: <Row>(sql: string, ...parameters: readonly SqliteParameter[]) => Row[];
  readonly run: (sql: string, ...parameters: readonly SqliteParameter[]) => void;
  readonly exec: (sql: string) => void;
  readonly close: () => void;
}

interface BunDatabase {
  query: (sql: string) => {
    all: (...parameters: unknown[]) => unknown[];
    run: (...parameters: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
  close: () => void;
}

interface NodeDatabase {
  prepare: (sql: string) => {
    all: (...parameters: unknown[]) => unknown[];
    run: (...parameters: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
  close: () => void;
}

export async function openSqliteDatabase(
  path: string,
  options: { readonly: boolean },
): Promise<SqliteDatabase> {
  if (process.versions.bun === undefined) {
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string, options: { readOnly: boolean }) => NodeDatabase;
    };
    const database = new DatabaseSync(path, { readOnly: options.readonly });
    return {
      all: <Row>(sql: string, ...parameters: readonly SqliteParameter[]) =>
        database.prepare(sql).all(...parameters) as Row[],
      run: (sql, ...parameters) => void database.prepare(sql).run(...parameters),
      exec: (sql) => database.exec(sql),
      close: () => database.close(),
    };
  }

  const { Database } = (await import("bun:sqlite")) as {
    Database: new (path: string, options?: { readonly?: boolean; create?: boolean }) => BunDatabase;
  };
  const database = new Database(path, {
    readonly: options.readonly,
    create: !options.readonly,
  });
  return {
    all: <Row>(sql: string, ...parameters: readonly SqliteParameter[]) =>
      database.query(sql).all(...parameters) as Row[],
    run: (sql, ...parameters) => void database.query(sql).run(...parameters),
    exec: (sql) => database.exec(sql),
    close: () => database.close(),
  };
}
