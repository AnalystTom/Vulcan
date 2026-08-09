// FILE: WorkspaceTerminalSurface.tsx
// Purpose: Mount one xterm instance inside a Workspace Pane, keyed so it survives
// the Pane being moved, resized, or hidden.
// Layer: Workspace UI
//
// The terminal runtime registry is a module-level singleton keyed by
// `threadId::terminalId`. Reusing it here is what makes a terminal survive layout
// changes: React can unmount and remount this component as the grid reflows, and
// the underlying PTY, scrollback, and xterm instance are untouched because the
// key never changes.
//
// The registry is imported lazily. xterm and its addons are ~223 KB gzipped, and
// a Workspace whose panes are all Agent Mode must not pay for them.

import type { TerminalLaunch } from "@vulcan/contracts";
import { useEffect, useRef, useState } from "react";

export interface WorkspaceTerminalSurfaceProps {
  /** Stable identity for the runtime. Must not change across re-renders. */
  readonly sessionKey: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly launch: TerminalLaunch;
  /** False while the pane is off-screen: the runtime sleeps rather than detaching. */
  readonly isVisible: boolean;
}

export function WorkspaceTerminalSurface({
  sessionKey,
  terminalId,
  cwd,
  launch,
  isVisible,
}: WorkspaceTerminalSurfaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let runtimeKey: string | null = null;

    void (async () => {
      try {
        const { terminalRuntimeRegistry, buildTerminalRuntimeKey } =
          await import("../terminal/terminalRuntimeRegistry");
        if (disposed) return;
        runtimeKey = buildTerminalRuntimeKey(sessionKey, terminalId);
        terminalRuntimeRegistry.attach(
          {
            runtimeKey,
            threadId: sessionKey,
            terminalId,
            terminalLabel: terminalId,
            cwd,
            launch,
            callbacks: {
              onSessionExited: () => {},
              onTerminalMetadataChange: () => {},
              onTerminalActivityChange: () => {},
            },
          },
          { autoFocus: false, isVisible },
          container,
        );
      } catch (cause) {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : "Failed to start this terminal.");
        }
      }
    })();

    return () => {
      disposed = true;
      if (!runtimeKey) return;
      // Detach, never dispose. Removing a pane from the layout must not terminate
      // the session behind it -- terminating is a separate, explicit action.
      void import("../terminal/terminalRuntimeRegistry").then(({ terminalRuntimeRegistry }) => {
        if (runtimeKey) terminalRuntimeRegistry.detach(runtimeKey);
      });
    };
  }, [sessionKey, terminalId, cwd, launch, isVisible]);

  useEffect(() => {
    void import("../terminal/terminalRuntimeRegistry").then(
      ({ terminalRuntimeRegistry, buildTerminalRuntimeKey }) => {
        terminalRuntimeRegistry.setViewState(buildTerminalRuntimeKey(sessionKey, terminalId), {
          autoFocus: false,
          isVisible,
        });
      },
    );
  }, [sessionKey, terminalId, isVisible]);

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4 text-sm text-muted-foreground">
        {error}
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full min-h-0 min-w-0" />;
}
