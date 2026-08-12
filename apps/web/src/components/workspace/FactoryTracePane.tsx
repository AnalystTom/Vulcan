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

export interface FactoryTracePaneProps {
  readonly isVisible: boolean;
  /** The thread whose checkout the factory runs in. Null means nowhere to look. */
  readonly threadId: string | null;
}

export function FactoryTracePane({ isVisible, threadId }: FactoryTracePaneProps) {
  const [status, setStatus] = useState<TraceSourceStatus | null>(null);
  const [sessions, setSessions] = useState<readonly TraceSessionSummary[]>([]);
  const [selectedAdwId, setSelectedAdwId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceSessionDetail | null>(null);
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Events already seen, and the cursor that produced them.
   *
   * Held in a ref rather than state because a poll must not re-render just to
   * record where it got to, and because appending is the whole point: the trace
   * is insertion-ordered and immutable, so a page is never re-fetched.
   */
  const eventsRef = useRef<{ adwId: string | null; cursor: number; events: TraceEvent[] }>({
    adwId: null,
    cursor: 0,
    events: [],
  });

  const refresh = useCallback(async () => {
    try {
      const api = ensureNativeApi();
      const nextStatus = await api.factoryTrace.status({ threadId: threadId as never });
      setStatus(nextStatus);
      setError(null);
      if (nextStatus.state !== "ready") {
        setSessions([]);
        setDetail(null);
        return;
      }

      const summaries = await api.factoryTrace.listSessions({ threadId: threadId as never });
      setSessions(summaries);

      const adwId = selectedAdwId ?? summaries[0]?.session.adwId ?? null;
      if (adwId !== selectedAdwId) setSelectedAdwId(adwId);
      if (adwId === null) {
        setDetail(null);
        return;
      }

      // A different session means a different event stream; the cursor cannot
      // carry over or the new session would start mid-history.
      if (eventsRef.current.adwId !== adwId) {
        eventsRef.current = { adwId, cursor: 0, events: [] };
      }
      const next = await api.factoryTrace.readSession({
        threadId: threadId as never,
        adwId: adwId as AdwId,
        after: eventsRef.current.cursor,
      });
      if (next === null) {
        setDetail(null);
        return;
      }
      eventsRef.current = {
        adwId,
        cursor: next.cursor,
        events: [...eventsRef.current.events, ...next.events],
      };
      setDetail({ ...next, events: eventsRef.current.events });
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

  const lanesInput = useMemo(
    () =>
      detail === null
        ? null
        : {
            phases: detail.phases,
            agents: detail.agents,
            events: detail.events,
            sessionStartedAt: detail.session.startedAt,
            sessionEndedAt: detail.session.endedAt,
          },
    [detail],
  );

  const selectedPhase = useMemo(
    () => detail?.phases.find((phase) => phase.phaseId === selectedPhaseId) ?? null,
    [detail, selectedPhaseId],
  );

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
            setSelectedPhaseId(null);
            setDetail(null);
          }}
        >
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

      {detail && lanesInput ? (
        <div className="flex min-h-0 flex-1 flex-col">
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
              onSelectPhase={setSelectedPhaseId}
            />
          </div>

          {selectedPhase ? (
            <div className="max-h-[45%] shrink-0 overflow-auto">
              <FactoryPhaseDetail
                phase={selectedPhase}
                events={detail.events}
                envelopes={detail.envelopes}
                gates={detail.gates}
                onClose={() => setSelectedPhaseId(null)}
              />
            </div>
          ) : null}
        </div>
      ) : (
        <PaneMessage>Loading session…</PaneMessage>
      )}
    </div>
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
