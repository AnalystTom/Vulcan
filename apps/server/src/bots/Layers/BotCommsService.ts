// FILE: Layers/BotCommsService.ts
// Purpose: Live BotCommsService — ask_bot (sync, bounded wait), delegate_bot (queued, drained
//          after the caller's turn settles), the per-thread depth ledger, peer-comms approval
//          cards, and the mirrored DM channel.
// Layer: Server domain service (bots)

import { randomUUID } from "node:crypto";

import {
  BotCommsChannelId,
  BotCommsMessageId,
  BotDelegationId,
  BotPeerApprovalId,
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type Bot,
  type BotCommsChannel,
  type BotCommsMessage,
  type BotDelegation,
  type BotEvent,
  type BotId,
  type BotPeerAction,
  type BotPeerApprovalDecision,
  type BotPeerApprovalRequest,
  type OrchestrationThreadShell,
} from "@vulcan/contracts";
import { Deferred, Effect, Layer, Option, PubSub, Stream } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BotCommsRepository } from "../../persistence/Services/BotCommsRepository.ts";
import { BotRepository } from "../../persistence/Services/BotRepository.ts";
import { BotServiceError } from "../Errors.ts";
import { BotService } from "../Services/BotService.ts";
import {
  BotCommsService,
  type AskBotOutcome,
  type BotCommsCaller,
  type BotCommsServiceShape,
  type BotRosterEntry,
  type DelegateBotOutcome,
} from "../Services/BotCommsService.ts";
import {
  ASK_BOT_WAIT_CEILING_MS,
  MAX_COMMS_DEPTH,
  PEER_APPROVAL_TIMEOUT_MS,
  buildAskPrompt,
  buildDelegationPrompt,
  busyText,
  clipPreview,
  commsActivitySummary,
  decideDelegation,
  deniedText,
  isBotBusy,
  resolvePeerTarget,
  visiblePeerBots,
} from "../botComms.ts";

const PEER_TASK_TITLE = "Messages from other bots";
const REPLY_POLL_MIN_MS = 250;
const REPLY_POLL_MAX_MS = 1_000;

function isoNow(): string {
  return new Date().toISOString();
}

function toServiceError(message: string) {
  return (cause: unknown) => new BotServiceError({ message, cause });
}

type PendingApproval = {
  readonly request: BotPeerApprovalRequest;
  readonly decision: Deferred.Deferred<BotPeerApprovalDecision>;
};

const make = Effect.gen(function* () {
  const commsRepository = yield* BotCommsRepository;
  const botRepository = yield* BotRepository;
  const botService = yield* BotService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const events = yield* PubSub.unbounded<BotEvent>();
  const pendingApprovals = new Map<string, PendingApproval>();

  const publish = (event: BotEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

  const listLiveBots = botRepository
    .listBots({ includeArchived: false })
    .pipe(Effect.mapError(toServiceError("Failed to list bots.")));

  const getRuntime = (bot: Bot) =>
    botRepository.getRuntimeState({ botId: bot.id }).pipe(
      Effect.map(
        Option.getOrElse(() => ({
          botId: bot.id,
          phase: "idle" as const,
          activeThreadId: null,
          takeoverReason: null,
          updatedAt: bot.updatedAt,
        })),
      ),
      Effect.mapError(toServiceError("Failed to load bot runtime state.")),
    );

  const getShell = (threadId: ThreadId) =>
    snapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.mapError(toServiceError("Failed to read the bot task thread.")));

  /** The target's active task thread, or null when the bot has no live task. */
  const findActiveTaskThread = (bot: Bot) =>
    Effect.gen(function* () {
      if (bot.activeTaskId === null) return null;
      const tasks = yield* botRepository
        .listBotTasks({ botId: bot.id, includeArchived: false })
        .pipe(Effect.mapError(toServiceError("Failed to load bot tasks.")));
      const task = tasks.find((candidate) => candidate.id === bot.activeTaskId) ?? tasks[0];
      return task?.threadId ?? null;
    });

  const ensureTaskThread = (bot: Bot) =>
    Effect.gen(function* () {
      const existing = yield* findActiveTaskThread(bot);
      if (existing !== null) return existing;
      const created = yield* botService.createTask({ botId: bot.id, title: PEER_TASK_TITLE });
      return created.task.threadId;
    });

  const availabilityOf = (bot: Bot) =>
    Effect.gen(function* () {
      const runtime = yield* getRuntime(bot);
      const threadId = runtime.activeThreadId ?? (yield* findActiveTaskThread(bot));
      const shell = threadId === null ? Option.none() : yield* getShell(threadId);
      const busy = isBotBusy({
        runtime,
        latestTurnState: Option.isSome(shell) ? shell.value.latestTurn?.state : null,
      });
      return { runtime, availability: busy ? ("busy" as const) : ("available" as const) };
    });

  const resolveCaller: BotCommsServiceShape["resolveCaller"] = (threadId) =>
    Effect.gen(function* () {
      const botOption = yield* botRepository
        .getBotByThreadId({ threadId })
        .pipe(Effect.mapError(toServiceError("Failed to resolve the calling bot.")));
      if (Option.isNone(botOption) || botOption.value.archivedAt !== null) return null;
      const depth = yield* commsRepository
        .getDepth(threadId)
        .pipe(Effect.mapError(toServiceError("Failed to read the comms depth.")));
      return { bot: botOption.value, threadId, depth };
    });

  const listRoster: BotCommsServiceShape["listRoster"] = ({ selfId }) =>
    Effect.gen(function* () {
      const bots = yield* listLiveBots;
      const peers = visiblePeerBots(bots, selfId).filter((bot) => bot.id !== selfId);
      return yield* Effect.forEach(
        peers,
        (bot): Effect.Effect<BotRosterEntry, BotServiceError> =>
          availabilityOf(bot).pipe(Effect.map((state) => ({ bot, ...state }))),
        { concurrency: 8 },
      );
    });

  // ── Channel mirror ───────────────────────────────────────────────

  const ensureChannel = (a: BotId, b: BotId) =>
    commsRepository
      .upsertChannel({
        id: BotCommsChannelId.makeUnsafe(`bot-channel-${randomUUID()}`),
        botIds: [a, b],
        now: isoNow(),
      })
      .pipe(Effect.mapError(toServiceError("Failed to open the bot channel.")));

  const mirror = (input: {
    readonly channel: BotCommsChannel;
    readonly fromBotId: BotId;
    readonly kind: BotCommsMessage["kind"];
    readonly text: string;
    readonly sourceThreadId: ThreadId | null;
  }) =>
    Effect.gen(function* () {
      const message: BotCommsMessage = {
        id: BotCommsMessageId.makeUnsafe(`bot-msg-${randomUUID()}`),
        channelId: input.channel.id,
        fromBotId: input.fromBotId,
        kind: input.kind,
        text: input.text,
        sourceThreadId: input.sourceThreadId,
        createdAt: isoNow(),
      };
      const channel = yield* commsRepository
        .appendMessage(message)
        .pipe(Effect.mapError(toServiceError("Failed to record the bot message.")));
      yield* publish({ type: "comms.message.appended", message });
      yield* publish({ type: "comms.channel.upserted", channel });
      return channel;
    });

  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly action: "ask" | "delegate";
    readonly target: Bot;
    readonly channelId: BotCommsChannelId;
    readonly delegationId: BotDelegationId | null;
  }) =>
    orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`bot-comms:${randomUUID()}:activity`),
        threadId: input.threadId,
        activity: {
          id: EventId.makeUnsafe(`bot-comms-${randomUUID()}`),
          tone: "info",
          kind: input.action === "ask" ? "bot.comms.ask" : "bot.comms.delegate",
          summary: commsActivitySummary({ action: input.action, targetName: input.target.name }),
          payload: {
            targetBotId: input.target.id,
            targetName: input.target.name,
            channelId: input.channelId,
            delegationId: input.delegationId,
          },
          turnId: null,
          createdAt: isoNow(),
        },
        createdAt: isoNow(),
      })
      .pipe(
        Effect.asVoid,
        // The chip is cosmetic: never let it fail the comms call.
        Effect.catch(() => Effect.void),
      );

  // ── Approval cards ───────────────────────────────────────────────

  const requestApproval = (input: {
    readonly action: BotPeerAction;
    readonly source: Bot;
    readonly sourceThreadId: ThreadId;
    readonly target: Bot;
    readonly preview: string;
  }) =>
    Effect.gen(function* () {
      const decision = yield* Deferred.make<BotPeerApprovalDecision>();
      const createdAt = Date.now();
      const request: BotPeerApprovalRequest = {
        id: BotPeerApprovalId.makeUnsafe(`bot-peer-approval-${randomUUID()}`),
        action: input.action,
        sourceBotId: input.source.id,
        sourceThreadId: input.sourceThreadId,
        targetBotId: input.target.id,
        preview: clipPreview(input.preview),
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(createdAt + PEER_APPROVAL_TIMEOUT_MS).toISOString(),
      };
      pendingApprovals.set(request.id, { request, decision });
      yield* publish({ type: "peerApproval.requested", request });
      const outcome = yield* Deferred.await(decision).pipe(
        Effect.timeoutOption(PEER_APPROVAL_TIMEOUT_MS),
        Effect.map(Option.getOrElse((): BotPeerApprovalDecision => "deny")),
        Effect.ensuring(Effect.sync(() => pendingApprovals.delete(request.id))),
      );
      // A timeout resolves the card too, so the UI never shows a stale request.
      yield* publish({ type: "peerApproval.resolved", requestId: request.id, decision: outcome });
      return outcome;
    });

  const respondPeerApproval: BotCommsServiceShape["respondPeerApproval"] = (input) =>
    Effect.gen(function* () {
      const pending = pendingApprovals.get(input.requestId);
      if (!pending) return { resolved: false };
      yield* Deferred.succeed(pending.decision, input.decision);
      return { resolved: true };
    });

  /** Returns "allow" when no card is needed. */
  const gateByApproval = (input: Parameters<typeof requestApproval>[0]) =>
    input.source.approvePeerComms ? requestApproval(input) : Effect.succeed("allow" as const);

  // ── Peer turns ───────────────────────────────────────────────────

  const dispatchPeerTurn = (input: {
    readonly target: Bot;
    readonly targetThreadId: ThreadId;
    readonly sourceBotId: BotId;
    readonly depth: number;
    readonly prompt: string;
  }) =>
    Effect.gen(function* () {
      const now = isoNow();
      // Write the depth first: the turn must never start without its ledger row, otherwise the
      // target could see bot tools it is not allowed to use.
      yield* commsRepository
        .setDepth({
          threadId: input.targetThreadId,
          depth: input.depth,
          sourceBotId: input.sourceBotId,
          setAt: now,
        })
        .pipe(Effect.mapError(toServiceError("Failed to record the comms depth.")));
      const suffix = randomUUID();
      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`bot-comms:${suffix}:turn`),
          threadId: input.targetThreadId,
          message: {
            messageId: MessageId.makeUnsafe(`bot-comms:${suffix}:message`),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          dispatchMode: "queue",
          dispatchOrigin: "agent",
          runtimeMode: input.target.runtimeMode,
          interactionMode: input.target.interactionMode,
          modelSelection: input.target.modelSelection,
          ...(input.target.providerOptions ? { providerOptions: input.target.providerOptions } : {}),
          createdAt: now,
        })
        .pipe(
          Effect.mapError(toServiceError("Failed to start the peer turn.")),
          Effect.tapError(() =>
            commsRepository.clearDepth(input.targetThreadId).pipe(Effect.ignore),
          ),
        );
    });

  const isTerminal = (shell: OrchestrationThreadShell) =>
    shell.latestTurn !== null &&
    (shell.latestTurn.state === "completed" ||
      shell.latestTurn.state === "error" ||
      shell.latestTurn.state === "interrupted");

  /** Latest assistant text for the thread's most recent turn. */
  const readLatestReply = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const detail = yield* snapshotQuery
        .getThreadDetailById(threadId)
        .pipe(Effect.mapError(toServiceError("Failed to read the peer reply.")));
      if (Option.isNone(detail)) return null;
      const turnId = detail.value.latestTurn?.turnId ?? null;
      const assistant = detail.value.messages.findLast(
        (message) =>
          message.role === "assistant" && (turnId === null || message.turnId === turnId),
      );
      const text = assistant?.text.trim() ?? "";
      return {
        state: detail.value.latestTurn?.state ?? null,
        text,
        error: detail.value.session?.lastError ?? null,
      };
    });

  /** Polls until a turn newer than `priorTurnId` settles or the deadline passes. */
  const waitForSettledTurn = (input: {
    readonly threadId: ThreadId;
    readonly priorTurnId: string | null;
    readonly deadlineMs: number;
  }) =>
    Effect.gen(function* () {
      let delay = REPLY_POLL_MIN_MS;
      while (Date.now() < input.deadlineMs) {
        const shell = yield* getShell(input.threadId);
        if (Option.isNone(shell)) return "gone" as const;
        const latest = shell.value.latestTurn;
        if (latest !== null && latest.turnId !== input.priorTurnId && isTerminal(shell.value)) {
          return "settled" as const;
        }
        yield* Effect.sleep(Math.min(delay, Math.max(1, input.deadlineMs - Date.now())));
        delay = Math.min(REPLY_POLL_MAX_MS, Math.ceil(delay * 1.5));
      }
      return "timeout" as const;
    });

  const askBot: BotCommsServiceShape["askBot"] = (input) =>
    Effect.gen(function* () {
      const bots = yield* listLiveBots;
      const resolved = resolvePeerTarget({
        bots,
        selfId: input.caller.bot.id,
        rawTargetId: input.rawTargetId,
        callerDepth: input.caller.depth,
      });
      if (!resolved.ok) return { kind: "rejected", code: resolved.code } satisfies AskBotOutcome;
      const target = resolved.target;
      const channel = yield* ensureChannel(input.caller.bot.id, target.id);

      const decision = yield* gateByApproval({
        action: "ask_bot",
        source: input.caller.bot,
        sourceThreadId: input.caller.threadId,
        target,
        preview: input.message,
      });
      if (decision === "deny") {
        yield* mirror({
          channel,
          fromBotId: input.caller.bot.id,
          kind: "activity",
          text: deniedText(target.name),
          sourceThreadId: input.caller.threadId,
        });
        return { kind: "denied", target } satisfies AskBotOutcome;
      }

      const state = yield* availabilityOf(target);
      if (state.availability === "busy") {
        return { kind: "busy", target } satisfies AskBotOutcome;
      }
      const targetThreadId = yield* ensureTaskThread(target);
      const before = yield* getShell(targetThreadId);
      const priorTurnId = Option.isSome(before) ? (before.value.latestTurn?.turnId ?? null) : null;

      yield* mirror({
        channel,
        fromBotId: input.caller.bot.id,
        kind: "text",
        text: input.message,
        sourceThreadId: input.caller.threadId,
      });
      yield* appendActivity({
        threadId: input.caller.threadId,
        action: "ask",
        target,
        channelId: channel.id,
        delegationId: null,
      });

      const dispatched = yield* dispatchPeerTurn({
        target,
        targetThreadId,
        sourceBotId: input.caller.bot.id,
        depth: input.caller.depth + 1,
        prompt: buildAskPrompt({ fromName: input.caller.bot.name, message: input.message }),
      }).pipe(Effect.either);
      if (dispatched._tag === "Left") {
        return { kind: "failed", target, error: dispatched.left.message } satisfies AskBotOutcome;
      }

      const waited = yield* waitForSettledTurn({
        threadId: targetThreadId,
        priorTurnId,
        deadlineMs: Date.now() + ASK_BOT_WAIT_CEILING_MS,
      });
      if (waited === "timeout") {
        return { kind: "timeout", target, threadId: targetThreadId } satisfies AskBotOutcome;
      }
      if (waited === "gone") {
        return {
          kind: "failed",
          target,
          error: "The peer's task thread disappeared before it replied.",
        } satisfies AskBotOutcome;
      }
      const reply = yield* readLatestReply(targetThreadId);
      if (reply === null || reply.state === "error") {
        return {
          kind: "failed",
          target,
          error: reply?.error ?? "The peer's turn failed before it replied.",
        } satisfies AskBotOutcome;
      }
      const replyText = reply.text.length > 0 ? reply.text : "(no reply text)";
      yield* mirror({
        channel,
        fromBotId: target.id,
        kind: "text",
        text: replyText,
        sourceThreadId: targetThreadId,
      });
      return {
        kind: "replied",
        target,
        reply: replyText,
        threadId: targetThreadId,
      } satisfies AskBotOutcome;
    });

  // ── Delegations ──────────────────────────────────────────────────

  const publishDelegation = (delegation: BotDelegation) =>
    publish({ type: "delegation.upserted", delegation });

  const updateDelegation = (
    input: Parameters<typeof commsRepository.updateDelegation>[0],
  ): Effect.Effect<BotDelegation | null, BotServiceError> =>
    commsRepository.updateDelegation(input).pipe(
      Effect.mapError(toServiceError("Failed to update the delegation.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(null),
          onSome: (delegation) => publishDelegation(delegation).pipe(Effect.as(delegation)),
        }),
      ),
    );

  const delegateBot: BotCommsServiceShape["delegateBot"] = (input) =>
    Effect.gen(function* () {
      const bots = yield* listLiveBots;
      const pending = yield* commsRepository
        .countPendingDelegations(input.caller.threadId)
        .pipe(Effect.mapError(toServiceError("Failed to count queued delegations.")));
      const decision = decideDelegation({
        bots,
        selfId: input.caller.bot.id,
        rawTargetId: input.rawTargetId,
        callerDepth: input.caller.depth,
        pendingForSourceThread: pending,
      });
      if (!decision.ok) {
        return { kind: "rejected", code: decision.code } satisfies DelegateBotOutcome;
      }
      const target = decision.target;
      const channel = yield* ensureChannel(input.caller.bot.id, target.id);
      const now = isoNow();
      const reason = input.reason?.trim() ? clipPreview(input.reason) : null;
      const delegation = yield* commsRepository
        .insertDelegation({
          id: BotDelegationId.makeUnsafe(`bot-delegation-${randomUUID()}`),
          sourceBotId: input.caller.bot.id,
          sourceThreadId: input.caller.threadId,
          targetBotId: target.id,
          targetThreadId: null,
          prompt: input.message,
          reason,
          depth: input.caller.depth,
          status: "pending",
          result: null,
          channelId: channel.id,
          createdAt: now,
          updatedAt: now,
        })
        .pipe(Effect.mapError(toServiceError("Failed to queue the delegation.")));
      yield* publishDelegation(delegation);
      yield* mirror({
        channel,
        fromBotId: input.caller.bot.id,
        kind: "activity",
        text: `Queued a delegation: ${clipPreview(input.message)}`,
        sourceThreadId: input.caller.threadId,
      });
      yield* appendActivity({
        threadId: input.caller.threadId,
        action: "delegate",
        target,
        channelId: channel.id,
        delegationId: delegation.id,
      });
      return { kind: "queued", target, delegation } satisfies DelegateBotOutcome;
    });

  const rejectDelegation = (delegation: BotDelegation, result: string) =>
    Effect.gen(function* () {
      yield* updateDelegation({
        id: delegation.id,
        status: "rejected",
        result,
        updatedAt: isoNow(),
      });
      if (delegation.channelId !== null) {
        const channel = yield* commsRepository
          .getChannelById(delegation.channelId)
          .pipe(Effect.mapError(toServiceError("Failed to load the bot channel.")));
        if (Option.isSome(channel)) {
          yield* mirror({
            channel: channel.value,
            fromBotId: delegation.sourceBotId,
            kind: "activity",
            text: result,
            sourceThreadId: delegation.sourceThreadId,
          });
        }
      }
    });

  /** Re-checks everything at drain time: the roster, approval, and the target's availability. */
  const runDelegation = (delegation: BotDelegation) =>
    Effect.gen(function* () {
      const bots = yield* listLiveBots;
      const source = bots.find((bot) => bot.id === delegation.sourceBotId) ?? null;
      const target = bots.find((bot) => bot.id === delegation.targetBotId) ?? null;
      if (source === null || target === null) {
        return yield* rejectDelegation(
          delegation,
          `Delegation canceled — ${source === null ? "the delegating bot" : "the target bot"} is no longer available.`,
        );
      }
      if (delegation.depth >= MAX_COMMS_DEPTH) {
        return yield* rejectDelegation(
          delegation,
          `Delegation to @${target.name} canceled — the bot-to-bot depth limit was reached.`,
        );
      }
      const approval = yield* gateByApproval({
        action: "delegate_bot",
        source,
        sourceThreadId: delegation.sourceThreadId,
        target,
        preview: delegation.prompt,
      });
      if (approval === "deny") {
        return yield* rejectDelegation(
          delegation,
          `Delegation to @${target.name} was denied by the user.`,
        );
      }
      const state = yield* availabilityOf(target);
      if (state.availability === "busy") {
        return yield* rejectDelegation(delegation, busyText(target.name, "delegate"));
      }
      const targetThreadId = yield* ensureTaskThread(target);
      const channel = yield* ensureChannel(source.id, target.id);
      yield* mirror({
        channel,
        fromBotId: source.id,
        kind: "text",
        text: delegation.prompt,
        sourceThreadId: delegation.sourceThreadId,
      });
      const dispatched = yield* dispatchPeerTurn({
        target,
        targetThreadId,
        sourceBotId: source.id,
        depth: delegation.depth + 1,
        prompt: buildDelegationPrompt({
          fromName: source.name,
          message: delegation.prompt,
          reason: delegation.reason,
        }),
      }).pipe(Effect.either);
      if (dispatched._tag === "Left") {
        yield* updateDelegation({
          id: delegation.id,
          status: "failed",
          result: dispatched.left.message,
          targetThreadId,
          channelId: channel.id,
          updatedAt: isoNow(),
        });
        return;
      }
      yield* updateDelegation({
        id: delegation.id,
        status: "running",
        targetThreadId,
        channelId: channel.id,
        updatedAt: isoNow(),
      });
    });

  const drainSourceThread = (sourceThreadId: ThreadId, outcome: "completed" | "failed" | "interrupted") =>
    Effect.gen(function* () {
      const queued = yield* commsRepository
        .listDelegations({ sourceThreadId, status: "pending" })
        .pipe(Effect.mapError(toServiceError("Failed to list queued delegations.")));
      for (const delegation of queued) {
        if (outcome !== "completed") {
          yield* rejectDelegation(
            delegation,
            `Delegation discarded — the delegating turn ${outcome === "failed" ? "failed" : "was interrupted"}.`,
          );
          continue;
        }
        // One failing delegation must not block the rest of the queue.
        yield* runDelegation(delegation).pipe(
          Effect.catch((error) =>
            updateDelegation({
              id: delegation.id,
              status: "failed",
              result: error.message,
              updatedAt: isoNow(),
            }).pipe(Effect.asVoid),
          ),
        );
      }
    });

  /** A delegated turn on `threadId` settled: record its reply. */
  const finishRunningDelegations = (threadId: ThreadId, outcome: "completed" | "failed" | "interrupted") =>
    Effect.gen(function* () {
      const running = yield* commsRepository
        .listDelegations({ status: "running" })
        .pipe(Effect.mapError(toServiceError("Failed to list running delegations.")));
      const mine = running.filter((delegation) => delegation.targetThreadId === threadId);
      if (mine.length === 0) return;
      const reply = outcome === "completed" ? yield* readLatestReply(threadId) : null;
      for (const delegation of mine) {
        const failed = outcome !== "completed" || reply === null || reply.state === "error";
        const result = failed
          ? (reply?.error ?? `The delegated turn ${outcome === "interrupted" ? "was interrupted" : "failed"}.`)
          : reply.text.length > 0
            ? reply.text
            : "(no reply text)";
        yield* updateDelegation({
          id: delegation.id,
          status: failed ? "failed" : "done",
          result,
          updatedAt: isoNow(),
        });
        if (delegation.channelId !== null) {
          const channel = yield* commsRepository
            .getChannelById(delegation.channelId)
            .pipe(Effect.mapError(toServiceError("Failed to load the bot channel.")));
          if (Option.isSome(channel)) {
            yield* mirror({
              channel: channel.value,
              fromBotId: delegation.targetBotId,
              kind: failed ? "activity" : "text",
              text: result,
              sourceThreadId: threadId,
            });
          }
        }
      }
    });

  const onTurnSettled: BotCommsServiceShape["onTurnSettled"] = (input) =>
    Effect.gen(function* () {
      yield* commsRepository
        .clearDepth(input.threadId)
        .pipe(Effect.mapError(toServiceError("Failed to clear the comms depth.")));
      yield* finishRunningDelegations(input.threadId, input.outcome);
      yield* drainSourceThread(input.threadId, input.outcome);
    });

  const recoverAtStartup: BotCommsServiceShape["recoverAtStartup"] = Effect.gen(function* () {
    yield* commsRepository.clearAllDepths.pipe(
      Effect.mapError(toServiceError("Failed to clear stale comms depth rows.")),
    );
    const running = yield* commsRepository
      .listDelegations({ status: "running" })
      .pipe(Effect.mapError(toServiceError("Failed to list running delegations.")));
    for (const delegation of running) {
      yield* updateDelegation({
        id: delegation.id,
        status: "failed",
        result: "The server restarted before the delegated turn finished.",
        updatedAt: isoNow(),
      });
    }
    const pending = yield* commsRepository
      .listDelegations({ status: "pending" })
      .pipe(Effect.mapError(toServiceError("Failed to list queued delegations.")));
    const sourceThreads = [...new Set(pending.map((delegation) => delegation.sourceThreadId))];
    for (const sourceThreadId of sourceThreads) {
      // The source turn cannot still be live across a restart, so treat it as settled.
      yield* drainSourceThread(sourceThreadId, "completed");
    }
  });

  // ── Queries ──────────────────────────────────────────────────────

  const listChannels: BotCommsServiceShape["listChannels"] = (input) =>
    commsRepository
      .listChannels(input.botId === undefined ? {} : { botId: input.botId })
      .pipe(
        Effect.map((channels) => ({ channels })),
        Effect.mapError(toServiceError("Failed to list bot channels.")),
      );

  const listMessages: BotCommsServiceShape["listMessages"] = (input) =>
    commsRepository
      .listMessages({ channelId: input.channelId, limit: input.limit })
      .pipe(
        Effect.tap(() =>
          commsRepository
            .setChannelUnread({ channelId: input.channelId, unread: false, updatedAt: isoNow() })
            .pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.void,
                  onSome: (channel) => publish({ type: "comms.channel.upserted", channel }),
                }),
              ),
            ),
        ),
        Effect.map((messages) => ({ messages })),
        Effect.mapError(toServiceError("Failed to list bot messages.")),
      );

  const listDelegations: BotCommsServiceShape["listDelegations"] = (input) =>
    commsRepository
      .listDelegations(input.botId === undefined ? {} : { botId: input.botId })
      .pipe(
        Effect.map((delegations) => ({ delegations })),
        Effect.mapError(toServiceError("Failed to list delegations.")),
      );

  const snapshot: BotCommsServiceShape["snapshot"] = Effect.gen(function* () {
    const [channels, delegations] = yield* Effect.all([
      commsRepository.listChannels({}),
      commsRepository.listDelegations({}),
    ]).pipe(Effect.mapError(toServiceError("Failed to load the bot comms snapshot.")));
    return {
      channels,
      delegations,
      peerApprovals: [...pendingApprovals.values()].map((entry) => entry.request),
    };
  });

  return {
    resolveCaller,
    listRoster,
    askBot,
    delegateBot,
    onTurnSettled,
    recoverAtStartup,
    listChannels,
    listMessages,
    listDelegations,
    respondPeerApproval,
    snapshot,
    streamEvents: Stream.fromPubSub(events),
  } satisfies BotCommsServiceShape;
});

export const BotCommsServiceLive = Layer.effect(BotCommsService, make);
