import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  resolveCanonicalChat,
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
