import {
  CHIEF_OF_STAFF_CALL_ROUTE,
  type Bot,
  type ChiefOfStaffCallRequestResult,
  type ChiefOfStaffCallStatusResult,
} from "@vulcan/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";

const ACTIVE_PHASES = new Set(["dialing", "ringing", "in-progress"]);

const PHASE_LABELS = {
  dialing: "Calling",
  ringing: "Ringing",
  "in-progress": "In conversation",
  completed: "Call ended",
  failed: "Call failed",
} as const;

async function requestJson<T>(options: { readonly method?: "GET" | "POST"; readonly body?: unknown }) {
  const response = await fetch(resolveWsHttpUrl(CHIEF_OF_STAFF_CALL_ROUTE), {
    method: options.method ?? "GET",
    credentials: "include",
    ...(options.body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options.body),
        }),
  });
  const payload = (await response.json().catch(() => null)) as
    | T
    | { readonly error?: unknown }
    | null;
  if (!response.ok) {
    const message =
      payload && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `Call me request failed with status ${response.status}.`;
    throw new Error(message);
  }
  return payload as T;
}

export function ChiefOfStaffCallPanel({ bot }: { readonly bot: Bot }) {
  const [topic, setTopic] = useState("");
  const status = useQuery({
    queryKey: ["chief-of-staff-call", bot.id],
    queryFn: () => requestJson<ChiefOfStaffCallStatusResult>({}),
    refetchInterval: (query) => {
      const phase = query.state.data?.latestCall?.phase;
      return phase && ACTIVE_PHASES.has(phase) ? 2_000 : false;
    },
  });
  const startCall = useMutation({
    mutationFn: () =>
      requestJson<ChiefOfStaffCallRequestResult>({
        method: "POST",
        body: { topic: topic.trim() || undefined },
      }),
    onSuccess: async () => {
      toastManager.add({ type: "success", title: `${bot.name} is calling you.` });
      await status.refetch();
    },
    onError: (error: Error) => toastManager.add({ type: "error", title: error.message }),
  });
  const latestCall = status.data?.latestCall ?? null;
  const active = latestCall ? ACTIVE_PHASES.has(latestCall.phase) : false;

  return (
    <section className="space-y-4" data-testid="chief-of-staff-call-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-base font-semibold">Call me</h2>
          <p className="max-w-2xl text-xs text-muted-foreground">
            Ask {bot.name} to call your configured number with a current, read-only briefing from
            Vulcan’s project, thread, pull request, bot, and Factory trace data.
          </p>
        </div>
        {latestCall ? (
          <span
            className="rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium"
            data-testid="chief-of-staff-call-status"
          >
            {PHASE_LABELS[latestCall.phase]}
          </span>
        ) : null}
      </div>

      {status.isLoading ? (
        <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
          Checking call readiness…
        </p>
      ) : status.isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <p className="font-medium text-destructive">Call readiness could not be loaded.</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => void status.refetch()}>
            Retry
          </Button>
        </div>
      ) : !status.data?.configured ? (
        <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div>
            <p className="text-sm font-medium">Finish secure call setup</p>
            <p className="text-xs text-muted-foreground">
              Credentials stay on the Vulcan server. The call control remains disabled until every
              required value is supplied. Providers verify credentials when a call is requested.
            </p>
          </div>
          <ul className="space-y-1.5 text-xs" data-testid="chief-of-staff-call-setup">
            {status.data?.setupSteps.map((step) => (
              <li key={step.id} className="flex items-start gap-2">
                <span
                  className={step.configured ? "text-emerald-500" : "text-amber-500"}
                  aria-hidden="true"
                >
                  {step.configured ? "✓" : "○"}
                </span>
                <span className={step.configured ? "text-muted-foreground" : undefined}>
                  {step.label}
                </span>
              </li>
            ))}
          </ul>
          {status.data?.openAiWebhookUrl ? (
            <div className="rounded-lg border border-border bg-background/70 px-3 py-2 text-xs">
              <p className="text-muted-foreground">OpenAI webhook URL</p>
              <p className="mt-1 break-all font-mono select-all">{status.data.openAiWebhookUrl}</p>
            </div>
          ) : null}
        </div>
      ) : (
        <form
          className="space-y-3 rounded-xl border border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!active && !startCall.isPending) startCall.mutate();
          }}
        >
          <div>
            <p className="text-sm font-medium">
              {status.data.destinationLabel ? `Call ${status.data.destinationLabel}` : "Call me"}
            </p>
            <p className="text-xs text-muted-foreground">
              Twilio originates the phone call; OpenAI Realtime handles the private voice session.
            </p>
          </div>
          <Textarea
            aria-label="What should your Chief of Staff call about?"
            placeholder="Optional: what should we discuss?"
            maxLength={1_000}
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            disabled={active || startCall.isPending}
          />
          <Button type="submit" disabled={active || startCall.isPending}>
            {startCall.isPending ? "Requesting call…" : active ? "Call in progress" : "Call me"}
          </Button>
        </form>
      )}

      {latestCall?.error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {latestCall.error}
        </p>
      ) : null}
      {latestCall ? (
        <p className="text-[11px] text-muted-foreground">
          Last update {new Date(latestCall.updatedAt).toLocaleString()}
          {latestCall.topic ? ` · Topic: ${latestCall.topic}` : ""}
        </p>
      ) : null}
    </section>
  );
}
