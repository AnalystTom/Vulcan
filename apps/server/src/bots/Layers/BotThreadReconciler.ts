// FILE: Layers/BotThreadReconciler.ts
// Purpose: Keeps bot_tasks consistent with thread lifecycle — when a task's thread is
//          deleted (by the user, by project deletion, ...), the task row is archived so
//          the roster never points at a thread that no longer exists.
// Layer: Server domain reactor (mirrors automation/Layers/AutomationRunReactor.ts)

import type { OrchestrationEvent, ThreadId } from "@vulcan/contracts";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@vulcan/shared/DrainableWorker";
import { Cause, Effect, Layer, Stream } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { BotService } from "../Services/BotService.ts";
import {
  BotThreadReconciler,
  type BotThreadReconcilerShape,
} from "../Services/BotThreadReconciler.ts";

const BOT_THREAD_RECONCILER_CAPACITY = 128;

function threadIdOf(event: OrchestrationEvent): ThreadId | null {
  if (event.aggregateKind !== "thread") {
    return null;
  }
  return event.aggregateId as ThreadId;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const botService = yield* BotService;

  const reconcileSafely = (input: { readonly threadId: ThreadId; readonly deleted: boolean }) =>
    (input.deleted
      ? botService.reconcileDeletedThread({ threadId: input.threadId })
      : botService.reconcileThreadRuntime({ threadId: input.threadId })
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("bot thread reconciler failed to archive task", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(reconcileSafely, {
    capacity: BOT_THREAD_RECONCILER_CAPACITY,
  });

  const start: BotThreadReconcilerShape["start"] = Effect.fn(function* () {
    yield* startDrainableWorkerProducers(
      worker,
      Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          const threadId = threadIdOf(event);
          return threadId
            ? worker
                .enqueue({ threadId, deleted: event.type === "thread.deleted" })
                .pipe(Effect.asVoid)
            : Effect.void;
        }),
      ).pipe(Effect.asVoid),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies BotThreadReconcilerShape;
});

export const BotThreadReconcilerLive = Layer.effect(BotThreadReconciler, make);
