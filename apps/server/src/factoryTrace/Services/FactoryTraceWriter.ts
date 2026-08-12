// FILE: FactoryTraceWriter.ts
// Purpose: Expose the native-runtime-to-SSSF writer lifecycle and a direct test seam.
// Layer: Server factory trace

import type { ProviderRuntimeEvent } from "@vulcan/contracts";
import { ServiceMap, type Effect, type Scope } from "effect";

export interface FactoryTraceWriterShape {
  readonly append: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class FactoryTraceWriter extends ServiceMap.Service<
  FactoryTraceWriter,
  FactoryTraceWriterShape
>()("vulcan/factoryTrace/Services/FactoryTraceWriter") {}
