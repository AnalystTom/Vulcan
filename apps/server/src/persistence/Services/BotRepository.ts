import {
  Bot,
  BotActionAuditEntry,
  BotCreateInput,
  BotId,
  BotRuntimeState,
  BotTask,
  BotTaskId,
  ProjectId,
  ThreadId,
} from "@vulcan/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { BotRepositoryError } from "../Errors.ts";

export const CreateBotInput = Schema.Struct({
  id: BotId,
  input: BotCreateInput,
  workspaceDir: Schema.String,
  now: Schema.String,
});
export type CreateBotInput = typeof CreateBotInput.Type;

export const GetBotInput = Schema.Struct({
  id: BotId,
});
export type GetBotInput = typeof GetBotInput.Type;

export const GetBotByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetBotByThreadInput = typeof GetBotByThreadInput.Type;

export const ListBotsInput = Schema.Struct({
  includeArchived: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
});
export type ListBotsInput = typeof ListBotsInput.Type;

export const ArchiveBotInput = Schema.Struct({
  id: BotId,
  archivedAt: Schema.String,
});
export type ArchiveBotInput = typeof ArchiveBotInput.Type;

export const DeleteBotInput = Schema.Struct({
  id: BotId,
});
export type DeleteBotInput = typeof DeleteBotInput.Type;

export const CreateBotTaskInput = Schema.Struct({
  id: BotTaskId,
  botId: BotId,
  threadId: ThreadId,
  pinnedProjectId: Schema.optional(Schema.NullOr(ProjectId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  title: BotTask.fields.title,
  now: Schema.String,
});
export type CreateBotTaskInput = typeof CreateBotTaskInput.Type;

export const SetActiveBotTaskInput = Schema.Struct({
  botId: BotId,
  taskId: Schema.NullOr(BotTaskId),
  updatedAt: Schema.String,
});
export type SetActiveBotTaskInput = typeof SetActiveBotTaskInput.Type;

export const ArchiveBotTaskInput = Schema.Struct({
  taskId: BotTaskId,
  archivedAt: Schema.String,
});
export type ArchiveBotTaskInput = typeof ArchiveBotTaskInput.Type;

export const ListBotTasksInput = Schema.Struct({
  botId: Schema.optional(BotId),
  includeArchived: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
});
export type ListBotTasksInput = typeof ListBotTasksInput.Type;

export const ListBotTasksByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListBotTasksByProjectInput = typeof ListBotTasksByProjectInput.Type;

export const ClearBotTaskForDeletedThreadInput = Schema.Struct({
  threadId: ThreadId,
  archivedAt: Schema.String,
});
export type ClearBotTaskForDeletedThreadInput = typeof ClearBotTaskForDeletedThreadInput.Type;

export const TouchBotMemoryUpdatedAtInput = Schema.Struct({
  id: BotId,
  updatedAt: Schema.String,
});
export type TouchBotMemoryUpdatedAtInput = typeof TouchBotMemoryUpdatedAtInput.Type;

export const GetBotRuntimeStateInput = Schema.Struct({
  botId: BotId,
});
export type GetBotRuntimeStateInput = typeof GetBotRuntimeStateInput.Type;

export const SetBotRuntimeStateInput = BotRuntimeState;
export type SetBotRuntimeStateInput = typeof SetBotRuntimeStateInput.Type;

export const AppendBotActionAuditInput = BotActionAuditEntry;
export type AppendBotActionAuditInput = typeof AppendBotActionAuditInput.Type;

export const ListBotActionAuditInput = Schema.Struct({
  botId: BotId,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
});
export type ListBotActionAuditInput = typeof ListBotActionAuditInput.Type;

export interface BotRepositoryShape {
  readonly createBot: (input: CreateBotInput) => Effect.Effect<Bot, BotRepositoryError>;
  /** Full-row save; the caller owns merge semantics. */
  readonly updateBot: (bot: Bot) => Effect.Effect<Bot, BotRepositoryError>;
  readonly archiveBot: (input: ArchiveBotInput) => Effect.Effect<void, BotRepositoryError>;
  /** Hard delete of the bot row and its task rows; the workspace dir on disk is never touched. */
  readonly deleteBot: (input: DeleteBotInput) => Effect.Effect<void, BotRepositoryError>;
  readonly listBots: (
    input?: ListBotsInput,
  ) => Effect.Effect<ReadonlyArray<Bot>, BotRepositoryError>;
  readonly getBotById: (
    input: GetBotInput,
  ) => Effect.Effect<Option.Option<Bot>, BotRepositoryError>;
  /** Resolves the bot that owns a task thread (join through bot_tasks). */
  readonly getBotByThreadId: (
    input: GetBotByThreadInput,
  ) => Effect.Effect<Option.Option<Bot>, BotRepositoryError>;
  readonly createBotTask: (input: CreateBotTaskInput) => Effect.Effect<BotTask, BotRepositoryError>;
  readonly setActiveBotTask: (
    input: SetActiveBotTaskInput,
  ) => Effect.Effect<void, BotRepositoryError>;
  readonly archiveBotTask: (
    input: ArchiveBotTaskInput,
  ) => Effect.Effect<Option.Option<BotTask>, BotRepositoryError>;
  readonly listBotTasks: (
    input?: ListBotTasksInput,
  ) => Effect.Effect<ReadonlyArray<BotTask>, BotRepositoryError>;
  readonly listBotTasksByProject: (
    input: ListBotTasksByProjectInput,
  ) => Effect.Effect<ReadonlyArray<BotTask>, BotRepositoryError>;
  /** Archives the task attached to a deleted thread; returns it when one existed. */
  readonly clearBotTaskForDeletedThread: (
    input: ClearBotTaskForDeletedThreadInput,
  ) => Effect.Effect<Option.Option<BotTask>, BotRepositoryError>;
  readonly touchMemoryUpdatedAt: (
    input: TouchBotMemoryUpdatedAtInput,
  ) => Effect.Effect<void, BotRepositoryError>;
  readonly getRuntimeState: (
    input: GetBotRuntimeStateInput,
  ) => Effect.Effect<Option.Option<BotRuntimeState>, BotRepositoryError>;
  readonly setRuntimeState: (
    input: SetBotRuntimeStateInput,
  ) => Effect.Effect<BotRuntimeState, BotRepositoryError>;
  readonly appendAuditEntry: (
    input: AppendBotActionAuditInput,
  ) => Effect.Effect<BotActionAuditEntry, BotRepositoryError>;
  readonly listAuditEntries: (
    input: ListBotActionAuditInput,
  ) => Effect.Effect<ReadonlyArray<BotActionAuditEntry>, BotRepositoryError>;
}

export class BotRepository extends ServiceMap.Service<BotRepository, BotRepositoryShape>()(
  "vulcan/persistence/Services/BotRepository",
) {}
