import { resolveBotAutonomy, resolveBotCapabilityGrants } from "~/lib/botDefaults";
import type { Bot, BotControlAction, BotRuntimeState, BotTask } from "@vulcan/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { ChiefOfStaffCallPanel } from "./ChiefOfStaffCallPanel";

const PHASE_LABELS: Record<BotRuntimeState["phase"], string> = {
  idle: "Idle",
  running: "Working",
  "waiting-for-approval": "Waiting for approval",
  "takeover-requested": "Takeover requested",
  "human-control": "Human in control",
  paused: "Paused",
  error: "Needs attention",
};

export function BotAutonomyPanel({
  bot,
  tasks,
  state,
  busy,
  onControl,
  onRun,
}: {
  bot: Bot;
  tasks: readonly BotTask[];
  state: BotRuntimeState;
  busy: boolean;
  onControl: (action: BotControlAction, reason?: string) => Promise<void>;
  onRun: (task: BotTask, prompt: string) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const activeTask = tasks.find((task) => task.id === bot.activeTaskId && task.archivedAt === null);
  const audit = useQuery({
    queryKey: ["bot-audit", bot.id],
    queryFn: () => ensureNativeApi().bots.listAudit({ botId: bot.id, limit: 30 }),
    refetchInterval: state.phase === "idle" ? false : 3_000,
  });
  const autonomy = resolveBotAutonomy(bot);
  const capabilityGrants = resolveBotCapabilityGrants(bot);
  const canRun =
    autonomy.enabled &&
    capabilityGrants.includes("thread.write") &&
    state.phase === "idle" &&
    activeTask !== undefined;

  const control = async (action: BotControlAction, reason?: string) => {
    await onControl(action, reason);
    await audit.refetch();
  };

  return (
    <div className="space-y-10">
      {bot.chiefOfStaff ? <ChiefOfStaffCallPanel bot={bot} /> : null}
      <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-base font-semibold">Coworker control</h2>
          <p className="text-xs text-muted-foreground">
            Durable runtime state, explicit takeover, and an append-only action record.
          </p>
        </div>
        <span className="rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium">
          {PHASE_LABELS[state.phase]}
        </span>
      </div>

      {state.takeoverReason ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          {state.takeoverReason}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {state.phase === "running" || state.phase === "waiting-for-approval" ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => control("request-takeover", "Human requested control from Vulcan.")}
          >
            Request takeover
          </Button>
        ) : null}
        {state.phase === "takeover-requested" ? (
          <Button disabled={busy} onClick={() => control("take-control")}>
            Take control
          </Button>
        ) : null}
        {state.phase === "human-control" ? (
          <Button variant="outline" disabled={busy} onClick={() => control("release-control")}>
            Release control
          </Button>
        ) : null}
        {state.phase === "idle" ||
        state.phase === "running" ||
        state.phase === "waiting-for-approval" ? (
          <Button variant="outline" disabled={busy} onClick={() => control("pause")}>
            Pause
          </Button>
        ) : null}
        {state.phase === "paused" || state.phase === "error" ? (
          <Button variant="outline" disabled={busy} onClick={() => control("resume")}>
            Resume to idle
          </Button>
        ) : null}
      </div>

      <form
        className="space-y-2 rounded-xl border border-border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          const nextPrompt = prompt.trim();
          if (!canRun || !activeTask || !nextPrompt) return;
          void onRun(activeTask, nextPrompt).then(async () => {
            setPrompt("");
            await audit.refetch();
          });
        }}
      >
        <div>
          <p className="text-sm font-medium">Start autonomous work</p>
          <p className="text-xs text-muted-foreground">
            Runs in the active task’s isolated environment. The bot stops for provider approvals.
          </p>
        </div>
        <Textarea
          aria-label="Autonomous task prompt"
          placeholder="Describe the outcome and constraints for this run."
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        {!autonomy.enabled ? (
          <p className="text-xs text-muted-foreground">Enable autonomous coworker in Settings.</p>
        ) : !capabilityGrants.includes("thread.write") ? (
          <p className="text-xs text-muted-foreground">Grant “Start and steer work” in Settings.</p>
        ) : !activeTask ? (
          <p className="text-xs text-muted-foreground">Create or open a task first.</p>
        ) : null}
        <Button type="submit" disabled={busy || !canRun || prompt.trim().length === 0}>
          {busy ? "Starting…" : "Start run"}
        </Button>
      </form>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Recent decisions</h3>
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {audit.isLoading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading action record…</p>
          ) : audit.isError ? (
            <p className="p-4 text-sm text-destructive">Could not load the action record.</p>
          ) : audit.data?.entries.length ? (
            audit.data.entries.map((entry) => (
              <div key={entry.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                <span className="mt-0.5 rounded bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                  {entry.decision}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{entry.action}</p>
                  <p className="text-xs text-muted-foreground">{entry.summary}</p>
                </div>
                <time className="shrink-0 text-[10px] text-muted-foreground">
                  {new Date(entry.createdAt).toLocaleString()}
                </time>
              </div>
            ))
          ) : (
            <p className="p-4 text-sm text-muted-foreground">No governed actions yet.</p>
          )}
        </div>
      </div>
      </section>
    </div>
  );
}
