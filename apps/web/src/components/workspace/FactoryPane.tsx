// FILE: FactoryPane.tsx
// Purpose: The Factory Pane Mode -- a run's sessions, each drawn as per-worker
// lanes on one time axis, with the evidence behind any block one click away.
// Layer: Workspace UI
//
// The pane renders the run's raw facts and derives everything shown from them
// using the same shared functions the kernel's tests cover. Nothing here decides
// whether a node is complete or a gate passed; asking the server for a
// pre-computed view would let the picture drift from what the kernel believes.
//
// The session view is lanes rather than a list because the thing an operator
// watches is concurrency: which worker is busy, which is idle, and how long a
// handoff took. Future nodes stay visible as pending blocks -- the intended
// factory has to be legible before it executes, not only afterwards.

import type { AttentionItem, FactoryRunDetail, FactoryRunSummary } from "@vulcan/contracts";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { ensureNativeApi } from "~/nativeApi";

import { FactoryNodeDetail } from "./factory/FactoryNodeDetail";
import { FactoryRunStrip } from "./factory/FactoryRunStrip";
import { FactoryStartRun } from "./factory/FactoryStartRun";
import { FactoryTimeline, type FactorySelection } from "./factory/FactoryTimeline";

/** How often a visible Factory pane re-reads its run. */
const REFRESH_INTERVAL_MS = 2_000;

export interface FactoryPaneProps {
  readonly isVisible: boolean;
  /**
   * The thread whose workspace a new run would execute in. Null when the
   * Workspace has no thread yet, in which case starting a run is not offered --
   * a run needs a checkout to pin its evidence to.
   */
  readonly threadId: string | null;
}

export function FactoryPane({ isVisible, threadId }: FactoryPaneProps) {
  const [runs, setRuns] = useState<readonly FactoryRunSummary[] | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FactoryRunDetail | null>(null);
  const [selection, setSelection] = useState<FactorySelection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const api = ensureNativeApi();
      const summaries = await api.factory.listRuns();
      setRuns(summaries);
      setError(null);

      const runId = selectedRunId ?? summaries[0]?.run.id ?? null;
      if (runId !== selectedRunId) setSelectedRunId(runId);
      setDetail(runId ? await api.factory.readRun({ runId: runId as never }) : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read factory runs.");
    }
  }, [selectedRunId]);

  // Polling matches the controller's own cadence. A hidden pane stops, because a
  // grid of nine panes must not each keep a timer running.
  useEffect(() => {
    if (!isVisible) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isVisible, refresh]);

  if (error) {
    return <PaneMessage>{error}</PaneMessage>;
  }
  if (runs === null) {
    return <PaneMessage>Loading sessions…</PaneMessage>;
  }
  if (runs.length === 0) {
    return <FactoryStartRun threadId={threadId} onStarted={() => void refresh()} />;
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          session
        </span>
        <select
          aria-label="Workflow session"
          className="min-w-0 flex-1 truncate rounded border border-border bg-background px-1.5 py-0.5 text-xs"
          value={selectedRunId ?? ""}
          onChange={(event) => {
            setSelectedRunId(event.target.value);
            // The selection names a node in the run being left; carrying it over
            // would open evidence from a different session.
            setSelection(null);
            setDetail(null);
          }}
        >
          {runs.map((summary) => (
            <option key={summary.run.id} value={summary.run.id}>
              {summary.definitionName} — {summary.run.state} ({summary.completedNodeCount}/
              {summary.nodeCount})
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
          <IconRefresh className="size-3.5" aria-hidden />
        </Button>
      </div>

      {detail ? (
        <FactoryRunView detail={detail} selection={selection} onSelect={setSelection} />
      ) : (
        <PaneMessage>Loading session…</PaneMessage>
      )}
    </div>
  );
}

function FactoryRunView({
  detail,
  selection,
  onSelect,
}: {
  readonly detail: FactoryRunDetail;
  readonly selection: FactorySelection | null;
  readonly onSelect: (selection: FactorySelection | null) => void;
}) {
  // The snapshot the kernel would see, rebuilt from the wire payload so the same
  // shared projections produce the view.
  const snapshot = useMemo(
    () => ({
      definition: detail.definition,
      attempts: detail.attempts,
      artifacts: detail.artifacts,
      gateResults: detail.gateResults,
      currentRevision: detail.currentRevision,
    }),
    [detail],
  );

  const openAttention = detail.attentionItems.filter((item) => item.resolvedAt === null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FactoryRunStrip detail={detail} />

      {openAttention.length > 0 ? <AttentionSection items={openAttention} /> : null}

      <div className="min-h-0 flex-1 overflow-auto p-2">
        <FactoryTimeline
          snapshot={snapshot}
          runStartedAtMs={Date.parse(detail.run.createdAt)}
          runEndedAtMs={detail.run.endedAt === null ? null : Date.parse(detail.run.endedAt)}
          selection={selection}
          onSelect={onSelect}
        />
      </div>

      {selection ? (
        <div className="max-h-[45%] shrink-0 overflow-auto">
          <FactoryNodeDetail detail={detail} selection={selection} onClose={() => onSelect(null)} />
        </div>
      ) : null}
    </div>
  );
}

function AttentionSection({ items }: { readonly items: readonly AttentionItem[] }) {
  const [resolving, setResolving] = useState<string | null>(null);

  return (
    <section className="shrink-0 border-b border-amber-500/40 bg-amber-500/5 px-3 py-2">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
        <IconAlertTriangle className="size-3.5 text-amber-500" aria-hidden />
        Needs you ({items.length})
      </h3>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.id} className="text-xs">
            <p>{item.request}</p>
            {/* What was already tried, so the operator is not asked to repeat it. */}
            {item.attemptedRecovery.length > 0 ? (
              <p className="text-muted-foreground">
                Already tried: {item.attemptedRecovery.join(" → ")}
              </p>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className="mt-1"
              disabled={resolving === item.id}
              onClick={() => {
                setResolving(item.id);
                void ensureNativeApi()
                  .factory.resolveAttention({
                    attentionItemId: item.id,
                    resolution: "Acknowledged by the operator.",
                  })
                  .finally(() => setResolving(null));
              }}
            >
              Acknowledge
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PaneMessage({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
