// FILE: FactoryPane.tsx
// Purpose: The Factory Pane Mode -- the whole workflow graph, what every node and
// deterministic step is doing, and the evidence behind each one.
// Layer: Workspace UI
//
// The pane renders the run's raw facts and derives everything shown from them
// using the same shared functions the kernel's tests cover. Nothing here decides
// whether a node is complete or a gate passed; asking the server for a
// pre-computed view would let the picture drift from what the kernel believes.
//
// Future nodes are shown, not hidden. An operator has to be able to see the
// intended factory before it executes rather than reconstruct it afterwards,
// which is the difference between a plan and a log.

import type { AttentionItem, FactoryRunDetail, FactoryRunSummary } from "@vulcan/contracts";
import {
  buildFactoryActivityBoard,
  buildFactoryWaterfall,
  FACTORY_ACTIVITY_GROUPS,
  type FactoryNodeStatus,
  type FactoryWaterfallEntry,
} from "@vulcan/shared/workItemProjection";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconRefresh,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { ensureNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";

/** How often a visible Factory pane re-reads its run. */
const REFRESH_INTERVAL_MS = 2_000;

const STATUS_LABEL: Record<FactoryNodeStatus, string> = {
  "not-started": "Not started",
  "blocked-by-dependency": "Waiting on an earlier node",
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  review: "Verifying",
  failed: "Failed",
  complete: "Complete",
};

const STATUS_TONE: Record<FactoryNodeStatus, string> = {
  "not-started": "text-muted-foreground",
  "blocked-by-dependency": "text-muted-foreground",
  queued: "text-sky-600 dark:text-sky-400",
  running: "text-sky-600 dark:text-sky-400",
  waiting: "text-amber-600 dark:text-amber-400",
  review: "text-violet-600 dark:text-violet-400",
  failed: "text-red-600 dark:text-red-400",
  complete: "text-emerald-600 dark:text-emerald-400",
};

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
    return <PaneMessage>Loading runs…</PaneMessage>;
  }
  if (runs.length === 0) {
    return <StartRunPanel threadId={threadId} onStarted={() => void refresh()} />;
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
        <select
          aria-label="Workflow run"
          className="min-w-0 flex-1 truncate rounded border border-border bg-background px-1.5 py-0.5 text-xs"
          value={selectedRunId ?? ""}
          onChange={(event) => setSelectedRunId(event.target.value)}
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

      {detail ? <FactoryRunView detail={detail} /> : <PaneMessage>Loading run…</PaneMessage>}
    </div>
  );
}

function FactoryRunView({ detail }: { readonly detail: FactoryRunDetail }) {
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
  const waterfall = useMemo(() => buildFactoryWaterfall(snapshot), [snapshot]);
  const board = useMemo(() => buildFactoryActivityBoard(snapshot), [snapshot]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <section className="border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
          <span className="font-medium">{detail.definition.name}</span>
          <span className="text-muted-foreground">{detail.run.state}</span>
          {/* The revision everything is judged against; without it no verdict means anything. */}
          <span className="font-mono text-muted-foreground">
            {detail.currentRevision.slice(0, 10)}
          </span>
        </div>
      </section>

      {detail.attentionItems.length > 0 ? <AttentionSection items={detail.attentionItems} /> : null}

      <section className="border-b border-border px-3 py-2">
        <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Activity</h3>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {FACTORY_ACTIVITY_GROUPS.map((group) => (
            <span key={group} className="flex items-center gap-1">
              <span className={cn("font-medium", STATUS_TONE[group])}>{board[group].length}</span>
              <span className="text-muted-foreground">{group}</span>
            </span>
          ))}
        </div>
      </section>

      <section className="px-3 py-2">
        <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">
          Workflow ({waterfall.length} nodes)
        </h3>
        <ol className="flex flex-col gap-0.5">
          {waterfall.map((entry) => (
            <WaterfallRow key={entry.node.id} entry={entry} detail={detail} />
          ))}
        </ol>
      </section>
    </div>
  );
}

function AttentionSection({ items }: { readonly items: readonly AttentionItem[] }) {
  const [resolving, setResolving] = useState<string | null>(null);

  return (
    <section className="border-b border-amber-500/40 bg-amber-500/5 px-3 py-2">
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

function WaterfallRow({
  entry,
  detail,
}: {
  readonly entry: FactoryWaterfallEntry;
  readonly detail: FactoryRunDetail;
}) {
  const [open, setOpen] = useState(false);
  const artifacts = detail.artifacts.filter(
    (artifact) => artifact.producedByNodeId === entry.node.id,
  );
  const gate = detail.gateResults.filter((result) => result.nodeId === entry.node.id).at(-1);
  const hasDetail = artifacts.length > 0 || gate !== undefined || entry.attempt !== null;

  return (
    <li>
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-xs hover:bg-accent disabled:hover:bg-transparent"
      >
        {hasDetail ? (
          open ? (
            <IconChevronDown className="size-3 shrink-0" aria-hidden />
          ) : (
            <IconChevronRight className="size-3 shrink-0" aria-hidden />
          )
        ) : (
          <span className="size-3 shrink-0" />
        )}
        {/* Judgment and deterministic work are visually distinct, because the
            difference is what makes acceptance trustworthy. */}
        <span
          className={cn(
            "shrink-0 rounded px-1 text-[10px] uppercase",
            entry.isAgentWork
              ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
              : "bg-muted text-muted-foreground",
          )}
        >
          {entry.isAgentWork ? "agent" : entry.node.kind}
        </span>
        <span className="min-w-0 flex-1 truncate">{entry.node.title}</span>
        {entry.attemptCount > 1 ? (
          <span className="shrink-0 text-muted-foreground">×{entry.attemptCount}</span>
        ) : null}
        <span className={cn("shrink-0", STATUS_TONE[entry.status])}>
          {STATUS_LABEL[entry.status]}
        </span>
      </button>

      {open ? (
        <div className="ml-5 flex flex-col gap-1 border-l border-border pl-2 pb-1 text-xs">
          {entry.attempt?.waitingReason ? (
            <p className="text-muted-foreground">Waiting on: {entry.attempt.waitingReason}</p>
          ) : null}
          {entry.attempt?.failureSummary ? (
            <p className="text-red-600 dark:text-red-400">{entry.attempt.failureSummary}</p>
          ) : null}

          {gate ? (
            <div>
              <p className="font-medium">
                Gate {gate.passed ? "passed" : "did not pass"} at{" "}
                <span className="font-mono">{gate.revision.slice(0, 10)}</span>
              </p>
              <ul className="text-muted-foreground">
                {gate.checks.map((check) => (
                  <li key={check.name}>
                    {check.passed ? "✓" : "✗"} {check.name} — {check.detail}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {artifacts.map((artifact) => (
            <details key={artifact.id}>
              <summary className="cursor-pointer">
                <span
                  className={cn(
                    artifact.outcome === "failed"
                      ? "text-red-600 dark:text-red-400"
                      : "text-muted-foreground",
                  )}
                >
                  {artifact.kind} ({artifact.outcome}) @{" "}
                  <span className="font-mono">{artifact.revision.slice(0, 10)}</span>
                </span>
              </summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-1.5 text-[11px]">
                {artifact.summary}
              </pre>
            </details>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function PaneMessage({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

interface WorkflowOption {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly runnableHere: boolean;
  readonly missingCapabilities: readonly string[];
}

/**
 * The empty state, which is also where a run is started.
 *
 * Each workflow says whether it can run here and, when it cannot, exactly which
 * capabilities are missing. That is the same honesty the scheduler enforces:
 * offering a workflow that would immediately stop and ask for a capability
 * nobody reports would waste the operator's time.
 */
function StartRunPanel({
  threadId,
  onStarted,
}: {
  readonly threadId: string | null;
  readonly onStarted: () => void;
}) {
  const [workflows, setWorkflows] = useState<readonly WorkflowOption[] | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void ensureNativeApi()
      .factory.listWorkflows()
      .then(setWorkflows)
      .catch(() => setWorkflows([]));
  }, []);

  const start = async (workflow: WorkflowOption) => {
    if (!threadId) return;
    setStarting(workflow.id);
    setMessage(null);
    try {
      const result = await ensureNativeApi().factory.startRun({
        workflowYaml: workflow.source,
        workItemId: `work-item-${threadId}` as never,
        threadId: threadId as never,
        workspaceId: null,
        projectId: null,
      });
      if (result.outcome === "started") onStarted();
      else if (result.outcome === "refused") setMessage(result.reason);
      else setMessage(result.problems.map((problem) => problem.message).join(" "));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not start the run.");
    } finally {
      setStarting(null);
    }
  };

  return (
    <div className="flex h-full w-full flex-col gap-3 overflow-y-auto p-4 text-sm">
      <p className="text-muted-foreground">
        No workflow runs yet. Start one to see its graph, activity, and evidence here.
      </p>

      {threadId === null ? (
        <p className="text-muted-foreground text-xs">
          This workspace has no thread, so there is no checkout to run against. Open it from a
          project first.
        </p>
      ) : null}

      {(workflows ?? []).map((workflow) => (
        <div key={workflow.id} className="rounded border border-border p-2">
          <div className="font-medium">{workflow.name}</div>
          <p className="text-muted-foreground text-xs">{workflow.description}</p>
          {workflow.runnableHere ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-1.5"
              disabled={threadId === null || starting !== null}
              onClick={() => void start(workflow)}
            >
              {starting === workflow.id ? "Starting…" : "Run"}
            </Button>
          ) : (
            <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
              Cannot run here: no target reports {workflow.missingCapabilities.join(", ")}.
            </p>
          )}
        </div>
      ))}

      {message ? <p className="text-xs text-red-600 dark:text-red-400">{message}</p> : null}
    </div>
  );
}
