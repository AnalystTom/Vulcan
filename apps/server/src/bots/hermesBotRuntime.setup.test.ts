import { describe, expect, it } from "vitest";

import { sanitizeHermesSetupResponse } from "./hermesBotRuntime";

describe("sanitizeHermesSetupResponse", () => {
  it("removes MCP configuration and tool descriptions before crossing the bridge", () => {
    expect(
      sanitizeHermesSetupResponse("mcp.servers.list", {
        servers: [
          {
            name: "launchpost",
            transport: "http",
            url: "https://launchpost.example/mcp?credential=redacted-value",
            command: "node",
            args: ["--credential", "redacted-value"],
            env: ["LAUNCHPOST_TOKEN"],
            headers: { Authorization: "Bearer redacted-value" },
            auth: "oauth",
            oauth_tokens_present: true,
            enabled: true,
            tools: [{ name: "list_drafts", description: "private provider details" }],
          },
        ],
      } as never),
    ).toEqual({
      servers: [
        {
          name: "launchpost",
          transport: "http",
          auth: "oauth",
          oauth_tokens_present: true,
          tools: ["list_drafts"],
        },
      ],
    });
  });

  it("does not forward native OAuth failure text", () => {
    expect(
      sanitizeHermesSetupResponse("mcp.servers.oauth.poll", {
        ok: true,
        session_id: "oauth-session",
        status: "error",
        error_message: "provider URL carried redacted-value",
      } as never),
    ).toEqual({
      ok: true,
      session_id: "oauth-session",
      status: "error",
      error_message: "MCP authorization did not complete.",
    });
  });

  it("rejects account credentials embedded in sign-in URL queries or fragments", () => {
    for (const suffix of ["?access_token=private", "?API_KEY=private", "#refresh_token=private"]) {
      const result = sanitizeHermesSetupResponse("mcp.servers.oauth.start", {
        ok: true,
        session_id: "test-flow",
        auth_url: `https://provider.example/authorize${suffix}`,
      });
      expect(result).toEqual({ ok: true, session_id: "test-flow" });
    }
  });

  it("rejects malformed list payloads instead of turning them into empty state", () => {
    expect(() =>
      sanitizeHermesSetupResponse("mcp.servers.list", { servers: "invalid" } as never),
    ).toThrow("invalid setup response");
  });
});
