// FILE: BotMemoryEditor.tsx
// Purpose: Read and edit a bot's MEMORY.md, warn when it outgrew the per-turn budget, and
//          browse the memory/<topic>.md files the bot keeps beside it.
// Layer: Web UI component
// Exports: BotMemoryEditor

import {
  BOT_MEMORY_FILE_MAX_BYTES,
  BOT_MEMORY_PROMPT_MAX_BYTES,
  BOT_MEMORY_PROMPT_MAX_LINES,
  type BotId,
} from "@vulcan/contracts";
import { formatBytes } from "@vulcan/shared/formatBytes";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Textarea } from "~/components/ui/textarea";
import { ensureNativeApi } from "~/nativeApi";

export function BotMemoryEditor({
  botId,
  onSave,
  saving,
}: {
  botId: BotId;
  onSave: (text: string) => Promise<void>;
  saving: boolean;
}) {
  const query = useQuery({
    queryKey: ["bot-memory", botId],
    queryFn: () => ensureNativeApi().bots.getMemory({ botId }),
  });
  const [text, setText] = useState("");
  useEffect(() => {
    if (query.data) setText(query.data.memory.text);
  }, [query.data]);

  if (query.isLoading) return <p className="text-sm text-muted-foreground">Loading memory…</p>;
  if (query.error) {
    return <p className="text-sm text-destructive">Could not load memory: {query.error.message}</p>;
  }

  const savedText = query.data?.memory.text ?? "";
  const truncatedForPrompt = query.data?.memory.truncatedForPrompt ?? false;
  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-heading text-base font-semibold">Memory</h2>
        <p className="text-xs text-muted-foreground">
          This file is read fresh before every task turn. Keep durable, verified facts here.
        </p>
      </div>
      <Textarea
        aria-label="Bot memory"
        className="min-h-64 font-mono"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {truncatedForPrompt ? (
        <p
          role="status"
          className="rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          Over the budget — only the top of this file loads each turn. The first{" "}
          {BOT_MEMORY_PROMPT_MAX_LINES} lines or{" "}
          {BOT_MEMORY_PROMPT_MAX_BYTES.toLocaleString("en-US")} bytes ride into the prompt,
          whichever comes first. Move longer notes into a memory/&lt;topic&gt;.md file the bot can
          open on demand.
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button
          disabled={saving || text === savedText}
          onClick={() => void onSave(text).then(() => void query.refetch())}
        >
          {saving ? "Saving…" : "Save memory"}
        </Button>
      </div>
      <BotMemoryTopics botId={botId} />
    </div>
  );
}

/**
 * The bot's topic files. Listing is name + size only and the contents of one file are
 * fetched on open, so a bot with a large pile of notes costs nothing until the user looks.
 * Read-only: MEMORY.md is what the user curates, topic files are what the bot wrote.
 */
function BotMemoryTopics({ botId }: { botId: BotId }) {
  const [open, setOpen] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const topicsQuery = useQuery({
    queryKey: ["bot-memory-topics", botId],
    queryFn: () => ensureNativeApi().bots.listMemoryTopics({ botId }),
    enabled: open,
  });
  const topicQuery = useQuery({
    queryKey: ["bot-memory-topic", botId, selectedName],
    queryFn: () =>
      ensureNativeApi().bots.getMemoryTopic({
        botId,
        name: selectedName ?? "",
      }),
    enabled: open && selectedName !== null,
  });

  const topics = topicsQuery.data?.topics ?? [];

  return (
    <div className="rounded-xl border border-border">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <DisclosureChevron open={open} />
        <span className="text-xs font-medium">Topic files</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {open && topicsQuery.isLoading ? "Loading…" : `memory/ · ${topics.length}`}
        </span>
      </button>
      <DisclosureRegion open={open}>
        <div className="space-y-2 px-4 pb-4">
          {topicsQuery.error ? (
            <p className="text-xs text-destructive">
              Could not list topic files: {topicsQuery.error.message}
            </p>
          ) : null}
          {selectedName === null ? (
            topics.length === 0 && !topicsQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">
                No topic files yet. The bot writes longer notes to memory/&lt;topic&gt;.md and reads
                them on demand.
              </p>
            ) : (
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {topics.map((topic) => (
                  <button
                    key={topic.name}
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/50"
                    onClick={() => setSelectedName(topic.name)}
                  >
                    <span className="truncate font-mono text-xs">{topic.name}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {formatBytes(topic.bytes)}
                    </span>
                  </button>
                ))}
              </div>
            )
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs">memory/{selectedName}</span>
                <Button size="sm" variant="ghost" onClick={() => setSelectedName(null)}>
                  Back
                </Button>
              </div>
              {topicQuery.isLoading ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : topicQuery.error ? (
                <p className="text-xs text-destructive">
                  Could not open this file: {topicQuery.error.message}
                </p>
              ) : (
                <>
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs">
                    {topicQuery.data?.topic.text}
                  </pre>
                  {topicQuery.data?.topic.truncated ? (
                    <p className="text-[11px] text-muted-foreground">
                      Showing the first {formatBytes(BOT_MEMORY_FILE_MAX_BYTES)} of{" "}
                      {formatBytes(topicQuery.data.topic.bytes)}. Open the file in the bot workspace
                      to read the rest.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          )}
        </div>
      </DisclosureRegion>
    </div>
  );
}
