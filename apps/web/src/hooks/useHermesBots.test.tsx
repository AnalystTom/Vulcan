import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { WsRpcError } from "@vulcan/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  hermesKeys,
  parseProfileDetail,
  parseChatMessages,
  parseProfileList,
  parseRoutineList,
  parseRoomList,
  readHermesRoomLog,
  routeEventInvalidation,
  resolveCanonicalChat,
  shouldRetryHermesRegistryRead,
  useHermesProfileMutations,
  useHermesRoutineMutations,
  useHermesRoomMutations,
} from "./useHermesBots";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    hermesBots: {
      status: vi.fn(),
      connect: vi.fn(),
      request: mocks.request,
      onEvent: vi.fn(() => () => undefined),
    },
  }),
}));

vi.mock("../components/ui/toast", () => ({
  toastManager: { add: mocks.toast },
}));

function renderMutations() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const captured: { current: ReturnType<typeof useHermesRoomMutations> | null } = { current: null };

  function Probe(): ReactNode {
    captured.current = useHermesRoomMutations();
    return null;
  }

  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  );
  if (!captured.current) throw new Error("Room mutation hook did not render.");
  return captured.current;
}

function renderRoutineMutations(profile: string | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const captured: { current: ReturnType<typeof useHermesRoutineMutations> | null } = {
    current: null,
  };

  function Probe(): ReactNode {
    captured.current = useHermesRoutineMutations(profile);
    return null;
  }

  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  );
  if (!captured.current) throw new Error("Routine mutation hook did not render.");
  return captured.current;
}

function renderProfileMutations() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const captured: { current: ReturnType<typeof useHermesProfileMutations> | null } = {
    current: null,
  };

  function Probe(): ReactNode {
    captured.current = useHermesProfileMutations();
    return null;
  }

  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  );
  if (!captured.current) throw new Error("Profile mutation hook did not render.");
  return captured.current;
}

describe("Hermes profile model qualification", () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.toast.mockReset();
  });

  const selection = { provider: "openai-codex", model: "gpt-5.6-luna" };
  const verified = {
    ok: true,
    status: "smoke_verified",
    profile: "alpha",
    ...selection,
    response_model: selection.model,
  };

  it("checks the selected model in the target profile before saving any changes", async () => {
    mocks.request.mockResolvedValueOnce(verified).mockResolvedValueOnce({
      ok: true,
      applied: { model: true },
    });
    await renderProfileMutations().configure.mutateAsync({ name: "alpha", model: selection });
    expect(mocks.request.mock.calls.map(([request]) => request)).toEqual([
      { method: "model.check", params: { profile: "alpha", ...selection } },
      { method: "profiles.configure", params: { name: "alpha", ...selection } },
    ]);
  });

  it("rejects an edited empty toolset selection before any native RPC", async () => {
    await expect(
      renderProfileMutations().configure.mutateAsync({
        name: "alpha",
        model: selection,
        enabledToolsets: [],
      }),
    ).rejects.toThrow("Select at least one toolset");
    expect(mocks.request).not.toHaveBeenCalled();

    mocks.request.mockResolvedValueOnce({ ok: true, applied: { toolsets: true } });
    await renderProfileMutations().configure.mutateAsync({
      name: "alpha",
      enabledToolsets: ["browser"],
    });
    expect(mocks.request).toHaveBeenCalledWith({
      method: "profiles.configure",
      params: { name: "alpha", enabled_toolsets: ["browser"] },
    });
  });

  it.each([
    { ok: false, reason: "request_rejected", error: "OAuth authentication is not allowed" },
    { ...verified, response_model: "different-model" },
    { ...verified, profile: "other-profile" },
    { ...verified, status: "unqualified" },
  ])("does not configure a model without matching native evidence: %j", async (result) => {
    mocks.request.mockResolvedValueOnce(result);
    await expect(
      renderProfileMutations().configure.mutateAsync({
        name: "alpha",
        model: selection,
        description: "Updated role",
      }),
    ).rejects.toThrow("Hermes could not verify");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
});

const room = {
  room_id: "room-1",
  name: "Launch",
  members: [
    { member_id: "alpha", profile: "alpha", handle: "alpha" },
    { member_id: "beta", profile: "beta", handle: "beta" },
  ],
  authority_gateway_id: "install-1",
  authority_epoch: 1,
  revision: 1,
  created_at: 1,
  updated_at: 1,
  latest_seq: 0,
};

describe("useHermesRoomMutations", () => {
  beforeEach(() => {
    mocks.request.mockReset();
  });

  it("uses the native roster and idempotent discussion payloads", async () => {
    mocks.request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "groups.create") return { room };
      return {
        accepted: true,
        event: {
          room_id: "room-1",
          seq: 1,
          event_id: "event-1",
          kind: "message.user",
          actor: { kind: "user", id: "desktop" },
          authority_epoch: 1,
          payload: { text: "hello", thread_id: "event-1" },
          created_at: 1,
        },
      };
    });

    const mutations = renderMutations();
    await mutations.create.mutateAsync({ name: "Launch", profiles: ["alpha", "beta"] });
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "groups.create",
        params: expect.objectContaining({
          members: [
            { member_id: "alpha", profile: "alpha", handle: "alpha" },
            { member_id: "beta", profile: "beta", handle: "beta" },
          ],
        }),
      }),
    );

    await mutations.send.mutateAsync({ roomId: "room-1", clientEventId: "event-1", text: "hello" });
    expect(mocks.request).toHaveBeenCalledWith({
      method: "groups.send",
      params: {
        room_id: "room-1",
        event_id: "event-1",
        payload: { text: "hello", thread_id: "event-1" },
      },
    });
  });

  it("rejects a native-invalid one-member room before sending an RPC", async () => {
    const mutations = renderMutations();
    await expect(
      mutations.create.mutateAsync({ name: "Solo", profiles: ["alpha"] }),
    ).rejects.toThrow("between 2 and 6 members");
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

function roomEvent(seq: number) {
  return {
    room_id: "room-1",
    seq,
    event_id: `event-${seq}`,
    kind: "message.user",
    actor: { kind: "user", id: "desktop" },
    authority_epoch: 1,
    payload: { text: `message ${seq}`, thread_id: `thread-${seq}` },
    created_at: seq,
  };
}

describe("readHermesRoomLog", () => {
  beforeEach(() => {
    mocks.request.mockReset();
  });

  it("continues from the consumed cursor after bounded catch-up without duplicating rows", async () => {
    const cursors: number[] = [];
    mocks.request.mockImplementation(async ({ params }: { params: { since_seq: number } }) => {
      const since = params.since_seq;
      cursors.push(since);
      const seq = since + 1;
      return {
        events: [roomEvent(seq)],
        cursor: seq,
        latest_seq: 6,
        has_more: seq < 6,
        authority: { epoch: 1 },
      };
    });
    const queryClient = new QueryClient();

    const first = await readHermesRoomLog(queryClient, "room-1");
    expect(cursors).toEqual([0, 1, 2, 3, 4]);
    expect(first.latestSeq).toBe(5);
    expect(first.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);

    queryClient.setQueryData(hermesKeys.roomLog("room-1"), first);
    const second = await readHermesRoomLog(queryClient, "room-1");
    expect(cursors).toEqual([0, 1, 2, 3, 4, 5]);
    expect(second.latestSeq).toBe(6);
    expect(second.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("restarts from zero when authority changes between catch-up pages", async () => {
    const cursors: number[] = [];
    let phase = 0;
    mocks.request.mockImplementation(async ({ params }: { params: { since_seq: number } }) => {
      const since = params.since_seq;
      cursors.push(since);
      if (phase === 0) {
        phase = 1;
        return {
          events: [roomEvent(1)],
          cursor: 1,
          latest_seq: 2,
          has_more: true,
          authority: { epoch: 1 },
        };
      }
      if (phase === 1) {
        phase = 2;
        return {
          events: [roomEvent(2)],
          cursor: 2,
          latest_seq: 2,
          has_more: false,
          authority: { epoch: 2 },
        };
      }
      return {
        events: [roomEvent(1)],
        cursor: 1,
        latest_seq: 1,
        has_more: false,
        authority: { epoch: 2 },
      };
    });
    const result = await readHermesRoomLog(new QueryClient(), "room-1");
    expect(cursors).toEqual([0, 1, 0]);
    expect(result.authorityEpoch).toBe(2);
    expect(result.events.map((event) => event.seq)).toEqual([1]);
  });
});

describe("Hermes native response boundaries", () => {
  beforeEach(() => {
    mocks.request.mockReset();
  });

  it("does not create a Bot Chat when the session registry envelope is malformed", async () => {
    mocks.request.mockResolvedValue({});

    await expect(resolveCanonicalChat("alpha", null)).rejects.toThrow("invalid sessions list");
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "session.create" }),
    );
  });

  it("retries a capacity failure from the registry read before resuming and never creates a chat", async () => {
    const capacity = new WsRpcError({
      code: "RPC_REQUEST_CAPACITY_EXCEEDED",
      retryable: true,
      retryAfterMs: 250,
      message: "WebSocket standard request capacity exceeded.",
    });
    let listAttempts = 0;
    mocks.request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "session.list") {
        listAttempts += 1;
        if (listAttempts === 1) throw capacity;
        return { sessions: [{ id: "stored-alpha", title: "Bot Chat" }] };
      }
      return { session_id: "runtime-alpha", status: "idle", running: false, messages: [] };
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const chat = await queryClient.fetchQuery({
      queryKey: hermesKeys.chat("alpha"),
      queryFn: () => resolveCanonicalChat("alpha", null),
      retry: shouldRetryHermesRegistryRead,
      retryDelay: 0,
    });

    expect(chat.runtimeSessionId).toBe("runtime-alpha");
    expect(mocks.request.mock.calls.map(([request]) => request.method)).toEqual([
      "session.list",
      "session.list",
      "session.resume",
    ]);
    expect(mocks.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "session.create" }),
    );
  });

  it("stops retrying a registry capacity failure at the bounded limit", async () => {
    const capacity = new WsRpcError({
      code: "RPC_REQUEST_CAPACITY_EXCEEDED",
      retryable: true,
      retryAfterMs: 250,
      message: "WebSocket standard request capacity exceeded.",
    });
    mocks.request.mockRejectedValue(capacity);
    const queryClient = new QueryClient();

    await expect(
      queryClient.fetchQuery({
        queryKey: hermesKeys.chat("alpha"),
        queryFn: () => resolveCanonicalChat("alpha", null),
        retry: shouldRetryHermesRegistryRead,
        retryDelay: 0,
      }),
    ).rejects.toThrow("Could not check alpha's Bot Chat registry");
    expect(mocks.request).toHaveBeenCalledTimes(5);
    expect(mocks.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "session.create" }),
    );
  });

  it("does not retry a capacity failure after session resume may have started work", async () => {
    const capacity = new WsRpcError({
      code: "RPC_REQUEST_CAPACITY_EXCEEDED",
      retryable: true,
      retryAfterMs: 250,
      message: "WebSocket standard request capacity exceeded.",
    });
    mocks.request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "session.list")
        return { sessions: [{ id: "stored-alpha", title: "Bot Chat" }] };
      throw capacity;
    });

    await expect(resolveCanonicalChat("alpha", "stored-alpha")).rejects.toBe(capacity);
    expect(shouldRetryHermesRegistryRead(0, capacity)).toBe(false);
    expect(mocks.request.mock.calls.map(([request]) => request.method)).toEqual([
      "session.list",
      "session.resume",
    ]);
  });

  it("replays a failed native turn instead of presenting its idle session as successful", async () => {
    // Captured shape from the pinned gateway after an Anthropic HTTP 403.
    mocks.request.mockImplementation(async ({ method }: { method: string }) =>
      method === "session.list"
        ? { sessions: [{ id: "stored-chief", title: "Bot Chat" }] }
        : {
            session_id: "runtime-chief",
            status: "idle",
            running: false,
            messages: [{ row_id: 5, role: "user", text: "Coordinate the goal" }],
            inflight: {
              status: "error",
              error:
                "HTTP 403: OAuth authentication is currently not allowed for this organization.",
              recoverable: true,
              error_surface: { layer: "auth", retryable: false },
            },
          },
    );

    for (let refresh = 0; refresh < 2; refresh++) {
      const chat = await resolveCanonicalChat("chief", "stored-chief");
      expect(chat.status).toBe("error");
      expect(chat.failure).toEqual({
        message: "HTTP 403: OAuth authentication is currently not allowed for this organization.",
        retryable: false,
      });
      expect(chat.messages).toHaveLength(1);
      expect(chat.running).toBe(false);
    }
    expect(mocks.request.mock.calls.map(([request]) => request.method)).toEqual([
      "session.list",
      "session.resume",
      "session.list",
      "session.resume",
    ]);

    mocks.request.mockImplementation(async ({ method }: { method: string }) =>
      method === "session.list"
        ? { sessions: [{ id: "stored-chief", title: "Bot Chat" }] }
        : { session_id: "runtime-chief", status: "idle", running: false, inflight: null },
    );
    const recovered = await resolveCanonicalChat("chief", "stored-chief");
    expect(recovered.failure).toBeNull();
    expect(recovered.status).toBe("idle");
  });

  it("does not resume an unrelated session when the exact Bot Chat title is absent", async () => {
    mocks.request.mockResolvedValue({ sessions: [{ id: "other", title: "Other Chat" }] });

    await expect(resolveCanonicalChat("alpha", null)).rejects.toThrow("Could not confirm");
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "session.resume" }),
    );
    expect(mocks.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "session.create" }),
    );
  });

  it("rejects malformed profile and room list envelopes", () => {
    expect(() => parseProfileList({})).toThrow("invalid profiles list");
    expect(() => parseRoomList({})).toThrow("invalid rooms list");
    expect(() => parseRoutineList({})).toThrow("invalid jobs list");
    expect(() => parseProfileDetail({})).toThrow("invalid profile detail");
  });

  it("does not report routine creation success when the native tool returns an error result", async () => {
    mocks.request.mockResolvedValue({ success: false, error: "schedule is required for create" });

    const mutations = renderRoutineMutations("alpha");
    await expect(
      mutations.create.mutateAsync({
        title: "Daily check",
        schedule: "",
        instruction: "Check the room",
        deliverToChat: false,
      }),
    ).rejects.toThrow("schedule is required for create");
  });

  it("does not report profile configuration success for a malformed native result", async () => {
    mocks.request.mockResolvedValue({});

    const mutations = renderProfileMutations();
    await expect(
      mutations.configure.mutateAsync({ name: "alpha", description: "Updated" }),
    ).rejects.toThrow("did not confirm the profile changes");
  });
});

it("renders a persisted native chat row once when resume repeats history", () => {
  const message = { row_id: 8, role: "assistant", text: "native reply" };
  const tool = { role: "tool", name: "terminal", text: "same output from different calls" };
  const toolCall = { row_id: 9, role: "assistant", text: "" };
  const rows = parseChatMessages([message, toolCall, tool, message, tool]);
  expect(rows.map((row) => row.rowId)).toEqual(["8", null, null]);
  expect(rows.map((row) => row.role)).toEqual(["assistant", "tool", "tool"]);
});

describe("Hermes event invalidation", () => {
  it("keeps one pending chat read alive across an event burst", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = hermesKeys.chat("alpha");
    queryClient.setQueryData(key, { revision: 1 });

    let reads = 0;
    let resolveRead!: (value: { revision: number }) => void;
    const pendingRead = new Promise<{ revision: number }>((resolve) => {
      resolveRead = resolve;
    });
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: async () => {
        reads += 1;
        return reads === 1 ? pendingRead : { revision: 2 };
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const updates: Array<{ revision: number } | undefined> = [];
    const unsubscribe = observer.subscribe((result) => updates.push(result.data));

    const event = { type: "message.delta", payload: { session_id: "runtime-alpha" } };
    routeEventInvalidation(queryClient, event);
    routeEventInvalidation(queryClient, event);
    routeEventInvalidation(queryClient, event);
    await vi.waitFor(() => expect(reads).toBe(1));

    routeEventInvalidation(queryClient, {
      type: "message.complete",
      payload: { session_id: "runtime-alpha" },
    });
    resolveRead({ revision: 1 });
    await vi.waitFor(() => expect(updates.at(-1)).toEqual({ revision: 2 }));
    expect(reads).toBe(2);
    unsubscribe();
  });

  it("does not trail a failed cached read and replay an uncertain operation", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = hermesKeys.chat("alpha");
    queryClient.setQueryData(key, { revision: 1 });
    let reads = 0;
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: async () => {
        reads += 1;
        throw new Error("resume outcome is unknown");
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    routeEventInvalidation(queryClient, {
      type: "message.complete",
      payload: { session_id: "runtime-alpha" },
    });
    await vi.waitFor(() => expect(observer.getCurrentResult().isRefetchError).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(1);
    unsubscribe();
  });

  it("trails a completion event that arrives during a cold chat read", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = hermesKeys.chat("alpha");
    let reads = 0;
    let resolveRead!: (value: { revision: number }) => void;
    const pendingRead = new Promise<{ revision: number }>((resolve) => {
      resolveRead = resolve;
    });
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: async () => {
        reads += 1;
        return reads === 1 ? pendingRead : { revision: 2 };
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const updates: Array<{ revision: number } | undefined> = [];
    const unsubscribe = observer.subscribe((result) => updates.push(result.data));
    await vi.waitFor(() => expect(reads).toBe(1));

    routeEventInvalidation(queryClient, {
      type: "message.complete",
      payload: { session_id: "runtime-alpha" },
    });
    resolveRead({ revision: 1 });
    await vi.waitFor(() => expect(updates.at(-1)).toEqual({ revision: 2 }));
    expect(reads).toBe(2);
    unsubscribe();
  });

  it("does not repeat a trailing read after that follow-up fails", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = hermesKeys.chat("alpha");
    queryClient.setQueryData(key, { revision: 1 });
    let reads = 0;
    let resolveRead!: (value: { revision: number }) => void;
    const pendingRead = new Promise<{ revision: number }>((resolve) => {
      resolveRead = resolve;
    });
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: async () => {
        reads += 1;
        if (reads === 1) return pendingRead;
        throw new Error("follow-up read failed");
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    routeEventInvalidation(queryClient, {
      type: "message.complete",
      payload: { session_id: "runtime-alpha" },
    });
    await vi.waitFor(() => expect(reads).toBe(1));
    routeEventInvalidation(queryClient, {
      type: "message.complete",
      payload: { session_id: "runtime-alpha" },
    });
    resolveRead({ revision: 1 });
    await vi.waitFor(() => expect(reads).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(2);
    unsubscribe();
  });

  it("trails each profile independently when one pending read fails", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const alphaKey = hermesKeys.chat("alpha");
    const betaKey = hermesKeys.chat("beta");
    queryClient.setQueryData(alphaKey, { revision: 1 });
    queryClient.setQueryData(betaKey, { revision: 1 });
    let alphaReads = 0;
    let betaReads = 0;
    let rejectAlpha!: (error: Error) => void;
    let resolveBeta!: (value: { revision: number }) => void;
    const alphaRead = new Promise<never>((_resolve, reject) => {
      rejectAlpha = reject;
    });
    const betaRead = new Promise<{ revision: number }>((resolve) => {
      resolveBeta = resolve;
    });
    const alphaObserver = new QueryObserver(queryClient, {
      queryKey: alphaKey,
      queryFn: async () => {
        alphaReads += 1;
        return alphaRead;
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const betaObserver = new QueryObserver(queryClient, {
      queryKey: betaKey,
      queryFn: async () => {
        betaReads += 1;
        return betaReads === 1 ? betaRead : { revision: 2 };
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribeAlpha = alphaObserver.subscribe(() => undefined);
    const betaUpdates: Array<{ revision: number } | undefined> = [];
    const unsubscribeBeta = betaObserver.subscribe((result) => betaUpdates.push(result.data));

    routeEventInvalidation(queryClient, {
      type: "message.complete",
      payload: { session_id: "runtime-alpha" },
    });
    await vi.waitFor(() => {
      expect(alphaReads).toBe(1);
      expect(betaReads).toBe(1);
    });
    routeEventInvalidation(queryClient, {
      type: "message.complete",
      payload: { session_id: "runtime-alpha" },
    });
    rejectAlpha(new Error("alpha read failed"));
    resolveBeta({ revision: 1 });
    await vi.waitFor(() => expect(betaUpdates.at(-1)).toEqual({ revision: 2 }));
    expect(alphaReads).toBe(1);
    expect(betaReads).toBe(2);
    unsubscribeAlpha();
    unsubscribeBeta();
  });
});
