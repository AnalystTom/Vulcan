/**
 * Durable per-Workspace Pane layouts.
 *
 * This service owns storage only. It never invents a layout, never repairs one
 * beyond the normalization every layout goes through, and never touches the
 * sessions a Pane is attached to -- persisting a layout must never be able to
 * start or stop an Agent Session or a terminal.
 *
 * Writes are optimistically concurrent. A caller supplies the revision it read,
 * and a write whose revision no longer matches the stored row is rejected with
 * `WorkspaceLayoutConflictError` carrying the current layout, so the caller can
 * rebase rather than overwrite. The desktop app, a paired mobile client, and the
 * controller can all hold the same Workspace open, and last-write-wins would
 * silently discard whichever client blinked.
 */
import {
  NonNegativeInt,
  ProjectId,
  StoredWorkspaceLayout,
  ThreadId,
  WorkspaceId,
  WorkspaceLayout,
} from "@vulcan/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export class WorkspaceLayoutConflictError extends Schema.TaggedErrorClass<WorkspaceLayoutConflictError>()(
  "WorkspaceLayoutConflictError",
  {
    workspaceId: WorkspaceId,
    expectedRevision: NonNegativeInt,
    actualRevision: NonNegativeInt,
    current: WorkspaceLayout,
  },
) {
  override get message(): string {
    return `Workspace ${this.workspaceId} layout moved to revision ${this.actualRevision} while a client held ${this.expectedRevision}.`;
  }
}

export class WorkspaceLayoutNotFoundError extends Schema.TaggedErrorClass<WorkspaceLayoutNotFoundError>()(
  "WorkspaceLayoutNotFoundError",
  { workspaceId: WorkspaceId },
) {
  override get message(): string {
    return `No layout is stored for workspace ${this.workspaceId}.`;
  }
}

export type WorkspaceLayoutsError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | WorkspaceLayoutConflictError
  | WorkspaceLayoutNotFoundError;

export const UpsertWorkspaceLayoutInput = Schema.Struct({
  layout: WorkspaceLayout,
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  /**
   * The revision the caller believed was current. `null` means "create only" --
   * the write succeeds solely if no layout exists yet, which is how a Workspace
   * is opened for the first time without two clients racing to seed it.
   */
  expectedRevision: Schema.NullOr(NonNegativeInt),
});
export type UpsertWorkspaceLayoutInput = typeof UpsertWorkspaceLayoutInput.Type;

export interface WorkspaceLayoutsShape {
  /** The stored layout for a Workspace, or null when it has never been opened. */
  readonly read: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<StoredWorkspaceLayout | null, WorkspaceLayoutsError>;

  /** Every Workspace belonging to a project, most recently updated first. */
  readonly listByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<StoredWorkspaceLayout>, WorkspaceLayoutsError>;

  /**
   * Store a layout, conditional on `expectedRevision` still being current.
   * Returns what was stored so callers observe the canonical normalized value
   * rather than the one they sent.
   */
  readonly upsert: (
    input: UpsertWorkspaceLayoutInput,
  ) => Effect.Effect<StoredWorkspaceLayout, WorkspaceLayoutsError>;

  /**
   * Forget a Workspace's layout. Layout only: whatever its Panes were attached
   * to is the caller's to shut down, deliberately, somewhere else.
   */
  readonly remove: (workspaceId: WorkspaceId) => Effect.Effect<void, WorkspaceLayoutsError>;
}

export class WorkspaceLayouts extends ServiceMap.Service<WorkspaceLayouts, WorkspaceLayoutsShape>()(
  "vulcan/persistence/Services/WorkspaceLayouts/WorkspaceLayouts",
) {}
