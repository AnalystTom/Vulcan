// FILE: SssfTraceSource.test.ts
// Purpose: Read a real `sssf.db` and assert we see what the factory wrote.
// Layer: server integration test
//
// Every case here is about being handed someone else's file: a trace from an
// older tracer, a session still running, a payload that does not parse. The
// reader has to survive all of them, because a monitor that breaks when the
// thing it monitors is mid-flight is not a monitor.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { AdwId, ThreadId } from "@vulcan/contracts";
import { Effect, Layer } from "effect";

import { buildFactoryTraceTimeline } from "@vulcan/shared/factoryTraceTimeline";

import { SssfTraceSourceLive } from "./Layers/SssfTraceSource.ts";
import { FactoryTraceSource } from "./Services/FactoryTraceSource.ts";
import { TraceWorkspaces } from "./Services/TraceWorkspaces.ts";
import { writeTraceFixture, type TraceFixture } from "./traceFixture.ts";

const workspaces: string[] = [];

/** A workspace directory whose thread id is its own path, as in the runner tests. */
function makeWorkspace(): string {
  const path = mkdtempSync(join(tmpdir(), "vulcan-trace-"));
  workspaces.push(path);
  return path;
}

const fixedWorkspaces = Layer.succeed(TraceWorkspaces)({
  resolveThreadWorkspacePath: (threadId) =>
    Effect.succeed(threadId.startsWith("/") ? threadId : null),
});

const live = () => SssfTraceSourceLive.pipe(Layer.provideMerge(fixedWorkspaces));

const at = (seconds: number) => new Date(Date.UTC(2026, 7, 10, 12, 0, seconds)).toISOString();

/**
 * The shape of a real run: an engineer request, a planner, a builder that had to
 * be corrected once, a deterministic test phase, and a documenter still queued.
 */
const RUN: TraceFixture = {
  sessions: [
    {
      adw_id: "d140d7dd",
      adw_name: "adw_simple_sdlc",
      request: "Give the editor a side-by-side markdown view",
      status: "running",
      engineer: "IndyDevDan",
      started_at: at(0),
      ended_at: null,
      total_tokens: 1_390_000,
      total_cost: 2.08,
      archived: 0,
    },
  ],
  phases: [
    {
      phase_id: "p-request",
      adw_id: "d140d7dd",
      seq: 0,
      name: "request",
      kind: "engineer",
      owner: "IndyDevDan",
      description: "Capture the incoming ask",
      status: "success",
      attempt: 1,
      retries: 0,
      started_at: at(0),
      ended_at: at(1),
    },
    {
      phase_id: "p-plan",
      adw_id: "d140d7dd",
      seq: 1,
      name: "plan",
      kind: "agent",
      owner: "planner",
      description: "Turn the request into an implementable plan",
      status: "success",
      attempt: 1,
      retries: 0,
      started_at: at(10),
      ended_at: at(190),
    },
    {
      phase_id: "p-build",
      adw_id: "d140d7dd",
      seq: 2,
      name: "build",
      kind: "agent",
      owner: "builder",
      description: "Implement the plan exactly",
      status: "running",
      attempt: 2,
      retries: 1,
      started_at: at(200),
      ended_at: null,
    },
    {
      phase_id: "p-test",
      adw_id: "d140d7dd",
      seq: 3,
      name: "test",
      kind: "code",
      owner: "git",
      description: "Run the suite",
      status: "success",
      attempt: 1,
      retries: 0,
      started_at: at(195),
      ended_at: at(198),
    },
    {
      phase_id: "p-document",
      adw_id: "d140d7dd",
      seq: 4,
      name: "document",
      kind: "agent",
      owner: "documenter",
      description: "Write up what shipped",
      status: "queued",
      attempt: 0,
      retries: 0,
      started_at: null,
      ended_at: null,
    },
  ],
  events: [
    {
      event_id: "e1",
      adw_id: "d140d7dd",
      phase_id: "p-plan",
      type: "agent_start",
      name: "planner",
      payload_json: JSON.stringify({ model: "claude-opus-5", color: "#a78bfa" }),
      started_at: at(10),
    },
    {
      event_id: "e2",
      adw_id: "d140d7dd",
      phase_id: "p-plan",
      type: "tool_call",
      name: "read: specs/plan.md",
      payload_json: JSON.stringify({ tool: "read", ok: true, duration_ms: 30 }),
      started_at: at(60),
      ended_at: at(61),
    },
    {
      event_id: "e3",
      adw_id: "d140d7dd",
      phase_id: "p-plan",
      type: "tool_call",
      name: "bash: ls -la src",
      payload_json: JSON.stringify({ tool: "bash", ok: false }),
      started_at: at(120),
      ended_at: at(121),
    },
    {
      event_id: "e4",
      adw_id: "d140d7dd",
      phase_id: "p-plan",
      type: "agent_end",
      name: "planner",
      payload_json: JSON.stringify({
        cost: 0.42,
        usage: {
          input_tokens: 1_000,
          output_tokens: 300,
          cache_read_tokens: 90_000,
          cache_write_tokens: 500,
        },
        context_tokens: 12_000,
        context_window: 200_000,
      }),
      started_at: at(190),
    },
    {
      event_id: "e5",
      adw_id: "d140d7dd",
      phase_id: "p-build",
      type: "agent_start",
      name: "builder",
      // A payload that does not parse must cost its own detail, never the read.
      payload_json: "{not json",
      started_at: at(200),
    },
  ],
  envelopes: [
    {
      envelope_id: "env1",
      adw_id: "d140d7dd",
      phase_id: "p-plan",
      agent: "planner",
      output_type: "PlanOutput",
      payload_json: JSON.stringify({ status: "success", artifacts: ["specs/plan.md"] }),
      valid: 1,
      attempt: 1,
      created_at: at(190),
    },
  ],
  gateResults: [
    {
      id: 1,
      adw_id: "d140d7dd",
      phase_id: "p-plan",
      attempt: 1,
      gate: "artifacts_exist",
      passed: 1,
      violations_json: "[]",
      checks_json: JSON.stringify([{ item: "specs/plan.md", ok: true, note: "exists, 454B" }]),
      created_at: at(190),
    },
  ],
  agentSessions: [
    {
      adw_id: "d140d7dd",
      agent: "planner",
      coding_agent: "pi",
      model: "claude-opus-5",
      color: "#a78bfa",
      session_id: "s1",
      context_tokens: 12_000,
      context_window: 200_000,
      created_at: at(10),
      last_used_at: at(190),
    },
  ],
};

const withTrace = <A>(
  fixture: TraceFixture,
  use: (input: { threadId: ThreadId }) => Effect.Effect<A, unknown, FactoryTraceSource>,
) =>
  Effect.gen(function* () {
    const workspace = makeWorkspace();
    yield* Effect.promise(() =>
      writeTraceFixture(join(workspace, "adws/adw_data/sssf.db"), fixture),
    );
    return yield* use({ threadId: ThreadId.makeUnsafe(workspace) });
  }).pipe(Effect.provide(live()));

describe("reading a factory trace", () => {
  it.effect("reports where the trace is and that it is WAL", () =>
    withTrace(RUN, ({ threadId }) =>
      Effect.gen(function* () {
        const source = yield* FactoryTraceSource;
        const status = yield* source.status({ threadId });
        assert.strictEqual(status.state, "ready");
        if (status.state !== "ready") return;
        assert.strictEqual(status.sessionCount, 1);
        assert.strictEqual(status.journalMode.toLowerCase(), "wal");
        assert.isTrue(status.databasePath.endsWith("adws/adw_data/sssf.db"));
      }),
    ),
  );

  it.effect("calls a workspace with no factory absent, not broken", () =>
    Effect.gen(function* () {
      const source = yield* FactoryTraceSource;
      const status = yield* source.status({ threadId: ThreadId.makeUnsafe(makeWorkspace()) });
      // The ordinary state of most repos: nothing to read, nothing wrong.
      assert.strictEqual(status.state, "absent");
    }).pipe(Effect.provide(live())),
  );

  it.effect("says there is nowhere to look when the thread has no workspace", () =>
    Effect.gen(function* () {
      const source = yield* FactoryTraceSource;
      const status = yield* source.status({ threadId: ThreadId.makeUnsafe("no-such-thread") });
      assert.strictEqual(status.state, "no-workspace");
    }).pipe(Effect.provide(live())),
  );

  it.effect("lists sessions with their phases and agents", () =>
    withTrace(RUN, ({ threadId }) =>
      Effect.gen(function* () {
        const source = yield* FactoryTraceSource;
        const sessions = yield* source.listSessions({ threadId });
        assert.strictEqual(sessions.length, 1);
        const [summary] = sessions;
        assert.strictEqual(
          summary?.session.request,
          "Give the editor a side-by-side markdown view",
        );
        assert.strictEqual(summary?.session.status, "running");
        assert.strictEqual(summary?.phases.length, 5);
        // The builder is running and has no agent_sessions row yet, so its entry
        // comes from its agent_start event.
        assert.deepStrictEqual(summary?.agents.map((agent) => agent.agent).toSorted(), [
          "builder",
          "planner",
        ]);
      }),
    ),
  );

  it.effect("reads one session with its evidence and its cursor", () =>
    withTrace(RUN, ({ threadId }) =>
      Effect.gen(function* () {
        const source = yield* FactoryTraceSource;
        const detail = yield* source.readSession({
          threadId,
          adwId: AdwId.makeUnsafe("d140d7dd"),
        });
        assert.isNotNull(detail);
        if (!detail) return;

        assert.strictEqual(detail.events.length, 5);
        assert.isTrue(detail.cursor > 0);
        assert.strictEqual(detail.envelopes[0]?.outputType, "PlanOutput");
        assert.strictEqual(detail.envelopes[0]?.valid, true);

        // A gate's evidence survives as evidence, not as a bare verdict.
        assert.strictEqual(detail.gates[0]?.passed, true);
        assert.deepStrictEqual(detail.gates[0]?.checks, [
          { item: "specs/plan.md", ok: true, note: "exists, 454B" },
        ]);
        assert.deepStrictEqual(detail.gates[0]?.violations, []);

        // Usage is what moved, not what was billed: 1000 new input + 500 cache
        // writes read, 300 written. The 90k cache read is the same context again.
        assert.deepStrictEqual(detail.usage, { read: 1_500, written: 300 });

        const planner = detail.agents.find((agent) => agent.agent === "planner");
        assert.strictEqual(planner?.model, "claude-opus-5");
        assert.strictEqual(planner?.contextTokens, 12_000);
        assert.strictEqual(planner?.contextWindow, 200_000);
      }),
    ),
  );

  it.effect("returns only what is past the cursor", () =>
    withTrace(RUN, ({ threadId }) =>
      Effect.gen(function* () {
        const source = yield* FactoryTraceSource;
        const adwId = AdwId.makeUnsafe("d140d7dd");
        const first = yield* source.readSession({ threadId, adwId });
        assert.isNotNull(first);
        if (!first) return;

        // The whole polling contract: ask again from the cursor and a trace that
        // has not moved returns nothing, with the cursor unchanged.
        const second = yield* source.readSession({ threadId, adwId, after: first.cursor });
        assert.deepStrictEqual(second?.events, []);
        assert.strictEqual(second?.cursor, first.cursor);
      }),
    ),
  );

  it.effect("survives a trace written before the newer columns existed", () =>
    withTrace(
      {
        ...RUN,
        legacy: true,
        agentSessions: [],
        sessions: legacySessions(),
        gateResults: legacyGateResults(),
      },
      ({ threadId }) =>
        Effect.gen(function* () {
          const source = yield* FactoryTraceSource;
          const detail = yield* source.readSession({
            threadId,
            adwId: AdwId.makeUnsafe("d140d7dd"),
          });
          assert.isNotNull(detail);
          if (!detail) return;
          // Missing columns read as "this trace predates them", never as a failure.
          assert.strictEqual(detail.session.adwName, null);
          assert.strictEqual(detail.session.archived, false);
          assert.strictEqual(detail.gates[0]?.checks, null);
          assert.strictEqual(detail.gates[0]?.passed, true);
          // The lane still gets its label from the agent_start event.
          assert.strictEqual(
            detail.agents.find((agent) => agent.agent === "planner")?.model,
            "claude-opus-5",
          );
        }),
    ),
  );

  it.effect("returns null for a session the trace does not have", () =>
    withTrace(RUN, ({ threadId }) =>
      Effect.gen(function* () {
        const source = yield* FactoryTraceSource;
        const detail = yield* source.readSession({ threadId, adwId: AdwId.makeUnsafe("nope") });
        assert.isNull(detail);
      }),
    ),
  );
});

/** A gate row from before checks were recorded: a verdict and nothing behind it. */
function legacyGateResults() {
  return [
    {
      id: 1,
      adw_id: "d140d7dd",
      phase_id: "p-plan",
      attempt: 1,
      gate: "artifacts_exist",
      passed: 1,
      violations_json: "[]",
      created_at: at(190),
    },
  ];
}

/** A phase row, in the column order their tracer writes. */
function phaseRow(
  phaseId: string,
  seq: number,
  name: string,
  kind: string,
  owner: string,
  startedAt: string | null,
  endedAt: string | null,
  status = "success",
) {
  return {
    phase_id: phaseId,
    adw_id: "b17c",
    seq,
    name,
    kind,
    owner,
    description: `${name} phase`,
    status,
    attempt: 1,
    retries: 0,
    started_at: startedAt,
    ended_at: endedAt,
  };
}

/** An `agent_sessions` row: who the agent is and how full its window got. */
function agentRow(agent: string, model: string, color: string, contextTokens: number | null) {
  return {
    adw_id: "b17c",
    agent,
    coding_agent: "pi",
    model,
    color,
    session_id: `s-${agent}`,
    context_tokens: contextTokens,
    context_window: contextTokens === null ? null : 200_000,
    created_at: at(0),
    last_used_at: at(400),
  };
}

/** The session row an older tracer wrote: no `adw_name`, no `archived`. */
function legacySessions() {
  return [
    {
      adw_id: "d140d7dd",
      request: "Give the editor a side-by-side markdown view",
      status: "running",
      engineer: "IndyDevDan",
      started_at: at(0),
      ended_at: null,
      total_tokens: 1_390_000,
      total_cost: 2.08,
    },
  ];
}

/**
 * A dev -> review chain with a bounded revise loop, as `adw_build_review.py`
 * writes it: the reviewer runs twice around one builder revision.
 */
const DEV_REVIEW: TraceFixture = {
  sessions: [
    {
      adw_id: "b17c",
      adw_name: "adw_build_review",
      request: "Add a /health endpoint",
      status: "success",
      engineer: "dan",
      started_at: at(0),
      ended_at: at(400),
      total_tokens: 900_000,
      total_cost: 1.1,
      archived: 0,
    },
  ],
  phases: [
    phaseRow("q0", 0, "request", "engineer", "dan", at(0), at(1)),
    phaseRow("q1", 1, "build", "agent", "builder", at(5), at(120)),
    phaseRow("q2", 2, "review_1", "agent", "reviewer", at(125), at(180)),
    phaseRow("q3", 3, "revise_1", "agent", "builder", at(185), at(300)),
    phaseRow("q4", 4, "review_2", "agent", "reviewer", at(305), at(360)),
    phaseRow("q5", 5, "commit", "code", "git", at(365), at(366)),
    phaseRow("q6", 6, "document", "agent", "documenter", null, null, "queued"),
  ],
  agentSessions: [
    agentRow("builder", "kimi-k3", "#22d3ee", 8_400),
    agentRow("reviewer", "gpt-5.6-terra", "#fb7185", 5_200),
    agentRow("documenter", "gpt-5.6-luna", "#e879f9", null),
  ],
};

describe("showing agents by their role", () => {
  it.effect("gives each agent its own lane, with the model and colour its role declares", () =>
    withTrace(DEV_REVIEW, ({ threadId }) =>
      Effect.gen(function* () {
        const source = yield* FactoryTraceSource;
        const detail = yield* source.readSession({ threadId, adwId: AdwId.makeUnsafe("b17c") });
        assert.isNotNull(detail);
        if (!detail) return;

        const timeline = buildFactoryTraceTimeline({
          phases: detail.phases,
          agents: detail.agents,
          events: detail.events,
          sessionStartedAt: detail.session.startedAt,
          sessionEndedAt: detail.session.endedAt,
          nowMs: Date.parse(at(400)),
        });

        // The human, the deterministic step, and each agent are separate lanes,
        // in that order -- which is the whole point of the three kinds.
        assert.deepStrictEqual(
          timeline.lanes.map((lane) => lane.id),
          ["engineer:dan", "code:git", "agent:builder", "agent:reviewer", "agent:documenter"],
        );

        const builder = timeline.lanes.find((lane) => lane.id === "agent:builder");
        const reviewer = timeline.lanes.find((lane) => lane.id === "agent:reviewer");
        const documenter = timeline.lanes.find((lane) => lane.id === "agent:documenter");

        // Each lane wears the roster's own model and swatch for that role.
        assert.strictEqual(builder?.model, "kimi-k3");
        assert.strictEqual(builder?.color, "#22d3ee");
        assert.strictEqual(reviewer?.model, "gpt-5.6-terra");
        assert.strictEqual(reviewer?.color, "#fb7185");

        // A role that ran twice is one worker going round again, not two lanes.
        assert.deepStrictEqual(
          builder?.blocks.map((block) => block.phase.name),
          ["build", "revise_1"],
        );
        assert.deepStrictEqual(
          reviewer?.blocks.map((block) => block.phase.name),
          ["review_1", "review_2"],
        );

        // A role that has not run yet still has its lane and its model, so the
        // intended chain is legible before it executes.
        assert.deepStrictEqual(documenter?.blocks, []);
        assert.deepStrictEqual(
          documenter?.pending.map((phase) => phase.name),
          ["document"],
        );
        assert.strictEqual(documenter?.model, "gpt-5.6-luna");
        // Occupancy is unknown until a turn closes, so no bar is drawn.
        assert.isNull(documenter?.context ?? null);
        assert.strictEqual(reviewer?.context?.used, 5_200);
      }),
    ),
  );

  it.effect("keeps the lanes in step with the axis while a role is mid-turn", () =>
    withTrace(DEV_REVIEW, ({ threadId }) =>
      Effect.gen(function* () {
        const source = yield* FactoryTraceSource;
        const detail = yield* source.readSession({ threadId, adwId: AdwId.makeUnsafe("b17c") });
        if (!detail) return;
        const timeline = buildFactoryTraceTimeline({
          phases: detail.phases,
          agents: detail.agents,
          events: detail.events,
          sessionStartedAt: detail.session.startedAt,
          sessionEndedAt: detail.session.endedAt,
          nowMs: Date.parse(at(400)),
        });
        const builder = timeline.lanes.find((lane) => lane.id === "agent:builder");
        const reviewer = timeline.lanes.find((lane) => lane.id === "agent:reviewer");
        // The reviewer's first block starts after the builder's first ends: the
        // chain reads left to right without either lane borrowing space.
        const buildEnd = (builder?.blocks[0]?.leftPct ?? 0) + (builder?.blocks[0]?.widthPct ?? 0);
        assert.isTrue((reviewer?.blocks[0]?.leftPct ?? 0) >= buildEnd - 0.001);
      }),
    ),
  );
});

process.on("exit", () => {
  for (const path of workspaces) rmSync(path, { recursive: true, force: true });
});
