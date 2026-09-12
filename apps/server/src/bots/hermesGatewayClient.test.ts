import { describe, expect, it, vi } from "vitest";

import {
  createHermesGatewayClient,
  type HermesGatewayClient,
  type HermesGatewayState,
} from "./hermesGatewayClient";

class FakeSocket {
  readonly sent: string[] = [];
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();

  on(event: string, listener: (...args: never[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  frame(...frames: unknown[]): void {
    this.emit("message", `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n` as never);
  }

  private emit(event: string, ...args: never[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function requestId(socket: FakeSocket): number {
  return JSON.parse(socket.sent.at(-1)!.trim()).id;
}

async function ready(socket: FakeSocket, capabilities = {}, heartbeat = true): Promise<void> {
  socket.open();
  socket.frame({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "gateway.ready", payload: { heartbeat } },
  });
  await Promise.resolve();
  socket.frame({
    jsonrpc: "2.0",
    id: requestId(socket),
    result: {
      protocol_version: 2,
      driver: true,
      persistent_process: true,
      methods: ["groups.capabilities", "groups.send", "groups.log"],
      features: ["idempotent_send"],
      ...capabilities,
    },
  });
}

describe("Hermes native gateway client", () => {
  it("correlates responses and dispatches multiple newline-delimited notifications in one frame", async () => {
    const socket = new FakeSocket();
    const states: HermesGatewayState[] = [];
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const client = createHermesGatewayClient({
      url: "ws://hermes.test/api/ws?profile=default",
      token: "secret-token",
      socketFactory: (url) => {
        expect(url).toBe("ws://hermes.test/api/ws?profile=default&token=secret-token");
        return socket as never;
      },
    });
    client.onStatus((state) => states.push(state));
    client.subscribe((event) => events.push(event));

    const connected = client.connect();
    await ready(socket);
    const capabilities = await connected;
    expect(capabilities.protocol_version).toBe(2);
    expect(client.connected).toBe(true);

    const result = client.request<{ accepted: boolean }>("groups.send", { room_id: "room-1" });
    const id = requestId(socket);
    socket.frame(
      {
        jsonrpc: "2.0",
        method: "event",
        params: { type: "message.delta", payload: { text: "hi" } },
      },
      { jsonrpc: "2.0", id, result: { accepted: true } },
      {
        jsonrpc: "2.0",
        method: "event",
        params: { type: "message.complete", payload: { done: true } },
      },
    );

    await expect(result).resolves.toEqual({ accepted: true });
    expect(events).toEqual([
      { type: "gateway.ready", payload: { heartbeat: true } },
      { type: "message.delta", payload: { text: "hi" } },
      { type: "message.complete", payload: { done: true } },
    ]);
    expect(states).toEqual(["idle", "connecting", "open"]);
    client.close();
  });

  it("fails a connection whose gateway.ready handshake never arrives", async () => {
    const socket = new FakeSocket();
    const client = createHermesGatewayClient({
      url: "ws://hermes.test/api/ws",
      connectTimeoutMs: 5,
      socketFactory: () => socket as never,
    });

    socket.open();
    await expect(client.connect()).rejects.toMatchObject({ kind: "connect" });
    expect(client.connected).toBe(false);
    expect(socket.closed).toBe(true);
  });

  it("fails closed when capabilities advertise another protocol", async () => {
    const socket = new FakeSocket();
    const client = createHermesGatewayClient({
      url: "ws://hermes.test/api/ws",
      socketFactory: () => socket as never,
    });

    const connection = client.connect();
    await ready(socket, { protocol_version: 1 });
    await expect(connection).rejects.toMatchObject({ kind: "capability" });
    expect(client.connected).toBe(false);
    expect(socket.closed).toBe(true);
  });

  it("rejects a dropped mutation as unknown and never resends it", async () => {
    const sockets: FakeSocket[] = [];
    const client: HermesGatewayClient = createHermesGatewayClient({
      url: "ws://hermes.test/api/ws",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as never;
      },
    });

    const connection = client.connect();
    await ready(sockets[0]!);
    await connection;
    const mutation = client.request("groups.send", { room_id: "room-1", event_id: "once" });
    await Promise.resolve();
    sockets[0]!.close();

    await expect(mutation).rejects.toMatchObject({ kind: "unknown" });
    expect(sockets[0]!.sent.filter((frame) => frame.includes('"groups.send"'))).toHaveLength(1);
    client.close();
  });

  it("uses the advertised heartbeat, cleans its timer, and reports reconnect only after capabilities", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const states: HermesGatewayState[] = [];
      const client = createHermesGatewayClient({
        url: "ws://hermes.test/api/ws",
        socketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket as never;
        },
      });
      client.onStatus((state) => states.push(state));

      const first = client.connect();
      await ready(sockets[0]!);
      await first;
      expect(states).toEqual(["idle", "connecting", "open"]);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(sockets[0]!.sent.at(-1)).toContain('"gateway.ping"');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.connected).toBe(false);
      expect(client.state).toBe("error");
      expect(vi.getTimerCount()).toBe(0);

      const second = client.connect();
      expect(states.at(-1)).toBe("connecting");
      await ready(sockets[1]!);
      await second;
      expect(states.at(-1)).toBe("open");
      client.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
