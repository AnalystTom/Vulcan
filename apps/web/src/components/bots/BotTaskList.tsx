import type { Project } from "~/types";
import { ProjectId, type Bot, type BotTask, type BotTaskId } from "@vulcan/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { IconButton } from "~/components/ui/icon-button";
import { Input } from "~/components/ui/input";
import { ArchiveIcon } from "~/lib/icons";

export function BotTaskList({
  bot,
  tasks,
  projects,
  onCreate,
  onOpen,
  onArchive,
  creating,
  archivingTaskId,
}: {
  bot: Bot;
  tasks: readonly BotTask[];
  projects: readonly Project[];
  onCreate: (title: string, pinnedProjectId: ProjectId | null) => Promise<void>;
  onOpen: (task: BotTask) => void;
  onArchive: (task: BotTask) => void;
  creating: boolean;
  /** The task currently being archived, so only its own row goes busy. */
  archivingTaskId: BotTaskId | null;
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
              {project.name} · isolated worktree
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
            <div key={task.id} className="group flex items-center gap-2 pr-2 hover:bg-muted/50">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
                onClick={() => onOpen(task)}
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{task.title}</span>
                {task.id === bot.activeTaskId ? (
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Active
                  </span>
                ) : null}
              </button>
              <IconButton
                size="icon-sm"
                label={`Archive ${task.title}`}
                tooltip="Archive task"
                disabled={archivingTaskId === task.id}
                onClick={() => onArchive(task)}
              >
                <ArchiveIcon />
              </IconButton>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
