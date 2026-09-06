import { resolveBotRuntimeStates } from "~/lib/botDefaults";
import { BotId } from "@vulcan/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { BotResponsibilitiesPanel } from "~/components/bots/BotResponsibilitiesPanel";
import { BotAvatar } from "~/components/bots/BotAvatar";
import { BotAutonomyPanel } from "~/components/bots/BotAutonomyPanel";
import { BotMemoryEditor } from "~/components/bots/BotMemoryEditor";
import { BotTaskList } from "~/components/bots/BotTaskList";
import { BotSettingsForm } from "~/components/bots/BotSettingsForm";
import { useBots } from "~/hooks/useBots";
import { useStore } from "~/store";

function BotDetailRoute() {
  const { botId: rawBotId } = Route.useParams();
  const botId = BotId.makeUnsafe(rawBotId);
  const navigate = useNavigate();
  const bots = useBots();
  const projects = useStore((state) => state.projects);
  const bot = bots.data.bots.find((candidate) => candidate.id === botId);
  const tasks = bots.data.tasks.filter((task) => task.botId === botId);
  const runtimeState = resolveBotRuntimeStates(bots.data).find((state) => state.botId === botId);

  if (bots.isLoading) {
    return <main className="p-8 text-sm text-muted-foreground">Loading agent…</main>;
  }
  if (!bot) {
    return <main className="p-8 text-sm text-destructive">Agent not found.</main>;
  }

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-10 px-6 py-10">
        <header className="flex items-start gap-4">
          <BotAvatar avatar={bot.avatar} name={bot.name} className="size-14 text-lg" />
          <div className="min-w-0">
            <h1 className="truncate font-display text-3xl font-semibold">{bot.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{bot.title || "No role set"}</p>
            {bot.description ? <p className="mt-3 max-w-2xl text-sm">{bot.description}</p> : null}
            <p className="mt-2 text-xs text-muted-foreground">
              {bot.modelSelection.provider} · {bot.modelSelection.model}
            </p>
          </div>
        </header>

        <BotResponsibilitiesPanel bot={bot} tasks={tasks} />

        <BotTaskList
          bot={bot}
          tasks={tasks}
          projects={projects}
          creating={bots.createTaskMutation.isPending}
          onCreate={async (title, pinnedProjectId) => {
            const result = await bots.createTaskMutation.mutateAsync({
              botId,
              title,
              pinnedProjectId,
            });
            await navigate({
              to: "/$threadId",
              params: { threadId: result.task.threadId },
            });
          }}
          onOpen={(task) => {
            void bots.setActiveTaskMutation.mutateAsync(task).then(() =>
              navigate({
                to: "/$threadId",
                params: { threadId: task.threadId },
              }),
            );
          }}
          archivingTaskId={
            bots.archiveTaskMutation.isPending
              ? (bots.archiveTaskMutation.variables?.id ?? null)
              : null
          }
          onArchive={(task) => {
            void bots.archiveTaskMutation.mutateAsync(task);
          }}
        />

        <BotMemoryEditor
          botId={botId}
          saving={bots.saveMemoryMutation.isPending}
          onSave={async (text) => {
            await bots.saveMemoryMutation.mutateAsync({ botId, text });
          }}
        />

        <BotAutonomyPanel
          bot={bot}
          tasks={tasks}
          state={
            runtimeState ?? {
              botId,
              phase: "idle",
              activeThreadId: null,
              takeoverReason: null,
              updatedAt: bot.updatedAt,
            }
          }
          busy={bots.controlMutation.isPending || bots.runTaskMutation.isPending}
          onControl={async (action, reason) => {
            await bots.controlMutation.mutateAsync({ botId, action, reason });
          }}
          onRun={async (task, prompt) => {
            await bots.runTaskMutation.mutateAsync({ botId, taskId: task.id, prompt });
          }}
        />

        <BotSettingsForm
          bot={bot}
          saving={bots.updateMutation.isPending}
          onSave={async (input) => {
            await bots.updateMutation.mutateAsync(input);
          }}
        />
      </div>
    </main>
  );
}

export const Route = createFileRoute("/_chat/bots/$botId")({ component: BotDetailRoute });
