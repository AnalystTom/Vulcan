// FILE: FactoryStartRun.tsx
// Purpose: The Factory pane's empty state, which is also where a session starts.
// Layer: Workspace UI
//
// Each workflow says whether it can run here and, when it cannot, exactly which
// capabilities are missing. That is the same honesty the scheduler enforces:
// offering a workflow that would immediately stop and ask for a capability
// nobody reports would waste the operator's time.

import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { ensureNativeApi } from "~/nativeApi";

interface WorkflowOption {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly runnableHere: boolean;
  readonly missingCapabilities: readonly string[];
}

export function FactoryStartRun({
  threadId,
  onStarted,
}: {
  /**
   * The thread whose workspace a new run would execute in. Null when there is no
   * checkout to pin evidence to, in which case starting is not offered.
   */
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
        No sessions yet. Start one to watch every worker's lane as the run executes.
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
