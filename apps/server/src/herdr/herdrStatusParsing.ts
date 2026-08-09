// FILE: herdrStatusParsing.ts
// Purpose: Turn `herdr status --json` and `herdr session list --json` output into
// an explicit availability verdict.
// Layer: Server Herdr bridge (pure; the process spawning lives in Layers/HerdrBridge.ts)
//
// Kept pure and separate from the subprocess so every branch -- missing binary,
// unparseable output, old protocol, stopped server -- is exercised in tests
// without a Herdr installation. Vulcan must render the difference between these
// cases to the operator, so getting them wrong is a product bug, not a detail.

import {
  HERDR_MIN_PROTOCOL,
  type HerdrAvailability,
  type HerdrSession,
  type HerdrUnavailableReason,
} from "@vulcan/contracts";

/** Raw result of invoking the Herdr CLI, so callers can be tested with fixtures. */
export interface HerdrCommandOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

const unavailable = (
  reason: HerdrUnavailableReason,
  detail: string,
  binaryPath: string | null = null,
  protocol: number | null = null,
): HerdrAvailability => ({ status: "unavailable", reason, detail, binaryPath, protocol });

const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const readRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Decides whether Herdr can be attached to.
 *
 * The order of the checks is the order of the remedies the operator would try,
 * so the first failing check is the one worth reporting: a missing binary is not
 * also a protocol problem, and an old binary's server status does not matter.
 */
export function evaluateHerdrAvailability(
  binaryPath: string | null,
  status: HerdrCommandOutcome | null,
): HerdrAvailability {
  if (binaryPath === null) {
    return unavailable(
      "binary-missing",
      "No `herdr` executable was found on PATH. Install Herdr from herdr.dev to use Herdr Terminal panes.",
    );
  }
  if (status === null || !status.ok) {
    const detail =
      status?.stderr.trim() || status?.stdout.trim() || "`herdr status --json` failed.";
    return unavailable("status-unreadable", detail, binaryPath);
  }

  const parsed = readRecord(parseJson(status.stdout));
  if (parsed === null) {
    return unavailable(
      "status-unreadable",
      "`herdr status --json` did not return a JSON object.",
      binaryPath,
    );
  }

  const client = readRecord(parsed.client);
  const server = readRecord(parsed.server);
  const clientProtocol = readNumber(client?.protocol);
  const clientVersion = readString(client?.version);

  if (clientProtocol === null || clientVersion === null) {
    return unavailable(
      "status-unreadable",
      "`herdr status --json` did not report a client version and protocol.",
      binaryPath,
    );
  }
  if (clientProtocol < HERDR_MIN_PROTOCOL) {
    return unavailable(
      "protocol-too-old",
      `Herdr ${clientVersion} speaks protocol ${clientProtocol}; Vulcan needs ${HERDR_MIN_PROTOCOL} or newer. Run \`herdr update\`.`,
      binaryPath,
      clientProtocol,
    );
  }

  // A Herdr install with no running server cannot host a durable session, so it
  // is reported as unavailable rather than attached-to-and-then-broken.
  if (server === null || server.running !== true) {
    return unavailable(
      "server-not-running",
      "The Herdr background server is not running. Start it by launching `herdr`, then retry.",
      binaryPath,
      clientProtocol,
    );
  }
  if (server.compatible === false) {
    const serverVersion = readString(server.version) ?? "unknown";
    return unavailable(
      "server-incompatible",
      `The running Herdr server (${serverVersion}) reports that it is incompatible with the installed client (${clientVersion}). Restart the Herdr server.`,
      binaryPath,
      clientProtocol,
    );
  }

  return {
    status: "available",
    binaryPath,
    clientVersion,
    protocol: clientProtocol,
    socketPath: readString(server.socket),
  };
}

/**
 * Sessions reported by `herdr session list --json`.
 *
 * Unparseable output yields an empty list rather than a throw: the session list
 * is a convenience for picking a name, and losing it must not take down the
 * availability verdict that the fallback decision depends on.
 */
export function parseHerdrSessions(outcome: HerdrCommandOutcome | null): HerdrSession[] {
  if (outcome === null || !outcome.ok) return [];
  const parsed = readRecord(parseJson(outcome.stdout));
  const sessions = parsed?.sessions;
  if (!Array.isArray(sessions)) return [];

  const result: HerdrSession[] = [];
  for (const entry of sessions) {
    const record = readRecord(entry);
    const name = readString(record?.name);
    if (name === null) continue;
    result.push({
      name,
      running: record?.running === true,
      isDefault: record?.default === true,
      socketPath: readString(record?.socket_path),
    });
  }
  return result;
}

/**
 * The argv that attaches to a durable Herdr session.
 *
 * Exposed so the terminal manager never assembles a Herdr command itself and the
 * exact invocation is covered by a test.
 */
export function herdrAttachCommand(
  availability: HerdrAvailability,
  sessionName: string,
): { readonly shell: string; readonly args: string[] } | null {
  if (availability.status !== "available") return null;
  return { shell: availability.binaryPath, args: ["session", "attach", sessionName] };
}
