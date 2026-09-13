import "../../index.css";

import type { TerminalEvent, TerminalSessionSnapshot } from "@vulcan/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const nativeApi = vi.hoisted(() => {
  const harness = {
    open: vi.fn(),
    restart: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn(),
    listener: null as ((event: TerminalEvent) => void) | null,
    refresh: vi.fn().mockResolvedValue([
      {
        provider: "grok",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: "2026-09-13T00:00:00.000Z",
      },
    ]),
  };
  const api = { terminal: harness };
  harness.onEvent.mockImplementation((listener: (event: TerminalEvent) => void) => {
    harness.listener = listener;
    return () => {
      if (harness.listener === listener) harness.listener = null;
    };
  });
  return Object.assign(harness, { api });
});

vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => nativeApi.api,
}));
vi.mock("../../hooks/useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => nativeApi.refresh,
}));
vi.mock("../terminal/terminalRuntimeRegistry", () => ({
  terminalRuntimeRegistry: { disposeTerminal: vi.fn() },
}));
vi.mock("../workspace/WorkspaceTerminalSurface", () => ({
  WorkspaceTerminalSurface: () => <div data-testid="grok-terminal-surface" />,
}));

import { GrokLoginControl } from "./GrokLoginControl";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function snapshot(
  status: TerminalSessionSnapshot["status"],
  exitCode: number | null = null,
): TerminalSessionSnapshot {
  return {
    threadId: "settings:grok-login",
    terminalId: "device-auth",
    cwd: "/workspace",
    status,
    pid: status === "running" ? 1234 : null,
    history: "device auth output",
    exitCode,
    exitSignal: null,
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}

function emit(event: TerminalEvent) {
  nativeApi.listener?.(event);
}

describe("GrokLoginControl lifecycle", () => {
  afterEach(() => {
    nativeApi.open.mockReset();
    nativeApi.restart.mockReset();
    nativeApi.close.mockReset().mockResolvedValue(undefined);
    nativeApi.refresh.mockReset().mockResolvedValue([
      {
        provider: "grok",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: "2026-09-13T00:00:00.000Z",
      },
    ]);
    nativeApi.listener = null;
  });

  it("closes a late-opened session when cancelled during open", async () => {
    const pending = deferred<TerminalSessionSnapshot>();
    nativeApi.open.mockReturnValueOnce(pending.promise);
    const mounted = await render(<GrokLoginControl cwd="/workspace" />);

    await page.getByRole("button", { name: "Start sign-in" }).click();
    await vi.waitFor(() => expect(nativeApi.open).toHaveBeenCalledOnce());
    await page.getByRole("button", { name: "Cancel" }).click();
    pending.resolve(snapshot("running"));

    await vi.waitFor(() => expect(nativeApi.close).toHaveBeenCalledTimes(2));
    await expect.element(page.getByText("Grok sign-in was cancelled.")).toBeVisible();
    expect(document.querySelector('[data-testid="grok-terminal-surface"]')).toBeNull();
    await mounted.unmount();
  });

  it("closes a session opened after the control unmounts", async () => {
    const pending = deferred<TerminalSessionSnapshot>();
    nativeApi.open.mockReturnValueOnce(pending.promise);
    const mounted = await render(<GrokLoginControl cwd="/workspace" />);

    await page.getByRole("button", { name: "Start sign-in" }).click();
    await vi.waitFor(() => expect(nativeApi.open).toHaveBeenCalledOnce());
    await mounted.unmount();
    pending.resolve(snapshot("running"));

    await vi.waitFor(() => expect(nativeApi.close).toHaveBeenCalledTimes(2));
  });

  it("keeps an early exit result when open resolves afterwards", async () => {
    const pending = deferred<TerminalSessionSnapshot>();
    nativeApi.open.mockReturnValueOnce(pending.promise);
    const mounted = await render(<GrokLoginControl cwd="/workspace" />);

    await page.getByRole("button", { name: "Start sign-in" }).click();
    await vi.waitFor(() => expect(nativeApi.open).toHaveBeenCalledOnce());
    emit({
      type: "exited",
      threadId: "settings:grok-login",
      terminalId: "device-auth",
      exitCode: 0,
      exitSignal: null,
      createdAt: "2026-09-13T00:00:00.000Z",
    });
    pending.resolve(snapshot("running"));

    await expect
      .element(
        page.getByText(
          "Grok reports authenticated. Choose Grok in the provider picker to start a session.",
        ),
      )
      .toBeVisible();
    expect(document.querySelector('[data-testid="grok-terminal-surface"]')).toBeNull();
    expect(nativeApi.open).toHaveBeenCalledOnce();
    await mounted.unmount();
  });

  it("only starts again after an explicit retry", async () => {
    nativeApi.open.mockResolvedValueOnce(snapshot("exited", 1));
    const mounted = await render(<GrokLoginControl cwd="/workspace" />);

    await page.getByRole("button", { name: "Start sign-in" }).click();
    await expect
      .element(
        page.getByText("Grok sign-in did not complete. Review the terminal output and retry."),
      )
      .toBeVisible();
    expect(nativeApi.open).toHaveBeenCalledOnce();

    nativeApi.restart.mockResolvedValueOnce(snapshot("running"));
    await page.getByRole("button", { name: "Retry sign-in" }).click();
    await vi.waitFor(() => expect(nativeApi.restart).toHaveBeenCalledOnce());
    expect(nativeApi.open).toHaveBeenCalledOnce();
    await expect.element(page.getByText("Grok sign-in is running.")).toBeVisible();
    await mounted.unmount();
  });

  it("does not adopt another control's fixed terminal session", async () => {
    const mounted = await render(<GrokLoginControl cwd="/workspace" />);
    emit({
      type: "started",
      threadId: "settings:grok-login",
      terminalId: "device-auth",
      snapshot: snapshot("running"),
      createdAt: "2026-09-13T00:00:00.000Z",
    });

    await expect.element(page.getByRole("button", { name: "Start sign-in" })).toBeVisible();
    expect(document.querySelector('[data-testid="grok-terminal-surface"]')).toBeNull();
    expect(nativeApi.close).not.toHaveBeenCalled();
    await mounted.unmount();
  });
});
