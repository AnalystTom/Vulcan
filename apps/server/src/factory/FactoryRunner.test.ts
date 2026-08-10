import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { WorkItemId } from "@vulcan/contracts";
import { CHECKOUT_VERIFY_WORKFLOW_YAML } from "@vulcan/shared/checkoutVerifyWorkflow";
import { TRACER_BULLET_WORKFLOW_YAML } from "@vulcan/shared/tracerBulletWorkflow";
import { parseWorkflowYaml } from "@vulcan/shared/workflowYaml";
import { Effect, Layer } from "effect";

import { FactoryStore } from "../persistence/Services/FactoryStore.ts";
import { FactoryStoreLive } from "../persistence/Layers/FactoryStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { FactoryRunnerLive } from "./Layers/FactoryRunner.ts";
import { FactoryRunner } from "./Services/FactoryRunner.ts";

/**
 * A fresh database per test.
 *
 * `tick()` is deliberately global -- one pass supervises every active run -- so
 * sharing a database between tests would let one test's run be advanced by
 * another test's tick. Isolation has to be at the storage layer, not the caller.
 */
const freshFactory = () =>
  FactoryRunnerLive.pipe(
    Layer.provideMerge(FactoryStoreLive),
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

/**
 * A real git checkout whose "checks" are a command we control, so the test
 * asserts the controller's behaviour rather than this repo's test suite.
 */
function makeRepository(): string {
  const path = mkdtempSync(join(tmpdir(), "vulcan-runner-"));
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

const headOf = (path: string) =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();

/** The verify workflow with its test command swapped for one this test controls. */
const definitionWithCommand = (command: string) => ({
  ...verifyDefinition,
  nodes: verifyDefinition.nodes.map((node) => (node.kind === "test" ? { ...node, command } : node)),
});

const startAndDrain = (input: {
  readonly definition: typeof verifyDefinition;
  readonly workspacePath: string;
  readonly maxTicks?: number;
}) =>
  Effect.gen(function* () {
    const runner = yield* FactoryRunner;
    const store = yield* FactoryStore;
    const run = yield* runner.startRun({
      definition: input.definition,
      workItemId: WorkItemId.makeUnsafe(`item-${input.workspacePath.slice(-8)}`),
      workspacePath: input.workspacePath,
      workspaceId: null,
      projectId: null,
      threadId: null,
    });

    // Tick until the run settles. Each tick dispatches whatever the kernel says
    // is ready, so a linear workflow needs one tick per node.
    const reports = [];
    for (let index = 0; index < (input.maxTicks ?? 8); index += 1) {
      const report = yield* runner.tick();
      reports.push(report);
      const stored = yield* store.readRun(run.id);
      if (stored && stored.run.state !== "pending" && stored.run.state !== "running") break;
    }

    const snapshot = yield* store.readRunSnapshot(run.id);
    const stored = yield* store.readRun(run.id);
    const attention = yield* store.listOpenAttentionItems({ runId: run.id });
    return { run, snapshot, stored, attention, reports, store, runner };
  });

describe("FactoryRunner", () => {
  it.effect("refuses to start a run somewhere evidence could not be pinned", () =>
    Effect.gen(function* () {
      const runner = yield* FactoryRunner;
      const notARepo = mkdtempSync(join(tmpdir(), "vulcan-norepo-"));
      repositories.push(notARepo);

      const outcome = yield* Effect.result(
        runner.startRun({
          definition: verifyDefinition,
          workItemId: WorkItemId.makeUnsafe("item-norepo"),
          workspacePath: notARepo,
          workspaceId: null,
          projectId: null,
          threadId: null,
        }),
      );
      assert.strictEqual(outcome._tag, "Failure");
    }).pipe(Effect.provide(freshFactory())),
  );

  it.effect("reports only the capabilities this machine actually has", () =>
    Effect.gen(function* () {
      // Claiming a capability we cannot perform would make the scheduler dispatch
      // work nothing can do, which is the failure the product forbids.
      const runner = yield* FactoryRunner;
      const target = yield* runner.localTarget();
      assert.deepStrictEqual([...target.capabilities].toSorted(), ["git", "node", "shell"]);
      assert.isFalse(target.capabilities.includes("agent"));
      assert.isFalse(target.capabilities.includes("browser"));
    }).pipe(Effect.provide(freshFactory())),
  );

  it.effect("drives a real workflow to a passed gate against a real revision", () =>
    Effect.gen(function* () {
      const workspacePath = makeRepository();
      const { snapshot, stored, attention } = yield* startAndDrain({
        definition: definitionWithCommand("exit 0"),
        workspacePath,
      });

      assert.strictEqual(stored?.run.state, "succeeded");
      assert.deepStrictEqual(attention, []);
      assert.isNotNull(snapshot);
      if (!snapshot) return;

      // Real artifacts from real subprocesses, pinned to the real HEAD.
      const head = headOf(workspacePath);
      assert.strictEqual(snapshot.currentRevision, head);
      const kinds = snapshot.artifacts.map((artifact) => artifact.kind).toSorted();
      assert.deepStrictEqual(kinds, ["command-output", "test-results"]);
      for (const artifact of snapshot.artifacts) assert.strictEqual(artifact.revision, head);

      // The gate cites the evidence it read, at that revision.
      const gate = snapshot.gateResults.at(-1);
      assert.strictEqual(gate?.passed, true);
      assert.strictEqual(gate?.revision, head);
      for (const check of gate?.checks ?? []) {
        assert.isTrue(check.passed);
        assert.isTrue(check.evidenceArtifactIds.length > 0);
      }

      // Every attempt reached a terminal state and nothing holds a target.
      assert.isTrue(snapshot.attempts.every((attempt) => attempt.state === "succeeded"));
      assert.deepStrictEqual(yield* (yield* FactoryStore).listLeases(), []);
    }).pipe(Effect.provide(freshFactory())),
  );

  it.effect("captures a failing command as failing evidence and refuses the gate", () =>
    Effect.gen(function* () {
      const workspacePath = makeRepository();
      const { snapshot, stored } = yield* startAndDrain({
        definition: definitionWithCommand("echo 'checks failed' >&2; exit 3"),
        workspacePath,
      });

      assert.strictEqual(stored?.run.state, "failed");
      const testArtifacts =
        snapshot?.artifacts.filter((artifact) => artifact.kind === "test-results") ?? [];
      assert.isTrue(testArtifacts.length > 0);
      // The exit code is evidence, recorded, not a verdict swallowed by the loop.
      assert.isTrue(testArtifacts.every((artifact) => artifact.outcome === "failed"));
      assert.isTrue(testArtifacts[0]?.summary.includes("exit 3"));
      // Never reached the gate, so nothing claimed completion.
      assert.deepStrictEqual(snapshot?.gateResults, []);
    }).pipe(Effect.provide(freshFactory())),
  );

  it.effect("retries a failing node up to the policy limit and no further", () =>
    Effect.gen(function* () {
      const workspacePath = makeRepository();
      const { snapshot } = yield* startAndDrain({
        definition: definitionWithCommand("exit 1"),
        workspacePath,
      });

      const testAttempts = snapshot?.attempts.filter((attempt) => attempt.nodeId === "test") ?? [];
      assert.strictEqual(testAttempts.length, verifyDefinition.policy.maxAttemptsPerNode);
      assert.isTrue(testAttempts.every((attempt) => attempt.state === "failed"));
    }).pipe(Effect.provide(freshFactory())),
  );

  it.effect("asks a person when a node needs a capability nothing reports", () =>
    Effect.gen(function* () {
      // The tracer bullet's plan node requires `agent`, which this server does
      // not provide. Routing must refuse it and hand over, not fake it.
      const workspacePath = makeRepository();
      const { stored, attention } = yield* startAndDrain({
        definition: tracerDefinition as unknown as typeof verifyDefinition,
        workspacePath,
        maxTicks: 3,
      });

      assert.notStrictEqual(stored?.run.state, "succeeded");
      assert.isTrue(attention.length > 0);
      const first = attention[0];
      assert.strictEqual(first?.reason, "missing-capability");
      assert.isTrue(first?.request.includes("agent"));
      // Nothing was executed on its behalf.
      assert.deepStrictEqual(yield* (yield* FactoryStore).listLeases(), []);
    }).pipe(Effect.provide(freshFactory())),
  );

  it.effect("resumes a run from storage rather than from memory", () =>
    Effect.gen(function* () {
      // The controller keeps no run state between ticks: every tick rebuilds the
      // snapshot from the database, which is what makes a restart survivable.
      const workspacePath = makeRepository();
      const runner = yield* FactoryRunner;
      const store = yield* FactoryStore;

      const run = yield* runner.startRun({
        definition: definitionWithCommand("exit 0"),
        workItemId: WorkItemId.makeUnsafe("item-resume"),
        workspacePath,
        workspaceId: null,
        projectId: null,
        threadId: null,
      });

      yield* runner.tick();
      const afterFirst = yield* store.readRunSnapshot(run.id);
      assert.strictEqual(afterFirst?.attempts.length, 1);

      // A fresh snapshot read is all the next tick uses.
      yield* runner.tick();
      const afterSecond = yield* store.readRunSnapshot(run.id);
      assert.strictEqual(afterSecond?.attempts.length, 2);
      assert.strictEqual(afterSecond?.attempts[0]?.state, "succeeded");
    }).pipe(Effect.provide(freshFactory())),
  );

  it.effect("does nothing on a tick with no active runs", () =>
    Effect.gen(function* () {
      const runner = yield* FactoryRunner;
      const report = yield* runner.tick();
      assert.strictEqual(report.nodesDispatched, 0);
      assert.strictEqual(report.attentionItemsRaised, 0);
    }).pipe(Effect.provide(freshFactory())),
  );
});

// Repositories are shared across the layer block, so they are removed once at the
// end rather than per test.
process.on("exit", () => {
  for (const path of repositories) rmSync(path, { recursive: true, force: true });
});
