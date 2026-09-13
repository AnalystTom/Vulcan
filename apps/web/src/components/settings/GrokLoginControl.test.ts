import { describe, expect, it } from "vitest";

import { grokLoginOutcomeMessage } from "./GrokLoginControl";

const unknownGrokStatus = {
  provider: "grok",
  status: "ready",
  available: true,
  authStatus: "unknown",
  checkedAt: "2026-09-13T00:00:00.000Z",
} as const;

const authenticatedGrokStatus = { ...unknownGrokStatus, authStatus: "authenticated" } as const;

describe("grokLoginOutcomeMessage", () => {
  it("keeps cancelled and failed terminal states actionable", () => {
    expect(grokLoginOutcomeMessage("cancelled", undefined, false)).toBe(
      "Grok sign-in was cancelled.",
    );
    expect(grokLoginOutcomeMessage("failed", undefined, false)).toContain(
      "Review the terminal output",
    );
  });

  it("does not claim authentication when provider health remains unknown", () => {
    expect(grokLoginOutcomeMessage("completed", unknownGrokStatus, false)).toContain(
      "Authentication is not verified",
    );
    expect(grokLoginOutcomeMessage("completed", undefined, true)).toContain(
      "status could not be refreshed",
    );
  });

  it("points an authenticated owner to the existing Grok session flow", () => {
    expect(grokLoginOutcomeMessage("completed", authenticatedGrokStatus, false)).toContain(
      "Choose Grok in the provider picker to start a session",
    );
  });
});
