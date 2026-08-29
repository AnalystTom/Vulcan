import { describe, expect, it } from "vitest";

import { parseOmpModelSlug, parseOmpModelsJson, toOmpProviderModelDescriptor } from "./ompModels";

describe("ompModels", () => {
  it("parses provider-qualified slugs", () => {
    expect(parseOmpModelSlug("qwen3090/qwen3.8-27b")).toEqual({
      provider: "qwen3090",
      id: "qwen3.8-27b",
    });
    expect(parseOmpModelSlug("qwen3.8-27b")).toEqual({ id: "qwen3.8-27b" });
  });

  it("parses omp models --json output", () => {
    const models = parseOmpModelsJson(
      JSON.stringify({
        models: [
          {
            provider: "qwen3090",
            id: "qwen3.8-27b",
            selector: "qwen3090/qwen3.8-27b",
            name: "qwen3.8-27b",
            contextWindow: 32768,
            reasoning: true,
            thinking: ["minimal", "low", "medium", "high"],
          },
        ],
      }),
    );
    expect(models).toEqual([
      {
        provider: "qwen3090",
        id: "qwen3.8-27b",
        selector: "qwen3090/qwen3.8-27b",
        name: "qwen3.8-27b",
        contextWindow: 32768,
        reasoning: true,
        thinking: ["minimal", "low", "medium", "high"],
      },
    ]);
    expect(toOmpProviderModelDescriptor(models[0]!).slug).toBe("qwen3090/qwen3.8-27b");
  });
});
