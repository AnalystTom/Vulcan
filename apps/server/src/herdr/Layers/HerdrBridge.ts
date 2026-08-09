import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { HerdrAvailability, HerdrStatus } from "@vulcan/contracts";
import { Effect, Layer } from "effect";

import { resolveExecutable } from "../../executableLookup.ts";
import {
  evaluateHerdrAvailability,
  type HerdrCommandOutcome,
  herdrAttachCommand,
  parseHerdrSessions,
} from "../herdrStatusParsing.ts";
import { HerdrBridge, type HerdrBridgeShape } from "../Services/HerdrBridge.ts";

const execFileAsync = promisify(execFile);

/**
 * Probing spawns two short-lived subprocesses. Panes ask for availability on
 * every render and every reconnect, so the verdict is cached for long enough to
 * keep that free while still noticing an operator who has just started Herdr in
 * another window.
 */
const STATUS_CACHE_MS = 5_000;

/** Herdr answers status locally over a unix socket; anything slower is wedged. */
const COMMAND_TIMEOUT_MS = 5_000;

async function runHerdr(binaryPath: string, args: string[]): Promise<HerdrCommandOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, args, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1_000_000,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr };
  } catch (cause) {
    const error = cause as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? "herdr invocation failed",
    };
  }
}

const makeHerdrBridge = Effect.sync((): HerdrBridgeShape => {
  let cached: { readonly status: HerdrStatus; readonly probedAt: number } | null = null;
  // Concurrent panes mounting at once must not each spawn their own probe.
  let inFlight: Promise<HerdrStatus> | null = null;

  const probe = async (): Promise<HerdrStatus> => {
    const binaryPath = resolveExecutable("herdr");
    const statusOutcome =
      binaryPath === null ? null : await runHerdr(binaryPath, ["status", "--json"]);
    const availability = evaluateHerdrAvailability(binaryPath, statusOutcome);

    // Only ask for sessions once Herdr is known good. Listing sessions from a
    // broken install would produce noise the operator cannot act on.
    const sessions =
      availability.status === "available"
        ? parseHerdrSessions(await runHerdr(availability.binaryPath, ["session", "list", "--json"]))
        : [];

    return { availability, sessions, checkedAt: new Date().toISOString() };
  };

  const readStatus = (options?: { readonly refresh?: boolean }): Effect.Effect<HerdrStatus> =>
    Effect.promise(() => {
      const now = Date.now();
      if (!options?.refresh && cached && now - cached.probedAt < STATUS_CACHE_MS) {
        return Promise.resolve(cached.status);
      }
      if (inFlight) return inFlight;
      inFlight = probe()
        .then((status) => {
          cached = { status, probedAt: Date.now() };
          return status;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    });

  const availability = (options?: {
    readonly refresh?: boolean;
  }): Effect.Effect<HerdrAvailability> =>
    readStatus(options).pipe(Effect.map((status) => status.availability));

  const resolveAttachCommand: HerdrBridgeShape["resolveAttachCommand"] = (sessionName) =>
    availability().pipe(Effect.map((current) => herdrAttachCommand(current, sessionName)));

  return { status: readStatus, availability, resolveAttachCommand };
});

export const HerdrBridgeLive = Layer.effect(HerdrBridge, makeHerdrBridge);
