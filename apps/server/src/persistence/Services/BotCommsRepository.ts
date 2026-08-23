// FILE: Services/BotCommsRepository.ts
// Purpose: Persistence contract for bot peer comms — DM channels + mirrored messages, the
//          async delegation queue, and the per-thread comms depth ledger.
// Layer: Server persistence service contract

import {
  BotCommsChannel,
  BotCommsChannelId,
  BotCommsMessage,
  BotDelegation,
  BotDelegationId,
  BotDelegationStatus,
  BotId,
  ThreadId,
} from "@vulcan/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { BotRepositoryError } from "../Errors.ts";

export const UpsertBotCommsChannelInput = Schema.Struct({
  id: BotCommsChannelId,
  botIds: Schema.Tuple([BotId, BotId]),
  now: Schema.String,
});
export type UpsertBotCommsChannelInput = typeof UpsertBotCommsChannelInput.Type;

export const ListBotCommsChannelsInput = Schema.Struct({
  botId: Schema.optional(BotId),
});
export type ListBotCommsChannelsInput = typeof ListBotCommsChannelsInput.Type;

export const ListBotCommsMessagesInput = Schema.Struct({
  channelId: BotCommsChannelId,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
});
export type ListBotCommsMessagesInput = typeof ListBotCommsMessagesInput.Type;

export const SetBotCommsChannelUnreadInput = Schema.Struct({
  channelId: BotCommsChannelId,
  unread: Schema.Boolean,
  updatedAt: Schema.String,
});
export type SetBotCommsChannelUnreadInput = typeof SetBotCommsChannelUnreadInput.Type;

export const ListBotDelegationsInput = Schema.Struct({
  botId: Schema.optional(BotId),
  sourceThreadId: Schema.optional(ThreadId),
  status: Schema.optional(BotDelegationStatus),
});
export type ListBotDelegationsInput = typeof ListBotDelegationsInput.Type;

export const UpdateBotDelegationInput = Schema.Struct({
  id: BotDelegationId,
  status: BotDelegationStatus,
  result: Schema.optional(Schema.NullOr(Schema.String)),
  targetThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  channelId: Schema.optional(Schema.NullOr(BotCommsChannelId)),
  updatedAt: Schema.String,
});
export type UpdateBotDelegationInput = typeof UpdateBotDelegationInput.Type;

export const SetBotCommsDepthInput = Schema.Struct({
  threadId: ThreadId,
  depth: Schema.Int,
  sourceBotId: Schema.NullOr(BotId),
  setAt: Schema.String,
});
export type SetBotCommsDepthInput = typeof SetBotCommsDepthInput.Type;

export interface BotCommsRepositoryShape {
  /** Finds the pair's channel, creating it on first contact. Pair order is normalized. */
  readonly upsertChannel: (
    input: UpsertBotCommsChannelInput,
  ) => Effect.Effect<BotCommsChannel, BotRepositoryError>;
  readonly getChannelById: (
    channelId: BotCommsChannelId,
  ) => Effect.Effect<Option.Option<BotCommsChannel>, BotRepositoryError>;
  readonly listChannels: (
    input?: ListBotCommsChannelsInput,
  ) => Effect.Effect<ReadonlyArray<BotCommsChannel>, BotRepositoryError>;
  readonly setChannelUnread: (
    input: SetBotCommsChannelUnreadInput,
  ) => Effect.Effect<Option.Option<BotCommsChannel>, BotRepositoryError>;
  /** Appends a message and bumps the channel's preview/unread state in one step. */
  readonly appendMessage: (
    message: BotCommsMessage,
  ) => Effect.Effect<BotCommsChannel, BotRepositoryError>;
  readonly listMessages: (
    input: ListBotCommsMessagesInput,
  ) => Effect.Effect<ReadonlyArray<BotCommsMessage>, BotRepositoryError>;

  readonly insertDelegation: (
    delegation: BotDelegation,
  ) => Effect.Effect<BotDelegation, BotRepositoryError>;
  readonly updateDelegation: (
    input: UpdateBotDelegationInput,
  ) => Effect.Effect<Option.Option<BotDelegation>, BotRepositoryError>;
  readonly listDelegations: (
    input?: ListBotDelegationsInput,
  ) => Effect.Effect<ReadonlyArray<BotDelegation>, BotRepositoryError>;
  readonly countPendingDelegations: (
    sourceThreadId: ThreadId,
  ) => Effect.Effect<number, BotRepositoryError>;

  readonly getDepth: (threadId: ThreadId) => Effect.Effect<number, BotRepositoryError>;
  readonly setDepth: (input: SetBotCommsDepthInput) => Effect.Effect<void, BotRepositoryError>;
  readonly clearDepth: (threadId: ThreadId) => Effect.Effect<void, BotRepositoryError>;
  /** Startup hygiene: no depth row can be valid once the process that wrote it is gone. */
  readonly clearAllDepths: Effect.Effect<void, BotRepositoryError>;
}

export class BotCommsRepository extends ServiceMap.Service<
  BotCommsRepository,
  BotCommsRepositoryShape
>()("vulcan/persistence/Services/BotCommsRepository") {}
