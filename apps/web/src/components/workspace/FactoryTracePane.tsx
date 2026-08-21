// FILE: FactoryTracePane.tsx
// Purpose: The Factory Pane Mode -- monitor a software factory's sessions as
// per-worker swim lanes, live, with the evidence behind any phase one click away.
// Layer: Workspace UI
//
// Vulcan watches a factory it does not run. An external ADW owns sequencing,
// retries, and acceptance, and writes its trace to SQLite beside the checkout
// while it works; this pane polls that trace and draws it. There is nothing here
// to start or cancel, which is the honest shape of a monitor.
//
// Polling rather than a push channel is the factory's own contract: readers poll
// the trace, live and history are the same query at different cadence, and the
// rowid cursor means each poll asks only for what it has not seen.

import type {
  AdwId,
  TraceEvent,
  TraceSessionDetail,
  TraceSessionSummary,
  TraceSourceStatus,
} from "@vulcan/contracts";
import { countPhaseProgress } from "@vulcan/shared/factoryTraceTimeline";
import { IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { ensureNativeApi } from "~/nativeApi";

import { FactoryPhaseDetail } from "./factoryTrace/FactoryPhaseDetail";
import { FactoryTraceLanes } from "./factoryTrace/FactoryTraceLanes";
import { FactoryTraceStrip } from "./factoryTrace/FactoryTraceStrip";

/** Their polling default is 500ms; a pane in a grid of nine settles for less. */
const REFRESH_INTERVAL_MS = 1_000;
/** Aggregate views draw many sessions at once instead of naming one. */
const ALL_AGENTS_VALUE = "__all_agents__";
const RUNNING_AGENTS_VALUE = "__running_agents__";

const isAggregateView = (value: string | null): value is string =>
  value === ALL_AGENTS_VALUE || value === RUNNING_AGENTS_VALUE;

/**
 * The sessions an aggregate view spans, in listing order.
 *
 * "Running" is the live cut an operator watching a busy workspace actually
 * wants: every agent working right now, and nothing that already finished.
 */
function aggregateAdwIds(value: string, sessions: readonly TraceSessionSummary[]): string[] {
  const included =
    value === RUNNING_AGENTS_VALUE
      ? sessions.filter((summary) => summary.session.status === "running")
      : sessions;
  return included.map((summary) => summary.session.adwId);
}

interface SelectedPhase {
  readonly adwId: string;
  readonly phaseId: string;
}

export interface FactoryTracePaneProps {
  readonly isVisible: boolean;
  /** The thread whose checkout the factory runs in. Null means nowhere to look. */
  readonly threadId: string | null;
}

export function FactoryTracePane({ isVisible, threadId }: FactoryTracePaneProps) {
  const [status, setStatus] = useState<TraceSourceStatus | null>(null);
  const [sessions, setSessions] = useState<readonly TraceSessionSummary[]>([]);
  const [selectedAdwId, setSelectedAdwId] = useState<string | null>(null);
  const [detailsByAdwId, setDetailsByAdwId] = useState<ReadonlyMap<string, TraceSessionDetail>>(
    new Map(),
  );
  const [selectedPhase, setSelectedPhase] = useState<SelectedPhase | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Events already seen, and the cursor that produced them.
   *
   * Held in a ref rather than state because a poll must not re-render just to
   * record where it got to, and because appending is the whole point: the trace
   * is insertion-ordered and immutable, so a page is never re-fetched.
   */
  const eventsRef = useRef(new Map<string, { cursor: number; events: TraceEvent[] }>());

  const refresh = useCallback(async () => {
    try {
      const api = ensureNativeApi();
      const nextStatus = await api.factoryTrace.status({
        threadId: threadId as never,
      });
      setStatus(nextStatus);
      setError(null);
      if (nextStatus.state !== "ready") {
        setSessions([]);
        setDetailsByAdwId(new Map());
        return;
      }

      const summaries = await api.factoryTrace.listSessions({
        threadId: threadId as never,
      });
      setSessions(summaries);

      const fallbackAdwId = summaries[0]?.session.adwId ?? null;
      const hasSelectedSession = summaries.some(
        (summary) => summary.session.adwId === selectedAdwId,
      );
      const nextSelectedAdwId =
        isAggregateView(selectedAdwId) || hasSelectedSession ? selectedAdwId : fallbackAdwId;
      if (nextSelectedAdwId !== selectedAdwId) setSelectedAdwId(nextSelectedAdwId);

      if (nextSelectedAdwId === null) {
        setDetailsByAdwId(new Map());
        return;
      }

      const adwIds = isAggregateView(nextSelectedAdwId)
        ? aggregateAdwIds(nextSelectedAdwId, summaries)
        : [nextSelectedAdwId];
      const nextDetails = await Promise.all(
        adwIds.map(async (adwId) => {
          const existing = eventsRef.current.get(adwId) ?? {
            cursor: 0,
            events: [],
          };
          const next = await api.factoryTrace.readSession({
            threadId: threadId as never,
            adwId: adwId as AdwId,
            after: existing.cursor,
          });
          if (next === null) return null;
          const events = [...existing.events, ...next.events];
          eventsRef.current.set(adwId, { cursor: next.cursor, events });
          return [adwId, { ...next, events }] as const;
        }),
      );
      setDetailsByAdwId(
        new Map(
          nextDetails.filter((detail): detail is NonNullable<typeof detail> => detail !== null),
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the factory trace.");
    }
  }, [selectedAdwId, threadId]);

  // A hidden pane stops polling: a grid of nine panes must not each keep a timer
  // and a database read running.
  useEffect(() => {
    if (!isVisible) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isVisible, refresh]);

  const runningCount = useMemo(
    () => sessions.filter((summary) => summary.session.status === "running").length,
    [sessions],
  );

  const visibleDetails = useMemo(() => {
    if (isAggregateView(selectedAdwId)) {
      return aggregateAdwIds(selectedAdwId, sessions).flatMap((adwId) => {
        const detail = detailsByAdwId.get(adwId);
        return detail ? [detail] : [];
      });
    }
    const detail = selectedAdwId ? detailsByAdwId.get(selectedAdwId) : null;
    return detail ? [detail] : [];
  }, [detailsByAdwId, selectedAdwId, sessions]);

  if (error) return <PaneMessage>{error}</PaneMessage>;
  if (status === null) return <PaneMessage>Looking for a factory trace…</PaneMessage>;
  if (status.state !== "ready") return <TraceUnavailable status={status} />;
  if (sessions.length === 0) {
    return (
      <PaneMessage>
        No factory sessions yet. Run an ADW in this workspace and it will appear here as it works.
      </PaneMessage>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          session
        </span>
        <select
          aria-label="Factory session"
          className="min-w-0 flex-1 truncate rounded border border-border bg-background px-1.5 py-0.5 text-xs"
          value={selectedAdwId ?? ""}
          onChange={(event) => {
            setSelectedAdwId(event.target.value);
            // The selection names a phase in the session being left.
            setSelectedPhase(null);
          }}
        >
          <option value={ALL_AGENTS_VALUE}>All agents — {sessions.length} sessions</option>
          {/* Keep the option while it is the active view, so a run finishing
              out of the last agent does not leave the select blank. */}
          {runningCount > 0 || selectedAdwId === RUNNING_AGENTS_VALUE ? (
            <option value={RUNNING_AGENTS_VALUE}>Running now — {runningCount} active</option>
          ) : null}
          {sessions.map((summary) => {
            const progress = countPhaseProgress(summary.phases);
            return (
              <option key={summary.session.adwId} value={summary.session.adwId}>
                {summary.session.adwId} — {summary.session.status ?? "unknown"} ({progress.done}/
                {progress.total})
              </option>
            );
          })}
        </select>
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
          <IconRefresh className="size-3.5" aria-hidden />
        </Button>
      </div>

      {visibleDetails.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className={
              isAggregateView(selectedAdwId)
                ? "grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-auto p-2 xl:grid-cols-2"
                : "min-h-0 flex-1 overflow-auto"
            }
          >
            {visibleDetails.map((detail) => (
              <FactorySessionTrace
                key={detail.session.adwId}
                detail={detail}
                selectedPhaseId={
                  selectedPhase?.adwId === detail.session.adwId ? selectedPhase.phaseId : null
                }
                onSelectPhase={(phaseId) =>
                  setSelectedPhase(
                    phaseId === null ? null : { adwId: detail.session.adwId, phaseId },
                  )
                }
                onClosePhase={() => setSelectedPhase(null)}
              />
            ))}
          </div>
        </div>
      ) : selectedAdwId === RUNNING_AGENTS_VALUE ? (
        <PaneMessage>No agents are running right now.</PaneMessage>
      ) : (
        <PaneMessage>Loading session…</PaneMessage>
      )}
    </div>
  );
}

function FactorySessionTrace({
  detail,
  selectedPhaseId,
  onSelectPhase,
  onClosePhase,
}: {
  readonly detail: TraceSessionDetail;
  readonly selectedPhaseId: string | null;
  readonly onSelectPhase: (phaseId: string | null) => void;
  readonly onClosePhase: () => void;
}) {
  const lanesInput = useMemo(
    () => ({
      phases: detail.phases,
      agents: detail.agents,
      events: detail.events,
      sessionStartedAt: detail.session.startedAt,
      sessionEndedAt: detail.session.endedAt,
    }),
    [detail],
  );
  const selectedPhase = detail.phases.find((phase) => phase.phaseId === selectedPhaseId) ?? null;

  return (
    <section className="flex min-h-0 flex-col overflow-hidden border border-border bg-background">
      <FactoryTraceStrip
        session={detail.session}
        usage={detail.usage}
        phaseProgress={countPhaseProgress(detail.phases)}
      />
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <FactoryTraceLanes
          input={lanesInput}
          isLive={detail.session.status === "running"}
          selectedPhaseId={selectedPhaseId}
          onSelectPhase={onSelectPhase}
        />
      </div>
      {selectedPhase ? (
        <div className="max-h-[45%] shrink-0 overflow-auto">
          <FactoryPhaseDetail
            phase={selectedPhase}
            events={detail.events}
            envelopes={detail.envelopes}
            gates={detail.gates}
            onClose={onClosePhase}
          />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Why there is nothing to show.
 *
 * Each state gets its own sentence because they need different actions: a
 * workspace with no factory is normal and fixable by stamping one, while an
 * unreadable trace is a fault worth naming.
 */
function TraceUnavailable({ status }: { readonly status: TraceSourceStatus }) {
  if (status.state === "no-workspace") {
    return (
      <PaneMessage>
        This workspace has no thread, so there is no checkout to look for a factory trace in.
      </PaneMessage>
    );
  }
  if (status.state === "absent") {
    return (
      <PaneMessage>
        No factory trace in this workspace.
        <span className="mt-1 block font-mono text-[11px] opacity-70">{status.databasePath}</span>
        <span className="mt-2 block">
          Stamp a factory into the repo, or point Vulcan at an existing trace with
          <span className="font-mono"> VULCAN_FACTORY_TRACE_DB</span>.
        </span>
      </PaneMessage>
    );
  }
  return (
    <PaneMessage>
      {status.state === "unreadable" ? status.reason : "The factory trace could not be read."}
    </PaneMessage>
  );
}

function PaneMessage({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
