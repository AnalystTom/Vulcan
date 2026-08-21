import { describe, expect, it } from "vitest";

import { buildBotMemoryBlock, buildBotStaticPersona, buildBotTurnContext } from "./botPrompt.ts";

describe("buildBotStaticPersona", () => {
  it("renders name, role, and about", () => {
    expect(
      buildBotStaticPersona({
        name: "Maus",
        title: "Chief of Staff",
        description: "Coordinates the other bots.",
      }),
    ).toBe(
      "You are Maus, a bot teammate in Vulcan.\nRole: Chief of Staff.\nAbout: Coordinates the other bots.",
    );
  });

  it("omits empty title and description instead of rendering blank fields", () => {
    expect(buildBotStaticPersona({ name: "Maus", title: "", description: "  " })).toBe(
      "You are Maus, a bot teammate in Vulcan.",
    );
  });
});

describe("buildBotMemoryBlock", () => {
  it("returns empty for empty memory", () => {
    expect(buildBotMemoryBlock({ memoryText: "", truncated: false })).toBe("");
    expect(buildBotMemoryBlock({ memoryText: "  \n ", truncated: false })).toBe("");
  });

  it("wraps memory with the provenance rule", () => {
    const block = buildBotMemoryBlock({ memoryText: "- user prefers tabs", truncated: false });
    expect(block).toContain("- user prefers tabs");
    expect(block).toContain("MEMORY.md");
    expect(block).toContain("Record only facts you verified");
    expect(block).not.toContain("Memory truncated");
  });

  it("adds a truncation note when the excerpt was clipped", () => {
    const block = buildBotMemoryBlock({ memoryText: "- user prefers tabs", truncated: true });
    expect(block).toContain("Memory truncated to the load budget.");
  });
});

describe("buildBotTurnContext", () => {
  it("joins persona and memory with a blank line", () => {
    expect(buildBotTurnContext({ persona: "P", memoryBlock: "M" })).toBe("P\n\nM");
  });

  it("drops empty parts", () => {
    expect(buildBotTurnContext({ persona: "P", memoryBlock: "" })).toBe("P");
    expect(buildBotTurnContext({ persona: "", memoryBlock: "" })).toBe("");
  });
});
