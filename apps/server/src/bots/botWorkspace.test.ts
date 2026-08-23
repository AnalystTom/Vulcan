import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  isBotMemoryTopicName,
  listBotMemoryTopics,
  loadBotMemoryForPrompt,
  readBotMemoryFile,
  readBotMemoryTopic,
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

  it("isBotMemoryTopicName gates every name listing and reading share", () => {
    for (const name of ["notes.md", "Q3 plan.md", "deploy-runbook.md", "a.md", "_private.md"]) {
      assert.strictEqual(isBotMemoryTopicName(name), true, name);
    }
    for (const name of [
      "",
      "notes",
      "notes.txt",
      "notes.MD",
      ".hidden.md",
      "..",
      "../MEMORY.md",
      "nested/notes.md",
      "nested\\notes.md",
      "/etc/passwd.md",
      "note\n.md",
      `${"a".repeat(201)}.md`,
    ]) {
      assert.strictEqual(isBotMemoryTopicName(name), false, JSON.stringify(name));
    }
  });

  it.effect("lists only valid topic files, sorted, with their sizes", () =>
    Effect.gen(function* () {
      const workspaceDir = yield* scaffold("bot-topics");
      const topicsDir = nodePath.join(workspaceDir, "memory");
      writeFileSync(nodePath.join(topicsDir, "zebra.md"), "z");
      writeFileSync(nodePath.join(topicsDir, "alpha.md"), "alpha notes");
      // Everything the name gate rejects must stay invisible to the UI.
      writeFileSync(nodePath.join(topicsDir, ".secret.md"), "hidden");
      writeFileSync(nodePath.join(topicsDir, "notes.txt"), "not markdown");
      mkdirSync(nodePath.join(topicsDir, "folder.md"));

      const topics = yield* listBotMemoryTopics({ workspaceDir }).pipe(
        Effect.provide(NodeServices.layer),
      );
      assert.deepStrictEqual(topics, [
        { name: "alpha.md", bytes: 11 },
        { name: "zebra.md", bytes: 1 },
      ]);
    }),
  );

  it.effect("lists nothing when the memory directory is missing", () =>
    Effect.gen(function* () {
      const topics = yield* listBotMemoryTopics({
        workspaceDir: nodePath.join(makeBotsWorkspaceRoot(), "never-scaffolded"),
      }).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(topics, []);
    }),
  );

  it.effect("readBotMemoryTopic returns contents and refuses anything outside memory/", () =>
    Effect.gen(function* () {
      const workspaceDir = yield* scaffold("bot-topic-read");
      const contents = "# Runbook\nstep one\n";
      writeFileSync(nodePath.join(workspaceDir, "memory", "runbook.md"), contents);

      const topic = yield* readBotMemoryTopic({
        workspaceDir,
        name: "runbook.md",
      }).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(topic, {
        name: "runbook.md",
        text: contents,
        bytes: Buffer.byteLength(contents, "utf8"),
        truncated: false,
      });

      for (const name of ["../MEMORY.md", "nested/runbook.md", "missing.md"]) {
        const denied = yield* readBotMemoryTopic({ workspaceDir, name }).pipe(
          Effect.provide(NodeServices.layer),
        );
        assert.strictEqual(denied, null, name);
      }
    }),
  );

  it.effect("a symlink planted in memory/ is neither listed nor readable", () =>
    Effect.gen(function* () {
      const workspaceDir = yield* scaffold("bot-topic-symlink");
      const outsider = nodePath.join(workspaceDir, "OUTSIDE.md");
      writeFileSync(outsider, "secrets\n");
      symlinkSync(outsider, nodePath.join(workspaceDir, "memory", "link.md"));

      const topics = yield* listBotMemoryTopics({ workspaceDir }).pipe(
        Effect.provide(NodeServices.layer),
      );
      assert.deepStrictEqual(topics, []);

      const topic = yield* readBotMemoryTopic({
        workspaceDir,
        name: "link.md",
      }).pipe(Effect.provide(NodeServices.layer));
      assert.strictEqual(topic, null);
    }),
  );

  it.effect("readBotMemoryTopic caps an oversized topic file at the memory byte limit", () =>
    Effect.gen(function* () {
      const workspaceDir = yield* scaffold("bot-topic-oversized");
      const content = "a".repeat(BOT_MEMORY_FILE_MAX_BYTES + 10);
      writeFileSync(nodePath.join(workspaceDir, "memory", "huge.md"), content);

      const topic = yield* readBotMemoryTopic({
        workspaceDir,
        name: "huge.md",
      }).pipe(Effect.provide(NodeServices.layer));
      assert.strictEqual(topic?.truncated, true);
      assert.strictEqual(topic?.bytes, BOT_MEMORY_FILE_MAX_BYTES + 10);
      assert.strictEqual(topic?.text.length, BOT_MEMORY_FILE_MAX_BYTES);
    }),
  );
});
