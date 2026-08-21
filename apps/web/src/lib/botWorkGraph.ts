import type { BotListResult } from "@vulcan/contracts";

export type BotWorkGraphNode = {
  readonly id: string;
  readonly kind: "bot" | "task";
  readonly label: string;
  readonly botId: string;
};

export type BotWorkGraphEdge = {
  readonly id: string;
  readonly from: string;
  readonly to: string;
};

export type BotWorkGraph = {
  readonly nodes: ReadonlyArray<BotWorkGraphNode>;
  readonly edges: ReadonlyArray<BotWorkGraphEdge>;
  readonly omittedTaskCount: number;
};

const MAX_TASK_NODES = 24;

/**
 * This is deliberately based only on persisted BotTask records. A task edge
 * means an agent owns that normal Vulcan thread; it never implies a peer
 * message or a reporting line that the product has not recorded.
 */
export function buildBotWorkGraph(data: BotListResult): BotWorkGraph {
  const activeTasks = data.tasks
    .filter((task) => task.archivedAt === null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const visibleTasks = activeTasks.slice(0, MAX_TASK_NODES);

  return {
    nodes: [
      ...data.bots.map((bot) => ({
        id: `bot:${bot.id}`,
        kind: "bot" as const,
        label: bot.name,
        botId: bot.id,
      })),
      ...visibleTasks.map((task) => ({
        id: `task:${task.id}`,
        kind: "task" as const,
        label: task.title,
        botId: task.botId,
      })),
    ],
    edges: visibleTasks.map((task) => ({
      id: `assignment:${task.id}`,
      from: `bot:${task.botId}`,
      to: `task:${task.id}`,
    })),
    omittedTaskCount: activeTasks.length - visibleTasks.length,
  };
}
