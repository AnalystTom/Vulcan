// FILE: herdr.ts
// Purpose: Contract for the Herdr terminal backend -- whether it is usable, and
// what durable sessions it is currently hosting.
// Layer: contract (schema only)
//
// Herdr is a separate product invoked as a subprocess. Vulcan can therefore
// never assume it is present, current, or running, and the one thing it must
// never do is quietly substitute its own terminal and let the operator believe
// they are looking at a durable Herdr session. Availability is consequently an
// explicit tagged value with a typed reason, not a boolean and not an absence.

import { Schema } from "effect";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

/**
 * Oldest Herdr socket protocol Vulcan will attach to. Below this the session
 * verbs Vulcan depends on are missing or shaped differently, and attaching would
 * fail in ways that look like a broken terminal rather than a version problem.
 */
export const HERDR_MIN_PROTOCOL = 14;

/** Why Herdr cannot be used right now. Each maps to a different operator remedy. */
export const HerdrUnavailableReason = Schema.Literals([
  /** No `herdr` executable on PATH or at the configured location -- install it. */
  "binary-missing",
  /** The binary is present but `herdr status` did not answer -- it may be broken or wedged. */
  "status-unreadable",
  /** Installed, but older than HERDR_MIN_PROTOCOL -- update it. */
  "protocol-too-old",
  /** Installed and current, but its background server is not running -- start it. */
  "server-not-running",
  /** The server is running but reports itself incompatible with its own client. */
  "server-incompatible",
]);
export type HerdrUnavailableReason = typeof HerdrUnavailableReason.Type;

export const HerdrAvailable = Schema.Struct({
  status: Schema.Literal("available"),
  binaryPath: TrimmedNonEmptyString,
  clientVersion: TrimmedNonEmptyString,
  protocol: NonNegativeInt,
  socketPath: Schema.NullOr(TrimmedNonEmptyString),
});
export type HerdrAvailable = typeof HerdrAvailable.Type;

export const HerdrUnavailable = Schema.Struct({
  status: Schema.Literal("unavailable"),
  reason: HerdrUnavailableReason,
  /** Operator-facing detail: the version found, the stderr, the path searched. */
  detail: Schema.String.check(Schema.isMaxLength(2_000)),
  /** Present when a binary was found but rejected, so the UI can name the version. */
  binaryPath: Schema.NullOr(TrimmedNonEmptyString),
  protocol: Schema.NullOr(NonNegativeInt),
});
export type HerdrUnavailable = typeof HerdrUnavailable.Type;

export const HerdrAvailability = Schema.Union([HerdrAvailable, HerdrUnavailable]);
export type HerdrAvailability = typeof HerdrAvailability.Type;

export const HerdrSession = Schema.Struct({
  name: TrimmedNonEmptyString,
  running: Schema.Boolean,
  isDefault: Schema.Boolean,
  socketPath: Schema.NullOr(TrimmedNonEmptyString),
});
export type HerdrSession = typeof HerdrSession.Type;

export const HerdrStatus = Schema.Struct({
  availability: HerdrAvailability,
  /** Empty whenever Herdr is unavailable; never a guess. */
  sessions: Schema.Array(HerdrSession),
  checkedAt: Schema.String,
});
export type HerdrStatus = typeof HerdrStatus.Type;

/**
 * How a terminal should be launched.
 *
 * The client names a capability; the server resolves the command. A client can
 * never hand over an arbitrary argv, because the WebSocket is reachable by a
 * paired mobile client and an enrolled worker, and "run this command" is not a
 * capability any of them should hold.
 */
export const TerminalLaunch = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("shell") }),
  Schema.Struct({
    kind: Schema.Literal("herdr"),
    sessionName: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  }),
]);
export type TerminalLaunch = typeof TerminalLaunch.Type;
