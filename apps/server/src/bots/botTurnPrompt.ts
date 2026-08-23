// FILE: botTurnPrompt.ts
// Purpose: Resolve the bot context block for a provider turn. Looks up whether the
//          thread belongs to a bot task and, if so, assembles persona + memory + the
//          peer-comms addendum under a character budget. Deliberately infallible: a
//          broken MEMORY.md (or any other failure) must never fail a turn, so every
//          error degrades to "".
// Layer: Server domain helper
// Exports: resolveBotTurnPrompt

import type { Bot, ThreadId } from "@vulcan/contracts";
import { Cause, Effect, Option } from "effect";

import { BotCommsRepository } from "../persistence/Services/BotCommsRepository.ts";
import { BotRepository } from "../persistence/Services/BotRepository.ts";
import { visiblePeerBots } from "./botComms.ts";
import {
  buildBotCommsBlock,
  buildBotMemoryBlock,
  buildBotStaticPersona,
  buildBotTurnContext,
  type BotRosterPromptEntry,
} from "./botPrompt.ts";
import { loadBotMemoryForPrompt } from "./botWorkspace.ts";

/**
 * Peer roster for the prompt. Availability comes from the durable runtime phase only:
 * this runs on the dispatch path of every bot turn, so it must stay one query per peer
 * and never touch the projection.
 */
const loadRosterEntries = (self: Bot) =>
  Effect.gen(function* () {
    const repository = yield* BotRepository;
    const bots = yield* repository.listBots({ includeArchived: false });
    const peers = visiblePeerBots(bots, self.id).filter((bot) => bot.id !== self.id);
    return yield* Effect.forEach(
      peers,
      (bot): Effect.Effect<BotRosterPromptEntry, never, never> =>
        repository.getRuntimeState({ botId: bot.id }).pipe(
          Effect.map((state) => ({
            name: bot.name,
            title: bot.title,
            description: bot.description,
            availability:
              Option.isSome(state) && state.value.phase !== "idle"
                ? ("busy" as const)
                : ("available" as const),
          })),
          Effect.orElseSucceed(() => ({
            name: bot.name,
            title: bot.title,
            description: bot.description,
            availability: "available" as const,
          })),
        ),
      { concurrency: 8 },
    );
  });

/**
 * Returns the bot context for a thread, or "" when the thread is not a bot task, the
 * budget is empty, or anything fails. Non-bot threads return without touching the
 * filesystem — this sits on the hot dispatch path for every turn.
 *
 * Truncation keeps the persona intact (it leads the block) and cuts from the end, i.e.
 * from the memory excerpt and the comms addendum.
 */
export const resolveBotTurnPrompt = (input: {
  readonly threadId: ThreadId;
  readonly maxChars: number;
}) =>
  Effect.gen(function* () {
    if (input.maxChars <= 0) {
      return "";
    }
    const repository = yield* BotRepository;
    const bot = yield* repository.getBotByThreadId({ threadId: input.threadId });
    if (Option.isNone(bot)) {
      return "";
    }
    const memory = yield* loadBotMemoryForPrompt({ workspaceDir: bot.value.workspaceDir });
    // Comms persistence is optional so existing fakes/tests without it keep working.
    const commsRepository = yield* Effect.serviceOption(BotCommsRepository);
    const depth = Option.isSome(commsRepository)
      ? yield* commsRepository.value.getDepth(input.threadId).pipe(Effect.orElseSucceed(() => 0))
      : 0;
    const peers =
      depth > 0 || !bot.value.chiefOfStaff
        ? []
        : yield* loadRosterEntries(bot.value).pipe(Effect.orElseSucceed(() => []));
    const context = buildBotTurnContext({
      persona: buildBotStaticPersona(bot.value),
      memoryBlock: buildBotMemoryBlock({ memoryText: memory.text, truncated: memory.truncated }),
      commsBlock: buildBotCommsBlock({ chiefOfStaff: bot.value.chiefOfStaff, depth, peers }),
    });
    return context.length > input.maxChars ? context.slice(0, input.maxChars) : context;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("failed to resolve bot turn prompt; continuing without bot context", {
        threadId: input.threadId,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as("")),
    ),
  );
