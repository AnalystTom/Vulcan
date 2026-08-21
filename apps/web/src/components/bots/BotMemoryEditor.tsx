import type { BotId } from "@vulcan/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
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
      <div className="flex justify-end">
        <Button
          disabled={saving || text === savedText}
          onClick={() => void onSave(text).then(() => void query.refetch())}
        >
          {saving ? "Saving…" : "Save memory"}
        </Button>
      </div>
    </div>
  );
}
