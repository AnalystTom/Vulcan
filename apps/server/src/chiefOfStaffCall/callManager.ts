import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import type {
  Bot,
  ChiefOfStaffCall,
  ChiefOfStaffCallStatusResult,
  OrchestrationShellSnapshot,
} from "@vulcan/contracts";
import OpenAI from "openai";
import WebSocket from "ws";

import { createLogger } from "../logger";

const OPENAI_WEBHOOK_PATH = "/api/chief-of-staff/call-me/openai-webhook";
const TWILIO_STATUS_PATH = "/api/chief-of-staff/call-me/twilio-status";
const CALL_REQUEST_SIP_HEADER = "X-Vulcan-Call-Request";
const CALL_REQUEST_TTL_MS = 15 * 60 * 1_000;
const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;
const SIDEBAND_CONNECT_TIMEOUT_MS = 10_000;
const BRIEFING_MAX_CHARS = 16_000;
const BOT_CONTEXT_MAX_CHARS = 4_000;
const TOPIC_MAX_CHARS = 2_000;
const logger = createLogger("chief-of-staff-call");
const ACTIVE_PHASES = new Set<ChiefOfStaffCall["phase"]>([
  "dialing",
  "ringing",
  "in-progress",
]);

interface CallConfiguration {
  readonly openAiApiKey: string;
  readonly openAiWebhookSecret: string;
  readonly openAiProjectId: string;
  readonly openAiModel: string;
  readonly openAiSipHost: "sip.api.openai.com" | "sip-eu.api.openai.com";
  readonly twilioAccountSid: string;
  readonly twilioAuthToken: string;
  readonly twilioFromNumber: string;
  readonly destinationNumber: string;
  readonly publicOrigin: string;
}

interface RecoveryConfiguration {
  readonly openAiApiKey: string;
  readonly twilioAccountSid: string;
  readonly twilioAuthToken: string;
}

interface PendingCallContext {
  readonly config: CallConfiguration;
  readonly instructions: string;
  readonly refreshBriefing: () => Promise<string>;
  readonly handledToolCallIds: Set<string>;
  twilioCallSid: string | null;
  openAiCallId: string | null;
}

interface BriefingBot {
  readonly name: string;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly chiefOfStaff: boolean;
}

interface BriefingThread {
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly branch: string | null;
  readonly archivedAt?: string | null | undefined;
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly latestTurn: { readonly state: string } | null;
  readonly session: { readonly status: string; readonly lastError?: string | null } | null;
  readonly lastKnownPr: {
    readonly number: number;
    readonly state: "open" | "closed" | "merged";
    readonly isDraft?: boolean | undefined;
    readonly mergeability?: "mergeable" | "conflicting" | "unknown" | undefined;
  } | null;
}

interface BriefingSnapshot {
  readonly updatedAt: string;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly threads: ReadonlyArray<BriefingThread>;
}

function value(env: NodeJS.ProcessEnv, name: string): string {
  return env[name]?.trim() ?? "";
}

function enabled(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function validE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

function maskPhoneNumber(phoneNumber: string): string {
  return `configured number ending ${phoneNumber.slice(-4)}`;
}

export function resolveCallConfiguration(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly publicUrl: URL | undefined;
}): {
  readonly configuration: CallConfiguration | null;
  readonly setupSteps: ChiefOfStaffCallStatusResult["setupSteps"];
} {
  const openAiApiKey = value(input.env, "OPENAI_API_KEY");
  const openAiWebhookSecret = value(input.env, "OPENAI_WEBHOOK_SECRET");
  const openAiProjectId = value(input.env, "OPENAI_PROJECT_ID");
  const openAiModel = value(input.env, "VULCAN_CALL_ME_OPENAI_MODEL") || "gpt-realtime-2.1";
  const configuredSipHost = value(input.env, "VULCAN_CALL_ME_OPENAI_SIP_HOST");
  const openAiSipHost =
    configuredSipHost === "sip-eu.api.openai.com"
      ? "sip-eu.api.openai.com"
      : "sip.api.openai.com";
  const sipHostValid =
    configuredSipHost === "" ||
    configuredSipHost === "sip.api.openai.com" ||
    configuredSipHost === "sip-eu.api.openai.com";
  const twilioAccountSid = value(input.env, "TWILIO_ACCOUNT_SID");
  const twilioAuthToken = value(input.env, "TWILIO_AUTH_TOKEN");
  const twilioFromNumber = value(input.env, "TWILIO_FROM_NUMBER");
  const destinationNumber = value(input.env, "VULCAN_CALL_ME_NUMBER");
  const publicOrigin = input.publicUrl?.origin ?? "";

  const setupSteps: ChiefOfStaffCallStatusResult["setupSteps"] = [
    {
      id: "public-url",
      label: "HTTPS VULCAN_PUBLIC_URL for signed callbacks",
      configured: publicOrigin.startsWith("https://"),
    },
    {
      id: "openai-key",
      label: "OPENAI_API_KEY",
      configured: openAiApiKey.length > 0,
    },
    {
      id: "openai-project",
      label: "OPENAI_PROJECT_ID (proj_…)",
      configured: /^proj_[A-Za-z0-9_-]+$/.test(openAiProjectId),
    },
    {
      id: "openai-webhook-secret",
      label: "OPENAI_WEBHOOK_SECRET",
      configured: openAiWebhookSecret.length > 0,
    },
    {
      id: "openai-webhook-registered",
      label: "OpenAI realtime.call.incoming webhook registered",
      configured: enabled(value(input.env, "VULCAN_CALL_ME_OPENAI_WEBHOOK_CONFIGURED")),
    },
    {
      id: "openai-sip-host",
      label: "OpenAI SIP region",
      configured: sipHostValid,
    },
    {
      id: "twilio-credentials",
      label: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN",
      configured: /^AC[a-fA-F0-9]{32}$/.test(twilioAccountSid) && twilioAuthToken.length > 0,
    },
    {
      id: "phone-numbers",
      label: "TWILIO_FROM_NUMBER and VULCAN_CALL_ME_NUMBER (E.164)",
      configured: validE164(twilioFromNumber) && validE164(destinationNumber),
    },
  ];

  if (setupSteps.some((step) => !step.configured)) {
    return { configuration: null, setupSteps };
  }

  return {
    configuration: {
      openAiApiKey,
      openAiWebhookSecret,
      openAiProjectId,
      openAiModel,
      openAiSipHost,
      twilioAccountSid,
      twilioAuthToken,
      twilioFromNumber,
      destinationNumber,
      publicOrigin,
    },
    setupSteps,
  };
}

function threadAttentionReason(thread: BriefingThread): string | null {
  if (thread.hasPendingApprovals) return "waiting for approval";
  if (thread.hasPendingUserInput) return "waiting for Tom";
  if (thread.latestTurn?.state === "error") return "latest turn failed";
  if (thread.session?.status === "error") return "provider session failed";
  if (thread.lastKnownPr?.state === "open") {
    if (thread.lastKnownPr.mergeability === "conflicting") return "open PR has conflicts";
    return thread.lastKnownPr.isDraft ? "draft PR is still open" : "PR is still open";
  }
  if (thread.lastKnownPr?.state === "closed") return "PR was closed without merging";
  if (thread.latestTurn?.state === "running" || thread.session?.status === "running") {
    return "work is running";
  }
  if (thread.branch && thread.lastKnownPr === null) return "branch has no recorded PR";
  return null;
}

export function buildChiefOfStaffBriefing(input: {
  readonly chiefOfStaff: BriefingBot;
  readonly bots: readonly BriefingBot[];
  readonly snapshot: BriefingSnapshot;
  readonly topic: string | null;
  readonly factoryStatus?: readonly string[];
  readonly botContext?: string;
}): string {
  const currentThreads = input.snapshot.threads.filter((thread) => thread.archivedAt == null);
  const projectNames = new Map(input.snapshot.projects.map((project) => [project.id, project.title]));
  const allAttention = [...currentThreads]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .flatMap((thread) => {
      const reason = threadAttentionReason(thread);
      if (!reason) return [];
      const project = projectNames.get(thread.projectId) ?? "Unknown project";
      const pullRequest = thread.lastKnownPr
        ? `; PR #${thread.lastKnownPr.number} ${thread.lastKnownPr.state}`
        : "";
      const branch = thread.branch ? `; branch ${thread.branch}` : "";
      return [`- ${project} / ${thread.title}: ${reason}${pullRequest}${branch}`];
    });
  const attention = allAttention.slice(0, 30);
  const allActiveBots = input.bots
    .filter((bot) => bot.archivedAt === null)
    .map(
      (bot) =>
        `- ${bot.name}: ${bot.title || "no role set"}${bot.chiefOfStaff ? " (Chief of Staff)" : ""}`,
    );
  const activeBots = allActiveBots.slice(0, 30);
  const allProjectSummaries = input.snapshot.projects
    .map((project) => {
      const threads = currentThreads.filter((thread) => thread.projectId === project.id);
      const openPullRequests = threads.filter((thread) => thread.lastKnownPr?.state === "open").length;
      const needsAttention = threads.filter((thread) => threadAttentionReason(thread) !== null).length;
      return `- ${project.title}: ${threads.length} active threads, ${openPullRequests} open PRs, ${needsAttention} items needing attention`;
    });
  const projectSummary = allProjectSummaries.slice(0, 30);
  const allFactoryStatus = input.factoryStatus ?? [];
  const factoryStatus = allFactoryStatus.slice(0, 30);
  const botContext = input.botContext
    ? input.botContext.length > BOT_CONTEXT_MAX_CHARS
      ? `${input.botContext.slice(0, BOT_CONTEXT_MAX_CHARS)}\n[Bot memory truncated for this call.]`
      : input.botContext
    : "";
  const topic = input.topic
    ? input.topic.length > TOPIC_MAX_CHARS
      ? `${input.topic.slice(0, TOPIC_MAX_CHARS)}… [topic truncated]`
      : input.topic
    : null;

  const briefing = [
    `You are ${input.chiefOfStaff.name}, Tom's Chief of Staff inside Vulcan.`,
    "This is a private voice conversation initiated by Tom from Vulcan's Call me control.",
    "Be concise, candid, and action-oriented. Ask one question at a time. Never claim you checked data that is not in the briefing.",
    "This call is read-only. You may discuss and recommend actions, but you cannot mutate projects, merge code, run commands, or access Tailscale hosts during the call.",
    ...(botContext ? [botContext] : []),
    topic ? `Tom requested this call about: ${topic}` : "Tom did not specify a topic.",
    "",
    `Snapshot time: ${input.snapshot.updatedAt}`,
    `Projects (showing ${projectSummary.length} of ${allProjectSummaries.length}):`,
    ...(projectSummary.length > 0 ? projectSummary : ["- No active projects in the Vulcan snapshot."]),
    "",
    `Work needing attention (showing newest ${attention.length} of ${allAttention.length}):`,
    ...(attention.length > 0 ? attention : ["- No blocked, failed, running, or unmerged work is visible in the snapshot."]),
    "",
    `Bot roster (showing ${activeBots.length} of ${allActiveBots.length}):`,
    ...(activeBots.length > 0 ? activeBots : ["- No active bots in the roster."]),
    "",
    "Factory status:",
    ...(factoryStatus.length
      ? factoryStatus
      : ["- No software factory traces are available for the active threads."]),
    "",
    "Start by greeting Tom by name, briefly state the most important current item, then ask what he wants to discuss.",
  ].join("\n");

  if (briefing.length <= BRIEFING_MAX_CHARS) return briefing;
  const notice = `\n\n[Briefing truncated: ${briefing.length - BRIEFING_MAX_CHARS} characters omitted. Use refresh_vulcan_status for a fresh bounded status.]`;
  return `${briefing.slice(0, BRIEFING_MAX_CHARS - notice.length)}${notice}`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildTwilioTwiMl(
  config: Pick<CallConfiguration, "openAiProjectId" | "openAiSipHost">,
  requestId: string,
): string {
  const sipUri = `sip:${config.openAiProjectId}@${config.openAiSipHost};transport=tls?${CALL_REQUEST_SIP_HEADER}=${encodeURIComponent(requestId)}`;
  return `<Response><Dial answerOnBridge="true"><Sip>${xmlEscape(sipUri)}</Sip></Dial></Response>`;
}

export function callRequestIdFromSipHeaders(
  headers: ReadonlyArray<{ readonly name: string; readonly value: string }> | undefined,
): string | null {
  return (
    headers?.find((header) => header.name.toLowerCase() === CALL_REQUEST_SIP_HEADER.toLowerCase())
      ?.value ?? null
  );
}

function isPersistedCall(value: unknown): value is ChiefOfStaffCall {
  if (!value || typeof value !== "object") return false;
  const call = value as Record<string, unknown>;
  return (
    typeof call.id === "string" &&
    ["dialing", "ringing", "in-progress", "completed", "failed"].includes(
      String(call.phase),
    ) &&
    typeof call.requestedAt === "string" &&
    typeof call.updatedAt === "string" &&
    (call.topic === null || typeof call.topic === "string") &&
    (call.error === null || typeof call.error === "string")
  );
}

function parsePersistedCallState(value: unknown): {
  readonly call: ChiefOfStaffCall;
  readonly twilioCallSid: string | null;
  readonly openAiCallId: string | null;
} | null {
  if (isPersistedCall(value)) return { call: value, twilioCallSid: null, openAiCallId: null };
  if (!value || typeof value !== "object") return null;
  const state = value as {
    readonly call?: unknown;
    readonly twilioCallSid?: unknown;
    readonly openAiCallId?: unknown;
  };
  if (!isPersistedCall(state.call)) return null;
  return {
    call: state.call,
    twilioCallSid:
      typeof state.twilioCallSid === "string" && /^CA[a-fA-F0-9]{32}$/.test(state.twilioCallSid)
        ? state.twilioCallSid
        : null,
    openAiCallId: typeof state.openAiCallId === "string" ? state.openAiCallId : null,
  };
}

export function validateTwilioSignature(input: {
  readonly authToken: string;
  readonly signature: string;
  readonly url: string;
  readonly params: URLSearchParams;
}): boolean {
  const sorted = [...input.params.entries()].sort(([left], [right]) => left.localeCompare(right));
  const payload = `${input.url}${sorted.map(([key, item]) => `${key}${item}`).join("")}`;
  const expected = createHmac("sha1", input.authToken).update(payload).digest("base64");
  const left = Buffer.from(expected);
  const right = Buffer.from(input.signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

function mapTwilioPhase(status: string): Pick<ChiefOfStaffCall, "phase" | "error"> | null {
  switch (status) {
    case "queued":
    case "initiated":
      return { phase: "dialing", error: null };
    case "ringing":
      return { phase: "ringing", error: null };
    case "in-progress":
      return { phase: "in-progress", error: null };
    case "completed":
      return { phase: "completed", error: null };
    case "busy":
      return { phase: "failed", error: "The configured number was busy." };
    case "no-answer":
      return { phase: "failed", error: "The call was not answered." };
    case "canceled":
      return { phase: "failed", error: "The call was canceled." };
    case "failed":
      return { phase: "failed", error: "Twilio could not complete the call." };
    default:
      return null;
  }
}

export class ChiefOfStaffCallManager {
  readonly #calls = new Map<string, ChiefOfStaffCall>();
  readonly #contexts = new Map<string, PendingCallContext>();
  readonly #sidebandSockets = new Map<string, WebSocket>();
  readonly #twilioCallSids = new Map<string, string>();
  readonly #openAiCallIds = new Map<string, string>();
  #latestCallId: string | null = null;
  #statePath: string | null = null;

  latestCall(): ChiefOfStaffCall | null {
    const latest = this.#latestCallId ? (this.#calls.get(this.#latestCallId) ?? null) : null;
    if (
      latest &&
      ACTIVE_PHASES.has(latest.phase) &&
      Date.now() - Date.parse(latest.requestedAt) > CALL_REQUEST_TTL_MS
    ) {
      void this.#failProviderCall(latest.id, "The call request expired before it completed.");
      return this.#calls.get(latest.id) ?? null;
    }
    return latest;
  }

  status(input: {
    readonly env: NodeJS.ProcessEnv;
    readonly publicUrl: URL | undefined;
    readonly chiefOfStaff: Bot | null;
    readonly statePath: string;
  }): ChiefOfStaffCallStatusResult {
    const resolved = resolveCallConfiguration(input);
    void this.#loadPersistedState(input.statePath, resolved.configuration);
    const setupSteps = [
      ...resolved.setupSteps,
      {
        id: "chief-of-staff",
        label: "One active Chief of Staff bot",
        configured: input.chiefOfStaff !== null,
      },
    ];
    const destinationNumber = value(input.env, "VULCAN_CALL_ME_NUMBER");
    return {
      configured: setupSteps.every((step) => step.configured),
      setupSteps,
      chiefOfStaff: input.chiefOfStaff
        ? {
            id: input.chiefOfStaff.id,
            name: input.chiefOfStaff.name,
            title: input.chiefOfStaff.title,
          }
        : null,
      destinationLabel: validE164(destinationNumber) ? maskPhoneNumber(destinationNumber) : null,
      openAiWebhookUrl: input.publicUrl
        ? new URL(OPENAI_WEBHOOK_PATH, input.publicUrl).toString()
        : null,
      latestCall: this.latestCall(),
    };
  }

  async requestCall(input: {
    readonly env: NodeJS.ProcessEnv;
    readonly publicUrl: URL | undefined;
    readonly chiefOfStaff: Bot;
    readonly bots: readonly Bot[];
    readonly snapshot: OrchestrationShellSnapshot;
    readonly topic: string | null;
    readonly factoryStatus?: readonly string[];
    readonly botContext?: string;
    readonly statePath: string;
    readonly refreshBriefing?: () => Promise<string>;
    readonly fetch?: typeof fetch;
  }): Promise<ChiefOfStaffCall> {
    const resolved = resolveCallConfiguration(input);
    await this.#loadPersistedState(input.statePath, resolved.configuration);
    const activeCall = this.latestCall();
    if (activeCall && ACTIVE_PHASES.has(activeCall.phase)) {
      throw new Error("A Chief of Staff call is already active.");
    }
    if (!resolved.configuration) {
      throw new Error("Call me is not fully configured.");
    }

    const now = new Date().toISOString();
    const call: ChiefOfStaffCall = {
      id: crypto.randomUUID(),
      phase: "dialing",
      requestedAt: now,
      updatedAt: now,
      topic: input.topic,
      error: null,
    };
    this.#latestCallId = call.id;
    this.#calls.set(call.id, call);
    this.#contexts.set(call.id, {
      config: resolved.configuration,
      instructions: buildChiefOfStaffBriefing(input),
      refreshBriefing:
        input.refreshBriefing ?? (() => Promise.resolve(buildChiefOfStaffBriefing(input))),
      handledToolCallIds: new Set(),
      twilioCallSid: null,
      openAiCallId: null,
    });
    this.#persistLatestCall();

    const statusCallback = new URL(TWILIO_STATUS_PATH, resolved.configuration.publicOrigin);
    statusCallback.searchParams.set("requestId", call.id);
    const body = new URLSearchParams({
      To: resolved.configuration.destinationNumber,
      From: resolved.configuration.twilioFromNumber,
      Twiml: buildTwilioTwiMl(resolved.configuration, call.id),
      StatusCallback: statusCallback.toString(),
      StatusCallbackMethod: "POST",
    });
    for (const event of ["initiated", "ringing", "answered", "completed"]) {
      body.append("StatusCallbackEvent", event);
    }

    const fetchImpl = input.fetch ?? fetch;
    try {
      const response = await fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${resolved.configuration.twilioAccountSid}/Calls.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${resolved.configuration.twilioAccountSid}:${resolved.configuration.twilioAuthToken}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
          signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
        },
      );
      const responseBody = (await response.json().catch(() => null)) as {
        message?: unknown;
        sid?: unknown;
      } | null;
      if (!response.ok) {
        throw new Error(
          responseBody && typeof responseBody.message === "string"
            ? `Twilio rejected the call: ${responseBody.message}`
            : `Twilio rejected the call with status ${response.status}.`,
        );
      }
      const context = this.#contexts.get(call.id);
      if (
        context &&
        typeof responseBody?.sid === "string" &&
        /^CA[a-fA-F0-9]{32}$/.test(responseBody.sid)
      ) {
        context.twilioCallSid = responseBody.sid;
        this.#twilioCallSids.set(call.id, responseBody.sid);
        this.#persistLatestCall();
      }
      return call;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The outbound call could not start.";
      this.#update(call.id, { phase: "failed", error: message });
      throw new Error(message, { cause: error });
    }
  }

  async handleOpenAiWebhook(input: {
    readonly rawBody: string;
    readonly headers: Record<string, string>;
  }): Promise<void> {
    const pendingContext = [...this.#calls.values()]
      .filter((candidate) => ACTIVE_PHASES.has(candidate.phase))
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
      .map((candidate) => this.#contexts.get(candidate.id))
      .find((context) => context !== undefined);
    const apiKey = pendingContext?.config.openAiApiKey ?? value(process.env, "OPENAI_API_KEY");
    const webhookSecret =
      pendingContext?.config.openAiWebhookSecret ?? value(process.env, "OPENAI_WEBHOOK_SECRET");
    if (!apiKey || !webhookSecret) throw new Error("OpenAI webhook verification is not configured.");

    const client = new OpenAI({ apiKey, webhookSecret });
    const event = await client.webhooks.unwrap(input.rawBody, input.headers);
    if (event.type !== "realtime.call.incoming") return;
    const requestId = callRequestIdFromSipHeaders(event.data.sip_headers);
    const call = requestId ? this.#calls.get(requestId) : null;
    const context = requestId ? this.#contexts.get(requestId) : null;
    if (!call || !context || !ACTIVE_PHASES.has(call.phase)) {
      await client.realtime.calls.reject(
        event.data.call_id,
        { status_code: 603 },
        { timeout: PROVIDER_REQUEST_TIMEOUT_MS },
      );
      return;
    }

    await client.realtime.calls.accept(
      event.data.call_id,
      {
        type: "realtime",
        model: context.config.openAiModel,
        instructions: context.instructions,
        output_modalities: ["audio"],
        max_output_tokens: 1_200,
        tools: [
          {
            type: "function",
            name: "refresh_vulcan_status",
            description:
              "Read a fresh Vulcan project, thread, pull request, bot, and Factory status briefing before answering a question about current work.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
        tool_choice: "auto",
        tracing: {
          workflow_name: "Vulcan Chief of Staff call",
          group_id: call.id,
          metadata: { call_request_id: call.id, bot_role: "chief-of-staff" },
        },
      },
      { timeout: PROVIDER_REQUEST_TIMEOUT_MS },
    );
    context.openAiCallId = event.data.call_id;
    this.#openAiCallIds.set(call.id, event.data.call_id);
    this.#persistLatestCall();
    this.#update(call.id, { phase: "in-progress", error: null });
    this.#startSideband(event.data.call_id, call.id, context.config.openAiApiKey);
  }

  handleTwilioStatus(input: {
    readonly requestId: string;
    readonly signature: string;
    readonly params: URLSearchParams;
  }): void {
    const context = this.#contexts.get(input.requestId);
    if (!context) throw new Error("Unknown call request.");
    const callbackUrl = new URL(TWILIO_STATUS_PATH, context.config.publicOrigin);
    callbackUrl.searchParams.set("requestId", input.requestId);
    if (
      !validateTwilioSignature({
        authToken: context.config.twilioAuthToken,
        signature: input.signature,
        url: callbackUrl.toString(),
        params: input.params,
      })
    ) {
      throw new Error("Invalid Twilio callback signature.");
    }
    const next = mapTwilioPhase(input.params.get("CallStatus") ?? "");
    if (!next) return;
    this.#update(input.requestId, next);
  }

  async recover(input: {
    readonly env: NodeJS.ProcessEnv;
    readonly publicUrl: URL | undefined;
    readonly statePath: string;
  }): Promise<void> {
    await this.#loadPersistedState(input.statePath, {
      openAiApiKey: value(input.env, "OPENAI_API_KEY"),
      twilioAccountSid: value(input.env, "TWILIO_ACCOUNT_SID"),
      twilioAuthToken: value(input.env, "TWILIO_AUTH_TOKEN"),
    });
  }

  #loadPersistedState(
    statePath: string,
    recoveryConfig: RecoveryConfiguration | null,
  ): Promise<void> {
    if (this.#statePath === statePath) return Promise.resolve();
    this.#statePath = statePath;
    this.#calls.clear();
    this.#contexts.clear();
    this.#twilioCallSids.clear();
    this.#openAiCallIds.clear();
    this.#latestCallId = null;
    try {
      const parsed = parsePersistedCallState(
        JSON.parse(readFileSync(statePath, "utf8")) as unknown,
      );
      if (!parsed) return Promise.resolve();
      const wasActive = ACTIVE_PHASES.has(parsed.call.phase);
      const call = wasActive
        ? {
            ...parsed.call,
            phase: "failed" as const,
            updatedAt: new Date().toISOString(),
            error: "Vulcan restarted before the call completed.",
          }
        : parsed.call;
      this.#calls.set(call.id, call);
      this.#latestCallId = call.id;
      if (parsed.twilioCallSid) this.#twilioCallSids.set(call.id, parsed.twilioCallSid);
      if (parsed.openAiCallId) this.#openAiCallIds.set(call.id, parsed.openAiCallId);
      if (wasActive) {
        this.#persistLatestCall();
        if (!recoveryConfig) return Promise.resolve();
        return this.#settleProviderCleanup([
          ...(parsed.openAiCallId && recoveryConfig.openAiApiKey
            ? [this.#terminateOpenAiCall(recoveryConfig, parsed.openAiCallId)]
            : []),
          ...(parsed.twilioCallSid && recoveryConfig.twilioAccountSid && recoveryConfig.twilioAuthToken
            ? [this.#terminateTwilioCall(recoveryConfig, parsed.twilioCallSid)]
            : []),
        ]);
      }
    } catch {
      // First use, a removed state directory, and corrupt state all fail closed to no active call.
    }
    return Promise.resolve();
  }

  #persistLatestCall(): void {
    if (!this.#statePath) return;
    const call = this.#latestCallId ? this.#calls.get(this.#latestCallId) : null;
    if (!call) return;
    const temporaryPath = `${this.#statePath}.tmp-${process.pid}`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({
        call,
        twilioCallSid: this.#twilioCallSids.get(call.id) ?? null,
        openAiCallId: this.#openAiCallIds.get(call.id) ?? null,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporaryPath, this.#statePath);
  }

  #update(
    callId: string,
    patch: Pick<ChiefOfStaffCall, "phase" | "error">,
  ): ChiefOfStaffCall | null {
    const current = this.#calls.get(callId);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.#calls.set(callId, next);
    this.#persistLatestCall();
    if (!ACTIVE_PHASES.has(next.phase)) {
      const socket = this.#sidebandSockets.get(callId);
      this.#sidebandSockets.delete(callId);
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
      this.#contexts.delete(callId);
      this.#twilioCallSids.delete(callId);
      this.#openAiCallIds.delete(callId);
    }
    return next;
  }

  #startSideband(openAiCallId: string, requestId: string, apiKey: string): void {
    const socket = new WebSocket(
      `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(openAiCallId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    this.#sidebandSockets.set(requestId, socket);
    const connectTimeout = setTimeout(() => {
      if (socket.readyState !== WebSocket.CONNECTING) return;
      socket.terminate();
      void this.#failProviderCall(
        requestId,
        "The OpenAI Realtime control channel timed out.",
      );
    }, SIDEBAND_CONNECT_TIMEOUT_MS);
    socket.once("open", () => {
      clearTimeout(connectTimeout);
      socket.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions:
              "Greet Tom by name, give the single most important status item from your briefing, then ask what he wants to discuss.",
          },
        }),
      );
    });
    socket.on("message", (message) => {
      void this.#handleSidebandMessage(requestId, socket, message.toString());
    });
    socket.once("error", () => {
      clearTimeout(connectTimeout);
      const current = this.#calls.get(requestId);
      if (current && ACTIVE_PHASES.has(current.phase)) {
        void this.#failProviderCall(
          requestId,
          "The OpenAI Realtime control channel could not connect.",
        );
      }
    });
    socket.once("close", () => {
      clearTimeout(connectTimeout);
      this.#sidebandSockets.delete(requestId);
      const current = this.#calls.get(requestId);
      if (current && ACTIVE_PHASES.has(current.phase)) {
        void this.#failProviderCall(
          requestId,
          "The OpenAI Realtime control channel closed unexpectedly.",
        );
      }
    });
  }

  async #failProviderCall(requestId: string, message: string): Promise<void> {
    const context = this.#contexts.get(requestId);
    const current = this.#calls.get(requestId);
    if (!context || !current || !ACTIVE_PHASES.has(current.phase)) return;
    this.#update(requestId, { phase: "failed", error: message });
    await this.#settleProviderCleanup([
      ...(context.openAiCallId
        ? [this.#terminateOpenAiCall(context.config, context.openAiCallId)]
        : []),
      ...(context.twilioCallSid
        ? [this.#terminateTwilioCall(context.config, context.twilioCallSid)]
        : []),
    ]);
  }

  async #settleProviderCleanup(tasks: readonly Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn("provider call cleanup failed", { cause: result.reason });
      }
    }
  }

  async #handleSidebandMessage(
    requestId: string,
    socket: WebSocket,
    rawMessage: string,
  ): Promise<void> {
    const context = this.#contexts.get(requestId);
    if (!context || socket.readyState !== WebSocket.OPEN) return;
    let event: unknown;
    try {
      event = JSON.parse(rawMessage) as unknown;
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    const responseEvent = event as {
      readonly type?: unknown;
      readonly response?: { readonly output?: ReadonlyArray<Record<string, unknown>> };
    };
    if (responseEvent.type !== "response.done") return;
    const toolCalls = (responseEvent.response?.output ?? []).filter(
      (item) =>
        item.type === "function_call" &&
        item.name === "refresh_vulcan_status" &&
        typeof item.call_id === "string",
    );
    for (const toolCall of toolCalls) {
      const callId = toolCall.call_id as string;
      if (context.handledToolCallIds.has(callId)) continue;
      context.handledToolCallIds.add(callId);
      let output: string;
      try {
        output = JSON.stringify({ briefing: await context.refreshBriefing() });
      } catch {
        output = JSON.stringify({ error: "The fresh Vulcan status could not be loaded." });
      }
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output },
        }),
      );
      socket.send(JSON.stringify({ type: "response.create" }));
    }
  }

  async #terminateOpenAiCall(
    config: Pick<RecoveryConfiguration, "openAiApiKey">,
    openAiCallId: string,
  ): Promise<void> {
    const client = new OpenAI({ apiKey: config.openAiApiKey });
    await client.realtime.calls.hangup(openAiCallId, { timeout: PROVIDER_REQUEST_TIMEOUT_MS });
  }

  async #terminateTwilioCall(
    config: Pick<RecoveryConfiguration, "twilioAccountSid" | "twilioAuthToken">,
    twilioCallSid: string,
  ): Promise<void> {
    const body = new URLSearchParams({ Status: "completed" });
    await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Calls/${twilioCallSid}.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      },
    );
  }
}

export const chiefOfStaffCallManager = new ChiefOfStaffCallManager();
