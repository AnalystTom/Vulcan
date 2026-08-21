import { assert, it } from "@effect/vitest";
import {
  BotAuditEntryId,
  BotId,
  BotTaskId,
  ProjectId,
  ThreadId,
  type BotCreateInput,
} from "@vulcan/contracts";
import { Effect, Layer, Option } from "effect";

import { runMigrations } from "../Migrations.ts";
import { BotRepositoryLive } from "./BotRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { BotRepository } from "../Services/BotRepository.ts";

const layer = it.layer(BotRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const createInput = {
  name: "Maus",
  title: "Chief of Staff",
  description: "Coordinates the other bots.",
  avatar: { kind: "shape", shape: "happy", color: "teal" },
  modelSelection: {
    provider: "codex",
    model: "gpt-5-codex",
  },
} satisfies BotCreateInput;

const NOW = "2026-08-18T10:00:00.000Z";
const LATER = "2026-08-18T11:00:00.000Z";

layer("BotRepository", (it) => {
  it.effect("creates and lists bots with defaults", () =>
    Effect.gen(function* () {
      const repository = yield* BotRepository;
      yield* runMigrations();

      const created = yield* repository.createBot({
        id: BotId.makeUnsafe("bot-list-1"),
        input: createInput,
        workspaceDir: "/tmp/vulcan-bots/bot-list-1",
        now: NOW,
      });
      const listed = yield* repository.listBots({ includeArchived: false });

      assert.strictEqual(created.runtimeMode, "approval-required");
      assert.strictEqual(created.interactionMode, "default");
      assert.strictEqual(created.isolationMode, "worktree");
      assert.deepStrictEqual(created.autonomy, { enabled: false, maxActiveRuns: 1 });
      assert.deepStrictEqual(created.capabilityGrants, ["thread.read", "filesystem.read"]);
      assert.strictEqual(created.chiefOfStaff, false);
      assert.strictEqual(created.isPinned, false);
      assert.strictEqual(created.activeTaskId, null);
      assert.strictEqual(created.workspaceDir, "/tmp/vulcan-bots/bot-list-1");
      const listedBot = listed.find((bot) => bot.id === created.id);
      assert.isDefined(listedBot);
      assert.deepStrictEqual(listedBot?.avatar, { kind: "shape", shape: "happy", color: "teal" });
    }),
  );

  it.effect("persists durable takeover state and an append-only action ledger", () =>
    Effect.gen(function* () {
      const repository = yield* BotRepository;
      yield* runMigrations();

      const bot = yield* repository.createBot({
        id: BotId.makeUnsafe("bot-control-1"),
        input: {
          ...createInput,
          autonomy: { enabled: true, maxActiveRuns: 2 },
          capabilityGrants: ["thread.read", "browser.control"],
        },
        workspaceDir: "/tmp/vulcan-bots/bot-control-1",
        now: NOW,
      });
      yield* repository.setRuntimeState({
        botId: bot.id,
        phase: "takeover-requested",
        activeThreadId: ThreadId.makeUnsafe("thread-control-1"),
        takeoverReason: "Sign in is required.",
        updatedAt: LATER,
      });
      yield* repository.appendAuditEntry({
        id: BotAuditEntryId.makeUnsafe("audit-control-1"),
        botId: bot.id,
        taskId: null,
        threadId: ThreadId.makeUnsafe("thread-control-1"),
        capability: "browser.control",
        action: "browser.navigate",
        decision: "approval-required",
        summary: "Navigation paused for human takeover.",
        detailJson: JSON.stringify({ host: "example.com" }),
        createdAt: LATER,
      });

      const state = yield* repository.getRuntimeState({ botId: bot.id });
      const audit = yield* repository.listAuditEntries({ botId: bot.id, limit: 20 });

      assert.isTrue(Option.isSome(state));
      if (Option.isSome(state)) {
        assert.strictEqual(state.value.phase, "takeover-requested");
        assert.strictEqual(state.value.takeoverReason, "Sign in is required.");
      }
      assert.strictEqual(audit.length, 1);
      assert.strictEqual(audit[0]?.decision, "approval-required");
      assert.strictEqual(audit[0]?.capability, "browser.control");
    }),
  );

  it.effect("updates a bot with a full-row save", () =>
    Effect.gen(function* () {
      const repository = yield* BotRepository;
      yield* runMigrations();

      const created = yield* repository.createBot({
        id: BotId.makeUnsafe("bot-update-1"),
        input: createInput,
        workspaceDir: "/tmp/vulcan-bots/bot-update-1",
        now: NOW,
      });
      yield* repository.updateBot({
        ...created,
        name: "Maus 2",
        isPinned: true,
        updatedAt: LATER,
      });
      const reloaded = yield* repository.getBotById({ id: created.id });

      assert.isTrue(Option.isSome(reloaded));
      if (Option.isSome(reloaded)) {
        assert.strictEqual(reloaded.value.name, "Maus 2");
        assert.strictEqual(reloaded.value.isPinned, true);
        assert.strictEqual(reloaded.value.updatedAt, LATER);
      }
    }),
  );

  it.effect("archiveBot hides the bot from default lists and clears chief-of-staff", () =>
    Effect.gen(function* () {
      const repository = yield* BotRepository;
      yield* runMigrations();

      const created = yield* repository.createBot({
        id: BotId.makeUnsafe("bot-archive-1"),
        input: { ...createInput, chiefOfStaff: true },
        workspaceDir: "/tmp/vulcan-bots/bot-archive-1",
        now: NOW,
      });
      yield* repository.archiveBot({ id: created.id, archivedAt: LATER });

      const visible = yield* repository.listBots({ includeArchived: false });
      const all = yield* repository.listBots({ includeArchived: true });

      assert.isFalse(visible.some((bot) => bot.id === created.id));
      const archivedBot = all.find((bot) => bot.id === created.id);
      assert.isDefined(archivedBot);
      assert.strictEqual(archivedBot?.archivedAt, LATER);
      assert.strictEqual(archivedBot?.chiefOfStaff, false);
    }),
  );

  it.effect("enforces a single chief-of-staff bot", () =>
    Effect.gen(function* () {
      const repository = yield* BotRepository;
      yield* runMigrations();

      yield* repository.createBot({
        id: BotId.makeUnsafe("bot-cos-1"),
        input: { ...createInput, chiefOfStaff: true },
        workspaceDir: "/tmp/vulcan-bots/bot-cos-1",
        now: NOW,
      });
      const second = yield* repository
        .createBot({
          id: BotId.makeUnsafe("bot-cos-2"),
          input: { ...createInput, name: "Second", chiefOfStaff: true },
          workspaceDir: "/tmp/vulcan-bots/bot-cos-2",
          now: NOW,
        })
        .pipe(Effect.flip);

      assert.strictEqual(second._tag, "PersistenceSqlError");
    }),
  );

  it.effect("creates tasks, resolves the bot by thread id, and tracks the active task", () =>
    Effect.gen(function* () {
      const repository = yield* BotRepository;
      yield* runMigrations();

      const bot = yield* repository.createBot({
        id: BotId.makeUnsafe("bot-task-task-1"),
        input: createInput,
        workspaceDir: "/tmp/vulcan-bots/bot-task-task-1",
        now: NOW,
      });
      const task = yield* repository.createBotTask({
        id: BotTaskId.makeUnsafe("task-task-1"),
        botId: bot.id,
        threadId: ThreadId.makeUnsafe("thread-task-1"),
        pinnedProjectId: ProjectId.makeUnsafe("project-task-1"),
        title: "Research task",
        now: NOW,
      });
      yield* repository.setActiveBotTask({ botId: bot.id, taskId: task.id, updatedAt: LATER });

      const byThread = yield* repository.getBotByThreadId({
        threadId: ThreadId.makeUnsafe("thread-task-1"),
      });
      const missing = yield* repository.getBotByThreadId({
        threadId: ThreadId.makeUnsafe("thread-task-unknown"),
      });
      const tasks = yield* repository.listBotTasks({ botId: bot.id });
      const byProject = yield* repository.listBotTasksByProject({
        projectId: ProjectId.makeUnsafe("project-task-1"),
      });
      const reloaded = yield* repository.getBotById({ id: bot.id });

      assert.isTrue(Option.isSome(byThread));
      if (Option.isSome(byThread)) {
        assert.strictEqual(byThread.value.id, bot.id);
      }
      assert.isTrue(Option.isNone(missing));
      assert.strictEqual(tasks.length, 1);
      assert.strictEqual(tasks[0]?.pinnedProjectId, "project-task-1");
      assert.strictEqual(byProject.length, 1);
      assert.isTrue(Option.isSome(reloaded));
      if (Option.isSome(reloaded)) {
        assert.strictEqual(reloaded.value.activeTaskId, task.id);
      }
    }),
  );

  it.effect("archiveBotTask clears the bot's active-task pointer", () =>
    Effect.gen(function* () {
      const repository = yield* BotRepository;
      yield* runMigrations();

      const bot = yield* repository.createBot({
        id: BotId.makeUnsafe("bot-archtask-archtask-1"),
        input: createInput,
        workspaceDir: "/tmp/vulcan-bots/bot-archtask-archtask-1",
        now: NOW,
      });
      const task = yield* repository.createBotTask({
        id: BotTaskId.makeUnsafe("task-archtask-1"),
        botId: bot.id,
        threadId: ThreadId.makeUnsafe("thread-archtask-1"),
        title: "Research task",
        now: NOW,
      });
      yield* repository.setActiveBotTask({ botId: bot.id, taskId: task.id, updatedAt: NOW });

      const archived = yield* repository.archiveBotTask({ taskId: task.id, archivedAt: LATER });
      const reloaded = yield* repository.getBotById({ id: bot.id });
      const visibleTasks = yield* repository.listBotTasks({ botId: bot.id });

      assert.isTrue(Option.isSome(archived));
      if (Option.isSome(archived)) {
        assert.strictEqual(archived.value.archivedAt, LATER);
      }
      assert.isTrue(Option.isSome(reloaded));
      if (Option.isSome(reloaded)) {
        assert.strictEqual(reloaded.value.activeTaskId, null);
      }
      assert.strictEqual(visibleTasks.length, 0);
    }),
  );

  it.effect("clearBotTaskForDeletedThread archives the orphaned task once", () =>
    Effect.gen(function* () {
      const repository = yield* BotRepository;
      yield* runMigrations();

      const bot = yield* repository.createBot({
        id: BotId.makeUnsafe("bot-clear-1"),
        input: createInput,
        workspaceDir: "/tmp/vulcan-bots/bot-clear-1",
        now: NOW,
      });
      yield* repository.createBotTask({
        id: BotTaskId.makeUnsafe("task-clear-1"),
        botId: bot.id,
        threadId: ThreadId.makeUnsafe("thread-clear-1"),
        title: "Research task",
        now: NOW,
      });

      const first = yield* repository.clearBotTaskForDeletedThread({
        threadId: ThreadId.makeUnsafe("thread-clear-1"),
        archivedAt: LATER,
      });
      const second = yield* repository.clearBotTaskForDeletedThread({
        threadId: ThreadId.makeUnsafe("thread-clear-1"),
        archivedAt: LATER,
      });

      assert.isTrue(Option.isSome(first));
      assert.isTrue(Option.isNone(second));
    }),
  );

  it.effect("deleteBot removes the bot and its tasks", () =>
    Effect.gen(function* () {
      const repository = yield* BotRepository;
      yield* runMigrations();

      const bot = yield* repository.createBot({
        id: BotId.makeUnsafe("bot-delete-1"),
        input: createInput,
        workspaceDir: "/tmp/vulcan-bots/bot-delete-1",
        now: NOW,
      });
      yield* repository.createBotTask({
        id: BotTaskId.makeUnsafe("task-delete-1"),
        botId: bot.id,
        threadId: ThreadId.makeUnsafe("thread-delete-1"),
        title: "Research task",
        now: NOW,
      });

      yield* repository.deleteBot({ id: bot.id });

      const bots = yield* repository.listBots({ includeArchived: true });
      const tasks = yield* repository.listBotTasks({ includeArchived: true });

      assert.isFalse(bots.some((candidate) => candidate.id === bot.id));
      assert.isFalse(tasks.some((task) => task.botId === bot.id));
    }),
  );

  it.effect("touchMemoryUpdatedAt persists without altering the bot row shape", () =>
    Effect.gen(function* () {
      const repository = yield* BotRepository;
      yield* runMigrations();

      const bot = yield* repository.createBot({
        id: BotId.makeUnsafe("bot-touch-1"),
        input: createInput,
        workspaceDir: "/tmp/vulcan-bots/bot-touch-1",
        now: NOW,
      });
      yield* repository.touchMemoryUpdatedAt({ id: bot.id, updatedAt: LATER });

      const reloaded = yield* repository.getBotById({ id: bot.id });
      assert.isTrue(Option.isSome(reloaded));
      if (Option.isSome(reloaded)) {
        assert.strictEqual(reloaded.value.updatedAt, NOW);
      }
    }),
  );
});
