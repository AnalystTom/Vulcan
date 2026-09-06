import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { ThreadId } from "@vulcan/contracts";
import { Effect, Option } from "effect";
import type { BotRepositoryShape } from "../persistence/Services/BotRepository.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { readStringArg, ToolInputError } from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "./toolRuntime.ts";
const execute = promisify(execFile);

export function serverBrowserArguments(
  workspace: string,
  botId: string,
  operation: string,
  args: Record<string, unknown>,
): string[] {
  const base = ["--session", botId, "--profile", join(workspace, "browser"), "--json"];
  if (
    (operation === "click" || operation === "fill") &&
    !/^@e[0-9]+$/.test(readStringArg(args, "ref", { required: true })!)
  )
    throw new ToolInputError("Use an @e reference from the latest snapshot.");
  if (operation === "fill" && readStringArg(args, "text", { required: true })!.startsWith("-"))
    throw new ToolInputError(
      "Text beginning with a command option is not supported by this browser adapter.",
    );
  switch (operation) {
    case "snapshot":
      return [...base, "snapshot", "-i"];
    case "open": {
      const url = new URL(readStringArg(args, "url", { required: true })!);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
        throw new ToolInputError("Use an HTTP(S) URL without embedded credentials.");
      return [...base, "open", url.href];
    }
    case "click":
      return [...base, "click", readStringArg(args, "ref", { required: true })!];
    case "fill":
      return [
        ...base,
        "fill",
        readStringArg(args, "ref", { required: true })!,
        readStringArg(args, "text", { required: true })!,
      ];
    default:
      throw new ToolInputError("Unsupported browser action.");
  }
}

export function makeBotServerBrowserTools(
  repository: BotRepositoryShape,
  binary: string,
): readonly ToolEntry[] {
  return ["snapshot", "open", "click", "fill"].map(
    (operation): ToolEntry => ({
      requiredCapability: "browser:control",
      requiresActiveTurn: operation !== "snapshot",
      visibleFor: (context) =>
        repository.getBotByThreadId({ threadId: ThreadId.makeUnsafe(context.callerThreadId) }).pipe(
          Effect.map(Option.isSome),
          Effect.orElseSucceed(() => false),
        ),
      definition: {
        name: `browser_server_${operation}`,
        description: `${operation} in this bot's dedicated browser on the Vulcan server. The profile and sign-ins persist in its workspace across tasks. This is a server browser, not the user's visible browser. Take a fresh snapshot before acting and use its @refs. Never submit forms, register accounts or send messages without the user's authority.`,
        inputSchema: {
          type: "object",
          properties:
            operation === "open"
              ? { url: { type: "string" } }
              : operation === "fill"
                ? { ref: { type: "string" }, text: { type: "string" } }
                : operation === "click"
                  ? { ref: { type: "string" } }
                  : {},
          required:
            operation === "open"
              ? ["url"]
              : operation === "fill"
                ? ["ref", "text"]
                : operation === "click"
                  ? ["ref"]
                  : [],
          additionalProperties: false,
        },
        annotations: {
          title: `Server browser ${operation}`,
          ...(operation === "snapshot" ? READ_ONLY_TOOL_ANNOTATIONS : WRITE_TOOL_ANNOTATIONS),
        },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          const bot = yield* repository.getBotByThreadId({
            threadId: ThreadId.makeUnsafe(context.callerThreadId),
          });
          if (Option.isNone(bot) || bot.value.archivedAt)
            return mcpToolResultError("An active bot is required.");
          const commandArgs = yield* Effect.try({
            try: () =>
              serverBrowserArguments(bot.value.workspaceDir, bot.value.id, operation, args),
            catch: () => new ToolInputError("Invalid browser action arguments."),
          });
          const result = yield* Effect.tryPromise({
            try: (signal) =>
              execute(binary, commandArgs, { timeout: 45_000, maxBuffer: 2 * 1024 * 1024, signal }),
            catch: (cause) =>
              new ToolInputError(
                `Server browser process failed (${(cause as NodeJS.ErrnoException).code ?? "unknown"}). Check its state before retrying.`,
              ),
          });
          return mcpToolResultJson({ output: result.stdout });
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(
              mcpToolResultError(
                error instanceof ToolInputError
                  ? error.message
                  : "Server browser unavailable or action failed. Inspect the server connection and installed browser runtime; do not assume the action completed.",
              ),
            ),
          ),
        ),
    }),
  );
}
