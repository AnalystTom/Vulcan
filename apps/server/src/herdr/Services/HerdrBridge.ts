/**
 * Access to the Herdr terminal backend.
 *
 * Herdr is a separate product Vulcan shells out to. This service is the only
 * place that knows that, and it exposes exactly two things: whether Herdr can be
 * used, and how to attach to one of its durable sessions.
 *
 * It deliberately cannot produce a fallback. When Herdr is unavailable,
 * `resolveAttachCommand` returns null and the caller has to surface the
 * unavailable state, because a bridge that could quietly hand back a plain shell
 * would let a fallback terminal be presented and recorded as Herdr.
 */
import type { HerdrAvailability, HerdrStatus } from "@vulcan/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface HerdrBridgeShape {
  /**
   * Current availability plus the sessions Herdr is hosting.
   *
   * Cached briefly; `refresh` forces a re-probe for when the operator has just
   * installed, updated, or started Herdr and is retrying.
   */
  readonly status: (options?: { readonly refresh?: boolean }) => Effect.Effect<HerdrStatus>;

  /** Availability alone, for callers that do not need the session list. */
  readonly availability: (options?: {
    readonly refresh?: boolean;
  }) => Effect.Effect<HerdrAvailability>;

  /**
   * Ensures a new named session is supervised on Linux, then returns the argv
   * that attaches to it. Existing running sessions are reused unchanged.
   */
  readonly resolveAttachCommand: (
    sessionName: string,
    cwd: string,
  ) => Effect.Effect<{ readonly shell: string; readonly args: string[] } | null>;
}

export class HerdrBridge extends ServiceMap.Service<HerdrBridge, HerdrBridgeShape>()(
  "vulcan/herdr/Services/HerdrBridge/HerdrBridge",
) {}
