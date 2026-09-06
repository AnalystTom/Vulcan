import type { BotControlAction, BotRuntimeState, ThreadId } from "@vulcan/contracts";

export interface BotControlTransitionInput {
  readonly action: BotControlAction;
  readonly activeThreadId?: ThreadId | null;
  readonly reason?: string;
  readonly now: string;
}

function invalid(action: BotControlAction, phase: BotRuntimeState["phase"]): never {
  const label = action.replaceAll("-", " ");
  throw new Error(`Cannot ${label} while the bot is ${phase}.`);
}

/** Pure, fail-closed takeover state machine shared by RPC and autonomous execution. */
export function transitionBotControl(
  current: BotRuntimeState,
  input: BotControlTransitionInput,
): BotRuntimeState {
  const withTime = (patch: Partial<BotRuntimeState>): BotRuntimeState => ({
    ...current,
    ...patch,
    updatedAt: input.now,
  });

  switch (input.action) {
    case "request-takeover": {
      if (current.phase !== "running" && current.phase !== "waiting-for-approval") {
        return invalid(input.action, current.phase);
      }
      const reason = input.reason?.trim();
      if (!reason) throw new Error("A takeover request requires a reason.");
      return withTime({
        phase: "takeover-requested",
        activeThreadId: input.activeThreadId ?? current.activeThreadId,
        takeoverReason: reason,
      });
    }
    case "take-control":
      if (current.phase !== "takeover-requested") return invalid(input.action, current.phase);
      return withTime({ phase: "human-control" });
    case "release-control":
      if (current.phase !== "human-control") return invalid(input.action, current.phase);
      // Releasing never silently resumes autonomy. The human explicitly resumes next.
      return withTime({ phase: "paused", takeoverReason: null });
    case "pause":
      if (current.phase === "human-control" || current.phase === "takeover-requested") {
        return invalid(input.action, current.phase);
      }
      return withTime({ phase: "paused", takeoverReason: null });
    case "resume":
      if (current.phase !== "paused" && current.phase !== "error") {
        return invalid(input.action, current.phase);
      }
      return withTime({ phase: "idle", activeThreadId: null, takeoverReason: null });
  }
}
