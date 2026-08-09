import { Effect, FileSystem, Layer, Path } from "effect";

import { HerdrBridgeLive } from "../herdr/Layers/HerdrBridge";
import { TerminalManagerLive } from "./Layers/Manager";
import { PtyAdapter } from "./Services/PTY";

type RuntimePtyAdapterLoader = {
  layer: Layer.Layer<PtyAdapter, never, FileSystem.FileSystem | Path.Path>;
};

const runtimePtyAdapterLoaders = {
  bun: () => import("./Layers/BunPTY"),
  node: () => import("./Layers/NodePTY"),
} satisfies Record<string, () => Promise<RuntimePtyAdapterLoader>>;

const makeRuntimePtyAdapterLayer = () =>
  Effect.gen(function* () {
    const runtime = process.versions.bun !== undefined ? "bun" : "node";
    const loader = runtimePtyAdapterLoaders[runtime];
    const ptyAdapterModule = yield* Effect.promise<RuntimePtyAdapterLoader>(loader);
    return ptyAdapterModule.layer;
  }).pipe(Layer.unwrap);

// The Herdr bridge is merged rather than only provided, so the WebSocket layer
// can report Herdr's availability to the UI using the same probe (and the same
// cache) the terminal manager attaches through. Two independent probes could
// disagree, and the UI would then offer a fallback for a Herdr that just worked.
export const TerminalLayerLive = TerminalManagerLive.pipe(
  Layer.provideMerge(HerdrBridgeLive),
  Layer.provide(makeRuntimePtyAdapterLayer()),
);
