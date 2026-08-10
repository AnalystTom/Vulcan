/**
 * The long-running controller: the thing that actually makes runs progress.
 *
 * It is a poller rather than an event chain on purpose. A run advances because
 * the world changed -- a command finished, a target went offline, a person
 * answered, a revision moved -- and several of those produce no event this
 * process would see. Polling means a run created by another client, or one left
 * mid-flight by a crash, is picked up on the next tick with no cross-process
 * signalling and no reconciliation protocol.
 *
 * Every tick rebuilds each active run's snapshot from storage and asks the
 * kernel what to do. The controller holds no run state between ticks, so a
 * restart mid-run is indistinguishable from a slow tick.
 */
import type {
  ExecutionTarget,
  GitRevision,
  ProjectId,
  ThreadId,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunId,
  WorkItemId,
  WorkspaceId,
} from "@vulcan/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

import type { FactoryStoreError } from "../../persistence/Services/FactoryStore.ts";

export class FactoryRunError extends Schema.TaggedErrorClass<FactoryRunError>()("FactoryRunError", {
  message: Schema.String,
}) {}

export type FactoryRunnerError = FactoryStoreError | FactoryRunError;

export interface StartRunInput {
  readonly definition: WorkflowDefinition;
  readonly workItemId: WorkItemId;
  readonly workspaceId: WorkspaceId | null;
  readonly projectId: ProjectId | null;
  /**
   * The thread whose workspace the run executes in. Required, because a run
   * without one has nowhere to produce evidence -- the path is derived from the
   * thread rather than supplied, so a handoff to a worktree moves the run too.
   */
  readonly threadId: ThreadId;
}

/** What one tick did, so the caller can log or test it without reading the database. */
export interface TickReport {
  readonly runsExamined: number;
  readonly nodesDispatched: number;
  readonly stallsDetected: number;
  readonly attentionItemsRaised: number;
  readonly leasesReclaimed: number;
}

export interface FactoryRunnerShape {
  /**
   * Persist a definition and open a run against it, pinned to the workspace's
   * current revision. Does not execute anything -- the next tick does.
   */
  readonly startRun: (input: StartRunInput) => Effect.Effect<WorkflowRun, FactoryRunnerError>;

  /**
   * One supervision pass over every active run. Idempotent: ticking twice with
   * nothing changed does nothing the second time.
   */
  readonly tick: () => Effect.Effect<TickReport, FactoryRunnerError>;

  /** Where a run executes. Held here because the definition does not carry it. */
  readonly readWorkspacePath: (
    runId: WorkflowRunId,
  ) => Effect.Effect<string | null, FactoryRunnerError>;

  /**
   * The capabilities this server can actually provide, registered as a local
   * Execution Target. Reported, never inferred.
   */
  readonly localTarget: () => Effect.Effect<ExecutionTarget, FactoryRunnerError>;

  /** Revision the workspace is at now, or null when it is not a git checkout. */
  readonly readWorkspaceRevision: (
    workspacePath: string,
  ) => Effect.Effect<GitRevision | null, FactoryRunnerError>;

  /**
   * Start ticking on an interval for the lifetime of the enclosing scope.
   *
   * A failing tick is logged and the loop continues: one bad run must not stop
   * the controller supervising every other run.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class FactoryRunner extends ServiceMap.Service<FactoryRunner, FactoryRunnerShape>()(
  "vulcan/factory/Services/FactoryRunner/FactoryRunner",
) {}
