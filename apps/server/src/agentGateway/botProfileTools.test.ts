import { describe, expect, it } from "vitest";
import { decodeBotProfileUpdate } from "./botProfileTools.ts";
describe("chat bot profile updates", () => {
  it("binds profile changes to the caller and rejects permission or machine changes", () => {
    expect(
      decodeBotProfileUpdate("bot-1", { name: "Marketing", title: "Distribution" }),
    ).toMatchObject({ id: "bot-1", name: "Marketing" });
    for (const change of [
      { id: "someone-else" },
      { capabilityGrants: ["shell.execute"] },
      { runtimeMode: "full-access" },
      { workspaceDir: "/" },
    ])
      expect(() => decodeBotProfileUpdate("bot-1", change)).toThrow();
    expect(() => decodeBotProfileUpdate("bot-1", { name: "" })).toThrow();
  });
});

it("executes a chat profile write through the Effect handler", async () => {
  const { Effect, Option } = await import("effect");
  const { makeBotProfileTools } = await import("./botProfileTools.ts");
  const repository = {
    getBotByThreadId: () => Effect.succeed(Option.some({ id: "bot-1", archivedAt: null })),
  } as unknown as import("../persistence/Services/BotRepository.ts").BotRepositoryShape;
  const service = {
    update: (input: unknown) => Effect.succeed({ bot: input }),
  } as unknown as import("../bots/Services/BotService.ts").BotServiceShape;
  const result = await Effect.runPromise(
    makeBotProfileTools(repository, service)[1]!.handler({ name: "Researcher" }, {
      callerThreadId: "thread-1",
    } as import("./toolRuntime.ts").ToolContext),
  );
  expect(JSON.stringify(result)).toContain("Researcher");
  expect(result.isError).not.toBe(true);
});
