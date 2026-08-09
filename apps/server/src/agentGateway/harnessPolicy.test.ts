import { assert, describe, it } from "@effect/vitest";

import {
  renderVulcanHarnessPolicy,
  VULCAN_HARNESS_POLICY_MARKER,
  takeVulcanHarnessPolicyForProviderSession,
  takeVulcanHarnessPolicyTextPartForProviderSession,
  takeVulcanHarnessPolicyForSession,
} from "./harnessPolicy.ts";

describe("Vulcan harness policy", () => {
  it("identifies Vulcan and explains exact batch coordination when MCP is available", () => {
    const policy = renderVulcanHarnessPolicy({ gatewayControlAvailable: true });
    assert.include(policy, VULCAN_HARNESS_POLICY_MARKER);
    assert.include(policy, "Vulcan is the host and harness");
    assert.include(policy, "one exact vulcan_create_threads plan");
    assert.include(policy, "before returning an operationId");
    assert.include(policy, "vulcan_wait_for_threads");
    assert.include(policy, "Use the browser_* tools");
    assert.include(policy, "exact thread-scoped Electron page Vulcan surfaces to the user");
    assert.include(policy, "continue in the background");
    assert.include(policy, "must never change the user's active chat");
    assert.include(policy, "in any language");
    assert.include(policy, "canonical and complete control surface");
    assert.include(policy, "start with browser_open");
    assert.include(policy, "do not load or use a generic Browser");
    assert.include(policy, "workspace-relative paths");
    assert.include(policy, "BrowserInterruptedByHuman");
    assert.include(policy, "BrowserDownloadApprovalRequired");
    assert.include(policy, "OAuth popup requiring human action");
    assert.include(policy, "stop using tools and answer");
    assert.include(policy, "do not create Vulcan threads");
    assert.include(policy, "3–8 word outcome-oriented task label");
    assert.include(policy, "no assumed chat context");
    assert.include(policy, "notifying the user versus staying silent");
    assert.include(policy, 'later manual follow-up such as "continue"');
    assert.include(policy, "Never call this tool for a manual follow-up turn");
  });

  it("never advertises gateway mutation to providers without scoped MCP", () => {
    const policy = renderVulcanHarnessPolicy({ gatewayControlAvailable: false });
    assert.include(policy, "Vulcan MCP control is unavailable");
    assert.notInclude(policy, "one exact vulcan_create_threads plan");
  });

  it("delivers a private host-context block once per provider session", () => {
    const state: { harnessPolicyDelivered?: boolean } = {};
    assert.include(
      takeVulcanHarnessPolicyForSession(state, { gatewayControlAvailable: true }) ?? "",
      "<vulcan_host_context>",
    );
    assert.isNull(takeVulcanHarnessPolicyForSession(state, { gatewayControlAvailable: true }));
  });

  it("delivers once on fresh/load/fork sessions for every scoped MCP provider", () => {
    for (const provider of [
      "antigravity",
      "cursor",
      "grok",
      "droid",
      "opencode",
      "kilo",
      "pi",
    ] as const) {
      for (const lifecycle of ["fresh", "load", "fork"] as const) {
        const state: { harnessPolicyDelivered?: boolean } = {};
        const first =
          takeVulcanHarnessPolicyTextPartForProviderSession(state, {
            provider,
            scopedGatewayConnectionAvailable: true,
          })?.text ?? "";
        assert.include(first, VULCAN_HARNESS_POLICY_MARKER, `${provider}/${lifecycle}`);
        assert.include(first, "Use the vulcan_* tools", `${provider}/${lifecycle}`);
        assert.isNull(
          takeVulcanHarnessPolicyForProviderSession(state, {
            provider,
            scopedGatewayConnectionAvailable: true,
          }),
          `${provider}/${lifecycle}`,
        );
      }
    }
  });

  it("keeps OpenCode, Kilo, and Pi identity-only until scoped setup succeeds", () => {
    for (const provider of ["opencode", "kilo", "pi"] as const) {
      const text =
        takeVulcanHarnessPolicyForProviderSession(
          {},
          { provider, scopedGatewayConnectionAvailable: false },
        ) ?? "";
      assert.include(text, VULCAN_HARNESS_POLICY_MARKER, provider);
      assert.include(text, "Vulcan MCP control is unavailable", provider);
      assert.notInclude(text, "one exact vulcan_create_threads plan", provider);
    }
  });
});
