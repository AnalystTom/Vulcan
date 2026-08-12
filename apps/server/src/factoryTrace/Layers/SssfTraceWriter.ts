// FILE: SssfTraceWriter.ts
// Purpose: Append every provider's canonical runtime events to the workspace's
// SSSF trace without putting SQLite latency or failure on turn processing.
// Layer: Server factory trace

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { ProviderRuntimeEvent } from "@vulcan/contracts";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@vulcan/shared/DrainableWorker";
import { Cause, Effect, Layer, Option, Stream } from "effect";

import { createLogger } from "../../logger.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  FactoryTraceWriter,
  type FactoryTraceWriterShape,
} from "../Services/FactoryTraceWriter.ts";
import { TraceWorkspaces } from "../Services/TraceWorkspaces.ts";
import { openSqliteDatabase, type SqliteDatabase, type SqliteParameter } from "../sqlite.ts";
import { SSSF_SCHEMA } from "../sssfSchema.ts";
import {
  FactoryTraceMapper,
  type TraceThreadMetadata,
  type TraceWriteOperation,
} from "../traceMapping.ts";
import { resolveTraceDatabasePath } from "../tracePath.ts";

const logger = createLogger("factory-trace-writer");
const WRITER_CAPACITY = 256;

interface OpenTrace {
  readonly database: SqliteDatabase;
  readonly columns: Map<string, ReadonlySet<string>>;
  readonly ownedAdwIds: Set<string>;
}

const make = Effect.gen(function* () {
  const workspaces = yield* TraceWorkspaces;
  const projections = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const mapper = new FactoryTraceMapper();
  const handles = new Map<string, OpenTrace>();
  const failures = new Map<string, number>();
  const reportedFailures = new Set<string>();

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const handle of handles.values()) handle.database.close();
      handles.clear();
    }),
  );

  const open = async (path: string): Promise<OpenTrace> => {
    const existing = handles.get(path);
    if (existing) return existing;
    const created = !existsSync(path);
    if (created) mkdirSync(dirname(path), { recursive: true });
    const database = await openSqliteDatabase(path, { readonly: false });
    database.exec("PRAGMA busy_timeout = 5000");
    if (created) {
      database.exec("PRAGMA journal_mode = WAL");
      database.exec(SSSF_SCHEMA);
    }
    const handle = { database, columns: new Map(), ownedAdwIds: new Set<string>() };
    handles.set(path, handle);
    return handle;
  };

  const columnsFor = (handle: OpenTrace, table: string): ReadonlySet<string> => {
    const cached = handle.columns.get(table);
    if (cached) return cached;
    const columns = new Set(
      handle.database.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name),
    );
    handle.columns.set(table, columns);
    return columns;
  };

  const supportedEntries = (
    handle: OpenTrace,
    table: string,
    values: TraceWriteOperation["values"],
  ) => Object.entries(values).filter(([column]) => columnsFor(handle, table).has(column));

  const insert = (
    handle: OpenTrace,
    table: string,
    values: TraceWriteOperation["values"],
    prefix = "INSERT OR IGNORE",
  ) => {
    const entries = supportedEntries(handle, table, values);
    if (entries.length === 0) return;
    handle.database.run(
      `${prefix} INTO ${table} (${entries.map(([column]) => column).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`,
      ...entries.map(([, value]) => value),
    );
  };

  const update = (
    handle: OpenTrace,
    table: string,
    key: string,
    values: TraceWriteOperation["values"],
  ) => {
    const keyValue = values[key];
    const entries = supportedEntries(handle, table, values).filter(
      ([column, value]) =>
        column !== key && (key === "adw_id" || column !== "adw_id") && value !== null,
    );
    if (keyValue === undefined || entries.length === 0) return;
    handle.database.run(
      `UPDATE ${table} SET ${entries.map(([column]) => `${column} = ?`).join(", ")} WHERE ${key} = ?`,
      ...entries.map(([, value]) => value),
      keyValue,
    );
  };

  const applyOperation = (handle: OpenTrace, operation: TraceWriteOperation) => {
    const adwId = String(operation.values.adw_id ?? "");
    if (operation.kind === "session.ensure") {
      const hasAdwName = columnsFor(handle, "sessions").has("adw_name");
      const [existing] = handle.database.all<{ adw_name: string | null }>(
        `SELECT ${hasAdwName ? "adw_name" : "NULL AS adw_name"} FROM sessions WHERE adw_id = ?`,
        adwId,
      );
      if (!existing) {
        insert(handle, "sessions", operation.values);
        handle.ownedAdwIds.add(adwId);
      } else if (existing.adw_name === "vulcan") {
        // A server restart can resume a native thread whose deterministic id is
        // already present. The provenance marker distinguishes that row from an
        // external tracer's coincidental 8-hex collision.
        handle.ownedAdwIds.add(adwId);
      }
      return;
    }
    if (!handle.ownedAdwIds.has(adwId)) return;
    switch (operation.kind) {
      case "session.update":
        update(handle, "sessions", "adw_id", operation.values);
        return;
      case "phase.insert":
        {
          const [latest] = handle.database.all<{ seq: number | null }>(
            "SELECT MAX(seq) AS seq FROM phases WHERE adw_id = ?",
            adwId,
          );
          insert(handle, "phases", {
            ...operation.values,
            seq: (latest?.seq ?? 0) + 1,
          });
        }
        return;
      case "phase.update":
        update(handle, "phases", "phase_id", operation.values);
        return;
      case "event.insert":
        insert(handle, "events", operation.values);
        return;
      case "agent.upsert": {
        const entries = supportedEntries(handle, "agent_sessions", operation.values);
        const updates = entries
          .filter(([column]) => !["adw_id", "agent", "created_at"].includes(column))
          .map(([column]) => `${column} = COALESCE(excluded.${column}, agent_sessions.${column})`);
        handle.database.run(
          `INSERT INTO agent_sessions (${entries.map(([column]) => column).join(", ")}) VALUES (${entries.map(() => "?").join(", ")}) ON CONFLICT(adw_id, agent) DO UPDATE SET ${updates.join(", ")}`,
          ...entries.map(([, value]) => value as SqliteParameter),
        );
      }
    }
  };

  const metadataFor = (event: ProviderRuntimeEvent): Effect.Effect<TraceThreadMetadata> =>
    projections.getThreadDetailById(event.threadId).pipe(
      Effect.map((threadOption) => {
        const thread = Option.getOrUndefined(threadOption);
        const matchingUserMessage = thread?.messages.findLast(
          (message) =>
            message.role === "user" &&
            (event.turnId === undefined || message.turnId === event.turnId),
        );
        return {
          title: thread?.title ?? null,
          request: matchingUserMessage?.text.trim() || null,
          model: thread?.modelSelection.model ?? null,
          providerSessionId: event.providerRefs?.providerThreadId ?? null,
        };
      }),
      Effect.catchCause(() =>
        Effect.succeed({ title: null, request: null, model: null, providerSessionId: null }),
      ),
    );

  const appendUnsafe = Effect.fnUntraced(function* (event: ProviderRuntimeEvent) {
    const workspace = yield* workspaces.resolveThreadWorkspacePath(event.threadId);
    if (process.env.VULCAN_TRACE_WRITER_DEBUG === "1") {
      logger.info("trace-writer event", { type: event.type, threadId: event.threadId, workspace });
    }
    if (workspace === null) return;
    const path = resolveTraceDatabasePath(workspace);
    if ((failures.get(path) ?? 0) >= 3) return;
    const metadata = yield* metadataFor(event);
    const operations = mapper.map(event, metadata);
    if (operations.length === 0) return;
    yield* Effect.tryPromise({
      try: async () => {
        const handle = await open(path);
        handle.database.exec("BEGIN IMMEDIATE");
        try {
          for (const operation of operations) applyOperation(handle, operation);
          handle.database.exec("COMMIT");
          failures.delete(path);
        } catch (cause) {
          handle.database.exec("ROLLBACK");
          throw cause;
        }
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          const count = (failures.get(path) ?? 0) + 1;
          failures.set(path, count);
          if (count >= 3 && !reportedFailures.has(path)) {
            reportedFailures.add(path);
            logger.warn("factory trace writes disabled after persistent failure", { path });
          }
        }),
      ),
    );
  });

  const append: FactoryTraceWriterShape["append"] = (event) =>
    appendUnsafe(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.sync(() => {
              if (process.env.VULCAN_TRACE_WRITER_DEBUG === "1") {
                logger.warn("trace-writer append failed", { cause: Cause.pretty(cause) });
              }
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(append, { capacity: WRITER_CAPACITY });
  const start: FactoryTraceWriterShape["start"] = startDrainableWorkerProducers(
    worker,
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) => worker.enqueue(event)),
      );
    }),
  );

  return { append, start, drain: worker.drain } satisfies FactoryTraceWriterShape;
});

export const SssfTraceWriterLive = Layer.effect(FactoryTraceWriter, make);
