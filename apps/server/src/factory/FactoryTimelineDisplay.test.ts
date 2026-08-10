// FILE: FactoryTimelineDisplay.test.ts
// Purpose: What the operator sees in the Factory session timeline after the real
// runner has driven a real workflow against a real checkout.
// Layer: server integration test
//
// The projection has its own unit tests over hand-built snapshots. This one
// closes the loop the other end: it drives the actual runner and asserts on the
// lanes the pane would draw from what the runner actually stored. A change that
// makes the runner record work differently -- an attempt that never reaches
// `running`, say -- has to fail here rather than quietly turn a lane blank.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ThreadId, WorkItemId } from "@vulcan/contracts";
import { CHECKOUT_VERIFY_WORKFLOW_YAML } from "@vulcan/shared/checkoutVerifyWorkflow";
import { buildFactoryTimeline } from "@vulcan/shared/factoryTimeline";
import { TRACER_BULLET_WORKFLOW_YAML } from "@vulcan/shared/tracerBulletWorkflow";
import { parseWorkflowYaml } from "@vulcan/shared/workflowYaml";
import { Effect, Layer } from "effect";

import { FactoryStoreLive } from "../persistence/Layers/FactoryStore.ts";
import { FactoryStore } from "../persistence/Services/FactoryStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { FactoryRunnerLive } from "./Layers/FactoryRunner.ts";
import { FactoryRunner } from "./Services/FactoryRunner.ts";
import { FactoryWorkspaces } from "./Services/FactoryWorkspaces.ts";

const fixedWorkspaces = Layer.succeed(FactoryWorkspaces)({
  resolveThreadWorkspacePath: (threadId) =>
    Effect.succeed(threadId.startsWith("/") ? threadId : null),
});

const freshFactory = () =>
  FactoryRunnerLive.pipe(
    Layer.provideMerge(FactoryStoreLive),
    Layer.provideMerge(fixedWorkspaces),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

const parseOrThrow = (source: string) => {
  const result = parseWorkflowYaml(source);
  if (!result.ok) throw new Error(`workflow must parse: ${JSON.stringify(result.problems)}`);
  return result.definition;
};

const verifyDefinition = parseOrThrow(CHECKOUT_VERIFY_WORKFLOW_YAML);
const tracerDefinition = parseOrThrow(TRACER_BULLET_WORKFLOW_YAML);

const repositories: string[] = [];

function makeRepository(): string {
  const path = mkdtempSync(join(tmpdir(), "vulcan-timeline-"));
  repositories.push(path);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8" });
  git("init", "--initial-branch=main");
  git("config", "user.email", "runner@vulcan.test");
  git("config", "user.name", "Runner");
  writeFileSync(join(path, "README.md"), "# fixture\n");
  git("add", ".");
  git("commit", "-m", "initial");
  return path;
}

/** Starts a run, ticks it to a standstill, and projects what the pane would draw. */
const startAndProject = (input: {
  readonly definition: typeof verifyDefinition;
  readonly maxTicks?: number;
}) =>
  Effect.gen(function* () {
    const workspacePath = makeRepository();
    const runner = yield* FactoryRunner;
    const store = yield* FactoryStore;

    const run = yield* runner.startRun({
      definition: input.definition,
      workItemId: WorkItemId.makeUnsafe(`item-${workspacePath.slice(-8)}`),
      workspaceId: null,
      projectId: null,
      threadId: ThreadId.makeUnsafe(workspacePath),
    });

    for (let index = 0; index < (input.maxTicks ?? 8); index += 1) {
      yield* runner.tick();
      const stored = yield* store.readRun(run.id);
      if (stored && stored.run.state !== "pending" && stored.run.state !== "running") break;
    }

    const snapshot = yield* store.readRunSnapshot(run.id);
    if (!snapshot) throw new Error("a started run must have a snapshot");
    const timeline = buildFactoryTimeline(snapshot, {
      nowMs: Date.now(),
      runStartedAtMs: Date.parse(run.createdAt),
      runEndedAtMs: null,
    });
    return { timeline, snapshot, stored: yield* store.readRun(run.id) };
  });

const laneOf = (timeline: { lanes: readonly { id: string }[] }, id: string) => {
  const lane = timeline.lanes.find((candidate) => candidate.id === id);
  assert.isDefined(lane, `expected a ${id} lane`);
  return lane as never as {
    blocks: readonly { node: { id: string }; status: string; durationMs: number }[];
    pending: readonly { node: { id: string }; status: string }[];
  };
};

describe("Factory session timeline over a real run", () => {
  it.effect("draws deterministic work as timed blocks in the code lane", () =>
    Effect.gen(function* () {
      const { timeline, stored } = yield* startAndProject({
        definition: {
          ...verifyDefinition,
          nodes: verifyDefinition.nodes.map((node) =>
            node.kind === "test" ? { ...node, command: "sleep 0.2; exit 0" } : node,
          ),
        },
      });

      assert.strictEqual(stored?.run.state, "succeeded");
      const workspace = laneOf(timeline, "workspace");
      assert.isTrue(workspace.blocks.length > 0);
      assert.isTrue(workspace.blocks.every((block) => block.status === "complete"));
      // Real subprocess time, not a placeholder width.
      assert.isTrue(workspace.blocks.some((block) => block.durationMs > 0));
      assert.deepStrictEqual(workspace.pending, []);
      assert.isTrue(timeline.hasStarted);
    }).pipe(Effect.provide(freshFactory())),
  );

  it.effect("shows an agent node this machine cannot run as attempts that failed", () =>
    Effect.gen(function* () {
      // No target reports `agent`, so the plan node is refused at provisioning
      // and never reaches `running`. The operator still has to see a worker that
      // tried and gave up: attempts with no start time belong on the axis, not in
      // the not-started stack, or a run that failed three times reads as untouched.
      const { timeline } = yield* startAndProject({
        definition: tracerDefinition as unknown as typeof verifyDefinition,
        maxTicks: 4,
      });

      const planner = laneOf(timeline, "agent:plan");
      assert.strictEqual(planner.blocks.length, tracerDefinition.policy.maxAttemptsPerNode);
      assert.isTrue(planner.blocks.every((block) => block.status === "failed"));
      assert.deepStrictEqual(planner.pending, []);

      // Everything downstream stays visible as the plan it still is.
      const builder = laneOf(timeline, "agent:build");
      assert.deepStrictEqual(
        builder.pending.map((item) => item.status),
        ["blocked-by-dependency"],
      );
    }).pipe(Effect.provide(freshFactory())),
  );

  it.effect("keeps every node of the definition on some lane before anything runs", () =>
    Effect.gen(function* () {
      // The intended factory has to be legible before it executes, so no node may
      // be dropped by lane assignment.
      const { timeline } = yield* startAndProject({
        definition: tracerDefinition as unknown as typeof verifyDefinition,
        maxTicks: 1,
      });
      const placed = timeline.lanes.flatMap((lane) => [
        ...lane.blocks.map((block) => block.node.id),
        ...lane.pending.map((item) => item.node.id),
      ]);
      for (const node of tracerDefinition.nodes) assert.include(placed, node.id);
    }).pipe(Effect.provide(freshFactory())),
  );
});

// Checkouts outlive the tests that made them, so they are removed once at the end
// rather than per test.
process.on("exit", () => {
  for (const path of repositories) rmSync(path, { recursive: true, force: true });
});
