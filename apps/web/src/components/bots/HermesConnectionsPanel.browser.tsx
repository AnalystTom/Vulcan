import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NativeApi } from "@vulcan/contracts";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

const fixture = vi.hoisted(() => {
  let enabled = false;
  let enabledToolsets = ["browser", "custom_unknown"];
  let flowNumber = 0;
  let approvedPolls = 0;
  let contradictoryApproval = false;
  let rejectCancellation = false;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  const request = vi.fn(
    async ({ method, params }: { method: string; params: Record<string, unknown> }) => {
      calls.push({ method, params });
      if (method === "mcp.catalog") {
        return {
          servers: [
            {
              name: "launchpost",
              description: "",
              installed: true,
              enabled: true,
              transport: "http",
            },
          ],
        };
      }
      if (method === "mcp.servers.list") {
        return {
          servers: [
            {
              name: "launchpost",
              transport: "http",
              auth: "oauth",
              oauth_tokens_present: false,
              enabled,
              tools: [],
            },
          ],
        };
      }
      if (method === "profiles.describe") {
        return {
          name: "research",
          model: { provider: "test", default: "test-model" },
          skills: [],
          toolsets: [],
          toolsets_pinned: true,
          enabled_toolsets: enabledToolsets,
          mcp_servers: [{ name: "launchpost", enabled, transport: "http" }],
        };
      }
      if (method === "profiles.configure") {
        enabled = (params.enabled_mcp_servers as string[]).includes("launchpost");
        enabledToolsets = [...(params.enabled_toolsets as string[])];
        return { ok: true, applied: { mcp_servers: true, toolsets: true } };
      }
      if (method === "mcp.servers.add") {
        return {
          ok: true,
          server: {
            name: params.name,
            transport: "http",
            auth: "header",
            enabled: false,
            tools: [],
          },
        };
      }
      if (method === "mcp.servers.oauth.start") {
        flowNumber += 1;
        return {
          ok: true,
          session_id: `oauth-session-${flowNumber}`,
          auth_url: `https://provider.example/authorize?state=oauth-state-${flowNumber}`,
        };
      }
      if (method === "mcp.servers.oauth.poll") {
        if (contradictoryApproval) {
          contradictoryApproval = false;
          return { ok: false, session_id: params.session_id, status: "approved", tools: [] };
        }
        if (approvedPolls > 0) {
          approvedPolls -= 1;
          return { ok: true, session_id: params.session_id, status: "approved", tools: [] };
        }
        return { ok: true, session_id: params.session_id, status: "pending", tools: [] };
      }
      if (method === "mcp.servers.oauth.callback") {
        return { ok: true, session_id: params.session_id, status: "pending", tools: [] };
      }
      if (method === "mcp.servers.oauth.cancel") {
        if (rejectCancellation) throw new Error("fixture cancellation rejected");
        return { ok: true, session_id: params.session_id, status: "error", tools: [] };
      }
      throw new Error(`Unhandled fixture RPC: ${method}`);
    },
  );
  const api = {
    hermesBots: {
      request,
      status: vi.fn(),
      connect: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
    },
  } as unknown as NativeApi;

  return {
    api,
    request,
    calls,
    approveNextPoll: () => {
      approvedPolls += 1;
    },
    returnContradictoryApproval: () => {
      contradictoryApproval = true;
    },
    rejectNextCancellation: () => {
      rejectCancellation = true;
    },
    reset: () => {
      enabled = false;
      enabledToolsets = ["browser", "custom_unknown"];
      flowNumber = 0;
      approvedPolls = 0;
      contradictoryApproval = false;
      rejectCancellation = false;
      calls.length = 0;
      request.mockClear();
    },
  };
});

vi.mock("../../nativeApi", () => ({
  readNativeApi: () => fixture.api,
}));

import { HermesConnectionsPanel } from "./HermesConnectionsPanel";

function TestProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      {children}
    </QueryClientProvider>
  );
}

afterEach(async () => {
  await cleanup();
  document
    .querySelectorAll("iframe[src*='hermes-mcp-callback.html']")
    .forEach((frame) => frame.remove());
  fixture.reset();
});

it("keeps Hermes connection access and local OAuth state truthful", async () => {
  await render(
    <TestProviders>
      <HermesConnectionsPanel profile="research" />
    </TestProviders>,
  );

  const allow = page.getByRole("checkbox", { name: "Allow this worker to use the connection" });
  await expect.element(allow).toBeVisible();
  expect((allow.element() as HTMLInputElement).checked).toBe(false);
  await allow.click();
  await vi.waitFor(() =>
    expect(fixture.request).toHaveBeenCalledWith({
      method: "profiles.configure",
      params: {
        name: "research",
        enabled_mcp_servers: ["launchpost"],
        enabled_toolsets: ["browser", "custom_unknown", "launchpost"],
      },
    }),
  );

  await page.getByRole("button", { name: "Add connection" }).click();
  await page.getByLabelText("Authentication").selectOptions("header");
  await page.getByLabelText("Connection name").fill("test-service");
  await page.getByLabelText("Service URL").fill("https://test-service.example/mcp");
  const tokenField = page.getByLabelText("Access token", { exact: true });
  const token = tokenField.element() as HTMLInputElement;
  await tokenField.fill("test-access-token");
  await page.getByRole("button", { name: "Save connection" }).click();
  await vi.waitFor(() => expect(token.value).toBe(""));

  const start = page.getByRole("button", { name: "Sign in" });
  await start.click();
  await vi.waitFor(() =>
    expect(fixture.request).toHaveBeenCalledWith({
      method: "mcp.servers.oauth.start",
      params: {
        profile: "research",
        name: "launchpost",
        client_redirect_uri: `${window.location.origin}/hermes-mcp-callback.html`,
      },
    }),
  );
  await expect.element(page.getByRole("link", { name: "Open sign-in" })).toBeVisible();

  const state = "oauth-state-1";
  const callback = document.createElement("iframe");
  callback.src = `${window.location.origin}/hermes-mcp-callback.html?state=${state}&code=test-code`;
  document.body.append(callback);
  await vi.waitFor(() =>
    expect(fixture.request).toHaveBeenCalledWith({
      method: "mcp.servers.oauth.callback",
      params: {
        profile: "research",
        name: "launchpost",
        session_id: "oauth-session-1",
        code: "test-code",
        state,
      },
    }),
  );
  await vi.waitFor(() =>
    expect(callback.contentDocument?.body.textContent).toContain(
      "check whether the connection succeeded",
    ),
  );
  expect(document.body.textContent).not.toContain(
    "Sign-in completed and the connection was checked.",
  );

  fixture.returnContradictoryApproval();
  await page.getByRole("button", { name: "Check status" }).click();
  await expect
    .element(
      page.getByText("The sign-in status is unavailable. Check again or cancel.", { exact: true }),
    )
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Cancel sign-in" })).toBeVisible();

  fixture.approveNextPoll();
  await page.getByRole("button", { name: "Check status" }).click();
  await expect
    .element(page.getByText("Sign-in completed and the connection was checked.", { exact: true }))
    .toBeVisible();

  await page.getByRole("button", { name: "Sign in" }).click();
  await expect.element(page.getByRole("button", { name: "Cancel sign-in" })).toBeVisible();
  const malformed = document.createElement("iframe");
  malformed.src = `${window.location.origin}/hermes-mcp-callback.html?state=oauth-state-2`;
  document.body.append(malformed);
  await vi.waitFor(() =>
    expect(malformed.contentDocument?.body.textContent).toContain("cannot be returned"),
  );
  expect(
    fixture.calls.some(
      ({ method, params }) =>
        method === "mcp.servers.oauth.callback" && params.session_id === "oauth-session-2",
    ),
  ).toBe(false);
  fixture.rejectNextCancellation();
  await page.getByRole("button", { name: "Cancel sign-in" }).click();
  await expect
    .element(
      page.getByText("Cancellation was not confirmed. Check the status or retry cancellation.", {
        exact: true,
      }),
    )
    .toBeVisible();

  for (const call of fixture.calls.filter(({ method }) => method.startsWith("mcp."))) {
    expect(call.params.profile).toBe("research");
  }
});
