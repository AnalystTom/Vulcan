import "../../index.css";

import type { HermesBotEvent, NativeApi } from "@vulcan/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

const readFile = vi.hoisted(() => vi.fn());
const hermesChatState = vi.hoisted((): { runtimeSessionId: string | null; running: boolean } => ({
  runtimeSessionId: "runtime-session",
  running: false,
}));
const hermesEventListeners = vi.hoisted(() => new Set<(event: HermesBotEvent) => void>());

vi.mock("~/hooks/useHermesBots", async () => {
  const { useEffect } = await import("react");
  const actual =
    await vi.importActual<typeof import("~/hooks/useHermesBots")>("~/hooks/useHermesBots");
  return {
    ...actual,
    useHermesChat: () => ({
      data: {
        profile: "chief",
        storedSessionId: "stored-session",
        runtimeSessionId: hermesChatState.runtimeSessionId,
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
        running: hermesChatState.running,
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
    useHermesEvent: (listener: (event: HermesBotEvent) => void) => {
      useEffect(() => {
        hermesEventListeners.add(listener);
        return () => {
          hermesEventListeners.delete(listener);
        };
      }, [listener]);
    },
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
  };
});

import { HermesBotChat } from "./HermesBotConversation";

function installNativeApi(api: NativeApi): () => void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", { configurable: true, value: api });
  return () => {
    if (previousDescriptor) Object.defineProperty(window, "nativeApi", previousDescriptor);
    else Reflect.deleteProperty(window, "nativeApi");
  };
}

afterEach(async () => {
  await cleanup();
  readFile.mockReset();
  hermesEventListeners.clear();
  hermesChatState.runtimeSessionId = "runtime-session";
  hermesChatState.running = false;
});

const chiefProfile = {
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
};

function emitHermesEvent(event: HermesBotEvent): void {
  for (const listener of hermesEventListeners) listener(event);
}

function chat() {
  return <HermesBotChat profile={chiefProfile} />;
}

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
    await render(chat());

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

it("shows compaction only for the active running session and clears it on native lifecycle events", async () => {
  hermesChatState.running = true;
  const screen = await render(chat());
  await expect.element(page.getByText("Running", { exact: true })).toBeVisible();

  emitHermesEvent({
    type: "status.update",
    payload: { session_id: "runtime-other", kind: "compacting", text: "Compacting" },
  });
  await expect.element(page.getByText("Running", { exact: true })).toBeVisible();

  emitHermesEvent({
    type: "status.update",
    payload: { session_id: "runtime-session", kind: "compacting", text: "Compacting" },
  });
  await expect.element(page.getByText("Summarizing history", { exact: true })).toBeVisible();

  emitHermesEvent({
    type: "session.resume_progress",
    payload: { session_id: "runtime-session", phase: "history" },
  });
  await expect.element(page.getByText("Running", { exact: true })).toBeVisible();

  emitHermesEvent({
    type: "status.update",
    payload: { session_id: "runtime-session", kind: "compacting", text: "Compacting" },
  });
  emitHermesEvent({
    type: "message.delta",
    payload: { session_id: "runtime-session", text: "resumed" },
  });
  await expect.element(page.getByText("Running", { exact: true })).toBeVisible();

  emitHermesEvent({
    type: "status.update",
    payload: { session_id: "runtime-session", kind: "compacting", text: "Compacting" },
  });
  emitHermesEvent({ type: "disconnect", payload: {} });
  await expect.element(page.getByText("Running", { exact: true })).toBeVisible();

  emitHermesEvent({
    type: "status.update",
    payload: { kind: "compacting", text: "Compacting" },
  });
  await expect.element(page.getByText("Running", { exact: true })).toBeVisible();

  emitHermesEvent({
    type: "status.update",
    payload: { session_id: "runtime-session", kind: "compacting" },
  });
  await expect.element(page.getByText("Summarizing history", { exact: true })).toBeVisible();
  hermesChatState.runtimeSessionId = "runtime-new";
  await screen.rerender(chat());
  await expect.element(page.getByText("Running", { exact: true })).toBeVisible();

  emitHermesEvent({
    type: "status.update",
    payload: { session_id: "runtime-new", kind: "compacting", text: "Compacting" },
  });
  await expect.element(page.getByText("Summarizing history", { exact: true })).toBeVisible();

  hermesChatState.running = false;
  await screen.rerender(chat());
  await expect
    .element(page.getByText("Summarizing history", { exact: true }))
    .not.toBeInTheDocument();
  hermesChatState.runtimeSessionId = null;
  hermesChatState.running = true;
  await screen.rerender(chat());
  emitHermesEvent({ type: "status.update", payload: { kind: "compacting" } });
  await expect.element(page.getByText("Running", { exact: true })).toBeVisible();
});
