import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ServerSecretStore, type ServerSecretStoreShape } from "../auth/Services/ServerSecretStore";

const gatewayHarness = vi.hoisted(() => {
  const connectOutcomes: Array<Promise<void> | Error> = [];
  const clients: Array<{ readonly close: ReturnType<typeof vi.fn> }> = [];
  const capabilities = {
    protocol_version: 2,
    driver: true,
    persistent_process: true,
    methods: ["groups.capabilities", "groups.send", "groups.log"],
    features: [],
  } as const;
  const createHermesGatewayClient = vi.fn(
    (options: { readonly url: string; readonly token?: string }) => {
      const outcome = connectOutcomes.shift();
      const close = vi.fn();
      const client = {
        get connected() {
          return true;
        },
        state: "open" as const,
        connect: vi.fn(() =>
          outcome instanceof Error
            ? Promise.reject(outcome)
            : Promise.resolve(outcome).then(() => capabilities),
        ),
        request: vi.fn(() => Promise.resolve({})),
        subscribe: vi.fn(() => () => undefined),
        onStatus: vi.fn((listener: (state: "open") => void) => {
          listener("open");
          return () => undefined;
        }),
        close,
      };
      clients.push({ close });
      void options;
      return client;
    },
  );
  return { clients, connectOutcomes, createHermesGatewayClient };
});

vi.mock("./hermesGatewayClient", () => ({
  createHermesGatewayClient: gatewayHarness.createHermesGatewayClient,
}));

import { resolveHermesConnection, validateHermesConnection } from "./hermesBotRuntime";
import { HermesBotRuntime, HermesBotRuntimeLive } from "./hermesBotRuntime";
import { ServerSettingsService } from "../serverSettings";

function makeSecretStore(initial: unknown): ServerSecretStoreShape & { read(): unknown } {
  let value: Uint8Array | null =
    initial === null ? null : new TextEncoder().encode(JSON.stringify(initial));
  return {
    get: () => Effect.succeed(value),
    set: (_name, next) =>
      Effect.sync(() => {
        value = Uint8Array.from(next);
      }),
    remove: () =>
      Effect.sync(() => {
        value = null;
      }),
    getOrCreateRandom: () => Effect.die("not used in test"),
    read: () => (value ? JSON.parse(new TextDecoder().decode(value)) : null),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for test condition");
}

describe("native Hermes connection boundary", () => {
  it("accepts loopback gateways with credentials kept separate", () => {
    expect(
      validateHermesConnection({ url: "ws://127.0.0.1:41493/api/ws", token: "private" }),
    ).toEqual({ url: "ws://127.0.0.1:41493/api/ws", token: "private" });
    expect(validateHermesConnection({ url: "wss://localhost/api/ws" }).url).toBe(
      "wss://localhost/api/ws",
    );
  });

  it("rejects remote gated authentication and credentials embedded in URLs without echoing them", () => {
    for (const url of [
      "ws://example.com/api/ws",
      "wss://example.com/api/ws",
      "https://example.com/api/ws",
      "wss://private@example.com/api/ws",
      "wss://localhost/api/ws?token=private",
      "wss://localhost/api/ws#private",
      "wss://example.com/wrong",
      "private",
    ]) {
      expect(() => validateHermesConnection({ url })).toThrow();
      try {
        validateHermesConnection({ url });
      } catch (error) {
        expect(error instanceof Error && error.message).not.toContain("private");
      }
    }
  });

  it("reuses a token when the entered URL normalizes to the saved endpoint", () => {
    expect(
      resolveHermesConnection(
        { url: "wss://LOCALHOST/api/ws" },
        { url: "wss://localhost/api/ws", token: "private" },
      ),
    ).toEqual({ url: "wss://localhost/api/ws", token: "private" });
  });

  it("serializes concurrent connection changes and restores credentials after a failed probe", async () => {
    const store = makeSecretStore({
      url: "ws://127.0.0.1:41493/api/ws",
      token: "old-token",
    });
    let releaseFirstProbe!: () => void;
    const firstProbe = new Promise<void>((resolve) => {
      releaseFirstProbe = resolve;
    });
    gatewayHarness.connectOutcomes.push(firstProbe, new Error("probe failed"));
    const runtime = ManagedRuntime.make(
      HermesBotRuntimeLive.pipe(
        Layer.provide(Layer.succeed(ServerSecretStore, store)),
        Layer.provide(ServerSettingsService.layerTest()),
      ),
    );

    try {
      const bot = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* HermesBotRuntime;
        }),
      );
      const first = runtime.runPromise(bot.connect({ url: "ws://127.0.0.1:41493/api/ws" }));
      await waitFor(() => gatewayHarness.clients.length === 1);

      const second = runtime.runPromise(
        bot.connect({
          url: "ws://127.0.0.1:41494/api/ws",
          token: "new-token",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(gatewayHarness.clients).toHaveLength(1);

      releaseFirstProbe();
      await expect(first).resolves.toMatchObject({
        endpoint: "ws://127.0.0.1:41493/api/ws",
        connected: true,
      });
      await expect(second).rejects.toThrow("probe failed");
      expect(store.read()).toEqual({
        url: "ws://127.0.0.1:41493/api/ws",
        token: "old-token",
      });

      await expect(runtime.runPromise(bot.status)).resolves.toMatchObject({
        endpoint: "ws://127.0.0.1:41493/api/ws",
        connected: true,
      });
      expect(gatewayHarness.clients[0]?.close).not.toHaveBeenCalled();
      expect(gatewayHarness.clients[1]?.close).toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it("reads a bounded text report from the connected gateway without exposing the token to the client", async () => {
    const store = makeSecretStore({
      url: "ws://127.0.0.1:41493/api/ws",
      token: "gateway-token",
    });
    const contents = "# LaunchPost report\n\nVerified source-backed result.";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "launchpost-report.md",
          path: "/home/russki/report.md",
          size: Buffer.byteLength(contents),
          mime_type: "text/markdown",
          data_url: `data:text/markdown;base64,${Buffer.from(contents).toString("base64")}`,
          root: null,
          locked_root: null,
          can_change_path: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const runtime = ManagedRuntime.make(
      HermesBotRuntimeLive.pipe(
        Layer.provide(Layer.succeed(ServerSecretStore, store)),
        Layer.provide(ServerSettingsService.layerTest()),
      ),
    );

    try {
      const bot = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* HermesBotRuntime;
        }),
      );
      await expect(
        runtime.runPromise(bot.readFile({ path: "/home/russki/report.md" })),
      ).resolves.toEqual({
        name: "launchpost-report.md",
        path: "/home/russki/report.md",
        size: Buffer.byteLength(contents),
        mimeType: "text/markdown",
        contents,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:41493/api/files/read?path=%2Fhome%2Frusski%2Freport.md",
        expect.objectContaining({
          redirect: "error",
          headers: { Authorization: "Bearer gateway-token" },
        }),
      );
    } finally {
      await runtime.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("rejects oversized and binary gateway reports before returning content", async () => {
    const store = makeSecretStore({ url: "ws://127.0.0.1:41493/api/ws", token: "token" });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const runtime = ManagedRuntime.make(
      HermesBotRuntimeLive.pipe(
        Layer.provide(Layer.succeed(ServerSecretStore, store)),
        Layer.provide(ServerSettingsService.layerTest()),
      ),
    );
    try {
      const bot = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* HermesBotRuntime;
        }),
      );
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "large.md",
            path: "/large.md",
            size: 512 * 1024 + 1,
            mime_type: "text/markdown",
            data_url: "data:text/markdown;base64,eA==",
          }),
          { status: 200 },
        ),
      );
      await expect(runtime.runPromise(bot.readFile({ path: "/large.md" }))).rejects.toThrow(
        "Hermes report is too large to preview",
      );
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "image.md",
            path: "/image.md",
            size: 3,
            mime_type: "image/png",
            data_url: "data:image/png;base64,eA==",
          }),
          { status: 200 },
        ),
      );
      await expect(runtime.runPromise(bot.readFile({ path: "/image.md" }))).rejects.toThrow(
        "Hermes report is binary",
      );
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "empty.md",
            path: "/empty.md",
            size: 0,
            mime_type: "text/markdown",
            data_url: "data:text/markdown;base64,",
          }),
          { status: 200 },
        ),
      );
      await expect(runtime.runPromise(bot.readFile({ path: "/empty.md" }))).resolves.toMatchObject({
        name: "empty.md",
        size: 0,
        contents: "",
      });
    } finally {
      await runtime.dispose();
      vi.unstubAllGlobals();
    }
  });
});
