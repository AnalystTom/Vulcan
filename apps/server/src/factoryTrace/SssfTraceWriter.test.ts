// FILE: SssfTraceWriter.test.ts
// Purpose: Prove native runtime events round-trip through a real SSSF database and the existing reader.
// Layer: server integration test

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AdwId, ThreadId, type ProviderRuntimeEvent } from "@vulcan/contracts";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { SssfTraceSourceLive } from "./Layers/SssfTraceSource.ts";
import { SssfTraceWriterLive } from "./Layers/SssfTraceWriter.ts";
import { FactoryTraceSource } from "./Services/FactoryTraceSource.ts";
import { FactoryTraceWriter } from "./Services/FactoryTraceWriter.ts";
import { TraceWorkspaces } from "./Services/TraceWorkspaces.ts";
import { traceAdwId } from "./traceMapping.ts";
import { writeTraceFixture } from "./traceFixture.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";

const workspaces: string[] = [];
const makeWorkspace = () => {
  const workspace = mkdtempSync(join(tmpdir(), "vulcan-trace-writer-"));
  workspaces.push(workspace);
  return workspace;
};

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

const fixedWorkspaces = Layer.succeed(TraceWorkspaces, {
  resolveThreadWorkspacePath: (threadId) => Effect.succeed(String(threadId)),
});
const projections = Layer.succeed(ProjectionSnapshotQuery, {
  getThreadDetailById: () =>
    Effect.succeed(
      Option.some({
        title: "Write native trace",
        modelSelection: { provider: "codex", model: "gpt-5.6" },
        messages: [{ role: "user", text: "Write native trace", turnId: "turn-1" }],
      }),
    ),
} as unknown as ProjectionSnapshotQuery["Service"]);
const provider = Layer.succeed(ProviderService, {
  streamEvents: Stream.empty,
} as unknown as ProviderService["Service"]);

const live = Layer.mergeAll(
  SssfTraceSourceLive.pipe(Layer.provideMerge(fixedWorkspaces)),
  SssfTraceWriterLive.pipe(
    Layer.provideMerge(fixedWorkspaces),
    Layer.provideMerge(projections),
    Layer.provideMerge(provider),
  ),
);

const runtimeEvent = (threadId: string, value: Record<string, unknown>) =>
  ({
    eventId: `${value.type}-${value.eventId ?? "1"}`,
    provider: "codex",
    threadId,
    createdAt: "2026-08-12T10:00:00.000Z",
    payload: {},
    ...value,
  }) as ProviderRuntimeEvent;

const writeTurn = (writer: FactoryTraceWriter["Service"], threadId: string) =>
  Effect.gen(function* () {
    yield* writer.append(
      runtimeEvent(threadId, {
        type: "session.configured",
        payload: { config: { model: "gpt-5.6", sessionId: "provider-session-1" } },
      }),
    );
    yield* writer.append(
      runtimeEvent(threadId, {
        type: "turn.started",
        eventId: "start",
        turnId: "turn-1",
        payload: { model: "gpt-5.6" },
      }),
    );
    yield* writer.append(
      runtimeEvent(threadId, {
        type: "thread.token-usage.updated",
        eventId: "usage",
        payload: { usage: { usedTokens: 400, maxTokens: 2_000, totalProcessedTokens: 900 } },
      }),
    );
    yield* writer.append(
      runtimeEvent(threadId, {
        type: "item.completed",
        eventId: "tool",
        turnId: "turn-1",
        itemId: "tool-1",
        payload: { itemType: "command_execution", title: "Run tests", detail: "All passed" },
      }),
    );
    yield* writer.append(
      runtimeEvent(threadId, {
        type: "turn.completed",
        eventId: "complete",
        turnId: "turn-1",
        createdAt: "2026-08-12T10:01:00.000Z",
        payload: { state: "completed", usage: { input_tokens: 120, output_tokens: 30 } },
      }),
    );
  });

describe("SssfTraceWriter", () => {
  it("round-trips sessions, phases, events, agents, and usage through SssfTraceSource", async () => {
    const workspace = makeWorkspace();
    const runtime = ManagedRuntime.make(live);
    try {
      const writer = await runtime.runPromise(Effect.service(FactoryTraceWriter));
      await runtime.runPromise(writeTurn(writer, workspace));
      const source = await runtime.runPromise(Effect.service(FactoryTraceSource));
      const detail = await runtime.runPromise(
        source.readSession({
          threadId: ThreadId.makeUnsafe(workspace),
          adwId: AdwId.makeUnsafe(traceAdwId(workspace)),
        }),
      );

      expect(detail?.session).toMatchObject({
        adwName: "vulcan",
        request: "Write native trace",
        status: "completed",
        totalTokens: 900,
      });
      expect(detail?.phases).toHaveLength(1);
      expect(detail?.phases[0]).toMatchObject({
        kind: "agent",
        owner: "codex",
        status: "completed",
      });
      expect(detail?.events.map((event) => event.type)).toEqual([
        "phase_start",
        "agent_start",
        "tool_call",
        "agent_end",
        "phase_end",
      ]);
      expect(detail?.agents[0]).toMatchObject({
        agent: "codex",
        codingAgent: "codex",
        model: "gpt-5.6",
        sessionId: "provider-session-1",
        contextTokens: 400,
        contextWindow: 2_000,
      });
      expect(detail?.usage).toEqual({ read: 120, written: 30 });
    } finally {
      await runtime.dispose();
    }
  });

  it("appends to an older schema without optional columns", async () => {
    const workspace = makeWorkspace();
    await writeTraceFixture(join(workspace, "adws/adw_data/sssf.db"), { legacy: true });
    const runtime = ManagedRuntime.make(live);
    try {
      const writer = await runtime.runPromise(Effect.service(FactoryTraceWriter));
      await runtime.runPromise(writeTurn(writer, workspace));
      const source = await runtime.runPromise(Effect.service(FactoryTraceSource));
      const sessions = await runtime.runPromise(
        source.listSessions({ threadId: ThreadId.makeUnsafe(workspace) }),
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.agents[0]).toMatchObject({ codingAgent: "codex", color: null });
    } finally {
      await runtime.dispose();
    }
  });

  it("never updates a pre-existing external session whose id collides", async () => {
    const workspace = makeWorkspace();
    const adwId = traceAdwId(workspace);
    await writeTraceFixture(join(workspace, "adws/adw_data/sssf.db"), {
      sessions: [
        {
          adw_id: adwId,
          adw_name: "external",
          request: "keep me",
          status: "running",
          total_tokens: 77,
        },
      ],
    });
    const runtime = ManagedRuntime.make(live);
    try {
      const writer = await runtime.runPromise(Effect.service(FactoryTraceWriter));
      await runtime.runPromise(writeTurn(writer, workspace));
      const source = await runtime.runPromise(Effect.service(FactoryTraceSource));
      const detail = await runtime.runPromise(
        source.readSession({
          threadId: ThreadId.makeUnsafe(workspace),
          adwId: AdwId.makeUnsafe(adwId),
        }),
      );
      expect(detail?.session).toMatchObject({
        adwName: "external",
        request: "keep me",
        totalTokens: 77,
      });
      expect(detail?.phases).toEqual([]);
      expect(detail?.events).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });
});
