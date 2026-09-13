import { describe, expect, it, vi } from "vitest";
import type { ManagedMcpConnection } from "@vulcan/contracts";
import { makeHermesSharedAccounts } from "./hermesSharedAccounts";

const providerToken = "provider-secret-test-only";
const serverName = "vulcan_shared_accounts";
const catalog = ["read_posts", "schedule_post"].map((name) => ({
  name,
  inputSchema: { type: "object" },
}));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness() {
  let connections: readonly ManagedMcpConnection[] = [];
  let runtime = "runtime-one";
  const secrets = new Map<string, Uint8Array>();
  const profiles = new Map(
    ["research", "distribution"].map((profile) => [
      profile,
      {
        name: profile,
        toolsets_pinned: true,
        enabled_toolsets: ["browser", "custom_unknown", "no_mcp"],
        mcp_servers: [{ name: "other", enabled: false, url: "https://other.example/mcp" }],
      },
    ]),
  );
  const capabilities = new Map<string, string>();
  const nativeRequest = vi.fn(
    async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === "profiles.list")
        return { profiles: [...profiles.values()].map(({ name }) => ({ name })) };
      const profile = profiles.get(String(params.profile ?? params.name));
      if (!profile) throw new Error("Missing test profile");
      if (method === "profiles.describe") return structuredClone(profile);
      if (method === "mcp.servers.list") return { servers: structuredClone(profile.mcp_servers) };
      if (method === "mcp.servers.add") {
        const config = params.config as { url: string; enabled: boolean };
        expect(config.enabled).toBe(false);
        profile.mcp_servers.push({ name: String(params.name), url: config.url, enabled: false });
        capabilities.set(profile.name, String(params.bearer_token));
        return { ok: true };
      }
      if (method === "profiles.configure") {
        for (const server of profile.mcp_servers)
          server.enabled = (params.enabled_mcp_servers as string[]).includes(server.name);
        if (params.enabled_toolsets)
          profile.enabled_toolsets = [...(params.enabled_toolsets as string[])];
        return { ok: true, applied: { mcp_servers: true, toolsets: true } };
      }
      throw new Error("Unexpected test native method");
    },
  );
  let responseResult: unknown;
  const fetchRequest = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${providerToken}` });
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result:
        responseResult ??
        (request.method === "tools/list"
          ? { tools: catalog }
          : { content: [{ type: "text", text: "Recorded by test provider" }] }),
    });
  });
  const options = {
    secrets: {
      get: vi.fn(async (key: string) => secrets.get(key) ?? null),
      set: async (key: string, bytes: Uint8Array) => {
        secrets.set(key, bytes);
      },
      remove: async (key: string) => {
        secrets.delete(key);
      },
    },
    getConnections: async () => structuredClone(connections),
    saveConnections: async (next: readonly ManagedMcpConnection[]) => {
      connections = structuredClone(next);
    },
    runtimeKey: async () => runtime,
    nativeRequest,
    fetchRequest,
  };
  const api = makeHermesSharedAccounts(options);
  const save = (extra = {}) =>
    api.request("vulcan.accounts.save", {
      id: "launchpost",
      name: "LaunchPost",
      url: "https://launchpost.example/mcp",
      enabled: true,
      credential: providerToken,
      ...extra,
    });
  const grant = (profile: string, allowedTools: string[]) =>
    api.request("vulcan.accounts.grant", {
      id: "launchpost",
      profile,
      allowedTools,
      brokerUrl: "http://127.0.0.1:58094",
    });
  const call = (
    profile: string,
    name = "vulcan_call_managed_mcp",
    args: Record<string, unknown> = {
      connectionId: "launchpost",
      tool: "read_posts",
      arguments: {},
    },
    target = api,
  ) =>
    target.handleMcpPost(`Bearer ${capabilities.get(profile)}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
  return {
    api,
    options,
    save,
    grant,
    call,
    profiles,
    secrets,
    capabilities,
    nativeRequest,
    fetchRequest,
    setRuntime: (value: string) => {
      runtime = value;
    },
    setResult: (value: unknown) => {
      responseResult = value;
    },
  };
}

describe("native Hermes shared accounts", () => {
  it("stores one provider credential, grants two independent workers, and survives a broker restart", async () => {
    const h = harness();
    await h.save();
    await Promise.all([
      h.grant("research", ["read_posts"]),
      h.grant("distribution", ["schedule_post"]),
    ]);
    expect(h.capabilities.get("research")).not.toBe(h.capabilities.get("distribution"));
    expect(JSON.stringify(h.nativeRequest.mock.calls)).not.toContain(providerToken);
    expect(h.profiles.get("research")?.enabled_toolsets).toEqual([
      "browser",
      "custom_unknown",
      serverName,
    ]);
    expect(
      h.profiles.get("research")?.mcp_servers.find((server) => server.name === "other")?.enabled,
    ).toBe(false);
    expect(await h.api.request("vulcan.accounts.list", {})).toMatchObject({
      connections: [
        {
          credentialConfigured: true,
          profileGrants: expect.arrayContaining([
            { profile: "research", allowedTools: ["read_posts"] },
            { profile: "distribution", allowedTools: ["schedule_post"] },
          ]),
        },
      ],
    });
    const restarted = makeHermesSharedAccounts(h.options);
    expect(await h.call("research", undefined, undefined, restarted)).toMatchObject({
      status: 200,
      body: { result: { content: expect.any(Array) } },
    });
    expect(h.fetchRequest).toHaveBeenCalledTimes(1);
    expect(
      await h.call("distribution", "vulcan_call_managed_mcp", {
        connectionId: "launchpost",
        tool: "read_posts",
        arguments: {},
        profile: "research",
      }),
    ).toMatchObject({ body: { result: { isError: true } } });
    expect(h.fetchRequest).toHaveBeenCalledTimes(1);
    expect(
      await h.call("research", "vulcan_describe_managed_mcp", { connectionId: "launchpost" }),
    ).toMatchObject({
      body: { result: { content: [{ text: expect.stringContaining("read_posts") }] } },
    });
    expect(
      JSON.stringify(
        await h.call("research", "vulcan_describe_managed_mcp", { connectionId: "launchpost" }),
      ),
    ).not.toContain("schedule_post");
    expect(JSON.stringify(await h.api.request("vulcan.accounts.list", {}))).not.toContain(
      h.capabilities.get("research"),
    );
  });

  it("denies spoofed identity, changed runtime, disabled native grant and explicit no_mcp pin", async () => {
    const h = harness();
    await h.save();
    await h.grant("research", ["read_posts"]);
    expect(await h.api.handleMcpPost("Bearer research", { profile: "research" })).toMatchObject({
      status: 401,
    });
    h.setRuntime("different-runtime");
    expect(await h.call("research")).toMatchObject({ status: 401 });
    h.setRuntime("runtime-one");
    h.profiles.get("research")!.enabled_toolsets.push("no_mcp");
    expect(await h.call("research")).toMatchObject({ status: 401 });
    h.profiles.get("research")!.enabled_toolsets = [serverName];
    h.profiles
      .get("research")!
      .mcp_servers.find((server) => server.name === serverName)!.enabled = false;
    expect(await h.call("research")).toMatchObject({ status: 401 });
    const binding = h.profiles
      .get("research")!
      .mcp_servers.find((server) => server.name === serverName)!;
    binding.enabled = true;
    binding.url = "https://replacement.example/mcp";
    expect(await h.call("research")).toMatchObject({ status: 401 });
    expect(h.fetchRequest).not.toHaveBeenCalled();
  });

  it.each(["revoke", "remove", "disable", "endpoint", "tools"])(
    "checks %s against current state on every call",
    async (change) => {
      const h = harness();
      await h.save();
      await h.grant("research", ["read_posts"]);
      await h.call("research");
      if (change === "revoke" || change === "remove")
        await h.api.request(`vulcan.accounts.${change}`, { id: "launchpost", profile: "research" });
      if (change === "disable") await h.save({ enabled: false });
      if (change === "endpoint") await h.save({ url: "https://new.example/mcp" });
      if (change === "tools") await h.grant("research", ["schedule_post"]);
      expect(await h.call("research")).toMatchObject({ body: { result: { isError: true } } });
      expect(h.fetchRequest).toHaveBeenCalledTimes(1);
      if (change === "revoke" || change === "remove") {
        expect(
          await h.api.handleMcpPost(`Bearer ${h.capabilities.get("research")}`, {
            jsonrpc: "2.0",
            id: 2,
            method: "initialize",
            params: {},
          }),
        ).toMatchObject({
          status: 200,
          body: { result: { capabilities: { tools: expect.any(Object) } } },
        });
        expect(
          await h.call("research", "vulcan_describe_managed_mcp", { connectionId: "launchpost" }),
        ).toMatchObject({ body: { result: { isError: true } } });
        expect(await h.call("research", "vulcan_list_managed_mcp", {})).toMatchObject({
          body: {
            result: {
              content: [{ type: "text", text: JSON.stringify({ connections: [] }, null, 2) }],
            },
          },
        });
        expect(h.fetchRequest).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("does not install provider credentials or overwrite an unrelated native connection", async () => {
    const h = harness();
    await h.save();
    h.profiles
      .get("research")!
      .mcp_servers.push({ name: serverName, url: "https://unrelated.example/mcp", enabled: true });
    await expect(h.grant("research", ["read_posts"])).rejects.toThrow();
    expect(h.nativeRequest.mock.calls.some(([method]) => method === "mcp.servers.add")).toBe(false);
    expect(await h.api.request("vulcan.accounts.list", {})).toMatchObject({
      connections: [{ profileGrants: [] }],
    });
  });

  it("withholds grants when native setup fails", async () => {
    const h = harness();
    await h.save();
    const native = h.nativeRequest.getMockImplementation()!;
    h.nativeRequest.mockImplementation(async (method, params) =>
      method === "profiles.configure" ? { ok: false } : native(method, params),
    );
    await expect(h.grant("research", ["read_posts"])).rejects.toThrow();
    expect(await h.api.request("vulcan.accounts.list", {})).toMatchObject({
      connections: [{ profileGrants: [] }],
    });
  });

  it("revokes during a slow secret read without dispatching the provider call", async () => {
    const h = harness();
    await h.save();
    await h.grant("research", ["read_posts"]);
    const entered = deferred(),
      resume = deferred();
    const read = h.options.secrets.get.getMockImplementation()!;
    h.options.secrets.get.mockImplementation(async (key) => {
      if (key === "managed-mcp-launchpost") {
        entered.resolve();
        await resume.promise;
      }
      return read(key);
    });
    const pending = h.call("research");
    await entered.promise;
    await h.api.request("vulcan.accounts.revoke", { id: "launchpost", profile: "research" });
    resume.resolve();
    expect(await pending).toMatchObject({ body: { result: { isError: true } } });
    expect(h.fetchRequest).not.toHaveBeenCalled();
  });

  it("cancels both active and queued grants when revocation arrives during native setup", async () => {
    const h = harness();
    await h.save();
    const entered = deferred(),
      resume = deferred();
    const native = h.nativeRequest.getMockImplementation()!;
    h.nativeRequest.mockImplementation(async (method, params) => {
      if (method === "profiles.configure") {
        entered.resolve();
        await resume.promise;
      }
      return native(method, params);
    });
    const first = h.grant("research", ["read_posts"]);
    const second = h.grant("research", ["schedule_post"]);
    const settled = Promise.allSettled([first, second]);
    await entered.promise;
    await h.api.request("vulcan.accounts.revoke", { id: "launchpost", profile: "research" });
    resume.resolve();
    expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(await h.api.request("vulcan.accounts.list", {})).toMatchObject({
      connections: [{ profileGrants: [] }],
    });
  });

  it("withholds decoded secret echoes and bounds streamed response bytes", async () => {
    const h = harness();
    await h.save();
    await h.grant("research", ["read_posts"]);
    h.setResult({ content: [{ type: "text", text: providerToken }] });
    const echo = await h.call("research");
    expect(echo).toMatchObject({ body: { result: { isError: true } } });
    expect(JSON.stringify(echo)).not.toContain(providerToken);
    const canceled = vi.fn();
    h.fetchRequest.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(600_000));
            },
            cancel: canceled,
          }),
        ),
    );
    expect(await h.call("research")).toMatchObject({ body: { result: { isError: true } } });
    expect(canceled).toHaveBeenCalledOnce();
  });

  it("checks real provider catalogs without granting and rejects unsafe endpoints", async () => {
    const h = harness();
    await h.save();
    expect(await h.api.request("vulcan.accounts.check", { id: "launchpost" })).toEqual({
      ok: true,
      tools: catalog,
    });
    expect(await h.api.request("vulcan.accounts.list", {})).toMatchObject({
      connections: [{ profileGrants: [] }],
    });
    for (const url of [
      "http://example.com/mcp",
      "https://user:password@example.com/mcp",
      "https://example.com/mcp?token=x",
      "https://example.com/mcp#x",
    ]) {
      await expect(h.save({ url })).rejects.toThrow();
    }
    await expect(h.grant("unknown-worker", ["read_posts"])).rejects.toThrow();
  });
});
