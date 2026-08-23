import path from "node:path";

import {
  CHIEF_OF_STAFF_CALL_ROUTE,
  CHIEF_OF_STAFF_OPENAI_WEBHOOK_ROUTE,
  CHIEF_OF_STAFF_TWILIO_STATUS_ROUTE,
  ChiefOfStaffCallRequestInput,
  type OrchestrationShellSnapshot,
} from "@vulcan/contracts";
import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { makeEffectAuthRequest } from "../auth/effectHttp";
import { ServerAuth } from "../auth/Services/ServerAuth";
import { BotService } from "../bots/Services/BotService";
import { buildBotMemoryBlock, buildBotStaticPersona } from "../bots/botPrompt";
import { loadBotMemoryForPrompt } from "../bots/botWorkspace";
import { ServerConfig } from "../config";
import {
  FactoryTraceSource,
  type FactoryTraceSourceShape,
} from "../factoryTrace/Services/FactoryTraceSource";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { isLegacyTokenAuthorized } from "../http";
import {
  isTrustedAppOrigin,
  normalizeCorsOrigin,
  shouldRejectAuthMutationOrigin,
} from "../trustedOrigins";
import { buildChiefOfStaffBriefing, chiefOfStaffCallManager } from "./callManager";

const MAX_WEBHOOK_BYTES = 64 * 1024;
const decodeCallRequest = Schema.decodeUnknownEffect(ChiefOfStaffCallRequestInput);

function jsonError(message: string, status: number, headers: Record<string, string> = {}) {
  return HttpServerResponse.jsonUnsafe({ error: message }, { status, headers });
}

export function resolveChiefOfStaffCallCorsHeaders(input: {
  readonly rawOrigin: string | ReadonlyArray<string> | undefined;
  readonly requestOrigin: string;
  readonly config: Parameters<typeof isTrustedAppOrigin>[0]["config"];
}): Record<string, string> | null {
  const origin = normalizeCorsOrigin(input.rawOrigin);
  if (!origin) return {};
  if (!isTrustedAppOrigin({ origin, requestOrigin: input.requestOrigin, config: input.config })) {
    return null;
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function readBody(request: HttpServerRequest.HttpServerRequest) {
  const declaredLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    return Effect.fail(new Error("Request body too large."));
  }
  return request.text.pipe(
    Effect.flatMap((body) =>
      Buffer.byteLength(body, "utf8") <= MAX_WEBHOOK_BYTES
        ? Effect.succeed(body)
        : Effect.fail(new Error("Request body too large.")),
    ),
  );
}

const findChiefOfStaff = Effect.gen(function* () {
  const bots = yield* BotService;
  const roster = yield* bots.list({ includeArchived: false });
  return {
    roster,
    chiefOfStaff: roster.bots.find((bot) => bot.chiefOfStaff) ?? null,
  };
});

function readFactoryStatus(
  factoryTrace: FactoryTraceSourceShape,
  snapshot: OrchestrationShellSnapshot,
) {
  const currentThreads = snapshot.threads
    .filter((thread) => thread.archivedAt == null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 30);
  const totalCurrentThreads = snapshot.threads.filter((thread) => thread.archivedAt == null).length;
  return Effect.forEach(
    currentThreads,
    (thread) =>
      factoryTrace.status({ threadId: thread.id }).pipe(
        Effect.map((status) => {
          if (status.state === "ready") {
            return `- ${thread.title}: ${status.sessionCount} recorded factory session${status.sessionCount === 1 ? "" : "s"}`;
          }
          if (status.state === "unreadable") {
            return `- ${thread.title}: factory trace is unreadable`;
          }
          return null;
        }),
      ),
    { concurrency: 8 },
  ).pipe(
    Effect.timeout("3 seconds"),
    Effect.map((items) => [
      `- Scanned newest ${currentThreads.length} of ${totalCurrentThreads} active threads.`,
      ...items.filter((item): item is string => item !== null),
    ]),
    Effect.catchTag("TimeoutException", () =>
      Effect.succeed(["- Factory status timed out; ask again to retry the read."]),
    ),
  );
}

function readBotContext(bot: Parameters<typeof buildBotStaticPersona>[0] & { workspaceDir: string }) {
  return loadBotMemoryForPrompt({ workspaceDir: bot.workspaceDir }).pipe(
    Effect.map((memory) =>
      [
        buildBotStaticPersona(bot),
        buildBotMemoryBlock({ memoryText: memory.text, truncated: memory.truncated }),
      ]
        .filter(Boolean)
        .join("\n\n"),
    ),
    Effect.catch(() => Effect.succeed(buildBotStaticPersona(bot))),
  );
}

const authenticate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* ServerAuth;
  return yield* auth.authenticateHttpRequest(makeEffectAuthRequest(request));
});

const authenticateMutation = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (!url) return yield* Effect.fail(new Error("Bad Request"));
  const config = yield* ServerConfig;
  const session = yield* authenticate;
  if (
    shouldRejectAuthMutationOrigin({
      rawOrigin: request.headers.origin,
      requestOrigin: url.origin,
      config,
      credentialSource: session.credentialSource,
    })
  ) {
    return yield* Effect.fail(new Error("Trusted request origin required."));
  }
  return session;
});

const callRouteHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (!url) return jsonError("Bad Request", 400);

  if (request.method === "POST" && url.pathname === CHIEF_OF_STAFF_OPENAI_WEBHOOK_ROUTE) {
    const rawBody = yield* readBody(request);
    yield* Effect.tryPromise({
      try: () =>
        chiefOfStaffCallManager.handleOpenAiWebhook({
          rawBody,
          headers: request.headers,
        }),
      catch: (cause) =>
        new Error(cause instanceof Error ? cause.message : "OpenAI webhook handling failed."),
    });
    return HttpServerResponse.empty({ status: 200 });
  }

  if (request.method === "POST" && url.pathname === CHIEF_OF_STAFF_TWILIO_STATUS_ROUTE) {
    const requestId = url.searchParams.get("requestId")?.trim() ?? "";
    if (!requestId) return jsonError("Missing call request id.", 400);
    const params = new URLSearchParams(yield* readBody(request));
    yield* Effect.try({
      try: () =>
        chiefOfStaffCallManager.handleTwilioStatus({
          requestId,
          signature: request.headers["x-twilio-signature"] ?? "",
          params,
        }),
      catch: (cause) =>
        new Error(cause instanceof Error ? cause.message : "Twilio callback handling failed."),
    });
    return HttpServerResponse.empty({ status: 200 });
  }

  if (url.pathname !== CHIEF_OF_STAFF_CALL_ROUTE) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }

  const config = yield* ServerConfig;
  const corsHeaders = resolveChiefOfStaffCallCorsHeaders({
    rawOrigin: request.headers.origin,
    requestOrigin: url.origin,
    config,
  });
  if (corsHeaders === null) {
    return jsonError("Trusted request origin required.", 403);
  }
  if (request.method === "OPTIONS") {
    return HttpServerResponse.empty({ status: 204, headers: corsHeaders });
  }
  const locallyAuthorized = isLegacyTokenAuthorized({ config, url });
  if (request.method === "GET") {
    if (!locallyAuthorized) yield* authenticate;
    const { chiefOfStaff } = yield* findChiefOfStaff;
    return HttpServerResponse.jsonUnsafe(
      chiefOfStaffCallManager.status({
        env: process.env,
        publicUrl: config.publicUrl,
        chiefOfStaff,
        statePath: path.join(config.stateDir, "chief-of-staff-call.json"),
      }),
      { headers: corsHeaders },
    );
  }

  if (request.method === "POST") {
    if (!locallyAuthorized) yield* authenticateMutation;
    const payload = yield* readBody(request).pipe(
      Effect.flatMap((body) =>
        Effect.try({
          try: () => JSON.parse(body) as unknown,
          catch: () => new Error("Invalid call request."),
        }),
      ),
      Effect.flatMap(decodeCallRequest),
      Effect.mapError(() => new Error("Invalid call request.")),
    );
    const { roster, chiefOfStaff } = yield* findChiefOfStaff;
    if (!chiefOfStaff) {
      return jsonError("Create or promote a Chief of Staff bot first.", 409, corsHeaders);
    }
    const projection = yield* ProjectionSnapshotQuery;
    const botService = yield* BotService;
    const factoryTrace = yield* FactoryTraceSource;
    const snapshot = yield* projection.getShellSnapshot();
    const factoryStatus = yield* readFactoryStatus(factoryTrace, snapshot);
    const botContext = yield* readBotContext(chiefOfStaff);
    const call = yield* Effect.tryPromise({
      try: () =>
        chiefOfStaffCallManager.requestCall({
          env: process.env,
          publicUrl: config.publicUrl,
          chiefOfStaff,
          bots: roster.bots,
          snapshot,
          factoryStatus,
          botContext,
          topic: payload.topic?.trim() || null,
          statePath: path.join(config.stateDir, "chief-of-staff-call.json"),
          refreshBriefing: async () => {
            const [freshSnapshot, freshRoster] = await Effect.runPromise(
              Effect.all([
                projection.getShellSnapshot(),
                botService.list({ includeArchived: false }),
              ]),
            );
            const freshChiefOfStaff =
              freshRoster.bots.find((bot) => bot.chiefOfStaff) ?? chiefOfStaff;
            const freshFactoryStatus = await Effect.runPromise(
              readFactoryStatus(factoryTrace, freshSnapshot),
            );
            const freshBotContext = await Effect.runPromise(readBotContext(freshChiefOfStaff));
            return buildChiefOfStaffBriefing({
              chiefOfStaff: freshChiefOfStaff,
              bots: freshRoster.bots,
              snapshot: freshSnapshot,
              factoryStatus: freshFactoryStatus,
              botContext: freshBotContext,
              topic: payload.topic?.trim() || null,
            });
          },
        }),
      catch: (cause) =>
        new Error(cause instanceof Error ? cause.message : "The call could not be started."),
    });
    return HttpServerResponse.jsonUnsafe({ call }, { status: 202, headers: corsHeaders });
  }

  return HttpServerResponse.text("Method Not Allowed", { status: 405, headers: corsHeaders });
}).pipe(
  Effect.catchTag("AuthError", (error) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      const config = yield* ServerConfig;
      const headers = url
        ? (resolveChiefOfStaffCallCorsHeaders({
            rawOrigin: request.headers.origin,
            requestOrigin: url.origin,
            config,
          }) ?? {})
        : {};
      return jsonError(error.message, error.status, headers);
    }),
  ),
  Effect.catch((error) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      const config = yield* ServerConfig;
      const headers = url
        ? (resolveChiefOfStaffCallCorsHeaders({
            rawOrigin: request.headers.origin,
            requestOrigin: url.origin,
            config,
          }) ?? {})
        : {};
      return jsonError(
        error instanceof Error ? error.message : "Call me request failed.",
        400,
        headers,
      );
    }),
  ),
);

export const chiefOfStaffCallRouteLayer = HttpRouter.add(
  "*",
  "/api/chief-of-staff/*",
  callRouteHandler,
);
