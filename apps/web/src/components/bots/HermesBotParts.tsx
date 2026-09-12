// FILE: HermesBotParts.tsx
// Purpose: Small presentational parts shared by the native Hermes Bot surfaces — real avatars,
//          labels derived from gateway data, time formatting, the evidence disclosure, and the
//          approval / clarify prompt cards. Nothing here fabricates a status: every label maps a
//          field the gateway actually sent.
// Layer: Web UI (bots)
// Exports: HermesAvatar, hermesProfileLabel, hermesProfileHasRecentActivity, relativeIso, absoluteIso,
//          EvidenceDisclosure, ApprovalCard, ClarifyCard, StatusPill, SectionHeading, ErrorNotice

import { useState, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Textarea } from "~/components/ui/textarea";
import {
  useHermesProfileAvatar,
  type HermesPendingApproval,
  type HermesPendingClarify,
  type HermesProfile,
} from "~/hooks/useHermesBots";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";

/** A recent heartbeat is activity evidence, not confirmation that the worker is still running. */
const RECENT_ACTIVITY_WINDOW_MS = 2 * 60_000;

export function hermesProfileLabel(profile: Pick<HermesProfile, "title" | "displayName" | "name">) {
  return profile.title?.trim() || profile.displayName.trim() || profile.name;
}

export function hermesProfileHasRecentActivity(
  profile: Pick<HermesProfile, "workerLastActiveIso">,
  now = Date.now(),
) {
  if (!profile.workerLastActiveIso) return false;
  const at = Date.parse(profile.workerLastActiveIso);
  return Number.isFinite(at) && now - at <= RECENT_ACTIVITY_WINDOW_MS;
}

export function relativeIso(iso: string | null): string | null {
  return iso ? formatRelativeTime(iso) : null;
}

export function absoluteIso(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : null;
}

function initialsOf(text: string) {
  return (
    text
      .split(/[\s_-]+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "B"
  );
}

/** The profile's uploaded avatar when the gateway has one; initials otherwise. */
export function HermesAvatar({
  profile,
  className,
}: {
  profile: Pick<HermesProfile, "name" | "hasAvatar" | "title" | "displayName">;
  className?: string;
}) {
  const avatar = useHermesProfileAvatar(profile.name, profile.hasAvatar);
  const label = hermesProfileLabel(profile);
  const base = cn(
    "flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[42%] bg-muted font-display text-sm font-semibold text-foreground",
    className,
  );
  if (avatar.data) {
    return <img alt={`${label} avatar`} className={cn(base, "object-cover")} src={avatar.data} />;
  }
  return (
    <div aria-label={`${label} avatar`} className={base}>
      {initialsOf(label)}
    </div>
  );
}

export function StatusPill({
  tone,
  children,
}: {
  tone: "success" | "warning" | "error" | "info" | "outline";
  children: ReactNode;
}) {
  return (
    <Badge variant={tone} size="default">
      {children}
    </Badge>
  );
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="font-heading text-base font-semibold">{title}</h2>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function ErrorNotice({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Alert variant="error" size="sm">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <span className="break-words">{message}</span>
        {onRetry ? (
          <Button size="xs" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** "Details" toggle exposing exact gateway coordinates as evidence, hidden by default. */
export function EvidenceDisclosure({
  label,
  rows,
  json,
  className,
}: {
  label?: string;
  rows: ReadonlyArray<readonly [string, string | number | null | undefined]>;
  json?: unknown;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const visible = rows.filter(
    (row): row is readonly [string, string | number] =>
      row[1] !== null && row[1] !== undefined && row[1] !== "",
  );
  if (visible.length === 0 && json === undefined) return null;
  return (
    <div className={className}>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <DisclosureChevron open={open} className="size-3" />
        {label ?? "Details"}
      </button>
      <DisclosureRegion open={open}>
        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px]">
          {visible.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="break-all font-mono">{String(value)}</dd>
            </div>
          ))}
        </dl>
        {json !== undefined ? (
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 text-[11px] leading-snug">
            {typeof json === "string" ? json : JSON.stringify(json, null, 2)}
          </pre>
        ) : null}
      </DisclosureRegion>
    </div>
  );
}

/** The gateway's approval choices as it names them; the driver's safe set when it sent none. */
const FALLBACK_APPROVAL_CHOICES = ["once", "deny"] as const;

function approvalChoiceLabel(choice: string) {
  switch (choice) {
    case "once":
      return "Allow once";
    case "session":
      return "Allow for this session";
    case "always":
      return "Always allow";
    case "deny":
      return "Deny";
    default:
      return choice;
  }
}

export function ApprovalCard({
  approval,
  who,
  busy,
  onChoose,
}: {
  approval: HermesPendingApproval;
  who: string;
  busy: boolean;
  onChoose: (choice: string) => void;
}) {
  const choices = approval.choices.length > 0 ? approval.choices : FALLBACK_APPROVAL_CHOICES;
  return (
    <Alert variant="warning">
      <AlertTitle>{who} is waiting for your approval</AlertTitle>
      <AlertDescription>
        {approval.description ? <span>{approval.description}</span> : null}
        {approval.command ? (
          <pre className="max-h-32 overflow-auto rounded-md bg-muted/40 p-2 text-[11px] leading-snug">
            {approval.command}
          </pre>
        ) : null}
        {!approval.description && !approval.command ? (
          <span>
            The gateway did not include the action text; the request id below is the only identity.
          </span>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          {choices.map((choice) => (
            <Button
              key={choice}
              size="xs"
              variant={choice === "deny" ? "destructive-outline" : "outline"}
              disabled={busy}
              onClick={() => onChoose(choice)}
            >
              {approvalChoiceLabel(choice)}
            </Button>
          ))}
        </div>
        <EvidenceDisclosure rows={[["request_id", approval.requestId]]} />
      </AlertDescription>
    </Alert>
  );
}

export function ClarifyCard({
  clarify,
  who,
  busy,
  onAnswer,
}: {
  clarify: HermesPendingClarify;
  who: string;
  busy: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [text, setText] = useState("");
  const single = clarify.questions.length === 1 ? (clarify.questions[0] ?? null) : null;
  return (
    <Alert variant="info">
      <AlertTitle>{who} has a question</AlertTitle>
      <AlertDescription>
        {clarify.questions.map((question, index) => (
          <div key={question.qid ?? index} className="space-y-1">
            <span className="text-foreground">{question.question}</span>
            {single && question.choices.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {question.choices.map((choice) => (
                  <Button
                    key={choice}
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onAnswer(choice)}
                  >
                    {choice}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!text.trim() || busy) return;
            onAnswer(text.trim());
            setText("");
          }}
        >
          <Textarea
            size="sm"
            aria-label="Your answer"
            placeholder={single ? "Type an answer" : "Answer all questions in one message"}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={busy || !text.trim()}>
            Answer
          </Button>
        </form>
        <EvidenceDisclosure rows={[["request_id", clarify.requestId]]} />
      </AlertDescription>
    </Alert>
  );
}
