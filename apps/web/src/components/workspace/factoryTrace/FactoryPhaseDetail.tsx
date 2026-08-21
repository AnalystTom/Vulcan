// FILE: FactoryPhaseDetail.tsx
// Purpose: The evidence behind one phase -- its envelope, its gates and what
// they checked, and the events it produced.
// Layer: Workspace UI
//
// Clicking a block has to answer "why does it say that", so this shows receipts.
// Gate checks are the important part: the factory records one `{item, ok, note}`
// per thing a gate inspected, so a green gate can say *what* it verified rather
// than only that it passed. A gate with no recorded checks is labelled as such,
// never rendered as though it checked nothing.

import type { TraceEnvelope, TraceEvent, TraceGateResult, TracePhase } from "@vulcan/contracts";
import {
  parseAgentSpawn,
  parseEventMessage,
  parsePhaseUsage,
  parseToolCall,
} from "@vulcan/shared/factoryTracePayload";
import { IconX } from "@tabler/icons-react";
import { useState } from "react";

import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { IconButton } from "~/components/ui/icon-button";
import { formatClockDuration } from "~/session-logic";
import { cn } from "~/lib/utils";

import { PHASE_STATUS_LABEL, PHASE_STATUS_TONE } from "./traceTheme";

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function FactoryPhaseDetail({
  phase,
  events,
  envelopes,
  gates,
  onClose,
}: {
  readonly phase: TracePhase;
  readonly events: readonly TraceEvent[];
  readonly envelopes: readonly TraceEnvelope[];
  readonly gates: readonly TraceGateResult[];
  readonly onClose: () => void;
}) {
  const phaseEvents = events.filter((event) => event.phaseId === phase.phaseId);
  const phaseEnvelopes = envelopes.filter((envelope) => envelope.phaseId === phase.phaseId);
  const phaseGates = gates.filter((gate) => gate.phaseId === phase.phaseId);
  const status = phase.status ?? "queued";

  const startedMs = phase.startedAt === null ? Number.NaN : Date.parse(phase.startedAt);
  const endedMs = phase.endedAt === null ? Number.NaN : Date.parse(phase.endedAt);
  const toolCalls = phaseEvents.filter((event) => event.type === "tool_call");
  // Receipts for how this phase's worker was spawned and what it spent, read
  // from its own events so the panel answers "which model, how many tokens".
  const spawn = parseAgentSpawn(phaseEvents);
  const usage = parsePhaseUsage(phaseEvents);

  return (
    <section className="border-t border-border bg-muted/20 px-3 py-2 text-xs">
      <header className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
          {phase.kind ?? "phase"}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{phase.name ?? phase.phaseId}</p>
          <p className="truncate text-muted-foreground">{phase.description ?? ""}</p>
        </div>
        <IconButton label="Close phase detail" onClick={onClose}>
          <IconX className="size-3.5" aria-hidden />
        </IconButton>
      </header>

      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
        <Fact label="Owner">{phase.owner ?? "—"}</Fact>
        <Fact label="Status">
          <span className={PHASE_STATUS_TONE[status]}>{PHASE_STATUS_LABEL[status]}</span>
        </Fact>
        {phase.attempt !== null && phase.attempt > 1 ? (
          <Fact label="Attempt">#{phase.attempt}</Fact>
        ) : null}
        {/* A retry here is a correction inside the same session, not a restart. */}
        {phase.retries !== null && phase.retries > 0 ? (
          <Fact label="Corrections">{phase.retries}</Fact>
        ) : null}
        {Number.isFinite(startedMs) ? (
          <Fact label="Started">{new Date(startedMs).toLocaleTimeString()}</Fact>
        ) : null}
        {Number.isFinite(startedMs) && Number.isFinite(endedMs) ? (
          <Fact label="Took">{formatClockDuration(endedMs - startedMs)}</Fact>
        ) : null}
        {toolCalls.length > 0 ? <Fact label="Tool calls">{toolCalls.length}</Fact> : null}
        {/* The model this phase actually spawned on -- can differ across a run. */}
        {spawn?.model ? (
          <Fact label="Model">
            <span className="font-mono text-[11px]">{spawn.model}</span>
          </Fact>
        ) : null}
        {spawn?.sessionId ? (
          <Fact label="Session">
            <span className="font-mono text-[11px]" title={spawn.sessionId}>
              {spawn.sessionId}
            </span>
          </Fact>
        ) : null}
        {/* What moved through this phase, not what the whole run was billed. */}
        {usage?.read !== null && usage?.read !== undefined ? (
          <Fact label="Tokens in">
            <span
              className="font-mono text-[11px]"
              title="Prompt tokens read (input + cache writes)"
            >
              {COMPACT.format(usage.read)}
            </span>
          </Fact>
        ) : null}
        {usage?.written !== null && usage?.written !== undefined ? (
          <Fact label="Tokens out">
            <span className="font-mono text-[11px]" title="Tokens generated">
              {COMPACT.format(usage.written)}
            </span>
          </Fact>
        ) : null}
      </dl>

      {phase.error ? (
        <p className="mt-2 rounded border border-destructive/40 bg-destructive/5 px-1.5 py-1 text-destructive">
          {phase.error}
        </p>
      ) : null}

      {phaseGates.map((gate) => (
        <GateVerdict key={gate.id} gate={gate} />
      ))}

      {phaseEnvelopes.map((envelope) => (
        <EnvelopeRow key={envelope.envelopeId} envelope={envelope} />
      ))}

      {phaseEvents.length > 0 ? <EventList events={phaseEvents} /> : null}
    </section>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </>
  );
}

function GateVerdict({ gate }: { readonly gate: TraceGateResult }) {
  const [open, setOpen] = useState(!gate.passed);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-accent"
      >
        <DisclosureChevron open={open} className="size-3" />
        <span
          className={cn(
            "font-medium",
            gate.passed ? PHASE_STATUS_TONE.success : PHASE_STATUS_TONE.fail,
          )}
        >
          {gate.passed ? "✓" : "✗"} {gate.gate ?? "gate"}
        </span>
        {gate.attempt !== null && gate.attempt > 1 ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            attempt {gate.attempt}
          </span>
        ) : null}
      </button>
      <DisclosureRegion open={open}>
        <div className="pl-4 text-muted-foreground">
          {gate.checks === null ? (
            // Not the same claim as "checked nothing" — say which one it is.
            <p>This trace predates recorded checks, so only the verdict survives.</p>
          ) : (
            <ul>
              {gate.checks.map((check) => (
                <li key={check.item}>
                  <span className={check.ok ? PHASE_STATUS_TONE.success : PHASE_STATUS_TONE.fail}>
                    {check.ok ? "✓" : "✗"}
                  </span>{" "}
                  {check.item} — {check.note}
                </li>
              ))}
            </ul>
          )}
          {gate.violations.map((violation) => (
            <p key={violation} className="text-destructive">
              {violation}
            </p>
          ))}
        </div>
      </DisclosureRegion>
    </div>
  );
}

/**
 * The typed handoff this phase produced.
 *
 * Rendered as the raw JSON the factory stored: it is the contract the next agent
 * actually read, and prettifying it into prose would show something no node ever
 * saw.
 */
function EnvelopeRow({ envelope }: { readonly envelope: TraceEnvelope }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-accent"
      >
        <DisclosureChevron open={open} className="size-3" />
        <span className="min-w-0 flex-1 truncate">
          envelope{envelope.outputType ? ` · ${envelope.outputType}` : ""}
        </span>
        <span
          className={cn(
            "shrink-0 text-[10px]",
            envelope.valid ? PHASE_STATUS_TONE.success : PHASE_STATUS_TONE.fail,
          )}
        >
          {envelope.valid ? "parsed" : "invalid"}
        </span>
      </button>
      <DisclosureRegion open={open}>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-1.5 text-[11px]">
          {prettyJson(envelope.payloadJson)}
        </pre>
      </DisclosureRegion>
    </div>
  );
}

function EventList({ events }: { readonly events: readonly TraceEvent[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-accent"
      >
        <DisclosureChevron open={open} className="size-3" />
        Events ({events.length})
      </button>
      <DisclosureRegion open={open}>
        <ul className="mt-1 max-h-64 overflow-auto">
          {events.map((event) => (
            <EventRow key={event.eventId} event={event} />
          ))}
        </ul>
      </DisclosureRegion>
    </div>
  );
}

/**
 * One event, told in the terms of its type.
 *
 * The raw `name` is often just a status word; the useful part -- the tool that
 * ran, the model an agent spawned on, why something failed -- lives in the
 * payload, so each type reads its own out rather than showing the same opaque
 * line for all ten.
 */
function EventRow({ event }: { readonly event: TraceEvent }) {
  const detail = describeEvent(event);
  const failed = event.type === "error" || (event.type === "tool_call" && detail.failed);
  return (
    <li className="flex min-w-0 items-baseline gap-1.5 py-px">
      <span className="w-16 shrink-0 truncate font-mono text-[10px] text-muted-foreground">
        {event.type ?? "event"}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", failed && PHASE_STATUS_TONE.fail)}>
        {detail.text}
      </span>
      {event.tokens !== null && event.tokens > 0 ? (
        <span
          className="shrink-0 font-mono text-[10px] text-muted-foreground"
          title="Billed tokens"
        >
          {COMPACT.format(event.tokens)}
        </span>
      ) : null}
    </li>
  );
}

function describeEvent(event: TraceEvent): { readonly text: string; readonly failed: boolean } {
  switch (event.type) {
    case "agent_start": {
      const spawn = parseAgentSpawn([event]);
      return {
        text: spawn?.model ? `${event.name ?? "agent"} · ${spawn.model}` : (event.name ?? "agent"),
        failed: false,
      };
    }
    case "tool_call": {
      const call = parseToolCall(event.payloadJson);
      const label = call.summary ?? event.name ?? call.tool ?? "tool call";
      return { text: label, failed: call.failed };
    }
    case "error": {
      const message = parseEventMessage(event.payloadJson);
      return { text: message ?? event.name ?? "error", failed: true };
    }
    case "handoff": {
      const message = parseEventMessage(event.payloadJson);
      return { text: message ?? event.name ?? "handoff", failed: false };
    }
    default:
      return { text: event.name ?? "", failed: false };
  }
}

function prettyJson(raw: string | null): string {
  if (raw === null) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // Not JSON is a fact about the trace, so show it as written.
    return raw;
  }
}
