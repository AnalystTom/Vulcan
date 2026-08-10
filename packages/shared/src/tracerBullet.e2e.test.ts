// FILE: tracerBullet.e2e.test.ts
// Purpose: Drive the tracer-bullet workflow end to end against a real temporary
// git repository, and assert the properties the product's completion claims rest
// on.
// Layer: shared domain logic test
//
// This is the issue's primary contract at the kernel seam: deterministic node
// executors, but real orchestration, real git revisions, real artifacts, real
// gates, real retries, real Attention Items, and a real PR-ready Gate Result.
// The executors stand in for agents and for the browser and Lavish harnesses;
// everything they hand back -- above all the revisions -- comes from git.
//
// What it does not yet cover, and what a later stage owes: running through the
// packaged desktop app and the authoritative controller, the Lavish sidecar, and
// a real Playwright journey.

import {
  type ArtifactId,
  type AttentionItemId,
  type ExecutionTarget,
  type ExecutionTargetId,
  type GitRevision,
  type NodeAttemptId,
  type WorkflowNode,
  type WorkflowRunId,
} from "@vulcan/contracts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ControllerEnvironment,
  driveRun,
  type NodeOutcome,
  gateResultsFor,
} from "./factoryController";
import { findStaleArtifacts } from "./factoryKernel";
import { TRACER_BULLET_WORKFLOW_YAML } from "./tracerBulletWorkflow";
import { parseWorkflowYaml } from "./workflowYaml";
import { placeWorkItem } from "./workItemProjection";

const parsed = parseWorkflowYaml(TRACER_BULLET_WORKFLOW_YAML);
if (!parsed.ok) throw new Error("tracer bullet workflow must parse");
const definition = parsed.definition;

const runId = "run-e2e" as WorkflowRunId;
const gateNodeId = definition.nodes.find((node) => node.kind === "gate")?.id;

let repository: string;

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();

const headRevision = (): GitRevision => git("rev-parse", "HEAD") as GitRevision;

// A fresh repository per test. Sharing one would let an earlier test's commit
// make a later test's build a no-op, which git rejects -- and would couple the
// tests to each other's history.
beforeEach(() => {
  repository = mkdtempSync(join(tmpdir(), "vulcan-tracer-"));
  git("init", "--initial-branch=main");
  git("config", "user.email", "tracer@vulcan.test");
  git("config", "user.name", "Tracer");
  writeFileSync(join(repository, "README.md"), "# fixture\n");
  git("add", ".");
  git("commit", "-m", "initial");
});

afterEach(() => {
  if (repository) rmSync(repository, { recursive: true, force: true });
});

/** Targets that between them cover every capability the tracer bullet needs. */
const TARGETS: ExecutionTarget[] = [
  {
    id: "main-server" as ExecutionTargetId,
    label: "main server",
    capabilities: ["agent", "git", "shell", "node", "browser", "lavish"],
    maxConcurrentLeases: 4,
    online: true,
    lastSeenAt: null,
  },
];

interface HarnessOptions {
  /** Node ids whose executor should fail, and how many times before succeeding. */
  readonly failures?: Record<string, number>;
  /** Node ids whose executor should report waiting on a person. */
  readonly waitsForHuman?: readonly string[];
  readonly targets?: readonly ExecutionTarget[];
}

/**
 * A deterministic environment whose "build" node makes a real commit.
 *
 * The commit is the point: it moves the workspace revision mid-run exactly as a
 * real build would, so the pinning and invalidation rules are exercised against
 * git rather than against a fixture.
 */
function makeEnvironment(options: HarnessOptions = {}): {
  environment: ControllerEnvironment;
  executed: string[];
} {
  const executed: string[] = [];
  const remainingFailures = new Map(Object.entries(options.failures ?? {}));
  let clock = Date.parse("2026-08-09T00:00:00.000Z");
  let ids = 0;

  const tick = () => {
    // One second per call: enough to order events, never enough to trip the
    // policy's timeouts, so the run is deterministic.
    clock += 1_000;
    return new Date(clock).toISOString();
  };

  const executeNode = async ({ node }: { node: WorkflowNode }): Promise<NodeOutcome> => {
    executed.push(node.id);

    if (options.waitsForHuman?.includes(node.id)) {
      return { kind: "waiting", reason: "approval-required" };
    }

    const failures = remainingFailures.get(node.id) ?? 0;
    if (failures > 0) {
      remainingFailures.set(node.id, failures - 1);
      return { kind: "failed", failureSummary: `${node.id} failed deliberately.` };
    }

    switch (node.kind) {
      case "agent": {
        if (node.role !== "build") {
          return {
            kind: "produced",
            revision: headRevision(),
            succeeded: true,
            artifacts: [{ kind: "plan", outcome: "informational", summary: "Planned the change." }],
          };
        }
        // A real edit and a real commit, so the revision genuinely moves.
        writeFileSync(join(repository, "feature.txt"), `built at ${tick()}\n`);
        git("add", ".");
        git("commit", "-m", "build: implement the work item");
        return {
          kind: "produced",
          revision: headRevision(),
          succeeded: true,
          artifacts: [{ kind: "diff", outcome: "informational", summary: "One file changed." }],
        };
      }
      case "test": {
        // A real command against the real checkout.
        const tracked = git("ls-files");
        const passed = tracked.includes("feature.txt");
        return {
          kind: "produced",
          revision: headRevision(),
          succeeded: passed,
          artifacts: [
            {
              kind: "test-results",
              outcome: passed ? "passed" : "failed",
              summary: passed ? "All checks passed." : "The built file is missing.",
            },
          ],
        };
      }
      case "browserVerification":
        return {
          kind: "produced",
          revision: headRevision(),
          succeeded: true,
          artifacts: [
            { kind: "browser-journey", outcome: "passed", summary: "New-user journey completed." },
            { kind: "screenshot", outcome: "passed", summary: "Delivered surface captured." },
          ],
        };
      case "review":
        return {
          kind: "produced",
          revision: headRevision(),
          succeeded: true,
          artifacts: [{ kind: "review", outcome: "passed", summary: "Independently reviewed." }],
        };
      case "lavishReview":
        return {
          kind: "produced",
          revision: headRevision(),
          succeeded: true,
          artifacts: [
            { kind: "lavish-review", outcome: "passed", summary: "Visual review approved." },
          ],
        };
      case "gate":
        // A gate produces no evidence; it judges what already exists.
        return { kind: "produced", revision: headRevision(), succeeded: true, artifacts: [] };
      default:
        return { kind: "produced", revision: headRevision(), succeeded: true, artifacts: [] };
    }
  };

  return {
    executed,
    environment: {
      executeNode,
      now: tick,
      nextAttemptId: () => `attempt-${(ids += 1)}` as NodeAttemptId,
      nextArtifactId: () => `artifact-${(ids += 1)}` as ArtifactId,
      nextAttentionItemId: () => `attention-${(ids += 1)}` as AttentionItemId,
      targets: options.targets ?? TARGETS,
      initialRevision: headRevision(),
    },
  };
}

describe("tracer bullet against a real git repository", () => {
  it("runs Work Item to a PR-ready Gate Result citing evidence at one revision", async () => {
    const { environment, executed } = makeEnvironment();
    const result = await driveRun(runId, definition, environment);

    expect(result.state).toBe("succeeded");
    // Every node ran, in dependency order.
    expect(executed).toEqual([
      "plan",
      "build",
      "test",
      "browser-verification",
      "review",
      "lavish-review",
      "pr-ready",
    ]);

    const gate = gateResultsFor(result.snapshot, gateNodeId!).at(-1);
    expect(gate?.passed).toBe(true);
    // The gate judged the revision the build produced, which is a real git SHA.
    expect(gate?.revision).toBe(headRevision());
    expect(gate?.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(gate?.policyVersion).toBe(definition.policy.version);

    // Every check cites the artifacts it read, and none is empty.
    expect(gate?.checks).toHaveLength(4);
    for (const check of gate?.checks ?? []) {
      expect(check.passed).toBe(true);
      expect(check.evidenceArtifactIds.length).toBeGreaterThan(0);
    }

    // All surviving evidence describes the revision the gate judged. The plan and
    // diff artifacts produced before the build's commit are correctly stale.
    const stale = findStaleArtifacts(result.snapshot);
    expect(stale.every((artifact) => artifact.revision !== result.snapshot.currentRevision)).toBe(
      true,
    );
    for (const artifact of result.snapshot.artifacts) {
      if (stale.includes(artifact)) continue;
      expect(artifact.revision).toBe(gate?.revision);
    }

    // No target is left reserved once the run stops.
    expect(result.leases).toEqual([]);
    expect(result.attentionItems).toEqual([]);
  });

  it("shows the item as done on the board only because the gate passed", async () => {
    const { environment } = makeEnvironment();
    const result = await driveRun(runId, definition, environment);

    const placement = placeWorkItem({
      workItem: {
        id: "item-1" as never,
        title: "Tracer",
        body: "",
        source: { kind: "local", externalId: null, url: null },
        projectId: null,
        workspaceId: null,
        intent: "ready",
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      },
      snapshot: result.snapshot,
      deliveryGateNodeId: gateNodeId!,
      openAttentionItems: [],
    });
    expect(placement.column).toBe("done");
    expect(placement.reason).toContain(result.snapshot.currentRevision);

    // Point the board at a gate that never ran and delivery cannot be claimed,
    // even though the run is finished.
    const withoutGate = placeWorkItem({
      workItem: {
        id: "item-1" as never,
        title: "Tracer",
        body: "",
        source: { kind: "local", externalId: null, url: null },
        projectId: null,
        workspaceId: null,
        intent: "ready",
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      },
      snapshot: result.snapshot,
      deliveryGateNodeId: null,
      openAttentionItems: [],
    });
    expect(withoutGate.column).not.toBe("done");
  });

  it("invalidates the passed gate when a new commit lands", async () => {
    const { environment } = makeEnvironment();
    const result = await driveRun(runId, definition, environment);
    const passedRevision = result.snapshot.currentRevision;

    // Someone pushes another change.
    writeFileSync(join(repository, "later.txt"), "later\n");
    git("add", ".");
    git("commit", "-m", "a later change");
    const moved = { ...result.snapshot, currentRevision: headRevision() };

    expect(moved.currentRevision).not.toBe(passedRevision);
    // Every artifact the gate cited is now stale, so the pass no longer counts.
    expect(findStaleArtifacts(moved).length).toBe(moved.artifacts.length);

    const placement = placeWorkItem({
      workItem: {
        id: "item-1" as never,
        title: "Tracer",
        body: "",
        source: { kind: "local", externalId: null, url: null },
        projectId: null,
        workspaceId: null,
        intent: "ready",
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      },
      snapshot: moved,
      deliveryGateNodeId: gateNodeId!,
      openAttentionItems: [],
    });
    expect(placement.column).not.toBe("done");
  });

  it("retries a failing node within its budget and still delivers", async () => {
    const { environment, executed } = makeEnvironment({ failures: { test: 1 } });
    const result = await driveRun(runId, definition, environment);

    expect(result.state).toBe("succeeded");
    // The repair loop is visible: the test node ran twice.
    expect(executed.filter((id) => id === "test")).toHaveLength(2);
    expect(gateResultsFor(result.snapshot, gateNodeId!).at(-1)?.passed).toBe(true);
  });

  it("stops and asks a person once the attempt budget is spent", async () => {
    const { environment } = makeEnvironment({
      failures: { test: definition.policy.maxAttemptsPerNode + 1 },
    });
    const result = await driveRun(runId, definition, environment);

    expect(result.state).toBe("failed");
    // The gate never passed, so nothing downstream claimed completion.
    expect(gateResultsFor(result.snapshot, gateNodeId!)).toEqual([]);
    // A person is asked exactly once, with the rungs already tried.
    expect(result.attentionItems).toHaveLength(1);
    expect(result.attentionItems[0]?.nodeId).toBe("test");
    expect(result.attentionItems[0]?.request).toContain("test");
    expect(result.leases).toEqual([]);
  });

  it("hands over to a person rather than spinning when a node waits on approval", async () => {
    const { environment } = makeEnvironment({ waitsForHuman: ["review"] });
    const result = await driveRun(runId, definition, environment);

    expect(result.state).toBe("blocked");
    expect(result.attentionItems).toHaveLength(1);
    expect(result.attentionItems[0]?.reason).toBe("approval-required");
    // The loop stopped instead of retrying the node forever.
    expect(result.turns).toBeLessThan(10);
  });

  it("raises attention instead of running when no target has the capability", async () => {
    // A capability nobody reports will never resolve by waiting, so it goes
    // straight to a person rather than through the automatic rungs.
    const { environment, executed } = makeEnvironment({
      targets: [
        {
          id: "limited" as ExecutionTargetId,
          label: "limited",
          // Reports agent work but not a shell, so the plan node runs and the
          // test node has nowhere to go.
          capabilities: ["agent", "git"],
          maxConcurrentLeases: 1,
          online: true,
          lastSeenAt: null,
        },
      ],
    });
    const result = await driveRun(runId, definition, environment);

    expect(result.state).not.toBe("succeeded");
    // The plan node needs nothing, so it ran; the build node needs shell and did not.
    expect(executed).toContain("plan");
    expect(executed).not.toContain("test");
    expect(result.attentionItems.length).toBeGreaterThan(0);
    expect(result.leases).toEqual([]);
  });
});
