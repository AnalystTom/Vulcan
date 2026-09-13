// FILE: _chat.workspace.$workspaceId.tsx
// Purpose: Registers a Workspace's Pane grid under the shared chat shell.
// Layer: Route
// Exports: Route

import {
  WS_STREAM_LIMITS,
  type ProjectId,
  type ThreadId,
  type WorkspaceId,
} from "@vulcan/contracts";
import { resolveThreadWorkspaceCwd } from "@vulcan/shared/threadEnvironment";
import { readPaneAttachment } from "@vulcan/shared/workspaceLayout";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import {
  DeferredChatView,
  noopChatSurfaceAction,
} from "~/components/chat/ChatThreadSurfacePrimitives";
import { WorkspaceSurface } from "~/components/workspace/WorkspaceSurface";
import { useStore } from "~/store";
import { createProjectSelector, createThreadSelector } from "~/storeSelectors";
import { resolveWorkspaceThreadIds, useWorkspaceLayoutStore } from "~/workspaceLayoutStore";

export const Route = createFileRoute("/_chat/workspace/$workspaceId")({
  component: WorkspaceRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    projectId: typeof search.projectId === "string" ? (search.projectId as ProjectId) : undefined,
    threadId: typeof search.threadId === "string" ? (search.threadId as ThreadId) : undefined,
  }),
});

function WorkspaceRoute() {
  const { workspaceId } = Route.useParams();
  const { projectId, threadId } = Route.useSearch();
  const project = useStore(useMemo(() => createProjectSelector(projectId ?? null), [projectId]));
  const thread = useStore(useMemo(() => createThreadSelector(threadId ?? null), [threadId]));
  const layout = useWorkspaceLayoutStore((store) => store.entries[workspaceId]?.layout ?? null);
  const streamingThreadIds = resolveWorkspaceThreadIds(layout, threadId ?? null).slice(
    0,
    WS_STREAM_LIMITS.threadPerClient,
  );
  const cwd = resolveThreadWorkspaceCwd({
    projectCwd: project?.cwd ?? null,
    envMode: thread?.envMode,
    worktreePath: thread?.worktreePath,
    workingDirectory: thread?.workingDirectory,
  });

  return (
    <WorkspaceSurface
      workspaceId={workspaceId as WorkspaceId}
      projectId={projectId ?? null}
      threadId={threadId ?? null}
      cwd={cwd ?? ""}
      renderAgentPane={(pane, context) => {
        // Each Agent Pane hosts the native thread surface. `paneScopeId` keys the
        // ChatView instance, so moving a pane in the grid re-parents the DOM
        // without recreating the conversation.
        const paneThreadId = readPaneAttachment(pane, "agent")?.threadId ?? null;
        const resolvedThreadId = paneThreadId ?? threadId ?? null;
        if (!resolvedThreadId) {
          return (
            <div className="flex h-full w-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
              This pane has no agent session yet. Open a thread to attach one.
            </div>
          );
        }
        if (!streamingThreadIds.includes(resolvedThreadId)) {
          return (
            <button
              type="button"
              className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground"
              onClick={() =>
                void useWorkspaceLayoutStore
                  .getState()
                  .focusPane(workspaceId as WorkspaceId, pane.paneId)
              }
            >
              Focus this pane to load its conversation. Up to {WS_STREAM_LIMITS.threadPerClient}{" "}
              coding chats stream at once.
            </button>
          );
        }
        return (
          <DeferredChatView
            threadId={resolvedThreadId}
            paneScopeId={`workspace:${workspaceId}:${pane.paneId}`}
            deferMount={false}
            surfaceMode="split"
            isFocusedPane={context.isFocused}
            // The Workspace grid owns layout, so the chat surface's own
            // browser/diff side panels stay closed here: a Pane Mode is how a
            // Workspace shows those, not a panel nested inside another pane.
            panelState={{
              panel: null,
              diffTurnId: null,
              diffFilePath: null,
              hasOpenedPanel: false,
              lastOpenPanel: "diff",
            }}
            onToggleDiff={noopChatSurfaceAction}
            onToggleBrowser={noopChatSurfaceAction}
            onOpenBrowserUrl={noopChatSurfaceAction}
            onOpenTurnDiff={noopChatSurfaceAction}
          />
        );
      }}
    />
  );
}
