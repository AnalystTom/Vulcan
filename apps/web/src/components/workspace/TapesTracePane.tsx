// FILE: TapesTracePane.tsx
// Purpose: Read locally captured Tapes sessions and spans.

import { IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";

const REFRESH_INTERVAL_MS = 2_000;

interface TapesSession {
  readonly id: string;
  readonly harness_id: string;
  readonly cwd: string | null;
  readonly started_at: string;
  readonly last_seen_at: string;
  readonly turn_count: number;
  readonly total_input_tokens: number;
  readonly total_output_tokens: number;
  readonly total_cost_usd: number;
  readonly derived_status: string;
}
interface TapesSpan {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly status: string;
  readonly duration_ns: number;
}
interface TapesTrace {
  readonly trace: { readonly id: string; readonly status: string; readonly span_count: number };
  readonly spans: readonly TapesSpan[];
}
interface TapesSessionDetail {
  readonly traces: readonly TapesTrace[];
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
function formatDuration(ns: number): string {
  if (ns < 1_000_000) return `${Math.round(ns / 1_000)}µs`;
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(1)}ms`;
  return `${(ns / 1_000_000_000).toFixed(1)}s`;
}

export function TapesTracePane({ isVisible }: { readonly isVisible: boolean }) {
  const [sessions, setSessions] = useState<readonly TapesSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TapesSessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(resolveWsHttpUrl("/api/tapes/sessions"));
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as { readonly items: readonly TapesSession[] };
      setSessions(payload.items);
      setSelectedId((current) =>
        current && payload.items.some((session) => session.id === current)
          ? current
          : (payload.items[0]?.id ?? null),
      );
      setError(null);
      setRefreshVersion((version) => version + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read Tapes.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!isVisible) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isVisible, refresh]);
  useEffect(() => {
    if (!selectedId || !isVisible) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          resolveWsHttpUrl(`/api/tapes/sessions/${encodeURIComponent(selectedId)}/traces`),
        );
        if (!response.ok) throw new Error(await response.text());
        const next = (await response.json()) as TapesSessionDetail;
        if (!cancelled) setDetail(next);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not read trace.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isVisible, refreshVersion, selectedId]);
  if (loading) return <PanelMessage>Looking for local Tapes traces…</PanelMessage>;
  if (error) return <PanelMessage>{error}</PanelMessage>;
  if (sessions.length === 0)
    return (
      <PanelMessage>
        No captured agent sessions yet. Start an agent and its trace will appear here.
      </PanelMessage>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
        <select
          aria-label="Captured agent session"
          className="min-w-0 flex-1 truncate rounded border border-border bg-background px-1.5 py-1 text-xs"
          value={selectedId ?? ""}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {session.harness_id} · {formatDate(session.last_seen_at)} · {session.turn_count} turns
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Refresh Tapes traces"
          onClick={() => void refresh()}
        >
          <IconRefresh className="size-3.5" aria-hidden />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {sessions
          .filter((session) => session.id === selectedId)
          .map((session) => (
            <section key={session.id} className="mb-3 rounded border border-border p-3 text-xs">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-medium">
                <span>{session.harness_id}</span>
                <span className="text-muted-foreground">{session.derived_status}</span>
                <span>{session.turn_count} turns</span>
                <span>{session.total_input_tokens + session.total_output_tokens} tokens</span>
                <span>${session.total_cost_usd.toFixed(4)}</span>
              </div>
              <p className="mt-2 break-all text-muted-foreground">
                {session.cwd ?? "No working directory recorded"}
              </p>
              <p className="mt-1 text-muted-foreground">Started {formatDate(session.started_at)}</p>
            </section>
          ))}
        {detail?.traces.map((trace) => (
          <section
            key={trace.trace.id}
            className="mb-3 overflow-hidden rounded border border-border"
          >
            <header className="flex items-center justify-between border-b border-border px-3 py-2 text-xs">
              <span className="font-medium">Trace {trace.trace.id}</span>
              <span className="text-muted-foreground">
                {trace.trace.status} · {trace.trace.span_count} spans
              </span>
            </header>
            <ul className="divide-y divide-border">
              {trace.spans.map((span) => (
                <li key={span.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                  <span className="w-12 shrink-0 uppercase text-muted-foreground">{span.kind}</span>
                  <span className="min-w-0 flex-1 truncate">{span.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {formatDuration(span.duration_ns)}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{span.status}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
function PanelMessage({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
