import { describe, expect, it } from "vitest";

import { evaluateBotGatewayToolPolicy } from "./botGatewayPolicy.ts";

describe("evaluateBotGatewayToolPolicy", () => {
  it("allows a granted write capability", () => {
    expect(
      evaluateBotGatewayToolPolicy({
        capabilityGrants: ["thread.read", "thread.write"],
        controlPhase: "running",
        toolName: "vulcan_send_message",
        readOnly: false,
      }),
    ).toEqual({ decision: "allowed", capability: "thread.write" });
  });

  it("fails closed when the bot lacks the tool capability", () => {
    expect(
      evaluateBotGatewayToolPolicy({
        capabilityGrants: ["thread.read"],
        controlPhase: "running",
        toolName: "browser_click",
        readOnly: false,
      }),
    ).toMatchObject({ decision: "denied", capability: "browser.control" });
  });

  it("blocks writes while a human has control", () => {
    expect(
      evaluateBotGatewayToolPolicy({
        capabilityGrants: ["browser.control"],
        controlPhase: "human-control",
        toolName: "browser_click",
        readOnly: false,
      }),
    ).toMatchObject({ decision: "denied", reason: expect.stringMatching(/human control/i) });
  });

  it("keeps read-only inspection available while paused", () => {
    expect(
      evaluateBotGatewayToolPolicy({
        capabilityGrants: ["thread.read"],
        controlPhase: "paused",
        toolName: "vulcan_read_thread",
        readOnly: true,
      }),
    ).toEqual({ decision: "allowed", capability: "thread.read" });
  });
});
