import { describe, expect, it } from "vitest";

import { transitionBotControl } from "./botControl.ts";

const base = {
  botId: "bot-control" as never,
  phase: "running" as const,
  activeThreadId: "thread-control" as never,
  takeoverReason: null,
  updatedAt: "2026-08-21T20:00:00.000Z",
};

describe("transitionBotControl", () => {
  it("moves a running bot through takeover and releases to paused", () => {
    const requested = transitionBotControl(base, {
      action: "request-takeover",
      reason: "Login required",
      now: "2026-08-21T20:01:00.000Z",
    });
    expect(requested).toMatchObject({
      phase: "takeover-requested",
      takeoverReason: "Login required",
    });

    const controlled = transitionBotControl(requested, {
      action: "take-control",
      now: "2026-08-21T20:02:00.000Z",
    });
    expect(controlled.phase).toBe("human-control");

    const released = transitionBotControl(controlled, {
      action: "release-control",
      now: "2026-08-21T20:03:00.000Z",
    });
    expect(released).toMatchObject({ phase: "paused", takeoverReason: null });
  });

  it("fails closed on an invalid takeover transition", () => {
    expect(() =>
      transitionBotControl(
        { ...base, phase: "idle" },
        { action: "take-control", now: "2026-08-21T20:01:00.000Z" },
      ),
    ).toThrow(/cannot take control/i);
  });

  it("requires a reason when autonomy asks for takeover", () => {
    expect(() =>
      transitionBotControl(base, {
        action: "request-takeover",
        now: "2026-08-21T20:01:00.000Z",
      }),
    ).toThrow(/reason/i);
  });
});
