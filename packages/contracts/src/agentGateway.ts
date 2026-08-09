/**
 * Public contracts for the Vulcan agent-control gateway.
 *
 * New gateway tools decode these schemas before doing any work. Keeping the
 * limits here ensures the MCP surface, server implementation, and tests share
 * the same definition of an exact creation/wait plan.
 */
import { Schema } from "effect";

import { ProjectId, ThreadId, TurnId } from "./baseSchemas";
import { ModelSelection, ProviderKind } from "./orchestration";
import { ProviderModelDescriptor } from "./providerDiscovery";
import { ServerProviderAuthStatus } from "./server";

export const VULCAN_GATEWAY_MAX_THREADS_PER_OPERATION = 20;
export const VULCAN_GATEWAY_MAX_REQUEST_ID_LENGTH = 256;
export const VULCAN_GATEWAY_MAX_WAIT_MS = 60_000;

export const VulcanGatewayErrorCode = Schema.Literals([
  "caller_session_inactive",
  "caller_turn_inactive",
  "capability_denied",
  "provider_unavailable",
  "model_unavailable",
  "model_option_unavailable",
  "idempotency_conflict",
  "creation_plan_locked",
  "creation_limit_exceeded",
  "thread_not_found",
  "wait_timed_out",
  "operation_failed",
]);
export type VulcanGatewayErrorCode = typeof VulcanGatewayErrorCode.Type;

export const VulcanGatewayError = Schema.Struct({
  code: VulcanGatewayErrorCode,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
});
export type VulcanGatewayError = typeof VulcanGatewayError.Type;

export const VulcanGatewayErrorResult = Schema.Struct({
  error: VulcanGatewayError,
});
export type VulcanGatewayErrorResult = typeof VulcanGatewayErrorResult.Type;

export const VulcanContextResult = Schema.Struct({
  harness: Schema.Struct({
    name: Schema.Literal("Vulcan"),
    policyVersion: Schema.String,
  }),
  caller: Schema.Struct({
    threadId: ThreadId,
    turnId: Schema.NullOr(TurnId),
    provider: ProviderKind,
    projectId: ProjectId,
  }),
  capabilities: Schema.Struct({
    threadRead: Schema.Boolean,
    threadCreate: Schema.Boolean,
    threadWait: Schema.Boolean,
    automations: Schema.Boolean,
  }),
});
export type VulcanContextResult = typeof VulcanContextResult.Type;

export const VulcanCreateThreadSpec = Schema.Struct({
  prompt: Schema.String.check(Schema.isNonEmpty()),
  title: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  target: ModelSelection,
  projectId: Schema.optional(ProjectId),
  environment: Schema.optional(Schema.Literals(["local", "worktree"])),
  baseRef: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  // Legacy inputs remain decodable for replay/backward compatibility, but the
  // MCP catalog no longer advertises branch-backed worktree creation.
  baseBranch: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  branchName: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  runtimeMode: Schema.optional(Schema.Literals(["approval-required", "full-access"])),
});
export type VulcanCreateThreadSpec = typeof VulcanCreateThreadSpec.Type;

const VulcanGatewayRequestId = Schema.String.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(VULCAN_GATEWAY_MAX_REQUEST_ID_LENGTH),
);

export const VulcanCreateThreadsInput = Schema.Struct({
  requestId: VulcanGatewayRequestId,
  threads: Schema.Array(VulcanCreateThreadSpec)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(VULCAN_GATEWAY_MAX_THREADS_PER_OPERATION)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type VulcanCreateThreadsInput = typeof VulcanCreateThreadsInput.Type;

export const VulcanProviderCatalog = Schema.Struct({
  provider: ProviderKind,
  defaultModel: Schema.NullOr(Schema.String),
  models: Schema.Array(ProviderModelDescriptor),
  enabled: Schema.Boolean,
  available: Schema.Boolean,
  authStatus: Schema.optional(ServerProviderAuthStatus),
  source: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type VulcanProviderCatalog = typeof VulcanProviderCatalog.Type;

export const VulcanGatewayTargetOptionValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
]);
export type VulcanGatewayTargetOptionValue = typeof VulcanGatewayTargetOptionValue.Type;

export const VulcanGatewayTargetOptionRule = Schema.Struct({
  key: Schema.String,
  valueType: Schema.Literals(["string", "number", "boolean"]),
  allowedValues: Schema.Array(VulcanGatewayTargetOptionValue),
  allowedValuesSource: Schema.Literals(["provider-contract", "model-discovery"]),
});
export type VulcanGatewayTargetOptionRule = typeof VulcanGatewayTargetOptionRule.Type;

export const VulcanGatewayTargetConstruction = Schema.Struct({
  modelValueSource: Schema.Literal("providers[].models[].slug"),
  primaryOptionKey: Schema.String,
  alternativeOptionKeys: Schema.Array(Schema.String),
  optionSelectionRule: Schema.String,
  providerOptions: Schema.Array(VulcanGatewayTargetOptionRule),
  optionsByModel: Schema.Record(Schema.String, Schema.Array(VulcanGatewayTargetOptionRule)),
  exampleTarget: Schema.NullOr(ModelSelection),
});
export type VulcanGatewayTargetConstruction = typeof VulcanGatewayTargetConstruction.Type;

export const VulcanCapabilitiesResult = Schema.Struct({
  targetConstruction: Schema.Record(Schema.String, VulcanGatewayTargetConstruction),
  providers: Schema.Array(VulcanProviderCatalog),
  limits: Schema.Struct({
    maxThreadsPerOperation: Schema.Int,
    maxWaitMs: Schema.Int,
    oneCreationPlanPerActiveTurn: Schema.Boolean,
  }),
});
export type VulcanCapabilitiesResult = typeof VulcanCapabilitiesResult.Type;

export const VulcanCreatedThreadResult = Schema.Struct({
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  target: ModelSelection,
  provider: ProviderKind,
  model: Schema.String,
  runtimeMode: Schema.Literals(["approval-required", "full-access"]),
  environment: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  status: Schema.Literal("task_dispatched"),
});
export type VulcanCreatedThreadResult = typeof VulcanCreatedThreadResult.Type;

export const VulcanCreateThreadsResult = Schema.Struct({
  operationId: Schema.String,
  requestId: VulcanGatewayRequestId,
  requestedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  createdCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  threadIds: Schema.Array(ThreadId),
  threads: Schema.Array(VulcanCreatedThreadResult),
});
export type VulcanCreateThreadsResult = typeof VulcanCreateThreadsResult.Type;

export const VulcanWaitForThreadsInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(VULCAN_GATEWAY_MAX_THREADS_PER_OPERATION)),
  runIds: Schema.optional(
    Schema.Array(Schema.NullOr(TurnId)).check(
      Schema.isMaxLength(VULCAN_GATEWAY_MAX_THREADS_PER_OPERATION),
    ),
  ),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
      Schema.isLessThanOrEqualTo(VULCAN_GATEWAY_MAX_WAIT_MS),
    ),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type VulcanWaitForThreadsInput = typeof VulcanWaitForThreadsInput.Type;

export const VulcanWaitedThreadResult = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(TurnId),
  state: Schema.Literals(["idle", "pending", "running", "completed", "error", "interrupted"]),
  terminal: Schema.Boolean,
  timedOut: Schema.Boolean,
  summary: Schema.NullOr(Schema.String),
  summaryTruncated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  readThread: Schema.Struct({
    tool: Schema.Literal("vulcan_read_thread"),
    arguments: Schema.Struct({ threadId: ThreadId }),
  }),
});
export type VulcanWaitedThreadResult = typeof VulcanWaitedThreadResult.Type;

export const VulcanWaitForThreadsResult = Schema.Struct({
  callerThreadId: ThreadId,
  runIds: Schema.Array(Schema.NullOr(TurnId)),
  allTerminal: Schema.Boolean,
  timedOut: Schema.Boolean,
  threads: Schema.Array(VulcanWaitedThreadResult),
});
export type VulcanWaitForThreadsResult = typeof VulcanWaitForThreadsResult.Type;
