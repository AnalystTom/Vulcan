// FILE: useHermesBots.ts
// Purpose: Native Hermes Bot-mode data layer for the web app. One optional native-API door
//          (`hermesBots`), tolerant parsers for the pinned gateway payloads (v0.21.2,
//          b7b35a8), react-query keys/queries, and the mutations the Bots UI needs.
//          Hermes owns profiles, sessions, rooms and routines; nothing here schedules,
//          queues or replays work — every write is one explicit user action.
// Layer: Web hook
// Exports: readHermesBotsApi, useHermesBotsApi, useHermesStatus, useHermesEvent,
//          useHermesEventInvalidation, useHermesProfiles, useHermesProfileAvatar,
//          useHermesProfileDetail, useHermesModelCatalog, useHermesProfileMutations,
//          useHermesChat, useHermesChatMutations, useHermesRooms, useHermesRoomState,
//          useHermesRoomLog, useHermesRoomMutations, useHermesRoutines,
//          useHermesRoutineMutations, hermesTimeToIso, HERMES_BOT_CHAT_TITLE, HERMES_UI_META_KEY

import type {
  HermesBotCapabilities,
  HermesBotConnectInput,
  HermesBotEvent,
  HermesBotMethod,
  HermesBotRequest,
  HermesBotStatus,
  NativeApi,
} from "@vulcan/contracts";
import { Schema } from "effect";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { readNativeApi } from "../nativeApi";
import { toastManager } from "../components/ui/toast";

// ── Native API door ────────────────────────────────────────────────────────────

export type HermesCapabilities = HermesBotCapabilities;
export type HermesBotsStatus = HermesBotStatus;
export type HermesBotsEvent = HermesBotEvent;
export type HermesBotsNativeApi = NonNullable<NativeApi["hermesBots"]>;

/** Null when this server build has no Hermes bridge; the legacy Bots view stays in charge. */
export function readHermesBotsApi(): HermesBotsNativeApi | null {
  const api = readNativeApi();
  return api?.hermesBots ?? null;
}

export function useHermesBotsApi(): HermesBotsNativeApi | null {
  return useMemo(readHermesBotsApi, []);
}

function requireApi(): HermesBotsNativeApi {
  const api = readHermesBotsApi();
  if (!api) throw new Error("This Vulcan server has no Hermes bridge.");
  return api;
}

async function call(
  method: HermesBotMethod,
  params: HermesBotRequest["params"] = {},
): Promise<unknown> {
  return requireApi().request({ method, params });
}

const HERMES_REGISTRY_READ_CAPACITY_CODE = "RPC_REQUEST_CAPACITY_EXCEEDED";
const HERMES_REGISTRY_READ_RETRY_LIMIT = 4;
const HERMES_REGISTRY_READ_RETRY_MS = 250;

function errorCause(error: unknown): unknown {
  return rec(error)?.cause;
}

export function shouldRetryHermesRegistryRead(failureCount: number, error: unknown): boolean {
  return (
    rec(errorCause(error))?.code === HERMES_REGISTRY_READ_CAPACITY_CODE &&
    failureCount < HERMES_REGISTRY_READ_RETRY_LIMIT
  );
}

function hermesRegistryReadRetryDelay(_attempt: number, error: unknown): number {
  const retryAfterMs = num(rec(errorCause(error))?.retryAfterMs);
  return retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : HERMES_REGISTRY_READ_RETRY_MS;
}

// ── Tolerant payload readers ───────────────────────────────────────────────────

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return list(value).flatMap((entry) => (typeof entry === "string" ? [entry] : []));
}

function requiredList(body: unknown, key: string): unknown[] {
  const root = rec(body);
  const rows = root?.[key];
  if (!Array.isArray(rows)) throw new Error(`The gateway returned an invalid ${key} list.`);
  return rows;
}

/** Gateway timestamps are Unix seconds (floats); a few fields are ms. Null when absent. */
export function hermesTimeToIso(value: unknown): string | null {
  const seconds = num(value);
  if (seconds === null || seconds <= 0) return null;
  const ms = seconds > 1e12 ? seconds : seconds * 1000;
  return new Date(ms).toISOString();
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ── Constants from the gateway source ──────────────────────────────────────────

/** A bot's one forever-chat is the session titled exactly this on its profile. */
export const HERMES_BOT_CHAT_TITLE = "Bot Chat";
/** Per-bot presentation metadata rides profile.yaml `ui_meta` under this key. */
export const HERMES_UI_META_KEY = "hermes-bots";
const ROUTINE_TAG_RE = /^\[bot:([a-z0-9][a-z0-9_-]*)\]\s*/i;
const SESSION_LIST_LIMIT = 200;
const ROOM_LOG_PAGE_LIMIT = 500;

// ── Profiles ───────────────────────────────────────────────────────────────────

export interface HermesSessionPreview {
  readonly id: string;
  readonly resolvedId: string | null;
  readonly title: string;
  readonly preview: string;
  readonly lastActiveIso: string | null;
  readonly messageCount: number | null;
}

export interface HermesProfile {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  /** Role label the user gave this bot (ui_meta), distinct from the profile name. */
  readonly title: string | null;
  readonly hidden: boolean;
  readonly isDefault: boolean;
  readonly provider: string | null;
  readonly model: string | null;
  readonly skillCount: number;
  readonly hasAvatar: boolean;
  readonly canonical: HermesSessionPreview | null;
  readonly lastSession: HermesSessionPreview | null;
  /** Newest hidden worker heartbeat; evidence of recent activity, not a running-turn guarantee. */
  readonly workerLastActiveIso: string | null;
  /** Compare-and-swap revision for the ui_meta key; null when the gateway reports none. */
  readonly uiMetaRevision: number | null;
}

export interface HermesProfileList {
  readonly profiles: readonly HermesProfile[];
  /** The gateway injects the teammate-messaging protocol itself. */
  readonly botModeProtocol: boolean;
}

function parseSessionPreview(value: unknown): HermesSessionPreview | null {
  const row = rec(value);
  const id = row ? str(row.id) : null;
  if (!row || !id) return null;
  return {
    id,
    resolvedId: str(row.resolved_id),
    title: str(row.title) ?? "",
    preview: str(row.preview) ?? "",
    lastActiveIso: hermesTimeToIso(row.last_active) ?? hermesTimeToIso(row.started_at),
    messageCount: num(row.message_count),
  };
}

function parseProfile(value: unknown): HermesProfile | null {
  const row = rec(value);
  const name = row ? str(row.name) : null;
  if (!row || !name) return null;
  const meta = rec(rec(row.ui_meta)?.[HERMES_UI_META_KEY]);
  const revisions = rec(row.ui_meta_revisions);
  const worker = rec(row.worker_session);
  return {
    name,
    displayName: str(row.display_name) ?? name,
    description: str(row.description) ?? "",
    title: meta ? str(meta.title) : null,
    hidden: meta ? (bool(meta.hidden) ?? false) : false,
    isDefault: bool(row.is_default) ?? false,
    provider: str(row.provider),
    model: str(row.model),
    skillCount: num(row.skill_count) ?? 0,
    hasAvatar: bool(row.has_avatar) ?? false,
    canonical: parseSessionPreview(row.canonical_session),
    lastSession: parseSessionPreview(row.last_session),
    workerLastActiveIso: worker ? hermesTimeToIso(worker.last_active) : null,
    uiMetaRevision: revisions ? num(revisions[HERMES_UI_META_KEY]) : null,
  };
}

export function parseProfileList(body: unknown): HermesProfileList {
  const root = rec(body);
  const profiles = requiredList(body, "profiles");
  return {
    profiles: profiles.flatMap((entry) => {
      const profile = parseProfile(entry);
      return profile ? [profile] : [];
    }),
    botModeProtocol: bool(root?.bot_mode_protocol) ?? false,
  };
}

export interface HermesProfileDetail {
  readonly name: string;
  readonly description: string;
  readonly soul: string;
  readonly provider: string;
  readonly model: string;
  readonly skills: readonly { name: string; enabled: boolean }[];
  readonly toolsets: readonly {
    name: string;
    label: string;
    description: string;
    toolCount: number;
    enabled: boolean;
  }[];
  readonly toolsetsPinned: boolean;
  readonly mcpServers: readonly { name: string; enabled: boolean; transport: string }[];
}

export function parseProfileDetail(body: unknown): HermesProfileDetail {
  const root = rec(body);
  const name = root ? str(root.name) : null;
  if (!root || !name) throw new Error("The gateway returned an invalid profile detail.");
  const model = rec(root.model) ?? {};
  return {
    name,
    description: str(root.description) ?? "",
    soul: typeof root.soul === "string" ? root.soul : "",
    provider: str(model.provider) ?? "",
    model: str(model.default) ?? "",
    skills: list(root.skills).flatMap((entry) => {
      const row = rec(entry);
      const name = row ? str(row.name) : null;
      return row && name ? [{ name, enabled: bool(row.enabled) ?? true }] : [];
    }),
    toolsets: list(root.toolsets).flatMap((entry) => {
      const row = rec(entry);
      const name = row ? str(row.name) : null;
      return row && name
        ? [
            {
              name,
              label: str(row.label) ?? name,
              description: str(row.description) ?? "",
              toolCount: num(row.tool_count) ?? 0,
              enabled: bool(row.enabled) ?? false,
            },
          ]
        : [];
    }),
    toolsetsPinned: bool(root.toolsets_pinned) ?? false,
    mcpServers: list(root.mcp_servers).flatMap((entry) => {
      const row = rec(entry);
      const name = row ? str(row.name) : null;
      return row && name
        ? [{ name, enabled: bool(row.enabled) ?? true, transport: str(row.transport) ?? "stdio" }]
        : [];
    }),
  };
}

export interface HermesModelProvider {
  readonly slug: string;
  readonly name: string;
  /** Null when the gateway did not report authentication for this provider. */
  readonly authenticated: boolean | null;
  readonly isCurrent: boolean;
  readonly models: readonly { id: string; name: string; isCurrent: boolean }[];
}

export function parseModelCatalog(body: unknown): HermesModelProvider[] {
  return list(rec(body)?.providers).flatMap((entry) => {
    const row = rec(entry);
    const slug = row ? str(row.slug) : null;
    if (!row || !slug) return [];
    return [
      {
        slug,
        name: str(row.name) ?? slug,
        authenticated: bool(row.authenticated),
        isCurrent: bool(row.is_current) ?? false,
        models: list(row.models).flatMap((model) => {
          if (typeof model === "string")
            return model ? [{ id: model, name: model, isCurrent: false }] : [];
          const modelRow = rec(model);
          const id = modelRow ? (str(modelRow.id) ?? str(modelRow.name)) : null;
          return modelRow && id
            ? [
                {
                  id,
                  name: str(modelRow.name) ?? id,
                  isCurrent: bool(modelRow.is_current) ?? false,
                },
              ]
            : [];
        }),
      },
    ];
  });
}

// ── Canonical chat ─────────────────────────────────────────────────────────────

export type HermesChatRole = "user" | "assistant" | "tool" | "system";

export interface HermesChatMessage {
  readonly index: number;
  readonly role: HermesChatRole;
  readonly text: string;
  readonly timestampIso: string | null;
  readonly rowId: string | null;
  readonly displayKind: string | null;
  readonly toolName: string | null;
  readonly toolContext: string | null;
}

export interface HermesPendingApproval {
  readonly requestId: string | null;
  readonly command: string | null;
  readonly description: string | null;
  readonly choices: readonly string[];
}

export interface HermesClarifyQuestion {
  readonly qid: string | null;
  readonly question: string;
  readonly choices: readonly string[];
  readonly multiSelect: boolean;
}

export interface HermesPendingClarify {
  readonly requestId: string | null;
  readonly questions: readonly HermesClarifyQuestion[];
}

export interface HermesChatSnapshot {
  readonly profile: string;
  /** Durable registry row for the "Bot Chat" session. */
  readonly storedSessionId: string;
  /** Live runtime id every prompt/interrupt/approval RPC targets. */
  readonly runtimeSessionId: string;
  readonly messages: readonly HermesChatMessage[];
  readonly running: boolean;
  readonly status: string | null;
  readonly failure: { readonly message: string; readonly retryable: boolean | null } | null;
  readonly pendingApproval: HermesPendingApproval | null;
  readonly pendingClarify: HermesPendingClarify | null;
  readonly loadedAtIso: string;
}

export function parseChatMessages(value: unknown): HermesChatMessage[] {
  const seenRows = new Set<string>();
  return list(value).flatMap((entry, index) => {
    const row = rec(entry);
    const role = row ? str(row.role) : null;
    if (!row || (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system")) {
      return [];
    }
    // Tool-call-only assistant rows have no chat text; the native tool row renders their activity.
    if (role === "assistant" && (typeof row.text !== "string" || !row.text.trim())) return [];
    const rowId = typeof row.row_id === "number" ? String(row.row_id) : str(row.row_id);
    // Native resume may repeat persisted rows while merging live and stored history.
    // Preserve unkeyed tool/activity rows; only a native row id proves duplication.
    if (rowId !== null) {
      if (seenRows.has(rowId)) return [];
      seenRows.add(rowId);
    }
    return [
      {
        index,
        role,
        text: typeof row.text === "string" ? row.text : "",
        timestampIso: hermesTimeToIso(row.timestamp),
        rowId,
        displayKind: str(row.display_kind),
        toolName: role === "tool" ? str(row.name) : null,
        toolContext: role === "tool" ? str(row.context) : null,
      },
    ];
  });
}

export function parsePendingApproval(value: unknown): HermesPendingApproval | null {
  const row = rec(value);
  if (!row) return null;
  return {
    requestId: str(row.request_id),
    command: str(row.command),
    description: str(row.description),
    choices: strings(row.choices),
  };
}

export function parsePendingClarify(value: unknown): HermesPendingClarify | null {
  const row = rec(value);
  if (!row) return null;
  const batch = list(row.questions).flatMap((entry) => {
    const question = rec(entry);
    const text = question ? str(question.question) : null;
    return question && text
      ? [
          {
            qid: str(question.qid) ?? str(question.id),
            question: text,
            choices: strings(question.choices),
            multiSelect: bool(question.multi_select) ?? bool(question.multiSelect) ?? false,
          },
        ]
      : [];
  });
  const single = str(row.question);
  const questions =
    batch.length > 0
      ? batch
      : single
        ? [
            {
              qid: null,
              question: single,
              choices: strings(row.choices),
              multiSelect: bool(row.multi_select) ?? false,
            },
          ]
        : [];
  if (questions.length === 0) return null;
  return { requestId: str(row.request_id), questions };
}

function parseResume(body: unknown, profile: string, storedSessionId: string): HermesChatSnapshot {
  const root = rec(body) ?? {};
  const runtimeSessionId = str(root.session_id);
  if (!runtimeSessionId) throw new Error("The gateway resumed the chat without a session id.");
  // Native sessions become idle after a failed turn; its replayable outcome lives in inflight.
  const inflight = rec(root.inflight);
  const failure =
    inflight?.status === "error"
      ? {
          message: str(inflight.error) ?? "The native turn failed without an error message.",
          retryable: bool(rec(inflight.error_surface)?.retryable),
        }
      : null;
  return {
    profile,
    // `session_key` echoes the resume target, which may be a compressed lineage tip. The
    // caller's registry id remains the durable Bot Chat identity across resume calls.
    storedSessionId:
      storedSessionId || str(root.stored_session_id) || str(root.session_key) || runtimeSessionId,
    runtimeSessionId,
    messages: parseChatMessages(root.messages),
    running: bool(root.running) ?? false,
    status: failure ? "error" : str(root.status),
    failure,
    pendingApproval: parsePendingApproval(root.pending_approval),
    pendingClarify: parsePendingClarify(root.pending_clarify),
    loadedAtIso: new Date().toISOString(),
  };
}

function parseSessionRows(body: unknown): HermesSessionPreview[] {
  return requiredList(body, "sessions").flatMap((entry) => {
    const row = parseSessionPreview(entry);
    return row ? [row] : [];
  });
}

/**
 * The exact registry lookup: the profile's session titled "Bot Chat". Fails closed — a failed or
 * unconfirmed lookup never reads as "no chat exists", because minting a second Bot Chat forks the
 * bot's history. `knownCanonicalId` is the roster's last positive confirmation.
 */
export async function resolveCanonicalChat(profile: string, knownCanonicalId: string | null) {
  let rows: HermesSessionPreview[];
  try {
    rows = parseSessionRows(
      await call("session.list", {
        profile,
        title: HERMES_BOT_CHAT_TITLE,
        include_hidden: true,
        limit: SESSION_LIST_LIMIT,
      }),
    );
  } catch (cause) {
    throw new Error(
      `Could not check ${profile}'s Bot Chat registry (${errorMessage(cause)}). Not starting a new chat.`,
      { cause },
    );
  }
  const existing = rows.find((row) => row.title === HERMES_BOT_CHAT_TITLE) ?? null;
  if (!existing && rows.length > 0) {
    throw new Error(
      `Could not confirm ${profile}'s Bot Chat registry. Not starting a new chat; try again.`,
    );
  }
  if (existing) {
    const resumed = await call("session.resume", {
      session_id: existing.resolvedId ?? existing.id,
      profile,
    });
    return parseResume(resumed, profile, existing.id);
  }
  if (knownCanonicalId) {
    throw new Error(
      `Could not confirm ${profile}'s Bot Chat registry. Not starting a new chat; try again.`,
    );
  }
  const created = rec(
    await call("session.create", {
      profile,
      title: HERMES_BOT_CHAT_TITLE,
      hidden: true,
      follow_profile_config: true,
    }),
  );
  const runtimeSessionId = created ? str(created.session_id) : null;
  const storedSessionId = created ? str(created.stored_session_id) : null;
  if (!runtimeSessionId || !storedSessionId)
    throw new Error("The gateway created the chat without ids.");
  try {
    await call("session.title", { session_id: runtimeSessionId, title: HERMES_BOT_CHAT_TITLE });
  } catch (cause) {
    // Another writer took the canonical title between our miss and this write: adopt the winner.
    if (/already in use/i.test(errorMessage(cause))) {
      const winner = parseSessionRows(
        await call("session.list", {
          profile,
          title: HERMES_BOT_CHAT_TITLE,
          include_hidden: true,
          limit: SESSION_LIST_LIMIT,
        }),
      ).find((row) => row.title === HERMES_BOT_CHAT_TITLE);
      if (winner) {
        return parseResume(
          await call("session.resume", { session_id: winner.resolvedId ?? winner.id, profile }),
          profile,
          winner.id,
        );
      }
    }
    throw cause;
  }
  return {
    profile,
    storedSessionId,
    runtimeSessionId,
    messages: [],
    running: false,
    status: null,
    failure: null,
    pendingApproval: null,
    pendingClarify: null,
    loadedAtIso: new Date().toISOString(),
  } satisfies HermesChatSnapshot;
}

// ── Rooms (native hosted group chats) ──────────────────────────────────────────

export interface HermesRoomMember {
  readonly memberId: string;
  readonly profile: string;
  readonly handle: string | null;
  readonly displayName: string | null;
}

export interface HermesRoom {
  readonly roomId: string;
  readonly name: string;
  readonly members: readonly HermesRoomMember[];
  readonly authorityGatewayId: string;
  readonly authorityEpoch: number;
  readonly revision: number;
  readonly createdAtIso: string | null;
  readonly updatedAtIso: string | null;
  readonly latestSeq: number | null;
  readonly disbandedAtIso: string | null;
}

export interface HermesRoomActor {
  readonly kind: string;
  readonly id: string;
  readonly displayName: string | null;
  readonly profile: string | null;
}

export interface HermesRoomEvent {
  readonly roomId: string;
  readonly seq: number;
  readonly eventId: string;
  readonly kind: string;
  readonly actor: HermesRoomActor;
  readonly authorityEpoch: number | null;
  readonly payload: Rec;
  readonly createdAtIso: string | null;
}

export interface HermesRoomLog {
  readonly roomId: string;
  readonly events: readonly HermesRoomEvent[];
  readonly latestSeq: number;
  readonly hasMore: boolean;
  readonly authorityEpoch: number | null;
}

export type HermesRoomPendingAction =
  | { readonly kind: "retry"; readonly taskId: string; readonly memberId: string | null }
  | {
      readonly kind: "approval";
      readonly taskId: string;
      readonly memberId: string | null;
      readonly executionGeneration: number;
      readonly requestId: string | null;
      readonly approval: HermesPendingApproval;
    }
  | { readonly kind: "other"; readonly label: string; readonly memberId: string | null };

export interface HermesRoomDriverStatus {
  readonly running: boolean;
  readonly working: boolean;
  readonly blocked: boolean;
  readonly counts: Readonly<Record<string, number>>;
  readonly pendingActions: readonly HermesRoomPendingAction[];
}

export interface HermesRoomState {
  readonly room: HermesRoom;
  /** Null when the process-owned driver is not running; the gateway then omits it. */
  readonly driver: HermesRoomDriverStatus | null;
}

function parseRoom(value: unknown): HermesRoom | null {
  const row = rec(value);
  const roomId = row ? str(row.room_id) : null;
  if (!row || !roomId) return null;
  return {
    roomId,
    name: str(row.name) ?? roomId,
    members: list(row.members).flatMap((entry) => {
      const member = rec(entry);
      const profile = member ? (str(member.profile) ?? str(member.member_id)) : null;
      return member && profile
        ? [
            {
              memberId: str(member.member_id) ?? profile,
              profile,
              handle: str(member.handle),
              displayName: str(member.display_name),
            },
          ]
        : [];
    }),
    authorityGatewayId: str(row.authority_gateway_id) ?? "",
    authorityEpoch: num(row.authority_epoch) ?? 0,
    revision: num(row.revision) ?? 0,
    createdAtIso: hermesTimeToIso(row.created_at),
    updatedAtIso: hermesTimeToIso(row.updated_at),
    latestSeq: num(row.latest_seq),
    disbandedAtIso: hermesTimeToIso(row.disbanded_at),
  };
}

export function parseRoomList(body: unknown): HermesRoom[] {
  return requiredList(body, "rooms").flatMap((entry) => {
    const room = parseRoom(entry);
    return room && room.disbandedAtIso === null ? [room] : [];
  });
}

function parseRoomEvent(value: unknown): HermesRoomEvent | null {
  const row = rec(value);
  const seq = row ? num(row.seq) : null;
  const kind = row ? str(row.kind) : null;
  if (!row || seq === null || !kind) return null;
  const actor = rec(row.actor) ?? {};
  return {
    roomId: str(row.room_id) ?? "",
    seq,
    eventId: str(row.event_id) ?? `seq-${seq}`,
    kind,
    actor: {
      kind: str(actor.kind) ?? "system",
      id: str(actor.id) ?? "",
      displayName: str(actor.display_name),
      profile: str(actor.profile),
    },
    authorityEpoch: num(row.authority_epoch),
    payload: rec(row.payload) ?? {},
    createdAtIso: hermesTimeToIso(row.created_at),
  };
}

function parseRoomLogPage(body: unknown, roomId: string) {
  const root = rec(body) ?? {};
  const authority = rec(root.authority);
  return {
    events: list(root.events).flatMap((entry) => {
      const event = parseRoomEvent(entry);
      return event ? [event] : [];
    }),
    cursor: num(root.cursor) ?? 0,
    latestSeq: num(root.latest_seq) ?? 0,
    hasMore: bool(root.has_more) ?? false,
    authorityEpoch: authority ? num(authority.epoch) : null,
    roomId,
  };
}

function parsePendingAction(value: unknown): HermesRoomPendingAction | null {
  const row = rec(value);
  const kind = row ? str(row.kind) : null;
  if (!row || !kind) return null;
  const memberId = str(row.member_id);
  const taskId = str(row.task_id);
  if (kind === "retry" && taskId) return { kind, taskId, memberId };
  if (kind === "approval" && taskId) {
    const approval = parsePendingApproval(row.approval) ?? {
      requestId: str(row.request_id),
      command: null,
      description: null,
      choices: [],
    };
    return {
      kind,
      taskId,
      memberId,
      executionGeneration: num(row.execution_generation) ?? 0,
      requestId: str(row.request_id) ?? approval.requestId,
      approval,
    };
  }
  return { kind: "other", label: kind, memberId };
}

export function parseRoomState(body: unknown): HermesRoomState {
  const root = rec(body) ?? {};
  const room = parseRoom(root.room);
  if (!room) throw new Error("The gateway returned no room.");
  const driver = rec(root.driver_status);
  return {
    room,
    driver: driver
      ? {
          running: bool(driver.running) ?? false,
          working: bool(driver.working) ?? false,
          blocked: bool(driver.blocked) ?? false,
          counts: Object.fromEntries(
            Object.entries(rec(driver.counts) ?? {}).flatMap(([key, value]) => {
              const count = num(value);
              return count === null ? [] : [[key, count] as const];
            }),
          ),
          pendingActions: list(driver.pending_actions).flatMap((entry) => {
            const action = parsePendingAction(entry);
            return action ? [action] : [];
          }),
        }
      : null,
  };
}

// ── Routines (native cron, per profile store) ──────────────────────────────────

export interface HermesRoutine {
  readonly jobId: string;
  readonly title: string;
  readonly ownerTag: string | null;
  readonly schedule: string;
  readonly active: boolean;
  readonly state: string | null;
  readonly nextRunAtIso: string | null;
  readonly lastRunAtIso: string | null;
  readonly lastStatus: string | null;
  readonly issue: string | null;
  readonly promptPreview: string;
  readonly deliver: string | null;
  readonly model: string | null;
  readonly repeat: string | null;
}

export interface HermesRoutineList {
  readonly jobs: readonly HermesRoutine[];
  /** The profile the gateway scoped the cron store to; null on gateways that ignore `profile`. */
  readonly scoped: string | null;
}

function isoOrNull(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function parseRoutineList(body: unknown): HermesRoutineList {
  const root = rec(body) ?? {};
  const jobs = requiredList(body, "jobs");
  return {
    scoped: str(root.scoped),
    jobs: jobs.flatMap((entry) => {
      const row = rec(entry);
      const jobId = row ? str(row.job_id) : null;
      if (!row || !jobId) return [];
      const name = str(row.name) ?? "";
      const tag = ROUTINE_TAG_RE.exec(name);
      const paused = bool(row.enabled) === false || str(row.state) === "paused";
      const issue = [row.last_fire_error, row.last_delivery_error, row.paused_reason]
        .map(str)
        .find((text): text is string => text !== null);
      const repeat = row.repeat;
      return [
        {
          jobId,
          title: name.replace(ROUTINE_TAG_RE, "") || "Untitled routine",
          ownerTag: tag?.[1] ? tag[1].toLowerCase() : null,
          schedule: str(row.schedule) ?? "",
          active: !paused,
          state: str(row.state),
          nextRunAtIso: paused ? null : isoOrNull(row.next_run_at),
          lastRunAtIso: isoOrNull(row.last_run_at),
          lastStatus: str(row.last_status),
          issue: issue ?? null,
          promptPreview: str(row.prompt_preview) ?? str(row.prompt) ?? "",
          deliver: str(row.deliver),
          model: str(row.model),
          repeat: typeof repeat === "number" ? String(repeat) : str(repeat),
        },
      ];
    }),
  };
}

function requireCronMutationSuccess(body: unknown): void {
  const root = rec(body);
  if (!root || bool(root.success) !== true) {
    const reason = root ? str(root.error) : null;
    throw new Error(reason ?? "The gateway did not confirm the routine change.");
  }
}

// ── Query keys ─────────────────────────────────────────────────────────────────

const ROOT = "hermes-bots" as const;

export const hermesKeys = {
  all: [ROOT] as const,
  status: [ROOT, "status"] as const,
  profiles: [ROOT, "profiles"] as const,
  avatar: (name: string) => [ROOT, "avatar", name] as const,
  detail: (name: string) => [ROOT, "detail", name] as const,
  models: [ROOT, "models"] as const,
  chats: [ROOT, "chat"] as const,
  chat: (profile: string) => [ROOT, "chat", profile] as const,
  rooms: [ROOT, "rooms"] as const,
  roomState: (roomId: string) => [ROOT, "room-state", roomId] as const,
  roomLog: (roomId: string) => [ROOT, "room-log", roomId] as const,
  routines: (profile: string) => [ROOT, "routines", profile] as const,
};

const mutationToast = {
  onError: (error: Error) => toastManager.add({ type: "error" as const, title: error.message }),
};

// ── Status and events ──────────────────────────────────────────────────────────

export function useHermesStatus() {
  const api = useHermesBotsApi();
  return useQuery({
    queryKey: hermesKeys.status,
    queryFn: () => requireApi().status(),
    enabled: api !== null,
    staleTime: 10_000,
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data;
      return status?.configured && !status.connected ? 15_000 : false;
    },
  });
}

export function useHermesConnect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: HermesBotConnectInput) => requireApi().connect(input),
    onSuccess: (status) => {
      queryClient.setQueryData(hermesKeys.status, status);
      void queryClient.invalidateQueries({ queryKey: hermesKeys.all });
    },
    ...mutationToast,
  });
}

/** Subscribe to bridge events for the life of the component. */
export function useHermesEvent(handler: ((event: HermesBotsEvent) => void) | null) {
  const api = useHermesBotsApi();
  useEffect(() => {
    if (!api || !handler) return;
    return api.onEvent(handler);
  }, [api, handler]);
}

const HERMES_EVENT_INVALIDATION_OPTIONS = { cancelRefetch: false } as const;

function invalidateHermesQueries(queryClient: QueryClient, queryKey: QueryKey): void {
  const pendingReads = queryClient
    .getQueryCache()
    .findAll({ queryKey })
    .filter((query) => query.state.fetchStatus === "fetching")
    .flatMap((query) => (query.promise ? [{ key: query.queryKey, promise: query.promise }] : []));

  void queryClient.invalidateQueries({ queryKey }, HERMES_EVENT_INVALIDATION_OPTIONS);
  for (const pending of pendingReads) {
    void pending.promise.then(
      () =>
        queryClient.invalidateQueries(
          { queryKey: pending.key, exact: true },
          HERMES_EVENT_INVALIDATION_OPTIONS,
        ),
      () => undefined,
    );
  }
}

export function routeEventInvalidation(queryClient: QueryClient, event: HermesBotsEvent) {
  const type = event.type;
  if (type.startsWith("connection") || type === "status" || type.startsWith("bridge")) {
    invalidateHermesQueries(queryClient, hermesKeys.status);
    return;
  }
  if (/room|group/i.test(type)) {
    invalidateHermesQueries(queryClient, hermesKeys.rooms);
    invalidateHermesQueries(queryClient, [ROOT, "room-state"]);
    invalidateHermesQueries(queryClient, [ROOT, "room-log"]);
    return;
  }
  if (
    typeof event.payload.session_id === "string" ||
    type.startsWith("session.") ||
    type.startsWith("message.")
  ) {
    invalidateHermesQueries(queryClient, hermesKeys.chats);
    if (type === "message.complete" || type === "session.info") {
      invalidateHermesQueries(queryClient, hermesKeys.profiles);
    }
  }
}

/** One subscription per mounted Bots surface: gateway events refresh the affected queries. */
export function useHermesEventInvalidation() {
  const api = useHermesBotsApi();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!api) return;
    return api.onEvent((event) => routeEventInvalidation(queryClient, event));
  }, [api, queryClient]);
}

// ── Profiles ───────────────────────────────────────────────────────────────────

export function useHermesProfiles(enabled: boolean) {
  return useQuery({
    queryKey: hermesKeys.profiles,
    queryFn: async () => parseProfileList(await call("profiles.list", { include_sessions: true })),
    enabled,
    refetchInterval: enabled ? 15_000 : false,
    retry: 1,
  });
}

export function useHermesProfileAvatar(name: string, hasAvatar: boolean) {
  return useQuery({
    queryKey: hermesKeys.avatar(name),
    queryFn: async () => {
      const body = rec(await call("profiles.get_asset", { name, asset: "avatar" }));
      return body && bool(body.found) === true ? (str(body.data) ?? null) : null;
    },
    enabled: hasAvatar,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

export function useHermesProfileDetail(name: string | null) {
  return useQuery({
    queryKey: hermesKeys.detail(name ?? ""),
    queryFn: async () => parseProfileDetail(await call("profiles.describe", { name })),
    enabled: name !== null,
    staleTime: 30_000,
    retry: 1,
  });
}

/** Only providers the gateway reports as authenticated, or all when it reports nothing. */
export function useHermesModelCatalog(enabled: boolean) {
  return useQuery({
    queryKey: hermesKeys.models,
    queryFn: async () =>
      parseModelCatalog(
        await call("model.options", { include_unconfigured: false, explicit_only: false }),
      ).filter((provider) => provider.authenticated !== false),
    enabled,
    staleTime: 2 * 60_000,
    retry: false,
  });
}

export interface HermesProfileConfigureInput {
  readonly name: string;
  readonly description?: string;
  readonly soul?: string;
  readonly model?: { provider: string; model: string; confirmExpensive?: boolean };
  readonly disabledSkills?: readonly string[];
  readonly enabledToolsets?: readonly string[];
  readonly uiMeta?: { title?: string | null; hidden?: boolean | null };
  readonly uiMetaExpectedRevision?: number | null;
}

export interface HermesProfileConfigureResult {
  readonly ok: boolean;
  readonly applied: Readonly<Record<string, boolean>>;
  readonly confirmRequired: boolean;
  readonly confirmMessage: string | null;
}

function parseConfigureResult(body: unknown): HermesProfileConfigureResult {
  const root = rec(body);
  if (!root || bool(root.ok) !== true || !rec(root.applied)) {
    throw new Error("The gateway did not confirm the profile changes.");
  }
  return {
    ok: true,
    applied: Object.fromEntries(
      Object.entries(rec(root.applied) ?? {}).flatMap(([key, value]) =>
        typeof value === "boolean" ? [[key, value] as const] : [],
      ),
    ),
    confirmRequired: bool(root.confirm_required) ?? false,
    confirmMessage: str(root.confirm_message),
  };
}

export function useHermesProfileMutations() {
  const queryClient = useQueryClient();
  const invalidate = (name?: string) => {
    void queryClient.invalidateQueries({ queryKey: hermesKeys.profiles });
    if (name) void queryClient.invalidateQueries({ queryKey: hermesKeys.detail(name) });
  };
  const create = useMutation({
    mutationFn: async (input: {
      name: string;
      description: string;
      title: string;
      model: { provider: string; model: string } | null;
    }) => {
      const created = rec(
        await call("profiles.create", {
          name: input.name,
          ...(input.description ? { description: input.description } : {}),
          ...(input.model ? { provider: input.model.provider, model: input.model.model } : {}),
        }),
      );
      if (!created || bool(created.ok) !== true)
        throw new Error("The gateway did not create the profile.");
      if (input.title) {
        await call("profiles.configure", {
          name: input.name,
          ui_meta: { [HERMES_UI_META_KEY]: { title: input.title } },
        });
      }
      return input.name;
    },
    onSuccess: () => invalidate(),
    ...mutationToast,
  });
  const configure = useMutation({
    mutationFn: async (input: HermesProfileConfigureInput) => {
      const params: Record<string, Schema.Json> = { name: input.name };
      if (input.description !== undefined) params.description = input.description;
      if (input.soul !== undefined) params.soul = input.soul;
      if (input.model) {
        params.provider = input.model.provider;
        params.model = input.model.model;
        if (input.model.confirmExpensive) params.confirm_expensive_model = true;
      }
      if (input.disabledSkills) params.disabled_skills = [...input.disabledSkills];
      if (input.enabledToolsets) params.enabled_toolsets = [...input.enabledToolsets];
      if (input.uiMeta) {
        const uiMeta = Object.fromEntries(
          Object.entries(input.uiMeta).filter(([, value]) => value !== undefined),
        );
        params.ui_meta = { [HERMES_UI_META_KEY]: uiMeta };
        if (input.uiMetaExpectedRevision !== undefined && input.uiMetaExpectedRevision !== null) {
          params.ui_meta_expected_revisions = {
            [HERMES_UI_META_KEY]: input.uiMetaExpectedRevision,
          };
        }
      }
      return parseConfigureResult(await call("profiles.configure", params));
    },
    onSuccess: (_result, input) => invalidate(input.name),
    ...mutationToast,
  });
  const setAvatar = useMutation({
    mutationFn: async (input: { name: string; dataUrl: string | null }) => {
      const body = rec(
        await call("profiles.set_asset", {
          name: input.name,
          asset: "avatar",
          ...(input.dataUrl ? { data: input.dataUrl } : { clear: true }),
        }),
      );
      if (!body || bool(body.ok) !== true) throw new Error("The gateway did not store the avatar.");
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: hermesKeys.avatar(input.name) });
      invalidate();
    },
    ...mutationToast,
  });
  return { create, configure, setAvatar };
}

// ── Canonical chat ─────────────────────────────────────────────────────────────

export function useHermesChat(profile: string | null, knownCanonicalId: string | null) {
  return useQuery<HermesChatSnapshot, Error>({
    queryKey: hermesKeys.chat(profile ?? ""),
    queryFn: () => {
      if (!profile) throw new Error("Pick a bot first.");
      return resolveCanonicalChat(profile, knownCanonicalId);
    },
    enabled: profile !== null,
    refetchInterval: (query) => (query.state.data?.running ? 3_000 : false),
    retry: shouldRetryHermesRegistryRead,
    retryDelay: hermesRegistryReadRetryDelay,
  });
}

export function useHermesChatMutations(profile: string | null) {
  const queryClient = useQueryClient();
  const refresh = () => {
    if (profile) void queryClient.invalidateQueries({ queryKey: hermesKeys.chat(profile) });
  };
  const submit = useMutation({
    mutationFn: async (input: { runtimeSessionId: string; text: string }) => {
      await call("prompt.submit", { session_id: input.runtimeSessionId, text: input.text });
    },
    onSuccess: refresh,
    ...mutationToast,
  });
  const interrupt = useMutation({
    mutationFn: async (input: { runtimeSessionId: string }) => {
      await call("session.interrupt", { session_id: input.runtimeSessionId });
    },
    onSuccess: refresh,
    ...mutationToast,
  });
  const respondApproval = useMutation({
    mutationFn: async (input: {
      runtimeSessionId: string;
      requestId: string | null;
      choice: string;
    }) => {
      await call("approval.respond", {
        session_id: input.runtimeSessionId,
        choice: input.choice,
        ...(input.requestId ? { request_id: input.requestId } : {}),
      });
    },
    onSuccess: refresh,
    ...mutationToast,
  });
  const respondClarify = useMutation({
    mutationFn: async (input: {
      runtimeSessionId: string;
      requestId: string | null;
      answer: string;
    }) => {
      await call("clarify.respond", {
        session_id: input.runtimeSessionId,
        answer: input.answer,
        ...(input.requestId ? { request_id: input.requestId } : {}),
      });
    },
    onSuccess: refresh,
    ...mutationToast,
  });
  return { submit, interrupt, respondApproval, respondClarify };
}

// ── Rooms ──────────────────────────────────────────────────────────────────────

export function useHermesRooms(enabled: boolean) {
  return useQuery({
    queryKey: hermesKeys.rooms,
    queryFn: async () => parseRoomList(await call("groups.list", { limit: 100 })),
    enabled,
    refetchInterval: enabled ? 20_000 : false,
    retry: 1,
  });
}

export function useHermesRoomState(roomId: string | null) {
  return useQuery({
    queryKey: hermesKeys.roomState(roomId ?? ""),
    queryFn: async () => parseRoomState(await call("groups.state", { room_id: roomId })),
    enabled: roomId !== null,
    refetchInterval: (query) => (query.state.data?.driver?.working ? 2_500 : 10_000),
    retry: 1,
  });
}

/** Monotonic replay: pages after the last seen seq are appended; an authority change replays from 0. */
export async function readHermesRoomLog(
  queryClient: QueryClient,
  roomId: string,
): Promise<HermesRoomLog> {
  const previous = queryClient.getQueryData<HermesRoomLog>(hermesKeys.roomLog(roomId));

  const read = async (restart: boolean): Promise<HermesRoomLog> => {
    let events = restart ? [] : previous ? [...previous.events] : [];
    let page = parseRoomLogPage(
      await call("groups.log", {
        room_id: roomId,
        since_seq: restart ? 0 : (previous?.latestSeq ?? 0),
        limit: ROOM_LOG_PAGE_LIMIT,
      }),
      roomId,
    );
    if (!restart && previous && page.authorityEpoch !== previous.authorityEpoch) return read(true);

    const seen = new Set(events.map((event) => event.seq));
    let authorityEpoch = page.authorityEpoch;
    const append = (next: ReturnType<typeof parseRoomLogPage>): void => {
      if (next.authorityEpoch !== authorityEpoch) {
        throw new Error("The gateway room authority changed during log replay.");
      }
      for (const event of next.events) {
        if (seen.has(event.seq)) continue;
        seen.add(event.seq);
        events.push(event);
      }
    };
    append(page);
    let hasMore = page.hasMore;
    let cursor = page.cursor;
    // Bounded catch-up so a busy room does not need several polls to reach the tail.
    for (let hops = 0; hasMore && hops < 4; hops += 1) {
      const next = parseRoomLogPage(
        await call("groups.log", {
          room_id: roomId,
          since_seq: cursor,
          limit: ROOM_LOG_PAGE_LIMIT,
        }),
        roomId,
      );
      try {
        append(next);
      } catch (error) {
        if (!restart) return read(true);
        throw error;
      }
      hasMore = next.hasMore;
      cursor = next.cursor;
    }
    events.sort((left, right) => left.seq - right.seq);
    return { roomId, events, latestSeq: cursor, hasMore, authorityEpoch };
  };

  return read(false);
}

export function useHermesRoomLog(roomId: string | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: hermesKeys.roomLog(roomId ?? ""),
    queryFn: () => {
      if (!roomId) throw new Error("Pick a group first.");
      return readHermesRoomLog(queryClient, roomId);
    },
    enabled: roomId !== null,
    refetchInterval: 4_000,
    retry: 1,
  });
}

export function useHermesRoomMutations() {
  const queryClient = useQueryClient();
  const refreshRoom = (roomId: string) => {
    void queryClient.invalidateQueries({ queryKey: hermesKeys.roomState(roomId) });
    void queryClient.invalidateQueries({ queryKey: hermesKeys.roomLog(roomId) });
  };
  const create = useMutation({
    mutationFn: async (input: { name: string; profiles: readonly string[] }) => {
      if (input.profiles.length < 2 || input.profiles.length > 6) {
        throw new Error("Group chats need between 2 and 6 members.");
      }
      const roomId = `vulcan-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
      const body = rec(
        await call("groups.create", {
          room_id: roomId,
          name: input.name,
          members: input.profiles.map((profile) => ({
            member_id: profile,
            profile,
            handle: profile,
          })),
        }),
      );
      const room = parseRoom(body?.room);
      if (!room) throw new Error("The gateway did not return the created room.");
      return room;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: hermesKeys.rooms }),
    ...mutationToast,
  });
  /** No toast here: the composer owns the unconfirmed-delivery state and the same event id. */
  const send = useMutation({
    mutationFn: async (input: { roomId: string; clientEventId: string; text: string }) => {
      const body = rec(
        await call("groups.send", {
          room_id: input.roomId,
          event_id: input.clientEventId,
          payload: { text: input.text, thread_id: input.clientEventId },
        }),
      );
      if (!body || bool(body.accepted) !== true)
        throw new Error("The gateway did not accept the message.");
      return parseRoomEvent(body.event);
    },
    onSuccess: (_event, input) => refreshRoom(input.roomId),
  });
  const stop = useMutation({
    mutationFn: async (input: { roomId: string }) => {
      const body = rec(
        await call("groups.stop", {
          room_id: input.roomId,
          cancel_id: `vulcan-stop-${crypto.randomUUID()}`,
        }),
      );
      return num(body?.cancelled) ?? 0;
    },
    onSuccess: (_count, input) => refreshRoom(input.roomId),
    ...mutationToast,
  });
  const retry = useMutation({
    mutationFn: async (input: { roomId: string; taskId: string }) => {
      await call("groups.retry", { room_id: input.roomId, task_id: input.taskId });
    },
    onSuccess: (_result, input) => refreshRoom(input.roomId),
    ...mutationToast,
  });
  const approve = useMutation({
    mutationFn: async (input: {
      roomId: string;
      memberId: string;
      taskId: string;
      executionGeneration: number;
      requestId: string | null;
      choice: string;
    }) => {
      await call("groups.approve", {
        room_id: input.roomId,
        member_id: input.memberId,
        task_id: input.taskId,
        execution_generation: input.executionGeneration,
        choice: input.choice,
        ...(input.requestId ? { request_id: input.requestId } : {}),
      });
    },
    onSuccess: (_result, input) => refreshRoom(input.roomId),
    ...mutationToast,
  });
  const rename = useMutation({
    mutationFn: async (input: { roomId: string; name: string }) => {
      await call("groups.rename", {
        room_id: input.roomId,
        event_id: `rename-${crypto.randomUUID()}`,
        name: input.name,
      });
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: hermesKeys.rooms });
      refreshRoom(input.roomId);
    },
    ...mutationToast,
  });
  return { create, send, stop, retry, approve, rename };
}

// ── Routines ───────────────────────────────────────────────────────────────────

export function useHermesRoutines(profile: string | null) {
  return useQuery({
    queryKey: hermesKeys.routines(profile ?? ""),
    queryFn: async () =>
      parseRoutineList(
        await call("cron.manage", { action: "list", include_disabled: true, profile }),
      ),
    enabled: profile !== null,
    refetchInterval: 30_000,
    retry: 1,
  });
}

export function useHermesRoutineMutations(profile: string | null) {
  const queryClient = useQueryClient();
  const refresh = () => {
    if (profile) void queryClient.invalidateQueries({ queryKey: hermesKeys.routines(profile) });
  };
  const create = useMutation({
    mutationFn: async (input: {
      title: string;
      schedule: string;
      instruction: string;
      deliverToChat: boolean;
    }) => {
      if (!profile) throw new Error("Pick a bot first.");
      const result = await call("cron.manage", {
        action: "add",
        profile,
        name: `[bot:${profile}] ${input.title}`,
        schedule: input.schedule,
        prompt: input.instruction,
        ...(input.deliverToChat ? { deliver: "bot-chat" } : {}),
      });
      requireCronMutationSuccess(result);
    },
    onSuccess: refresh,
    ...mutationToast,
  });
  const control = useMutation({
    mutationFn: async (input: { jobId: string; action: "pause" | "resume" | "remove" }) => {
      if (!profile) throw new Error("Pick a bot first.");
      const result = await call("cron.manage", {
        action: input.action,
        name: input.jobId,
        profile,
      });
      requireCronMutationSuccess(result);
    },
    onSuccess: refresh,
    ...mutationToast,
  });
  return { create, control };
}
