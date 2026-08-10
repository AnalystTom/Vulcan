/**
 * Durable storage for the Software Factory.
 *
 * The one operation everything else is built on is `readRunSnapshot`: it
 * reassembles the exact `RunSnapshot` value the kernel takes, so a controller
 * that restarts resumes from storage with no in-memory state to lose. Every other
 * method exists to keep that snapshot true.
 *
 * This service stores; it never decides. It does not derive run state, does not
 * evaluate gates, and does not choose what runs next -- those are the kernel's,
 * and duplicating them here would let storage and logic disagree about whether a
 * run is finished.
 */
import type {
  Artifact,
  AttentionItem,
  AttentionItemId,
  ExecutionTarget,
  GateResult,
  GitRevision,
  NodeAttempt,
  NodeAttemptId,
  RecoveryRung,
  TargetLease,
  WorkflowDefinition,
  WorkflowDefinitionId,
  WorkflowRun,
  WorkflowRunId,
  WorkflowRunState,
} from "@vulcan/contracts";
import type { RunSnapshot } from "@vulcan/shared/factoryKernel";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type FactoryStoreError = PersistenceSqlError | PersistenceDecodeError;

/** A run plus the definition version it is pinned to. */
export interface StoredRun {
  readonly run: WorkflowRun;
  readonly definition: WorkflowDefinition;
  readonly currentRevision: GitRevision;
}

export interface FactoryStoreShape {
  /**
   * Store a definition version. Idempotent by (id, version): re-storing the same
   * version is a no-op rather than an overwrite, because a definition a run is
   * pinned to must never change underneath it.
   */
  readonly putDefinition: (
    definition: WorkflowDefinition,
  ) => Effect.Effect<void, FactoryStoreError>;

  readonly readDefinition: (
    definitionId: WorkflowDefinitionId,
    version: number,
  ) => Effect.Effect<WorkflowDefinition | null, FactoryStoreError>;

  readonly listDefinitions: () => Effect.Effect<
    ReadonlyArray<WorkflowDefinition>,
    FactoryStoreError
  >;

  readonly createRun: (run: WorkflowRun) => Effect.Effect<void, FactoryStoreError>;

  readonly readRun: (runId: WorkflowRunId) => Effect.Effect<StoredRun | null, FactoryStoreError>;

  /**
   * Runs the controller should still be working on. Deliberately a query rather
   * than a cached set, so a run created by another client is picked up on the
   * next tick without any cross-process signalling.
   */
  readonly listActiveRuns: () => Effect.Effect<ReadonlyArray<StoredRun>, FactoryStoreError>;

  readonly setRunState: (input: {
    readonly runId: WorkflowRunId;
    readonly state: WorkflowRunState;
    readonly endedAt: string | null;
  }) => Effect.Effect<void, FactoryStoreError>;

  /**
   * Record where the workspace is now. Moving this is what invalidates
   * verification evidence, so it is a deliberate write and never a side effect of
   * storing an artifact.
   */
  readonly setRunRevision: (input: {
    readonly runId: WorkflowRunId;
    readonly revision: GitRevision;
  }) => Effect.Effect<void, FactoryStoreError>;

  /** Insert or update an attempt. Attempts are identified by their own id. */
  readonly putAttempt: (input: {
    readonly attempt: NodeAttempt;
    readonly attemptedRecovery: readonly RecoveryRung[];
  }) => Effect.Effect<void, FactoryStoreError>;

  /** Recovery rungs already spent for a node, so the ladder survives a restart. */
  readonly readAttemptedRecovery: (
    attemptId: NodeAttemptId,
  ) => Effect.Effect<ReadonlyArray<RecoveryRung>, FactoryStoreError>;

  /** Proof of life from a target or provider. Not proof of progress. */
  readonly recordHeartbeat: (input: {
    readonly attemptId: NodeAttemptId;
    readonly at: string;
  }) => Effect.Effect<void, FactoryStoreError>;

  /** Attempts in flight across every run, for the stall sweep. */
  readonly listActiveAttempts: () => Effect.Effect<ReadonlyArray<NodeAttempt>, FactoryStoreError>;

  readonly appendArtifacts: (input: {
    readonly runId: WorkflowRunId;
    readonly artifacts: readonly Artifact[];
  }) => Effect.Effect<void, FactoryStoreError>;

  /**
   * Store a verdict. One row per gate per revision, so re-judging at the same
   * revision replaces the verdict while a new revision keeps the old one for
   * audit.
   */
  readonly putGateResult: (result: GateResult) => Effect.Effect<void, FactoryStoreError>;

  /**
   * The exact value the kernel consumes, rebuilt from storage.
   * Returns null when the run does not exist.
   */
  readonly readRunSnapshot: (
    runId: WorkflowRunId,
  ) => Effect.Effect<RunSnapshot | null, FactoryStoreError>;

  readonly createAttentionItem: (item: AttentionItem) => Effect.Effect<void, FactoryStoreError>;

  readonly listOpenAttentionItems: (input?: {
    readonly runId?: WorkflowRunId;
  }) => Effect.Effect<ReadonlyArray<AttentionItem>, FactoryStoreError>;

  readonly resolveAttentionItem: (input: {
    readonly attentionItemId: AttentionItemId;
    readonly resolution: string;
    readonly at: string;
  }) => Effect.Effect<void, FactoryStoreError>;

  readonly putTarget: (target: ExecutionTarget) => Effect.Effect<void, FactoryStoreError>;

  readonly listTargets: () => Effect.Effect<ReadonlyArray<ExecutionTarget>, FactoryStoreError>;

  readonly acquireLease: (lease: TargetLease) => Effect.Effect<void, FactoryStoreError>;

  readonly releaseLease: (attemptId: NodeAttemptId) => Effect.Effect<void, FactoryStoreError>;

  /**
   * Leases that outlived their deadline. Reclaimed rather than trusted: a target
   * whose worker died must not stay reserved by an attempt nobody can reach.
   */
  readonly listExpiredLeases: (
    now: string,
  ) => Effect.Effect<ReadonlyArray<TargetLease>, FactoryStoreError>;

  readonly listLeases: () => Effect.Effect<ReadonlyArray<TargetLease>, FactoryStoreError>;
}

export class FactoryStore extends ServiceMap.Service<FactoryStore, FactoryStoreShape>()(
  "vulcan/persistence/Services/FactoryStore/FactoryStore",
) {}
