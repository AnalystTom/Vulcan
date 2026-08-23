import type { FactoryTraceLane } from "@vulcan/shared/factoryTraceTimeline";
import { describe, expect, it } from "vitest";

import { buildLaneTints, findLaneBot, laneBotTint } from "./traceTheme";

const laneOf = (overrides: Partial<FactoryTraceLane> & { id: string }): FactoryTraceLane => ({
  label: overrides.id.split(":")[1] ?? overrides.id,
  displayName: null,
  kind: "agent",
  model: null,
  color: null,
  context: null,
  blocks: [],
  pending: [],
  ...overrides,
});

describe("findLaneBot", () => {
  const bots = [{ name: "Ada", avatar: { color: "purple" } }];

  it("matches a lane to the bot whose name the trace recorded", () => {
    expect(findLaneBot(laneOf({ id: "agent:Ada", displayName: "  ada " }), bots)).toBe(bots[0]);
  });

  it("never matches on the lane label alone", () => {
    // An external factory is free to name an agent "Ada"; borrowing a
    // coworker's face for its work would be a claim the operator cannot check.
    expect(findLaneBot(laneOf({ id: "agent:Ada", label: "Ada" }), bots)).toBeNull();
  });

  it("leaves non-agent lanes alone", () => {
    expect(
      findLaneBot(laneOf({ id: "code:git", kind: "code", displayName: "Ada" }), bots),
    ).toBeNull();
  });
});

describe("buildLaneTints", () => {
  it("keeps the factory's own swatch ahead of the bot's", () => {
    const lane = laneOf({
      id: "agent:Ada",
      displayName: "Ada",
      color: "#123456",
    });
    const tints = buildLaneTints([lane], () => "#a855f7");
    expect(tints.get("agent:Ada")).toBe("#123456");
  });

  it("falls back to the bot's swatch when the trace carries none", () => {
    const lane = laneOf({ id: "agent:Ada", displayName: "Ada" });
    const tints = buildLaneTints([lane], () =>
      laneBotTint({ name: "Ada", avatar: { color: "purple" } }),
    );
    expect(tints.get("agent:Ada")).toBe("#a855f7");
  });

  it("ignores an identity colour that is not a hex value", () => {
    const lane = laneOf({ id: "agent:Ada", displayName: "Ada" });
    const tints = buildLaneTints([lane], () => "javascript:alert(1)");
    expect(tints.get("agent:Ada")).toBe("var(--factory-lane-agent-1)");
  });
});
