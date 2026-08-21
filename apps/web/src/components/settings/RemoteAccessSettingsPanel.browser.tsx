// FILE: RemoteAccessSettingsPanel.browser.tsx
// Purpose: Browser behavior for owner-managed mobile pairing and client revocation.
// Layer: Browser UI test

import "../../index.css";

import type { AuthClientSession, AuthPairingCredentialResult, ServerConfig } from "@vulcan/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  createPairing: vi.fn<() => Promise<AuthPairingCredentialResult>>(),
  listPairingLinks: vi.fn(async () => []),
  listClients: vi.fn<() => Promise<ReadonlyArray<AuthClientSession>>>(),
  revokeClient: vi.fn(async () => ({ revoked: true })),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    server: {
      createAuthPairingToken: harness.createPairing,
      listAuthPairingLinks: harness.listPairingLinks,
      listAuthClients: harness.listClients,
      revokeAuthClient: harness.revokeClient,
    },
  }),
}));

import { RemoteAccessSettingsPanel } from "./RemoteAccessSettingsPanel";

const config = {
  cwd: "/repo",
  worktreesDir: "/worktrees",
  keybindingsConfigPath: "/tmp/keybindings.json",
  keybindings: { version: 1, bindings: [] },
  issues: [],
  providers: [],
  availableEditors: [],
  remoteAccessUrl: "https://vulcan.test",
} as unknown as ServerConfig;

const mobileClient = {
  sessionId: "auth-session-mobile",
  subject: "one-time-token",
  role: "client",
  method: "browser-session-cookie",
  client: {
    label: "Pixel 9a",
    deviceType: "mobile",
    os: "Android",
    browser: "Chrome",
  },
  issuedAt: "2026-08-21T10:00:00.000Z",
  expiresAt: "2026-09-20T10:00:00.000Z",
  lastConnectedAt: "2026-08-21T10:05:00.000Z",
  connected: true,
  current: false,
} as AuthClientSession;

function renderPanel(role: "owner" | "client" = "owner") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RemoteAccessSettingsPanel
        active
        authSession={{
          authenticated: true,
          role,
          sessionMethod: "browser-session-cookie",
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "vulcan_session",
          },
        }}
        config={config}
      />
    </QueryClientProvider>,
  );
}

describe("RemoteAccessSettingsPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("lets the owner create a labelled mobile link and revoke the paired child", async () => {
    harness.createPairing.mockResolvedValue({
      id: "pairing-1",
      credential: "PAIR123",
      label: "Pixel 9a",
      expiresAt: "2026-08-21T10:10:00.000Z",
    });
    harness.listClients.mockResolvedValue([mobileClient]);

    await renderPanel();

    await expect.element(page.getByText("Pixel 9a")).toBeVisible();
    await page.getByLabelText("Device name").fill("Gym phone");
    await page.getByRole("button", { name: "Create pairing link" }).click();

    expect(harness.createPairing).toHaveBeenCalledWith({ label: "Gym phone" });
    const pairingLink = page.getByLabelText("New pairing link");
    await expect.element(pairingLink).toBeVisible();
    expect((pairingLink.element() as HTMLInputElement).value).toBe(
      "https://vulcan.test/pair#token=PAIR123",
    );

    await page.getByRole("button", { name: "Revoke Pixel 9a" }).click();
    expect(harness.revokeClient).toHaveBeenCalledWith({ sessionId: mobileClient.sessionId });
  });

  it("keeps access management on the owner and explains the child role", async () => {
    await renderPanel("client");

    await expect.element(page.getByText("Connected as a client")).toBeVisible();
    expect(document.body.textContent).toContain("Only the owner device can pair or revoke");
    expect(harness.listClients).not.toHaveBeenCalled();
    expect(harness.listPairingLinks).not.toHaveBeenCalled();
  });
});
