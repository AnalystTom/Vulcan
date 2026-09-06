import { type ModelSlug, type ProviderKind } from "@vulcan/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { useProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";

const choices = [
  ["GitHub & shipping", "PRs, reviews, CI, release notes"],
  ["Engineering marketing", "Launches, docs, positioning, changelogs"],
  ["Day-to-day ops", "Issues, status updates, digests"],
  ["Something else", "You’ve got a specific job in mind"],
] as const;

export function NewBotChat({
  onCreate,
  onCancel,
  pending,
}: {
  onCreate: (input: { message: string; provider: ProviderKind; model: ModelSlug }) => Promise<void>;
  onCancel: () => void;
  pending: boolean;
}) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const statuses = useProviderStatusesForLocalConfig();
  const provider = statuses.find(
    (status) => status.available && status.authStatus !== "unauthenticated",
  )?.provider;
  const catalog = useProviderModelCatalog({
    selectedProvider: provider ?? "codex",
    discoveryEnabled: true,
  });
  const model = provider ? catalog.modelOptionsByProvider[provider][0]?.slug : undefined;
  const busy = pending || sending;
  return (
    <main className="flex h-full min-h-0 w-full flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <h1 className="font-medium">New agent</h1>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-between gap-8 overflow-y-auto px-6 py-10">
        <section
          className="max-w-xl rounded-2xl border border-border bg-muted/30 p-4"
          aria-label="Agent setup"
        >
          <h2 className="font-medium">What should I lean into first for you?</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            I’ll adapt from here — pick whatever’s most useful right now.
          </p>
          <div className="mt-4 overflow-hidden rounded-xl border border-border">
            {choices.map(([title, detail]) => (
              <button
                key={title}
                type="button"
                disabled={busy}
                className="block w-full border-b border-border p-3 text-left text-sm last:border-b-0 hover:bg-muted"
                onClick={() => {
                  setMessage(
                    title === "Something else"
                      ? ""
                      : `I want you to handle ${title.toLowerCase()}: ${detail}.`,
                  );
                  document.getElementById("new-bot-message")?.focus();
                }}
              >
                <span className="block">{title}</span>
                <span className="text-muted-foreground">{detail}</span>
              </button>
            ))}
          </div>
        </section>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!provider || !model || !message.trim() || busy) return;
            setSending(true);
            setError("");
            void onCreate({ message: message.trim(), provider, model })
              .catch((cause) =>
                setError(cause instanceof Error ? cause.message : "Could not start this agent."),
              )
              .finally(() => setSending(false));
          }}
        >
          {!provider || !model ? (
            <p role="status" className="text-sm text-muted-foreground">
              No ready model yet. Connect a provider to start chatting.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Textarea
            id="new-bot-message"
            aria-label="Message your new agent"
            placeholder="Type your own answer"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            autoFocus
            disabled={busy}
            rows={3}
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={busy || !provider || !model || !message.trim()}>
              {busy ? "Starting…" : "Send"}
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}
