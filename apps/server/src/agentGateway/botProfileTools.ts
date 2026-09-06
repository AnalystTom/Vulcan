import { hostname } from "node:os";
import { BotUpdateInput, ThreadId } from "@vulcan/contracts";
import { Effect, Option, Schema } from "effect";
import type { BotServiceShape } from "../bots/Services/BotService.ts";
import type { BotRepositoryShape } from "../persistence/Services/BotRepository.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { errorText, ToolInputError } from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "./toolRuntime.ts";

const PROFILE_FIELDS = ["name", "title", "description", "modelSelection"] as const;

export function decodeBotProfileUpdate(botId: string, args: Record<string, unknown>) {
  if (
    Object.keys(args).some(
      (key) => !PROFILE_FIELDS.includes(key as (typeof PROFILE_FIELDS)[number]),
    )
  ) {
    throw new ToolInputError(
      "Only name, title, description and modelSelection can be changed here. Permissions and execution access cannot be elevated by the bot.",
    );
  }
  return Schema.decodeUnknownSync(BotUpdateInput)({ ...args, id: botId });
}

export function makeBotProfileTools(
  repository: BotRepositoryShape,
  service: BotServiceShape,
): readonly ToolEntry[] {
  const self = (threadId: string) =>
    repository
      .getBotByThreadId({ threadId: ThreadId.makeUnsafe(threadId) })
      .pipe(
        Effect.flatMap((bot) =>
          Option.isSome(bot) && !bot.value.archivedAt
            ? Effect.succeed(bot.value)
            : Effect.fail(new ToolInputError("This tool requires an active bot task.")),
        ),
      );
  const visibleFor = (context: { callerThreadId: string }) =>
    self(context.callerThreadId).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  return [
    {
      requiredCapability: "thread:read",
      visibleFor,
      definition: {
        name: "vulcan_get_bot_profile",
        description:
          "Read your own durable profile, actual execution machine, workspace, model and granted capabilities. Inspect before explaining where you run. The execution machine is the Vulcan server, not necessarily the user's browser machine.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { title: "Read bot profile", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: (_args, context) =>
        self(context.callerThreadId).pipe(
          Effect.map((bot) =>
            mcpToolResultJson({
              name: bot.name,
              title: bot.title,
              description: bot.description,
              modelSelection: bot.modelSelection,
              executionHost: hostname(),
              workspaceDir: bot.workspaceDir,
              capabilityGrants: bot.capabilityGrants,
              autonomy: bot.autonomy,
            }),
          ),
          Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
        ),
    },
    {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      visibleFor,
      definition: {
        name: "vulcan_update_bot_profile",
        description:
          "Save your own name, role (title), durable instructions (description), or default model when requested in chat. Preserve existing instructions when extending them. Never put credentials here. Does not change permissions, machine, or existing task models; use automation tools for responsibility models.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            modelSelection: {
              type: "object",
              properties: { provider: { type: "string" }, model: { type: "string" } },
              required: ["provider", "model"],
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        annotations: { title: "Save bot profile", ...WRITE_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          const bot = yield* self(context.callerThreadId);
          const input = yield* Effect.try({
            try: () => decodeBotProfileUpdate(bot.id, args),
            catch: (cause) => new ToolInputError(errorText(cause)),
          });
          const result = yield* service.update(input);
          return mcpToolResultJson({
            name: result.bot.name,
            title: result.bot.title,
            description: result.bot.description,
            modelSelection: result.bot.modelSelection,
          });
        }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
    },
  ];
}
