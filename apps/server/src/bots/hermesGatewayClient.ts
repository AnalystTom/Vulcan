import WebSocket, { type RawData } from "ws";
import { Schema } from "effect";
import type {
  HermesBotCapabilities,
  HermesBotEvent as ContractHermesBotEvent,
} from "@vulcan/contracts";

// Wire checked against Hermes Agent b7b35a84b7fbe1aa2e223a6ce726a2471300d0a4.

export type HermesGatewayState = "idle" | "connecting" | "open" | "closed" | "error";

export type HermesGatewayErrorKind = "connect" | "closed" | "unknown" | "remote" | "capability";

export class HermesGatewayError extends Error {
  readonly kind: HermesGatewayErrorKind;
  readonly code: number | undefined;

  constructor(kind: HermesGatewayErrorKind, message: string, code?: number) {
    super(message);
    this.name = "HermesGatewayError";
    this.kind = kind;
    this.code = code;
  }
}

export type HermesBotEvent = ContractHermesBotEvent;
export type HermesGatewayCapabilities = HermesBotCapabilities;

export interface HermesGatewayClientOptions {
  readonly url: string;
  readonly token?: string | undefined;
  readonly requestTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly socketFactory?: (url: string) => HermesWebSocket;
}

export interface HermesGatewayClient {
  readonly connected: boolean;
  readonly state: HermesGatewayState;
  connect(): Promise<HermesGatewayCapabilities>;
  request<T extends Schema.Json = Schema.Json>(
    method: string,
    params?: Record<string, Schema.Json>,
  ): Promise<T>;
  subscribe(listener: (event: HermesBotEvent) => void): () => void;
  onStatus(listener: (state: HermesGatewayState) => void): () => void;
  close(): void;
}

interface HermesWebSocket {
  readonly readyState: number;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: () => void): this;
  send(data: string): void;
  close(): void;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcFrame {
  readonly id?: number | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: Schema.Json;
  readonly error?: { readonly code?: number };
}

const OPEN = 1;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_DEADLINE_MS = 45_000;
// gateway.hosted_rooms.PROTOCOL_VERSION at the pinned Hermes revision.
const HERMES_PROTOCOL_VERSION = 2;
const REQUIRED_METHODS = ["groups.capabilities", "groups.send", "groups.log"] as const;

function gatewayUrl(url: string, token?: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new HermesGatewayError("connect", "Hermes gateway URL must use ws or wss.");
  }
  if (token) parsed.searchParams.set("token", token);
  return parsed.toString();
}

function rawText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function asRecord(value: unknown): Record<string, Schema.Json> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Schema.Json>)
    : null;
}

function capabilitiesFrom(value: unknown): HermesGatewayCapabilities {
  const record = asRecord(value);
  const methods = Array.isArray(record?.methods)
    ? record.methods.filter((method): method is string => typeof method === "string")
    : [];
  const features = Array.isArray(record?.features)
    ? record.features.filter((feature): feature is string => typeof feature === "string")
    : [];
  const protocolVersion = record?.protocol_version;

  if (
    protocolVersion !== HERMES_PROTOCOL_VERSION ||
    record?.driver !== true ||
    record?.persistent_process !== true ||
    REQUIRED_METHODS.some((method) => !methods.includes(method))
  ) {
    throw new HermesGatewayError("capability", "Hermes gateway capabilities are insufficient.");
  }

  return {
    protocol_version: HERMES_PROTOCOL_VERSION,
    driver: true,
    persistent_process: true,
    methods,
    features,
  };
}

export function createHermesGatewayClient(
  options: HermesGatewayClientOptions,
): HermesGatewayClient {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const url = gatewayUrl(options.url, options.token);
  let socket: HermesWebSocket | null = null;
  let state: HermesGatewayState = "idle";
  let nextId = 1;
  let connectPromise: Promise<HermesGatewayCapabilities> | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let capabilities: HermesGatewayCapabilities | null = null;
  let closedByClient = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastInboundAt = 0;
  let heartbeatSequence = 0;
  const pending = new Map<number, PendingRequest>();
  const eventListeners = new Set<(event: HermesBotEvent) => void>();
  const statusListeners = new Set<(state: HermesGatewayState) => void>();

  const setState = (next: HermesGatewayState): void => {
    if (state === next) return;
    state = next;
    for (const listener of statusListeners) listener(next);
  };

  const rejectPending = (error: Error): void => {
    for (const [id, call] of pending) {
      clearTimeout(call.timer);
      pending.delete(id);
      call.reject(error);
    }
  };

  const rejectReady = (error: Error): void => {
    readyReject?.(error);
    readyResolve = null;
    readyReject = null;
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = null;
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const handleFrame = (frame: JsonRpcFrame): void => {
    if (frame.id !== undefined && frame.id !== null) {
      const call = pending.get(frame.id);
      if (!call) return;
      clearTimeout(call.timer);
      pending.delete(frame.id);
      if (frame.error) {
        call.reject(
          new HermesGatewayError("remote", "Hermes gateway request failed.", frame.error.code),
        );
      } else {
        call.resolve(frame.result);
      }
      return;
    }

    if (frame.method !== "event") return;
    const params = asRecord(frame.params);
    if (params?.type === "gateway.ready") {
      const payload = asRecord(params.payload);
      if (payload?.heartbeat === true && socket) startHeartbeat(socket);
      readyResolve?.();
      readyResolve = null;
      readyReject = null;
      if (readyTimer) clearTimeout(readyTimer);
      readyTimer = null;
    }
    if (typeof params?.type !== "string") return;
    const payload = asRecord(params.payload) ?? {};
    for (const listener of eventListeners) listener({ type: params.type, payload });
  };

  const failSocket = (error: Error, next: HermesGatewayState = "error"): void => {
    const current = socket;
    socket = null;
    capabilities = null;
    stopHeartbeat();
    rejectReady(error);
    rejectPending(error);
    if (current) current.close();
    setState(next);
  };

  const startHeartbeat = (current: HermesWebSocket): void => {
    stopHeartbeat();
    lastInboundAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (socket !== current || current.readyState !== OPEN) return;
      if (Date.now() - lastInboundAt >= HEARTBEAT_DEADLINE_MS) {
        failSocket(new HermesGatewayError("unknown", "Hermes gateway connection was lost."));
        return;
      }
      try {
        current.send(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: `heartbeat-${++heartbeatSequence}`,
            method: "gateway.ping",
            params: {},
          })}\n`,
        );
      } catch {
        failSocket(new HermesGatewayError("unknown", "Hermes gateway connection was lost."));
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  const requestDirect = <T extends Schema.Json>(
    method: string,
    params: Record<string, Schema.Json> = {},
  ): Promise<T> => {
    const current = socket;
    if (!current || current.readyState !== OPEN) {
      return Promise.reject(new HermesGatewayError("closed", "Hermes gateway is not connected."));
    }
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new HermesGatewayError("unknown", "Hermes gateway request outcome is unknown."));
      }, requestTimeoutMs);
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        current.send(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(new HermesGatewayError("unknown", "Hermes gateway request outcome is unknown."));
      }
    });
  };

  const connect = async (): Promise<HermesGatewayCapabilities> => {
    if (state === "open" && capabilities) return capabilities;
    setState("connecting");
    closedByClient = false;
    let created: HermesWebSocket;
    try {
      created = options.socketFactory?.(url) ?? new WebSocket(url);
    } catch {
      const error = new HermesGatewayError("connect", "Hermes gateway connection failed.");
      setState("error");
      throw error;
    }
    socket = created;
    stopHeartbeat();
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
      readyTimer = setTimeout(() => {
        rejectReady(new HermesGatewayError("connect", "Hermes gateway handshake timed out."));
      }, connectTimeoutMs);
    });
    created.on("message", (data) => {
      if (socket !== created) return;
      lastInboundAt = Date.now();
      for (const line of rawText(data).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          handleFrame(JSON.parse(trimmed) as JsonRpcFrame);
        } catch {
          // Ignore malformed frames; a valid response remains correlated.
        }
      }
    });
    created.on("error", () => {
      if (socket === created && state === "connecting") {
        rejectReady(new HermesGatewayError("connect", "Hermes gateway connection failed."));
      }
    });
    created.on("close", () => {
      if (socket !== created) return;
      const error = closedByClient
        ? new HermesGatewayError("closed", "Hermes gateway connection closed.")
        : new HermesGatewayError("unknown", "Hermes gateway connection was lost.");
      socket = null;
      capabilities = null;
      stopHeartbeat();
      rejectReady(error);
      rejectPending(error);
      setState("closed");
    });
    try {
      await ready;
      const negotiated = capabilitiesFrom(await requestDirect("groups.capabilities"));
      capabilities = negotiated;
      setState("open");
      return negotiated;
    } catch (error) {
      const safeError =
        error instanceof HermesGatewayError
          ? error
          : new HermesGatewayError("connect", "Hermes gateway connection failed.");
      if (socket === created) failSocket(safeError);
      throw safeError;
    }
  };

  const client: HermesGatewayClient = {
    get connected() {
      return state === "open" && capabilities !== null;
    },
    get state() {
      return state;
    },
    connect() {
      if (!connectPromise) {
        connectPromise = connect().finally(() => {
          connectPromise = null;
        });
      }
      return connectPromise;
    },
    request<T extends Schema.Json = Schema.Json>(
      method: string,
      params: Record<string, Schema.Json> = {},
    ) {
      if (client.connected) return requestDirect<T>(method, params);
      return client.connect().then(() => requestDirect<T>(method, params));
    },
    subscribe(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onStatus(listener) {
      statusListeners.add(listener);
      listener(state);
      return () => statusListeners.delete(listener);
    },
    close() {
      closedByClient = true;
      const current = socket;
      socket = null;
      capabilities = null;
      stopHeartbeat();
      const error = new HermesGatewayError("closed", "Hermes gateway connection closed.");
      rejectReady(error);
      rejectPending(error);
      if (current) current.close();
      setState("closed");
      eventListeners.clear();
      statusListeners.clear();
    },
  };

  return client;
}
