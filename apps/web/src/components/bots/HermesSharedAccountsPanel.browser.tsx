import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

const fixture = vi.hoisted(() => {
  const accounts: Array<{
    id: string;
    name: string;
    url: string;
    enabled: boolean;
    credentialConfigured: boolean;
    profileGrants: Array<{ profile: string; allowedTools: string[] }>;
  }> = [];
  let rejectGrant = false;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const request = vi.fn(
    async ({ method, params }: { method: string; params: Record<string, unknown> }) => {
      calls.push({ method, params });
      if (method === "vulcan.accounts.list") return { connections: structuredClone(accounts) };
      if (method === "vulcan.accounts.save") {
        accounts.push({
          id: String(params.id),
          name: String(params.name),
          url: String(params.url),
          enabled: true,
          credentialConfigured: true,
          profileGrants: [],
        });
        return { ok: true };
      }
      if (method === "vulcan.accounts.check")
        return { ok: true, tools: [{ name: "list_posts" }, { name: "schedule_post" }] };
      const account = accounts.find((a) => a.id === params.id)!;
      if (method === "vulcan.accounts.grant") {
        if (rejectGrant) throw new Error("Uncertain setup");
        account.profileGrants.push({
          profile: String(params.profile),
          allowedTools: params.allowedTools as string[],
        });
        return { ok: true };
      }
      if (method === "vulcan.accounts.revoke") {
        account.profileGrants = account.profileGrants.filter((g) => g.profile !== params.profile);
        return { ok: true };
      }
      throw new Error("Unexpected fixture request");
    },
  );
  return {
    accounts,
    calls,
    request,
    failNextGrant: () => {
      rejectGrant = true;
    },
    reset: () => {
      accounts.length = 0;
      calls.length = 0;
      rejectGrant = false;
      request.mockClear();
    },
  };
});
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({ hermesBots: { request: fixture.request } }),
}));
import { HermesSharedAccountsPanel } from "./HermesSharedAccountsPanel";
afterEach(() => {
  cleanup();
  fixture.reset();
});

it("saves one credential, exposes checked tool choices, and keeps grants specific to each worker", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = await render(
    <QueryClientProvider client={client}>
      <HermesSharedAccountsPanel profile="research" />
    </QueryClientProvider>,
  );
  await expect.element(page.getByText("No shared accounts configured.")).toBeVisible();
  await page.getByRole("button", { name: "Add shared account", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Account name", exact: true })
    .fill("LaunchPost test account");
  await page
    .getByRole("textbox", { name: "Service HTTPS URL", exact: true })
    .fill("https://mcp.example.test/mcp");
  await page.getByLabelText("Shared access token", { exact: true }).fill("test-secret-once");
  await page.getByRole("button", { name: "Save shared account", exact: true }).click();
  await expect
    .element(page.getByText("Access token saved. Check the connection to verify access."))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Allow selected tools", exact: true }))
    .toBeDisabled();
  await page.getByRole("button", { name: "Check shared account", exact: true }).click();
  await expect
    .element(page.getByText("Last connection check succeeded: 2 tools available."))
    .toBeVisible();
  await page.getByRole("checkbox", { name: "list_posts", exact: true }).click();
  await page.getByRole("button", { name: "Allow selected tools", exact: true }).click();
  await expect.element(page.getByText("Granted to 1 worker.", { exact: false })).toBeVisible();
  expect(fixture.calls.find((c) => c.method === "vulcan.accounts.grant")?.params).toMatchObject({
    profile: "research",
    allowedTools: ["list_posts"],
  });
  await view.rerender(
    <QueryClientProvider client={client}>
      <HermesSharedAccountsPanel profile="distribution" />
    </QueryClientProvider>,
  );
  await expect.element(page.getByText("Tools allowed for @distribution")).toBeVisible();
  await expect
    .element(page.getByText("No tools granted. Check this account to choose tools."))
    .toBeVisible();
  await page.getByRole("button", { name: "Check shared account", exact: true }).click();
  await page.getByRole("checkbox", { name: "schedule_post", exact: true }).click();
  fixture.failNextGrant();
  await page.getByRole("button", { name: "Allow selected tools", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("The request could not be confirmed.");
  expect(fixture.accounts[0]?.profileGrants).toEqual([
    { profile: "research", allowedTools: ["list_posts"] },
  ]);
  expect(fixture.calls.filter((c) => c.method === "vulcan.accounts.save")).toHaveLength(1);
  await expect
    .poll(() =>
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((m) => m.state.variables),
      ),
    )
    .not.toContain("test-secret-once");
  await page.getByRole("button", { name: "Add shared account", exact: true }).click();
  await expect.element(page.getByLabelText("Shared access token", { exact: true })).toHaveValue("");
  client.clear();
});
