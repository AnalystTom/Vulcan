// FILE: botTurnPrompt.ts
// Purpose: Resolve the bot context block for a provider turn. Looks up whether the
//          thread belongs to a bot task and, if so, assembles persona + memory under a
//          character budget. Deliberately infallible: a broken MEMORY.md (or any other
//          failure) must never fail a turn, so every error degrades to "".
// Layer: Server domain helper
// Exports: resolveBotTurnPrompt

import type { ThreadId } from "@vulcan/contracts";
import { Cause, Effect, Option } from "effect";

import { BotRepository } from "../persistence/Services/BotRepository.ts";
import { buildBotMemoryBlock, buildBotStaticPersona, buildBotTurnContext } from "./botPrompt.ts";
import { loadBotMemoryForPrompt } from "./botWorkspace.ts";

/**
 * Returns the bot context for a thread, or "" when the thread is not a bot task, the
 * budget is empty, or anything fails. Non-bot threads return without touching the
 * filesystem — this sits on the hot dispatch path for every turn.
 *
 * Truncation keeps the persona intact (it leads the block) and cuts from the end, i.e.
 * from the memory excerpt.
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
    const context = buildBotTurnContext({
      persona: buildBotStaticPersona(bot.value),
      memoryBlock: buildBotMemoryBlock({ memoryText: memory.text, truncated: memory.truncated }),
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
