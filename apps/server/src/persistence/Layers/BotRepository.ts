import {
  Bot,
  BotActionAuditEntry,
  BotAvatar,
  BotAutonomyConfig,
  BotCapability,
  BotRuntimeState,
  BotTask,
  DEFAULT_BOT_AUTONOMY,
  DEFAULT_BOT_CAPABILITY_GRANTS,
  DEFAULT_BOT_ISOLATION_MODE,
  DEFAULT_BOT_RUNTIME_MODE,
  ModelSelection,
  ProjectId,
  ProviderStartOptions,
} from "@vulcan/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ArchiveBotInput,
  ArchiveBotTaskInput,
  AppendBotActionAuditInput,
  BotRepository,
  type BotRepositoryShape,
  ClearBotTaskForDeletedThreadInput,
  CreateBotInput,
  CreateBotTaskInput,
  DeleteBotInput,
  GetBotByThreadInput,
  GetBotInput,
  GetBotRuntimeStateInput,
  ListBotActionAuditInput,
  ListBotTasksByProjectInput,
  SetActiveBotTaskInput,
  SetBotRuntimeStateInput,
  TouchBotMemoryUpdatedAtInput,
} from "../Services/BotRepository.ts";

const BotDbRow = Schema.Struct({
  id: Bot.fields.id,
  name: Bot.fields.name,
  title: Bot.fields.title,
  description: Bot.fields.description,
  avatar: Schema.fromJsonString(BotAvatar),
  modelSelection: Schema.fromJsonString(ModelSelection),
  providerOptions: Schema.NullOr(Schema.fromJsonString(ProviderStartOptions)),
  runtimeMode: Bot.fields.runtimeMode,
  interactionMode: Bot.fields.interactionMode,
  isolationMode: Bot.fields.isolationMode,
  autonomy: Schema.fromJsonString(BotAutonomyConfig),
  capabilityGrants: Schema.fromJsonString(Schema.Array(BotCapability)),
  defaultWorkingDirectory: Schema.NullOr(Schema.String),
  defaultProjectId: Schema.NullOr(ProjectId),
  chiefOfStaff: Schema.Number,
  approvePeerComms: Schema.Number,
  isPinned: Schema.Number,
  isHidden: Schema.Number,
  activeTaskId: Bot.fields.activeTaskId,
  workspaceDir: Bot.fields.workspaceDir,
  createdAt: Bot.fields.createdAt,
  updatedAt: Bot.fields.updatedAt,
  archivedAt: Bot.fields.archivedAt,
});
type BotDbRow = typeof BotDbRow.Type;

const BotTaskDbRow = Schema.Struct({
  id: BotTask.fields.id,
  botId: BotTask.fields.botId,
  threadId: BotTask.fields.threadId,
  pinnedProjectId: BotTask.fields.pinnedProjectId,
  title: BotTask.fields.title,
  createdAt: BotTask.fields.createdAt,
  updatedAt: BotTask.fields.updatedAt,
  archivedAt: BotTask.fields.archivedAt,
});
type BotTaskDbRow = typeof BotTaskDbRow.Type;

const BotRuntimeStateDbRow = BotRuntimeState;
type BotRuntimeStateDbRow = typeof BotRuntimeStateDbRow.Type;

const BotActionAuditDbRow = BotActionAuditEntry;
type BotActionAuditDbRow = typeof BotActionAuditDbRow.Type;

const decodeBot = Schema.decodeUnknownEffect(Bot);
const decodeTask = Schema.decodeUnknownEffect(BotTask);
const decodeRuntimeState = Schema.decodeUnknownEffect(BotRuntimeState);
const decodeAuditEntry = Schema.decodeUnknownEffect(BotActionAuditEntry);

function toBot(row: BotDbRow) {
  return decodeBot({
    ...row,
    providerOptions: row.providerOptions,
    defaultWorkingDirectory: row.defaultWorkingDirectory,
    defaultProjectId: row.defaultProjectId,
    chiefOfStaff: row.chiefOfStaff === 1,
    approvePeerComms: row.approvePeerComms === 1,
    isPinned: row.isPinned === 1,
    isHidden: row.isHidden === 1,
  }).pipe(Effect.mapError(toPersistenceDecodeError("BotRepository.botRowToDomain")));
}

function toTask(row: BotTaskDbRow) {
  return decodeTask(row).pipe(
    Effect.mapError(toPersistenceDecodeError("BotRepository.taskRowToDomain")),
  );
}

function toRuntimeState(row: BotRuntimeStateDbRow) {
  return decodeRuntimeState(row).pipe(
    Effect.mapError(toPersistenceDecodeError("BotRepository.runtimeStateRowToDomain")),
  );
}

function toAuditEntry(row: BotActionAuditDbRow) {
  return decodeAuditEntry(row).pipe(
    Effect.mapError(toPersistenceDecodeError("BotRepository.auditEntryRowToDomain")),
  );
}

const makeBotRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertBot = SqlSchema.void({
    Request: BotDbRow,
    execute: (bot) =>
      sql`
        INSERT INTO bots (
          bot_id,
          name,
          title,
          description,
          avatar_json,
          model_selection_json,
          provider_options_json,
          runtime_mode,
          interaction_mode,
          isolation_mode,
          autonomy_json,
          capability_grants_json,
          default_working_directory,
          default_project_id,
          chief_of_staff,
          approve_peer_comms,
          is_pinned,
          is_hidden,
          active_task_id,
          workspace_dir,
          created_at,
          updated_at,
          archived_at
        )
        VALUES (
          ${bot.id},
          ${bot.name},
          ${bot.title},
          ${bot.description},
          ${bot.avatar},
          ${bot.modelSelection},
          ${bot.providerOptions},
          ${bot.runtimeMode},
          ${bot.interactionMode},
          ${bot.isolationMode},
          ${bot.autonomy},
          ${bot.capabilityGrants},
          ${bot.defaultWorkingDirectory},
          ${bot.defaultProjectId},
          ${bot.chiefOfStaff},
          ${bot.approvePeerComms},
          ${bot.isPinned},
          ${bot.isHidden},
          ${bot.activeTaskId},
          ${bot.workspaceDir},
          ${bot.createdAt},
          ${bot.updatedAt},
          ${bot.archivedAt}
        )
      `,
  });

  const updateBotRow = SqlSchema.void({
    Request: BotDbRow,
    execute: (bot) =>
      sql`
        UPDATE bots
        SET name = ${bot.name},
            title = ${bot.title},
            description = ${bot.description},
            avatar_json = ${bot.avatar},
            model_selection_json = ${bot.modelSelection},
            provider_options_json = ${bot.providerOptions},
            runtime_mode = ${bot.runtimeMode},
            interaction_mode = ${bot.interactionMode},
            isolation_mode = ${bot.isolationMode},
            autonomy_json = ${bot.autonomy},
            capability_grants_json = ${bot.capabilityGrants},
            default_working_directory = ${bot.defaultWorkingDirectory},
            default_project_id = ${bot.defaultProjectId},
            chief_of_staff = ${bot.chiefOfStaff},
            approve_peer_comms = ${bot.approvePeerComms},
            is_pinned = ${bot.isPinned},
            is_hidden = ${bot.isHidden},
            active_task_id = ${bot.activeTaskId},
            workspace_dir = ${bot.workspaceDir},
            updated_at = ${bot.updatedAt},
            archived_at = ${bot.archivedAt}
        WHERE bot_id = ${bot.id}
      `,
  });

  const getBotRow = SqlSchema.findOneOption({
    Request: GetBotInput,
    Result: BotDbRow,
    execute: ({ id }) =>
      sql`
        SELECT
          bot_id AS "id",
          name,
          title,
          description,
          avatar_json AS "avatar",
          model_selection_json AS "modelSelection",
          provider_options_json AS "providerOptions",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          isolation_mode AS "isolationMode",
          autonomy_json AS "autonomy",
          capability_grants_json AS "capabilityGrants",
          default_working_directory AS "defaultWorkingDirectory",
          default_project_id AS "defaultProjectId",
          chief_of_staff AS "chiefOfStaff",
          approve_peer_comms AS "approvePeerComms",
          is_pinned AS "isPinned",
          is_hidden AS "isHidden",
          active_task_id AS "activeTaskId",
          workspace_dir AS "workspaceDir",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
        FROM bots
        WHERE bot_id = ${id}
      `,
  });

  const getBotRowByThread = SqlSchema.findOneOption({
    Request: GetBotByThreadInput,
    Result: BotDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          bots.bot_id AS "id",
          bots.name,
          bots.title,
          bots.description,
          bots.avatar_json AS "avatar",
          bots.model_selection_json AS "modelSelection",
          bots.provider_options_json AS "providerOptions",
          bots.runtime_mode AS "runtimeMode",
          bots.interaction_mode AS "interactionMode",
          bots.isolation_mode AS "isolationMode",
          bots.autonomy_json AS "autonomy",
          bots.capability_grants_json AS "capabilityGrants",
          bots.default_working_directory AS "defaultWorkingDirectory",
          bots.default_project_id AS "defaultProjectId",
          bots.chief_of_staff AS "chiefOfStaff",
          bots.approve_peer_comms AS "approvePeerComms",
          bots.is_pinned AS "isPinned",
          bots.is_hidden AS "isHidden",
          bots.active_task_id AS "activeTaskId",
          bots.workspace_dir AS "workspaceDir",
          bots.created_at AS "createdAt",
          bots.updated_at AS "updatedAt",
          bots.archived_at AS "archivedAt"
        FROM bots
        JOIN bot_tasks ON bot_tasks.bot_id = bots.bot_id
        WHERE bot_tasks.thread_id = ${threadId}
      `,
  });

  const listBotRows = SqlSchema.findAll({
    Request: Schema.Struct({ includeArchived: Schema.Boolean }),
    Result: BotDbRow,
    execute: ({ includeArchived }) =>
      sql`
        SELECT
          bot_id AS "id",
          name,
          title,
          description,
          avatar_json AS "avatar",
          model_selection_json AS "modelSelection",
          provider_options_json AS "providerOptions",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          isolation_mode AS "isolationMode",
          autonomy_json AS "autonomy",
          capability_grants_json AS "capabilityGrants",
          default_working_directory AS "defaultWorkingDirectory",
          default_project_id AS "defaultProjectId",
          chief_of_staff AS "chiefOfStaff",
          approve_peer_comms AS "approvePeerComms",
          is_pinned AS "isPinned",
          is_hidden AS "isHidden",
          active_task_id AS "activeTaskId",
          workspace_dir AS "workspaceDir",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
        FROM bots
        WHERE (${includeArchived ? 1 : 0} = 1 OR archived_at IS NULL)
        ORDER BY created_at ASC, bot_id ASC
      `,
  });

  const archiveBotRow = SqlSchema.void({
    Request: ArchiveBotInput,
    execute: ({ id, archivedAt }) =>
      sql`
        UPDATE bots
        SET archived_at = ${archivedAt},
            updated_at = ${archivedAt},
            chief_of_staff = 0,
            active_task_id = NULL
        WHERE bot_id = ${id}
      `,
  });

  const deleteBotTasksRow = SqlSchema.void({
    Request: DeleteBotInput,
    execute: ({ id }) => sql`DELETE FROM bot_tasks WHERE bot_id = ${id}`,
  });

  const deleteBotRow = SqlSchema.void({
    Request: DeleteBotInput,
    execute: ({ id }) => sql`DELETE FROM bots WHERE bot_id = ${id}`,
  });

  const insertTask = SqlSchema.void({
    Request: BotTaskDbRow,
    execute: (task) =>
      sql`
        INSERT INTO bot_tasks (
          task_id,
          bot_id,
          thread_id,
          pinned_project_id,
          title,
          created_at,
          updated_at,
          archived_at
        )
        VALUES (
          ${task.id},
          ${task.botId},
          ${task.threadId},
          ${task.pinnedProjectId},
          ${task.title},
          ${task.createdAt},
          ${task.updatedAt},
          ${task.archivedAt}
        )
      `,
  });

  const setActiveTaskRow = SqlSchema.void({
    Request: SetActiveBotTaskInput,
    execute: ({ botId, taskId, updatedAt }) =>
      sql`
        UPDATE bots
        SET active_task_id = ${taskId},
            updated_at = ${updatedAt}
        WHERE bot_id = ${botId}
      `,
  });

  const archiveTaskRow = SqlSchema.findOneOption({
    Request: ArchiveBotTaskInput,
    Result: BotTaskDbRow,
    execute: ({ taskId, archivedAt }) =>
      sql`
        UPDATE bot_tasks
        SET archived_at = ${archivedAt},
            updated_at = ${archivedAt}
        WHERE task_id = ${taskId}
        RETURNING
          task_id AS "id",
          bot_id AS "botId",
          thread_id AS "threadId",
          pinned_project_id AS "pinnedProjectId",
          title,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
      `,
  });

  const clearActiveTaskPointerRow = SqlSchema.void({
    Request: Schema.Struct({ taskId: BotTask.fields.id, updatedAt: Schema.String }),
    execute: ({ taskId, updatedAt }) =>
      sql`
        UPDATE bots
        SET active_task_id = NULL,
            updated_at = ${updatedAt}
        WHERE active_task_id = ${taskId}
      `,
  });

  const listTaskRows = SqlSchema.findAll({
    Request: Schema.Struct({
      botId: Schema.NullOr(BotTask.fields.botId),
      includeArchived: Schema.Boolean,
    }),
    Result: BotTaskDbRow,
    execute: ({ botId, includeArchived }) =>
      sql`
        SELECT
          task_id AS "id",
          bot_id AS "botId",
          thread_id AS "threadId",
          pinned_project_id AS "pinnedProjectId",
          title,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
        FROM bot_tasks
        WHERE (${botId} IS NULL OR bot_id = ${botId})
          AND (${includeArchived ? 1 : 0} = 1 OR archived_at IS NULL)
        ORDER BY created_at ASC, task_id ASC
      `,
  });

  const listTaskRowsByProject = SqlSchema.findAll({
    Request: ListBotTasksByProjectInput,
    Result: BotTaskDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          task_id AS "id",
          bot_id AS "botId",
          thread_id AS "threadId",
          pinned_project_id AS "pinnedProjectId",
          title,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
        FROM bot_tasks
        WHERE pinned_project_id = ${projectId}
        ORDER BY created_at ASC, task_id ASC
      `,
  });

  const clearTaskForDeletedThreadRow = SqlSchema.findOneOption({
    Request: ClearBotTaskForDeletedThreadInput,
    Result: BotTaskDbRow,
    execute: ({ threadId, archivedAt }) =>
      sql`
        UPDATE bot_tasks
        SET archived_at = ${archivedAt},
            updated_at = ${archivedAt}
        WHERE thread_id = ${threadId}
          AND archived_at IS NULL
        RETURNING
          task_id AS "id",
          bot_id AS "botId",
          thread_id AS "threadId",
          pinned_project_id AS "pinnedProjectId",
          title,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
      `,
  });

  const touchMemoryUpdatedAtRow = SqlSchema.void({
    Request: TouchBotMemoryUpdatedAtInput,
    execute: ({ id, updatedAt }) =>
      sql`
        UPDATE bots
        SET memory_updated_at = ${updatedAt}
        WHERE bot_id = ${id}
      `,
  });

  const insertRuntimeStateRow = SqlSchema.void({
    Request: BotRuntimeStateDbRow,
    execute: (state) =>
      sql`
        INSERT INTO bot_runtime_state (
          bot_id,
          phase,
          active_thread_id,
          takeover_reason,
          updated_at
        )
        VALUES (
          ${state.botId},
          ${state.phase},
          ${state.activeThreadId},
          ${state.takeoverReason},
          ${state.updatedAt}
        )
        ON CONFLICT (bot_id) DO UPDATE SET
          phase = excluded.phase,
          active_thread_id = excluded.active_thread_id,
          takeover_reason = excluded.takeover_reason,
          updated_at = excluded.updated_at
      `,
  });

  const getRuntimeStateRow = SqlSchema.findOneOption({
    Request: GetBotRuntimeStateInput,
    Result: BotRuntimeStateDbRow,
    execute: ({ botId }) =>
      sql`
        SELECT
          bot_id AS "botId",
          phase,
          active_thread_id AS "activeThreadId",
          takeover_reason AS "takeoverReason",
          updated_at AS "updatedAt"
        FROM bot_runtime_state
        WHERE bot_id = ${botId}
      `,
  });

  const insertAuditEntryRow = SqlSchema.void({
    Request: AppendBotActionAuditInput,
    execute: (entry) =>
      sql`
        INSERT INTO bot_action_audit (
          audit_entry_id,
          bot_id,
          task_id,
          thread_id,
          capability,
          action,
          decision,
          summary,
          detail_json,
          created_at
        )
        VALUES (
          ${entry.id},
          ${entry.botId},
          ${entry.taskId},
          ${entry.threadId},
          ${entry.capability},
          ${entry.action},
          ${entry.decision},
          ${entry.summary},
          ${entry.detailJson},
          ${entry.createdAt}
        )
        ON CONFLICT(audit_entry_id) DO NOTHING
      `,
  });

  const listAuditEntryRows = SqlSchema.findAll({
    Request: ListBotActionAuditInput,
    Result: BotActionAuditDbRow,
    execute: ({ botId, limit }) =>
      sql`
        SELECT
          audit_entry_id AS "id",
          bot_id AS "botId",
          task_id AS "taskId",
          thread_id AS "threadId",
          capability,
          action,
          decision,
          summary,
          detail_json AS "detailJson",
          created_at AS "createdAt"
        FROM bot_action_audit
        WHERE bot_id = ${botId}
        ORDER BY created_at DESC, audit_entry_id DESC
        LIMIT ${limit}
      `,
  });

  const deleteBotAuditRows = SqlSchema.void({
    Request: DeleteBotInput,
    execute: ({ id }) => sql`DELETE FROM bot_action_audit WHERE bot_id = ${id}`,
  });

  const deleteBotRuntimeStateRow = SqlSchema.void({
    Request: DeleteBotInput,
    execute: ({ id }) => sql`DELETE FROM bot_runtime_state WHERE bot_id = ${id}`,
  });

  const toDbBooleanFields = (bot: Bot) => ({
    ...bot,
    providerOptions: bot.providerOptions ?? null,
    defaultWorkingDirectory: bot.defaultWorkingDirectory ?? null,
    defaultProjectId: bot.defaultProjectId ?? null,
    chiefOfStaff: bot.chiefOfStaff ? 1 : 0,
    approvePeerComms: bot.approvePeerComms ? 1 : 0,
    isPinned: bot.isPinned ? 1 : 0,
    isHidden: bot.isHidden ? 1 : 0,
  });

  const createBot: BotRepositoryShape["createBot"] = (request) => {
    const { id, input, workspaceDir, now } = request;
    const bot: Bot = {
      id,
      name: input.name,
      title: input.title ?? "",
      description: input.description ?? "",
      avatar: input.avatar,
      modelSelection: input.modelSelection,
      ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
      runtimeMode: input.runtimeMode ?? DEFAULT_BOT_RUNTIME_MODE,
      interactionMode: input.interactionMode ?? "default",
      isolationMode: input.isolationMode ?? DEFAULT_BOT_ISOLATION_MODE,
      autonomy: input.autonomy ?? DEFAULT_BOT_AUTONOMY,
      capabilityGrants: input.capabilityGrants ?? [...DEFAULT_BOT_CAPABILITY_GRANTS],
      defaultWorkingDirectory: input.defaultWorkingDirectory ?? null,
      defaultProjectId: input.defaultProjectId ?? null,
      chiefOfStaff: input.chiefOfStaff ?? false,
      approvePeerComms: input.approvePeerComms ?? false,
      isPinned: input.isPinned ?? false,
      isHidden: input.isHidden ?? false,
      activeTaskId: null,
      workspaceDir,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    const initialRuntimeState: BotRuntimeState = {
      botId: id,
      phase: "idle",
      activeThreadId: null,
      takeoverReason: null,
      updatedAt: now,
    };
    return insertBot(toDbBooleanFields(bot)).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.createBot:insert")),
      Effect.flatMap(() =>
        insertRuntimeStateRow(initialRuntimeState).pipe(
          Effect.mapError(toPersistenceSqlError("BotRepository.createBot:runtimeState")),
        ),
      ),
      Effect.as(bot),
    );
  };

  const updateBot: BotRepositoryShape["updateBot"] = (bot) =>
    updateBotRow(toDbBooleanFields(bot)).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.updateBot:update")),
      Effect.as(bot),
    );

  const archiveBot: BotRepositoryShape["archiveBot"] = (input) =>
    archiveBotRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.archiveBot:update")),
    );

  const deleteBot: BotRepositoryShape["deleteBot"] = (input) =>
    deleteBotAuditRows(input).pipe(
      Effect.flatMap(() => deleteBotRuntimeStateRow(input)),
      Effect.flatMap(() => deleteBotTasksRow(input)),
      Effect.flatMap(() => deleteBotRow(input)),
      Effect.mapError(toPersistenceSqlError("BotRepository.deleteBot:delete")),
      Effect.asVoid,
    );

  const listBots: BotRepositoryShape["listBots"] = (input = {}) =>
    listBotRows({ includeArchived: input.includeArchived ?? false }).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.listBots:query")),
      Effect.flatMap((rows) => Effect.forEach(rows, toBot, { concurrency: "unbounded" })),
    );

  const getBotById: BotRepositoryShape["getBotById"] = (input) =>
    getBotRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.getBotById:query")),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => toBot(row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const getBotByThreadId: BotRepositoryShape["getBotByThreadId"] = (input) =>
    getBotRowByThread(input).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.getBotByThreadId:query")),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => toBot(row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const createBotTask: BotRepositoryShape["createBotTask"] = (input) => {
    const task: BotTask = {
      id: input.id,
      botId: input.botId,
      threadId: input.threadId,
      pinnedProjectId: input.pinnedProjectId ?? null,
      title: input.title,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
    };
    return insertTask(task).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.createBotTask:insert")),
      Effect.as(task),
    );
  };

  const setActiveBotTask: BotRepositoryShape["setActiveBotTask"] = (input) =>
    setActiveTaskRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.setActiveBotTask:update")),
    );

  const archiveBotTask: BotRepositoryShape["archiveBotTask"] = (input) =>
    archiveTaskRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.archiveBotTask:update")),
      Effect.tap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.void,
          onSome: (row) =>
            clearActiveTaskPointerRow({ taskId: row.id, updatedAt: input.archivedAt }).pipe(
              Effect.mapError(
                toPersistenceSqlError("BotRepository.archiveBotTask:clearActivePointer"),
              ),
            ),
        }),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => toTask(row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const listBotTasks: BotRepositoryShape["listBotTasks"] = (input = {}) =>
    listTaskRows({
      botId: input.botId ?? null,
      includeArchived: input.includeArchived ?? false,
    }).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.listBotTasks:query")),
      Effect.flatMap((rows) => Effect.forEach(rows, toTask, { concurrency: "unbounded" })),
    );

  const listBotTasksByProject: BotRepositoryShape["listBotTasksByProject"] = (input) =>
    listTaskRowsByProject(input).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.listBotTasksByProject:query")),
      Effect.flatMap((rows) => Effect.forEach(rows, toTask, { concurrency: "unbounded" })),
    );

  const clearBotTaskForDeletedThread: BotRepositoryShape["clearBotTaskForDeletedThread"] = (
    input,
  ) =>
    clearTaskForDeletedThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.clearBotTaskForDeletedThread:update")),
      Effect.tap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.void,
          onSome: (row) =>
            clearActiveTaskPointerRow({ taskId: row.id, updatedAt: input.archivedAt }).pipe(
              Effect.mapError(
                toPersistenceSqlError(
                  "BotRepository.clearBotTaskForDeletedThread:clearActivePointer",
                ),
              ),
            ),
        }),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => toTask(row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const touchMemoryUpdatedAt: BotRepositoryShape["touchMemoryUpdatedAt"] = (input) =>
    touchMemoryUpdatedAtRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.touchMemoryUpdatedAt:update")),
    );

  const getRuntimeState: BotRepositoryShape["getRuntimeState"] = (input) =>
    getRuntimeStateRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.getRuntimeState:query")),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => toRuntimeState(row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const setRuntimeState: BotRepositoryShape["setRuntimeState"] = (input) =>
    insertRuntimeStateRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.setRuntimeState:upsert")),
      Effect.as(input),
    );

  const appendAuditEntry: BotRepositoryShape["appendAuditEntry"] = (input) =>
    insertAuditEntryRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.appendAuditEntry:insert")),
      Effect.as(input),
    );

  const listAuditEntries: BotRepositoryShape["listAuditEntries"] = (input) =>
    listAuditEntryRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("BotRepository.listAuditEntries:query")),
      Effect.flatMap((rows) => Effect.forEach(rows, toAuditEntry, { concurrency: "unbounded" })),
    );

  return {
    createBot,
    updateBot,
    archiveBot,
    deleteBot,
    listBots,
    getBotById,
    getBotByThreadId,
    createBotTask,
    setActiveBotTask,
    archiveBotTask,
    listBotTasks,
    listBotTasksByProject,
    clearBotTaskForDeletedThread,
    touchMemoryUpdatedAt,
    getRuntimeState,
    setRuntimeState,
    appendAuditEntry,
    listAuditEntries,
  } satisfies BotRepositoryShape;
});

export const BotRepositoryLive = Layer.effect(BotRepository, makeBotRepository);
