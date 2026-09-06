import { BotId, BotTaskId, ThreadId } from "@vulcan/contracts";
import { describe, expect, it } from "vitest";

import { buildBotWorkGraph } from "./botWorkGraph";

const timestamp = "2026-08-21T12:00:00.000Z";
const botId = BotId.makeUnsafe("bot-1");

const bot = {
  id: botId,
  name: "Coordinator",
  title: "",
  description: "",
  avatar: { kind: "shape" as const, color: "teal" as const },
  modelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  isolationMode: "workspace" as const,
  autonomy: { enabled: false, maxActiveRuns: 1 },
  capabilityGrants: [],
  chiefOfStaff: false,
  approvePeerComms: false,
  isPinned: false,
  isHidden: false,
  activeTaskId: null,
  workspaceDir: "/tmp/bot-1",
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: null,
};

describe("buildBotWorkGraph", () => {
  it("draws only persisted, active task ownership links", () => {
    const graph = buildBotWorkGraph({
      bots: [bot],
      runtimeStates: [],
      tasks: [
        {
          id: BotTaskId.makeUnsafe("task-visible"),
          botId,
          threadId: ThreadId.makeUnsafe("thread-1"),
          pinnedProjectId: null,
          title: "Review graph UI",
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: null,
        },
        {
          id: BotTaskId.makeUnsafe("task-archived"),
          botId,
          threadId: ThreadId.makeUnsafe("thread-2"),
          pinnedProjectId: null,
          title: "Old work",
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: timestamp,
        },
      ],
    });

    expect(graph.nodes.map((node) => node.label)).toEqual(["Coordinator", "Review graph UI"]);
    expect(graph.edges).toEqual([
      { id: "assignment:task-visible", from: "bot:bot-1", to: "task:task-visible" },
    ]);
  });
});
