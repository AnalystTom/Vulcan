import type {
  AutomationDefinition,
  AutomationRetryPolicy,
  AutomationSchedule,
  Bot,
  BotTask,
  ModelSelection,
  ProjectId,
} from "@vulcan/contracts";
import { Link } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { getProviderStartOptions, useAppSettings } from "~/appSettings";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import ChatMarkdown from "~/components/ChatMarkdown";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { resolveBotAutonomy, resolveBotCapabilityGrants } from "~/lib/botDefaults";
import {
  botResponsibilities,
  RESPONSIBILITY_EVIDENCE_INSTRUCTIONS,
  responsibilityRetryLabel,
} from "~/lib/botResponsibilities";
import {
  AutomationModelPicker,
  formatCadence,
  providerOptionsForAutomationModelSelection,
  runStatusLabel,
  useAutomations,
} from "~/routes/-automations.shared";

const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

export function BotResponsibilitiesPanel({ bot, tasks }: { bot: Bot; tasks: readonly BotTask[] }) {
  const automations = useAutomations();
  const [editing, setEditing] = useState<AutomationDefinition | null | undefined>();
  const responsibilities = botResponsibilities(tasks, automations.data.definitions);
  const memoryQueries = useQueries({
    queries: responsibilities.map((definition) => ({
      queryKey: ["automation-memory", definition.id],
      queryFn: () => ensureNativeApi().automation.getMemory({ automationId: definition.id }),
    })),
  });
  const canRun =
    resolveBotAutonomy(bot).enabled && resolveBotCapabilityGrants(bot).includes("thread.write");

  return (
    <section className="space-y-4" aria-label="Responsibilities">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-lg font-semibold">Responsibilities</h2>
          <p className="text-sm text-muted-foreground">
            Ongoing work, with a schedule and a record of what happened.
          </p>
        </div>
        <Button
          onClick={() => setEditing(editing === null ? undefined : null)}
          aria-expanded={editing !== undefined}
        >
          Add responsibility
        </Button>
      </div>
      <DisclosureRegion open={editing !== undefined}>
        {editing !== undefined ? (
          <ResponsibilityForm
            key={editing?.id ?? "new"}
            bot={bot}
            tasks={tasks}
            definition={editing}
            onSaved={() => {
              setEditing(undefined);
              void automations.refetch();
            }}
            onCancel={() => setEditing(undefined)}
          />
        ) : null}
      </DisclosureRegion>
      {!canRun ? (
        <p className="text-xs text-muted-foreground">
          Save responsibilities now. Enable autonomy and “Start and steer work” in this profile’s
          settings before running them.
        </p>
      ) : null}
      {automations.isLoading ? (
        <p role="status">Loading responsibilities…</p>
      ) : automations.isError ? (
        <div role="alert">
          Could not load responsibilities.{" "}
          <Button variant="outline" onClick={() => void automations.refetch()}>
            Retry
          </Button>
        </div>
      ) : responsibilities.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
          No responsibilities yet. Tell this agent what it should own and when it should run.
        </p>
      ) : (
        responsibilities.map((definition, index) => {
          const runs = automations.runsByAutomationId.get(definition.id) ?? [];
          const latest = runs[0];
          const memoryQuery = memoryQueries[index]!;
          const memory =
            automations.data.memories?.find((entry) => entry.automationId === definition.id) ??
            memoryQuery.data;
          const task = tasks.find((entry) => entry.threadId === definition.targetThreadId);
          const archivedTask = Boolean(task?.archivedAt);
          return (
            <article key={definition.id} className="space-y-4 rounded-xl border border-border p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-medium break-words">{definition.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    {formatCadence(definition.schedule)} · {definition.modelSelection.provider} /{" "}
                    {definition.modelSelection.model}
                  </p>
                </div>
                <span className="text-xs">
                  {archivedTask
                    ? "Task archived"
                    : !definition.enabled
                      ? "Schedule paused"
                      : "Scheduled"}
                </span>
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">Next run</dt>
                  <dd>
                    {definition.enabled && definition.nextRunAt
                      ? new Date(definition.nextRunAt).toLocaleString()
                      : "Not scheduled"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Retry rule</dt>
                  <dd>{responsibilityRetryLabel(definition.retryPolicy)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Latest run</dt>
                  <dd>
                    {latest?.result?.outcome === "needs-attention"
                      ? "Needs attention"
                      : latest
                        ? latest.status === "succeeded"
                          ? "Turn finished"
                          : runStatusLabel(latest.status)
                        : "Not run yet"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Failure policy</dt>
                  <dd>
                    {definition.stopOnError
                      ? "Pause immediately on failure"
                      : "Retry eligible failures, then keep the schedule"}
                  </dd>
                </div>
              </dl>
              <div>
                <h4 className="text-xs font-medium text-muted-foreground">Persistent progress</h4>
                <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm">
                  {memory?.content ||
                    (memoryQuery.isPending
                      ? "Loading progress…"
                      : memoryQuery.isError
                        ? "Could not load progress. Open history to retry."
                        : "No progress recorded yet.")}
                </div>
              </div>
              <div>
                <h4 className="text-xs font-medium text-muted-foreground">Result and evidence</h4>
                <ChatMarkdown
                  className="mt-1 text-sm"
                  cwd={bot.workspaceDir}
                  text={latest?.error || latest?.result?.summary || "No result recorded yet."}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={() => setEditing(definition)}>
                  Edit responsibility
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    automations.updateMutation.isPending ||
                    (!definition.enabled && (!canRun || archivedTask))
                  }
                  onClick={() =>
                    automations.updateMutation.mutate({
                      id: definition.id,
                      enabled: !definition.enabled,
                    })
                  }
                >
                  {definition.enabled ? "Pause schedule" : "Enable schedule"}
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    !canRun ||
                    archivedTask ||
                    automations.runNowMutation.isPending ||
                    (latest !== undefined &&
                      ["pending", "claimed", "running", "waiting-for-approval"].includes(
                        latest.status,
                      ))
                  }
                  onClick={() => automations.runNowMutation.mutate(definition)}
                >
                  Run now
                </Button>
                <Link
                  className="text-sm underline underline-offset-4"
                  to="/automations/$automationId"
                  params={{ automationId: definition.id }}
                >
                  History and evidence
                </Link>
                {latest?.threadId ? (
                  <Link
                    className="text-sm underline underline-offset-4"
                    to="/$threadId"
                    params={{ threadId: latest.threadId }}
                  >
                    Open work
                  </Link>
                ) : null}
              </div>
            </article>
          );
        })
      )}
    </section>
  );
}

function ResponsibilityForm({
  bot,
  tasks,
  definition,
  onSaved,
  onCancel,
}: {
  bot: Bot;
  tasks: readonly BotTask[];
  definition: AutomationDefinition | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const projects = useStore((state) => state.projects);
  const { settings } = useAppSettings();
  const [name, setName] = useState(definition?.name ?? "");
  const [prompt, setPrompt] = useState(definition?.prompt ?? "");
  const [taskId, setTaskId] = useState(
    tasks.find((task) => task.threadId === definition?.targetThreadId)?.id ?? "",
  );
  const [createdTask, setCreatedTask] = useState<BotTask | null>(null);
  const [projectId, setProjectId] = useState<string>(bot.defaultProjectId ?? "");
  const [model, setModel] = useState<ModelSelection>(
    definition?.modelSelection ?? bot.modelSelection,
  );
  const [schedule, setSchedule] = useState<AutomationSchedule>(
    definition?.schedule ?? {
      type: "daily",
      timeOfDay: "09:00",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  );
  const [retry, setRetry] = useState<AutomationRetryPolicy>(
    definition?.retryPolicy ?? { type: "none" },
  );
  const [stopOnError, setStopOnError] = useState(definition?.stopOnError ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const api = ensureNativeApi();
      if (definition) {
        await api.automation.update({
          id: definition.id,
          name: name.trim(),
          prompt: prompt.trim(),
          schedule,
          retryPolicy: retry,
          stopOnError,
          modelSelection: model,
          providerOptions: providerOptionsForAutomationModelSelection(
            definition,
            model,
            getProviderStartOptions(settings),
          ),
          ...(model.provider !== definition.modelSelection.provider
            ? { runtimeMode: "approval-required" as const }
            : {}),
        });
      } else {
        let task =
          tasks.find((entry) => entry.id === taskId && !entry.archivedAt) ??
          (createdTask?.id === taskId ? createdTask : undefined);
        if (!task) {
          task = (
            await api.bots.createTask({
              botId: bot.id,
              title: name.trim(),
              pinnedProjectId: projectId ? (projectId as ProjectId) : null,
            })
          ).task;
          // Keep the created task selected if saving the schedule fails; retry must not create another.
          setCreatedTask(task);
          setTaskId(task.id);
        }
        const snapshot = await api.orchestration.getSnapshot();
        const thread = snapshot.threads.find((entry) => entry.id === task.threadId);
        if (!thread) throw new Error("The task is still loading. Retry saving in a moment.");
        await api.automation.create({
          projectId: thread.projectId,
          sourceThreadId: task.threadId,
          targetThreadId: task.threadId,
          mode: "heartbeat",
          name: name.trim(),
          prompt: prompt.trim() + RESPONSIBILITY_EVIDENCE_INSTRUCTIONS,
          schedule,
          enabled: false,
          modelSelection: model,
          providerOptions: getProviderStartOptions(settings),
          runtimeMode: "approval-required",
          interactionMode: "default",
          worktreeMode: "auto",
          retryPolicy: retry,
          stopOnError,
          notificationPolicy: "all",
        });
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save responsibility.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4 rounded-xl border border-border bg-muted/20 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void save();
      }}
    >
      <h3 className="font-medium">{definition ? "Edit responsibility" : "New responsibility"}</h3>
      <label className="block space-y-1 text-xs font-medium">
        Responsibility name
        <Input
          required
          maxLength={160}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="block space-y-1 text-xs font-medium">
        Outcome and instructions
        <Textarea
          aria-label="Outcome and instructions"
          required
          maxLength={60000}
          rows={5}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      {!definition ? (
        <>
          <label className="block space-y-1 text-xs font-medium">
            Task
            <select
              aria-label="Task"
              className={selectClass}
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
            >
              <option value="">Create a dedicated task</option>
              {tasks
                .filter((task) => !task.archivedAt)
                .map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
            </select>
          </label>
          {!taskId ? (
            <label className="block space-y-1 text-xs font-medium">
              Project
              <select
                aria-label="Project"
                className={selectClass}
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">Bot workspace</option>
                {projects
                  .filter((project) => project.kind !== "bots")
                  .map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
        </>
      ) : null}
      <div>
        <p className="mb-1 text-xs font-medium">Harness and model for this responsibility</p>
        <AutomationModelPicker
          value={model}
          projectCwd={projects.find((project) => project.id === projectId)?.cwd ?? null}
          onChange={setModel}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-xs font-medium">
          Schedule
          <select
            aria-label="Schedule"
            className={selectClass}
            value={schedule.type}
            onChange={(event) =>
              setSchedule(
                event.target.value === "weekly"
                  ? { type: "weekly", dayOfWeek: 1, timeOfDay: "09:00", timezone: "Europe/London" }
                  : { type: "daily", timeOfDay: "09:00", timezone: "Europe/London" },
              )
            }
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            {schedule.type !== "daily" && schedule.type !== "weekly" ? (
              <option value={schedule.type}>{formatCadence(schedule)}</option>
            ) : null}
          </select>
        </label>
        {schedule.type === "daily" || schedule.type === "weekly" ? (
          <>
            <label className="space-y-1 text-xs font-medium">
              Time
              <Input
                type="time"
                required
                value={schedule.timeOfDay}
                onChange={(event) => setSchedule({ ...schedule, timeOfDay: event.target.value })}
              />
            </label>
            <label className="space-y-1 text-xs font-medium">
              Timezone
              <Input
                required
                value={schedule.timezone ?? "UTC"}
                onChange={(event) => setSchedule({ ...schedule, timezone: event.target.value })}
              />
            </label>
          </>
        ) : null}
        {schedule.type === "weekly" ? (
          <label className="space-y-1 text-xs font-medium">
            Day
            <select
              className={selectClass}
              value={schedule.dayOfWeek}
              onChange={(event) =>
                setSchedule({ ...schedule, dayOfWeek: Number(event.target.value) })
              }
            >
              {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(
                (day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ),
              )}
            </select>
          </label>
        ) : null}
      </div>
      <label className="block space-y-1 text-xs font-medium">
        Automatic retries
        <select
          aria-label="Automatic retries"
          className={selectClass}
          value={retry.type}
          onChange={(event) => {
            setStopOnError(event.target.value === "none");
            setRetry(
              event.target.value === "fixed"
                ? { type: "fixed", maxAttempts: 3, delaySeconds: 300 }
                : event.target.value === "exponential"
                  ? {
                      type: "exponential",
                      maxAttempts: 3,
                      initialDelaySeconds: 300,
                      maxDelaySeconds: 3600,
                    }
                  : { type: "none" },
            );
          }}
        >
          <option value="none">No automatic retries</option>
          <option value="fixed">Retry with a fixed delay</option>
          <option value="exponential">Retry with increasing delays</option>
        </select>
      </label>
      {retry.type !== "none" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-medium">
            Maximum attempts
            <Input
              type="number"
              required
              min={1}
              max={10}
              value={retry.maxAttempts}
              onChange={(event) => setRetry({ ...retry, maxAttempts: Number(event.target.value) })}
            />
          </label>
          <label className="space-y-1 text-xs font-medium">
            Initial delay (seconds)
            <Input
              type="number"
              required
              min={1}
              value={retry.type === "fixed" ? retry.delaySeconds : retry.initialDelaySeconds}
              onChange={(event) =>
                setRetry(
                  retry.type === "fixed"
                    ? { ...retry, delaySeconds: Number(event.target.value) }
                    : { ...retry, initialDelaySeconds: Number(event.target.value) },
                )
              }
            />
          </label>
          {retry.type === "exponential" ? (
            <label className="space-y-1 text-xs font-medium">
              Maximum delay (seconds)
              <Input
                type="number"
                required
                min={retry.initialDelaySeconds}
                value={retry.maxDelaySeconds}
                onChange={(event) =>
                  setRetry({ ...retry, maxDelaySeconds: Number(event.target.value) })
                }
              />
            </label>
          ) : null}
        </div>
      ) : null}
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={stopOnError}
          onChange={(event) => setStopOnError(event.target.checked)}
        />
        Pause immediately on failure, without retrying
      </label>
      {retry.type !== "none" ? (
        <p className="text-xs text-muted-foreground">
          Only failures before a turn is accepted can retry automatically. Work that may already
          have sent or published something needs review before retrying.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {definition
          ? "Changes apply to future runs."
          : "Saved paused, with approval required. Enable the schedule when the workflow and access are ready."}{" "}
        Runs require the Vulcan server to stay online.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !name.trim() || !prompt.trim()}>
          {busy ? "Saving…" : "Save responsibility"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
