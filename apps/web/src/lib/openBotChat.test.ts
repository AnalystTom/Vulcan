// FILE: openBotChat.test.ts
// Purpose: Unit tests for chat-first bot navigation helpers.
// Layer: Web unit tests

import { describe, expect, it, vi } from "vitest";

import { findBotTaskForThread, openBotChat, resolveBotChatTask } from "./openBotChat";

function makeBot(overrides: Partial<{ id: string; activeTaskId: string | null }> = {}) {
  return {
    id: overrides.id ?? "bot-1",
    activeTaskId: overrides.activeTaskId ?? null,
    defaultProjectId: null,
  } as Parameters<typeof openBotChat>[0]["bot"];
}

function makeTask(
  overrides: Partial<{
    id: string;
    botId: string;
    threadId: string;
    archivedAt: string | null;
  }> = {},
) {
  return {
    id: overrides.id ?? "task-1",
    botId: overrides.botId ?? "bot-1",
    threadId: overrides.threadId ?? "thread-1",
    archivedAt: overrides.archivedAt ?? null,
  } as Parameters<typeof openBotChat>[0]["tasks"][number];
}

describe("resolveBotChatTask", () => {
  it("prefers the bot's active task", () => {
    const bot = makeBot({ activeTaskId: "task-2" });
    const tasks = [
      makeTask({ id: "task-1", threadId: "t1" }),
      makeTask({ id: "task-2", threadId: "t2" }),
    ];
    expect(resolveBotChatTask(bot, tasks)?.id).toBe("task-2");
  });

  it("falls back to the first active task", () => {
    const bot = makeBot({ activeTaskId: null });
    const tasks = [
      makeTask({ id: "task-1", threadId: "t1" }),
      makeTask({ id: "task-2", threadId: "t2", archivedAt: "2026-01-01" }),
    ];
    expect(resolveBotChatTask(bot, tasks)?.id).toBe("task-1");
  });
});

describe("findBotTaskForThread", () => {
  it("finds the live task for a thread", () => {
    const tasks = [makeTask({ threadId: "thread-9" })];
    expect(findBotTaskForThread(tasks, "thread-9")?.threadId).toBe("thread-9");
  });
});

describe("openBotChat", () => {
  it("navigates to the existing active task", async () => {
    const navigateToThread = vi.fn();
    const setActiveTask = vi.fn(async () => undefined);
    const createTask = vi.fn();
    const bot = makeBot({ activeTaskId: "task-1" });
    const task = makeTask({ id: "task-1", threadId: "thread-1" });

    await openBotChat({
      bot,
      tasks: [task],
      createTask,
      setActiveTask,
      navigateToThread,
    });

    expect(createTask).not.toHaveBeenCalled();
    expect(setActiveTask).not.toHaveBeenCalled();
    expect(navigateToThread).toHaveBeenCalledWith("thread-1");
  });

  it("creates a General task when the bot has none", async () => {
    const navigateToThread = vi.fn();
    const setActiveTask = vi.fn(async () => undefined);
    const createTask = vi.fn(async () => ({
      task: makeTask({ id: "task-new", threadId: "thread-new" }),
    }));
    const bot = makeBot({ activeTaskId: null });

    await openBotChat({
      bot,
      tasks: [],
      createTask,
      setActiveTask,
      navigateToThread,
    });

    expect(createTask).toHaveBeenCalledWith({
      botId: "bot-1",
      title: "New task",
    });
    expect(navigateToThread).toHaveBeenCalledWith("thread-new");
  });
});
