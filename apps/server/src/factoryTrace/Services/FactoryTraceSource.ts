/**
 * Where Vulcan reads a software factory's trace from.
 *
 * Deliberately a service with three read methods and no writes. Vulcan does not
 * run the factory: an external ADW process owns sequencing, retries, and
 * acceptance, and writes what happened as it happens. Everything here is a poll
 * of that store.
 *
 * The seam exists so the store is swappable. Today it is the Super Simple
 * Software Factory's SQLite trace; tomorrow it could be another factory's, or a
 * remote one, and nothing above this interface would change -- which is the
 * point, because the pane must not learn what a `sssf.db` is.
 */
import type {
  AdwId,
  ThreadId,
  TraceSessionDetail,
  TraceSessionSummary,
  TraceSourceStatus,
} from "@vulcan/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

/** A trace that exists but could not be read. Never used for "no factory here". */
export class FactoryTraceError extends Data.TaggedError("FactoryTraceError")<{
  readonly message: string;
}> {}

export interface FactoryTraceSourceShape {
  /**
   * Whether a trace can be read for this thread, and where from.
   *
   * An absent database is an ordinary answer rather than an error: most
   * workspaces have no factory stamped into them, and the pane has to say that
   * plainly instead of drawing an empty run.
   */
  readonly status: (input: {
    readonly threadId: ThreadId | null;
  }) => Effect.Effect<TraceSourceStatus>;

  readonly listSessions: (input: {
    readonly threadId: ThreadId | null;
    readonly limit?: number | undefined;
  }) => Effect.Effect<readonly TraceSessionSummary[], FactoryTraceError>;

  /**
   * One session, with everything needed to draw it.
   *
   * `after` is the rowid cursor from the previous read: events above it are the
   * only ones returned, so a live pane asks for what it has not seen and the
   * same query serves both live and history.
   */
  readonly readSession: (input: {
    readonly threadId: ThreadId | null;
    readonly adwId: AdwId;
    readonly after?: number | undefined;
  }) => Effect.Effect<TraceSessionDetail | null, FactoryTraceError>;
}

export class FactoryTraceSource extends ServiceMap.Service<
  FactoryTraceSource,
  FactoryTraceSourceShape
>()("vulcan/factoryTrace/Services/FactoryTraceSource/FactoryTraceSource") {}
