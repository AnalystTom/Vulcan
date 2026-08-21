import { Schema } from "effect";

import {
  BotAuditEntryId,
  BotId,
  BotTaskId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas";
import {
  ModelSelection,
  ProviderInteractionMode,
  ProviderStartOptions,
  RuntimeMode,
} from "./orchestration";

// ── Bots ─────────────────────────────────────────────────────────────
//
// Bots are persistent named agents whose conversations are ordinary Vulcan
// threads. Each bot owns a file-based memory workspace on the server and any
// number of "task" threads that all share the bot's identity and memory.

export const DEFAULT_BOT_RUNTIME_MODE: RuntimeMode = "approval-required";

/**
 * Workspace keeps a bot inside its private memory/files directory. Worktree gives
 * project-scoped tasks a managed Git checkout instead of access to the user's
 * shared checkout. Worktree is the safe default for autonomous coworkers.
 */
export const BotIsolationMode = Schema.Literals(["workspace", "worktree"]);
export type BotIsolationMode = typeof BotIsolationMode.Type;
export const DEFAULT_BOT_ISOLATION_MODE: BotIsolationMode = "worktree";

/** Capabilities describe authority, independently from persona and skills. */
export const BotCapability = Schema.Literals([
  "thread.read",
  "thread.write",
  "automation.write",
  "browser.read",
  "browser.control",
  "filesystem.read",
  "filesystem.write",
  "shell.execute",
  "network.external",
  "peer.message",
]);
export type BotCapability = typeof BotCapability.Type;

export const DEFAULT_BOT_CAPABILITY_GRANTS: ReadonlyArray<BotCapability> = [
  "thread.read",
  "filesystem.read",
];

export const BotAutonomyConfig = Schema.Struct({
  enabled: Schema.Boolean,
  /** One by default; bounded to prevent a coworker from fanning out without control. */
  maxActiveRuns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
});
export type BotAutonomyConfig = typeof BotAutonomyConfig.Type;

export const DEFAULT_BOT_AUTONOMY: BotAutonomyConfig = {
  enabled: false,
  maxActiveRuns: 1,
};

/** Maximum number of non-archived bots on the roster. */
export const BOT_ROSTER_MAX = 40;

/** MEMORY.md excerpt budget when injected into a turn prompt (whichever cap hits first). */
export const BOT_MEMORY_PROMPT_MAX_LINES = 200;
export const BOT_MEMORY_PROMPT_MAX_BYTES = 24_000;

/** Hard byte cap for the MEMORY.md file itself (reads truncate, writes reject). */
export const BOT_MEMORY_FILE_MAX_BYTES = 262_144;

const BotIsoDateTime = IsoDateTime.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
);

export const BotColor = Schema.Literals([
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
]);
export type BotColor = typeof BotColor.Type;

export const BotAvatarShape = Schema.Literals([
  "idle",
  "happy",
  "curious",
  "drowsy",
  "working",
  "thinking",
  "listening",
  "sleeping",
  "suspicious",
  "proud",
]);
export type BotAvatarShape = typeof BotAvatarShape.Type;

export const BotAvatar = Schema.Struct({
  kind: Schema.Literals(["shape", "image"]),
  shape: Schema.optional(BotAvatarShape),
  color: BotColor,
  imageAttachmentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type BotAvatar = typeof BotAvatar.Type;

export const BotName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
export type BotName = typeof BotName.Type;

export const BotTitle = TrimmedString.check(Schema.isMaxLength(120));
export type BotTitle = typeof BotTitle.Type;

export const BotDescription = TrimmedString.check(Schema.isMaxLength(2_000));
export type BotDescription = typeof BotDescription.Type;

export const Bot = Schema.Struct({
  id: BotId,
  name: BotName,
  title: BotTitle,
  description: BotDescription,
  avatar: BotAvatar,
  modelSelection: ModelSelection,
  providerOptions: Schema.optional(Schema.NullOr(ProviderStartOptions)),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  isolationMode: Schema.optional(BotIsolationMode).pipe(
    Schema.withDecodingDefault(() => DEFAULT_BOT_ISOLATION_MODE),
  ),
  autonomy: Schema.optional(BotAutonomyConfig).pipe(
    Schema.withDecodingDefault(() => DEFAULT_BOT_AUTONOMY),
  ),
  capabilityGrants: Schema.optional(Schema.Array(BotCapability)).pipe(
    Schema.withDecodingDefault(() => [...DEFAULT_BOT_CAPABILITY_GRANTS]),
  ),
  /** Default cwd for new tasks; falls back to the bot workspace dir when null. */
  defaultWorkingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultProjectId: Schema.optional(Schema.NullOr(ProjectId)),
  /** At most one bot may be the chief of staff at a time. */
  chiefOfStaff: Schema.Boolean,
  approvePeerComms: Schema.Boolean,
  isPinned: Schema.Boolean,
  isHidden: Schema.Boolean,
  activeTaskId: Schema.NullOr(BotTaskId),
  /** Server-derived absolute path of the bot's memory workspace. */
  workspaceDir: TrimmedNonEmptyString,
  createdAt: BotIsoDateTime,
  updatedAt: BotIsoDateTime,
  archivedAt: Schema.NullOr(BotIsoDateTime),
});
export type Bot = typeof Bot.Type;

export const BotTask = Schema.Struct({
  id: BotTaskId,
  botId: BotId,
  threadId: ThreadId,
  /** Optional project whose cwd the task thread runs in (instead of the bot workspace). */
  pinnedProjectId: Schema.NullOr(ProjectId),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  createdAt: BotIsoDateTime,
  updatedAt: BotIsoDateTime,
  archivedAt: Schema.NullOr(BotIsoDateTime),
});
export type BotTask = typeof BotTask.Type;

export const BotMemory = Schema.Struct({
  botId: BotId,
  text: Schema.String.check(Schema.isMaxLength(BOT_MEMORY_FILE_MAX_BYTES)),
  /** True when the prompt excerpt was clipped by the line/byte budget. */
  truncatedForPrompt: Schema.Boolean,
  updatedAt: BotIsoDateTime,
});
export type BotMemory = typeof BotMemory.Type;

export const BotControlPhase = Schema.Literals([
  "idle",
  "running",
  "waiting-for-approval",
  "takeover-requested",
  "human-control",
  "paused",
  "error",
]);
export type BotControlPhase = typeof BotControlPhase.Type;

/** Durable control-plane state. Human control is explicit and blocks autonomous actions. */
export const BotRuntimeState = Schema.Struct({
  botId: BotId,
  phase: BotControlPhase,
  activeThreadId: Schema.NullOr(ThreadId),
  takeoverReason: Schema.NullOr(TrimmedString.check(Schema.isMaxLength(2_000))),
  updatedAt: BotIsoDateTime,
});
export type BotRuntimeState = typeof BotRuntimeState.Type;

export const BotActionDecision = Schema.Literals([
  "allowed",
  "denied",
  "approval-required",
  "cancelled",
  "failed",
]);
export type BotActionDecision = typeof BotActionDecision.Type;

/** Append-only record written before or as an autonomous side effect is decided. */
export const BotActionAuditEntry = Schema.Struct({
  id: BotAuditEntryId,
  botId: BotId,
  taskId: Schema.NullOr(BotTaskId),
  threadId: Schema.NullOr(ThreadId),
  capability: BotCapability,
  action: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  decision: BotActionDecision,
  summary: TrimmedString.check(Schema.isMaxLength(2_000)),
  detailJson: Schema.NullOr(Schema.String.check(Schema.isMaxLength(32_768))),
  createdAt: BotIsoDateTime,
});
export type BotActionAuditEntry = typeof BotActionAuditEntry.Type;

// ── RPC inputs / results ─────────────────────────────────────────────

export const BotListInput = Schema.Struct({
  includeArchived: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
});
export type BotListInput = typeof BotListInput.Type;

export const BotListResult = Schema.Struct({
  bots: Schema.Array(Bot),
  tasks: Schema.Array(BotTask),
  runtimeStates: Schema.optional(Schema.Array(BotRuntimeState)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
});
export type BotListResult = typeof BotListResult.Type;

export const BotCreateInput = Schema.Struct({
  name: BotName,
  title: Schema.optional(BotTitle).pipe(Schema.withDecodingDefault(() => "")),
  description: Schema.optional(BotDescription).pipe(Schema.withDecodingDefault(() => "")),
  avatar: BotAvatar,
  modelSelection: ModelSelection,
  providerOptions: Schema.optional(Schema.NullOr(ProviderStartOptions)),
  runtimeMode: Schema.optional(RuntimeMode).pipe(
    Schema.withDecodingDefault(() => DEFAULT_BOT_RUNTIME_MODE),
  ),
  interactionMode: Schema.optional(ProviderInteractionMode).pipe(
    Schema.withDecodingDefault(() => "default" as const),
  ),
  isolationMode: Schema.optional(BotIsolationMode).pipe(
    Schema.withDecodingDefault(() => DEFAULT_BOT_ISOLATION_MODE),
  ),
  autonomy: Schema.optional(BotAutonomyConfig).pipe(
    Schema.withDecodingDefault(() => DEFAULT_BOT_AUTONOMY),
  ),
  capabilityGrants: Schema.optional(Schema.Array(BotCapability)).pipe(
    Schema.withDecodingDefault(() => [...DEFAULT_BOT_CAPABILITY_GRANTS]),
  ),
  defaultWorkingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultProjectId: Schema.optional(Schema.NullOr(ProjectId)),
  chiefOfStaff: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  approvePeerComms: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  isHidden: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
});
export type BotCreateInput = typeof BotCreateInput.Type;

export const BotCreateResult = Schema.Struct({
  bot: Bot,
});
export type BotCreateResult = typeof BotCreateResult.Type;

export const BotUpdateInput = Schema.Struct({
  id: BotId,
  name: Schema.optional(BotName),
  title: Schema.optional(BotTitle),
  description: Schema.optional(BotDescription),
  avatar: Schema.optional(BotAvatar),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(Schema.NullOr(ProviderStartOptions)),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  isolationMode: Schema.optional(BotIsolationMode),
  autonomy: Schema.optional(BotAutonomyConfig),
  capabilityGrants: Schema.optional(Schema.Array(BotCapability)),
  defaultWorkingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultProjectId: Schema.optional(Schema.NullOr(ProjectId)),
  chiefOfStaff: Schema.optional(Schema.Boolean),
  approvePeerComms: Schema.optional(Schema.Boolean),
  isPinned: Schema.optional(Schema.Boolean),
  isHidden: Schema.optional(Schema.Boolean),
});
export type BotUpdateInput = typeof BotUpdateInput.Type;

export const BotUpdateResult = Schema.Struct({
  bot: Bot,
});
export type BotUpdateResult = typeof BotUpdateResult.Type;

export const BotDeleteInput = Schema.Struct({
  id: BotId,
});
export type BotDeleteInput = typeof BotDeleteInput.Type;

export const BotDeleteResult = Schema.Struct({
  deleted: Schema.Boolean,
});
export type BotDeleteResult = typeof BotDeleteResult.Type;

export const BotTaskCreateInput = Schema.Struct({
  botId: BotId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  pinnedProjectId: Schema.optional(Schema.NullOr(ProjectId)),
});
export type BotTaskCreateInput = typeof BotTaskCreateInput.Type;

export const BotTaskCreateResult = Schema.Struct({
  task: BotTask,
  bot: Bot,
});
export type BotTaskCreateResult = typeof BotTaskCreateResult.Type;

export const BotTaskRunInput = Schema.Struct({
  botId: BotId,
  taskId: BotTaskId,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)),
});
export type BotTaskRunInput = typeof BotTaskRunInput.Type;

export const BotTaskRunResult = Schema.Struct({
  task: BotTask,
  state: BotRuntimeState,
});
export type BotTaskRunResult = typeof BotTaskRunResult.Type;

export const BotTaskSetActiveInput = Schema.Struct({
  botId: BotId,
  taskId: Schema.NullOr(BotTaskId),
});
export type BotTaskSetActiveInput = typeof BotTaskSetActiveInput.Type;

export const BotTaskSetActiveResult = Schema.Struct({
  bot: Bot,
});
export type BotTaskSetActiveResult = typeof BotTaskSetActiveResult.Type;

export const BotTaskArchiveInput = Schema.Struct({
  taskId: BotTaskId,
});
export type BotTaskArchiveInput = typeof BotTaskArchiveInput.Type;

export const BotTaskArchiveResult = Schema.Struct({
  task: BotTask,
});
export type BotTaskArchiveResult = typeof BotTaskArchiveResult.Type;

export const BotMemoryGetInput = Schema.Struct({
  botId: BotId,
});
export type BotMemoryGetInput = typeof BotMemoryGetInput.Type;

export const BotMemoryGetResult = Schema.Struct({
  memory: BotMemory,
});
export type BotMemoryGetResult = typeof BotMemoryGetResult.Type;

export const BotMemorySetInput = Schema.Struct({
  botId: BotId,
  text: Schema.String.check(Schema.isMaxLength(BOT_MEMORY_FILE_MAX_BYTES)),
});
export type BotMemorySetInput = typeof BotMemorySetInput.Type;

export const BotMemorySetResult = Schema.Struct({
  memory: BotMemory,
});
export type BotMemorySetResult = typeof BotMemorySetResult.Type;

export const BotControlAction = Schema.Literals([
  "request-takeover",
  "take-control",
  "release-control",
  "pause",
  "resume",
]);
export type BotControlAction = typeof BotControlAction.Type;

export const BotControlInput = Schema.Struct({
  botId: BotId,
  action: BotControlAction,
  activeThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  reason: Schema.optional(TrimmedString.check(Schema.isMaxLength(2_000))),
});
export type BotControlInput = typeof BotControlInput.Type;

export const BotControlResult = Schema.Struct({
  state: BotRuntimeState,
});
export type BotControlResult = typeof BotControlResult.Type;

export const BotAuditListInput = Schema.Struct({
  botId: BotId,
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))).pipe(
    Schema.withDecodingDefault(() => 100),
  ),
});
export type BotAuditListInput = typeof BotAuditListInput.Type;

export const BotAuditListResult = Schema.Struct({
  entries: Schema.Array(BotActionAuditEntry),
});
export type BotAuditListResult = typeof BotAuditListResult.Type;

// ── Event stream ─────────────────────────────────────────────────────

export const BotEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    bots: Schema.Array(Bot),
    tasks: Schema.Array(BotTask),
    runtimeStates: Schema.optional(Schema.Array(BotRuntimeState)).pipe(
      Schema.withDecodingDefault(() => []),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("bot.upserted"),
    bot: Bot,
  }),
  Schema.Struct({
    type: Schema.Literal("bot.deleted"),
    botId: BotId,
  }),
  Schema.Struct({
    type: Schema.Literal("task.upserted"),
    task: BotTask,
  }),
  Schema.Struct({
    type: Schema.Literal("task.deleted"),
    taskId: BotTaskId,
  }),
  Schema.Struct({
    type: Schema.Literal("runtime.updated"),
    state: BotRuntimeState,
  }),
  Schema.Struct({
    type: Schema.Literal("audit.appended"),
    entry: BotActionAuditEntry,
  }),
]);
export type BotEvent = typeof BotEvent.Type;
