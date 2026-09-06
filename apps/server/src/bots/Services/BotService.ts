import type {
  BotAuditListInput,
  BotAuditListResult,
  BotControlInput,
  BotControlResult,
  BotCreateInput,
  BotCreateResult,
  BotDeleteInput,
  BotDeleteResult,
  BotEvent,
  BotListInput,
  BotListResult,
  BotMemoryGetInput,
  BotMemoryGetResult,
  BotMemorySetInput,
  BotMemorySetResult,
  BotMemoryTopicGetInput,
  BotMemoryTopicGetResult,
  BotMemoryTopicListInput,
  BotMemoryTopicListResult,
  BotTaskArchiveInput,
  BotTaskArchiveResult,
  BotTaskCreateInput,
  BotTaskCreateResult,
  BotTaskRunInput,
  BotTaskRunResult,
  BotTaskSetActiveInput,
  BotTaskSetActiveResult,
  BotUpdateInput,
  BotUpdateResult,
  ThreadId,
} from "@vulcan/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { BotServiceError } from "../Errors.ts";

export interface BotServiceShape {
  readonly list: (input?: BotListInput) => Effect.Effect<BotListResult, BotServiceError>;
  readonly create: (input: BotCreateInput) => Effect.Effect<BotCreateResult, BotServiceError>;
  readonly update: (input: BotUpdateInput) => Effect.Effect<BotUpdateResult, BotServiceError>;
  /** Archives the bot (rows are kept and the workspace dir on disk is never touched). */
  readonly delete: (input: BotDeleteInput) => Effect.Effect<BotDeleteResult, BotServiceError>;
  /** Creates a task by dispatching a real thread into the Bots container project. */
  readonly createTask: (
    input: BotTaskCreateInput,
  ) => Effect.Effect<BotTaskCreateResult, BotServiceError>;
  readonly runTask: (input: BotTaskRunInput) => Effect.Effect<BotTaskRunResult, BotServiceError>;
  readonly setActiveTask: (
    input: BotTaskSetActiveInput,
  ) => Effect.Effect<BotTaskSetActiveResult, BotServiceError>;
  readonly archiveTask: (
    input: BotTaskArchiveInput,
  ) => Effect.Effect<BotTaskArchiveResult, BotServiceError>;
  readonly getMemory: (
    input: BotMemoryGetInput,
  ) => Effect.Effect<BotMemoryGetResult, BotServiceError>;
  readonly setMemory: (
    input: BotMemorySetInput,
  ) => Effect.Effect<BotMemorySetResult, BotServiceError>;
  /** The bot's `memory/<topic>.md` files, name + size only. */
  readonly listMemoryTopics: (
    input: BotMemoryTopicListInput,
  ) => Effect.Effect<BotMemoryTopicListResult, BotServiceError>;
  /** One topic file's contents, capped at the memory byte limit. */
  readonly getMemoryTopic: (
    input: BotMemoryTopicGetInput,
  ) => Effect.Effect<BotMemoryTopicGetResult, BotServiceError>;
  readonly control: (input: BotControlInput) => Effect.Effect<BotControlResult, BotServiceError>;
  readonly listAudit: (
    input: BotAuditListInput,
  ) => Effect.Effect<BotAuditListResult, BotServiceError>;
  /** Current roster + tasks as a single snapshot event (prepended to streamEvents). */
  readonly snapshot: Effect.Effect<BotEvent, BotServiceError>;
  /** Archives the bot task attached to a deleted thread, if any (reconciler entry point). */
  readonly reconcileDeletedThread: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, BotServiceError>;
  /** Projects provider lifecycle for a bot task into durable coworker state. */
  readonly reconcileThreadRuntime: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, BotServiceError>;
  readonly streamEvents: Stream.Stream<BotEvent>;
}

export class BotService extends ServiceMap.Service<BotService, BotServiceShape>()(
  "vulcan/bots/Services/BotService",
) {}
