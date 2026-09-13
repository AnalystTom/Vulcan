import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseHermesMcpOAuth,
  parseHermesMcpServers,
  useHermesMcpMutations,
} from "./useHermesConnections";

const mocks = vi.hoisted(() => ({ request: vi.fn(), toast: vi.fn() }));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    hermesBots: {
      request: mocks.request,
      status: vi.fn(),
      connect: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
    },
  }),
}));

vi.mock("../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));

function renderMcpMutations(profile: string | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const captured: { current: ReturnType<typeof useHermesMcpMutations> | null } = { current: null };
  function Probe(): ReactNode {
    captured.current = useHermesMcpMutations(profile);
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  );
  if (!captured.current) throw new Error("MCP mutation hook did not render.");
  return captured.current;
}

describe("Hermes native connection data layer", () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.toast.mockReset();
  });

  it("derives authentication state without retaining raw MCP config", () => {
    expect(
      parseHermesMcpServers({
        servers: [
          {
            name: "launchpost",
            transport: "http",
            url: "https://provider.example/mcp?opaque=redacted-value",
            auth: "oauth",
            oauth_tokens_present: false,
            tools: [{ name: "drafts", description: "omitted" }],
          },
        ],
      }),
    ).toEqual([
      {
        name: "launchpost",
        transport: "http",
        auth: "oauth",
        authState: "authentication_required",
        oauthTokensPresent: false,
        enabled: null,
        tools: ["drafts"],
      },
    ]);
  });

  it("passes only the explicit profile and redirect URL to native OAuth start", async () => {
    mocks.request.mockResolvedValueOnce({
      ok: true,
      session_id: "oauth-session",
      auth_url: "https://provider.example/authorize?state=opaque",
      flow: "pkce",
    });
    await renderMcpMutations("research").oauthStart.mutateAsync({
      name: "launchpost",
      clientRedirectUri: "http://127.0.0.1:58094/hermes-mcp-callback.html",
    });
    expect(mocks.request).toHaveBeenCalledWith({
      method: "mcp.servers.oauth.start",
      params: {
        profile: "research",
        name: "launchpost",
        client_redirect_uri: "http://127.0.0.1:58094/hermes-mcp-callback.html",
      },
    });
  });

  it("uses native credential storage for a custom HTTP MCP server", async () => {
    mocks.request.mockResolvedValueOnce({
      ok: true,
      name: "launchpost",
      server: { name: "launchpost", transport: "http", auth: "header", tools: [] },
    });
    await renderMcpMutations("research").add.mutateAsync({
      name: "launchpost",
      url: "https://launchpost.example/mcp",
      auth: "header",
      bearerToken: "test-token",
    });
    expect(mocks.request).toHaveBeenCalledWith({
      method: "mcp.servers.add",
      params: {
        profile: "research",
        name: "launchpost",
        config: { enabled: false, url: "https://launchpost.example/mcp", auth: "header" },
        bearer_token: "test-token",
      },
    });
  });

  it("serializes connection grants from fresh settings and preserves custom toolsets", async () => {
    let enabled: string[] = [];
    let pinned = ["browser", "custom_unknown", "no_mcp"];
    mocks.request.mockImplementation(async ({ method, params }) => {
      if (method === "profiles.describe")
        return {
          name: "research",
          toolsets_pinned: true,
          enabled_toolsets: [...pinned],
          mcp_servers: ["alpha", "beta"].map((name) => ({ name, enabled: enabled.includes(name) })),
        };
      if (method !== "profiles.configure") throw new Error("Unexpected RPC");
      await Promise.resolve();
      enabled = [...params.enabled_mcp_servers];
      pinned = [...params.enabled_toolsets];
      return { ok: true, applied: { mcp_servers: true, toolsets: true } };
    });
    const actions = renderMcpMutations("research");
    await Promise.all([
      actions.grant.mutateAsync({ name: "alpha", enabled: true }),
      actions.grant.mutateAsync({ name: "beta", enabled: true }),
    ]);
    expect(enabled).toEqual(["alpha", "beta"]);
    expect(pinned).toEqual(["browser", "custom_unknown", "alpha", "beta"]);
    await actions.grant.mutateAsync({ name: "alpha", enabled: false });
    expect(enabled).toEqual(["beta"]);
    expect(pinned).toEqual(["browser", "custom_unknown", "beta"]);
    pinned = ["beta"];
    await actions.grant.mutateAsync({ name: "beta", enabled: false });
    expect(enabled).toEqual([]);
    expect(pinned).toEqual(["no_mcp"]);
  });
});

describe("Hermes OAuth parser", () => {
  it("rejects an OAuth response without an explicit ok field", () => {
    expect(() => parseHermesMcpOAuth({ status: "pending" })).toThrow("Hermes setup request failed");
  });

  it("keeps terminal status and drops native error text", () => {
    expect(
      parseHermesMcpOAuth({
        ok: true,
        session_id: "oauth-session",
        status: "error",
        error_message: "provider details with redacted-value",
      }),
    ).toEqual({
      ok: true,
      sessionId: "oauth-session",
      status: "error",
      authUrl: null,
      flow: null,
      error: "MCP authorization did not complete.",
      tools: [],
    });
  });
});
