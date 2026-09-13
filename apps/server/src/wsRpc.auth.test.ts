import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ServiceMap } from "effect";
import { Headers } from "effect/unstable/http";
import { RpcMessage } from "effect/unstable/rpc";
import { WS_METHODS, WsFeatureRpcGroup } from "@vulcan/contracts";
import { expect, vi } from "vitest";

import { AuthError } from "./auth/Services/ServerAuth";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { AutomationService } from "./automation/Services/AutomationService";
import { BotCommsService } from "./bots/Services/BotCommsService";
import { BotService } from "./bots/Services/BotService";
import { HermesBotRuntime } from "./bots/hermesBotRuntime";
import { ServerConfig } from "./config";
import { DevServerManager } from "./devServerManager";
import { ExternalMcpService } from "./externalMcp/Services/ExternalMcpService";
import { GitCore } from "./git/Services/GitCore";
import { GitHubCli } from "./git/Services/GitHubCli";
import { GitManager } from "./git/Services/GitManager";
import { GitStatusBroadcaster } from "./git/Services/GitStatusBroadcaster";
import { Keybindings } from "./keybindings";
import { Open } from "./open";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProviderCommandReactor } from "./orchestration/Services/ProviderCommandReactor";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { PullRequestService } from "./pullRequests/Services/PullRequestService";
import { ProfileStatsQuery } from "./profileStats";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry";
import { ProviderDiscoveryService } from "./provider/Services/ProviderDiscoveryService";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { ProviderService } from "./provider/Services/ProviderService";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { HerdrBridge } from "./herdr/Services/HerdrBridge";
import { FactoryRunner } from "./factory/Services/FactoryRunner";
import { FactoryStore } from "./persistence/Services/FactoryStore";
import { TextGeneration } from "./git/Services/TextGeneration";
import { TerminalManager } from "./terminal/Services/Manager";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem";
import { WorkspaceLayouts } from "./persistence/Services/WorkspaceLayouts";
import { ThreadDiagnosticsQuery } from "./diagnostics/Services/ThreadDiagnosticsQuery";
import { AgentGatewayCredentials } from "./agentGateway/Services/AgentGatewayCredentials";
import { CurrentWsSessionRole, WsConnectionSessionsLive } from "./wsConnectionSessions";
import { makeWsRpcLayer, authenticateRpcWebSocketUpgrade, canManageExternalMcp } from "./wsRpc";

const managedMcpConnection = {
  id: "shared-tools",
  name: "Shared tools",
  url: "https://mcp.example.test/tools",
  enabled: true,
  botIds: [],
  allowedTools: [],
  profileGrants: [],
};

const stubLayer = <I, S>(service: ServiceMap.Key<I, S>) =>
  Layer.succeed(
    service,
    new Proxy(
      {},
      {
        get: () => Effect.void,
      },
    ) as S,
  );

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "vulcan-ws-settings-auth-test-",
}).pipe(Layer.provide(NodeServices.layer));

const serverUpdateSettingsHandlerLayer = Layer.mergeAll(
  serverConfigLayer,
  NodeServices.layer,
  ServerSettingsService.layerTest(),
  WsConnectionSessionsLive,
  stubLayer(CheckpointDiffQuery),
  stubLayer(AutomationService),
  stubLayer(BotCommsService),
  stubLayer(BotService),
  stubLayer(DevServerManager),
  stubLayer(HermesBotRuntime),
  stubLayer(ExternalMcpService),
  stubLayer(GitCore),
  stubLayer(GitHubCli),
  stubLayer(GitManager),
  stubLayer(GitStatusBroadcaster),
  stubLayer(Keybindings),
  stubLayer(Open),
  stubLayer(OrchestrationEngineService),
  stubLayer(ProviderCommandReactor),
  stubLayer(ProjectionSnapshotQuery),
  stubLayer(PullRequestService),
  stubLayer(ProfileStatsQuery),
  stubLayer(ProviderAdapterRegistry),
  stubLayer(ProviderDiscoveryService),
  stubLayer(ProviderHealth),
  stubLayer(ProviderService),
  stubLayer(ServerEnvironment),
  stubLayer(ServerLifecycleEvents),
  stubLayer(ServerRuntimeStartup),
  stubLayer(HerdrBridge),
  stubLayer(FactoryRunner),
  stubLayer(FactoryStore),
  stubLayer(TextGeneration),
  stubLayer(TerminalManager),
  stubLayer(WorkspaceEntries),
  stubLayer(WorkspaceFileSystem),
  stubLayer(WorkspaceLayouts),
  stubLayer(ThreadDiagnosticsQuery),
  stubLayer(AgentGatewayCredentials),
);

it("reserves external MCP management for owner sessions", () => {
  assert.isTrue(canManageExternalMcp("owner"));
  assert.isFalse(canManageExternalMcp("client"));
});

it("rejects managed MCP settings updates from clients and accepts owners", async () => {
  const call = (role: "owner" | "client") =>
    Effect.gen(function* () {
      const handler = yield* WsFeatureRpcGroup.accessHandler(WS_METHODS.serverUpdateSettings);
      return yield* handler(
        { managedMcpConnections: [managedMcpConnection] },
        { clientId: 1, requestId: RpcMessage.RequestId(1n), headers: Headers.empty },
      );
    }).pipe(
      Effect.provide(makeWsRpcLayer().pipe(Layer.provide(serverUpdateSettingsHandlerLayer))),
      Effect.provideService(CurrentWsSessionRole, role),
    ) as Effect.Effect<unknown, unknown, never>;

  const clientCall = Effect.runPromise(call("client"));
  await expect(clientCall).rejects.toMatchObject({
    message: "Owner authorization is required for this operation.",
  });
  const ownerResult = await Effect.runPromise(call("owner"));
  assert.notProperty(ownerResult, "managedMcpConnections");
});

it.effect("rejects an unauthorized websocket upgrade on a non-loopback bind", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(
        new AuthError({
          message: "Authentication required.",
          status: 401,
        }),
      ),
    );

    const error = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "0.0.0.0", authToken: "remote-secret", publicUrl: undefined },
      legacyToken: null,
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://192.168.1.50:3773/ws"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    }).pipe(Effect.flip);

    assert.equal(error.status, 401);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

it.effect("does not accept a legacy query token on a non-loopback bind", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(
        new AuthError({
          message: "Authentication required.",
          status: 401,
        }),
      ),
    );

    const error = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "192.168.1.50", authToken: "remote-secret", publicUrl: undefined },
      legacyToken: "remote-secret",
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://192.168.1.50:3773/ws?token=remote-secret"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    }).pipe(Effect.flip);

    assert.equal(error.status, 401);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

it.effect("accepts an authenticated session on a non-loopback bind", () =>
  Effect.gen(function* () {
    const authenticatedSession = {
      sessionId: "remote-session" as never,
      subject: "owner-bootstrap",
      method: "browser-session-cookie" as const,
      role: "owner" as const,
    };
    const authenticateWebSocketUpgrade = vi.fn(() => Effect.succeed(authenticatedSession));

    const session = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "0.0.0.0", authToken: "remote-secret", publicUrl: undefined },
      legacyToken: "remote-secret",
      request: {
        headers: {},
        cookies: { "vulcan-session": "paired-session-credential" },
        url: new URL("http://192.168.1.50:3773/ws?token=remote-secret"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    });

    assert.equal(session, authenticatedSession);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

it.effect("preserves the legacy query token for loopback desktop sessions", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(new AuthError({ message: "Unexpected authentication call.", status: 500 })),
    );

    const session = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "127.0.0.1", authToken: "desktop-secret", publicUrl: undefined },
      legacyToken: "desktop-secret",
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://127.0.0.1:3773/ws?token=desktop-secret"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    });

    assert.equal(session, null);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 0);
  }),
);

it.effect(
  "disables the legacy loopback query token when an HTTPS public origin is configured",
  () =>
    Effect.gen(function* () {
      const authenticatedSession = {
        sessionId: "proxy-session" as never,
        subject: "owner-bootstrap",
        method: "browser-session-cookie" as const,
        role: "owner" as const,
      };
      const authenticateWebSocketUpgrade = vi.fn(() => Effect.succeed(authenticatedSession));

      const session = yield* authenticateRpcWebSocketUpgrade({
        config: {
          host: "127.0.0.1",
          authToken: "proxy-secret",
          publicUrl: new URL("https://vulcan.example.test/"),
        },
        legacyToken: "proxy-secret",
        request: {
          headers: {},
          cookies: { "vulcan-session": "paired-session-credential" },
          url: new URL("http://127.0.0.1:3773/ws?token=proxy-secret"),
        },
        serverAuth: { authenticateWebSocketUpgrade },
      });

      assert.equal(session, authenticatedSession);
      assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
    }),
);
