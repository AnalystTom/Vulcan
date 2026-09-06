import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  EventId,
  type ProviderComposerCapabilities,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderListSkillsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@vulcan/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { OmpAdapter, type OmpAdapterShape } from "../Services/OmpAdapter.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";
import { makeBoundedCallbackIngress } from "../boundedCallbackIngress.ts";
import {
  compactProviderRuntimeEventForIngress,
  isTerminalProviderRuntimeEvent,
  PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
  PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
  providerRuntimeEventBytes,
} from "../providerRuntimeEventIngress.ts";
import {
  parseOmpModelSlug,
  parseOmpModelsJson,
  toOmpProviderModelDescriptor,
} from "../ompModels.ts";
import { OmpRpcClient, type OmpRpcFrame } from "../ompRpcClient.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "omp" as const;
const execFileAsync = promisify(execFile);

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (isRecord(value) && typeof value.text === "string") return value.text;
  if (isRecord(value) && typeof value.content === "string") return value.content;
  return undefined;
}

interface OmpSessionContext {
  lifecycleGeneration: string | undefined;
  client: OmpRpcClient;
  unsubscribe: () => void;
  session: ProviderSession;
  turns: Array<{ id: TurnId; items: unknown[] }>;
  activeTurnId: TurnId | undefined;
  activeAssistantItemId: RuntimeItemId | undefined;
  activeReasoningItemId: RuntimeItemId | undefined;
  activeToolItems: Map<string, RuntimeItemId>;
  stopped: boolean;
}

export interface OmpAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const makeOmpAdapter = (options?: OmpAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const runtimeEventQueue = yield* Queue.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );
    const sessions = new Map<ThreadId, OmpSessionContext>();
    const ownsNativeEventLogger = options?.nativeEventLogger === undefined;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const runtimeEventIngress = yield* makeBoundedCallbackIngress<
      ProviderRuntimeEvent,
      never,
      never
    >(
      (event) =>
        (nativeEventLogger && event.raw
          ? nativeEventLogger.write(event.raw, event.threadId).pipe(Effect.ignore)
          : Effect.void
        ).pipe(Effect.andThen(Queue.offer(runtimeEventQueue, event)), Effect.asVoid),
      {
        capacity: PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
        maxBufferedBytes: PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
        terminalReserve: PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
        isTerminal: isTerminalProviderRuntimeEvent,
        sizeOf: providerRuntimeEventBytes,
      },
    );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) => {
      runtimeEventIngress.offer(compactProviderRuntimeEventForIngress(event));
    };

    const makeEventBase = (
      context: OmpSessionContext,
      extra?: { readonly includeTurnId?: boolean },
    ) => ({
      eventId: EventId.makeUnsafe(crypto.randomUUID()),
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      ...(context.lifecycleGeneration !== undefined
        ? { lifecycleGeneration: context.lifecycleGeneration }
        : {}),
      ...(extra?.includeTurnId !== false && context.activeTurnId
        ? { turnId: context.activeTurnId }
        : {}),
    });

    const handleFrame = (context: OmpSessionContext, frame: OmpRpcFrame) => {
      const type = typeof frame.type === "string" ? frame.type : "";
      if (type === "agent_start") {
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "thread.state.changed",
          payload: { state: "active" },
          raw: { source: "omp.rpc.event", messageType: type, payload: frame },
        });
        return;
      }
      if (type === "turn_start") {
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "turn.started",
          payload: {
            ...(context.session.model ? { model: context.session.model } : {}),
          },
          raw: { source: "omp.rpc.event", messageType: type, payload: frame },
        });
        return;
      }
      if (type === "message_update") {
        const update = isRecord(frame.assistantMessageEvent) ? frame.assistantMessageEvent : null;
        if (update?.type === "text_delta" && typeof update.delta === "string") {
          if (!context.activeAssistantItemId) {
            context.activeAssistantItemId = RuntimeItemId.makeUnsafe(
              `omp-assistant-${crypto.randomUUID()}`,
            );
            offerRuntimeEvent({
              ...makeEventBase(context),
              itemId: context.activeAssistantItemId,
              type: "item.started",
              payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" },
              raw: { source: "omp.rpc.event", messageType: type, payload: frame },
            });
          }
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: context.activeAssistantItemId,
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta: update.delta },
            raw: { source: "omp.rpc.event", messageType: type, payload: frame },
          });
        }
        if (update?.type === "thinking_delta" && typeof update.delta === "string") {
          if (!context.activeReasoningItemId) {
            context.activeReasoningItemId = RuntimeItemId.makeUnsafe(
              `omp-reasoning-${crypto.randomUUID()}`,
            );
            offerRuntimeEvent({
              ...makeEventBase(context),
              itemId: context.activeReasoningItemId,
              type: "item.started",
              payload: { itemType: "reasoning", status: "inProgress", title: "Reasoning" },
              raw: { source: "omp.rpc.event", messageType: type, payload: frame },
            });
          }
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: context.activeReasoningItemId,
            type: "content.delta",
            payload: { streamKind: "reasoning_text", delta: update.delta },
            raw: { source: "omp.rpc.event", messageType: type, payload: frame },
          });
        }
        return;
      }
      if (type === "tool_execution_start") {
        const toolCallId =
          typeof frame.toolCallId === "string" ? frame.toolCallId : crypto.randomUUID();
        const toolName = typeof frame.toolName === "string" ? frame.toolName : "tool";
        const itemId = RuntimeItemId.makeUnsafe(`omp-tool-${toolCallId}`);
        context.activeToolItems.set(toolCallId, itemId);
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId,
          type: "item.started",
          payload: {
            itemType: "dynamic_tool_call",
            status: "inProgress",
            title: toolName,
            data: { toolCallId, toolName, args: frame.args },
          },
          raw: { source: "omp.rpc.event", messageType: type, payload: frame },
        });
        return;
      }
      if (type === "tool_execution_end") {
        const toolCallId = typeof frame.toolCallId === "string" ? frame.toolCallId : "";
        const itemId =
          context.activeToolItems.get(toolCallId) ??
          RuntimeItemId.makeUnsafe(`omp-tool-${toolCallId || crypto.randomUUID()}`);
        context.activeToolItems.delete(toolCallId);
        const detail = textFromUnknown(frame.result);
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId,
          type: "item.completed",
          payload: {
            itemType: "dynamic_tool_call",
            status: frame.isError === true ? "failed" : "completed",
            title: typeof frame.toolName === "string" ? frame.toolName : "tool",
            ...(detail ? { detail } : {}),
          },
          raw: { source: "omp.rpc.event", messageType: type, payload: frame },
        });
        return;
      }
      if (type === "turn_end" || type === "agent_end") {
        if (context.activeAssistantItemId) {
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: context.activeAssistantItemId,
            type: "item.completed",
            payload: { itemType: "assistant_message", status: "completed", title: "Assistant" },
            raw: { source: "omp.rpc.event", messageType: type, payload: frame },
          });
          context.activeAssistantItemId = undefined;
        }
        if (context.activeReasoningItemId) {
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: context.activeReasoningItemId,
            type: "item.completed",
            payload: { itemType: "reasoning", status: "completed", title: "Reasoning" },
            raw: { source: "omp.rpc.event", messageType: type, payload: frame },
          });
          context.activeReasoningItemId = undefined;
        }
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "turn.completed",
          payload: { state: "completed" },
          raw: { source: "omp.rpc.event", messageType: type, payload: frame },
        });
        context.activeTurnId = undefined;
      }
    };

    const requireSession = (threadId: ThreadId) =>
      Effect.sync(() => sessions.get(threadId)).pipe(
        Effect.flatMap((context) =>
          context
            ? Effect.succeed(context)
            : Effect.fail(
                new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
              ),
        ),
      );

    const stopSession: OmpAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) return;
        context.stopped = true;
        context.unsubscribe();
        sessions.delete(threadId);
        yield* Effect.tryPromise({
          try: async () => {
            await context.client.stop();
          },
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/stop",
              detail: toMessage(cause, "Failed to stop OMP session."),
              cause,
            }),
        }).pipe(Effect.ignore);
      });

    const startSession: OmpAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const cwd = trimToUndefined(input.cwd) ?? serverConfig.cwd;
        const executable = trimToUndefined(input.providerOptions?.omp?.binaryPath) ?? "omp";
        const agentDir = trimToUndefined(input.providerOptions?.omp?.agentDir);
        const model =
          input.modelSelection?.provider === "omp"
            ? trimToUndefined(input.modelSelection.model)
            : undefined;
        const thinkingLevel =
          input.modelSelection?.provider === "omp"
            ? trimToUndefined(input.modelSelection.options?.thinkingLevel)
            : undefined;
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopSession(input.threadId);
        }
        const args = ["--mode", "rpc", "--cwd", cwd, "--no-title"];
        if (model) args.push("--model", model);
        if (thinkingLevel) args.push("--thinking", thinkingLevel);
        if (input.runtimeMode !== "approval-required") {
          args.push("--auto-approve");
        }
        const resumeCursor =
          typeof input.resumeCursor === "string" ? trimToUndefined(input.resumeCursor) : undefined;
        if (resumeCursor) {
          args.push("--resume", resumeCursor);
        }
        const client = new OmpRpcClient({
          executable,
          args,
          cwd,
          env: buildProviderChildEnvironment({
            provider: "omp",
            overrides: {
              ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
            },
          }),
          spawnProcess: spawn,
        });
        yield* Effect.tryPromise({
          try: () => client.start(),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/start",
              detail: toMessage(cause, "Failed to start OMP RPC session."),
              cause,
            }),
        });
        if (model) {
          const parsed = parseOmpModelSlug(model);
          if (parsed.provider) {
            yield* Effect.tryPromise({
              try: () =>
                client.request({
                  type: "set_model",
                  provider: parsed.provider,
                  modelId: parsed.id,
                }),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "model/set",
                  detail: toMessage(cause, "Failed to set OMP model."),
                  cause,
                }),
            }).pipe(Effect.ignore);
          }
        }
        const now = new Date().toISOString();
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          threadId: input.threadId,
          createdAt: now,
          updatedAt: now,
          ...(model ? { model } : {}),
        };
        const context: OmpSessionContext = {
          lifecycleGeneration: input.lifecycleGeneration,
          client,
          unsubscribe: () => undefined,
          session,
          turns: [],
          activeTurnId: undefined,
          activeAssistantItemId: undefined,
          activeReasoningItemId: undefined,
          activeToolItems: new Map(),
          stopped: false,
        };
        context.unsubscribe = client.onFrame((frame) => handleFrame(context, frame));
        sessions.set(input.threadId, context);
        return session;
      });

    const sendTurn: OmpAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        if (context.activeTurnId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "An OMP turn is already active for this thread.",
          });
        }
        if (input.modelSelection?.provider === "omp") {
          const parsed = parseOmpModelSlug(input.modelSelection.model);
          if (parsed.provider) {
            yield* Effect.tryPromise({
              try: () =>
                context.client.request({
                  type: "set_model",
                  provider: parsed.provider,
                  modelId: parsed.id,
                }),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "model/set",
                  detail: toMessage(cause, "Failed to set OMP model."),
                  cause,
                }),
            });
          }
          const thinkingLevel = trimToUndefined(input.modelSelection.options?.thinkingLevel);
          if (thinkingLevel) {
            yield* Effect.tryPromise({
              try: () =>
                context.client.request({
                  type: "set_thinking_level",
                  level: thinkingLevel,
                }),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "thinking/set",
                  detail: toMessage(cause, "Failed to set OMP thinking level."),
                  cause,
                }),
            }).pipe(Effect.ignore);
          }
          context.session = { ...context.session, model: input.modelSelection.model };
        }
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        context.activeTurnId = turnId;
        context.turns.push({ id: turnId, items: [] });
        yield* Effect.tryPromise({
          try: () => context.client.request({ type: "prompt", message: input.input }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: toMessage(cause, "Failed to send OMP prompt."),
              cause,
            }),
        });
        return { threadId: input.threadId, turnId };
      });

    const steerTurn: NonNullable<OmpAdapterShape["steerTurn"]> = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        yield* Effect.tryPromise({
          try: () => context.client.request({ type: "steer", message: input.input }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/steer",
              detail: toMessage(cause, "Failed to steer OMP turn."),
              cause,
            }),
        });
        return {
          threadId: input.threadId,
          turnId: context.activeTurnId ?? TurnId.makeUnsafe(crypto.randomUUID()),
        };
      });

    const interruptTurn: OmpAdapterShape["interruptTurn"] = (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.tryPromise({
            try: () => context.client.request({ type: "abort" }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/interrupt",
                detail: toMessage(cause, "Failed to interrupt OMP turn."),
                cause,
              }),
          }),
        ),
        Effect.asVoid,
      );

    const listSessions: OmpAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values()).map((context) => context.session));

    const hasSession: OmpAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const snapshotThread = (context: OmpSessionContext) => ({
      threadId: context.session.threadId,
      ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
      turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
    });

    const readThread: OmpAdapterShape["readThread"] = (threadId) =>
      requireSession(threadId).pipe(Effect.map(snapshotThread));

    const rollbackThread: OmpAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        context.turns.splice(Math.max(0, context.turns.length - Math.max(0, numTurns)));
        return snapshotThread(context);
      });

    const compactThread: NonNullable<OmpAdapterShape["compactThread"]> = (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.tryPromise({
            try: () => context.client.request({ type: "compact" }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/compact",
                detail: toMessage(cause, "Failed to compact OMP thread."),
                cause,
              }),
          }),
        ),
        Effect.asVoid,
      );

    const stopAll: OmpAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.keys()), (threadId) => stopSession(threadId), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.asVoid);

    const listModels: NonNullable<OmpAdapterShape["listModels"]> = (input) =>
      Effect.tryPromise({
        try: async () => {
          const executable = trimToUndefined(input.binaryPath) ?? "omp";
          const cwd = trimToUndefined(input.cwd) ?? serverConfig.cwd;
          const agentDir = trimToUndefined(input.agentDir);
          const { stdout } = await execFileAsync(executable, ["models", "--json"], {
            cwd,
            env: buildProviderChildEnvironment({
              provider: "omp",
              overrides: {
                ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
              },
            }),
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024,
          });
          const models = parseOmpModelsJson(stdout).map(toOmpProviderModelDescriptor);
          return {
            models,
            source: "omp.cli",
            cached: false,
          } satisfies ProviderListModelsResult;
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: toMessage(cause, "Failed to list OMP models."),
            cause,
          }),
      });

    const listSkills: NonNullable<OmpAdapterShape["listSkills"]> = () =>
      Effect.succeed({
        skills: [],
        source: "omp.cli",
        cached: false,
      } satisfies ProviderListSkillsResult);

    const listCommands: NonNullable<OmpAdapterShape["listCommands"]> = (input) =>
      Effect.gen(function* () {
        const active = input.threadId
          ? sessions.get(ThreadId.makeUnsafe(input.threadId))
          : undefined;
        if (!active) {
          return {
            commands: [],
            source: "omp.cli",
            cached: false,
          } satisfies ProviderListCommandsResult;
        }
        const response = yield* Effect.tryPromise({
          try: () => active.client.request({ type: "get_available_commands" }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "command/list",
              detail: toMessage(cause, "Failed to list OMP commands."),
              cause,
            }),
        });
        const data = isRecord(response.data) ? response.data : {};
        const commands = Array.isArray(data.commands)
          ? data.commands.flatMap((command) => {
              if (!isRecord(command) || typeof command.name !== "string") return [];
              return [
                {
                  name: command.name,
                  description:
                    typeof command.description === "string" ? command.description : "OMP command",
                },
              ];
            })
          : [];
        return {
          commands,
          source: "omp.rpc",
          cached: false,
        } satisfies ProviderListCommandsResult;
      });

    const getComposerCapabilities: NonNullable<OmpAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: true,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.orDie,
        Effect.andThen(runtimeEventIngress.stop),
        Effect.ensuring(
          ownsNativeEventLogger && nativeEventLogger
            ? nativeEventLogger.close().pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.ensuring(Queue.shutdown(runtimeEventQueue)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsTurnSteering: true,
      },
      startSession,
      sendTurn,
      steerTurn,
      interruptTurn,
      respondToRequest: (threadId) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "request/respond",
            issue: `OMP session '${threadId}' does not support request responses.`,
          }),
        ),
      respondToUserInput: () => Effect.void,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      compactThread,
      stopAll,
      listModels,
      listSkills,
      listCommands,
      getComposerCapabilities,
      get streamEvents() {
        return Stream.fromQueue(runtimeEventQueue);
      },
    } satisfies OmpAdapterShape;
  });

export const OmpAdapterLive = Layer.effect(OmpAdapter, makeOmpAdapter());

export function makeOmpAdapterLive(options?: OmpAdapterLiveOptions) {
  return Layer.effect(OmpAdapter, makeOmpAdapter(options));
}
