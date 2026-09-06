import {
  AutomationId,
  BotId,
  BotTaskId,
  ProjectId,
  ThreadId,
  type AutomationDefinition,
  type BotTask,
} from "@vulcan/contracts";
import { describe, expect, it } from "vitest";
import { botResponsibilities, RESPONSIBILITY_EVIDENCE_INSTRUCTIONS } from "./botResponsibilities";

describe("botResponsibilities", () => {
  it("matches ownership by continued task, never by project or originating conversation", () => {
    const now = "2026-09-06T09:00:00.000Z";
    const threadId = ThreadId.makeUnsafe("bot-thread");
    const task: BotTask = {
      id: BotTaskId.makeUnsafe("task"),
      botId: BotId.makeUnsafe("bot"),
      threadId,
      title: "Outreach",
      pinnedProjectId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: now,
    };
    const base: AutomationDefinition = {
      id: AutomationId.makeUnsafe("owned"),
      projectId: ProjectId.makeUnsafe("bots"),
      sourceThreadId: null,
      name: "Outreach",
      prompt: "Verify deliveries",
      schedule: { type: "daily", timeOfDay: "09:00" },
      enabled: false,
      nextRunAt: null,
      modelSelection: { provider: "codex", model: "selected-model" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      worktreeMode: "auto",
      mode: "heartbeat",
      targetThreadId: threadId,
      maxIterations: null,
      stopOnError: true,
      minimumIntervalSeconds: 60,
      maxRuntimeSeconds: null,
      retryPolicy: { type: "none" },
      misfirePolicy: "coalesce",
      acknowledgedRisks: [],
      iterationCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    const definitions = [
      base,
      {
        ...base,
        id: AutomationId.makeUnsafe("unowned"),
        targetThreadId: ThreadId.makeUnsafe("another"),
        sourceThreadId: threadId,
      },
      { ...base, id: AutomationId.makeUnsafe("standalone"), mode: "standalone" as const },
      { ...base, id: AutomationId.makeUnsafe("archived"), archivedAt: now },
    ];
    expect(botResponsibilities([task], definitions).map((entry) => entry.id)).toEqual([base.id]);
    expect(botResponsibilities([], definitions)).toEqual([]);
  });

  it("requires evidence and reconciliation for recurring work", () => {
    expect(RESPONSIBILITY_EVIDENCE_INSTRUCTIONS).toContain("never blindly resend");
    expect(RESPONSIBILITY_EVIDENCE_INSTRUCTIONS).toContain("not proof of delivery");
  });
});
