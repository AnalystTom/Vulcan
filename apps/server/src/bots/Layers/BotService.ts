// FILE: Layers/BotService.ts
// Purpose: Live BotService — bot roster CRUD, task threads dispatched into the Bots
//          container project, file-backed memory, and the bot event stream.
// Layer: Server domain service (mirrors automation/Layers/AutomationService.ts idioms)

import { randomUUID } from "node:crypto";

import {
  BOT_ROSTER_MAX,
  BotAuditEntryId,
  BotId,
  BotTaskId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type Bot,
  type BotActionAuditEntry,
  type BotCapability,
  type BotEvent,
  type BotMemory,
  type BotRuntimeState,
  type OrchestrationProjectShell,
} from "@vulcan/contracts";
import { workspaceRootsEqual } from "@vulcan/shared/threadWorkspace";
import { Effect, FileSystem, Layer, Option, Path, PubSub, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BotRepository } from "../../persistence/Services/BotRepository.ts";
import { BotServiceError } from "../Errors.ts";
import { BotService, type BotServiceShape } from "../Services/BotService.ts";
import { transitionBotControl } from "../botControl.ts";
import { provisionBotTaskEnvironment } from "../botIsolation.ts";
import {
  BOT_MEMORY_FILE_NAME,
  ensureBotWorkspace,
  readBotMemoryFile,
  writeBotMemoryFile,
} from "../botWorkspace.ts";

function isoNow(): string {
  return new Date().toISOString();
}

function makeBotId(): BotId {
  // Bot ids double as workspace directory names, so they must stay path-safe.
  return BotId.makeUnsafe(`bot-${randomUUID()}`);
}

function makeBotTaskId(): BotTaskId {
  return BotTaskId.makeUnsafe(`bot-task-${randomUUID()}`);
}

function makeBotAuditEntryId(): BotAuditEntryId {
  return BotAuditEntryId.makeUnsafe(`bot-audit-${randomUUID()}`);
}

function toServiceError(message: string) {
  return (cause: unknown) => new BotServiceError({ message, cause });
}

export const BotServiceLive = Layer.effect(
  BotService,
  Effect.gen(function* () {
    const repository = yield* BotRepository;
    const git = yield* GitCore;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const config = yield* ServerConfig;
    // The workspace helpers pull FileSystem/Path from context; capture them once so the
    // service methods stay requirement-free.
    const workspaceServices = yield* Effect.services<FileSystem.FileSystem | Path.Path>();
    const withWorkspaceServices = <A, E>(
      effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
    ): Effect.Effect<A, E> => Effect.provideServices(effect, workspaceServices);

    // Unbounded so we never silently drop roster updates under a burst, matching the rest
    // of the server's PubSub usage.
    const events = yield* PubSub.unbounded<BotEvent>();
    const publish = (event: BotEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

    const requireBot = (id: BotId) =>
      repository.getBotById({ id }).pipe(
        Effect.mapError(toServiceError("Failed to load bot.")),
        Effect.flatMap((botOption) =>
          Option.match(botOption, {
            onNone: () => Effect.fail(new BotServiceError({ message: "Bot was not found." })),
            onSome: (bot) =>
              bot.archivedAt
                ? Effect.fail(new BotServiceError({ message: "Bot has been deleted." }))
                : Effect.succeed(bot),
          }),
        ),
      );

    const publishBot = (id: BotId) =>
      repository.getBotById({ id }).pipe(
        Effect.mapError(toServiceError("Failed to load bot.")),
        Effect.flatMap((botOption) =>
          Option.match(botOption, {
            onNone: () => Effect.void,
            onSome: (bot) => publish({ type: "bot.upserted", bot }),
          }),
        ),
      );

    const getShellSnapshot = () =>
      projectionSnapshotQuery
        .getShellSnapshot()
        .pipe(Effect.mapError(toServiceError("Failed to load project snapshot.")));

    const findBotsContainerProject = (
      projects: ReadonlyArray<OrchestrationProjectShell>,
    ): OrchestrationProjectShell | undefined => {
      const containers = projects.filter((project) => project.kind === "bots");
      return (
        containers.find((project) =>
          workspaceRootsEqual(project.workspaceRoot, config.botsWorkspaceRoot),
        ) ?? containers[0]
      );
    };

    /**
     * The Bots container project owns every bot task thread. Unlike Studio (which the
     * client creates on demand), the server creates this container itself — the web app
     * never has to know the bots workspace root exists before its first task shows up.
     */
    const ensureBotsContainerProject = Effect.gen(function* () {
      const existing = findBotsContainerProject((yield* getShellSnapshot()).projects);
      if (existing) {
        return existing;
      }
      const projectId = ProjectId.makeUnsafe(randomUUID());
      yield* orchestrationEngine
        .dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(`bot:project-create:${randomUUID()}`),
          projectId,
          kind: "bots",
          title: "Bots",
          workspaceRoot: config.botsWorkspaceRoot,
          createWorkspaceRootIfMissing: true,
          createdAt: isoNow(),
        })
        .pipe(
          Effect.mapError(toServiceError("Failed to create the Bots container project.")),
          // A concurrent createTask can win the race to create the container; the
          // container is what matters, not who created it.
          Effect.catch((error) =>
            getShellSnapshot().pipe(
              Effect.flatMap((snapshot) => {
                const winner = findBotsContainerProject(snapshot.projects);
                return winner ? Effect.void : Effect.fail(error);
              }),
            ),
          ),
        );
      const snapshot = yield* getShellSnapshot();
      const container = findBotsContainerProject(snapshot.projects);
      return (
        container ??
        (yield* Effect.fail(
          new BotServiceError({
            message: "The Bots container project is missing after creating it.",
          }),
        ))
      );
    });

    const loadMemory = (bot: Bot) =>
      Effect.gen(function* () {
        const workspaceDir = yield* ensureBotWorkspace({
          botsWorkspaceRoot: config.botsWorkspaceRoot,
          botId: bot.id,
        });
        const content = yield* readBotMemoryFile({ workspaceDir });
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const mtime = yield* fileSystem.stat(path.join(workspaceDir, BOT_MEMORY_FILE_NAME)).pipe(
          Effect.map((info) => info.mtime?.toISOString()),
          Effect.catch(() => Effect.succeed(undefined)),
        );
        return {
          botId: bot.id,
          text: content.text,
          truncatedForPrompt: content.truncated,
          updatedAt: mtime ?? bot.updatedAt,
        } satisfies BotMemory;
      }).pipe(
        withWorkspaceServices,
        Effect.mapError((error) =>
          error instanceof BotServiceError
            ? error
            : new BotServiceError({ message: "Failed to read bot memory.", cause: error }),
        ),
      );

    const getRuntimeStateOrIdle = (bot: Bot) =>
      repository.getRuntimeState({ botId: bot.id }).pipe(
        Effect.mapError(toServiceError("Failed to load bot runtime state.")),
        Effect.map(
          Option.getOrElse(
            (): BotRuntimeState => ({
              botId: bot.id,
              phase: "idle",
              activeThreadId: null,
              takeoverReason: null,
              updatedAt: bot.updatedAt,
            }),
          ),
        ),
      );

    const list: BotServiceShape["list"] = (input) =>
      Effect.gen(function* () {
        const bots = yield* repository
          .listBots(input ?? { includeArchived: false })
          .pipe(Effect.mapError(toServiceError("Failed to list bots.")));
        const tasks = yield* repository
          .listBotTasks({ includeArchived: false })
          .pipe(Effect.mapError(toServiceError("Failed to list bot tasks.")));
        const runtimeStates = yield* Effect.forEach(bots, getRuntimeStateOrIdle, {
          concurrency: "unbounded",
        });
        return { bots, tasks, runtimeStates };
      });

    const create: BotServiceShape["create"] = (input) =>
      Effect.gen(function* () {
        const roster = yield* repository
          .listBots({ includeArchived: false })
          .pipe(Effect.mapError(toServiceError("Failed to list bots.")));
        if (roster.length >= BOT_ROSTER_MAX) {
          return yield* Effect.fail(
            new BotServiceError({
              message: `The bot roster is full (${BOT_ROSTER_MAX} bots). Delete a bot before creating another.`,
            }),
          );
        }
        const id = makeBotId();
        const workspaceDir = yield* withWorkspaceServices(
          ensureBotWorkspace({ botsWorkspaceRoot: config.botsWorkspaceRoot, botId: id }),
        ).pipe(Effect.mapError(toServiceError("Failed to create the bot workspace.")));
        const bot = yield* repository
          .createBot({ id, input, workspaceDir, now: isoNow() })
          .pipe(
            Effect.mapError(
              input.chiefOfStaff
                ? toServiceError(
                    "Failed to create bot. Only one bot can be chief of staff at a time.",
                  )
                : toServiceError("Failed to create bot."),
            ),
          );
        yield* publish({ type: "bot.upserted", bot });
        return { bot };
      });

    const update: BotServiceShape["update"] = (input) =>
      Effect.gen(function* () {
        const bot = yield* requireBot(input.id);
        const next: Bot = {
          ...bot,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          ...(input.providerOptions !== undefined
            ? { providerOptions: input.providerOptions }
            : {}),
          ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
          ...(input.interactionMode !== undefined
            ? { interactionMode: input.interactionMode }
            : {}),
          ...(input.isolationMode !== undefined ? { isolationMode: input.isolationMode } : {}),
          ...(input.autonomy !== undefined ? { autonomy: input.autonomy } : {}),
          ...(input.capabilityGrants !== undefined
            ? { capabilityGrants: input.capabilityGrants }
            : {}),
          ...(input.defaultWorkingDirectory !== undefined
            ? { defaultWorkingDirectory: input.defaultWorkingDirectory }
            : {}),
          ...(input.defaultProjectId !== undefined
            ? { defaultProjectId: input.defaultProjectId }
            : {}),
          ...(input.chiefOfStaff !== undefined ? { chiefOfStaff: input.chiefOfStaff } : {}),
          ...(input.approvePeerComms !== undefined
            ? { approvePeerComms: input.approvePeerComms }
            : {}),
          ...(input.isPinned !== undefined ? { isPinned: input.isPinned } : {}),
          ...(input.isHidden !== undefined ? { isHidden: input.isHidden } : {}),
          updatedAt: isoNow(),
        };
        const saved = yield* repository
          .updateBot(next)
          .pipe(
            Effect.mapError(
              input.chiefOfStaff
                ? toServiceError(
                    "Failed to update bot. Only one bot can be chief of staff at a time.",
                  )
                : toServiceError("Failed to update bot."),
            ),
          );
        yield* publish({ type: "bot.upserted", bot: saved });
        return { bot: saved };
      });

    const deleteBot: BotServiceShape["delete"] = (input) =>
      Effect.gen(function* () {
        // Archive, never hard-delete: history stays queryable, and the workspace dir on
        // disk (the bot's memory) is deliberately left for the user to keep or remove.
        yield* requireBot(input.id);
        yield* repository
          .archiveBot({ id: input.id, archivedAt: isoNow() })
          .pipe(Effect.mapError(toServiceError("Failed to delete bot.")));
        yield* publish({ type: "bot.deleted", botId: input.id });
        return { deleted: true };
      });

    const createTask: BotServiceShape["createTask"] = (input) =>
      Effect.gen(function* () {
        const bot = yield* requireBot(input.botId);
        const now = isoNow();
        const taskId = makeBotTaskId();
        const threadId = ThreadId.makeUnsafe(`bot:${taskId}:thread`);

        const container = yield* ensureBotsContainerProject;
        const snapshot = yield* getShellSnapshot();
        const pinnedProjectId = input.pinnedProjectId ?? bot.defaultProjectId ?? null;
        const pinnedProject = pinnedProjectId
          ? snapshot.projects.find((project) => project.id === pinnedProjectId)
          : undefined;
        if (pinnedProjectId && !pinnedProject) {
          return yield* Effect.fail(
            new BotServiceError({ message: "The pinned project was not found." }),
          );
        }
        const workspaceDir = yield* withWorkspaceServices(
          ensureBotWorkspace({ botsWorkspaceRoot: config.botsWorkspaceRoot, botId: bot.id }),
        ).pipe(Effect.mapError(toServiceError("Failed to prepare the bot workspace.")));
        const isolatedEnvironment = yield* provisionBotTaskEnvironment({
          bot,
          pinnedProject,
          workspaceDir,
          git,
        });

        yield* orchestrationEngine
          .dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe(`bot:${taskId}:thread-create`),
            threadId,
            projectId: container.id,
            title: input.title,
            modelSelection: bot.modelSelection,
            runtimeMode: bot.runtimeMode,
            interactionMode: bot.interactionMode,
            ...isolatedEnvironment,
            createdAt: now,
          })
          .pipe(
            Effect.mapError(toServiceError("Failed to create the bot task thread.")),
            Effect.tapError(() =>
              isolatedEnvironment.worktreePath
                ? git
                    .removeWorktree({
                      cwd: pinnedProject!.workspaceRoot,
                      path: isolatedEnvironment.worktreePath,
                      force: true,
                    })
                    .pipe(
                      Effect.catch((cause) =>
                        Effect.logWarning("failed to roll back bot worktree", {
                          worktreePath: isolatedEnvironment.worktreePath,
                          cause,
                        }),
                      ),
                    )
                : Effect.void,
            ),
          );

        const task = yield* repository
          .createBotTask({
            id: taskId,
            botId: bot.id,
            threadId,
            pinnedProjectId,
            title: input.title,
            now,
          })
          .pipe(Effect.mapError(toServiceError("Failed to save the bot task.")));
        // A new task is what the user is about to talk to; make it the active one.
        yield* repository
          .setActiveBotTask({ botId: bot.id, taskId, updatedAt: now })
          .pipe(Effect.mapError(toServiceError("Failed to activate the bot task.")));

        const refreshed = yield* requireBot(bot.id);
        yield* publish({ type: "task.upserted", task });
        yield* publish({ type: "bot.upserted", bot: refreshed });
        return { task, bot: refreshed };
      });

    const setActiveTask: BotServiceShape["setActiveTask"] = (input) =>
      Effect.gen(function* () {
        const bot = yield* requireBot(input.botId);
        if (input.taskId !== null) {
          const tasks = yield* repository
            .listBotTasks({ botId: bot.id, includeArchived: false })
            .pipe(Effect.mapError(toServiceError("Failed to load bot tasks.")));
          if (!tasks.some((task) => task.id === input.taskId)) {
            return yield* Effect.fail(new BotServiceError({ message: "Bot task was not found." }));
          }
        }
        yield* repository
          .setActiveBotTask({ botId: bot.id, taskId: input.taskId, updatedAt: isoNow() })
          .pipe(Effect.mapError(toServiceError("Failed to set the active bot task.")));
        const refreshed = yield* requireBot(bot.id);
        yield* publish({ type: "bot.upserted", bot: refreshed });
        return { bot: refreshed };
      });

    const archiveTask: BotServiceShape["archiveTask"] = (input) =>
      Effect.gen(function* () {
        const archived = yield* repository
          .archiveBotTask({ taskId: input.taskId, archivedAt: isoNow() })
          .pipe(Effect.mapError(toServiceError("Failed to archive the bot task.")));
        if (Option.isNone(archived)) {
          return yield* Effect.fail(new BotServiceError({ message: "Bot task was not found." }));
        }
        yield* publish({ type: "task.deleted", taskId: input.taskId });
        // Archiving also clears the bot's active pointer when it pointed here.
        yield* publishBot(archived.value.botId);
        return { task: archived.value };
      });

    const getMemory: BotServiceShape["getMemory"] = (input) =>
      Effect.gen(function* () {
        const bot = yield* requireBot(input.botId);
        const memory = yield* loadMemory(bot);
        return { memory };
      });

    const setMemory: BotServiceShape["setMemory"] = (input) =>
      Effect.gen(function* () {
        const bot = yield* requireBot(input.botId);
        const now = isoNow();
        yield* withWorkspaceServices(
          Effect.gen(function* () {
            const workspaceDir = yield* ensureBotWorkspace({
              botsWorkspaceRoot: config.botsWorkspaceRoot,
              botId: bot.id,
            });
            yield* writeBotMemoryFile({ workspaceDir, text: input.text });
          }),
        ).pipe(
          Effect.mapError((error) =>
            error._tag === "BotWorkspaceError"
              ? new BotServiceError({ message: error.message, cause: error })
              : new BotServiceError({ message: "Failed to write bot memory.", cause: error }),
          ),
        );
        yield* repository
          .touchMemoryUpdatedAt({ id: bot.id, updatedAt: now })
          .pipe(Effect.mapError(toServiceError("Failed to record the bot memory update.")));
        const memory = yield* loadMemory(bot);
        return { memory };
      });

    const controlCapability = (action: Parameters<typeof transitionBotControl>[1]["action"]): BotCapability =>
      action === "pause" || action === "resume" ? "automation.write" : "browser.control";

    const makeControlAuditEntry = (input: {
      readonly botId: BotId;
      readonly taskId: BotActionAuditEntry["taskId"];
      readonly threadId: BotActionAuditEntry["threadId"];
      readonly action: Parameters<typeof transitionBotControl>[1]["action"];
      readonly decision: BotActionAuditEntry["decision"];
      readonly summary: string;
      readonly createdAt: string;
    }): BotActionAuditEntry => ({
      id: makeBotAuditEntryId(),
      botId: input.botId,
      taskId: input.taskId,
      threadId: input.threadId,
      capability: controlCapability(input.action),
      action: `control.${input.action}`,
      decision: input.decision,
      summary: input.summary,
      detailJson: null,
      createdAt: input.createdAt,
    });

    const control: BotServiceShape["control"] = (input) =>
      Effect.gen(function* () {
        const bot = yield* requireBot(input.botId);
        const current = yield* getRuntimeStateOrIdle(bot);
        const now = isoNow();
        const taskId = bot.activeTaskId;
        const threadId = input.activeThreadId ?? current.activeThreadId;
        const resumeBlockedReason =
          input.action === "resume" && current.activeThreadId
            ? yield* getShellSnapshot().pipe(
                Effect.map((snapshot) => {
                  const thread = snapshot.threads.find(
                    (candidate) => candidate.id === current.activeThreadId,
                  );
                  return thread &&
                    (thread.hasPendingApprovals ||
                      thread.hasPendingUserInput ||
                      thread.latestTurn?.state === "running" ||
                      thread.session?.status === "starting" ||
                      thread.session?.status === "running")
                    ? "Cannot resume autonomy while the previous provider turn is still active. Resolve or cancel it first."
                    : null;
                }),
              )
            : null;
        const next = yield* Effect.try({
          try: () => {
            if (resumeBlockedReason) throw new Error(resumeBlockedReason);
            return transitionBotControl(current, {
              action: input.action,
              ...(input.activeThreadId !== undefined
                ? { activeThreadId: input.activeThreadId }
                : {}),
              ...(input.reason !== undefined ? { reason: input.reason } : {}),
              now,
            });
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) => {
            const message = cause instanceof Error ? cause.message : "Bot control was denied.";
            const denied = makeControlAuditEntry({
              botId: bot.id,
              taskId,
              threadId,
              action: input.action,
              decision: "denied",
              summary: message,
              createdAt: now,
            });
            return repository.appendAuditEntry(denied).pipe(
              Effect.mapError(toServiceError("Failed to record denied bot control action.")),
              Effect.tap(() => publish({ type: "audit.appended", entry: denied })),
              Effect.flatMap(() => Effect.fail(new BotServiceError({ message, cause }))),
            );
          }),
        );
        const saved = yield* repository
          .setRuntimeState(next)
          .pipe(Effect.mapError(toServiceError("Failed to update bot control state.")));
        const shouldInterrupt =
          saved.activeThreadId !== null &&
          (input.action === "take-control" ||
            (input.action === "pause" &&
              (current.phase === "running" || current.phase === "waiting-for-approval")));
        const interruptError = shouldInterrupt
          ? yield* orchestrationEngine
              .dispatch({
                type: "thread.turn.interrupt",
                commandId: CommandId.makeUnsafe(`bot:control-interrupt:${randomUUID()}`),
                threadId: saved.activeThreadId!,
                createdAt: now,
              })
              .pipe(
                Effect.match({
                  onFailure: (cause) =>
                    cause instanceof Error ? cause.message : "Provider interruption failed.",
                  onSuccess: () => null,
                }),
              )
          : null;
        const entry = makeControlAuditEntry({
          botId: bot.id,
          taskId,
          threadId: saved.activeThreadId,
          action: input.action,
          decision: interruptError ? "failed" : "allowed",
          summary: interruptError
            ? `Control moved to ${saved.phase}, but the active provider turn could not be interrupted: ${interruptError}`
            : `Bot control moved from ${current.phase} to ${saved.phase}.`,
          createdAt: now,
        });
        yield* repository
          .appendAuditEntry(entry)
          .pipe(Effect.mapError(toServiceError("Failed to record bot control action.")));
        yield* publish({ type: "runtime.updated", state: saved });
        yield* publish({ type: "audit.appended", entry });
        if (interruptError) {
          return yield* Effect.fail(
            new BotServiceError({
              message:
                "The bot is blocked by human control, but its active provider turn could not be interrupted. Check the thread before making changes.",
            }),
          );
        }
        return { state: saved };
      });

    const listAudit: BotServiceShape["listAudit"] = (input) =>
      Effect.gen(function* () {
        yield* requireBot(input.botId);
        const entries = yield* repository
          .listAuditEntries({ botId: input.botId, limit: input.limit ?? 100 })
          .pipe(Effect.mapError(toServiceError("Failed to list bot audit entries.")));
        return { entries };
      });

    const runTask: BotServiceShape["runTask"] = (input) =>
      Effect.gen(function* () {
        const bot = yield* requireBot(input.botId);
        const tasks = yield* repository
          .listBotTasks({ botId: bot.id, includeArchived: false })
          .pipe(Effect.mapError(toServiceError("Failed to load bot tasks.")));
        const task = tasks.find((candidate) => candidate.id === input.taskId);
        if (!task) {
          return yield* Effect.fail(new BotServiceError({ message: "Bot task was not found." }));
        }

        const now = isoNow();
        const current = yield* getRuntimeStateOrIdle(bot);
        const denial = !bot.autonomy.enabled
          ? "Autonomous execution is disabled for this bot."
          : !bot.capabilityGrants.includes("thread.write")
            ? "This bot has not been granted thread.write."
            : current.phase !== "idle"
              ? `The bot cannot start autonomous work while it is ${current.phase}.`
              : null;
        if (denial) {
          const entry: BotActionAuditEntry = {
            id: makeBotAuditEntryId(),
            botId: bot.id,
            taskId: task.id,
            threadId: task.threadId,
            capability: "thread.write",
            action: "task.run",
            decision: "denied",
            summary: denial,
            detailJson: null,
            createdAt: now,
          };
          yield* repository
            .appendAuditEntry(entry)
            .pipe(Effect.mapError(toServiceError("Failed to record denied autonomous run.")));
          yield* publish({ type: "audit.appended", entry });
          return yield* Effect.fail(new BotServiceError({ message: denial }));
        }

        const running = yield* repository
          .setRuntimeState({
            botId: bot.id,
            phase: "running",
            activeThreadId: task.threadId,
            takeoverReason: null,
            updatedAt: now,
          })
          .pipe(Effect.mapError(toServiceError("Failed to start the autonomous run.")));
        const entry: BotActionAuditEntry = {
          id: makeBotAuditEntryId(),
          botId: bot.id,
          taskId: task.id,
          threadId: task.threadId,
          capability: "thread.write",
          action: "task.run",
          decision: "allowed",
          summary: `Autonomous run started for “${task.title}”.`,
          detailJson: null,
          createdAt: now,
        };
        yield* repository
          .appendAuditEntry(entry)
          .pipe(Effect.mapError(toServiceError("Failed to record autonomous run.")));
        yield* publish({ type: "runtime.updated", state: running });
        yield* publish({ type: "audit.appended", entry });

        const suffix = randomUUID();
        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`bot:${suffix}:run`),
            threadId: task.threadId,
            message: {
              messageId: MessageId.makeUnsafe(`bot:${suffix}:message`),
              role: "user",
              text: input.prompt,
              attachments: [],
            },
            dispatchMode: "queue",
            dispatchOrigin: "automation",
            runtimeMode: bot.runtimeMode,
            interactionMode: bot.interactionMode,
            modelSelection: bot.modelSelection,
            ...(bot.providerOptions ? { providerOptions: bot.providerOptions } : {}),
            createdAt: now,
          })
          .pipe(
            Effect.mapError(toServiceError("Failed to dispatch the autonomous run.")),
            Effect.catch((error) => {
              const failedAt = isoNow();
              const failedState: BotRuntimeState = {
                botId: bot.id,
                phase: "error",
                activeThreadId: task.threadId,
                takeoverReason: error.message,
                updatedAt: failedAt,
              };
              const failedEntry: BotActionAuditEntry = {
                id: makeBotAuditEntryId(),
                botId: bot.id,
                taskId: task.id,
                threadId: task.threadId,
                capability: "thread.write",
                action: "task.run",
                decision: "failed",
                summary: error.message,
                detailJson: null,
                createdAt: failedAt,
              };
              return repository.setRuntimeState(failedState).pipe(
                Effect.mapError(toServiceError("Failed to record autonomous run failure.")),
                Effect.tap((state) => publish({ type: "runtime.updated", state })),
                Effect.zipRight(
                  repository
                    .appendAuditEntry(failedEntry)
                    .pipe(
                      Effect.mapError(toServiceError("Failed to audit autonomous run failure.")),
                    ),
                ),
                Effect.tap(() => publish({ type: "audit.appended", entry: failedEntry })),
                Effect.flatMap(() => Effect.fail(error)),
              );
            }),
          );

        return { task, state: running };
      });

    const snapshot: BotServiceShape["snapshot"] = list({ includeArchived: false }).pipe(
      Effect.map(
        ({ bots, tasks, runtimeStates }): BotEvent => ({
          type: "snapshot",
          bots,
          tasks,
          runtimeStates,
        }),
      ),
      Effect.mapError(toServiceError("Failed to load the bot snapshot.")),
    );

    const reconcileDeletedThread: BotServiceShape["reconcileDeletedThread"] = (input) =>
      Effect.gen(function* () {
        const cleared = yield* repository
          .clearBotTaskForDeletedThread({ threadId: input.threadId, archivedAt: isoNow() })
          .pipe(Effect.mapError(toServiceError("Failed to reconcile the deleted bot thread.")));
        if (Option.isNone(cleared)) {
          return;
        }
        yield* publish({ type: "task.deleted", taskId: cleared.value.id });
        yield* publishBot(cleared.value.botId);
      });

    const reconcileThreadRuntime: BotServiceShape["reconcileThreadRuntime"] = (input) =>
      Effect.gen(function* () {
        const botOption = yield* repository
          .getBotByThreadId({ threadId: input.threadId })
          .pipe(Effect.mapError(toServiceError("Failed to resolve bot runtime thread.")));
        if (Option.isNone(botOption)) return;

        const bot = botOption.value;
        const current = yield* getRuntimeStateOrIdle(bot);
        if (
          current.phase === "takeover-requested" ||
          current.phase === "human-control" ||
          current.phase === "paused"
        ) {
          return;
        }
        const thread = (yield* getShellSnapshot()).threads.find(
          (candidate) => candidate.id === input.threadId,
        );
        if (!thread) return;

        const phase: BotRuntimeState["phase"] =
          thread.hasPendingApprovals || thread.hasPendingUserInput
            ? "waiting-for-approval"
            : thread.latestTurn?.state === "running" ||
                thread.session?.status === "starting" ||
                thread.session?.status === "running"
              ? "running"
              : thread.latestTurn?.state === "error" || thread.session?.status === "error"
                ? "error"
                : "idle";
        const activeThreadId = phase === "idle" ? null : input.threadId;
        const takeoverReason =
          phase === "error" ? (thread.session?.lastError ?? "The autonomous run failed.") : null;
        if (
          phase === current.phase &&
          activeThreadId === current.activeThreadId &&
          takeoverReason === current.takeoverReason
        ) {
          return;
        }
        const saved = yield* repository
          .setRuntimeState({
            botId: bot.id,
            phase,
            activeThreadId,
            takeoverReason,
            updatedAt: isoNow(),
          })
          .pipe(Effect.mapError(toServiceError("Failed to reconcile bot runtime state.")));
        yield* publish({ type: "runtime.updated", state: saved });
      });

    return {
      list,
      create,
      update,
      delete: deleteBot,
      createTask,
      runTask,
      setActiveTask,
      archiveTask,
      getMemory,
      setMemory,
      control,
      listAudit,
      snapshot,
      reconcileDeletedThread,
      reconcileThreadRuntime,
      streamEvents: Stream.fromPubSub(events),
    } satisfies BotServiceShape;
  }),
);
