// FILE: WorkspacePaneSwitcher.tsx
// Purpose: Present a Workspace's Panes one at a time on a narrow viewport.
// Layer: Workspace UI
//
// A 3x3 grid on a phone is nine unreadable slivers, so below the md breakpoint
// the same Panes are shown as a single surface with a switcher.
//
// The critical property is that this changes *presentation only*. It never
// writes to the layout, so the desktop arrangement an operator built is still
// there, unchanged, when they open the same Workspace on a laptop. Every Pane
// stays reachable, and the header still says what each one is.

import type { PaneId, WorkspaceLayout, WorkspacePane } from "@vulcan/contracts";
import { collectPaneIdsInVisualOrder, findPane } from "@vulcan/shared/workspaceLayout";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { type ReactNode, useMemo } from "react";

import { cn } from "~/lib/utils";

import { describePaneMode } from "./paneModeRegistry";

export interface WorkspacePaneSwitcherProps {
  readonly layout: WorkspaceLayout;
  readonly renderPane: (pane: WorkspacePane, context: { isFocused: boolean }) => ReactNode;
  /**
   * Which Pane is showing. Reuses `focusedPaneId` rather than holding separate
   * state, so switching on a phone and focusing on a laptop are the same fact
   * and survive a reload identically.
   */
  readonly onFocusPane: (paneId: PaneId) => void;
}

export function WorkspacePaneSwitcher({
  layout,
  renderPane,
  onFocusPane,
}: WorkspacePaneSwitcherProps) {
  const order = useMemo(() => collectPaneIdsInVisualOrder(layout), [layout]);
  const activeId = layout.focusedPaneId ?? order[0] ?? null;
  const activeIndex = activeId ? order.indexOf(activeId) : -1;
  const active = activeId ? findPane(layout, activeId) : null;

  if (!active || activeIndex === -1) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
        This workspace has no panes.
      </div>
    );
  }

  const step = (delta: number) => {
    const next = order[activeIndex + delta];
    if (next) onFocusPane(next);
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <nav
        aria-label="Panes"
        className="flex shrink-0 items-center gap-1 border-b border-border px-1 py-1"
      >
        <SwitchButton
          label="Previous pane"
          disabled={activeIndex === 0}
          onClick={() => step(-1)}
          icon={<IconChevronLeft className="size-4" aria-hidden />}
        />

        {/* Every pane is reachable directly, not only by stepping through. */}
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {order.map((paneId, index) => {
            const pane = findPane(layout, paneId);
            if (!pane) return null;
            const descriptor = describePaneMode(pane.mode);
            const isActive = paneId === activeId;
            return (
              <button
                key={paneId}
                type="button"
                aria-current={isActive ? "true" : undefined}
                onClick={() => onFocusPane(paneId)}
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs",
                  isActive ? "bg-accent text-foreground" : "text-muted-foreground",
                )}
              >
                <descriptor.Icon className="size-3.5" aria-hidden />
                <span>{descriptor.label}</span>
                <span className="text-muted-foreground">{index + 1}</span>
              </button>
            );
          })}
        </div>

        <SwitchButton
          label="Next pane"
          disabled={activeIndex === order.length - 1}
          onClick={() => step(1)}
          icon={<IconChevronRight className="size-4" aria-hidden />}
        />
      </nav>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* Only the active pane is mounted. Nine live surfaces on a phone would
            be unaffordable, and the layout is untouched either way. */}
        {renderPane(active, { isFocused: true })}
      </div>
    </div>
  );
}

function SwitchButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {icon}
    </button>
  );
}
