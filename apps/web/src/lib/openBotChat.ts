// FILE: openBotChat.ts
// Purpose: Open a bot the OpenBot/Maus way — land in its active task chat, creating one if needed.
// Layer: Web helper
// Exports: resolveBotChatTask, openBotChat

import type { Bot, BotTask, BotTaskCreateInput, ProjectId } from "@vulcan/contracts";

export function resolveBotChatTask(bot: Bot, tasks: readonly BotTask[]): BotTask | null {
  const active = tasks.filter((task) => task.botId === bot.id && task.archivedAt === null);
  if (bot.activeTaskId) {
    const match = active.find((task) => task.id === bot.activeTaskId);
    if (match) return match;
  }
  return active[0] ?? null;
}

export function findBotTaskForThread(tasks: readonly BotTask[], threadId: string): BotTask | null {
  return tasks.find((task) => task.threadId === threadId && task.archivedAt === null) ?? null;
}

export async function openBotChat(input: {
  readonly bot: Bot;
  readonly tasks: readonly BotTask[];
  readonly createTask: (payload: BotTaskCreateInput) => Promise<{ readonly task: BotTask }>;
  readonly setActiveTask: (task: BotTask) => Promise<unknown>;
  readonly navigateToThread: (threadId: string) => void | Promise<unknown>;
}): Promise<string> {
  const existing = resolveBotChatTask(input.bot, input.tasks);
  if (existing) {
    if (input.bot.activeTaskId !== existing.id) {
      await input.setActiveTask(existing);
    }
    await input.navigateToThread(existing.threadId);
    return existing.threadId;
  }

  const created = await input.createTask({
    botId: input.bot.id,
    title: "New task",
    ...(input.bot.defaultProjectId
      ? { pinnedProjectId: input.bot.defaultProjectId as ProjectId }
      : {}),
  });
  await input.navigateToThread(created.task.threadId);
  return created.task.threadId;
}
