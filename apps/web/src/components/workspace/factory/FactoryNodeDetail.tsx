// FILE: FactoryNodeDetail.tsx
// Purpose: The evidence behind one node -- the attempt's facts, what the node was
// asked to do, the verdict over it, and the artifacts it produced.
// Layer: Workspace UI
//
// Selecting a block on the timeline has to answer "why does it say that", so
// this shows receipts rather than a summary: the revision an attempt ran at, the
// exact checks a gate read, and each artifact's own outcome. A gate judged at a
// revision the workspace has moved past is called out, because stale evidence
// that looks current is worse than no evidence.

import type { Artifact, FactoryRunDetail, GateResult, WorkflowNode } from "@vulcan/contracts";
import { describeFactoryNode } from "@vulcan/shared/factoryTimeline";
import { IconX } from "@tabler/icons-react";
import { useMemo, useState } from "react";

import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { IconButton } from "~/components/ui/icon-button";
import { formatClockDuration } from "~/session-logic";
import { cn } from "~/lib/utils";

import { STATUS_TONE } from "./factoryLaneTheme";
import type { FactorySelection } from "./FactoryTimeline";

export function FactoryNodeDetail({
  detail,
  selection,
  onClose,
}: {
  readonly detail: FactoryRunDetail;
  readonly selection: FactorySelection;
  readonly onClose: () => void;
}) {
  const node = detail.definition.nodes.find((candidate) => candidate.id === selection.nodeId);

  const attempt = useMemo(() => {
    const attempts = detail.attempts.filter((candidate) => candidate.nodeId === selection.nodeId);
    if (selection.attemptId === null) return null;
    return attempts.find((candidate) => candidate.id === selection.attemptId) ?? null;
  }, [detail.attempts, selection]);

  const artifacts = detail.artifacts.filter((artifact) =>
    attempt
      ? artifact.producedByAttemptId === attempt.id
      : artifact.producedByNodeId === selection.nodeId,
  );
  // The newest verdict for this node; older ones are superseded history.
  const gate = detail.gateResults.findLast((result) => result.nodeId === selection.nodeId);

  if (!node) return null;

  const startedMs = attempt?.startedAt ? Date.parse(attempt.startedAt) : Number.NaN;
  const endedMs = attempt?.endedAt ? Date.parse(attempt.endedAt) : Number.NaN;

  return (
    <section className="border-t border-border bg-muted/20 px-3 py-2 text-xs">
      <header className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
          {node.kind}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{node.title}</p>
          <p className="truncate text-muted-foreground">{describeFactoryNode(node)}</p>
        </div>
        <IconButton label="Close node detail" onClick={onClose}>
          <IconX className="size-3.5" aria-hidden />
        </IconButton>
      </header>

      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
        {attempt ? (
          <>
            <Fact label="Attempt">#{attempt.attemptNumber}</Fact>
            <Fact label="State">{attempt.state}</Fact>
            {attempt.waitingReason ? <Fact label="Waiting on">{attempt.waitingReason}</Fact> : null}
            {attempt.targetId ? <Fact label="Target">{attempt.targetId}</Fact> : null}
            {attempt.revision ? (
              <Fact label="Revision" mono>
                {attempt.revision.slice(0, 10)}
              </Fact>
            ) : null}
            {Number.isFinite(startedMs) ? (
              <Fact label="Started">{new Date(startedMs).toLocaleTimeString()}</Fact>
            ) : null}
            {Number.isFinite(startedMs) && Number.isFinite(endedMs) ? (
              <Fact label="Took">{formatClockDuration(endedMs - startedMs)}</Fact>
            ) : null}
          </>
        ) : (
          <Fact label="Attempt">Not started</Fact>
        )}
        <Fact label="Depends on">
          {node.dependsOn.length > 0 ? node.dependsOn.join(", ") : "nothing"}
        </Fact>
        {node.requiredCapabilities.length > 0 ? (
          <Fact label="Needs">{node.requiredCapabilities.join(", ")}</Fact>
        ) : null}
      </dl>

      {attempt?.failureSummary ? (
        <p className="mt-2 rounded border border-destructive/40 bg-destructive/5 px-1.5 py-1 text-destructive">
          {attempt.failureSummary}
        </p>
      ) : null}

      <NodeSpecifics node={node} />

      {gate ? <GateVerdict gate={gate} currentRevision={detail.currentRevision} /> : null}

      {artifacts.length > 0 ? (
        <div className="mt-2">
          <h4 className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Artifacts ({artifacts.length})
          </h4>
          <ul className="flex flex-col gap-1">
            {artifacts.map((artifact) => (
              <ArtifactRow key={artifact.id} artifact={artifact} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Fact({
  label,
  mono,
  children,
}: {
  readonly label: string;
  readonly mono?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 truncate", mono && "font-mono")}>{children}</dd>
    </>
  );
}

/** What this kind of node was actually asked to do, in its own terms. */
function NodeSpecifics({ node: workflowNode }: { readonly node: WorkflowNode }) {
  const [open, setOpen] = useState(false);

  const body = (() => {
    switch (workflowNode.kind) {
      case "agent":
        return <pre className="whitespace-pre-wrap break-words">{workflowNode.promptTemplate}</pre>;
      case "command":
      case "test":
        return <pre className="whitespace-pre-wrap break-words">{workflowNode.command}</pre>;
      case "browserVerification":
        return (
          <ol className="list-decimal pl-4">
            {workflowNode.journey.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        );
      case "gate":
        return (
          <ul className="pl-1">
            {workflowNode.checks.map((check) => (
              <li key={check.name}>
                {check.name} — needs {check.requiresArtifactKinds.join(", ") || "no artifacts"}
              </li>
            ))}
          </ul>
        );
      case "approval":
        return <p>{workflowNode.question}</p>;
      case "review":
      case "lavishReview":
        return null;
    }
  })();

  if (body === null) return null;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-accent"
      >
        <DisclosureChevron open={open} className="size-3" />
        Instruction
      </button>
      <DisclosureRegion open={open}>
        <div className="mt-1 max-h-48 overflow-auto rounded bg-muted/50 p-1.5 text-[11px] text-muted-foreground">
          {body}
        </div>
      </DisclosureRegion>
    </div>
  );
}

function GateVerdict({
  gate,
  currentRevision,
}: {
  readonly gate: GateResult;
  readonly currentRevision: string;
}) {
  const stale = gate.revision !== currentRevision;
  return (
    <div className="mt-2">
      <p className={cn("font-medium", gate.passed ? STATUS_TONE.complete : STATUS_TONE.failed)}>
        Gate {gate.passed ? "passed" : "did not pass"} at{" "}
        <span className="font-mono">{gate.revision.slice(0, 10)}</span>
      </p>
      {/* A verdict from before the last commit is history, not a current claim. */}
      {stale ? (
        <p className="text-amber-600 dark:text-amber-400">
          The workspace has moved to {currentRevision.slice(0, 10)}, so this verdict no longer
          counts.
        </p>
      ) : null}
      <ul className="text-muted-foreground">
        {gate.checks.map((check) => (
          <li key={check.name}>
            <span className={check.passed ? STATUS_TONE.complete : STATUS_TONE.failed}>
              {check.passed ? "✓" : "✗"}
            </span>{" "}
            {check.name} — {check.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ArtifactRow({ artifact }: { readonly artifact: Artifact }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-accent"
      >
        <DisclosureChevron open={open} className="size-3" />
        <span className="min-w-0 flex-1 truncate">{artifact.kind}</span>
        <span
          className={cn(
            "shrink-0 text-[10px]",
            artifact.outcome === "failed"
              ? STATUS_TONE.failed
              : artifact.outcome === "passed"
                ? STATUS_TONE.complete
                : "text-muted-foreground",
          )}
        >
          {artifact.outcome}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {artifact.revision.slice(0, 7)}
        </span>
      </button>
      <DisclosureRegion open={open}>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-1.5 text-[11px]">
          {artifact.summary}
        </pre>
      </DisclosureRegion>
    </li>
  );
}
