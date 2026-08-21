import { assert, it } from "@effect/vitest";
import { ThreadId, type Bot, Bot as BotSchema } from "@vulcan/contracts";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { describe } from "vitest";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { BotRepository, type BotRepositoryShape } from "../persistence/Services/BotRepository.ts";
import { resolveBotTurnPrompt } from "./botTurnPrompt.ts";

const testBot: Bot = Schema.decodeUnknownSync(BotSchema)({
  id: "bot-turn-prompt-1",
  name: "Maus",
  title: "Chief of Staff",
  description: "Coordinates the other bots.",
  avatar: { kind: "shape", shape: "happy", color: "teal" },
  modelSelection: { provider: "codex", model: "gpt-5-codex" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  chiefOfStaff: false,
  approvePeerComms: false,
  isPinned: false,
  isHidden: false,
  activeTaskId: null,
  workspaceDir: "/bots/bot-turn-prompt-1",
  createdAt: "2026-08-18T10:00:00.000Z",
  updatedAt: "2026-08-18T10:00:00.000Z",
  archivedAt: null,
});

const unusedRepositoryMethod = () => Effect.die("unexpected BotRepository call");

function makeRepositoryLayer(
  getBotByThreadId: BotRepositoryShape["getBotByThreadId"],
): Layer.Layer<BotRepository> {
  return Layer.succeed(BotRepository, {
    createBot: unusedRepositoryMethod,
    updateBot: unusedRepositoryMethod,
    archiveBot: unusedRepositoryMethod,
    deleteBot: unusedRepositoryMethod,
    listBots: unusedRepositoryMethod,
    getBotById: unusedRepositoryMethod,
    getBotByThreadId,
    createBotTask: unusedRepositoryMethod,
    setActiveBotTask: unusedRepositoryMethod,
    archiveBotTask: unusedRepositoryMethod,
    listBotTasks: unusedRepositoryMethod,
    listBotTasksByProject: unusedRepositoryMethod,
    clearBotTaskForDeletedThread: unusedRepositoryMethod,
    touchMemoryUpdatedAt: unusedRepositoryMethod,
    getRuntimeState: unusedRepositoryMethod,
    setRuntimeState: unusedRepositoryMethod,
    appendAuditEntry: unusedRepositoryMethod,
    listAuditEntries: unusedRepositoryMethod,
  } as BotRepositoryShape);
}

function makeRecordingFileSystemLayer(memoryText: string) {
  const reads: Array<string> = [];
  const layer = Layer.merge(
    FileSystem.layerNoop({
      readFileString: (filePath: string) =>
        Effect.sync(() => {
          reads.push(filePath);
        }).pipe(Effect.as(memoryText)),
    }),
    Path.layer,
  );
  return { layer, reads };
}

const THREAD_ID = ThreadId.makeUnsafe("thread-bot-turn-prompt");

describe("resolveBotTurnPrompt", () => {
  it.effect("returns the persona and memory for a bot task thread", () =>
    Effect.gen(function* () {
      const fs = makeRecordingFileSystemLayer("- user prefers tabs");
      const prompt = yield* resolveBotTurnPrompt({ threadId: THREAD_ID, maxChars: 10_000 }).pipe(
        Effect.provide(
          Layer.merge(
            makeRepositoryLayer(() => Effect.succeedSome(testBot)),
            fs.layer,
          ),
        ),
      );
      assert.include(prompt, "You are Maus, a bot teammate in Vulcan.");
      assert.include(prompt, "Role: Chief of Staff.");
      assert.include(prompt, "- user prefers tabs");
      assert.deepStrictEqual(fs.reads, ["/bots/bot-turn-prompt-1/MEMORY.md"]);
    }),
  );

  it.effect("returns empty for a non-bot thread without touching the filesystem", () =>
    Effect.gen(function* () {
      const fs = makeRecordingFileSystemLayer("- should never be read");
      const prompt = yield* resolveBotTurnPrompt({ threadId: THREAD_ID, maxChars: 10_000 }).pipe(
        Effect.provide(
          Layer.merge(
            makeRepositoryLayer(() => Effect.succeed(Option.none())),
            fs.layer,
          ),
        ),
      );
      assert.strictEqual(prompt, "");
      assert.deepStrictEqual(fs.reads, []);
    }),
  );

  it.effect("returns empty when the budget is empty", () =>
    Effect.gen(function* () {
      const fs = makeRecordingFileSystemLayer("- should never be read");
      const prompt = yield* resolveBotTurnPrompt({ threadId: THREAD_ID, maxChars: 0 }).pipe(
        Effect.provide(
          Layer.merge(
            makeRepositoryLayer(() => Effect.succeedSome(testBot)),
            fs.layer,
          ),
        ),
      );
      assert.strictEqual(prompt, "");
      assert.deepStrictEqual(fs.reads, []);
    }),
  );

  it.effect("keeps the persona and cuts from the end when over budget", () =>
    Effect.gen(function* () {
      const fs = makeRecordingFileSystemLayer(`- ${"x".repeat(5_000)}`);
      const prompt = yield* resolveBotTurnPrompt({ threadId: THREAD_ID, maxChars: 120 }).pipe(
        Effect.provide(
          Layer.merge(
            makeRepositoryLayer(() => Effect.succeedSome(testBot)),
            fs.layer,
          ),
        ),
      );
      assert.strictEqual(prompt.length, 120);
      assert.isTrue(prompt.startsWith("You are Maus, a bot teammate in Vulcan."));
    }),
  );

  it.effect(
    "degrades to empty when the repository fails — a broken lookup must not fail the turn",
    () =>
      Effect.gen(function* () {
        const fs = makeRecordingFileSystemLayer("- irrelevant");
        const prompt = yield* resolveBotTurnPrompt({ threadId: THREAD_ID, maxChars: 10_000 }).pipe(
          Effect.provide(
            Layer.merge(
              makeRepositoryLayer(() =>
                Effect.fail(
                  new PersistenceSqlError({ operation: "getBotByThreadId", detail: "boom" }),
                ),
              ),
              fs.layer,
            ),
          ),
        );
        assert.strictEqual(prompt, "");
      }),
  );

  it.effect(
    "degrades to empty when reading memory dies — a broken MEMORY.md must not fail the turn",
    () =>
      Effect.gen(function* () {
        const layer = Layer.merge(
          makeRepositoryLayer(() => Effect.succeedSome(testBot)),
          Layer.merge(
            FileSystem.layerNoop({
              readFileString: () => Effect.die("filesystem exploded"),
            }),
            Path.layer,
          ),
        );
        const prompt = yield* resolveBotTurnPrompt({ threadId: THREAD_ID, maxChars: 10_000 }).pipe(
          Effect.provide(layer),
        );
        assert.strictEqual(prompt, "");
      }),
  );
});
