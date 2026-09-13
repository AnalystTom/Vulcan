import type { HermesBotMethod, HermesBotRequest, NativeApi } from "@vulcan/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hermesSetupUrl as safeHttpUrl } from "@vulcan/shared/hermesSetup";

import { readNativeApi } from "../nativeApi";
import { toastManager } from "../components/ui/toast";
import { parseProfileDetail } from "./useHermesBots";

type Rec = Record<string, unknown>;
type HermesBotsNativeApi = NonNullable<NativeApi["hermesBots"]>;
type HermesParams = HermesBotRequest["params"];

function rec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rows(body: unknown, key: string): unknown[] {
  const value = rec(body)?.[key];
  if (!Array.isArray(value)) throw new Error(`Hermes returned an invalid ${key} list.`);
  return value;
}

function safeLoopbackHttpUrl(value: unknown): string | null {
  const candidate = safeHttpUrl(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "http:" ||
      !(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") ||
      !url.port
    )
      return null;
    return candidate;
  } catch {
    return null;
  }
}

function safeFailure(): Error {
  return new Error("Hermes setup request failed.");
}

function api(): HermesBotsNativeApi | null {
  return readNativeApi()?.hermesBots ?? null;
}

function requireApi(): HermesBotsNativeApi {
  const value = api();
  if (!value) throw new Error("This Vulcan server has no Hermes bridge.");
  return value;
}

async function call(
  method: HermesBotMethod,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  try {
    return await requireApi().request({ method, params: params as HermesParams });
  } catch {
    // Native RPC exceptions can contain upstream headers, URLs, or provider details.
    throw safeFailure();
  }
}

function profileParams(profile: string): Record<string, unknown> {
  return { profile };
}

export interface HermesMcpCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly requiredEnvKeys: readonly string[];
  readonly transport: string;
}

export interface HermesMcpServer {
  readonly name: string;
  readonly transport: string;
  readonly auth: string | null;
  readonly authState:
    | "authenticated"
    | "authentication_required"
    | "configured"
    | "none"
    | "unknown";
  readonly oauthTokensPresent: boolean | null;
  /** Native list summaries omit the profile grant's disabled flag; use status/describe for that. */
  readonly enabled: boolean | null;
  /** Tool names only; descriptions and raw configuration stay out of UI state. */
  readonly tools: readonly string[];
}

export interface HermesMcpTestResult {
  readonly ok: boolean;
  readonly tools: readonly string[];
  readonly prompts: number | null;
  readonly resources: number | null;
  readonly oauthNeeded: boolean | null;
  readonly oauthTokensPresent: boolean | null;
  readonly error: string | null;
}

export interface HermesMcpAddInput {
  readonly name: string;
  readonly preset?: string;
  /** Custom HTTP MCP endpoint; credentials are stored by Hermes and never returned by this hook. */
  readonly url?: string;
  readonly auth?: "oauth" | "header";
  readonly bearerToken?: string;
}

export interface HermesMcpGrantInput {
  readonly name: string;
  readonly enabled: boolean;
}

export type HermesMcpOAuthStatus = "pending" | "approved" | "error";

export interface HermesMcpOAuthResult {
  readonly ok: boolean;
  readonly sessionId: string | null;
  readonly status: HermesMcpOAuthStatus | null;
  readonly authUrl: string | null;
  readonly flow: string | null;
  readonly error: string | null;
  readonly tools: readonly string[];
}

function authState(
  auth: string | null,
  oauthTokensPresent: boolean | null,
): HermesMcpServer["authState"] {
  if (!auth) return "none";
  if (auth === "oauth") {
    return oauthTokensPresent === true ? "configured" : "authentication_required";
  }
  return auth === "header" && oauthTokensPresent === null ? "configured" : "unknown";
}

function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string" && entry.length > 0) return [entry];
    const name = rec(entry)?.name;
    return typeof name === "string" && name.length > 0 ? [name] : [];
  });
}

export function parseHermesMcpCatalog(body: unknown): HermesMcpCatalogEntry[] {
  return rows(body, "servers").flatMap((entry) => {
    const row = rec(entry);
    const name = str(row?.name);
    if (!row || !name) return [];
    return [
      {
        name,
        description: str(row.description) ?? "",
        installed: bool(row.installed) ?? false,
        enabled: bool(row.enabled) ?? false,
        requiredEnvKeys: Array.isArray(row.requires)
          ? row.requires.flatMap((key) => (typeof key === "string" ? [key] : []))
          : [],
        transport: str(row.transport) ?? "unknown",
      },
    ];
  });
}

export function parseHermesMcpServers(body: unknown): HermesMcpServer[] {
  return rows(body, "servers").flatMap((entry) => {
    const row = rec(entry);
    const name = str(row?.name);
    if (!row || !name) return [];
    const auth = str(row.auth);
    const oauthTokensPresent =
      typeof row.oauth_tokens_present === "boolean" ? row.oauth_tokens_present : null;
    return [
      {
        name,
        transport: str(row.transport) ?? "unknown",
        auth,
        authState: authState(auth, oauthTokensPresent),
        oauthTokensPresent,
        enabled: bool(row.enabled),
        tools: toolNames(row.tools),
      },
    ];
  });
}

export function parseHermesMcpTest(body: unknown): HermesMcpTestResult {
  const root = rec(body);
  if (!root || typeof root.ok !== "boolean" || !Array.isArray(root.tools)) throw safeFailure();
  const ok = root.ok;
  return {
    ok,
    tools: toolNames(root?.tools),
    prompts: num(root?.prompts),
    resources: num(root?.resources),
    oauthNeeded: bool(root?.oauth_needed),
    oauthTokensPresent: bool(root?.oauth_tokens_present),
    error: ok ? null : "MCP server test failed.",
  };
}

function oauthStatus(value: unknown): HermesMcpOAuthStatus | null {
  if (value === "pending" || value === "approved" || value === "error") return value;
  return null;
}

export function parseHermesMcpOAuth(body: unknown): HermesMcpOAuthResult {
  const root = rec(body);
  if (!root || typeof root.ok !== "boolean") throw safeFailure();
  const ok = root.ok;
  const status = oauthStatus(root?.status);
  return {
    ok,
    sessionId: str(root?.session_id),
    status,
    authUrl: safeHttpUrl(root?.auth_url),
    flow: str(root?.flow),
    error: !ok || status === "error" ? "MCP authorization did not complete." : null,
    tools: toolNames(root?.tools),
  };
}

const ROOT = "hermes-bots" as const;
export const hermesConnectionKeys = {
  catalog: (profile: string) => [ROOT, "mcp-catalog", profile] as const,
  servers: (profile: string) => [ROOT, "mcp-servers", profile] as const,
};

export function useHermesMcpCatalog(profile: string | null, enabled = true) {
  return useQuery({
    queryKey: hermesConnectionKeys.catalog(profile ?? ""),
    queryFn: async () => parseHermesMcpCatalog(await call("mcp.catalog", profileParams(profile!))),
    enabled: enabled && profile !== null,
    staleTime: 60_000,
    retry: false,
  });
}

export function useHermesMcpServers(profile: string | null, enabled = true) {
  return useQuery({
    queryKey: hermesConnectionKeys.servers(profile ?? ""),
    queryFn: async () =>
      parseHermesMcpServers(await call("mcp.servers.list", profileParams(profile!))),
    enabled: enabled && profile !== null,
    staleTime: 30_000,
    retry: false,
  });
}

const mutationToast = {
  onError: (error: Error) => toastManager.add({ type: "error" as const, title: error.message }),
};

export function useHermesMcpMutations(profile: string | null) {
  const queryClient = useQueryClient();
  const refresh = () => {
    if (!profile) return;
    void queryClient.invalidateQueries({ queryKey: hermesConnectionKeys.catalog(profile) });
    void queryClient.invalidateQueries({ queryKey: hermesConnectionKeys.servers(profile) });
  };
  const refreshProfile = () => {
    refresh();
    if (!profile) return;
    void queryClient.invalidateQueries({ queryKey: ["hermes-bots", "profiles"] });
    void queryClient.invalidateQueries({ queryKey: ["hermes-bots", "detail", profile] });
  };
  const add = useMutation({
    mutationFn: async (input: HermesMcpAddInput) => {
      if (!profile) throw new Error("Pick a Hermes profile first.");
      if (!input.name.trim() || (!input.preset?.trim() && !input.url?.trim()))
        throw new Error("MCP server name and preset or URL are required.");
      const url = input.url ? safeHttpUrl(input.url) : null;
      if (input.url && (!url || new URL(url).search || new URL(url).hash)) {
        throw new Error("MCP server URL must be HTTP(S) without credentials, query, or hash.");
      }
      if (input.bearerToken && input.auth !== "header") {
        throw new Error("A bearer token requires header authentication.");
      }
      if (input.bearerToken !== undefined && input.bearerToken.length === 0) {
        throw new Error("A bearer token cannot be empty.");
      }
      const config = {
        enabled: false,
        ...(url ? { url } : {}),
        ...(input.auth ? { auth: input.auth } : {}),
      };
      const body = rec(
        await call("mcp.servers.add", {
          ...profileParams(profile),
          name: input.name,
          ...(input.preset?.trim() ? { preset: input.preset } : {}),
          config,
          ...(input.bearerToken ? { bearer_token: input.bearerToken } : {}),
        }),
      );
      if (!body || bool(body.ok) !== true) throw safeFailure();
      return parseHermesMcpServers({ servers: [body.server] })[0] ?? null;
    },
    gcTime: 0,
    onSuccess: refreshProfile,
    ...mutationToast,
  });
  const test = useMutation({
    mutationFn: async (input: { name: string }) => {
      if (!profile) throw new Error("Pick a Hermes profile first.");
      return parseHermesMcpTest(
        await call("mcp.servers.test", { ...profileParams(profile), name: input.name }),
      );
    },
    onSuccess: refresh,
    ...mutationToast,
  });
  const remove = useMutation({
    mutationFn: async (input: { name: string }) => {
      if (!profile) throw new Error("Pick a Hermes profile first.");
      const body = rec(
        await call("mcp.servers.remove", { ...profileParams(profile), name: input.name }),
      );
      if (bool(body?.ok) !== true) throw safeFailure();
    },
    onSuccess: refreshProfile,
    ...mutationToast,
  });
  const oauthStart = useMutation({
    mutationFn: async (input: { name: string; clientRedirectUri?: string }) => {
      if (!profile) throw new Error("Pick a Hermes profile first.");
      const redirect = input.clientRedirectUri
        ? safeLoopbackHttpUrl(input.clientRedirectUri)
        : null;
      if (input.clientRedirectUri && !redirect) {
        throw new Error("OAuth callback URL must be an HTTP loopback URL with an explicit port.");
      }
      return parseHermesMcpOAuth(
        await call("mcp.servers.oauth.start", {
          ...profileParams(profile),
          name: input.name,
          ...(redirect ? { client_redirect_uri: redirect } : {}),
        }),
      );
    },
    ...mutationToast,
  });
  const oauthPoll = useMutation({
    mutationFn: async (input: { name: string; sessionId: string }) => {
      if (!profile) throw new Error("Pick a Hermes profile first.");
      return parseHermesMcpOAuth(
        await call("mcp.servers.oauth.poll", {
          ...profileParams(profile),
          name: input.name,
          session_id: input.sessionId,
        }),
      );
    },
    onSuccess: refresh,
    ...mutationToast,
  });
  const oauthCancel = useMutation({
    mutationFn: async (input: { name: string; sessionId: string }) => {
      if (!profile) throw new Error("Pick a Hermes profile first.");
      const body = rec(
        await call("mcp.servers.oauth.cancel", {
          ...profileParams(profile),
          name: input.name,
          session_id: input.sessionId,
        }),
      );
      if (bool(body?.ok) !== true) throw safeFailure();
      return parseHermesMcpOAuth(body);
    },
    onSuccess: refresh,
    ...mutationToast,
  });
  const oauthCallback = useMutation({
    mutationFn: async (input: {
      name: string;
      sessionId: string;
      code?: string;
      state?: string;
      error?: string;
    }) => {
      if (!profile) throw new Error("Pick a Hermes profile first.");
      return parseHermesMcpOAuth(
        await call("mcp.servers.oauth.callback", {
          ...profileParams(profile),
          name: input.name,
          session_id: input.sessionId,
          ...(input.code ? { code: input.code } : {}),
          ...(input.state ? { state: input.state } : {}),
          ...(input.error ? { error: input.error } : {}),
        }),
      );
    },
    onSuccess: refresh,
    gcTime: 0,
    ...mutationToast,
  });
  const grant = useMutation({
    scope: { id: `hermes-profile-grant:${profile ?? ""}` },
    mutationFn: async (input: HermesMcpGrantInput) => {
      if (!profile) throw new Error("Pick a Hermes profile first.");
      // Serialized mutations must read after the previous write, not reuse a rendered snapshot.
      const snapshot = rec(await call("profiles.describe", { name: profile }));
      if (
        !snapshot ||
        snapshot.name !== profile ||
        !Array.isArray(snapshot.mcp_servers) ||
        typeof snapshot.toolsets_pinned !== "boolean"
      )
        throw safeFailure();
      const detail = parseProfileDetail(snapshot);
      if (!detail.mcpServers.some((entry) => entry.name === input.name)) throw safeFailure();
      const servers = new Set(
        detail.mcpServers.filter((entry) => entry.enabled).map((entry) => entry.name),
      );
      if (input.enabled) servers.add(input.name);
      else servers.delete(input.name);
      let pin = detail.enabledToolsets;
      if (detail.toolsetsPinned) {
        if (pin === null)
          throw new Error("Hermes must expose the complete tool selection before changing access.");
        if (input.enabled && pin.includes("no_mcp")) {
          const knownServers = new Set(detail.mcpServers.map((entry) => entry.name));
          pin = pin.filter((entry) => entry !== "no_mcp" && !knownServers.has(entry));
        }
        pin = input.enabled
          ? [...new Set([...pin, input.name])]
          : pin.filter((entry) => entry !== input.name);
      }
      // Native empty pins restore defaults; keep an explicit deny-all selection when revoking the last toolset.
      if (detail.toolsetsPinned && pin?.length === 0) pin = ["no_mcp"];
      const body = rec(
        await call("profiles.configure", {
          name: profile,
          enabled_mcp_servers: [...servers],
          ...(detail.toolsetsPinned && pin !== null ? { enabled_toolsets: pin } : {}),
        }),
      );
      const applied = rec(body?.applied);
      const mcpServersApplied = bool(applied?.mcp_servers) === true;
      const toolsetsApplied = detail.toolsetsPinned ? bool(applied?.toolsets) === true : null;
      if (
        bool(body?.ok) !== true ||
        !applied ||
        !mcpServersApplied ||
        (detail.toolsetsPinned && toolsetsApplied !== true)
      ) {
        throw new Error("Hermes did not apply all MCP grant changes; refresh and try again.");
      }
      return {
        ok: true,
        mcpServersApplied,
        toolsetsApplied,
      };
    },
    onSettled: refreshProfile,
    ...mutationToast,
  });
  return { add, test, remove, grant, oauthStart, oauthPoll, oauthCancel, oauthCallback };
}
