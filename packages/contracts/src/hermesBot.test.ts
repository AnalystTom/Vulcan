import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Effect, Schema } from "effect";

import { HermesBotRequest } from "./hermesBot";

describe("Hermes Bot RPC JSON codec", () => {
  it.effect("allows a profile-scoped native model check through the bot bridge", () =>
    Effect.gen(function* () {
      const request = {
        method: "model.check",
        params: { profile: "research", provider: "openai-codex", model: "gpt-5.6-luna" },
      };
      expect(yield* Schema.decodeUnknownEffect(HermesBotRequest)(request)).toEqual(request);
    }),
  );

  it.effect("preserves native params and JSON results on the wire", () =>
    Effect.gen(function* () {
      const request = {
        method: "profiles.list" as const,
        params: {
          include_sessions: true,
          limit: 25,
          profile: null,
          filters: ["active", { hidden: false }],
        },
      };
      const requestCodec = Schema.toCodecJson(HermesBotRequest);
      const requestWire = yield* Schema.encodeUnknownEffect(requestCodec)(request);
      const decodedRequest = yield* Schema.decodeUnknownEffect(requestCodec)(requestWire);
      expect(decodedRequest).toEqual(request);

      const result = {
        profiles: [{ name: "default", model: "claude" }],
        next_cursor: null,
      };
      const resultCodec = Schema.toCodecJson(Schema.Json);
      const resultWire = yield* Schema.encodeUnknownEffect(resultCodec)(result);
      const decodedResult = yield* Schema.decodeUnknownEffect(resultCodec)(resultWire);
      expect(decodedResult).toEqual(result);
    }),
  );
});
