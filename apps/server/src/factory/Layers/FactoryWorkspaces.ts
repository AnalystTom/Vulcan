import { Effect, Layer, Option } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { FactoryWorkspaces, type FactoryWorkspacesShape } from "../Services/FactoryWorkspaces.ts";

/**
 * Resolves a run's working directory exactly the way the rest of the app does.
 *
 * `resolveThreadWorkspaceCwd` is the same helper terminals, checkpoints, the
 * agent gateway, and the diff query already use, so a factory run and an Agent
 * Pane looking at the same thread can never disagree about which checkout they
 * are working in.
 */
const makeFactoryWorkspaces = Effect.gen(function* () {
  const projections = yield* ProjectionSnapshotQuery;

  const resolveThreadWorkspacePath: FactoryWorkspacesShape["resolveThreadWorkspacePath"] = (
    threadId,
  ) =>
    projections.getThreadCheckpointContext(threadId).pipe(
      Effect.map((context) =>
        Option.isNone(context)
          ? null
          : (resolveThreadWorkspaceCwd({
              thread: {
                projectId: context.value.projectId,
                envMode: context.value.envMode,
                worktreePath: context.value.worktreePath,
                workingDirectory: context.value.workingDirectory,
              },
              projects: [
                {
                  id: context.value.projectId,
                  kind: context.value.projectKind,
                  workspaceRoot: context.value.workspaceRoot,
                },
              ],
            }) ?? null),
      ),
      // A projection that cannot be read is "no workspace yet", not a crash: the
      // controller must keep supervising every other run.
      Effect.catchCause(() => Effect.succeed(null)),
    );

  return { resolveThreadWorkspacePath } satisfies FactoryWorkspacesShape;
});

export const FactoryWorkspacesLive = Layer.effect(FactoryWorkspaces, makeFactoryWorkspaces);
