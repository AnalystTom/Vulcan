// FILE: ActiveAgentPanel.tsx
// Purpose: Compact sidebar panel showing all currently active top-level agents.
// Layer: Sidebar UI component
// Exports: ActiveAgentPanel

import { useMemo, type ReactNode } from "react";

import type { ProjectId, ThreadId } from "@vulcan/contracts";
import { resolveThreadEnvironmentMode } from "@vulcan/shared/threadEnvironment";

import { BotIcon, GitBranchIcon, WorktreeIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
} from "../sidebarRowStyles";
import type { Project, SidebarThreadSummary } from "../types";
import {
  activeAgentAriaLabel,
  activeAgentStatusLabel,
  buildActiveAgentViewModel,
} from "./ActiveAgentPanel.logic";
import { FolderClosed } from "./FolderClosed";
import { ProviderIcon } from "./ProviderIcon";
import { createSidebarThreadHoverAnchorId, resolveThreadDisplayBranch } from "./Sidebar.logic";
import { sidebarGlyphClass } from "./sidebarGlyphs";
import { SIDEBAR_HOVER_CARD_TRIGGER_PROPS } from "./sidebarHoverCardStyles";
import { Tooltip, TooltipTrigger } from "./ui/tooltip";

export function ActiveAgentPanel({
  threads,
  projectById,
  activeThreadId,
  threadsHydrated,
  onOpenThread,
  renderThreadHoverCard,
}: {
  threads: readonly SidebarThreadSummary[];
  projectById: ReadonlyMap<ProjectId, Project>;
  activeThreadId: ThreadId | null;
  threadsHydrated: boolean;
  onOpenThread: (threadId: ThreadId) => void;
  renderThreadHoverCard: (thread: SidebarThreadSummary, anchorId: string) => ReactNode;
}) {
  const agents = useMemo(
    () => buildActiveAgentViewModel({ threads, projectById }),
    [projectById, threads],
  );

  return (
    <section aria-label={activeAgentAriaLabel(agents.length)} className="pb-2">
      <div className="mb-1.5 flex items-center gap-1.5 px-2">
        <BotIcon className={sidebarGlyphClass("meta", "text-muted-foreground/70")} aria-hidden />
        <span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>Active agents</span>
        <span className="ml-auto rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] leading-none tabular-nums text-muted-foreground/78">
          {agents.length}
        </span>
      </div>

      {agents.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {agents.map((agent) => {
            const thread = agent.thread;
            const provider = thread.session?.provider ?? thread.modelSelection.provider;
            const branch = resolveThreadDisplayBranch(thread);
            const isActive = activeThreadId === thread.id;
            const isWorktree =
              resolveThreadEnvironmentMode({
                envMode: thread.envMode,
                worktreePath: thread.worktreePath,
              }) === "worktree";
            const ProjectGlyph = isWorktree ? WorktreeIcon : FolderClosed;
            const hoverAnchorId = createSidebarThreadHoverAnchorId({
              scope: "activity",
              threadId: thread.id,
            });
            const statusLabel = activeAgentStatusLabel({
              state: agent.state,
              session: thread.session,
            });

            return (
              <Tooltip key={thread.id}>
                <TooltipTrigger
                  {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
                  render={
                    <div
                      data-thread-hover-anchor={hoverAnchorId}
                      className="group/active-agent-row relative"
                      data-thread-item
                    />
                  }
                >
                  <button
                    type="button"
                    onClick={() => onOpenThread(thread.id)}
                    data-testid={`active-agent-${thread.id}`}
                    className={cn(
                      "flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-lg px-2.5 py-2 text-left select-none",
                      SIDEBAR_ROW_FOCUS_CLASS_NAME,
                      isActive ? SIDEBAR_ROW_ACTIVE_CLASS_NAME : SIDEBAR_ROW_HOVER_CLASS_NAME,
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                      <ProviderIcon
                        provider={provider}
                        className="size-3 shrink-0"
                        fallback={
                          <span className="size-3 shrink-0 rounded-full border border-dashed border-muted-foreground/40" />
                        }
                      />
                      <span
                        className={cn(
                          "min-w-0 shrink truncate text-[length:var(--app-font-size-ui,12px)] leading-5 font-normal",
                          isActive ? "text-foreground" : SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
                        )}
                      >
                        {thread.title}
                      </span>
                      <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[length:var(--app-font-size-ui-sm,11px)] text-sky-600 dark:text-sky-300/80">
                        <span
                          aria-hidden
                          className="size-1.5 rounded-full bg-sky-500 motion-safe:animate-pulse dark:bg-sky-300/80"
                        />
                        {statusLabel}
                      </span>
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ProjectGlyph
                        className={sidebarGlyphClass("meta", "text-muted-foreground/70")}
                        aria-hidden
                      />
                      <span className="min-w-0 truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/80">
                        {agent.projectLabel}
                      </span>
                      {branch ? (
                        <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">
                          <GitBranchIcon className={sidebarGlyphClass("meta")} aria-hidden />
                          <span className="max-w-28 truncate">{branch}</span>
                        </span>
                      ) : null}
                    </span>
                  </button>
                </TooltipTrigger>
                {renderThreadHoverCard(thread, hoverAnchorId)}
              </Tooltip>
            );
          })}
        </div>
      ) : (
        <div className="rounded-lg px-2.5 py-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/55">
          {threadsHydrated ? "No active agents" : "Loading agents..."}
        </div>
      )}
    </section>
  );
}
