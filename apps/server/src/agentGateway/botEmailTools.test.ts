import { describe, expect, it, vi } from "vitest";
import { Effect, Option } from "effect";
import { makeBotEmailTools } from "./botEmailTools.ts";
import type { BotRepositoryShape } from "../persistence/Services/BotRepository.ts";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore.ts";
import type { ToolContext } from "./toolRuntime.ts";
const sdk = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue({ inboxId: "own@agentmail.to" }),
  list: vi.fn().mockResolvedValue({ messages: [] }),
}));
vi.mock("agentmail", () => ({
  AgentMailClient: class {
    inboxes = { get: sdk.get, messages: { list: sdk.list } };
  },
}));
describe("bot inbox boundary", () => {
  it("uses the caller's stored inbox and never an inbox supplied in arguments", async () => {
    const repository = {
      getBotByThreadId: () => Effect.succeed(Option.some({ id: "bot-a", archivedAt: null })),
    } as unknown as BotRepositoryShape;
    const secrets = {
      get: (name: string) =>
        Effect.succeed(
          new TextEncoder().encode(
            name === "agentmail-api-key" ? "private-test-key" : "own@agentmail.to",
          ),
        ),
    } as unknown as ServerSecretStoreShape;
    const tools = makeBotEmailTools(repository, secrets);
    const context = { callerThreadId: "thread-a" } as ToolContext;
    const result = await Effect.runPromise(
      tools
        .find((tool) => tool.definition.name === "vulcan_email_read")!
        .handler({ inboxId: "other@agentmail.to" }, context),
    );
    expect(sdk.list).toHaveBeenCalledWith("own@agentmail.to", { limit: 20 });
    expect(JSON.stringify(result)).not.toContain("private-test-key");
  });
});
