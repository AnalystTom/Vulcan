import { afterEach, describe, expect, it, vi } from "vitest";

const originalWindow = (globalThis as { window?: unknown }).window;

function stubWindowLocation(location: { hash: string }): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location },
  });
}

describe("capturedPairingHash", () => {
  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
    vi.resetModules();
  });

  it("snapshots the fragment present at import time", async () => {
    stubWindowLocation({ hash: "#token=CAPTURED-AT-LOAD" });
    vi.resetModules();
    const module = await import("./pairingHashCapture");
    expect(module.capturedPairingHash).toBe("#token=CAPTURED-AT-LOAD");
  });

  it("is empty when the document loaded without a fragment", async () => {
    stubWindowLocation({ hash: "" });
    vi.resetModules();
    const module = await import("./pairingHashCapture");
    expect(module.capturedPairingHash).toBe("");
  });

  it("does not track hash changes made after load", async () => {
    const location = { hash: "#token=ORIGINAL" };
    stubWindowLocation(location);
    vi.resetModules();
    const module = await import("./pairingHashCapture");
    // A later normalization of the URL must not retroactively change the capture.
    location.hash = "";
    expect(module.capturedPairingHash).toBe("#token=ORIGINAL");
  });
});
