import { Effect, Scope, ServiceMap } from "effect";

export interface BotThreadReconcilerShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class BotThreadReconciler extends ServiceMap.Service<
  BotThreadReconciler,
  BotThreadReconcilerShape
>()("vulcan/bots/Services/BotThreadReconciler") {}
