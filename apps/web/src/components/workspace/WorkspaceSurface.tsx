// FILE: WorkspaceSurface.tsx
// Purpose: A Workspace's complete pane experience -- loading the layout, choosing
// what each Pane Mode renders, and providing keyboard equivalents for every drag
// interaction.
// Layer: Workspace UI

import {
  type PaneDropZone,
  type PaneId,
  type PaneMode,
  type PaneRowId,
  type PaneSplitDirection,
  type ProjectId,
  type ThreadId,
  type WorkspaceId,
  type WorkspacePane,
  WORKSPACE_LAYOUT_MAX_PANES,
} from "@vulcan/contracts";
import {
  countPanes,
  findPaneInDirection,
  readPaneAttachment,
} from "@vulcan/shared/workspaceLayout";
import { IconPlus } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo } from "react";

import { Button } from "~/components/ui/button";
import {
  describePaneLayoutRejection,
  selectWorkspaceLayout,
  useWorkspaceLayoutStore,
} from "~/workspaceLayoutStore";

import { FactoryTracePane } from "./FactoryTracePane";
import { TapesTracePane } from "./TapesTracePane";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { ensureNativeApi } from "~/nativeApi";

import { HerdrTerminalPane } from "./HerdrTerminalPane";
import { describePaneMode } from "./paneModeRegistry";
import { WorkspaceGrid } from "./WorkspaceGrid";
import { WorkspacePaneSwitcher } from "./WorkspacePaneSwitcher";

export interface WorkspaceSurfaceProps {
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  /** Working directory terminals open in. */
  readonly cwd: string;
  /**
   * Renders the native agent surface for a Pane. Injected so this component does
   * not depend on the (very large) chat module graph, and so tests can drive the
   * grid without mounting a real Agent Session.
   */
  readonly renderAgentPane: (
    pane: WorkspacePane,
    context: { isFocused: boolean },
  ) => React.ReactNode;
}

export function WorkspaceSurface({
  workspaceId,
  projectId,
  threadId,
  cwd,
  renderAgentPane,
}: WorkspaceSurfaceProps) {
  const entry = useWorkspaceLayoutStore(
    useMemo(() => selectWorkspaceLayout(workspaceId), [workspaceId]),
  );
  const store = useWorkspaceLayoutStore();
  const isNarrow = useIsMobile();

  useEffect(() => {
    void store.open({ workspaceId, projectId, threadId });
  }, [store, workspaceId, projectId, threadId]);

  const layout = entry?.layout ?? null;
  const focusedPaneId = layout?.focusedPaneId ?? null;

  /**
   * Keyboard equivalents for every drag interaction, so the grid is operable
   * without a pointer. Scoped to Alt so they cannot shadow a terminal's own keys.
   */
  useEffect(() => {
    if (!layout) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const paneId = layout.focusedPaneId;

      if (event.key === "n" || event.key === "N") {
        event.preventDefault();
        void store.addPane(workspaceId, "agent");
        return;
      }
      if (!paneId) return;

      const directions: Record<string, "left" | "right" | "up" | "down"> = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down",
      };
      const direction = directions[event.key];
      if (direction) {
        event.preventDefault();
        if (event.shiftKey) {
          // Shift moves the pane itself; the plain arrow moves focus.
          const target = findPaneInDirection(layout, paneId, direction);
          if (target) {
            void store.movePane(workspaceId, paneId, target, "center");
          }
          return;
        }
        const next = findPaneInDirection(layout, paneId, direction);
        if (next) void store.focusPane(workspaceId, next);
        return;
      }

      if (event.key === "\\") {
        event.preventDefault();
        void store.splitPane(workspaceId, paneId, event.shiftKey ? "below" : "right", "agent");
        return;
      }
      if (event.key === "w" || event.key === "W") {
        event.preventDefault();
        void store.removePane(workspaceId, paneId);
        return;
      }
      if (event.key === "p" || event.key === "P") {
        event.preventDefault();
        const pane = layout.panes.find((candidate) => candidate.paneId === paneId);
        if (pane) void store.setPanePinned(workspaceId, paneId, !pane.pinned);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [layout, store, workspaceId]);

  const renderPane = useCallback(
    (pane: WorkspacePane, context: { isFocused: boolean }) => {
      switch (pane.mode) {
        case "agent":
          return renderAgentPane(pane, context);
        case "herdrTerminal":
          return (
            <HerdrTerminalPane
              pane={pane}
              cwd={cwd}
              isVisible
              onAttachSession={(sessionName) =>
                void store.setPaneAttachment(workspaceId, pane.paneId, {
                  mode: "herdrTerminal",
                  sessionName,
                  fallbackTerminalId: null,
                })
              }
              onAcceptFallback={(terminalId) =>
                void store.setPaneAttachment(workspaceId, pane.paneId, {
                  mode: "herdrTerminal",
                  // Recorded as a fallback, never as a Herdr session.
                  sessionName: null,
                  fallbackTerminalId: terminalId,
                })
              }
            />
          );
        case "factory":
          return <FactoryTracePane isVisible threadId={threadId} />;
        case "trace":
          return <TapesTracePane isVisible />;
        default: {
          const descriptor = describePaneMode(pane.mode);
          return (
            <div className="flex h-full w-full flex-col items-start justify-center gap-2 p-6 text-sm">
              <div className="font-medium">{descriptor.label} panes are not available yet</div>
              <p className="text-muted-foreground max-w-prose">{descriptor.description}</p>
              <p className="text-muted-foreground max-w-prose text-xs">
                This mode is declared so the layout, persistence, and automation share one taxonomy.
                It renders nothing until it is implemented.
              </p>
            </div>
          );
        }
      }
    },
    [cwd, renderAgentPane, store, workspaceId],
  );

  /**
   * Ends the session a Pane owns.
   *
   * Only a terminal qualifies: the Pane created it, so the Pane can end it. An
   * Agent Pane is a view onto a thread that exists independently of any layout,
   * so it returns null and the control is not offered -- closing that Pane
   * already leaves the session running, which is the guarantee.
   */
  const resolveTerminateSession = useCallback(
    (pane: WorkspacePane) => {
      if (pane.mode !== "herdrTerminal") return null;
      const attachment = readPaneAttachment(pane, "herdrTerminal");
      const terminalId = attachment?.fallbackTerminalId ?? attachment?.sessionName ?? null;
      if (terminalId === null) return null;

      return () => {
        void (async () => {
          const api = ensureNativeApi();
          // Confirmed explicitly, because this is the one Pane control that
          // destroys work rather than rearranging it.
          const confirmed = await api.dialogs.confirm(
            `Terminate the terminal session in this pane? This ends the process. Closing the pane instead leaves it running.`,
          );
          if (!confirmed) return;

          const scopeKey = `${pane.paneId}:${attachment?.fallbackTerminalId ? "fallback" : "herdr"}`;
          const resolvedId = attachment?.fallbackTerminalId ?? `herdr-${attachment?.sessionName}`;
          const { disposeAndCloseTerminalSession } = await import("../terminal/terminalSession");
          disposeAndCloseTerminalSession({
            api,
            threadId: scopeKey,
            terminalId: resolvedId,
          });
          // The attachment is cleared so the Pane does not reattach to a session
          // that no longer exists.
          await store.setPaneAttachment(workspaceId, pane.paneId, {
            mode: "herdrTerminal",
            sessionName: null,
            fallbackTerminalId: null,
          });
        })();
      };
    },
    [store, workspaceId],
  );

  const describePaneStatus = useCallback((pane: WorkspacePane) => {
    if (pane.mode !== "herdrTerminal") return { label: null, needsAttention: false };
    const attachment = readPaneAttachment(pane, "herdrTerminal");
    if (attachment?.fallbackTerminalId) {
      // Naming the fallback in the header is the whole point: the operator must
      // never mistake it for a durable Herdr session.
      return { label: "built-in terminal (Herdr unavailable)", needsAttention: true };
    }
    if (attachment?.sessionName) return { label: attachment.sessionName, needsAttention: false };
    return { label: null, needsAttention: false };
  }, []);

  if (!entry || !layout) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground text-sm">
        Loading workspace…
      </div>
    );
  }

  const paneCount = countPanes(layout);

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={paneCount >= WORKSPACE_LAYOUT_MAX_PANES}
          onClick={() => void store.addPane(workspaceId, "agent")}
        >
          <IconPlus className="size-4" aria-hidden />
          Add pane
        </Button>
        <span className="text-muted-foreground text-xs">
          {paneCount} of {WORKSPACE_LAYOUT_MAX_PANES} panes
        </span>
        {entry.lastRejection ? (
          <span className="text-xs text-amber-600 dark:text-amber-400" role="status">
            {describePaneLayoutRejection(entry.lastRejection)}
          </span>
        ) : null}
        {entry.errorMessage ? (
          <span className="text-muted-foreground text-xs" role="status">
            {entry.errorMessage}
          </span>
        ) : null}
      </div>

      <div className="min-h-0 min-w-0 flex-1">
        {isNarrow ? (
          // Presentation only -- the stored 3x3 layout is untouched, so the
          // desktop arrangement is still there when the same Workspace is
          // opened on a larger screen.
          <WorkspacePaneSwitcher
            layout={layout}
            renderPane={renderPane}
            onFocusPane={(paneId: PaneId) => void store.focusPane(workspaceId, paneId)}
          />
        ) : (
          <WorkspaceGrid
            layout={layout}
            renderPane={renderPane}
            describePaneStatus={describePaneStatus}
            onFocusPane={(paneId: PaneId) => void store.focusPane(workspaceId, paneId)}
            onSelectMode={(paneId: PaneId, mode: PaneMode) =>
              void store.setPaneMode(workspaceId, paneId, mode)
            }
            onSplitPane={(paneId: PaneId, direction: PaneSplitDirection) =>
              void store.splitPane(workspaceId, paneId, direction, "agent")
            }
            onTogglePinned={(paneId: PaneId) => {
              const pane = layout.panes.find((candidate) => candidate.paneId === paneId);
              if (pane) void store.setPanePinned(workspaceId, paneId, !pane.pinned);
            }}
            onClosePane={(paneId: PaneId) => void store.removePane(workspaceId, paneId)}
            onMovePane={(paneId: PaneId, targetPaneId: PaneId, zone: PaneDropZone) =>
              void store.movePane(workspaceId, paneId, targetPaneId, zone)
            }
            onSetRowHeights={(weights: readonly number[]) =>
              void store.setRowHeights(workspaceId, weights)
            }
            onSetCellWidths={(rowId: PaneRowId, weights: readonly number[]) =>
              void store.setCellWidths(workspaceId, rowId, weights)
            }
            resolveTerminateSession={resolveTerminateSession}
          />
        )}
      </div>
      {focusedPaneId ? null : null}
    </div>
  );
}
