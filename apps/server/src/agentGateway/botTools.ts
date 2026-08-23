// FILE: botTools.ts
// Purpose: Bot-only MCP tools — list_bots, ask_bot (sync, bounded wait) and delegate_bot
//          (queued until the caller's turn settles). Only bot task threads at comms depth 0
//          can see them; everything else gets "unknown tool".
// Layer: Server agent gateway (tool definitions)

import { BOT_COMMS_MESSAGE_MAX_CHARS, ThreadId } from "@vulcan/contracts";
import { Effect } from "effect";

import type { BotCommsServiceShape } from "../bots/Services/BotCommsService.ts";
import { MAX_COMMS_DEPTH, busyText, deniedText, peerFailureText } from "../bots/botComms.ts";
import { BOT_PEER_TOOL_NAMES } from "../bots/botGatewayPolicy.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { ToolInputError, errorText, readStringArg } from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";

function readMessageArg(args: Record<string, unknown>, name: string): string {
  const value = readStringArg(args, name, { required: true })!;
  if (value.length > BOT_COMMS_MESSAGE_MAX_CHARS) {
    throw new ToolInputError(
      `Argument "${name}" is too long (max ${BOT_COMMS_MESSAGE_MAX_CHARS} characters).`,
    );
  }
  return value;
}

export function makeBotTools(botComms: BotCommsServiceShape): ReadonlyArray<ToolEntry> {
  /** Visible only to bot task threads whose current turn is below the depth cap. */
  const visibleFor = (context: Pick<ToolContext, "callerThreadId">) =>
    botComms.resolveCaller(ThreadId.makeUnsafe(context.callerThreadId)).pipe(
      Effect.map((caller) => caller !== null && caller.depth < MAX_COMMS_DEPTH),
      Effect.orElseSucceed(() => false),
    );

  const requireCaller = (context: ToolContext) =>
    botComms.resolveCaller(ThreadId.makeUnsafe(context.callerThreadId)).pipe(
      Effect.flatMap((caller) =>
        caller === null
          ? Effect.fail(new ToolInputError("Only bot task threads can use peer tools."))
          : Effect.succeed(caller),
      ),
    );

  const listBots: ToolEntry = {
    requiredCapability: "thread:read",
    visibleFor,
    definition: {
      name: BOT_PEER_TOOL_NAMES.listBots,
      description:
        "List the other bots in this Vulcan workspace with their role, description and live availability. Use the returned bot_id with ask_bot or delegate_bot.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List bots", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (_args, context) =>
      Effect.gen(function* () {
        const caller = yield* requireCaller(context);
        const roster = yield* botComms.listRoster({ selfId: caller.bot.id });
        return mcpToolResultJson({
          bots: roster.map((entry) => ({
            bot_id: entry.bot.id,
            name: entry.bot.name,
            role: entry.bot.title || "General assistant",
            about: entry.bot.description,
            chief_of_staff: entry.bot.chiefOfStaff,
            availability: entry.availability,
          })),
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const askBot: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    visibleFor,
    definition: {
      name: BOT_PEER_TOOL_NAMES.askBot,
      description:
        "Ask another bot a question and wait for its reply (up to a few minutes). The peer answers from its own task thread. If the peer is busy you get an explicit busy result — use delegate_bot for work that can run later.",
      inputSchema: {
        type: "object",
        properties: {
          bot_id: { type: "string", description: "Target bot id or @name from list_bots." },
          message: { type: "string", description: "What to ask. Be specific and self-contained." },
        },
        required: ["bot_id", "message"],
        additionalProperties: false,
      },
      annotations: { title: "Ask a bot", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const rawTargetId = readStringArg(args, "bot_id", { required: true })!;
        const message = readMessageArg(args, "message");
        const caller = yield* requireCaller(context);
        const outcome = yield* botComms.askBot({ caller, rawTargetId, message });
        switch (outcome.kind) {
          case "replied":
            return mcpToolResultJson({
              status: "replied",
              bot_id: outcome.target.id,
              name: outcome.target.name,
              reply: outcome.reply,
              threadId: outcome.threadId,
            });
          case "timeout":
            return mcpToolResultJson({
              status: "timeout",
              bot_id: outcome.target.id,
              name: outcome.target.name,
              threadId: outcome.threadId,
              message: `@${outcome.target.name} has not replied yet. Their answer will appear in their task thread; do not re-send the same question.`,
            });
          case "busy":
            return mcpToolResultJson({
              status: "busy",
              bot_id: outcome.target.id,
              name: outcome.target.name,
              message: busyText(outcome.target.name, "ask"),
            });
          case "denied":
            return mcpToolResultJson({
              status: "denied",
              bot_id: outcome.target.id,
              name: outcome.target.name,
              message: deniedText(outcome.target.name),
            });
          case "failed":
            return mcpToolResultError(outcome.error);
          case "rejected":
            return mcpToolResultError(peerFailureText(outcome.code, rawTargetId));
        }
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const delegateBot: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    visibleFor,
    definition: {
      name: BOT_PEER_TOOL_NAMES.delegateBot,
      description:
        "Hand work to another bot. The delegation is queued and starts after your current turn ends; the peer does the work in its own task thread and reports back there. Returns immediately. At most a few delegations can be queued per turn.",
      inputSchema: {
        type: "object",
        properties: {
          bot_id: { type: "string", description: "Target bot id or @name from list_bots." },
          message: {
            type: "string",
            description: "The full brief: goal, context, constraints, expected deliverable.",
          },
          reason: {
            type: "string",
            description: "Optional one-line reason shown to the user (why this bot).",
          },
        },
        required: ["bot_id", "message"],
        additionalProperties: false,
      },
      annotations: { title: "Delegate to a bot", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const rawTargetId = readStringArg(args, "bot_id", { required: true })!;
        const message = readMessageArg(args, "message");
        const reason = readStringArg(args, "reason") ?? null;
        const caller = yield* requireCaller(context);
        const outcome = yield* botComms.delegateBot({ caller, rawTargetId, message, reason });
        if (outcome.kind === "rejected") {
          return mcpToolResultError(peerFailureText(outcome.code, rawTargetId));
        }
        return mcpToolResultJson({
          status: "queued",
          delegation_id: outcome.delegation.id,
          bot_id: outcome.target.id,
          name: outcome.target.name,
          message: `Delegation to @${outcome.target.name} queued. It starts after this turn ends; the result will be reported in @${outcome.target.name}'s task thread.`,
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  return [listBots, askBot, delegateBot];
}
