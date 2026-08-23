// FILE: SssfTraceSource.ts
// Purpose: Read a Super Simple Software Factory trace (`sssf.db`) as Vulcan's
// factory trace source.
// Layer: Server factory trace
//
// Their contract, followed exactly: agents write to SQLite, readers poll SQLite.
// There is no ingest endpoint to call, no socket to subscribe to, and no replay
// path -- live and history are the same `rowid > ?` query at different cadence.
// Every connection here is read-only; the only writers are the tracers of ADW
// processes that are still working, and WAL is what lets us read straight
// through their inserts.
//
// Columns the tracer added by migration are probed rather than selected blindly.
// A trace written by an older tracer is a normal thing to be handed, and it must
// degrade to "this db predates the column" instead of failing the whole read.

import { dirname } from "node:path";

import {
  AdwId,
  PhaseId,
  type TraceAgentSession,
  type TraceEvent,
  type TraceEnvelope,
  type TraceGateCheck,
  type TraceGateResult,
  type TracePhase,
  type TraceSession,
  type TraceSessionDetail,
  type TraceSessionSummary,
  type TraceSessionUsage,
  type TraceSourceStatus,
} from "@vulcan/contracts";
import { Effect, Layer } from "effect";

import { createLogger } from "../../logger.ts";
import {
  FactoryTraceError,
  FactoryTraceSource,
  type FactoryTraceSourceShape,
} from "../Services/FactoryTraceSource.ts";
import { TraceWorkspaces } from "../Services/TraceWorkspaces.ts";
import {
  MissingTraceDatabase,
  openReadonlyDatabase,
  type ReadonlyDatabase,
} from "../readonlySqlite.ts";
import { resolveTraceDatabasePath } from "../tracePath.ts";

const logger = createLogger("factory-trace");

/** Where the factory keeps its trace, relative to the repo it was stamped into. */
/** Events per read. Their polling contract's page size. */
const EVENT_PAGE_LIMIT = 500;
const SESSION_LIMIT = 200;

// --- raw row shapes ----------------------------------------------------------

interface SessionRow {
  adw_id: string;
  adw_name: string | null;
  request: string | null;
  status: string | null;
  engineer: string | null;
  started_at: string | null;
  ended_at: string | null;
  total_tokens: number | null;
  total_cost: number | null;
  archived: number | null;
}

interface PhaseRow {
  phase_id: string;
  adw_id: string;
  seq: number | null;
  name: string | null;
  kind: string | null;
  owner: string | null;
  description: string | null;
  status: string | null;
  attempt: number | null;
  retries: number | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
}

interface EventRow {
  rowid: number;
  event_id: string;
  adw_id: string;
  phase_id: string | null;
  parent_id: string | null;
  type: string | null;
  name: string | null;
  payload_json: string | null;
  tokens: number | null;
  started_at: string | null;
  ended_at: string | null;
}

interface EnvelopeRow {
  envelope_id: string;
  adw_id: string;
  phase_id: string | null;
  agent: string | null;
  output_type: string | null;
  payload_json: string | null;
  valid: number | null;
  attempt: number | null;
  created_at: string | null;
}

interface GateRow {
  id: number;
  adw_id: string;
  phase_id: string | null;
  attempt: number | null;
  gate: string | null;
  passed: number | null;
  violations_json: string | null;
  checks_json: string | null;
  created_at: string | null;
}

interface AgentRow {
  adw_id: string;
  agent: string;
  display_name: string | null;
  coding_agent: string | null;
  model: string | null;
  session_id: string | null;
  color: string | null;
  context_tokens: number | null;
  context_window: number | null;
  created_at: string | null;
  last_used_at: string | null;
}

// --- row mapping -------------------------------------------------------------

const asAdwId = (value: string) => value as AdwId;
const asPhaseId = (value: string | null) => (value === null ? null : (value as PhaseId));

/** SQLite has no booleans; the tracer writes 0/1 and NULL means "never set". */
const asBoolean = (value: number | null) => value === 1;

const asCount = (value: number | null) => (value === null ? null : Math.max(0, Math.trunc(value)));

const isOneOf = <T extends string>(allowed: readonly T[], value: string | null): T | null =>
  value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;

const SESSION_STATUSES = ["running", "completed", "failed", "success", "fail"] as const;
const PHASE_STATUSES = ["queued", "running", "completed", "failed", "success", "fail"] as const;
const PHASE_KINDS = ["engineer", "code", "agent"] as const;
const EVENT_TYPES = [
  "phase_start",
  "phase_end",
  "agent_start",
  "agent_end",
  "tool_call",
  "handoff",
  "gate_pass",
  "gate_fail",
  "log",
  "error",
] as const;

const toSession = (row: SessionRow): TraceSession => ({
  adwId: asAdwId(row.adw_id),
  adwName: row.adw_name,
  request: row.request,
  status: isOneOf(SESSION_STATUSES, row.status),
  engineer: row.engineer,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  totalTokens: asCount(row.total_tokens),
  totalCost: row.total_cost,
  archived: asBoolean(row.archived),
});

const toPhase = (row: PhaseRow): TracePhase => ({
  phaseId: row.phase_id as PhaseId,
  adwId: asAdwId(row.adw_id),
  seq: asCount(row.seq),
  name: row.name,
  kind: isOneOf(PHASE_KINDS, row.kind),
  owner: row.owner,
  description: row.description,
  status: isOneOf(PHASE_STATUSES, row.status),
  attempt: asCount(row.attempt),
  retries: asCount(row.retries),
  error: row.error,
  startedAt: row.started_at,
  endedAt: row.ended_at,
});

const toEvent = (row: EventRow): TraceEvent => ({
  rowid: Math.max(0, Math.trunc(row.rowid)),
  eventId: row.event_id,
  adwId: asAdwId(row.adw_id),
  phaseId: asPhaseId(row.phase_id),
  parentId: row.parent_id,
  type: isOneOf(EVENT_TYPES, row.type),
  name: row.name,
  payloadJson: row.payload_json,
  tokens: asCount(row.tokens),
  startedAt: row.started_at,
  endedAt: row.ended_at,
});

const toEnvelope = (row: EnvelopeRow): TraceEnvelope => ({
  envelopeId: row.envelope_id,
  adwId: asAdwId(row.adw_id),
  phaseId: asPhaseId(row.phase_id),
  agent: row.agent,
  outputType: row.output_type,
  payloadJson: row.payload_json,
  valid: asBoolean(row.valid),
  attempt: asCount(row.attempt),
  createdAt: row.created_at,
});

/**
 * Parses a JSON column, treating anything unreadable as absent.
 *
 * A malformed payload costs its own detail, never the whole read: the trace is
 * written by another process and a bad row must not take the pane down with it.
 */
function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const toGateResult = (row: GateRow): TraceGateResult => ({
  id: Math.max(0, Math.trunc(row.id)),
  adwId: asAdwId(row.adw_id),
  phaseId: asPhaseId(row.phase_id),
  attempt: asCount(row.attempt),
  gate: row.gate,
  passed: asBoolean(row.passed),
  violations: parseJson<string[]>(row.violations_json) ?? [],
  // Null stays null: "no evidence was recorded" is a different claim from
  // "the gate checked nothing".
  checks: parseJson<TraceGateCheck[]>(row.checks_json),
  createdAt: row.created_at,
});

const toAgentSession = (row: AgentRow): TraceAgentSession => ({
  adwId: asAdwId(row.adw_id),
  agent: row.agent,
  displayName: row.display_name,
  codingAgent: row.coding_agent,
  model: row.model,
  sessionId: row.session_id,
  color: row.color,
  contextTokens: asCount(row.context_tokens),
  contextWindow: asCount(row.context_window),
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

/** The `agent_start` payload, which is all a still-running agent has to offer. */
interface AgentStartPayload {
  model?: string;
  session_id?: string;
  color?: string;
  /** Vulcan's own: the bot the thread belongs to, before its row exists. */
  display_name?: string;
}

interface AgentEndUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_write_tokens?: number;
}

// --- the reader --------------------------------------------------------------

/**
 * One open database, reopened when the path changes.
 *
 * Held rather than reopened per request because the pane polls: opening a file
 * handle every second to answer the same question would be pure waste. The
 * handle is dropped as soon as a different workspace is asked about, so a
 * long-lived server never pins a database from a closed project.
 */
class TraceReader {
  private handle: { path: string; database: ReadonlyDatabase } | null = null;
  private readonly columnCache = new Map<string, boolean>();

  async open(path: string): Promise<ReadonlyDatabase> {
    if (this.handle?.path === path) return this.handle.database;
    this.handle?.database.close();
    this.columnCache.clear();
    const database = await openReadonlyDatabase(path);
    this.handle = { path, database };
    return database;
  }

  /**
   * A SELECT fragment for a column the tracer adds by migration.
   *
   * Selecting one blindly throws "no such column" against a db an older tracer
   * wrote, so it is probed and substituted with NULL, which reads downstream as
   * "this trace predates the column". The probe re-runs while the column is
   * missing, because the tracer's ALTER can land while we are serving; once
   * seen, a column never goes away, so it latches.
   */
  optionalColumn(database: ReadonlyDatabase, table: string, column: string): string {
    const key = `${table}.${column}`;
    if (this.columnCache.get(key) !== true) {
      const columns = database.all<{ name: string }>(`PRAGMA table_info(${table})`);
      this.columnCache.set(
        key,
        columns.some((candidate) => candidate.name === column),
      );
    }
    return this.columnCache.get(key) === true ? column : `NULL AS ${column}`;
  }
}

const makeSssfTraceSource = Effect.gen(function* () {
  const workspaces = yield* TraceWorkspaces;
  const reader = new TraceReader();

  /**
   * Where this thread's trace lives.
   *
   * The override wins, then the thread's own checkout. Derived from the
   * workspace every time rather than remembered, so a thread handed off to a
   * worktree starts reading the worktree's trace without anything to invalidate.
   */
  const resolvePath = (threadId: Parameters<FactoryTraceSourceShape["status"]>[0]["threadId"]) =>
    Effect.gen(function* () {
      if (threadId === null) return null;
      const workspacePath = yield* workspaces.resolveThreadWorkspacePath(threadId);
      return workspacePath === null ? null : resolveTraceDatabasePath(workspacePath);
    });

  const withDatabase = <A>(
    path: string,
    use: (database: ReadonlyDatabase) => A,
  ): Effect.Effect<A, FactoryTraceError> =>
    Effect.tryPromise({
      try: async () => use(await reader.open(path)),
      catch: (cause) =>
        new FactoryTraceError({
          message:
            cause instanceof MissingTraceDatabase
              ? `No factory trace at ${path}.`
              : `Could not read the factory trace at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });

  const status: FactoryTraceSourceShape["status"] = ({ threadId }) =>
    Effect.gen(function* () {
      const path = yield* resolvePath(threadId);
      if (path === null) return { state: "no-workspace" } as const;

      return yield* withDatabase(path, (database) => {
        const [count] = database.all<{ n: number }>("SELECT COUNT(*) AS n FROM sessions");
        return {
          state: "ready",
          databasePath: path,
          journalMode: database.journalMode,
          sessionCount: count?.n ?? 0,
        } as const satisfies TraceSourceStatus;
      }).pipe(
        Effect.catchTag("FactoryTraceError", (error) =>
          Effect.succeed(
            error.message.startsWith("No factory trace")
              ? ({ state: "absent", databasePath: path } as const)
              : ({
                  state: "unreadable",
                  databasePath: path,
                  reason: error.message,
                } as const),
          ),
        ),
      );
    });

  /**
   * Agents under a session: finished rows, then the ones still in flight.
   *
   * A running agent has no `agent_sessions` row yet -- only an `agent_start`
   * event -- and a lane with no label is worse than a lane labelled from the
   * event it does have. A finished row always wins, so this only fills gaps.
   */
  const readAgents = (
    database: ReadonlyDatabase,
    adwIds: readonly string[],
  ): TraceAgentSession[] => {
    if (adwIds.length === 0) return [];
    const placeholders = adwIds.map(() => "?").join(", ");
    const color = reader.optionalColumn(database, "agent_sessions", "color");
    const displayName = reader.optionalColumn(database, "agent_sessions", "display_name");
    const contextTokens = reader.optionalColumn(database, "agent_sessions", "context_tokens");
    const contextWindow = reader.optionalColumn(database, "agent_sessions", "context_window");

    const finished = database.all<AgentRow>(
      `SELECT adw_id, agent, ${displayName}, coding_agent, model, session_id, ${color},
              ${contextTokens}, ${contextWindow}, created_at, last_used_at
         FROM agent_sessions WHERE adw_id IN (${placeholders})
        ORDER BY created_at, agent`,
      ...adwIds,
    );
    const agents = finished.map(toAgentSession);
    const seen = new Set(agents.map((agent) => `${agent.adwId} ${agent.agent}`));

    const started = database.all<{
      adw_id: string;
      agent: string | null;
      payload_json: string | null;
      started_at: string | null;
    }>(
      `SELECT e.adw_id, p.owner AS agent, e.payload_json, e.started_at
         FROM events e JOIN phases p ON p.phase_id = e.phase_id
        WHERE e.adw_id IN (${placeholders}) AND e.type = 'agent_start'
        ORDER BY e.rowid`,
      ...adwIds,
    );

    for (const row of started) {
      if (row.agent === null) continue;
      const key = `${row.adw_id} ${row.agent}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const payload = parseJson<AgentStartPayload>(row.payload_json) ?? {};
      agents.push({
        adwId: asAdwId(row.adw_id),
        agent: row.agent,
        displayName: payload.display_name ?? null,
        codingAgent: null,
        model: payload.model ?? null,
        sessionId: payload.session_id ?? null,
        color: payload.color ?? null,
        // Occupancy is only known once the agent's turn closes.
        contextTokens: null,
        contextWindow: null,
        createdAt: row.started_at,
        lastUsedAt: row.started_at,
      });
    }
    return agents;
  };

  /**
   * What actually moved through a session, from the `agent_end` payloads.
   *
   * Derived rather than read off the session row because `total_tokens` is a
   * spend number: every turn re-sends the whole conversation, so it counts the
   * same context many times over. Raw reads only -- new input plus cache writes
   * -- because a cache read is that same material served again.
   */
  const readUsage = (database: ReadonlyDatabase, adwId: string): TraceSessionUsage => {
    const rows = database.all<{ payload_json: string | null }>(
      "SELECT payload_json FROM events WHERE adw_id = ? AND type = 'agent_end'",
      adwId,
    );
    let read = 0;
    let written = 0;
    for (const row of rows) {
      const usage = parseJson<{ usage?: AgentEndUsage }>(row.payload_json)?.usage;
      if (!usage) continue;
      read += (usage.input_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
      written += usage.output_tokens ?? 0;
    }
    return { read, written };
  };

  const listSessions: FactoryTraceSourceShape["listSessions"] = ({ threadId, limit }) =>
    Effect.gen(function* () {
      const path = yield* resolvePath(threadId);
      if (path === null) return [];

      return yield* withDatabase(path, (database): readonly TraceSessionSummary[] => {
        const adwName = reader.optionalColumn(database, "sessions", "adw_name");
        const archived = reader.optionalColumn(database, "sessions", "archived");
        const rows = database.all<SessionRow>(
          `SELECT adw_id, ${adwName}, request, status, engineer, started_at, ended_at,
                  total_tokens, total_cost, ${archived}
             FROM sessions ORDER BY started_at DESC, rowid DESC LIMIT ?`,
          Math.max(1, Math.min(limit ?? SESSION_LIMIT, SESSION_LIMIT)),
        );
        if (rows.length === 0) return [];

        const adwIds = rows.map((row) => row.adw_id);
        const placeholders = adwIds.map(() => "?").join(", ");
        const phases = database.all<PhaseRow>(
          `SELECT phase_id, adw_id, seq, name, kind, owner, description, status,
                  attempt, retries, error, started_at, ended_at
             FROM phases WHERE adw_id IN (${placeholders}) ORDER BY seq, rowid`,
          ...adwIds,
        );
        const agents = readAgents(database, adwIds);

        return rows.map((row) => ({
          session: toSession(row),
          phases: phases.filter((phase) => phase.adw_id === row.adw_id).map(toPhase),
          agents: agents.filter((agent) => agent.adwId === row.adw_id),
        }));
      });
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => logger.warn("factory trace unreadable", { reason: error.message })),
      ),
    );

  const readSession: FactoryTraceSourceShape["readSession"] = ({ threadId, adwId, after }) =>
    Effect.gen(function* () {
      const path = yield* resolvePath(threadId);
      if (path === null) return null;

      return yield* withDatabase(path, (database): TraceSessionDetail | null => {
        const adwName = reader.optionalColumn(database, "sessions", "adw_name");
        const archived = reader.optionalColumn(database, "sessions", "archived");
        const [row] = database.all<SessionRow>(
          `SELECT adw_id, ${adwName}, request, status, engineer, started_at, ended_at,
                  total_tokens, total_cost, ${archived}
             FROM sessions WHERE adw_id = ?`,
          adwId,
        );
        if (!row) return null;

        const phases = database.all<PhaseRow>(
          `SELECT phase_id, adw_id, seq, name, kind, owner, description, status,
                  attempt, retries, error, started_at, ended_at
             FROM phases WHERE adw_id = ? ORDER BY seq, rowid`,
          adwId,
        );
        const cursor = Math.max(0, Math.trunc(after ?? 0));
        const events = database.all<EventRow>(
          `SELECT rowid, event_id, adw_id, phase_id, parent_id, type, name,
                  payload_json, tokens, started_at, ended_at
             FROM events WHERE adw_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
          adwId,
          cursor,
          EVENT_PAGE_LIMIT,
        );
        const envelopes = database.all<EnvelopeRow>(
          `SELECT envelope_id, adw_id, phase_id, agent, output_type, payload_json,
                  valid, attempt, created_at
             FROM envelopes WHERE adw_id = ? ORDER BY created_at, rowid`,
          adwId,
        );
        const checks = reader.optionalColumn(database, "gate_results", "checks_json");
        const gates = database.all<GateRow>(
          `SELECT id, adw_id, phase_id, attempt, gate, passed, violations_json,
                  ${checks}, created_at
             FROM gate_results WHERE adw_id = ? ORDER BY id`,
          adwId,
        );

        return {
          session: toSession(row),
          usage: readUsage(database, adwId),
          phases: phases.map(toPhase),
          agents: readAgents(database, [adwId]),
          events: events.map(toEvent),
          envelopes: envelopes.map(toEnvelope),
          gates: gates.map(toGateResult),
          // The highest rowid seen, or the cursor we were given when the page was
          // empty, so it can be fed straight back in.
          cursor: events.at(-1)?.rowid ?? cursor,
        };
      });
    });

  return {
    status,
    listSessions,
    readSession,
  } satisfies FactoryTraceSourceShape;
});

export const SssfTraceSourceLive = Layer.effect(FactoryTraceSource, makeSssfTraceSource);

/** Exported for tests and for tooling that needs the conventional location. */
export const traceDatabasePathFor = (workspacePath: string): string =>
  resolveTraceDatabasePath(workspacePath);

/** The data directory a trace sits in, where the ADW keeps its session files. */
export const traceDataDirectoryFor = (databasePath: string): string => dirname(databasePath);
