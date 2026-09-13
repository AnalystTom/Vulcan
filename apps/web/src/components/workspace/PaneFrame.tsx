// FILE: PaneFrame.tsx
// Purpose: The chrome around a Pane -- its header, mode picker, pin, split, and
// close controls -- plus the drop overlay used when another Pane is dragged onto
// it.
// Layer: Workspace UI
//
// The header is deliberately identity-first. A grid of nine surfaces is only
// usable if each one says what it is: which mode, which session, which provider,
// what state. Everything here is keyboard reachable, because drag-and-drop must
// never be the only way to rearrange a Workspace.

import type { PaneDropZone, PaneMode, PaneSplitDirection, WorkspacePane } from "@vulcan/contracts";
import {
  IconLayoutColumns,
  IconLayoutRows,
  IconPin,
  IconPinnedOff,
  IconPlugConnectedX,
  IconX,
} from "@tabler/icons-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { describePaneMode, SELECTABLE_PANE_MODES } from "./paneModeRegistry";

/** Which edge of a pane a pointer is over, or its centre. */
export function resolveDropZone(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): PaneDropZone {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  // A generous centre keeps "swap" easy to hit; the edge bands are what make
  // insertion possible without a modifier key.
  const edge = 0.28;
  const fromLeft = x;
  const fromRight = 1 - x;
  const fromTop = y;
  const fromBottom = 1 - y;
  const nearest = Math.min(fromLeft, fromRight, fromTop, fromBottom);
  if (nearest > edge) return "center";
  if (nearest === fromLeft) return "left";
  if (nearest === fromRight) return "right";
  if (nearest === fromTop) return "above";
  return "below";
}

const DROP_ZONE_CLASS: Record<PaneDropZone, string> = {
  left: "left-0 top-0 h-full w-1/2",
  right: "right-0 top-0 h-full w-1/2",
  above: "left-0 top-0 w-full h-1/2",
  below: "left-0 bottom-0 w-full h-1/2",
  center: "inset-0",
};

export interface PaneFrameProps {
  readonly pane: WorkspacePane;
  readonly isFocused: boolean;
  /** Short status line for the header, e.g. the provider or session state. */
  readonly statusLabel?: string | null;
  /** True when this pane needs the operator, which the header must make obvious. */
  readonly needsAttention?: boolean;
  readonly canClose: boolean;
  /**
   * Ends the session this Pane owns, when it owns one.
   *
   * Null when the Pane only *references* a session -- an Agent Pane is a view
   * onto a thread that exists independently of any Pane, so offering to
   * terminate it from a layout control would be a surprising amount of power for
   * a view to have. A terminal is different: the Pane created it, so the Pane can
   * end it.
   */
  readonly onTerminateSession: (() => void) | null;
  readonly onFocus: () => void;
  readonly onSelectMode: (mode: PaneMode) => void;
  readonly onSplit: (direction: PaneSplitDirection) => void;
  readonly onTogglePinned: () => void;
  readonly onClose: () => void;
  readonly onDropPane: (draggedPaneId: string, zone: PaneDropZone) => void;
  readonly children: ReactNode;
}

export function PaneFrame({
  pane,
  isFocused,
  statusLabel,
  needsAttention,
  canClose,
  onTerminateSession,
  onFocus,
  onSelectMode,
  onSplit,
  onTogglePinned,
  onClose,
  onDropPane,
  children,
}: PaneFrameProps) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [dropZone, setDropZone] = useState<PaneDropZone | null>(null);
  const descriptor = useMemo(() => describePaneMode(pane.mode), [pane.mode]);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    setDropZone(resolveDropZone(rect, event.clientX, event.clientY));
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const draggedPaneId = event.dataTransfer.getData(PANE_DRAG_MIME);
      setDropZone(null);
      if (!draggedPaneId) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onDropPane(draggedPaneId, resolveDropZone(rect, event.clientX, event.clientY));
    },
    [onDropPane],
  );

  return (
    <section
      // A pane is a landmark rather than a button: it contains focusable content,
      // so the frame itself must not swallow the keyboard.
      aria-label={`${descriptor.label} pane`}
      data-pane-id={pane.paneId}
      data-pane-mode={pane.mode}
      data-pane-focused={isFocused ? "true" : "false"}
      className={cn(
        // flex-1 rather than h-full: the wrapper is a flex column, so the frame
        // has to claim the free space or it collapses to its content height.
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-background",
        isFocused ? "border-primary/60 ring-1 ring-primary/30" : "border-border",
      )}
      onFocusCapture={onFocus}
      onPointerDownCapture={onFocus}
      onDragOver={handleDragOver}
      onDragLeave={() => setDropZone(null)}
      onDrop={handleDrop}
    >
      <header
        className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-muted/40 px-1.5"
        // The header is the drag handle, so dragging never starts from inside a
        // terminal or a transcript where a drag means selecting text.
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(PANE_DRAG_MIME, pane.paneId);
          event.dataTransfer.effectAllowed = "move";
        }}
      >
        <Menu open={modeMenuOpen} onOpenChange={setModeMenuOpen}>
          <MenuTrigger
            render={
              <button
                type="button"
                className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium hover:bg-accent"
                aria-label={`Change pane mode (currently ${descriptor.label})`}
              />
            }
          >
            <descriptor.Icon className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{descriptor.label}</span>
          </MenuTrigger>
          <ComposerPickerMenuPopup align="start" className="min-w-64">
            {SELECTABLE_PANE_MODES.map((candidate) => (
              <MenuItem
                key={candidate.mode}
                onClick={() => {
                  onSelectMode(candidate.mode);
                  setModeMenuOpen(false);
                }}
              >
                <candidate.Icon className="size-4 shrink-0" aria-hidden />
                <span className="flex min-w-0 flex-col">
                  <span>{candidate.label}</span>
                  <span className="text-muted-foreground text-xs">{candidate.description}</span>
                </span>
              </MenuItem>
            ))}
          </ComposerPickerMenuPopup>
        </Menu>

        {statusLabel ? (
          <span
            className={cn(
              "truncate text-xs",
              needsAttention ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
            )}
          >
            {statusLabel}
          </span>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <PaneIconButton
            label="Split right"
            onClick={() => onSplit("right")}
            icon={<IconLayoutColumns className="size-3.5" aria-hidden />}
          />
          <PaneIconButton
            label="Split down"
            onClick={() => onSplit("below")}
            icon={<IconLayoutRows className="size-3.5" aria-hidden />}
          />
          <PaneIconButton
            label={pane.pinned ? "Unpin pane" : "Pin pane so automation leaves it alone"}
            onClick={onTogglePinned}
            icon={
              pane.pinned ? (
                <IconPin className="size-3.5 text-primary" aria-hidden />
              ) : (
                <IconPinnedOff className="size-3.5" aria-hidden />
              )
            }
          />
          {onTerminateSession ? (
            <PaneIconButton
              label="Terminate this pane's session. This ends the process, unlike closing the pane."
              onClick={onTerminateSession}
              icon={<IconPlugConnectedX className="size-3.5" aria-hidden />}
            />
          ) : null}
          <PaneIconButton
            label="Close pane. This leaves its session running."
            disabled={!canClose}
            onClick={onClose}
            icon={<IconX className="size-3.5" aria-hidden />}
          />
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>

      {dropZone ? (
        <div className="pointer-events-none absolute inset-0 z-10">
          <div
            className={cn(
              "absolute rounded-sm border-2 border-primary bg-primary/20",
              DROP_ZONE_CLASS[dropZone],
            )}
          />
        </div>
      ) : null}
    </section>
  );
}

/** The drag payload type. Narrow so unrelated drags (files, text) never match. */
export const PANE_DRAG_MIME = "application/x-vulcan-pane-id";

function PaneIconButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
