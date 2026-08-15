import { describe, expect, it, vi } from "vitest";

import {
  AUTH_BOOTSTRAP_PATH,
  AUTH_SESSION_PATH,
  exchangePairingCredential,
  extractPairingCredential,
  probeAuthenticated,
} from "./authClient";

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as Response;
}

describe("probeAuthenticated", () => {
  it("returns the server's authenticated flag", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ authenticated: true }));
    await expect(probeAuthenticated(fetchImpl as unknown as typeof fetch)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      AUTH_SESSION_PATH,
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
  });

  it("returns false when the server reports no session", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ authenticated: false }));
    await expect(probeAuthenticated(fetchImpl as unknown as typeof fetch)).resolves.toBe(false);
  });

  it("returns null (unknown) when the request throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(probeAuthenticated(fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
  });

  it("returns null when the response is not ok", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ authenticated: true }, { ok: false, status: 500 }),
    );
    await expect(probeAuthenticated(fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
  });

  it("returns null when the body lacks a boolean flag", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ authenticated: "yes" }));
    await expect(probeAuthenticated(fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
  });
});

describe("extractPairingCredential", () => {
  it("returns a bare token unchanged", () => {
    expect(extractPairingCredential("PAIRING-SECRET")).toBe("PAIRING-SECRET");
  });

  it("pulls the token out of a full /pair link", () => {
    expect(extractPairingCredential("http://100.111.214.80:3773/pair#token=PAIRING-SECRET")).toBe(
      "PAIRING-SECRET",
    );
  });

  it("pulls the token out of a bare token= fragment", () => {
    expect(extractPairingCredential("token=PAIRING-SECRET")).toBe("PAIRING-SECRET");
  });

  it("percent-decodes the token when possible", () => {
    expect(extractPairingCredential("token=a%2Bb")).toBe("a+b");
  });

  it("trims surrounding whitespace on a bare token", () => {
    expect(extractPairingCredential("  PAIRING-SECRET  ")).toBe("PAIRING-SECRET");
  });

  it("rejects an empty paste", () => {
    expect(extractPairingCredential("   ")).toBeNull();
  });

  it("rejects a whitespace-laden sentence that has no token param", () => {
    expect(extractPairingCredential("paste your token here please")).toBeNull();
  });
});

describe("exchangePairingCredential", () => {
  it("POSTs the credential and resolves ok on success", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response);
    await expect(
      exchangePairingCredential("PAIRING-SECRET", fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(AUTH_BOOTSTRAP_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "PAIRING-SECRET" }),
    });
  });

  it("surfaces the server error message on rejection", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "Token already used." }, { ok: false, status: 401 }),
    );
    await expect(
      exchangePairingCredential("PAIRING-SECRET", fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual({ ok: false, reason: "Token already used." });
  });

  it("falls back to a friendly reason when the body has no error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { ok: false, status: 401 }));
    const result = await exchangePairingCredential(
      "PAIRING-SECRET",
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/invalid, expired, or already used/);
  });

  it("reports an unreachable server when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await exchangePairingCredential(
      "PAIRING-SECRET",
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Could not reach/);
  });
});
