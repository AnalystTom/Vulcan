import {
  ProjectId,
  type Bot,
  type BotTask,
  type OrchestrationProjectShell,
} from "@vulcan/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

export function BotTaskList({
  bot,
  tasks,
  projects,
  onCreate,
  onOpen,
  creating,
}: {
  bot: Bot;
  tasks: readonly BotTask[];
  projects: readonly OrchestrationProjectShell[];
  onCreate: (title: string, pinnedProjectId: ProjectId | null) => Promise<void>;
  onOpen: (task: BotTask) => void;
  creating: boolean;
}) {
  const [title, setTitle] = useState("");
  const [pinnedProjectId, setPinnedProjectId] = useState<ProjectId | null>(
    bot.defaultProjectId ?? null,
  );
  const availableProjects = projects.filter((project) => project.kind === "project");
  const activeTasks = tasks.filter((task) => task.archivedAt === null);
  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-heading text-base font-semibold">Tasks</h2>
        <p className="text-xs text-muted-foreground">Each task is a normal Vulcan thread.</p>
      </div>
      <form
        className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,auto)_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          const nextTitle = title.trim();
          if (!nextTitle) return;
          void onCreate(nextTitle, pinnedProjectId).then(() => setTitle(""));
        }}
      >
        <Input
          aria-label="New task title"
          placeholder="What should this agent work on?"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <select
          aria-label="Task project"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={pinnedProjectId ?? ""}
          onChange={(event) =>
            setPinnedProjectId(event.target.value ? ProjectId.makeUnsafe(event.target.value) : null)
          }
        >
          <option value="">Private bot workspace</option>
          {availableProjects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title} · isolated worktree
            </option>
          ))}
        </select>
        <Button type="submit" disabled={creating || title.trim().length === 0}>
          {creating ? "Creating…" : "New task"}
        </Button>
      </form>
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {activeTasks.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No tasks yet.</p>
        ) : (
          activeTasks.map((task) => (
            <button
              key={task.id}
              type="button"
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
              onClick={() => onOpen(task)}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{task.title}</span>
              {task.id === bot.activeTaskId ? (
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Active
                </span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </section>
  );
}
