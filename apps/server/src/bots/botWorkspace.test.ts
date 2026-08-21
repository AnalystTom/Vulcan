import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { BOT_MEMORY_FILE_MAX_BYTES, BOT_MEMORY_PROMPT_MAX_BYTES } from "@vulcan/contracts";
import { Effect } from "effect";
import { afterAll, describe } from "vitest";

import { BotWorkspaceError } from "./Errors.ts";
import {
  BOT_MEMORY_SEED,
  ensureBotWorkspace,
  loadBotMemoryForPrompt,
  readBotMemoryFile,
  writeBotMemoryFile,
} from "./botWorkspace.ts";

const tempRoots: Array<string> = [];

function makeBotsWorkspaceRoot(): string {
  const root = mkdtempSync(nodePath.join(os.tmpdir(), "vulcan-bot-workspace-"));
  tempRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const scaffold = (botId: string) =>
  ensureBotWorkspace({ botsWorkspaceRoot: makeBotsWorkspaceRoot(), botId }).pipe(
    Effect.provide(NodeServices.layer),
  );

describe("botWorkspace", () => {
  it.effect("scaffolds the workspace: memory dir, seeded MEMORY.md, instruction files", () =>
    Effect.gen(function* () {
      const workspaceDir = yield* scaffold("bot-scaffold");

      assert.strictEqual(
        readFileSync(nodePath.join(workspaceDir, "MEMORY.md"), "utf8"),
        BOT_MEMORY_SEED,
      );
      const agents = readFileSync(nodePath.join(workspaceDir, "AGENTS.md"), "utf8");
      const claude = readFileSync(nodePath.join(workspaceDir, "CLAUDE.md"), "utf8");
      assert.strictEqual(agents, claude);
      assert.include(agents, "MEMORY.md");

      // The seed is instructions, not memory: it must load as empty.
      const memory = yield* loadBotMemoryForPrompt({ workspaceDir }).pipe(
        Effect.provide(NodeServices.layer),
      );
      assert.deepStrictEqual(memory, { text: "", truncated: false });
    }),
  );

  it.effect("is idempotent and never overwrites files the user already has", () =>
    Effect.gen(function* () {
      const botsWorkspaceRoot = makeBotsWorkspaceRoot();
      const workspaceDir = yield* ensureBotWorkspace({
        botsWorkspaceRoot,
        botId: "bot-idempotent",
      }).pipe(Effect.provide(NodeServices.layer));

      writeFileSync(nodePath.join(workspaceDir, "MEMORY.md"), "- the user prefers tabs\n");
      writeFileSync(nodePath.join(workspaceDir, "AGENTS.md"), "custom instructions\n");

      const again = yield* ensureBotWorkspace({ botsWorkspaceRoot, botId: "bot-idempotent" }).pipe(
        Effect.provide(NodeServices.layer),
      );

      assert.strictEqual(again, workspaceDir);
      assert.strictEqual(
        readFileSync(nodePath.join(workspaceDir, "MEMORY.md"), "utf8"),
        "- the user prefers tabs\n",
      );
      assert.strictEqual(
        readFileSync(nodePath.join(workspaceDir, "AGENTS.md"), "utf8"),
        "custom instructions\n",
      );
    }),
  );

  it.effect("loads exactly 200 lines without truncation and cuts the 201st", () =>
    Effect.gen(function* () {
      const workspaceDir = yield* scaffold("bot-lines");
      const twoHundredLines = Array.from({ length: 200 }, (_, i) => `line-${i + 1}`).join("\n");
      writeFileSync(nodePath.join(workspaceDir, "MEMORY.md"), twoHundredLines);

      const exact = yield* loadBotMemoryForPrompt({ workspaceDir }).pipe(
        Effect.provide(NodeServices.layer),
      );
      assert.deepStrictEqual(exact, { text: twoHundredLines, truncated: false });

      writeFileSync(nodePath.join(workspaceDir, "MEMORY.md"), `${twoHundredLines}\nline-201`);
      const over = yield* loadBotMemoryForPrompt({ workspaceDir }).pipe(
        Effect.provide(NodeServices.layer),
      );
      assert.deepStrictEqual(over, { text: twoHundredLines, truncated: true });
    }),
  );

  it.effect("byte cap cuts cleanly instead of leaving a broken multibyte character", () =>
    Effect.gen(function* () {
      const workspaceDir = yield* scaffold("bot-bytes");
      // "a" + 8000 x "€" (3 bytes each) = 24_001 bytes: the byte cap lands mid-"€".
      const content = `a${"€".repeat(8_000)}`;
      assert.strictEqual(Buffer.byteLength(content, "utf8"), BOT_MEMORY_PROMPT_MAX_BYTES + 1);
      writeFileSync(nodePath.join(workspaceDir, "MEMORY.md"), content);

      const memory = yield* loadBotMemoryForPrompt({ workspaceDir }).pipe(
        Effect.provide(NodeServices.layer),
      );
      assert.strictEqual(memory.truncated, true);
      assert.strictEqual(memory.text, `a${"€".repeat(7_999)}`);
      assert.notInclude(memory.text, "�");
    }),
  );

  it.effect("readBotMemoryFile returns the whole file and flags what the prompt would cut", () =>
    Effect.gen(function* () {
      const workspaceDir = yield* scaffold("bot-read-full");
      const content = Array.from({ length: 201 }, (_, i) => `line-${i + 1}`).join("\n");
      writeFileSync(nodePath.join(workspaceDir, "MEMORY.md"), content);

      const memory = yield* readBotMemoryFile({ workspaceDir }).pipe(
        Effect.provide(NodeServices.layer),
      );
      assert.strictEqual(memory.text, content);
      assert.strictEqual(memory.truncated, true);
    }),
  );

  it.effect("writeBotMemoryFile round-trips and rejects oversized writes", () =>
    Effect.gen(function* () {
      const workspaceDir = yield* scaffold("bot-write");

      yield* writeBotMemoryFile({
        workspaceDir,
        text: "- verified: deploys run on Fridays\n",
      }).pipe(Effect.provide(NodeServices.layer));
      const memory = yield* loadBotMemoryForPrompt({ workspaceDir }).pipe(
        Effect.provide(NodeServices.layer),
      );
      assert.deepStrictEqual(memory, {
        text: "- verified: deploys run on Fridays\n",
        truncated: false,
      });

      const error = yield* writeBotMemoryFile({
        workspaceDir,
        text: "a".repeat(BOT_MEMORY_FILE_MAX_BYTES + 1),
      }).pipe(Effect.provide(NodeServices.layer), Effect.flip);
      assert.instanceOf(error, BotWorkspaceError);
      assert.strictEqual(error.operation, "writeBotMemoryFile:validate");

      // The oversized write must not have clobbered the previous memory.
      const preserved = yield* loadBotMemoryForPrompt({ workspaceDir }).pipe(
        Effect.provide(NodeServices.layer),
      );
      assert.strictEqual(preserved.text, "- verified: deploys run on Fridays\n");
    }),
  );
});
