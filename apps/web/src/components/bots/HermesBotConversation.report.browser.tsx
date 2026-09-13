import "../../index.css";

import type { NativeApi } from "@vulcan/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const readFile = vi.hoisted(() => vi.fn());

vi.mock("~/hooks/useHermesBots", () => ({
  useHermesChat: () => ({
    data: {
      profile: "chief",
      storedSessionId: "stored-session",
      runtimeSessionId: "runtime-session",
      messages: [
        {
          index: 0,
          role: "assistant",
          text: "The report is [available here](/home/russki/launchpost-original-seo-20260913-G.md).",
          timestampIso: null,
          rowId: "row-1",
          displayKind: null,
          toolName: null,
          toolContext: null,
        },
      ],
      running: false,
      status: "ready",
      failure: null,
      pendingApproval: null,
      pendingClarify: null,
      loadedAtIso: "2026-09-13T00:00:00.000Z",
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useHermesChatMutations: () => ({
    submit: { isPending: false, mutateAsync: vi.fn() },
    interrupt: { isPending: false, mutate: vi.fn() },
    respondApproval: { isPending: false, mutate: vi.fn() },
    respondClarify: { isPending: false, mutate: vi.fn() },
  }),
  useHermesRoomLog: () => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() }),
  useHermesRoomMutations: () => ({
    send: { isPending: false, mutateAsync: vi.fn() },
    stop: { isPending: false, mutate: vi.fn() },
    retry: { isPending: false, mutate: vi.fn() },
    approve: { isPending: false, mutate: vi.fn() },
    rename: { isPending: false, mutateAsync: vi.fn() },
  }),
  useHermesRoomState: () => ({ data: undefined, error: null, refetch: vi.fn() }),
  useHermesProfileAvatar: () => ({ data: null }),
}));

import { HermesBotChat } from "./HermesBotConversation";

function installNativeApi(api: NativeApi): () => void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", { configurable: true, value: api });
  return () => {
    if (previousDescriptor) Object.defineProperty(window, "nativeApi", previousDescriptor);
    else Reflect.deleteProperty(window, "nativeApi");
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  readFile.mockReset();
});

it("opens a fetched Hermes report in the dedicated viewer", async () => {
  readFile.mockResolvedValue({
    name: "launchpost-original-seo-20260913-G.md",
    path: "/home/russki/launchpost-original-seo-20260913-G.md",
    size: 31,
    mimeType: "text/markdown",
    contents: "# Verified report\n\nFetched from Hermes.",
  });
  const restoreNativeApi = installNativeApi({ hermesBots: { readFile } } as unknown as NativeApi);
  try {
    await render(
      <HermesBotChat
        profile={{
          name: "chief",
          title: "Chief",
          displayName: "Chief",
          description: "",
          hidden: false,
          isDefault: false,
          provider: null,
          skillCount: 0,
          hasAvatar: false,
          canonical: null,
          lastSession: null,
          workerLastActiveIso: null,
          model: null,
          uiMetaRevision: null,
        }}
      />,
    );

    await page.getByRole("link", { name: "available here" }).click();
    await vi.waitFor(() =>
      expect(readFile).toHaveBeenCalledWith({
        path: "/home/russki/launchpost-original-seo-20260913-G.md",
      }),
    );
    await expect.element(page.getByText("Hermes report", { exact: true })).toBeVisible();
    await expect
      .element(page.getByTestId("hermes-report-viewer"))
      .toHaveTextContent("Verified report");
    await expect
      .element(page.getByTestId("hermes-report-viewer"))
      .toHaveTextContent("Fetched from Hermes.");
  } finally {
    restoreNativeApi();
  }
});
