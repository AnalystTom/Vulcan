import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { BotAvatar } from "~/components/bots/BotAvatar";
import { NewBotDialog } from "~/components/bots/NewBotDialog";
import { Button } from "~/components/ui/button";
import { useBots } from "~/hooks/useBots";
import { BotIcon, PlusIcon } from "~/lib/icons";

function BotsIndexRoute() {
  const bots = useBots();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-muted-foreground">
              <BotIcon className="size-5" />
              <span className="text-xs font-medium uppercase tracking-wider">Standing team</span>
            </div>
            <h1 className="font-display text-3xl font-semibold">Bots</h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Persistent agents with their own identity, memory, model, and task threads.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon /> New agent
          </Button>
        </div>

        {bots.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading agents…</p>
        ) : bots.error ? (
          <div className="rounded-xl border border-destructive/30 p-4 text-sm text-destructive">
            Could not load agents: {bots.error.message}
          </div>
        ) : bots.data.bots.length === 0 ? (
          <button
            type="button"
            className="flex w-full flex-col items-center rounded-2xl border border-dashed border-border px-6 py-16 text-center hover:bg-muted/30"
            onClick={() => setCreateOpen(true)}
          >
            <BotIcon className="mb-4 size-8 text-muted-foreground" />
            <span className="font-heading text-base font-semibold">Create your first agent</span>
            <span className="mt-1 text-sm text-muted-foreground">
              Give it a role, choose a model, then start its first task.
            </span>
          </button>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {bots.data.bots.map((bot) => {
              const taskCount = bots.data.tasks.filter(
                (task) => task.botId === bot.id && task.archivedAt === null,
              ).length;
              return (
                <Link
                  key={bot.id}
                  to="/bots/$botId"
                  params={{ botId: bot.id }}
                  className="group rounded-2xl border border-border p-4 transition-colors hover:bg-muted/40"
                >
                  <BotAvatar avatar={bot.avatar} name={bot.name} />
                  <h2 className="mt-4 truncate font-heading text-base font-semibold">{bot.name}</h2>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {bot.title || "No role set"}
                  </p>
                  <p className="mt-4 text-xs text-muted-foreground">
                    {taskCount} {taskCount === 1 ? "task" : "tasks"}
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <NewBotDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        pending={bots.createMutation.isPending}
        onCreate={async (input) => {
          await bots.createMutation.mutateAsync({
            name: input.name,
            title: input.title,
            description: input.description,
            avatar: { kind: "shape", shape: "idle", color: input.color },
            modelSelection: { provider: input.provider, model: input.model },
          });
          setCreateOpen(false);
        }}
      />
    </main>
  );
}

export const Route = createFileRoute("/_chat/bots/")({ component: BotsIndexRoute });
