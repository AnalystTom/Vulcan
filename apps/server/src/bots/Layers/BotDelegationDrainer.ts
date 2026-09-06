// FILE: Layers/BotDelegationDrainer.ts
// Purpose: Watches provider turn settles and hands them to BotCommsService so the comms depth
//          ledger is cleared and queued delegations run only after the delegating turn ended.
// Layer: Server domain reactor (mirrors bots/Layers/BotThreadReconciler.ts)

import type { ProviderRuntimeEvent, ThreadId } from "@vulcan/contracts";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@vulcan/shared/DrainableWorker";
import { Cause, Effect, Layer, Stream } from "effect";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { BotCommsService } from "../Services/BotCommsService.ts";
import {
  BotDelegationDrainer,
  type BotDelegationDrainerShape,
} from "../Services/BotDelegationDrainer.ts";

const DRAINER_CAPACITY = 128;

type SettledTurn = {
  readonly threadId: ThreadId;
  readonly outcome: "completed" | "failed" | "interrupted";
};

export function settledTurnOf(event: ProviderRuntimeEvent): SettledTurn | null {
  if (event.type === "turn.completed") {
    return {
      threadId: event.threadId,
      outcome:
        event.payload.state === "completed"
          ? "completed"
          : event.payload.state === "failed"
            ? "failed"
            : "interrupted",
    };
  }
  if (event.type === "turn.aborted") {
    return { threadId: event.threadId, outcome: "interrupted" };
  }
  return null;
}

const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const botComms = yield* BotCommsService;

  const settleSafely = (input: SettledTurn) =>
    botComms.onTurnSettled(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("bot delegation drainer failed", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(settleSafely, { capacity: DRAINER_CAPACITY });

  const start: BotDelegationDrainerShape["start"] = Effect.fn(function* () {
    yield* botComms.recoverAtStartup.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("bot delegation recovery failed at startup", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* startDrainableWorkerProducers(
      worker,
      Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) => {
          const settled = settledTurnOf(event);
          return settled ? worker.enqueue(settled).pipe(Effect.asVoid) : Effect.void;
        }),
      ).pipe(Effect.asVoid),
    );
  });

  return { start, drain: worker.drain } satisfies BotDelegationDrainerShape;
});

export const BotDelegationDrainerLive = Layer.effect(BotDelegationDrainer, make);
