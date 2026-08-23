// FILE: SssfTraceWriter.ts
// Purpose: Append every provider's canonical runtime events to the workspace's
// SSSF trace without putting SQLite latency or failure on turn processing.
// Layer: Server factory trace

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { ProviderRuntimeEvent } from "@vulcan/contracts";
import { botColorHex } from "@vulcan/shared/botAppearance";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@vulcan/shared/DrainableWorker";
import { Cause, Effect, Layer, Option, Stream } from "effect";

import { createLogger } from "../../logger.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BotRepository } from "../../persistence/Services/BotRepository.ts";
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
  type TraceBotIdentity,
  type TraceThreadMetadata,
  type TraceWriteOperation,
} from "../traceMapping.ts";
import { resolveTraceDatabasePath } from "../tracePath.ts";

const logger = createLogger("factory-trace-writer");
const WRITER_CAPACITY = 256;
/** Threads whose bot lookup is remembered. Bounded so a long session cannot grow it without end. */
const BOT_IDENTITY_CACHE_LIMIT = 512;

/**
 * Columns Vulcan adds to a schema it does not own.
 *
 * Added by `ALTER` rather than by rewriting the file, because the database may
 * have been created by an external tracer that is still writing to it. Nullable
 * and absent from every read that matters, so that tracer keeps working whether
 * or not it ever learns the column exists.
 */
const OPTIONAL_COLUMNS: readonly {
  readonly table: string;
  readonly column: string;
}[] = [{ table: "agent_sessions", column: "display_name" }];

interface OpenTrace {
  readonly database: SqliteDatabase;
  readonly columns: Map<string, ReadonlySet<string>>;
  readonly ownedAdwIds: Set<string>;
}

const make = Effect.gen(function* () {
  const workspaces = yield* TraceWorkspaces;
  const projections = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const bots = yield* BotRepository;
  const mapper = new FactoryTraceMapper();
  const botIdentities = new Map<string, TraceBotIdentity | null>();
  const handles = new Map<string, OpenTrace>();
  const failures = new Map<string, number>();
  const reportedFailures = new Set<string>();

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const handle of handles.values()) handle.database.close();
      handles.clear();
    }),
  );

  /**
   * Brings an existing trace up to the columns we write, if it will let us.
   *
   * Best effort by design: a database another process holds may refuse the
   * `ALTER`, and the write path already drops columns a table does not have, so
   * a refusal costs the display name and nothing else.
   */
  const migrateOptionalColumns = (database: SqliteDatabase) => {
    for (const { table, column } of OPTIONAL_COLUMNS) {
      try {
        const columns = database.all<{ name: string }>(`PRAGMA table_info(${table})`);
        // An empty result means the table itself is missing: not our schema, and
        // not ours to invent.
        if (columns.length === 0) continue;
        if (columns.some((candidate) => candidate.name === column)) continue;
        database.run(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      } catch (cause) {
        logger.warn("could not add optional trace column", {
          table,
          column,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  };

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
    migrateOptionalColumns(database);
    const handle = {
      database,
      columns: new Map(),
      ownedAdwIds: new Set<string>(),
    };
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

  /**
   * Whether this thread is a bot's, cached per thread.
   *
   * Every runtime event would otherwise mean a join through `bot_tasks`, on the
   * writer's own path, for an answer that changes about as often as a thread
   * changes owner -- which is never. The cache is refreshed when a turn or a
   * session opens, so a renamed or recoloured bot is picked up by its next turn
   * without anything having to invalidate it.
   */
  const resolveBot = Effect.fnUntraced(function* (event: ProviderRuntimeEvent) {
    const cached = botIdentities.get(event.threadId);
    const stale = event.type === "session.started" || event.type === "turn.started";
    if (cached !== undefined && !stale) return cached;

    const resolved = yield* bots.getBotByThreadId({ threadId: event.threadId }).pipe(
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: (bot): TraceBotIdentity => ({
            name: bot.name,
            color: botColorHex(bot.avatar.color),
          }),
        }),
      ),
      // A failed lookup is not an answer: keep whatever was known rather than
      // recording "not a bot" and stranding the run in a provider lane.
      Effect.catchCause(() => Effect.succeed(undefined)),
    );
    if (resolved === undefined) return cached ?? null;

    if (!botIdentities.has(event.threadId) && botIdentities.size >= BOT_IDENTITY_CACHE_LIMIT) {
      const oldest = botIdentities.keys().next();
      if (oldest.done !== true) botIdentities.delete(oldest.value);
    }
    botIdentities.set(event.threadId, resolved);
    return resolved;
  });

  const metadataFor = (event: ProviderRuntimeEvent): Effect.Effect<TraceThreadMetadata> =>
    Effect.all({
      thread: projections.getThreadDetailById(event.threadId),
      bot: resolveBot(event),
    }).pipe(
      Effect.map(({ thread: threadOption, bot }) => {
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
          bot,
        };
      }),
      Effect.catchCause(() =>
        Effect.succeed({
          title: null,
          request: null,
          model: null,
          providerSessionId: null,
          bot: null,
        }),
      ),
    );

  const appendUnsafe = Effect.fnUntraced(function* (event: ProviderRuntimeEvent) {
    const workspace = yield* workspaces.resolveThreadWorkspacePath(event.threadId);
    if (process.env.VULCAN_TRACE_WRITER_DEBUG === "1") {
      logger.info("trace-writer event", {
        type: event.type,
        threadId: event.threadId,
        workspace,
      });
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
                logger.warn("trace-writer append failed", {
                  cause: Cause.pretty(cause),
                });
              }
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(append, {
    capacity: WRITER_CAPACITY,
  });
  const start: FactoryTraceWriterShape["start"] = startDrainableWorkerProducers(
    worker,
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) => worker.enqueue(event)),
      );
    }),
  );

  return {
    append,
    start,
    drain: worker.drain,
  } satisfies FactoryTraceWriterShape;
});

export const SssfTraceWriterLive = Layer.effect(FactoryTraceWriter, make);
