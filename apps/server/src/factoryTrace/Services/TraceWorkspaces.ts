/**
 * Where a thread's checkout lives.
 *
 * One method, because that is the whole question. The path is *derived*, never
 * stored on the run: a Run belongs to a thread, the thread owns its workspace,
 * and the workspace owns its worktree. Copying the path onto the run would
 * duplicate a fact that can then disagree -- a thread handed off from local to a
 * worktree would leave its run pointing at the old checkout.
 *
 * Deriving also means the path survives a restart for free. The controller
 * re-resolves it every tick instead of remembering it.
 *
 * This exists as its own service rather than the runner reaching into the
 * projection read model directly, so the runner's dependency is "something that
 * can tell me where a thread lives" rather than the entire orchestration graph.
 */
import type { ThreadId } from "@vulcan/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface TraceWorkspacesShape {
  /**
   * The absolute working directory for a thread, or null when it has none yet --
   * a worktree still being created, or a thread whose project is gone.
   *
   * Null is an ordinary answer, not an error: the controller simply leaves that
   * run for a later tick rather than executing somewhere arbitrary.
   */
  readonly resolveThreadWorkspacePath: (threadId: ThreadId) => Effect.Effect<string | null>;
}

export class TraceWorkspaces extends ServiceMap.Service<TraceWorkspaces, TraceWorkspacesShape>()(
  "vulcan/factoryTrace/Services/TraceWorkspaces/TraceWorkspaces",
) {}
