import { createHash } from "node:crypto";
import type {
  HermesBotConnectInput,
  HermesBotEvent,
  HermesBotMethod,
  HermesBotReadFileInput,
  HermesBotReadFileResult,
  HermesBotRequest,
  HermesBotStatus,
} from "@vulcan/contracts";
import { Data, Effect, Layer, PubSub, Schema, Semaphore, ServiceMap, Stream } from "effect";
import { hermesSetupUrl as setupHttpUrl } from "@vulcan/shared/hermesSetup";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore";
import { createHermesGatewayClient, type HermesGatewayClient } from "./hermesGatewayClient";
import { makeHermesSharedAccounts } from "./hermesSharedAccounts";
import { ServerSettingsService } from "../serverSettings";

const CONNECTION_SECRET = "hermes-bot-runtime-connection";

export class HermesBotRuntimeError extends Data.TaggedError("HermesBotRuntimeError")<{
  readonly message: string;
}> {}

interface Connection {
  readonly url: string;
  readonly token?: string | undefined;
}

export function validateHermesConnection(input: Connection): Connection {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new HermesBotRuntimeError({ message: "Enter a valid Hermes WebSocket URL." });
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    !loopback ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new HermesBotRuntimeError({
      message:
        "Connect to a loopback Hermes gateway directly or through SSH. Gated remote browser authentication is not supported; enter the loopback gateway token separately.",
    });
  }
  if (url.pathname !== "/api/ws") {
    throw new HermesBotRuntimeError({ message: "The native Hermes gateway path must be /api/ws." });
  }
  return { url: url.toString(), ...(input.token ? { token: input.token } : {}) };
}

export function resolveHermesConnection(
  input: HermesBotConnectInput,
  previous: Connection | null,
): Connection {
  const connection = validateHermesConnection(input);
  return {
    ...connection,
    token: input.token ?? (previous?.url === connection.url ? previous.token : undefined),
  };
}

const HERMES_REPORT_MAX_BYTES = 512 * 1024;
const HERMES_FILE_RESPONSE_MAX_BYTES = 1_000_000;
const HERMES_FILE_READ_TIMEOUT_MS = 15_000;

const HERMES_SETUP_METHODS = new Set([
  "mcp.catalog",
  "mcp.servers.list",
  "mcp.servers.add",
  "mcp.servers.test",
  "mcp.servers.remove",
  "mcp.servers.oauth.start",
  "mcp.servers.oauth.poll",
  "mcp.servers.oauth.cancel",
  "mcp.servers.oauth.callback",
]);

type HermesSetupRecord = Schema.JsonObject;

function setupRecord(value: unknown): HermesSetupRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as HermesSetupRecord)
    : null;
}

function setupString(value: unknown, maxLength = 2_048): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function setupBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function setupNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function setupInvalidResponse(): never {
  throw new Error("Hermes returned an invalid setup response.");
}

function setupRows(root: HermesSetupRecord, key: string): unknown[] {
  return Array.isArray(root[key]) ? root[key] : setupInvalidResponse();
}

function setupToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string" && entry.length <= 2_048) return [entry];
    const name = setupRecord(entry)?.name;
    return typeof name === "string" && name.length > 0 && name.length <= 2_048 ? [name] : [];
  });
}

function setupError(value: unknown): string | null {
  return setupRecord(value)?.ok === false ? "Hermes setup request failed." : null;
}

function sanitizeMcpServer(value: unknown): Schema.Json | null {
  const row = setupRecord(value);
  const name = setupString(row?.name);
  if (!row || !name) return null;
  const auth = row.auth === "oauth" || row.auth === "header" ? row.auth : null;
  return {
    name,
    transport: setupString(row.transport) ?? "unknown",
    ...(auth ? { auth } : {}),
    ...(typeof row.oauth_tokens_present === "boolean"
      ? { oauth_tokens_present: row.oauth_tokens_present }
      : {}),
    tools: setupToolNames(row.tools),
  };
}

export function sanitizeHermesSetupResponse(
  method: HermesBotMethod,
  value: Schema.Json,
): Schema.Json {
  if (!HERMES_SETUP_METHODS.has(method)) return value;
  const root = setupRecord(value);
  if (!root) setupInvalidResponse();

  if (method === "mcp.catalog") {
    return {
      servers: setupRows(root, "servers").flatMap((entry) => {
        const row = setupRecord(entry);
        const name = setupString(row?.name);
        if (!row || !name) setupInvalidResponse();
        return [
          {
            name,
            description: setupString(row.description) ?? "",
            installed: setupBoolean(row.installed) ?? false,
            enabled: setupBoolean(row.enabled) ?? false,
            requires: Array.isArray(row.requires)
              ? row.requires.filter((key): key is string => typeof key === "string")
              : [],
            transport: setupString(row.transport) ?? "unknown",
          },
        ];
      }),
    };
  }

  if (method === "mcp.servers.list" || method === "mcp.servers.add") {
    const serverRows = method === "mcp.servers.add" ? [root.server] : setupRows(root, "servers");
    if (method === "mcp.servers.add" && !setupRecord(root.server)) setupInvalidResponse();
    const servers = serverRows.flatMap((entry) => {
      const safe = sanitizeMcpServer(entry);
      if (!safe) setupInvalidResponse();
      return [safe];
    });
    return {
      ...(typeof root.ok === "boolean" ? { ok: root.ok } : {}),
      ...(setupString(root.name) ? { name: root.name } : {}),
      ...(method === "mcp.servers.add" ? { server: servers[0] ?? null } : { servers }),
      ...(setupError(value) ? { error: setupError(value) } : {}),
    };
  }

  if (method === "mcp.servers.test") {
    if (typeof root.ok !== "boolean" || !Array.isArray(root.tools)) setupInvalidResponse();
    const ok = setupBoolean(root.ok) ?? false;
    return {
      ok,
      tools: setupToolNames(root.tools),
      ...(setupNumber(root.prompts) !== null ? { prompts: root.prompts } : {}),
      ...(setupNumber(root.resources) !== null ? { resources: root.resources } : {}),
      ...(typeof root.oauth_needed === "boolean" ? { oauth_needed: root.oauth_needed } : {}),
      ...(typeof root.oauth_tokens_present === "boolean"
        ? { oauth_tokens_present: root.oauth_tokens_present }
        : {}),
      ...(ok ? {} : { error: "MCP server test failed." }),
    };
  }

  if (method === "mcp.servers.remove") {
    return {
      ...(typeof root.ok === "boolean" ? { ok: root.ok } : {}),
      ...(typeof root.removed === "boolean" ? { removed: root.removed } : {}),
      ...(setupError(value) ? { error: setupError(value) } : {}),
    };
  }

  if (method.startsWith("mcp.servers.oauth.")) {
    if (typeof root.ok !== "boolean") setupInvalidResponse();
    const status =
      root.status === "pending" || root.status === "approved" || root.status === "error"
        ? root.status
        : undefined;
    if (method === "mcp.servers.oauth.poll" && !status) setupInvalidResponse();
    return {
      ...(typeof root.ok === "boolean" ? { ok: root.ok } : {}),
      ...(setupString(root.session_id) ? { session_id: root.session_id } : {}),
      ...(status ? { status } : {}),
      ...(setupHttpUrl(root.auth_url) ? { auth_url: root.auth_url } : {}),
      ...(setupString(root.flow) ? { flow: root.flow } : {}),
      ...(status === "error" ? { error_message: "MCP authorization did not complete." } : {}),
      ...(status === "approved" ? { tools: setupToolNames(root.tools) } : {}),
      ...(typeof root.cancelled === "boolean" ? { cancelled: root.cancelled } : {}),
    };
  }

  setupInvalidResponse();
}

function hermesHttpFileUrl(connectionUrl: string, path: string): string {
  const url = new URL(connectionUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/api/files/read";
  url.search = new URLSearchParams({ path }).toString();
  url.hash = "";
  return url.toString();
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > HERMES_FILE_RESPONSE_MAX_BYTES) {
    throw new Error("Hermes report response is too large to preview.");
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > HERMES_FILE_RESPONSE_MAX_BYTES) {
      throw new Error("Hermes report response is too large to preview.");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > HERMES_FILE_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new Error("Hermes report response is too large to preview.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function decodeHermesReportResponse(value: unknown): HermesBotReadFileResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hermes returned an invalid report response.");
  }
  const record = value as Record<string, unknown>;
  const name = record.name;
  const path = record.path;
  const size = record.size;
  const mimeType = record.mime_type;
  const dataUrl = record.data_url;
  if (
    typeof name !== "string" ||
    !name ||
    typeof path !== "string" ||
    !path ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > HERMES_REPORT_MAX_BYTES ||
    typeof mimeType !== "string" ||
    !mimeType ||
    typeof dataUrl !== "string"
  ) {
    if (typeof size === "number" && Number.isSafeInteger(size) && size > HERMES_REPORT_MAX_BYTES) {
      throw new Error("Hermes report is too large to preview.");
    }
    throw new Error("Hermes returned an invalid report response.");
  }
  if (
    !mimeType.toLowerCase().startsWith("text/") &&
    mimeType.toLowerCase() !== "application/markdown"
  ) {
    throw new Error("Hermes report is binary and cannot be previewed as text.");
  }
  const separator = dataUrl.indexOf(",");
  const header = separator >= 0 ? dataUrl.slice(0, separator) : "";
  const encoded = separator >= 0 ? dataUrl.slice(separator + 1) : "";
  const [dataMime, ...parameters] = header.split(";");
  if (
    dataMime?.toLowerCase() !== `data:${mimeType.toLowerCase()}` ||
    !parameters.some((parameter) => parameter.toLowerCase() === "base64") ||
    (encoded.length > 0 && (!/^[A-Za-z0-9+/=]+$/.test(encoded) || encoded.length % 4 !== 0))
  ) {
    throw new Error("Hermes returned an invalid report response.");
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
  } catch {
    throw new Error("Hermes returned an invalid report response.");
  }
  if (bytes.byteLength !== size || Buffer.from(bytes).toString("base64") !== encoded) {
    throw new Error("Hermes returned an invalid report response.");
  }
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Hermes report is binary and cannot be previewed as text.");
  }
  return { name, path, size, mimeType, contents };
}

async function readHermesReport(connection: Connection, input: HermesBotReadFileInput) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HERMES_FILE_READ_TIMEOUT_MS);
  try {
    const response = await fetch(hermesHttpFileUrl(connection.url, input.path), {
      headers: connection.token ? { Authorization: `Bearer ${connection.token}` } : undefined,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail =
        response.status === 401 || response.status === 403
          ? "Hermes report access was denied."
          : response.status === 404
            ? "Hermes report was not found on the gateway."
            : response.status === 413
              ? "Hermes report is too large to preview."
              : `Hermes report read failed (HTTP ${response.status}).`;
      throw new Error(detail);
    }
    return decodeHermesReportResponse(JSON.parse(await readBoundedResponse(response)));
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("Hermes ")) throw cause;
    throw new Error("Hermes report could not be read.");
  } finally {
    clearTimeout(timeout);
  }
}

interface HermesBotRuntimeShape {
  readonly handleAccountMcpPost: (
    authorizationHeader: string | undefined,
    body: unknown,
  ) => Effect.Effect<{ status: number; body?: unknown }, HermesBotRuntimeError>;
  readonly status: Effect.Effect<HermesBotStatus, HermesBotRuntimeError>;
  readonly connect: (
    input: HermesBotConnectInput,
  ) => Effect.Effect<HermesBotStatus, HermesBotRuntimeError>;
  readonly request: (input: HermesBotRequest) => Effect.Effect<Schema.Json, HermesBotRuntimeError>;
  readonly readFile: (
    input: HermesBotReadFileInput,
  ) => Effect.Effect<HermesBotReadFileResult, HermesBotRuntimeError>;
  readonly events: Stream.Stream<HermesBotEvent>;
}

export class HermesBotRuntime extends ServiceMap.Service<HermesBotRuntime, HermesBotRuntimeShape>()(
  "vulcan/bots/HermesBotRuntime",
) {}

const makeHermesBotRuntime = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const settings = yield* ServerSettingsService;
  // Notifications only invalidate views; durable messages and receipts are replayed from Hermes.
  const events = yield* PubSub.sliding<HermesBotEvent>(256);
  const connectionLock = yield* Semaphore.make(1);
  let client: HermesGatewayClient | null = null;
  let current: Connection | null = null;
  let connecting: Promise<HermesGatewayClient> | null = null;
  let pendingClient: HermesGatewayClient | null = null;
  let pendingConnection: Connection | null = null;
  let disposed = false;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const failure = (cause: unknown) =>
    new HermesBotRuntimeError({
      message: cause instanceof Error ? cause.message : "Hermes could not confirm this operation.",
    });
  const attempt = <T>(fn: () => Promise<T>) => Effect.tryPromise({ try: fn, catch: failure });
  const readConnection = secrets.get(CONNECTION_SECRET).pipe(
    Effect.mapError(
      () => new HermesBotRuntimeError({ message: "Could not read the saved Hermes connection." }),
    ),
    Effect.flatMap((bytes) =>
      Effect.try({
        try: (): Connection | null => {
          if (bytes) {
            const saved: unknown = JSON.parse(decoder.decode(bytes));
            if (
              !saved ||
              typeof saved !== "object" ||
              !("url" in saved) ||
              typeof saved.url !== "string"
            ) {
              throw new Error("The saved Hermes connection is invalid. Connect the gateway again.");
            }
            return validateHermesConnection({
              url: saved.url,
              ...("token" in saved && typeof saved.token === "string"
                ? { token: saved.token }
                : {}),
            });
          }
          return process.env.VULCAN_HERMES_WS_URL
            ? validateHermesConnection({
                url: process.env.VULCAN_HERMES_WS_URL,
                token: process.env.VULCAN_HERMES_TOKEN,
              })
            : null;
        },
        catch: failure,
      }),
    ),
  );

  const attach = (connection: Connection): Promise<HermesGatewayClient> => {
    if (client && current?.url === connection.url && current.token === connection.token) {
      const active = client;
      return active.connect().then(() => active);
    }
    if (connecting) {
      if (
        pendingConnection?.url !== connection.url ||
        pendingConnection.token !== connection.token
      ) {
        return Promise.reject(
          new HermesBotRuntimeError({
            message: "A different Hermes connection is being checked. Try again when it finishes.",
          }),
        );
      }
      return connecting;
    }
    const candidate = createHermesGatewayClient(connection);
    pendingClient = candidate;
    pendingConnection = connection;
    connecting = candidate
      .connect()
      .then(() => {
        if (disposed) {
          candidate.close();
          throw new HermesBotRuntimeError({
            message: "Vulcan is shutting down. Reconnect to read the Hermes outcome.",
          });
        }
        client?.close();
        client = candidate;
        current = connection;
        candidate.subscribe((event) => {
          Effect.runFork(PubSub.publish(events, event));
        });
        candidate.onStatus(() => {
          Effect.runFork(
            PubSub.publish(events, {
              type: "connection.changed",
              payload: { connected: candidate.connected },
            }),
          );
        });
        return candidate;
      })
      .catch((cause: unknown) => {
        candidate.close();
        throw cause;
      })
      .finally(() => {
        connecting = null;
        pendingConnection = null;
        pendingClient = null;
      });
    return connecting;
  };

  const statusUnlocked = Effect.gen(function* () {
    const connection = yield* readConnection;
    if (!connection)
      return {
        configured: false,
        connected: false,
        endpoint: null,
        capabilities: null,
        message: "Connect a Hermes gateway to use native Bot mode.",
      } satisfies HermesBotStatus;
    return yield* attempt(async (): Promise<HermesBotStatus> => {
      try {
        const active = await attach(connection);
        const capabilities = await active.connect();
        return {
          configured: true,
          connected: true,
          endpoint: connection.url,
          capabilities,
          message: null,
        };
      } catch (cause) {
        return {
          configured: true,
          connected: false,
          endpoint: connection.url,
          capabilities: null,
          message: failure(cause).message,
        };
      }
    });
  });

  const connectUnlocked = (input: HermesBotConnectInput) =>
    Effect.gen(function* () {
      const previous = yield* readConnection;
      const connection = yield* Effect.try({
        try: () => resolveHermesConnection(input, previous),
        catch: failure,
      });
      yield* secrets.set(CONNECTION_SECRET, encoder.encode(JSON.stringify(connection))).pipe(
        Effect.mapError(
          () =>
            new HermesBotRuntimeError({
              message: "Hermes connection could not be saved.",
            }),
        ),
      );
      yield* attempt(() => attach(connection)).pipe(
        Effect.tapError(() =>
          (previous
            ? secrets.set(CONNECTION_SECRET, encoder.encode(JSON.stringify(previous)))
            : secrets.remove(CONNECTION_SECRET)
          ).pipe(
            Effect.mapError(
              () =>
                new HermesBotRuntimeError({
                  message:
                    "Hermes connection failed and the previous connection could not be restored.",
                }),
            ),
          ),
        ),
      );
      return yield* statusUnlocked;
    });

  const status = connectionLock.withPermit(statusUnlocked);
  const connect = (input: HermesBotConnectInput) =>
    connectionLock.withPermit(connectUnlocked(input));

  const nativeRequest = (method: string, params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const active = yield* connectionLock.withPermit(
        Effect.gen(function* () {
          const connection = yield* readConnection;
          if (!connection)
            return yield* Effect.fail(
              new HermesBotRuntimeError({ message: "Connect Hermes before starting Bot work." }),
            );
          return yield* attempt(() => attach(connection));
        }),
      );
      return yield* attempt(() => active.request(method, params as Record<string, Schema.Json>));
    });

  const accounts = makeHermesSharedAccounts({
    secrets: {
      get: (name) => Effect.runPromise(secrets.get(name)),
      set: (name, value) => Effect.runPromise(secrets.set(name, value)),
      remove: (name) => Effect.runPromise(secrets.remove(name)),
    },
    getConnections: () =>
      Effect.runPromise(settings.getSettings).then((value) => value.managedMcpConnections),
    saveConnections: (connections) =>
      Effect.runPromise(settings.updateSettings({ managedMcpConnections: connections })).then(
        () => undefined,
      ),
    runtimeKey: async () => {
      const connection = await Effect.runPromise(readConnection);
      if (!connection) throw new Error("Connect Hermes before granting account access.");
      return createHash("sha256").update(JSON.stringify(connection)).digest("hex");
    },
    nativeRequest: (method, params) => Effect.runPromise(nativeRequest(method, params)),
  });

  const request = (input: HermesBotRequest) =>
    Effect.gen(function* () {
      if (input.method.startsWith("vulcan.accounts.")) {
        return yield* attempt(async () => {
          try {
            return (await accounts.request(input.method, input.params)) as Schema.Json;
          } catch {
            throw new Error(
              "Shared account request could not be confirmed. Review the connection and current grants before retrying.",
            );
          }
        });
      }
      return yield* attempt(async () => {
        try {
          return sanitizeHermesSetupResponse(
            input.method,
            await Effect.runPromise(nativeRequest(input.method, input.params)),
          );
        } catch (cause) {
          if (HERMES_SETUP_METHODS.has(input.method)) {
            if (
              cause instanceof Error &&
              cause.message === "Hermes returned an invalid setup response."
            ) {
              throw cause;
            }
            throw new Error("Hermes setup request failed.");
          }
          throw cause;
        }
      });
    });

  const readFile = (input: HermesBotReadFileInput) =>
    Effect.gen(function* () {
      const connection = yield* connectionLock.withPermit(
        Effect.gen(function* () {
          const saved = yield* readConnection;
          if (!saved)
            return yield* Effect.fail(
              new HermesBotRuntimeError({ message: "Connect Hermes before opening a report." }),
            );
          yield* attempt(() => attach(saved));
          return saved;
        }),
      );
      return yield* attempt(() => readHermesReport(connection, input));
    });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      disposed = true;
      pendingClient?.close();
      client?.close();
    }),
  );
  return {
    handleAccountMcpPost: (authorizationHeader, body) =>
      attempt(() => accounts.handleMcpPost(authorizationHeader, body)),
    status,
    connect,
    request,
    readFile,
    events: Stream.fromPubSub(events),
  } satisfies HermesBotRuntimeShape;
});

export const HermesBotRuntimeLive = Layer.effect(HermesBotRuntime, makeHermesBotRuntime);
