import type { Bot, OrchestrationProjectShell } from "@vulcan/contracts";
import { buildTemporaryWorktreeBranchName } from "@vulcan/shared/git";
import { Effect } from "effect";

import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { BotServiceError } from "./Errors.ts";

export interface BotTaskEnvironment {
  readonly envMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly workingDirectory: string;
  readonly associatedWorktreePath: string | null;
  readonly associatedWorktreeBranch: string | null;
  readonly associatedWorktreeRef: string | null;
}

/** Provision the filesystem boundary before a bot task thread exists. */
export function provisionBotTaskEnvironment(input: {
  readonly bot: Bot;
  readonly pinnedProject: OrchestrationProjectShell | undefined;
  readonly workspaceDir: string;
  readonly git: Pick<GitCoreShape, "statusDetails" | "createDetachedWorktree">;
}): Effect.Effect<BotTaskEnvironment, BotServiceError> {
  if (!input.pinnedProject || input.bot.isolationMode === "workspace") {
    return Effect.succeed({
      envMode: "local",
      branch: null,
      worktreePath: null,
      workingDirectory: input.workspaceDir,
      associatedWorktreePath: null,
      associatedWorktreeBranch: null,
      associatedWorktreeRef: null,
    });
  }

  const project = input.pinnedProject;
  return input.git.statusDetails(project.workspaceRoot).pipe(
    Effect.mapError(
      (cause) => new BotServiceError({ message: "Failed to inspect the pinned project.", cause }),
    ),
    Effect.flatMap((status) =>
      status.isRepo
        ? input.git
            .createDetachedWorktree({
              cwd: project.workspaceRoot,
              ref: "HEAD",
              path: null,
              copyChangesFrom: project.workspaceRoot,
              newBranch: buildTemporaryWorktreeBranchName(),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new BotServiceError({
                    message: "Failed to create the bot's isolated worktree.",
                    cause,
                  }),
              ),
              Effect.map((created) => ({
                envMode: "worktree" as const,
                branch: created.worktree.branch,
                worktreePath: created.worktree.path,
                workingDirectory: created.worktree.path,
                associatedWorktreePath: created.worktree.path,
                associatedWorktreeBranch: created.worktree.branch,
                associatedWorktreeRef: created.worktree.ref,
              })),
            )
        : Effect.fail(
            new BotServiceError({
              message:
                "This bot requires an isolated Git worktree, but the pinned project is not a Git repository.",
            }),
          ),
    ),
  );
}
