import type { ServerProviderStatus, TerminalEvent } from "@vulcan/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { ensureNativeApi } from "~/nativeApi";

import { Button } from "../ui/button";
import { WorkspaceTerminalSurface } from "../workspace/WorkspaceTerminalSurface";

const GROK_LOGIN_THREAD_ID = "settings:grok-login";
const GROK_LOGIN_TERMINAL_ID = "device-auth";

type GrokLoginPhase = "idle" | "starting" | "running" | "completed" | "failed" | "cancelled";

export function grokLoginOutcomeMessage(
  phase: GrokLoginPhase,
  status: ServerProviderStatus | null | undefined,
  refreshFailed: boolean,
): string | null {
  if (phase === "cancelled") return "Grok sign-in was cancelled.";
  if (phase === "failed")
    return "Grok sign-in did not complete. Review the terminal output and retry.";
  if (phase !== "completed") return null;
  if (refreshFailed) {
    return "The Grok login command completed, but provider status could not be refreshed. Authentication is not verified.";
  }
  if (!status || status.authStatus === "unknown") {
    return "The Grok login command completed, but Grok's authentication status is still unknown. Authentication is not verified.";
  }
  if (status.authStatus === "authenticated") {
    return "Grok reports authenticated. Choose Grok in the provider picker to start a session.";
  }
  return "The Grok login command completed, but Grok still reports unauthenticated. Review the terminal output and retry.";
}

export function GrokLoginControl(props: { readonly cwd: string }) {
  const api = ensureNativeApi();
  const refreshProviderStatusesNow = useRefreshProviderStatusesNow();
  const [phase, setPhase] = useState<GrokLoginPhase>("idle");
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [exitDetail, setExitDetail] = useState<string | null>(null);
  const [refreshedStatus, setRefreshedStatus] = useState<ServerProviderStatus | null | undefined>(
    undefined,
  );
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const startedRef = useRef(false);
  const cancelledRef = useRef(false);
  const mountedRef = useRef(false);
  const lifecycleGenerationRef = useRef(0);
  const terminalResultRef = useRef<"completed" | "failed" | null>(null);
  const existingSessionRef = useRef(false);
  const ownsSessionRef = useRef(false);
  const launchErrorRef = useRef<string | null>(null);
  const refreshProviderStatusesRef = useRef(refreshProviderStatusesNow);
  refreshProviderStatusesRef.current = refreshProviderStatusesNow;

  const handleExit = useCallback(
    (exitCode: number | null, exitSignal: number | null, generation: number) => {
      if (!mountedRef.current) return;
      existingSessionRef.current = true;
      startedRef.current = false;
      if (cancelledRef.current) {
        setPhase("cancelled");
        return;
      }
      if (exitCode !== 0 || exitSignal !== null) {
        terminalResultRef.current = "failed";
        setExitDetail(
          exitCode === null
            ? `Grok sign-in exited by signal ${exitSignal ?? "unknown"}.`
            : `Grok sign-in exited with code ${exitCode}.`,
        );
        setPhase("failed");
        return;
      }

      terminalResultRef.current = "completed";
      setPhase("completed");
      void refreshProviderStatusesRef.current({ silent: true }).then((providers) => {
        if (
          !mountedRef.current ||
          lifecycleGenerationRef.current !== generation ||
          cancelledRef.current
        ) {
          return;
        }
        if (providers === null) {
          setRefreshFailed(true);
          return;
        }
        setRefreshedStatus(providers.find((provider) => provider.provider === "grok") ?? null);
      });
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = api.terminal.onEvent((event: TerminalEvent) => {
      if (event.threadId !== GROK_LOGIN_THREAD_ID || event.terminalId !== GROK_LOGIN_TERMINAL_ID) {
        return;
      }
      if (!mountedRef.current || cancelledRef.current || !ownsSessionRef.current) return;
      if (event.type === "started" || event.type === "restarted") {
        existingSessionRef.current = true;
        setTerminalVisible(true);
        startedRef.current = true;
        setPhase("running");
        return;
      }
      if (event.type === "error") {
        existingSessionRef.current = true;
        startedRef.current = false;
        terminalResultRef.current = "failed";
        launchErrorRef.current = event.message;
        setExitDetail(event.message);
        setPhase("failed");
        return;
      }
      if (event.type !== "exited") return;

      handleExit(event.exitCode, event.exitSignal, lifecycleGenerationRef.current);
    });

    return () => {
      mountedRef.current = false;
      lifecycleGenerationRef.current += 1;
      cancelledRef.current = true;
      ownsSessionRef.current = false;
      unsubscribe();
      if (startedRef.current) {
        startedRef.current = false;
        void api.terminal.close({
          threadId: GROK_LOGIN_THREAD_ID,
          terminalId: GROK_LOGIN_TERMINAL_ID,
          deleteHistory: true,
        });
      }
    };
  }, [api, handleExit]);

  const start = useCallback(async () => {
    if (busyRef.current || !props.cwd.trim()) return;
    const generation = ++lifecycleGenerationRef.current;
    const retryExistingSession =
      phase !== "idle" && phase !== "cancelled" && existingSessionRef.current;
    busyRef.current = true;
    setBusy(true);
    cancelledRef.current = false;
    ownsSessionRef.current = true;
    startedRef.current = true;
    terminalResultRef.current = null;
    launchErrorRef.current = null;
    setPhase("starting");
    setExitDetail(null);
    setRefreshedStatus(undefined);
    setRefreshFailed(false);
    try {
      // Closing a terminal removes its server session. Dispose the detached xterm
      // runtime before a retry so it can subscribe to the replacement session's
      // events and replay its fresh history.
      const { terminalRuntimeRegistry } = await import("../terminal/terminalRuntimeRegistry");
      terminalRuntimeRegistry.disposeTerminal(GROK_LOGIN_THREAD_ID, GROK_LOGIN_TERMINAL_ID);
      const isStale = () =>
        !mountedRef.current ||
        cancelledRef.current ||
        lifecycleGenerationRef.current !== generation;
      if (isStale()) return;
      const snapshot = retryExistingSession
        ? await api.terminal.restart({
            threadId: GROK_LOGIN_THREAD_ID,
            terminalId: GROK_LOGIN_TERMINAL_ID,
            cwd: props.cwd,
            cols: 110,
            rows: 24,
          })
        : await api.terminal.open({
            threadId: GROK_LOGIN_THREAD_ID,
            terminalId: GROK_LOGIN_TERMINAL_ID,
            cwd: props.cwd,
            launch: { kind: "grok-login" },
            cols: 110,
            rows: 24,
          });
      existingSessionRef.current = true;
      if (isStale()) {
        existingSessionRef.current = false;
        await api.terminal
          .close({
            threadId: GROK_LOGIN_THREAD_ID,
            terminalId: GROK_LOGIN_TERMINAL_ID,
            deleteHistory: true,
          })
          .catch(() => undefined);
        return;
      }
      if (terminalResultRef.current !== null) return;
      if (snapshot.status === "error") {
        startedRef.current = false;
        terminalResultRef.current = "failed";
        setPhase("failed");
        setExitDetail(launchErrorRef.current ?? "The configured Grok CLI could not be started.");
        return;
      }
      if (snapshot.status === "exited") {
        handleExit(snapshot.exitCode, snapshot.exitSignal, generation);
        return;
      }
      setTerminalVisible(true);
      setPhase(snapshot.status === "running" ? "running" : "starting");
    } catch (error) {
      if (
        !mountedRef.current ||
        cancelledRef.current ||
        lifecycleGenerationRef.current !== generation
      ) {
        return;
      }
      startedRef.current = false;
      terminalResultRef.current = "failed";
      setPhase("failed");
      setExitDetail(
        launchErrorRef.current ??
          (error instanceof Error
            ? error.message
            : "The configured Grok CLI could not be started."),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [api, handleExit, phase, props.cwd]);

  const cancel = useCallback(async () => {
    if (!busyRef.current && !startedRef.current) return;
    lifecycleGenerationRef.current += 1;
    cancelledRef.current = true;
    ownsSessionRef.current = false;
    startedRef.current = false;
    await api.terminal
      .close({
        threadId: GROK_LOGIN_THREAD_ID,
        terminalId: GROK_LOGIN_TERMINAL_ID,
        deleteHistory: false,
      })
      .catch(() => undefined);
    existingSessionRef.current = false;
    if (!mountedRef.current) return;
    setTerminalVisible(false);
    setPhase("cancelled");
  }, [api]);

  const outcome = grokLoginOutcomeMessage(phase, refreshedStatus, refreshFailed);
  const showTerminal = terminalVisible && phase !== "cancelled";
  const canStart = !busy && Boolean(props.cwd.trim());

  return (
    <div className="mt-3 space-y-2 rounded-md border border-border/70 bg-background/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-foreground">Sign in with Grok</div>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">
            Runs the configured Grok CLI&apos;s device sign-in on the execution host. The
            URL, code, output, and completion state stay in the terminal below.
          </p>
        </div>
        {phase === "starting" || phase === "running" ? (
          <Button type="button" size="xs" variant="outline" onClick={() => void cancel()}>
            Cancel
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!canStart}
            onClick={() => void start()}
          >
            {phase === "idle" ? "Start sign-in" : "Retry sign-in"}
          </Button>
        )}
      </div>
      {!props.cwd.trim() ? (
        <p className="text-xs text-muted-foreground">Loading Grok configuration…</p>
      ) : null}
      {phase === "starting" ? (
        <p className="text-xs text-muted-foreground">Starting Grok sign-in…</p>
      ) : phase === "running" ? (
        <p className="text-xs text-muted-foreground">Grok sign-in is running.</p>
      ) : null}
      {exitDetail ? <p className="text-xs text-destructive">{exitDetail}</p> : null}
      {outcome ? <p className="text-xs text-muted-foreground">{outcome}</p> : null}
      {showTerminal ? (
        <div className="h-56 overflow-hidden rounded border border-border/70 bg-black">
          <WorkspaceTerminalSurface
            sessionKey={GROK_LOGIN_THREAD_ID}
            terminalId={GROK_LOGIN_TERMINAL_ID}
            cwd={props.cwd}
            launch={{ kind: "grok-login" }}
            isVisible
          />
        </div>
      ) : null}
    </div>
  );
}
