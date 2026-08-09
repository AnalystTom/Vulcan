// FILE: CursorAdapter.test.ts
// Purpose: Characterizes Cursor's private Vulcan host-policy delivery.
// Layer: Provider adapter tests

import { VULCAN_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import { describe, expect, it } from "vitest";

import { takeCursorVulcanHarnessPolicyTextPart } from "./CursorAdapter.ts";

describe("Cursor Vulcan harness policy", () => {
  it("delivers scoped MCP host context exactly once per fresh/load/fork session", () => {
    for (const lifecycle of ["fresh", "load", "fork"] as const) {
      const state: { harnessPolicyDelivered?: boolean } = {};
      const first = takeCursorVulcanHarnessPolicyTextPart(state, true);
      expect(first?.text, lifecycle).toContain(VULCAN_HARNESS_POLICY_MARKER);
      expect(first?.text, lifecycle).toContain("Use the vulcan_* tools");
      expect(takeCursorVulcanHarnessPolicyTextPart(state, true), lifecycle).toBeNull();
    }
  });

  it("stays truthful without a scoped gateway connection", () => {
    expect(takeCursorVulcanHarnessPolicyTextPart({}, false)?.text).toContain(
      "Vulcan MCP control is unavailable",
    );
  });
});
