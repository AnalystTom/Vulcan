import { describe, expect, it } from "vitest";

import { ProjectId, ThreadId } from "@vulcan/contracts";

import type { Project, SidebarThreadSummary, ThreadSession } from "../types";
import {
  activeAgentAriaLabel,
  activeAgentStatusLabel,
  buildActiveAgentViewModel,
  collectActiveAgentThreadIds,
  isActiveAgentThread,
} from "./ActiveAgentPanel.logic";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");

function makeProject(id: ProjectId = PROJECT_ID): Project {
  return {
    id,
    kind: "project",
    name: "Agent Panel",
    remoteName: "Agent Panel",
    folderName: "Agent_panel",
    localName: null,
    cwd: "/repo",
    defaultModelSelection: null,
    expanded: true,
    scripts: [],
  };
}

function makeSession(status: ThreadSession["status"], updatedAt: string): ThreadSession {
  return {
    provider: "codex",
    status,
    activeTurnId: status === "running" ? ("turn-1" as never) : undefined,
    createdAt: "2026-08-15T09:00:00.000Z",
    updatedAt,
    orchestrationStatus:
      status === "running" ? "running" : status === "connecting" ? "starting" : "idle",
  };
}

function makeThread(input: {
  id: string;
  session?: ThreadSession | null;
  hasLiveTailWork?: boolean;
  latestTurn?: SidebarThreadSummary["latestTurn"];
  archivedAt?: string | null;
  parentThreadId?: string | null;
  updatedAt?: string;
  projectId?: ProjectId;
}): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(input.id),
    projectId: input.projectId ?? PROJECT_ID,
    title: `Thread ${input.id}`,
    modelSelection: { provider: "codex", model: "gpt-5" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: input.session ?? null,
    createdAt: "2026-08-15T08:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-08-15T09:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
    settledAt: null,
    isPinned: false,
    latestTurn: input.latestTurn ?? null,
    lastVisitedAt: undefined,
    parentThreadId: input.parentThreadId ? ThreadId.makeUnsafe(input.parentThreadId) : null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: input.hasLiveTailWork ?? false,
  };
}

describe("isActiveAgentThread", () => {
  it("includes running and connecting top-level unarchived threads", () => {
    expect(
      isActiveAgentThread(
        makeThread({
          id: "running",
          session: makeSession("running", "2026-08-15T09:10:00.000Z"),
        }),
      ),
    ).toBe(true);
    expect(
      isActiveAgentThread(
        makeThread({
          id: "connecting",
          session: makeSession("connecting", "2026-08-15T09:10:00.000Z"),
        }),
      ),
    ).toBe(true);
  });

  it("excludes archived, child, and idle threads", () => {
    expect(
      isActiveAgentThread(
        makeThread({
          id: "archived",
          archivedAt: "2026-08-15T09:30:00.000Z",
          session: makeSession("running", "2026-08-15T09:10:00.000Z"),
        }),
      ),
    ).toBe(false);
    expect(
      isActiveAgentThread(
        makeThread({
          id: "child",
          parentThreadId: "parent",
          session: makeSession("running", "2026-08-15T09:10:00.000Z"),
        }),
      ),
    ).toBe(false);
    expect(
      isActiveAgentThread(
        makeThread({
          id: "idle",
          session: makeSession("ready", "2026-08-15T09:10:00.000Z"),
        }),
      ),
    ).toBe(false);
  });
});

describe("buildActiveAgentViewModel", () => {
  it("orders active agents by freshest runtime signal and keeps real project labels", () => {
    const older = makeThread({
      id: "older",
      session: makeSession("running", "2026-08-15T09:10:00.000Z"),
    });
    const newer = makeThread({
      id: "newer",
      session: makeSession("connecting", "2026-08-15T09:20:00.000Z"),
    });
    const idle = makeThread({
      id: "idle",
      session: makeSession("ready", "2026-08-15T09:30:00.000Z"),
    });

    const model = buildActiveAgentViewModel({
      threads: [older, idle, newer],
      projectById: new Map([[PROJECT_ID, makeProject()]]),
    });

    expect(model.map((agent) => agent.thread.id)).toEqual([
      ThreadId.makeUnsafe("newer"),
      ThreadId.makeUnsafe("older"),
    ]);
    expect(model.map((agent) => agent.projectLabel)).toEqual(["Agent Panel", "Agent Panel"]);
    expect(collectActiveAgentThreadIds(model)).toEqual([
      ThreadId.makeUnsafe("newer"),
      ThreadId.makeUnsafe("older"),
    ]);
  });
});

describe("active agent presentation helpers", () => {
  it("formats count and status labels", () => {
    const runningSession = makeSession("running", "2026-08-15T09:10:00.000Z");
    expect(activeAgentAriaLabel(1)).toBe("1 active agent");
    expect(activeAgentAriaLabel(2)).toBe("2 active agents");
    expect(activeAgentStatusLabel({ state: "connecting", session: null })).toBe("Connecting");
    expect(activeAgentStatusLabel({ state: "working", session: runningSession })).toBe("Working");
    expect(activeAgentStatusLabel({ state: "working", session: null })).toBe("Live");
  });
});
