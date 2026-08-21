import { BotId, ProjectId } from "@vulcan/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { provisionBotTaskEnvironment } from "./botIsolation.ts";

const bot = {
  id: BotId.makeUnsafe("bot-1"),
  name: "Scout",
  title: "Researcher",
  description: "",
  avatar: { kind: "shape" as const, shape: "working" as const, color: "teal" as const },
  modelSelection: { provider: "codex" as const, model: "gpt-5.6-sol" },
  providerOptions: null,
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  isolationMode: "worktree" as const,
  autonomy: { enabled: true, maxActiveRuns: 1 },
  capabilityGrants: ["thread.read" as const],
  defaultWorkingDirectory: null,
  defaultProjectId: null,
  chiefOfStaff: false,
  approvePeerComms: false,
  isPinned: false,
  isHidden: false,
  activeTaskId: null,
  workspaceDir: "/bots/bot-1",
  createdAt: "2026-08-21T20:00:00.000Z",
  updatedAt: "2026-08-21T20:00:00.000Z",
  archivedAt: null,
};

const project = {
  id: ProjectId.makeUnsafe("project-1"),
  kind: "project" as const,
  title: "App",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  scripts: [],
  isPinned: false,
  spaceId: null,
  createdAt: "2026-08-21T20:00:00.000Z",
  updatedAt: "2026-08-21T20:00:00.000Z",
};

describe("provisionBotTaskEnvironment", () => {
  it("keeps workspace-isolated bots inside their private workspace", async () => {
    const statusDetails = vi.fn();
    const result = await Effect.runPromise(
      provisionBotTaskEnvironment({
        bot: { ...bot, isolationMode: "workspace" },
        pinnedProject: project,
        workspaceDir: "/bots/bot-1",
        git: { statusDetails, createDetachedWorktree: vi.fn() } as never,
      }),
    );
    expect(result).toMatchObject({ envMode: "local", workingDirectory: "/bots/bot-1" });
    expect(statusDetails).not.toHaveBeenCalled();
  });

  it("creates a managed worktree for a project-scoped task", async () => {
    const createDetachedWorktree = vi.fn(() =>
      Effect.succeed({
        worktree: { path: "/worktrees/scout", branch: "vulcan/12345678", ref: "HEAD" },
      }),
    );
    const result = await Effect.runPromise(
      provisionBotTaskEnvironment({
        bot,
        pinnedProject: project,
        workspaceDir: "/bots/bot-1",
        git: {
          statusDetails: () => Effect.succeed({ isRepo: true }),
          createDetachedWorktree,
        } as never,
      }),
    );
    expect(result).toEqual({
      envMode: "worktree",
      branch: "vulcan/12345678",
      worktreePath: "/worktrees/scout",
      workingDirectory: "/worktrees/scout",
      associatedWorktreePath: "/worktrees/scout",
      associatedWorktreeBranch: "vulcan/12345678",
      associatedWorktreeRef: "HEAD",
    });
    expect(createDetachedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo", copyChangesFrom: "/repo", ref: "HEAD" }),
    );
  });

  it("fails closed when project worktree isolation is impossible", async () => {
    const error = await Effect.runPromise(
      Effect.flip(provisionBotTaskEnvironment({
        bot,
        pinnedProject: project,
        workspaceDir: "/bots/bot-1",
        git: {
          statusDetails: () => Effect.succeed({ isRepo: false }),
          createDetachedWorktree: vi.fn(),
        } as never,
      })),
    );
    expect(error.message).toContain("not a Git repository");
  });
});
