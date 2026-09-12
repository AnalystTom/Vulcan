import type {
  HermesBotConnectInput,
  HermesBotEvent,
  HermesBotRequest,
  HermesBotStatus,
} from "@vulcan/contracts";
import { Data, Effect, Layer, PubSub, Schema, Semaphore, ServiceMap, Stream } from "effect";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore";
import { createHermesGatewayClient, type HermesGatewayClient } from "./hermesGatewayClient";

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

interface HermesBotRuntimeShape {
  readonly status: Effect.Effect<HermesBotStatus, HermesBotRuntimeError>;
  readonly connect: (
    input: HermesBotConnectInput,
  ) => Effect.Effect<HermesBotStatus, HermesBotRuntimeError>;
  readonly request: (input: HermesBotRequest) => Effect.Effect<Schema.Json, HermesBotRuntimeError>;
  readonly events: Stream.Stream<HermesBotEvent>;
}

export class HermesBotRuntime extends ServiceMap.Service<HermesBotRuntime, HermesBotRuntimeShape>()(
  "vulcan/bots/HermesBotRuntime",
) {}

const makeHermesBotRuntime = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
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

  const request = (input: HermesBotRequest) =>
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
      return yield* attempt(() => active.request(input.method, input.params));
    });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      disposed = true;
      pendingClient?.close();
      client?.close();
    }),
  );
  return {
    status,
    connect,
    request,
    events: Stream.fromPubSub(events),
  } satisfies HermesBotRuntimeShape;
});

export const HermesBotRuntimeLive = Layer.effect(HermesBotRuntime, makeHermesBotRuntime);
