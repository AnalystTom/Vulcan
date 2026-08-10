import {
  type Artifact,
  ArtifactId,
  type AttentionItem,
  AttentionItemId,
  type ExecutionTarget,
  ExecutionTargetId,
  type GateResult,
  GitRevision,
  IsoDateTime,
  type NodeAttempt,
  NodeAttemptId,
  PositiveInt,
  ProjectId,
  type RecoveryRung,
  type TargetLease,
  ThreadId,
  TrimmedNonEmptyString,
  type WorkflowDefinition,
  WorkflowDefinitionId,
  WorkflowNode,
  WorkflowNodeId,
  type WorkflowRun,
  WorkflowRunId,
  WorkItemId,
  WorkspaceId,
  FactoryPolicy,
  GateCheckResult,
  NodeAttemptState,
  RecoveryRung as RecoveryRungSchema,
  TargetCapability,
  WaitingReason,
  WorkflowRunState,
} from "@vulcan/contracts";
import type { RunSnapshot } from "@vulcan/shared/factoryKernel";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import { FactoryStore, type FactoryStoreShape, type StoredRun } from "../Services/FactoryStore.ts";

// SQLite has no boolean, so every flag round-trips through 0/1 at exactly one
// place rather than being re-derived at each call site.
const fromSqlBoolean = (value: number): boolean => value === 1;
const toSqlBoolean = (value: boolean): number => (value ? 1 : 0);

const DefinitionRow = Schema.Struct({
  definitionId: WorkflowDefinitionId,
  version: PositiveInt,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  source: Schema.String,
  nodes: Schema.fromJsonString(Schema.Array(WorkflowNode)),
  policy: Schema.fromJsonString(FactoryPolicy),
});

const RunRow = Schema.Struct({
  runId: WorkflowRunId,
  definitionId: WorkflowDefinitionId,
  definitionVersion: PositiveInt,
  workItemId: WorkItemId,
  workspaceId: Schema.NullOr(WorkspaceId),
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  baseRevision: GitRevision,
  currentRevision: GitRevision,
  policyVersion: PositiveInt,
  state: WorkflowRunState,
  createdAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});

const AttemptRow = Schema.Struct({
  id: NodeAttemptId,
  runId: WorkflowRunId,
  nodeId: WorkflowNodeId,
  attemptNumber: PositiveInt,
  state: NodeAttemptState,
  waitingReason: Schema.NullOr(WaitingReason),
  targetId: Schema.NullOr(ExecutionTargetId),
  revision: Schema.NullOr(GitRevision),
  startedAt: Schema.NullOr(IsoDateTime),
  lastHeartbeatAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  failureSummary: Schema.NullOr(Schema.String),
});

const RecoveryRow = Schema.Struct({
  attemptedRecovery: Schema.fromJsonString(Schema.Array(RecoveryRungSchema)),
});

const ArtifactRow = Schema.Struct({
  id: ArtifactId,
  kind: TrimmedNonEmptyString,
  producedByNodeId: WorkflowNodeId,
  producedByAttemptId: NodeAttemptId,
  revision: GitRevision,
  createdAt: IsoDateTime,
  outcome: Schema.Literals(["passed", "failed", "informational"]),
  uri: Schema.NullOr(TrimmedNonEmptyString),
  summary: Schema.String,
});

const GateResultRow = Schema.Struct({
  runId: WorkflowRunId,
  nodeId: WorkflowNodeId,
  revision: GitRevision,
  passedFlag: Schema.Number,
  policyVersion: PositiveInt,
  checks: Schema.fromJsonString(Schema.Array(GateCheckResult)),
  evaluatedAt: IsoDateTime,
});

const AttentionRow = Schema.Struct({
  id: AttentionItemId,
  runId: WorkflowRunId,
  nodeId: Schema.NullOr(WorkflowNodeId),
  attemptId: Schema.NullOr(NodeAttemptId),
  request: TrimmedNonEmptyString,
  reason: Schema.Union([WaitingReason, Schema.Literal("recovery-exhausted")]),
  attemptedRecovery: Schema.fromJsonString(Schema.Array(RecoveryRungSchema)),
  workspaceId: Schema.NullOr(WorkspaceId),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});

const TargetRow = Schema.Struct({
  id: ExecutionTargetId,
  label: TrimmedNonEmptyString,
  capabilities: Schema.fromJsonString(Schema.Array(TargetCapability)),
  maxConcurrentLeases: PositiveInt,
  onlineFlag: Schema.Number,
  lastSeenAt: Schema.NullOr(IsoDateTime),
});

const LeaseRow = Schema.Struct({
  attemptId: NodeAttemptId,
  targetId: ExecutionTargetId,
  runId: WorkflowRunId,
  acquiredAt: IsoDateTime,
  expiresAt: IsoDateTime,
});

const toDefinition = (row: typeof DefinitionRow.Type): WorkflowDefinition => ({
  id: row.definitionId,
  version: row.version,
  name: row.name,
  description: row.description,
  nodes: row.nodes,
  policy: row.policy,
  source: row.source,
});

const toRun = (row: typeof RunRow.Type): WorkflowRun => ({
  id: row.runId,
  definitionId: row.definitionId,
  definitionVersion: row.definitionVersion,
  workItemId: row.workItemId,
  workspaceId: row.workspaceId,
  projectId: row.projectId,
  threadId: row.threadId,
  baseRevision: row.baseRevision,
  policyVersion: row.policyVersion,
  state: row.state,
  createdAt: row.createdAt,
  endedAt: row.endedAt,
});

const toAttempt = (row: typeof AttemptRow.Type): NodeAttempt => ({ ...row });

const toArtifact = (row: typeof ArtifactRow.Type): Artifact => ({ ...row });

const toGateResult = (row: typeof GateResultRow.Type): GateResult => ({
  nodeId: row.nodeId,
  runId: row.runId,
  passed: fromSqlBoolean(row.passedFlag),
  revision: row.revision,
  policyVersion: row.policyVersion,
  checks: row.checks,
  evaluatedAt: row.evaluatedAt,
});

const toAttentionItem = (row: typeof AttentionRow.Type): AttentionItem => ({ ...row });

const toLease = (row: typeof LeaseRow.Type): TargetLease => ({ ...row });

const makeFactoryStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const fail = (operation: string) =>
    toPersistenceSqlOrDecodeError(
      `FactoryStore.${operation}:query`,
      `FactoryStore.${operation}:decodeRows`,
    );

  const definitionColumns = sql`
    definition_id AS "definitionId",
    version AS "version",
    name AS "name",
    description AS "description",
    source AS "source",
    nodes_json AS "nodes",
    policy_json AS "policy"
  `;

  const runColumns = sql`
    run_id AS "runId",
    definition_id AS "definitionId",
    definition_version AS "definitionVersion",
    work_item_id AS "workItemId",
    workspace_id AS "workspaceId",
    project_id AS "projectId",
    thread_id AS "threadId",
    base_revision AS "baseRevision",
    current_revision AS "currentRevision",
    policy_version AS "policyVersion",
    state AS "state",
    created_at AS "createdAt",
    ended_at AS "endedAt"
  `;

  const attemptColumns = sql`
    attempt_id AS "id",
    run_id AS "runId",
    node_id AS "nodeId",
    attempt_number AS "attemptNumber",
    state AS "state",
    waiting_reason AS "waitingReason",
    target_id AS "targetId",
    revision AS "revision",
    started_at AS "startedAt",
    last_heartbeat_at AS "lastHeartbeatAt",
    ended_at AS "endedAt",
    failure_summary AS "failureSummary"
  `;

  // --- definitions ---

  const selectDefinition = SqlSchema.findOneOption({
    Request: Schema.Struct({ definitionId: WorkflowDefinitionId, version: PositiveInt }),
    Result: DefinitionRow,
    execute: ({ definitionId, version }) => sql`
      SELECT ${definitionColumns} FROM factory_workflow_definitions
      WHERE definition_id = ${definitionId} AND version = ${version}
    `,
  });

  const selectLatestDefinitions = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: DefinitionRow,
    execute: () => sql`
      SELECT ${definitionColumns} FROM factory_workflow_definitions
      ORDER BY definition_id ASC, version DESC
    `,
  });

  const putDefinition: FactoryStoreShape["putDefinition"] = (definition) =>
    sql`
      INSERT INTO factory_workflow_definitions (
        definition_id, version, name, description, source, nodes_json, policy_json, created_at
      ) VALUES (
        ${definition.id},
        ${definition.version},
        ${definition.name},
        ${definition.description},
        ${definition.source},
        ${JSON.stringify(definition.nodes)},
        ${JSON.stringify(definition.policy)},
        ${new Date().toISOString()}
      )
      -- A definition version a run is pinned to must never change underneath it.
      ON CONFLICT (definition_id, version) DO NOTHING
    `.pipe(Effect.asVoid, Effect.mapError(fail("putDefinition")));

  const readDefinition: FactoryStoreShape["readDefinition"] = (definitionId, version) =>
    selectDefinition({ definitionId, version }).pipe(
      Effect.map((row) => (Option.isNone(row) ? null : toDefinition(row.value))),
      Effect.mapError(fail("readDefinition")),
    );

  const listDefinitions: FactoryStoreShape["listDefinitions"] = () =>
    selectLatestDefinitions({}).pipe(
      Effect.map((rows) => rows.map(toDefinition)),
      Effect.mapError(fail("listDefinitions")),
    );

  // --- runs ---

  const selectRun = SqlSchema.findOneOption({
    Request: Schema.Struct({ runId: WorkflowRunId }),
    Result: RunRow,
    execute: ({ runId }) => sql`
      SELECT ${runColumns} FROM factory_runs WHERE run_id = ${runId}
    `,
  });

  const selectActiveRuns = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: RunRow,
    execute: () => sql`
      SELECT ${runColumns} FROM factory_runs
      WHERE state IN ('pending', 'running', 'blocked')
      ORDER BY created_at ASC
    `,
  });

  const hydrateRun = (row: typeof RunRow.Type) =>
    readDefinition(row.definitionId, row.definitionVersion).pipe(
      Effect.map((definition): StoredRun | null =>
        definition === null
          ? null
          : { run: toRun(row), definition, currentRevision: row.currentRevision },
      ),
    );

  const createRun: FactoryStoreShape["createRun"] = (run) =>
    sql`
      INSERT INTO factory_runs (
        run_id, definition_id, definition_version, work_item_id, workspace_id, project_id,
        thread_id, base_revision, current_revision, policy_version, state, created_at, ended_at
      ) VALUES (
        ${run.id}, ${run.definitionId}, ${run.definitionVersion}, ${run.workItemId},
        ${run.workspaceId}, ${run.projectId}, ${run.threadId}, ${run.baseRevision},
        ${run.baseRevision}, ${run.policyVersion}, ${run.state}, ${run.createdAt}, ${run.endedAt}
      )
    `.pipe(Effect.asVoid, Effect.mapError(fail("createRun")));

  const readRun: FactoryStoreShape["readRun"] = (runId) =>
    selectRun({ runId }).pipe(
      Effect.mapError(fail("readRun")),
      Effect.flatMap((row) => (Option.isNone(row) ? Effect.succeed(null) : hydrateRun(row.value))),
    );

  const listActiveRuns: FactoryStoreShape["listActiveRuns"] = () =>
    selectActiveRuns({}).pipe(
      Effect.mapError(fail("listActiveRuns")),
      Effect.flatMap((rows) => Effect.forEach(rows, hydrateRun)),
      // A run whose definition version is missing cannot be scheduled; dropping it
      // here keeps the controller from crashing on data it cannot act on.
      Effect.map((runs) => runs.filter((run): run is StoredRun => run !== null)),
    );

  const setRunState: FactoryStoreShape["setRunState"] = ({ runId, state, endedAt }) =>
    sql`
      UPDATE factory_runs SET state = ${state}, ended_at = ${endedAt} WHERE run_id = ${runId}
    `.pipe(Effect.asVoid, Effect.mapError(fail("setRunState")));

  const setRunRevision: FactoryStoreShape["setRunRevision"] = ({ runId, revision }) =>
    sql`
      UPDATE factory_runs SET current_revision = ${revision} WHERE run_id = ${runId}
    `.pipe(Effect.asVoid, Effect.mapError(fail("setRunRevision")));

  // --- attempts ---

  const selectAttempts = SqlSchema.findAll({
    Request: Schema.Struct({ runId: WorkflowRunId }),
    Result: AttemptRow,
    execute: ({ runId }) => sql`
      SELECT ${attemptColumns} FROM factory_node_attempts
      WHERE run_id = ${runId}
      ORDER BY node_id ASC, attempt_number ASC
    `,
  });

  const selectActiveAttempts = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: AttemptRow,
    execute: () => sql`
      SELECT ${attemptColumns} FROM factory_node_attempts
      WHERE state IN (
        'provisioning', 'ready', 'running', 'waiting-external',
        'waiting-agent', 'waiting-human', 'retrying', 'verifying'
      )
      ORDER BY started_at ASC
    `,
  });

  const selectRecovery = SqlSchema.findOneOption({
    Request: Schema.Struct({ attemptId: NodeAttemptId }),
    Result: RecoveryRow,
    execute: ({ attemptId }) => sql`
      SELECT attempted_recovery_json AS "attemptedRecovery"
      FROM factory_node_attempts WHERE attempt_id = ${attemptId}
    `,
  });

  const putAttempt: FactoryStoreShape["putAttempt"] = ({ attempt, attemptedRecovery }) =>
    sql`
      INSERT INTO factory_node_attempts (
        attempt_id, run_id, node_id, attempt_number, state, waiting_reason, target_id,
        revision, started_at, last_heartbeat_at, ended_at, failure_summary,
        attempted_recovery_json
      ) VALUES (
        ${attempt.id}, ${attempt.runId}, ${attempt.nodeId}, ${attempt.attemptNumber},
        ${attempt.state}, ${attempt.waitingReason}, ${attempt.targetId}, ${attempt.revision},
        ${attempt.startedAt}, ${attempt.lastHeartbeatAt}, ${attempt.endedAt},
        ${attempt.failureSummary}, ${JSON.stringify(attemptedRecovery)}
      )
      ON CONFLICT (attempt_id) DO UPDATE SET
        state = excluded.state,
        waiting_reason = excluded.waiting_reason,
        target_id = excluded.target_id,
        revision = excluded.revision,
        started_at = excluded.started_at,
        last_heartbeat_at = excluded.last_heartbeat_at,
        ended_at = excluded.ended_at,
        failure_summary = excluded.failure_summary,
        attempted_recovery_json = excluded.attempted_recovery_json
    `.pipe(Effect.asVoid, Effect.mapError(fail("putAttempt")));

  const readAttemptedRecovery: FactoryStoreShape["readAttemptedRecovery"] = (attemptId) =>
    selectRecovery({ attemptId }).pipe(
      Effect.map((row): readonly RecoveryRung[] =>
        Option.isNone(row) ? [] : row.value.attemptedRecovery,
      ),
      Effect.mapError(fail("readAttemptedRecovery")),
    );

  const recordHeartbeat: FactoryStoreShape["recordHeartbeat"] = ({ attemptId, at }) =>
    sql`
      UPDATE factory_node_attempts SET last_heartbeat_at = ${at} WHERE attempt_id = ${attemptId}
    `.pipe(Effect.asVoid, Effect.mapError(fail("recordHeartbeat")));

  const listActiveAttempts: FactoryStoreShape["listActiveAttempts"] = () =>
    selectActiveAttempts({}).pipe(
      Effect.map((rows) => rows.map(toAttempt)),
      Effect.mapError(fail("listActiveAttempts")),
    );

  // --- artifacts and gates ---

  const selectArtifacts = SqlSchema.findAll({
    Request: Schema.Struct({ runId: WorkflowRunId }),
    Result: ArtifactRow,
    execute: ({ runId }) => sql`
      SELECT
        artifact_id AS "id",
        kind AS "kind",
        produced_by_node_id AS "producedByNodeId",
        produced_by_attempt_id AS "producedByAttemptId",
        revision AS "revision",
        created_at AS "createdAt",
        outcome AS "outcome",
        uri AS "uri",
        summary AS "summary"
      FROM factory_artifacts WHERE run_id = ${runId}
      ORDER BY created_at ASC, artifact_id ASC
    `,
  });

  const appendArtifacts: FactoryStoreShape["appendArtifacts"] = ({ runId, artifacts }) => {
    if (artifacts.length === 0) return Effect.void;
    return Effect.forEach(
      artifacts,
      (artifact: Artifact) => sql`
        INSERT INTO factory_artifacts (
          artifact_id, run_id, kind, produced_by_node_id, produced_by_attempt_id,
          revision, outcome, uri, summary, created_at
        ) VALUES (
          ${artifact.id}, ${runId}, ${artifact.kind}, ${artifact.producedByNodeId},
          ${artifact.producedByAttemptId}, ${artifact.revision}, ${artifact.outcome},
          ${artifact.uri}, ${artifact.summary}, ${artifact.createdAt}
        )
        -- Artifacts are immutable, so a replayed append is a no-op.
        ON CONFLICT (artifact_id) DO NOTHING
      `,
    ).pipe(Effect.asVoid, Effect.mapError(fail("appendArtifacts")));
  };

  const selectGateResults = SqlSchema.findAll({
    Request: Schema.Struct({ runId: WorkflowRunId }),
    Result: GateResultRow,
    execute: ({ runId }) => sql`
      SELECT
        run_id AS "runId",
        node_id AS "nodeId",
        revision AS "revision",
        passed AS "passedFlag",
        policy_version AS "policyVersion",
        checks_json AS "checks",
        evaluated_at AS "evaluatedAt"
      FROM factory_gate_results WHERE run_id = ${runId}
      ORDER BY evaluated_at ASC
    `,
  });

  const putGateResult: FactoryStoreShape["putGateResult"] = (result) =>
    sql`
      INSERT INTO factory_gate_results (
        run_id, node_id, revision, passed, policy_version, checks_json, evaluated_at
      ) VALUES (
        ${result.runId}, ${result.nodeId}, ${result.revision}, ${toSqlBoolean(result.passed)},
        ${result.policyVersion}, ${JSON.stringify(result.checks)}, ${result.evaluatedAt}
      )
      ON CONFLICT (run_id, node_id, revision) DO UPDATE SET
        passed = excluded.passed,
        policy_version = excluded.policy_version,
        checks_json = excluded.checks_json,
        evaluated_at = excluded.evaluated_at
    `.pipe(Effect.asVoid, Effect.mapError(fail("putGateResult")));

  /**
   * Rebuild the kernel's input from storage.
   *
   * Everything the kernel needs and nothing it does not: the pinned definition,
   * every attempt, every artifact, every gate verdict, and where the workspace is
   * now. A controller that restarts calls this and continues.
   */
  const readRunSnapshot: FactoryStoreShape["readRunSnapshot"] = (runId) =>
    Effect.gen(function* () {
      const stored = yield* readRun(runId);
      if (stored === null) return null;

      const [attempts, artifacts, gateRows] = yield* Effect.all([
        selectAttempts({ runId }).pipe(Effect.mapError(fail("readRunSnapshot"))),
        selectArtifacts({ runId }).pipe(Effect.mapError(fail("readRunSnapshot"))),
        selectGateResults({ runId }).pipe(Effect.mapError(fail("readRunSnapshot"))),
      ]);

      return {
        definition: stored.definition,
        attempts: attempts.map(toAttempt),
        artifacts: artifacts.map(toArtifact),
        gateResults: gateRows.map(toGateResult),
        currentRevision: stored.currentRevision,
      } satisfies RunSnapshot;
    });

  // --- attention ---

  const attentionColumns = sql`
    attention_item_id AS "id",
    run_id AS "runId",
    node_id AS "nodeId",
    attempt_id AS "attemptId",
    request AS "request",
    reason AS "reason",
    attempted_recovery_json AS "attemptedRecovery",
    workspace_id AS "workspaceId",
    created_at AS "createdAt",
    resolved_at AS "resolvedAt"
  `;

  const selectOpenAttention = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: AttentionRow,
    execute: () => sql`
      SELECT ${attentionColumns} FROM factory_attention_items
      WHERE resolved_at IS NULL ORDER BY created_at ASC
    `,
  });

  const selectOpenAttentionForRun = SqlSchema.findAll({
    Request: Schema.Struct({ runId: WorkflowRunId }),
    Result: AttentionRow,
    execute: ({ runId }) => sql`
      SELECT ${attentionColumns} FROM factory_attention_items
      WHERE resolved_at IS NULL AND run_id = ${runId} ORDER BY created_at ASC
    `,
  });

  const createAttentionItem: FactoryStoreShape["createAttentionItem"] = (item) =>
    sql`
      INSERT INTO factory_attention_items (
        attention_item_id, run_id, node_id, attempt_id, request, reason,
        attempted_recovery_json, workspace_id, created_at, resolved_at, resolution
      ) VALUES (
        ${item.id}, ${item.runId}, ${item.nodeId}, ${item.attemptId}, ${item.request},
        ${item.reason}, ${JSON.stringify(item.attemptedRecovery)}, ${item.workspaceId},
        ${item.createdAt}, ${item.resolvedAt}, ${null}
      )
      ON CONFLICT (attention_item_id) DO NOTHING
    `.pipe(Effect.asVoid, Effect.mapError(fail("createAttentionItem")));

  const listOpenAttentionItems: FactoryStoreShape["listOpenAttentionItems"] = (input) =>
    (input?.runId === undefined
      ? selectOpenAttention({})
      : selectOpenAttentionForRun({ runId: input.runId })
    ).pipe(
      Effect.map((rows) => rows.map(toAttentionItem)),
      Effect.mapError(fail("listOpenAttentionItems")),
    );

  const resolveAttentionItem: FactoryStoreShape["resolveAttentionItem"] = ({
    attentionItemId,
    resolution,
    at,
  }) =>
    sql`
      UPDATE factory_attention_items
      SET resolved_at = ${at}, resolution = ${resolution}
      WHERE attention_item_id = ${attentionItemId} AND resolved_at IS NULL
    `.pipe(Effect.asVoid, Effect.mapError(fail("resolveAttentionItem")));

  // --- targets and leases ---

  const selectTargets = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: TargetRow,
    execute: () => sql`
      SELECT
        target_id AS "id",
        label AS "label",
        capabilities_json AS "capabilities",
        max_concurrent_leases AS "maxConcurrentLeases",
        online AS "onlineFlag",
        last_seen_at AS "lastSeenAt"
      FROM factory_execution_targets ORDER BY target_id ASC
    `,
  });

  const leaseColumns = sql`
    attempt_id AS "attemptId",
    target_id AS "targetId",
    run_id AS "runId",
    acquired_at AS "acquiredAt",
    expires_at AS "expiresAt"
  `;

  const selectLeases = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: LeaseRow,
    execute: () => sql`SELECT ${leaseColumns} FROM factory_target_leases`,
  });

  const selectExpiredLeases = SqlSchema.findAll({
    Request: Schema.Struct({ now: IsoDateTime }),
    Result: LeaseRow,
    execute: ({ now }) => sql`
      SELECT ${leaseColumns} FROM factory_target_leases WHERE expires_at < ${now}
    `,
  });

  const putTarget: FactoryStoreShape["putTarget"] = (target) =>
    sql`
      INSERT INTO factory_execution_targets (
        target_id, label, capabilities_json, max_concurrent_leases, online, last_seen_at
      ) VALUES (
        ${target.id}, ${target.label}, ${JSON.stringify(target.capabilities)},
        ${target.maxConcurrentLeases}, ${toSqlBoolean(target.online)}, ${target.lastSeenAt}
      )
      ON CONFLICT (target_id) DO UPDATE SET
        label = excluded.label,
        capabilities_json = excluded.capabilities_json,
        max_concurrent_leases = excluded.max_concurrent_leases,
        online = excluded.online,
        last_seen_at = excluded.last_seen_at
    `.pipe(Effect.asVoid, Effect.mapError(fail("putTarget")));

  const listTargets: FactoryStoreShape["listTargets"] = () =>
    selectTargets({}).pipe(
      Effect.map((rows) =>
        rows.map(
          (row): ExecutionTarget => ({
            id: row.id,
            label: row.label,
            capabilities: row.capabilities,
            maxConcurrentLeases: row.maxConcurrentLeases,
            online: fromSqlBoolean(row.onlineFlag),
            lastSeenAt: row.lastSeenAt,
          }),
        ),
      ),
      Effect.mapError(fail("listTargets")),
    );

  const acquireLease: FactoryStoreShape["acquireLease"] = (lease) =>
    sql`
      INSERT INTO factory_target_leases (attempt_id, target_id, run_id, acquired_at, expires_at)
      VALUES (${lease.attemptId}, ${lease.targetId}, ${lease.runId}, ${lease.acquiredAt},
              ${lease.expiresAt})
      ON CONFLICT (attempt_id) DO UPDATE SET
        target_id = excluded.target_id,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
    `.pipe(Effect.asVoid, Effect.mapError(fail("acquireLease")));

  const releaseLease: FactoryStoreShape["releaseLease"] = (attemptId) =>
    sql`DELETE FROM factory_target_leases WHERE attempt_id = ${attemptId}`.pipe(
      Effect.asVoid,
      Effect.mapError(fail("releaseLease")),
    );

  const listExpiredLeases: FactoryStoreShape["listExpiredLeases"] = (now) =>
    selectExpiredLeases({ now }).pipe(
      Effect.map((rows) => rows.map(toLease)),
      Effect.mapError(fail("listExpiredLeases")),
    );

  const listLeases: FactoryStoreShape["listLeases"] = () =>
    selectLeases({}).pipe(
      Effect.map((rows) => rows.map(toLease)),
      Effect.mapError(fail("listLeases")),
    );

  return {
    putDefinition,
    readDefinition,
    listDefinitions,
    createRun,
    readRun,
    listActiveRuns,
    setRunState,
    setRunRevision,
    putAttempt,
    readAttemptedRecovery,
    recordHeartbeat,
    listActiveAttempts,
    appendArtifacts,
    putGateResult,
    readRunSnapshot,
    createAttentionItem,
    listOpenAttentionItems,
    resolveAttentionItem,
    putTarget,
    listTargets,
    acquireLease,
    releaseLease,
    listExpiredLeases,
    listLeases,
  } satisfies FactoryStoreShape;
});

export const FactoryStoreLive = Layer.effect(FactoryStore, makeFactoryStore);
