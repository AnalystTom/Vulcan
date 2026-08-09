// FILE: HerdrTerminalPane.tsx
// Purpose: The Herdr Terminal Pane Mode -- a durable Herdr session when Herdr is
// usable, and an explicit, actionable unavailable state when it is not.
// Layer: Workspace UI
//
// The product rule this file exists to enforce: Vulcan must never present a
// built-in terminal as if it were Herdr. So the unavailable state is a real
// surface with the reason and the remedy, and the fallback is an explicit choice
// the operator makes -- after which the pane says "built-in terminal (Herdr
// unavailable)" and records a fallbackTerminalId rather than a Herdr session
// name.

import type { HerdrStatus, HerdrUnavailableReason, WorkspacePane } from "@vulcan/contracts";
import { readPaneAttachment } from "@vulcan/shared/workspaceLayout";
import { IconAlertTriangle, IconRefresh, IconTerminal2 } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { ensureNativeApi } from "~/nativeApi";

import { WorkspaceTerminalSurface } from "./WorkspaceTerminalSurface";

/** What the operator should do about each reason, in their own terms. */
const REMEDY: Record<HerdrUnavailableReason, string> = {
  "binary-missing": "Install Herdr, then retry.",
  "status-unreadable":
    "Herdr is installed but did not answer. Check it from a terminal, then retry.",
  "protocol-too-old": "Update Herdr with `herdr update`, then retry.",
  "server-not-running": "Start Herdr by running `herdr` in a terminal, then retry.",
  "server-incompatible": "Restart the Herdr server so it matches the installed client, then retry.",
};

export interface HerdrTerminalPaneProps {
  readonly pane: WorkspacePane;
  readonly cwd: string;
  readonly isVisible: boolean;
  /** Records the durable Herdr session this pane is bound to. */
  readonly onAttachSession: (sessionName: string) => void;
  /** Records that the operator accepted the built-in terminal instead. */
  readonly onAcceptFallback: (terminalId: string) => void;
}

export function HerdrTerminalPane({
  pane,
  cwd,
  isVisible,
  onAttachSession,
  onAcceptFallback,
}: HerdrTerminalPaneProps) {
  const attachment = useMemo(() => readPaneAttachment(pane, "herdrTerminal"), [pane]);
  const [status, setStatus] = useState<HerdrStatus | null>(null);
  const [probing, setProbing] = useState(false);
  // A terminal has to start somewhere. Without a working directory the server
  // rejects the open, and a blank pane would look like Herdr had failed -- so the
  // missing prerequisite is named instead.
  const hasWorkingDirectory = cwd.trim().length > 0;

  const probe = useCallback(async (refresh: boolean) => {
    setProbing(true);
    try {
      setStatus(await ensureNativeApi().herdr.status({ refresh }));
    } catch {
      // A failed probe is itself an unavailable state; render it as one rather
      // than leaving the pane blank.
      setStatus({
        availability: {
          status: "unavailable",
          reason: "status-unreadable",
          detail: "Vulcan could not reach the server to check Herdr.",
          binaryPath: null,
          protocol: null,
        },
        sessions: [],
        checkedAt: new Date().toISOString(),
      });
    } finally {
      setProbing(false);
    }
  }, []);

  // A pane already running a fallback terminal must not keep probing Herdr; the
  // operator made that choice and re-probing would churn for no reason.
  const usingFallback = attachment?.fallbackTerminalId != null;
  useEffect(() => {
    if (usingFallback || !hasWorkingDirectory) return;
    void probe(false);
  }, [probe, usingFallback, hasWorkingDirectory]);

  if (!hasWorkingDirectory) {
    return (
      <div className="flex h-full w-full flex-col items-start justify-center gap-2 p-6 text-sm">
        <div className="font-medium">This workspace has no working directory</div>
        <p className="text-muted-foreground max-w-prose">
          A terminal needs somewhere to start. Open this workspace from a project so its panes
          inherit the repository checkout or worktree.
        </p>
      </div>
    );
  }

  if (usingFallback && attachment?.fallbackTerminalId) {
    return (
      <WorkspaceTerminalSurface
        // Scoped by pane so two panes never share one xterm instance.
        sessionKey={`${pane.paneId}:fallback`}
        terminalId={attachment.fallbackTerminalId}
        cwd={cwd}
        launch={{ kind: "shell" }}
        isVisible={isVisible}
      />
    );
  }

  if (status?.availability.status === "available") {
    const sessionName = attachment?.sessionName ?? defaultSessionName(pane);
    if (attachment?.sessionName !== sessionName) {
      // Bind the pane to a concrete session name so a restart reattaches to the
      // same durable terminal rather than creating a new one each time.
      onAttachSession(sessionName);
    }
    return (
      <WorkspaceTerminalSurface
        sessionKey={`${pane.paneId}:herdr`}
        terminalId={`herdr-${sessionName}`}
        cwd={cwd}
        launch={{ kind: "herdr", sessionName }}
        isVisible={isVisible}
      />
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-start justify-center gap-3 p-6 text-sm">
      {status === null ? (
        <p className="text-muted-foreground">Checking whether Herdr is available…</p>
      ) : (
        <>
          <div className="flex items-center gap-2 font-medium">
            <IconAlertTriangle className="size-4 text-amber-500" aria-hidden />
            Herdr is unavailable
          </div>
          <p className="text-muted-foreground max-w-prose">
            {status.availability.status === "unavailable"
              ? status.availability.detail
              : "Herdr did not report a usable state."}
          </p>
          {status.availability.status === "unavailable" ? (
            <p className="text-muted-foreground max-w-prose">
              {REMEDY[status.availability.reason]}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" variant="outline" disabled={probing} onClick={() => void probe(true)}>
              <IconRefresh className="size-4" aria-hidden />
              {probing ? "Checking…" : "Retry"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onAcceptFallback(`fallback-${pane.paneId}`)}
            >
              <IconTerminal2 className="size-4" aria-hidden />
              Use the built-in terminal instead
            </Button>
          </div>
          <p className="text-muted-foreground max-w-prose text-xs">
            The built-in terminal is not durable and is not Herdr. This pane will say so, and the
            choice is recorded as a fallback.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * A stable per-Pane Herdr session name.
 *
 * Derived from the Pane id so the same Pane reattaches to the same durable
 * session across restarts, and two Panes never collide on one session.
 */
function defaultSessionName(pane: WorkspacePane): string {
  return `vulcan-${pane.paneId}`.slice(0, 64);
}
