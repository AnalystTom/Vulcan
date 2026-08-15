import { describe, expect, it, vi } from "vitest";

import { bootstrapPairingSession } from "./pairingBootstrap";

function makeDependencies(input: {
  readonly pathname?: string;
  readonly capturedHash?: string;
  readonly responseOk?: boolean;
}) {
  const events: Array<string> = [];
  const replace = vi.fn((url: string) => events.push(`navigate:${url}`));
  const replaceState = vi.fn((_data: unknown, _unused: string, url?: string | URL | null) =>
    events.push(`scrub:${String(url)}`),
  );
  const fetch = vi.fn(async () => {
    events.push("fetch");
    return { ok: input.responseOk ?? true } as Response;
  });
  const renderFailure = vi.fn(() => events.push("failure"));

  return {
    dependencies: {
      location: {
        pathname: input.pathname ?? "/pair",
        search: "",
        replace,
      },
      history: { replaceState },
      fetch: fetch as typeof globalThis.fetch,
      renderFailure,
      capturedHash: input.capturedHash ?? "#token=PAIRING-SECRET",
    },
    events,
    fetch,
    replace,
    replaceState,
    renderFailure,
  };
}

describe("bootstrapPairingSession", () => {
  it("ignores every route except the dedicated pairing route", async () => {
    const test = makeDependencies({ pathname: "/" });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("not-pairing");
    expect(test.fetch).not.toHaveBeenCalled();
    expect(test.replaceState).not.toHaveBeenCalled();
  });

  it("scrubs the fragment before exchanging it and redirects after success", async () => {
    const test = makeDependencies({});

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("redirecting");

    expect(test.events).toEqual(["scrub:/pair", "fetch", "navigate:/"]);
    expect(test.fetch).toHaveBeenCalledWith("/api/auth/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "PAIRING-SECRET" }),
    });
  });

  it("renders a token-free failure state when the exchange is rejected", async () => {
    const test = makeDependencies({ responseOk: false });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("failed");

    expect(test.events).toEqual(["scrub:/pair", "fetch", "failure"]);
    expect(test.replace).not.toHaveBeenCalled();
    expect(test.renderFailure).toHaveBeenCalledOnce();
  });

  it("fails without making a request when the fragment has no credential", async () => {
    const test = makeDependencies({ capturedHash: "" });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("failed");
    expect(test.events).toEqual(["scrub:/pair", "failure"]);
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it("exchanges the token captured at load even if the live URL was already scrubbed", async () => {
    // Regression: in the production bundle the token vanished before pairing read
    // it (a boot module normalized the URL first). Pairing must exchange the
    // fragment captured synchronously at document load, not whatever the live URL
    // says by the time this async flow runs, so a clean token still reaches the
    // bootstrap endpoint instead of stranding the user on the pairing-failed page.
    const test = makeDependencies({ capturedHash: "#token=PAIRING-SECRET" });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("redirecting");
    expect(test.fetch).toHaveBeenCalledWith(
      "/api/auth/bootstrap",
      expect.objectContaining({ body: JSON.stringify({ credential: "PAIRING-SECRET" }) }),
    );
  });

  it("accepts a full pairing link fragment, not just a bare token= pair", async () => {
    const test = makeDependencies({
      capturedHash: "#token=PAIRING-SECRET&issuedAt=123",
    });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("redirecting");
    expect(test.fetch).toHaveBeenCalledWith(
      "/api/auth/bootstrap",
      expect.objectContaining({ body: JSON.stringify({ credential: "PAIRING-SECRET" }) }),
    );
  });
});
