// FILE: Services/BotCommsService.ts
// Purpose: Bot-to-bot comms — synchronous asks, queued delegations, the depth ledger, human
//          peer-comms approval, and the mirrored DM channel the UI shows.
// Layer: Server domain service contract (bots)

import type {
  Bot,
  BotCommsChannel,
  BotCommsChannelListInput,
  BotCommsChannelListResult,
  BotCommsMessageListInput,
  BotCommsMessageListResult,
  BotDelegation,
  BotDelegationListInput,
  BotDelegationListResult,
  BotEvent,
  BotPeerApprovalRequest,
  BotPeerApprovalRespondInput,
  BotPeerApprovalRespondResult,
  BotRuntimeState,
  ThreadId,
} from "@vulcan/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { BotServiceError } from "../Errors.ts";

export interface BotRosterEntry {
  readonly bot: Bot;
  readonly runtime: BotRuntimeState;
  /** "available" | "busy" — derived from runtime phase and the live task thread. */
  readonly availability: "available" | "busy";
}

/** Who is calling a bot tool, resolved from the caller thread. */
export interface BotCommsCaller {
  readonly bot: Bot;
  readonly threadId: ThreadId;
  /** Comms depth of the caller's current turn (0 = started by a human). */
  readonly depth: number;
}

export type AskBotOutcome =
  | { readonly kind: "replied"; readonly target: Bot; readonly reply: string; readonly threadId: ThreadId }
  | { readonly kind: "timeout"; readonly target: Bot; readonly threadId: ThreadId }
  | { readonly kind: "busy"; readonly target: Bot }
  | { readonly kind: "denied"; readonly target: Bot }
  | { readonly kind: "failed"; readonly target: Bot; readonly error: string }
  | { readonly kind: "rejected"; readonly code: "self" | "no_target" | "too_deep" };

export type DelegateBotOutcome =
  | { readonly kind: "queued"; readonly target: Bot; readonly delegation: BotDelegation }
  | { readonly kind: "rejected"; readonly code: "self" | "no_target" | "too_deep" | "too_many" };

export interface BotCommsSnapshot {
  readonly channels: ReadonlyArray<BotCommsChannel>;
  readonly delegations: ReadonlyArray<BotDelegation>;
  readonly peerApprovals: ReadonlyArray<BotPeerApprovalRequest>;
}

export interface BotCommsServiceShape {
  /** None when the thread is not a bot task thread. */
  readonly resolveCaller: (
    threadId: ThreadId,
  ) => Effect.Effect<BotCommsCaller | null, BotServiceError>;
  /** Visible peers with live availability, excluding the caller. */
  readonly listRoster: (input: {
    readonly selfId: Bot["id"];
  }) => Effect.Effect<ReadonlyArray<BotRosterEntry>, BotServiceError>;
  readonly askBot: (input: {
    readonly caller: BotCommsCaller;
    readonly rawTargetId: string;
    readonly message: string;
  }) => Effect.Effect<AskBotOutcome, BotServiceError>;
  readonly delegateBot: (input: {
    readonly caller: BotCommsCaller;
    readonly rawTargetId: string;
    readonly message: string;
    readonly reason: string | null;
  }) => Effect.Effect<DelegateBotOutcome, BotServiceError>;
  /**
   * Called when a turn settles on any thread: clears that thread's depth row, then either
   * drains the delegations it queued (completed) or discards them (failed/interrupted).
   */
  readonly onTurnSettled: (input: {
    readonly threadId: ThreadId;
    readonly outcome: "completed" | "failed" | "interrupted";
  }) => Effect.Effect<void, BotServiceError>;
  /** Startup hygiene: clears stale depth rows and drains delegations left pending. */
  readonly recoverAtStartup: Effect.Effect<void, BotServiceError>;

  readonly listChannels: (
    input: BotCommsChannelListInput,
  ) => Effect.Effect<BotCommsChannelListResult, BotServiceError>;
  readonly listMessages: (
    input: BotCommsMessageListInput,
  ) => Effect.Effect<BotCommsMessageListResult, BotServiceError>;
  readonly listDelegations: (
    input: BotDelegationListInput,
  ) => Effect.Effect<BotDelegationListResult, BotServiceError>;
  readonly respondPeerApproval: (
    input: BotPeerApprovalRespondInput,
  ) => Effect.Effect<BotPeerApprovalRespondResult, BotServiceError>;
  readonly snapshot: Effect.Effect<BotCommsSnapshot, BotServiceError>;
  readonly streamEvents: Stream.Stream<BotEvent>;
}

export class BotCommsService extends ServiceMap.Service<BotCommsService, BotCommsServiceShape>()(
  "vulcan/bots/Services/BotCommsService",
) {}
