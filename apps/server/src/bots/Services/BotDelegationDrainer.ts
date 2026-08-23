import { Effect, Scope, ServiceMap } from "effect";

export interface BotDelegationDrainerShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class BotDelegationDrainer extends ServiceMap.Service<
  BotDelegationDrainer,
  BotDelegationDrainerShape
>()("vulcan/bots/Services/BotDelegationDrainer") {}
