// FILE: _chat.workspace.$workspaceId.tsx
// Purpose: Registers a Workspace's Pane grid under the shared chat shell.
// Layer: Route
// Exports: Route

import type { ProjectId, ThreadId, WorkspaceId } from "@vulcan/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import {
  DeferredChatView,
  noopChatSurfaceAction,
} from "~/components/chat/ChatThreadSurfacePrimitives";
import { WorkspaceSurface } from "~/components/workspace/WorkspaceSurface";
import { useStore } from "~/store";
import { createProjectSelector } from "~/storeSelectors";

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

  return (
    <WorkspaceSurface
      workspaceId={workspaceId as WorkspaceId}
      projectId={projectId ?? null}
      threadId={threadId ?? null}
      cwd={project?.cwd ?? ""}
      renderAgentPane={(pane, context) => {
        // Each Agent Pane hosts the native thread surface. `paneScopeId` keys the
        // ChatView instance, so moving a pane in the grid re-parents the DOM
        // without recreating the conversation.
        const attachment = pane.attachments.find((candidate) => candidate.mode === "agent");
        const paneThreadId = attachment && attachment.mode === "agent" ? attachment.threadId : null;
        const resolvedThreadId = paneThreadId ?? threadId ?? null;
        if (!resolvedThreadId) {
          return (
            <div className="flex h-full w-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
              This pane has no agent session yet. Open a thread to attach one.
            </div>
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
