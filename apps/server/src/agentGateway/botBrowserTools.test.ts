import { expect, it } from "vitest";
import { serverBrowserArguments } from "./botBrowserTools.ts";
it("binds browser storage to the bot and passes input as arguments, never shell code", () => {
  const args = serverBrowserArguments("/workspace/bot-a", "bot-a", "fill", {
    ref: "@e1",
    text: "$(touch /tmp/no)",
  });
  expect(args).toContain("/workspace/bot-a/browser");
  expect(args.slice(-3)).toEqual(["fill", "@e1", "$(touch /tmp/no)"]);
  expect(() => serverBrowserArguments("/a", "a", "open", { url: "file:///etc/passwd" })).toThrow();
  expect(() => serverBrowserArguments("/a", "a", "eval", {})).toThrow();
});
it("runs the server browser Effect handler with a real child process", async () => {
  const { Effect, Option } = await import("effect");
  const { makeBotServerBrowserTools } = await import("./botBrowserTools.ts");
  const repository = {
    getBotByThreadId: () =>
      Effect.succeed(Option.some({ id: "bot-a", workspaceDir: "/tmp/bot-a", archivedAt: null })),
  } as unknown as import("../persistence/Services/BotRepository.ts").BotRepositoryShape;
  const result = await Effect.runPromise(
    makeBotServerBrowserTools(repository, "/usr/bin/true")[0]!.handler({}, {
      callerThreadId: "thread-a",
    } as import("./toolRuntime.ts").ToolContext),
  );
  expect(result.isError).not.toBe(true);
});
