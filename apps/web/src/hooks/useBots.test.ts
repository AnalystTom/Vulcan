import { BotId, BotTaskId, ProjectId, ThreadId } from "@vulcan/contracts";
import { describe, expect, it } from "vitest";

import { reduceBotEvent } from "./useBots";

const now = "2026-08-19T12:00:00.000Z";
const botId = BotId.makeUnsafe("bot-1");
const bot = {
  id: botId,
  name: "Maus",
  title: "Chief of Staff",
  description: "Coordinates work.",
  avatar: { kind: "shape" as const, shape: "happy" as const, color: "teal" as const },
  modelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  isolationMode: "worktree" as const,
  autonomy: { enabled: false, maxActiveRuns: 1 },
  capabilityGrants: ["thread.read" as const, "filesystem.read" as const],
  chiefOfStaff: true,
  approvePeerComms: false,
  isPinned: false,
  isHidden: false,
  activeTaskId: null,
  workspaceDir: "/tmp/bots/bot-1",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
};
const task = {
  id: BotTaskId.makeUnsafe("task-1"),
  botId,
  threadId: ThreadId.makeUnsafe("thread-1"),
  pinnedProjectId: ProjectId.makeUnsafe("project-1"),
  title: "First task",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
};

describe("reduceBotEvent", () => {
  it("applies a snapshot and later upserts without duplicating rows", () => {
    const snapshot = reduceBotEvent(
      { bots: [], tasks: [] },
      { type: "snapshot", bots: [bot], tasks: [task] },
    );
    const updated = reduceBotEvent(snapshot, {
      type: "bot.upserted",
      bot: { ...bot, title: "Updated role" },
    });

    expect(updated.bots).toHaveLength(1);
    expect(updated.bots[0]?.title).toBe("Updated role");
    expect(updated.tasks).toEqual([task]);
  });

  it("removes a deleted bot and its tasks", () => {
    const result = reduceBotEvent({ bots: [bot], tasks: [task] }, { type: "bot.deleted", botId });
    expect(result).toEqual({ bots: [], tasks: [], runtimeStates: [] });
  });
});
