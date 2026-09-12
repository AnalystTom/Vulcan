// FILE: HermesBotConversation.tsx
// Purpose: The two native conversation surfaces — a bot's canonical "Bot Chat" (one forever-chat
//          per profile, resolved by exact title) and a hosted group room (the gateway's durable,
//          attributed discussion log). Both render only what the gateway persisted. A settled
//          turn is shown as execution evidence, never as goal completion.
// Layer: Web UI (bots)
// Exports: HermesBotChat, HermesGroupRoom

import { useEffect, useMemo, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import {
  useHermesChat,
  useHermesChatMutations,
  useHermesRoomLog,
  useHermesRoomMutations,
  useHermesRoomState,
  type HermesChatMessage,
  type HermesProfile,
  type HermesRoom,
  type HermesRoomEvent,
  type HermesRoomPendingAction,
} from "~/hooks/useHermesBots";
import { StopIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import {
  ApprovalCard,
  ClarifyCard,
  ErrorNotice,
  EvidenceDisclosure,
  HermesAvatar,
  StatusPill,
  absoluteIso,
  hermesProfileLabel,
  relativeIso,
} from "./HermesBotParts";

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Follow real messages while the reader is at the bottom; work rows never move the view. */
function useMessageFollow(messageCount: number) {
  const listRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const node = listRef.current;
    if (node && following.current) node.scrollTop = node.scrollHeight;
  }, [messageCount]);
  const onScroll = () => {
    const node = listRef.current;
    if (node) following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
  };
  return { ref: listRef, onScroll };
}

// ── Canonical Bot Chat ─────────────────────────────────────────────────────────

function displayKindLabel(kind: string | null): string | null {
  switch (kind) {
    case null:
    case undefined:
      return null;
    case "auto_continue":
      return "Resumed after an interrupted turn";
    case "steer":
      return "Steered mid-turn";
    case "skill_invocation":
      return "Skill";
    default:
      return kind.replace(/_/g, " ");
  }
}

function ChatMessageRow({ message, who }: { message: HermesChatMessage; who: string }) {
  const time = relativeIso(message.timestampIso);
  if (message.role === "tool") {
    return (
      <div className="px-2 text-[11px] text-muted-foreground">
        <span className="font-medium">
          {who} used {message.toolName ?? "a tool"}
        </span>
        {message.toolContext ? (
          <span className="ml-1 break-words">· {message.toolContext}</span>
        ) : null}
        <EvidenceDisclosure
          rows={[
            ["message row", message.rowId],
            ["tool", message.toolName],
          ]}
          json={message.text || undefined}
        />
      </div>
    );
  }
  if (message.role === "system") {
    return <div className="px-2 text-center text-[11px] text-muted-foreground">{message.text}</div>;
  }
  const mine = message.role === "user";
  const kind = displayKindLabel(message.displayKind);
  return (
    <div className={cn("flex flex-col gap-0.5", mine ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] break-words rounded-2xl px-3 py-2 text-sm",
          mine ? "whitespace-pre-wrap bg-primary/10" : "border border-border bg-background",
        )}
      >
        {mine ? message.text : <ChatMarkdown text={message.text} cwd={undefined} />}
      </div>
      <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
        <span>{mine ? "Incoming message" : who}</span>
        {kind ? <span>· {kind}</span> : null}
        {time ? <span title={absoluteIso(message.timestampIso) ?? undefined}>· {time}</span> : null}
        <EvidenceDisclosure
          rows={[
            ["message row", message.rowId],
            ["role", message.role],
          ]}
        />
      </div>
    </div>
  );
}

export function HermesBotChat({ profile }: { profile: HermesProfile }) {
  const chat = useHermesChat(profile.name, profile.canonical?.id ?? null);
  const actions = useHermesChatMutations(profile.name);
  const [draft, setDraft] = useState("");
  const [deliveryUnconfirmed, setDeliveryUnconfirmed] = useState(false);
  const label = hermesProfileLabel(profile);
  const snapshot = chat.data;
  const messageCount =
    snapshot?.messages.filter((message) => message.role === "user" || message.role === "assistant")
      .length ?? 0;
  const follow = useMessageFollow(messageCount);

  const busy =
    actions.submit.isPending ||
    actions.interrupt.isPending ||
    actions.respondApproval.isPending ||
    actions.respondClarify.isPending;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <HermesAvatar profile={profile} className="size-9 text-xs" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-heading text-base font-semibold">{label}</h2>
          <p className="truncate text-xs text-muted-foreground">
            Bot Chat · @{profile.name}
            {profile.model ? ` · ${profile.model}` : ""}
          </p>
        </div>
        {snapshot?.running ? <StatusPill tone="info">Running</StatusPill> : null}
        {snapshot?.running ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              actions.interrupt.mutate({ runtimeSessionId: snapshot.runtimeSessionId })
            }
          >
            <StopIcon /> Interrupt
          </Button>
        ) : null}
      </header>

      <div {...follow} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
        {chat.isLoading ? (
          <p className="text-sm text-muted-foreground">Opening {label}&apos;s chat…</p>
        ) : chat.error ? (
          <ErrorNotice
            title="Could not open this chat"
            message={chat.error.message}
            onRetry={() => void chat.refetch()}
          />
        ) : snapshot && snapshot.messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No messages yet. Everything you send here stays in this bot&apos;s one chat.
          </p>
        ) : (
          snapshot?.messages.map((message) => (
            <ChatMessageRow
              key={message.rowId ?? `i-${message.index}`}
              message={message}
              who={label}
            />
          ))
        )}
        {snapshot?.pendingApproval ? (
          <ApprovalCard
            approval={snapshot.pendingApproval}
            who={label}
            busy={busy}
            onChoose={(choice) =>
              actions.respondApproval.mutate({
                runtimeSessionId: snapshot.runtimeSessionId,
                requestId: snapshot.pendingApproval?.requestId ?? null,
                choice,
              })
            }
          />
        ) : null}
        {snapshot?.pendingClarify ? (
          <ClarifyCard
            clarify={snapshot.pendingClarify}
            who={label}
            busy={busy}
            onAnswer={(answer) =>
              actions.respondClarify.mutate({
                runtimeSessionId: snapshot.runtimeSessionId,
                requestId: snapshot.pendingClarify?.requestId ?? null,
                answer,
              })
            }
          />
        ) : null}
      </div>

      <form
        className="space-y-2 border-t border-border px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (!snapshot || !text || busy || snapshot.running || deliveryUnconfirmed) return;
          void actions.submit
            .mutateAsync({ runtimeSessionId: snapshot.runtimeSessionId, text })
            .then(() => setDraft(""))
            .catch(() => {
              setDeliveryUnconfirmed(true);
              void chat.refetch();
            });
        }}
      >
        {deliveryUnconfirmed ? (
          <Alert variant="warning" size="sm">
            <AlertTitle>Message delivery is unconfirmed</AlertTitle>
            <AlertDescription>
              Check this conversation and any resulting work before sending again.
              <Button type="button" size="xs" variant="outline" onClick={() => void chat.refetch()}>
                Refresh conversation
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => {
                  setDraft("");
                  setDeliveryUnconfirmed(false);
                }}
              >
                I checked the outcome
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <Textarea
          aria-label={`Message ${label}`}
          placeholder={
            snapshot?.running
              ? "Wait for this turn to finish, or interrupt it."
              : `Message ${label}`
          }
          value={draft}
          disabled={!snapshot || busy || snapshot.running || deliveryUnconfirmed}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <EvidenceDisclosure
            label="Session"
            rows={[
              ["profile", snapshot?.profile],
              ["stored session", snapshot?.storedSessionId],
              ["runtime session", snapshot?.runtimeSessionId],
              ["status", snapshot?.status],
              ["loaded", absoluteIso(snapshot?.loadedAtIso ?? null)],
            ]}
          />
          <Button
            type="submit"
            size="sm"
            disabled={!snapshot || busy || snapshot.running || deliveryUnconfirmed || !draft.trim()}
          >
            {actions.submit.isPending ? "Sending…" : "Send"}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ── Hosted group room ──────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s<>)"']+/g;

function payloadText(payload: Record<string, unknown>): string | null {
  for (const key of ["text", "content", "message", "body"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function payloadString(payload: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

type RoomRowKind = "user" | "member" | "activity" | "system";

interface RoomRow {
  readonly event: HermesRoomEvent;
  readonly kind: RoomRowKind;
  readonly who: string;
  readonly text: string | null;
  readonly label: string | null;
  readonly note: string | null;
}

function memberLabelFactory(room: HermesRoom | null, profiles: readonly HermesProfile[]) {
  return (id: string | null): string | null => {
    if (!id) return null;
    const member = room?.members.find(
      (entry) => entry.memberId === id || entry.profile === id || entry.handle === id,
    );
    const profile = profiles.find((entry) => entry.name === (member?.profile ?? id));
    return (
      member?.displayName ?? (profile ? hermesProfileLabel(profile) : null) ?? member?.handle ?? id
    );
  };
}

function activityLabel(
  kind: string,
  who: string | null,
  payload: Record<string, unknown>,
): { label: string; note: string | null } {
  const subject = who ?? "A member";
  const reason = payloadString(payload, ["reason", "error", "reason_code", "status"]);
  switch (kind) {
    case "turn.started":
      return { label: `${subject} started working`, note: null };
    case "turn.settled":
      return {
        label: `${subject} finished a turn`,
        note: "Execution settled; this is not a verified outcome.",
      };
    case "turn.failed":
      return { label: `${subject} hit an error`, note: reason };
    case "turn.cancelled":
      return { label: `${subject}'s turn was cancelled`, note: reason };
    case "turn.deferred":
      return { label: `${subject} is busy; this turn is queued`, note: reason };
    case "turn.reassigned":
      return { label: `Turn reassigned`, note: reason };
    case "member.unavailable":
      return { label: `${subject} is unavailable`, note: reason };
    case "room.activity":
      return { label: `Room ${reason ?? "activity"}`, note: payloadString(payload, ["thread_id"]) };
    case "room.stop_requested":
      return { label: "Stop requested", note: null };
    case "room.created":
      return { label: "Group created", note: null };
    case "room.renamed":
      return {
        label: `Renamed to ${payloadString(payload, ["name"]) ?? "a new name"}`,
        note: null,
      };
    case "room.members_changed":
      return { label: "Members changed", note: null };
    case "room.disbanded":
      return { label: "Group disbanded", note: null };
    case "authority.claimed":
      return { label: "Gateway authority claimed", note: null };
    case "authority.lost":
      return { label: "Gateway authority lost", note: null };
    default:
      return { label: kind, note: reason };
  }
}

function toRoomRow(
  event: HermesRoomEvent,
  memberLabel: (id: string | null) => string | null,
): RoomRow {
  const actorMember =
    event.actor.profile ?? (event.actor.kind === "member" ? event.actor.id : null);
  const payloadMember = payloadString(event.payload, ["member_id", "profile", "member"]);
  if (event.kind === "message.user") {
    return {
      event,
      kind: "user",
      who: "You",
      text: payloadText(event.payload) ?? "",
      label: null,
      note: null,
    };
  }
  if (event.kind === "message.member") {
    const who = event.actor.displayName ?? memberLabel(actorMember) ?? event.actor.id;
    return {
      event,
      kind: "member",
      who,
      text: payloadText(event.payload) ?? "",
      label: null,
      note: null,
    };
  }
  const who = memberLabel(payloadMember ?? actorMember);
  const { label, note } = activityLabel(event.kind, who, event.payload);
  return {
    event,
    kind: event.actor.kind === "system" ? "system" : "activity",
    who: who ?? "",
    text: null,
    label,
    note,
  };
}

function RoomEventRow({ row }: { row: RoomRow }) {
  const time = relativeIso(row.event.createdAtIso);
  const evidence = (
    <EvidenceDisclosure
      rows={[
        ["seq", row.event.seq],
        ["event_id", row.event.eventId],
        ["kind", row.event.kind],
        ["actor", `${row.event.actor.kind}:${row.event.actor.id}`],
        ["authority_epoch", row.event.authorityEpoch],
        ["created", absoluteIso(row.event.createdAtIso)],
      ]}
      json={row.event.payload}
    />
  );
  if (row.kind === "user" || row.kind === "member") {
    const mine = row.kind === "user";
    return (
      <div className={cn("flex flex-col gap-0.5", mine ? "items-end" : "items-start")}>
        <div
          className={cn(
            "max-w-[85%] break-words rounded-2xl px-3 py-2 text-sm",
            mine ? "whitespace-pre-wrap bg-primary/10" : "border border-border bg-background",
          )}
        >
          {row.text ? (
            mine ? (
              row.text
            ) : (
              <ChatMarkdown text={row.text} cwd={undefined} />
            )
          ) : (
            <span className="text-muted-foreground">(no text in this event)</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
          <span>{row.who}</span>
          {time ? (
            <span title={absoluteIso(row.event.createdAtIso) ?? undefined}>· {time}</span>
          ) : null}
          {evidence}
        </div>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "px-2 text-[11px]",
        row.kind === "system" ? "text-muted-foreground/80" : "text-muted-foreground",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-1.5">
        <span className={cn(row.event.kind === "turn.failed" && "text-destructive")}>
          {row.label}
        </span>
        {time ? (
          <span title={absoluteIso(row.event.createdAtIso) ?? undefined}>· {time}</span>
        ) : null}
        {evidence}
      </div>
      {row.note ? <div className="text-[10px]">{row.note}</div> : null}
    </div>
  );
}

function PendingActionCard({
  action,
  roomId,
  memberLabel,
  busy,
  onApprove,
  onRetry,
}: {
  action: HermesRoomPendingAction;
  roomId: string;
  memberLabel: (id: string | null) => string | null;
  busy: boolean;
  onApprove: (input: {
    roomId: string;
    memberId: string;
    taskId: string;
    executionGeneration: number;
    requestId: string | null;
    choice: string;
  }) => void;
  onRetry: (input: { roomId: string; taskId: string }) => void;
}) {
  const who = memberLabel(action.memberId) ?? "A member";
  if (action.kind === "approval") {
    return (
      <ApprovalCard
        approval={action.approval}
        who={who}
        busy={busy || !action.memberId}
        onChoose={(choice) =>
          action.memberId
            ? onApprove({
                roomId,
                memberId: action.memberId,
                taskId: action.taskId,
                executionGeneration: action.executionGeneration,
                requestId: action.requestId,
                choice,
              })
            : undefined
        }
      />
    );
  }
  if (action.kind === "retry") {
    return (
      <Alert variant="warning">
        <AlertTitle>{who}&apos;s task ended without a known result</AlertTitle>
        <AlertDescription>
          <span>
            The gateway could not confirm whether this task completed. Retrying starts it again;
            check any external destination first if the task could have written something.
          </span>
          <div>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => onRetry({ roomId, taskId: action.taskId })}
            >
              Retry this task
            </Button>
          </div>
          <EvidenceDisclosure rows={[["task_id", action.taskId]]} />
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="info" size="sm">
      <AlertTitle>Pending gateway action: {action.label}</AlertTitle>
    </Alert>
  );
}

interface UnconfirmedSend {
  readonly clientEventId: string;
  readonly text: string;
  readonly error: string;
}

export function HermesGroupRoom({
  roomId,
  profiles,
}: {
  roomId: string;
  profiles: readonly HermesProfile[];
}) {
  const state = useHermesRoomState(roomId);
  const log = useHermesRoomLog(roomId);
  const actions = useHermesRoomMutations();
  const [draft, setDraft] = useState("");
  const [showActivity, setShowActivity] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<UnconfirmedSend | null>(null);
  const room = state.data?.room ?? null;
  const driver = state.data?.driver ?? null;
  const memberLabel = useMemo(() => memberLabelFactory(room, profiles), [room, profiles]);
  const rows = useMemo(
    () => (log.data?.events ?? []).map((event) => toRoomRow(event, memberLabel)),
    [log.data, memberLabel],
  );
  const visibleRows = showActivity
    ? rows
    : rows.filter((row) => row.kind === "user" || row.kind === "member");

  const outcomes = useMemo(() => {
    const lastUserSeq = rows.reduce(
      (seq, row) => (row.kind === "user" ? Math.max(seq, row.event.seq) : seq),
      0,
    );
    if (lastUserSeq === 0) return [];
    const latestByMember = new Map<string, RoomRow>();
    for (const row of rows) {
      if (row.kind === "member" && row.event.seq > lastUserSeq) latestByMember.set(row.who, row);
    }
    return [...latestByMember.values()].map((row) => ({
      row,
      links: [...new Set((row.text ?? "").match(URL_RE) ?? [])],
    }));
  }, [rows]);

  const follow = useMessageFollow(
    rows.filter((row) => row.kind === "user" || row.kind === "member").length,
  );

  const busy =
    actions.send.isPending ||
    actions.stop.isPending ||
    actions.retry.isPending ||
    actions.approve.isPending;

  const sendWithId = (clientEventId: string, text: string) => {
    void actions.send
      .mutateAsync({ roomId, clientEventId, text })
      .then(() => {
        setUnconfirmed(null);
        setDraft("");
      })
      .catch((cause: unknown) => setUnconfirmed({ clientEventId, text, error: errorText(cause) }));
  };

  const tone = !driver
    ? ("outline" as const)
    : driver.blocked
      ? ("warning" as const)
      : driver.working
        ? ("info" as const)
        : ("success" as const);
  const statusLabel = !driver
    ? "Driver not running"
    : driver.blocked
      ? "Needs attention"
      : driver.working
        ? "Working"
        : "Idle";
  const liveCount = driver
    ? Object.entries(driver.counts)
        .filter(([status]) => !["completed", "cancelled", "failed"].includes(status))
        .reduce((sum, [, count]) => sum + count, 0)
    : 0;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="space-y-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            {renaming !== null && room ? (
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = renaming.trim();
                  if (!name || name === room.name) return setRenaming(null);
                  void actions.rename.mutateAsync({ roomId, name }).then(() => setRenaming(null));
                }}
              >
                <Input
                  aria-label="Group name"
                  size="sm"
                  value={renaming}
                  autoFocus
                  onChange={(event) => setRenaming(event.target.value)}
                />
                <Button type="submit" size="sm" disabled={actions.rename.isPending}>
                  Save
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <button
                type="button"
                className="max-w-full truncate text-left font-heading text-base font-semibold hover:underline"
                title="Rename group"
                onClick={() => room && setRenaming(room.name)}
              >
                {room?.name ?? "Group"}
              </button>
            )}
            <p className="truncate text-xs text-muted-foreground">
              {room
                ? room.members
                    .map((member) => memberLabel(member.memberId) ?? member.profile)
                    .join(", ")
                : "Loading members…"}
            </p>
          </div>
          <StatusPill tone={tone}>{statusLabel}</StatusPill>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !driver || (!driver.working && liveCount === 0)}
            onClick={() => actions.stop.mutate({ roomId })}
          >
            <StopIcon /> Stop
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Switch checked={showActivity} onCheckedChange={setShowActivity} />
            Show activity
          </label>
          <EvidenceDisclosure
            label="Room"
            rows={[
              ["room_id", room?.roomId],
              ["authority", room?.authorityGatewayId],
              ["epoch", room?.authorityEpoch],
              ["revision", room?.revision],
              ["latest_seq", log.data?.latestSeq],
              ["created", absoluteIso(room?.createdAtIso ?? null)],
              ["driver counts", driver ? JSON.stringify(driver.counts) : null],
            ]}
          />
        </div>
      </header>

      <div {...follow} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
        {state.error ? (
          <ErrorNotice
            title="Could not read this group"
            message={state.error.message}
            onRetry={() => void state.refetch()}
          />
        ) : null}
        {log.error ? (
          <ErrorNotice
            title="Could not read the group log"
            message={log.error.message}
            onRetry={() => void log.refetch()}
          />
        ) : null}
        {!driver && state.data ? (
          <Alert variant="warning" size="sm">
            <AlertTitle>The group driver is not running on the gateway</AlertTitle>
            <AlertDescription>
              Messages are stored, but nobody will answer until the gateway&apos;s Group Chat worker
              is up.
            </AlertDescription>
          </Alert>
        ) : null}
        {driver?.pendingActions.map((action, index) => (
          <PendingActionCard
            key={`${action.kind}-${"taskId" in action ? action.taskId : index}`}
            action={action}
            roomId={roomId}
            memberLabel={memberLabel}
            busy={busy}
            onApprove={(input) => actions.approve.mutate(input)}
            onRetry={(input) => actions.retry.mutate(input)}
          />
        ))}
        {log.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading the discussion…</p>
        ) : visibleRows.length === 0 && !log.error ? (
          <p className="text-sm text-muted-foreground">Nothing has been said here yet.</p>
        ) : (
          visibleRows.map((row) => <RoomEventRow key={row.event.seq} row={row} />)
        )}
        {log.data?.hasMore ? (
          <p className="text-[11px] text-muted-foreground">
            More events exist; they load on the next refresh.
          </p>
        ) : null}
      </div>

      {outcomes.length > 0 ? <OutcomesPanel outcomes={outcomes} /> : null}

      <form
        className="space-y-2 border-t border-border px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || unconfirmed) return;
          const text = draft.trim();
          if (!text) return;
          sendWithId(crypto.randomUUID(), text);
        }}
      >
        {unconfirmed ? (
          <Alert variant="warning" size="sm">
            <AlertTitle>Delivery unconfirmed</AlertTitle>
            <AlertDescription>
              <span>{unconfirmed.error}</span>
              <span>
                Retrying reuses the same message id, so the gateway cannot store it twice.
              </span>
              <div className="flex gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => sendWithId(unconfirmed.clientEventId, unconfirmed.text)}
                >
                  Retry same message
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setUnconfirmed(null)}
                >
                  Discard
                </Button>
              </div>
              <EvidenceDisclosure rows={[["client event id", unconfirmed.clientEventId]]} />
            </AlertDescription>
          </Alert>
        ) : null}
        <Textarea
          aria-label="Message the group"
          placeholder={
            unconfirmed
              ? "Resolve the unconfirmed message first."
              : "Message the group. Mention a member with @name."
          }
          value={unconfirmed ? unconfirmed.text : draft}
          disabled={busy || unconfirmed !== null || !room}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
              event.currentTarget.form?.requestSubmit();
          }}
        />
        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            disabled={busy || unconfirmed !== null || !room || !draft.trim()}
          >
            {actions.send.isPending ? "Sending…" : "Send"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function OutcomesPanel({
  outcomes,
}: {
  outcomes: ReadonlyArray<{ row: RoomRow; links: readonly string[] }>;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-t border-border px-4 py-2">
      <button
        type="button"
        className="text-xs font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        Latest replies since your last message ({outcomes.length})
      </button>
      <DisclosureRegion open={open}>
        <ul className="mt-1 space-y-1.5">
          {outcomes.map(({ row, links }) => (
            <li key={row.event.seq} className="text-xs">
              <span className="font-medium">{row.who}</span>
              <span className="text-muted-foreground"> · seq {row.event.seq}</span>
              <p className="line-clamp-3 whitespace-pre-wrap break-words text-muted-foreground">
                {row.text}
              </p>
              {links.length > 0 ? (
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {links.map((link) => (
                    <a
                      key={link}
                      href={link}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all text-[11px] underline underline-offset-2"
                    >
                      {link}
                    </a>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </DisclosureRegion>
    </div>
  );
}
