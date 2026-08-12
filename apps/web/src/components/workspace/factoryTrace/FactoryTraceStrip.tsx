// FILE: FactoryTraceStrip.tsx
// Purpose: The one-line answer to "what was asked, and how is it going" for a
// factory session.
// Layer: Workspace UI
//
// Cost and tokens are the factory's own numbers, and the split matters: the
// headline total bills every turn, including the same context re-read on each
// one, while read/written say what actually moved. Showing only the headline
// would make a modest run look enormous.

import type { TraceSession, TraceSessionUsage } from "@vulcan/contracts";
import {
  IconClock,
  IconCoin,
  IconListCheck,
  IconArrowDown,
  IconArrowUp,
} from "@tabler/icons-react";
import { type ReactNode } from "react";

import { formatClockDuration } from "~/session-logic";
import { cn } from "~/lib/utils";

import { SESSION_STATUS_TONE } from "./traceTheme";
import { useLiveClock } from "./useLiveClock";

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

const formatCost = (value: number): string =>
  value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;

export function FactoryTraceStrip({
  session,
  usage,
  phaseProgress,
}: {
  readonly session: TraceSession;
  readonly usage: TraceSessionUsage;
  readonly phaseProgress: { readonly done: number; readonly total: number };
}) {
  const endedAtMs = session.endedAt === null ? null : Date.parse(session.endedAt);
  const nowMs = useLiveClock(endedAtMs === null);
  const startedAtMs = session.startedAt === null ? Number.NaN : Date.parse(session.startedAt);
  const elapsedMs = Number.isFinite(startedAtMs) ? (endedAtMs ?? nowMs) - startedAtMs : Number.NaN;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2">
      <span
        className="min-w-0 flex-1 truncate text-xs font-medium"
        title={session.request ?? undefined}
      >
        {session.request ?? session.adwName ?? session.adwId}
      </span>

      {session.status ? (
        <span
          className={cn(
            "shrink-0 rounded border px-1.5 py-0.5 text-[10px]",
            SESSION_STATUS_TONE[session.status],
          )}
        >
          {session.status}
        </span>
      ) : null}

      {Number.isFinite(elapsedMs) ? (
        <Stat icon={<IconClock className="size-3" aria-hidden />} title="Elapsed">
          {formatClockDuration(Math.max(elapsedMs, 0))}
        </Stat>
      ) : null}
      <Stat icon={<IconListCheck className="size-3" aria-hidden />} title="Phases succeeded">
        {phaseProgress.done}/{phaseProgress.total}
      </Stat>
      {session.totalCost !== null ? (
        <Stat icon={<IconCoin className="size-3" aria-hidden />} title="Total cost">
          {formatCost(session.totalCost)}
        </Stat>
      ) : null}
      {/* What actually moved, not what was billed. */}
      <Stat
        icon={<IconArrowDown className="size-3" aria-hidden />}
        title="Tokens read for the first time"
        mono
      >
        {COMPACT.format(usage.read)}
      </Stat>
      <Stat icon={<IconArrowUp className="size-3" aria-hidden />} title="Tokens generated" mono>
        {COMPACT.format(usage.written)}
      </Stat>
    </div>
  );
}

function Stat({
  icon,
  title,
  mono,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly mono?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground",
        mono && "font-mono",
      )}
    >
      {icon}
      {children}
    </span>
  );
}
