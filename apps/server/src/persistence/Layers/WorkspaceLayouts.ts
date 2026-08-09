import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  type StoredWorkspaceLayout,
  ThreadId,
  WorkspaceId,
  WorkspaceLayout,
} from "@vulcan/contracts";
import { normalizeWorkspaceLayout } from "@vulcan/shared/workspaceLayout";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  type UpsertWorkspaceLayoutInput,
  WorkspaceLayoutConflictError,
  WorkspaceLayouts,
  type WorkspaceLayoutsError,
  type WorkspaceLayoutsShape,
} from "../Services/WorkspaceLayouts.ts";

/**
 * The stored shape. `layout` decodes straight out of the JSON column, so a row
 * that cannot produce a valid layout surfaces as a decode error rather than as a
 * half-built grid.
 */
const WorkspaceLayoutRow = Schema.Struct({
  layout: Schema.fromJsonString(WorkspaceLayout),
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const RevisionRow = Schema.Struct({ revision: NonNegativeInt });

const makeWorkspaceLayouts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectByWorkspaceId = SqlSchema.findOneOption({
    Request: Schema.Struct({ workspaceId: WorkspaceId }),
    Result: WorkspaceLayoutRow,
    execute: ({ workspaceId }) => sql`
      SELECT
        layout_json AS "layout",
        project_id AS "projectId",
        thread_id AS "threadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM workspace_layouts
      WHERE workspace_id = ${workspaceId}
    `,
  });

  const selectByProjectId = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId }),
    Result: WorkspaceLayoutRow,
    execute: ({ projectId }) => sql`
      SELECT
        layout_json AS "layout",
        project_id AS "projectId",
        thread_id AS "threadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM workspace_layouts
      WHERE project_id = ${projectId}
      ORDER BY updated_at DESC, workspace_id ASC
    `,
  });

  const selectRevision = SqlSchema.findOneOption({
    Request: Schema.Struct({ workspaceId: WorkspaceId }),
    Result: RevisionRow,
    execute: ({ workspaceId }) => sql`
      SELECT revision AS "revision"
      FROM workspace_layouts
      WHERE workspace_id = ${workspaceId}
    `,
  });

  const mapFailure = (operation: string) =>
    toPersistenceSqlOrDecodeError(
      `WorkspaceLayouts.${operation}:query`,
      `WorkspaceLayouts.${operation}:decodeRows`,
    );

  const toStored = (row: typeof WorkspaceLayoutRow.Type): StoredWorkspaceLayout => ({
    // Normalized on the way out as well as in. A row written by an older build,
    // or restored from a backup, still has to render.
    layout: normalizeWorkspaceLayout(row.layout),
    projectId: row.projectId,
    threadId: row.threadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const read: WorkspaceLayoutsShape["read"] = (workspaceId) =>
    selectByWorkspaceId({ workspaceId }).pipe(
      Effect.map((row) => (Option.isNone(row) ? null : toStored(row.value))),
      Effect.mapError(mapFailure("read")),
    );

  const listByProject: WorkspaceLayoutsShape["listByProject"] = (projectId) =>
    selectByProjectId({ projectId }).pipe(
      Effect.map((rows) => rows.map(toStored)),
      Effect.mapError(mapFailure("listByProject")),
    );

  const upsert: WorkspaceLayoutsShape["upsert"] = (input: UpsertWorkspaceLayoutInput) => {
    const layout = normalizeWorkspaceLayout(input.layout);
    const workspaceId = layout.workspaceId;

    // The compare-and-set runs inside one transaction so the revision a caller
    // is checked against cannot change between the read and the write. The
    // database is opened with `locking_mode = EXCLUSIVE`, so this is a guard
    // against concurrent requests in this process, not against other processes.
    const operation = sql.withTransaction(
      Effect.gen(function* () {
        const now = new Date().toISOString();
        const existing = yield* selectRevision({ workspaceId });

        if (Option.isNone(existing)) {
          // `expectedRevision` is irrelevant when nothing is stored: the row does
          // not exist, so no writer can be clobbered by creating it.
          yield* sql`
            INSERT INTO workspace_layouts (
              workspace_id, project_id, thread_id, revision, layout_json, created_at, updated_at
            )
            VALUES (
              ${workspaceId},
              ${input.projectId},
              ${input.threadId},
              ${layout.revision},
              ${JSON.stringify(layout)},
              ${now},
              ${now}
            )
          `;
          return {
            layout,
            projectId: input.projectId,
            threadId: input.threadId,
            createdAt: now,
            updatedAt: now,
          } satisfies StoredWorkspaceLayout;
        }

        if (input.expectedRevision !== null && input.expectedRevision !== existing.value.revision) {
          const current = yield* selectByWorkspaceId({ workspaceId });
          return yield* new WorkspaceLayoutConflictError({
            workspaceId,
            expectedRevision: input.expectedRevision,
            actualRevision: existing.value.revision,
            // A conflict is only actionable if the loser can see what won.
            current: Option.isNone(current)
              ? layout
              : normalizeWorkspaceLayout(current.value.layout),
          });
        }

        yield* sql`
          UPDATE workspace_layouts
          SET
            project_id = ${input.projectId},
            thread_id = ${input.threadId},
            revision = ${layout.revision},
            layout_json = ${JSON.stringify(layout)},
            updated_at = ${now}
          WHERE workspace_id = ${workspaceId}
        `;

        const stored = yield* selectByWorkspaceId({ workspaceId });
        return Option.isNone(stored)
          ? ({
              layout,
              projectId: input.projectId,
              threadId: input.threadId,
              createdAt: now,
              updatedAt: now,
            } satisfies StoredWorkspaceLayout)
          : toStored(stored.value);
      }),
    );

    return operation.pipe(
      Effect.mapError(
        (cause): WorkspaceLayoutsError =>
          cause instanceof WorkspaceLayoutConflictError ? cause : mapFailure("upsert")(cause),
      ),
    );
  };

  const remove: WorkspaceLayoutsShape["remove"] = (workspaceId) =>
    sql`DELETE FROM workspace_layouts WHERE workspace_id = ${workspaceId}`.pipe(
      Effect.asVoid,
      Effect.mapError(mapFailure("remove")),
    );

  return { read, listByProject, upsert, remove } satisfies WorkspaceLayoutsShape;
});

export const WorkspaceLayoutsLive = Layer.effect(WorkspaceLayouts, makeWorkspaceLayouts);
