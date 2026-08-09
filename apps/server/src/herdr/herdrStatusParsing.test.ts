import { HERDR_MIN_PROTOCOL } from "@vulcan/contracts";
import { describe, expect, it } from "vitest";

import {
  evaluateHerdrAvailability,
  herdrAttachCommand,
  type HerdrCommandOutcome,
  parseHerdrSessions,
} from "./herdrStatusParsing.ts";

const ok = (stdout: string): HerdrCommandOutcome => ({ ok: true, stdout, stderr: "" });
const failed = (stderr: string): HerdrCommandOutcome => ({ ok: false, stdout: "", stderr });

/** Captured verbatim from `herdr status --json` on Herdr 0.7.4. */
const healthyStatus = ok(
  JSON.stringify({
    client: { version: "0.7.4", channel: "stable", protocol: 16, session: null },
    server: {
      status: "running",
      running: true,
      version: "0.7.4",
      protocol: 16,
      compatible: true,
      socket: "/home/user/.config/herdr/herdr.sock",
      restart_needed: false,
    },
    update: { restart_needed: false },
  }),
);

describe("herdr availability", () => {
  it("accepts a running, current install and reports its socket", () => {
    const availability = evaluateHerdrAvailability("/usr/bin/herdr", healthyStatus);
    expect(availability).toEqual({
      status: "available",
      binaryPath: "/usr/bin/herdr",
      clientVersion: "0.7.4",
      protocol: 16,
      socketPath: "/home/user/.config/herdr/herdr.sock",
    });
  });

  it("reports a missing binary rather than a generic failure", () => {
    const availability = evaluateHerdrAvailability(null, null);
    expect(availability.status).toBe("unavailable");
    expect(availability).toMatchObject({ reason: "binary-missing", binaryPath: null });
  });

  it("reports unreadable status when the CLI fails or answers with non-JSON", () => {
    expect(evaluateHerdrAvailability("/usr/bin/herdr", failed("boom"))).toMatchObject({
      reason: "status-unreadable",
      detail: "boom",
    });
    expect(evaluateHerdrAvailability("/usr/bin/herdr", ok("not json"))).toMatchObject({
      reason: "status-unreadable",
    });
    expect(evaluateHerdrAvailability("/usr/bin/herdr", ok("{}"))).toMatchObject({
      reason: "status-unreadable",
    });
  });

  it("reports an old protocol with the version the operator has to update", () => {
    const old = ok(
      JSON.stringify({
        client: { version: "0.5.0", protocol: HERDR_MIN_PROTOCOL - 1 },
        server: { running: true, compatible: true },
      }),
    );
    const availability = evaluateHerdrAvailability("/usr/bin/herdr", old);
    expect(availability).toMatchObject({
      reason: "protocol-too-old",
      protocol: HERDR_MIN_PROTOCOL - 1,
    });
    if (availability.status !== "unavailable") throw new Error("expected unavailable");
    expect(availability.detail).toContain("0.5.0");
  });

  it("distinguishes a stopped server from a missing install", () => {
    const stopped = ok(
      JSON.stringify({
        client: { version: "0.7.4", protocol: 16 },
        server: { status: "stopped", running: false },
      }),
    );
    expect(evaluateHerdrAvailability("/usr/bin/herdr", stopped)).toMatchObject({
      reason: "server-not-running",
      binaryPath: "/usr/bin/herdr",
    });
  });

  it("reports a server that declares itself incompatible with its client", () => {
    const mismatched = ok(
      JSON.stringify({
        client: { version: "0.7.4", protocol: 16 },
        server: { running: true, compatible: false, version: "0.6.0" },
      }),
    );
    const availability = evaluateHerdrAvailability("/usr/bin/herdr", mismatched);
    expect(availability).toMatchObject({ reason: "server-incompatible" });
    if (availability.status !== "unavailable") throw new Error("expected unavailable");
    expect(availability.detail).toContain("0.6.0");
  });

  it("prefers the earliest remedy when several checks would fail", () => {
    // An old protocol on a stopped server is an update problem, not a start problem.
    const both = ok(
      JSON.stringify({
        client: { version: "0.5.0", protocol: 1 },
        server: { running: false },
      }),
    );
    expect(evaluateHerdrAvailability("/usr/bin/herdr", both)).toMatchObject({
      reason: "protocol-too-old",
    });
  });
});

describe("herdr sessions", () => {
  it("parses the session list", () => {
    const outcome = ok(
      JSON.stringify({
        sessions: [
          {
            default: true,
            name: "default",
            running: true,
            socket_path: "/home/user/.config/herdr/herdr.sock",
          },
          { default: false, name: "review", running: false },
        ],
      }),
    );
    expect(parseHerdrSessions(outcome)).toEqual([
      {
        name: "default",
        running: true,
        isDefault: true,
        socketPath: "/home/user/.config/herdr/herdr.sock",
      },
      { name: "review", running: false, isDefault: false, socketPath: null },
    ]);
  });

  it("returns an empty list rather than throwing on unusable output", () => {
    expect(parseHerdrSessions(null)).toEqual([]);
    expect(parseHerdrSessions(failed("nope"))).toEqual([]);
    expect(parseHerdrSessions(ok("not json"))).toEqual([]);
    expect(parseHerdrSessions(ok(JSON.stringify({ sessions: "no" })))).toEqual([]);
    expect(parseHerdrSessions(ok(JSON.stringify({ sessions: [{ running: true }] })))).toEqual([]);
  });
});

describe("herdr attach command", () => {
  it("attaches to a named session", () => {
    const availability = evaluateHerdrAvailability("/usr/bin/herdr", healthyStatus);
    expect(herdrAttachCommand(availability, "vulcan-1")).toEqual({
      shell: "/usr/bin/herdr",
      args: ["session", "attach", "vulcan-1"],
    });
  });

  it("refuses to produce a command when Herdr is unavailable", () => {
    // This is the guard that stops a Herdr pane from silently becoming a plain
    // shell. Without a command there is nothing to spawn, so the caller has to
    // surface the unavailable state and let the operator choose the fallback.
    const availability = evaluateHerdrAvailability(null, null);
    expect(herdrAttachCommand(availability, "vulcan-1")).toBeNull();
  });
});
