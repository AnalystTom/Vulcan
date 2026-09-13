// FILE: HermesBotsView.tsx
// Purpose: The native Hermes Bot-mode surface inside Vulcan's Bots area — gateway connection,
//          the live profile roster, hosted group rooms, and a bot's page (canonical chat, profile
//          settings, routines). Everything shown comes from the gateway; the legacy Vulcan bots
//          keep their own view and are never mixed into this roster.
// Layer: Web UI (bots)
// Exports: HermesBotsView, HermesBotsSelection, HermesBotsViewKind

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import {
  useHermesConnect,
  useHermesEventInvalidation,
  useHermesModelCatalog,
  useHermesProfileDetail,
  useHermesProfileMutations,
  useHermesProfiles,
  useHermesRoomMutations,
  useHermesRooms,
  useHermesRoutineMutations,
  useHermesRoutines,
  useHermesStatus,
  type HermesBotsStatus,
  type HermesModelProvider,
  type HermesProfile,
  type HermesProfileDetail,
  type HermesRoom,
  type HermesRoutine,
} from "~/hooks/useHermesBots";
import { BotIcon, PlusIcon, UsersIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { HermesBotChat, HermesGroupRoom } from "./HermesBotConversation";
import { HermesConnectionsPanel } from "./HermesConnectionsPanel";
import {
  ErrorNotice,
  EvidenceDisclosure,
  HermesAvatar,
  SectionHeading,
  StatusPill,
  absoluteIso,
  hermesProfileHasRecentActivity,
  hermesProfileLabel,
  relativeIso,
} from "./HermesBotParts";

export type HermesBotsViewKind = "chat" | "profile" | "routines";

export interface HermesBotsSelection {
  readonly profile: string | null;
  readonly room: string | null;
  readonly view: HermesBotsViewKind;
}

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

// ── Connection ─────────────────────────────────────────────────────────────────

function connectionTone(status: HermesBotsStatus | undefined): "success" | "error" | "outline" {
  if (!status) return "outline";
  if (status.connected) return "success";
  return status.configured ? "error" : "outline";
}

function connectionLabel(status: HermesBotsStatus | undefined) {
  if (!status) return "Checking…";
  if (status.connected) return "Connected";
  return status.configured ? "Disconnected" : "Not connected";
}

function ConnectForm({
  status,
  compact,
}: {
  status: HermesBotsStatus | undefined;
  compact: boolean;
}) {
  const connect = useHermesConnect();
  const [url, setUrl] = useState(status?.endpoint ?? "");
  const [token, setToken] = useState("");
  useEffect(() => {
    if (status?.endpoint && !url) setUrl(status.endpoint);
  }, [status?.endpoint, url]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || connect.isPending) return;
    void connect
      .mutateAsync({ url: trimmed, ...(token ? { token } : {}) })
      .then(() => setToken(""))
      .catch(() => undefined);
  };
  return (
    <form className={cn("space-y-3", compact ? "" : "max-w-xl")} onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs font-medium">
          Gateway URL
          <Input
            placeholder="ws://127.0.0.1:41493/api/ws"
            value={url}
            autoComplete="off"
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <label className="space-y-1 text-xs font-medium">
          Password
          <Input
            type="password"
            placeholder={
              status?.configured ? "Leave blank to keep the saved one" : "Gateway auth token"
            }
            value={token}
            autoComplete="new-password"
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Connect to a loopback Hermes gateway directly or through SSH. The token stays on your
          Vulcan server.
        </p>
        <Button type="submit" size="sm" disabled={connect.isPending || !url.trim()}>
          {connect.isPending ? "Connecting…" : status?.connected ? "Reconnect" : "Connect"}
        </Button>
      </div>
    </form>
  );
}

function ConnectionDetails({ status }: { status: HermesBotsStatus | undefined }) {
  const [open, setOpen] = useState(false);
  const caps = status?.capabilities ?? null;
  return (
    <div>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <DisclosureChevron open={open} className="size-3" />
        Connection
      </button>
      <DisclosureRegion open={open}>
        <div className="mt-2 space-y-3 rounded-xl border border-border p-3">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px]">
            <dt className="text-muted-foreground">Endpoint</dt>
            <dd className="break-all font-mono">{status?.endpoint ?? "—"}</dd>
            <dt className="text-muted-foreground">Protocol</dt>
            <dd>{caps ? `v${caps.protocol_version}` : "unknown"}</dd>
            <dt className="text-muted-foreground">Group driver</dt>
            <dd>{caps ? (caps.driver ? "running" : "not running") : "unknown"}</dd>
            <dt className="text-muted-foreground">Persistent process</dt>
            <dd>{caps ? (caps.persistent_process ? "yes" : "no") : "unknown"}</dd>
            <dt className="text-muted-foreground">Methods</dt>
            <dd>{caps ? `${caps.methods.length} advertised` : "unknown"}</dd>
          </dl>
          {status?.message ? (
            <p className="text-xs text-muted-foreground">{status.message}</p>
          ) : null}
          <ConnectForm status={status} compact />
        </div>
      </DisclosureRegion>
    </div>
  );
}

// ── Roster ─────────────────────────────────────────────────────────────────────

function ProfileRow({
  profile,
  active,
  onClick,
}: {
  profile: HermesProfile;
  active: boolean;
  onClick: () => void;
}) {
  const recentActivity = hermesProfileHasRecentActivity(profile);
  const lastIso = profile.canonical?.lastActiveIso ?? profile.lastSession?.lastActiveIso ?? null;
  const preview = profile.canonical?.preview ?? profile.lastSession?.preview ?? "";
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-muted/50",
        active && "bg-muted/70",
      )}
      onClick={onClick}
    >
      <HermesAvatar profile={profile} className="size-9 text-xs" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{hermesProfileLabel(profile)}</span>
          {recentActivity ? <StatusPill tone="info">Recent activity</StatusPill> : null}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {preview || `@${profile.name}${profile.model ? ` · ${profile.model}` : ""}`}
        </span>
      </span>
      {lastIso ? (
        <span
          className="shrink-0 text-[10px] text-muted-foreground"
          title={absoluteIso(lastIso) ?? undefined}
        >
          {relativeIso(lastIso)}
        </span>
      ) : null}
    </button>
  );
}

function RoomRow({
  room,
  active,
  onClick,
}: {
  room: HermesRoom;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-muted/50",
        active && "bg-muted/70",
      )}
      onClick={onClick}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[42%] bg-muted text-muted-foreground">
        <UsersIcon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{room.name}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {room.members.map((member) => member.displayName ?? member.profile).join(", ") ||
            "No members"}
        </span>
      </span>
      {room.updatedAtIso ? (
        <span
          className="shrink-0 text-[10px] text-muted-foreground"
          title={absoluteIso(room.updatedAtIso) ?? undefined}
        >
          {relativeIso(room.updatedAtIso)}
        </span>
      ) : null}
    </button>
  );
}

// ── Create dialogs ─────────────────────────────────────────────────────────────

function ModelFields({
  catalog,
  provider,
  model,
  onChange,
  allowKeep,
}: {
  catalog: { data: HermesModelProvider[] | undefined; isLoading: boolean; error: Error | null };
  provider: string;
  model: string;
  onChange: (next: { provider: string; model: string }) => void;
  allowKeep: string | null;
}) {
  const providers = catalog.data ?? [];
  const current = providers.find((entry) => entry.slug === provider) ?? null;
  if (catalog.isLoading)
    return <p className="text-xs text-muted-foreground">Discovering models…</p>;
  if (catalog.error || providers.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {catalog.error
          ? `Model discovery failed: ${catalog.error.message}`
          : "This gateway reported no authenticated model providers."}{" "}
        Model changes are disabled until it does.
      </p>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-xs font-medium">
        Provider
        <select
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={provider}
          onChange={(event) => {
            const next = providers.find((entry) => entry.slug === event.target.value) ?? null;
            onChange({ provider: event.target.value, model: next?.models[0]?.id ?? "" });
          }}
        >
          {allowKeep !== null ? (
            <option value="">Keep current{allowKeep ? ` (${allowKeep})` : ""}</option>
          ) : null}
          {providers.map((entry) => (
            <option key={entry.slug} value={entry.slug}>
              {entry.name}
              {entry.isCurrent ? " · gateway default" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1 text-xs font-medium">
        Model
        <select
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={model}
          disabled={!current}
          onChange={(event) => onChange({ provider, model: event.target.value })}
        >
          {!current ? <option value="">—</option> : null}
          {current?.models.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function CreateBotDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const mutations = useHermesProfileMutations();
  const catalog = useHermesModelCatalog(open);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState({ provider: "", model: "" });
  const nameError =
    name && !PROFILE_NAME_RE.test(name)
      ? "Use lowercase letters, digits, - or _ (starting with a letter or digit)."
      : null;
  const busy = mutations.create.isPending;
  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busy ? onClose() : undefined)}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New bot</DialogTitle>
          <DialogDescription>
            Creates a Hermes profile on the gateway with its own memory, skills and chat.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="hermes-create-bot"
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || !name || nameError) return;
              void mutations.create
                .mutateAsync({
                  name,
                  title: title.trim(),
                  description: description.trim(),
                  model: model.provider && model.model ? model : null,
                })
                .then((created) => {
                  setName("");
                  setTitle("");
                  setDescription("");
                  onCreated(created);
                })
                .catch(() => undefined);
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs font-medium">
                Profile name
                <Input
                  placeholder="research"
                  value={name}
                  autoFocus
                  onChange={(event) => setName(event.target.value.trim())}
                />
                {nameError ? (
                  <span className="block font-normal text-destructive">{nameError}</span>
                ) : null}
              </label>
              <label className="space-y-1 text-xs font-medium">
                Role
                <Input
                  placeholder="Prospect researcher"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
            </div>
            <label className="block space-y-1 text-xs font-medium">
              What this bot owns
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <ModelFields
              catalog={catalog}
              provider={model.provider}
              model={model.model}
              onChange={setModel}
              allowKeep="gateway default"
            />
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="hermes-create-bot"
            disabled={busy || !name || nameError !== null}
          >
            {busy ? "Creating…" : "Create bot"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function CreateGroupDialog({
  open,
  profiles,
  onClose,
  onCreated,
}: {
  open: boolean;
  profiles: readonly HermesProfile[];
  onClose: () => void;
  onCreated: (room: HermesRoom) => void;
}) {
  const mutations = useHermesRoomMutations();
  const [name, setName] = useState("");
  const [members, setMembers] = useState<readonly string[]>([]);
  const busy = mutations.create.isPending;
  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busy ? onClose() : undefined)}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New group</DialogTitle>
          <DialogDescription>
            A hosted room on the gateway. Members talk to each other there; you can watch and steer.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="hermes-create-group"
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || !name.trim() || members.length === 0) return;
              void mutations.create
                .mutateAsync({ name: name.trim(), profiles: members })
                .then((room) => {
                  setName("");
                  setMembers([]);
                  onCreated(room);
                })
                .catch(() => undefined);
            }}
          >
            <label className="block space-y-1 text-xs font-medium">
              Group name
              <Input
                placeholder="LaunchPost marketing"
                value={name}
                autoFocus
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <fieldset className="space-y-1.5">
              <legend className="text-xs font-medium">Members</legend>
              {profiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">No bots to add yet.</p>
              ) : null}
              {profiles.map((profile) => (
                <label key={profile.name} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={members.includes(profile.name)}
                    onChange={(event) =>
                      setMembers((current) =>
                        event.target.checked
                          ? [...current, profile.name]
                          : current.filter((entry) => entry !== profile.name),
                      )
                    }
                  />
                  <span className="truncate">{hermesProfileLabel(profile)}</span>
                  <span className="truncate text-xs text-muted-foreground">@{profile.name}</span>
                </label>
              ))}
            </fieldset>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="hermes-create-group"
            disabled={busy || !name.trim() || members.length === 0}
          >
            {busy ? "Creating…" : "Create group"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ── Profile settings ───────────────────────────────────────────────────────────

const AVATAR_MAX_BYTES = 2_000_000;

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function ProfileEditorForm({
  profile,
  detail,
}: {
  profile: HermesProfile;
  detail: HermesProfileDetail;
}) {
  const mutations = useHermesProfileMutations();
  const catalog = useHermesModelCatalog(true);
  const [title, setTitle] = useState(profile.title ?? "");
  const [description, setDescription] = useState(detail.description);
  const [soul, setSoul] = useState(detail.soul);
  const [soulOpen, setSoulOpen] = useState(false);
  const [model, setModel] = useState({ provider: "", model: "" });
  const savedToolsets =
    detail.enabledToolsets ??
    detail.toolsets.filter((entry) => entry.enabled).map((entry) => entry.name);
  const toolSelectionUnavailable = detail.toolsetsPinned && detail.enabledToolsets === null;
  const [toolsets, setToolsets] = useState<readonly string[]>(savedToolsets);
  const [skillsEnabled, setSkillsEnabled] = useState<readonly string[]>(
    detail.skills.filter((entry) => entry.enabled).map((entry) => entry.name),
  );
  const [confirm, setConfirm] = useState<string | null>(null);
  const [notApplied, setNotApplied] = useState<readonly string[]>([]);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const initialToolsets = savedToolsets.join("|");
  const initialSkills = detail.skills
    .filter((entry) => entry.enabled)
    .map((entry) => entry.name)
    .join("|");
  const toolsetsEdited =
    [...toolsets].sort().join("|") !== initialToolsets.split("|").sort().join("|");
  const emptyToolsetsEdited = toolsetsEdited && toolsets.length === 0;
  const dirty =
    title.trim() !== (profile.title ?? "") ||
    description.trim() !== detail.description ||
    soul !== detail.soul ||
    (model.provider !== "" && model.model !== "") ||
    toolsetsEdited ||
    [...skillsEnabled].sort().join("|") !== initialSkills.split("|").sort().join("|");

  const save = (confirmExpensive: boolean) => {
    const input = {
      name: profile.name,
      ...(title.trim() !== (profile.title ?? "")
        ? {
            uiMeta: { title: title.trim() || null },
            uiMetaExpectedRevision: profile.uiMetaRevision,
          }
        : {}),
      ...(description.trim() !== detail.description ? { description: description.trim() } : {}),
      ...(soul !== detail.soul ? { soul } : {}),
      ...(model.provider && model.model ? { model: { ...model, confirmExpensive } } : {}),
      ...(toolsetsEdited ? { enabledToolsets: toolsets } : {}),
      ...([...skillsEnabled].sort().join("|") !== initialSkills.split("|").sort().join("|")
        ? {
            disabledSkills: detail.skills
              .map((entry) => entry.name)
              .filter((name) => !skillsEnabled.includes(name)),
          }
        : {}),
    };
    void mutations.configure
      .mutateAsync(input)
      .then((result) => {
        if (result.confirmRequired) {
          setConfirm(
            result.confirmMessage ?? "The gateway wants confirmation before pinning this model.",
          );
          return;
        }
        setConfirm(null);
        setNotApplied(
          Object.entries(result.applied)
            .filter(([, ok]) => !ok)
            .map(([key]) => key),
        );
        if (input.model) setModel({ provider: "", model: "" });
      })
      .catch(() => undefined);
  };

  const busy = mutations.configure.isPending || mutations.setAvatar.isPending;
  const currentModel =
    detail.provider || detail.model
      ? `${detail.provider}/${detail.model}`.replace(/^\/|\/$/g, "")
      : "";

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionHeading
          title="Identity"
          description="How this bot appears here and to its teammates."
        />
        <div className="flex items-center gap-4">
          <HermesAvatar profile={profile} className="size-14 text-lg" />
          <div className="space-y-1">
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  if (file.size > AVATAR_MAX_BYTES)
                    return setAvatarError("Pick an image under 2 MB.");
                  setAvatarError(null);
                  void readFileAsDataUrl(file)
                    .then((dataUrl) =>
                      mutations.setAvatar.mutateAsync({ name: profile.name, dataUrl }),
                    )
                    .catch((cause: unknown) =>
                      setAvatarError(cause instanceof Error ? cause.message : String(cause)),
                    );
                }}
              />
              <span className="rounded-md border border-border px-2 py-1 hover:bg-muted">
                Upload avatar
              </span>
            </label>
            {profile.hasAvatar ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => mutations.setAvatar.mutate({ name: profile.name, dataUrl: null })}
              >
                Remove avatar
              </Button>
            ) : null}
            {avatarError ? <p className="text-xs text-destructive">{avatarError}</p> : null}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-medium">
            Role
            <Input
              value={title}
              placeholder="e.g. SEO lead"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="space-y-1 text-xs font-medium">
            Profile
            <Input value={`@${profile.name}`} disabled />
          </label>
        </div>
        <label className="block space-y-1 text-xs font-medium">
          Description
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs font-medium"
            aria-expanded={soulOpen}
            onClick={() => setSoulOpen((current) => !current)}
          >
            <DisclosureChevron open={soulOpen} className="size-3" />
            Personality (SOUL.md)
          </button>
          <DisclosureRegion open={soulOpen}>
            <Textarea
              aria-label="Personality (SOUL.md)"
              className="mt-2 font-mono"
              value={soul}
              onChange={(event) => setSoul(event.target.value)}
            />
          </DisclosureRegion>
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeading
          title="Model"
          description={
            currentModel
              ? `Currently ${currentModel}.`
              : "No model pinned; the gateway default applies."
          }
        />
        <ModelFields
          catalog={catalog}
          provider={model.provider}
          model={model.model}
          onChange={setModel}
          allowKeep={currentModel}
        />
        {confirm ? (
          <Alert variant="warning" size="sm">
            <AlertTitle>The gateway asks you to confirm this model</AlertTitle>
            <AlertDescription>
              <span>{confirm}</span>
              <div className="flex gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || emptyToolsetsEdited}
                  onClick={() => save(true)}
                >
                  Confirm and save
                </Button>
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
                  Keep current model
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
      </section>

      <section className="space-y-3">
        <SectionHeading
          title="Toolsets"
          description={
            detail.toolsetsPinned
              ? "Pinned for this profile."
              : "Following the gateway defaults; saving a change pins them."
          }
        />
        <div className="grid gap-2 sm:grid-cols-2">
          {detail.toolsets.map((toolset) => (
            <label key={toolset.name} className="flex items-start gap-2 text-sm">
              <input
                className="mt-1"
                type="checkbox"
                checked={toolsets.includes(toolset.name)}
                disabled={busy || toolSelectionUnavailable}
                onChange={(event) =>
                  setToolsets((current) =>
                    event.target.checked
                      ? [...current, toolset.name]
                      : current.filter((entry) => entry !== toolset.name),
                  )
                }
              />
              <span>
                {toolset.label}
                <span className="block text-xs text-muted-foreground">
                  {toolset.description || toolset.name}
                  {toolset.toolCount ? ` · ${toolset.toolCount} tools` : ""}
                </span>
              </span>
            </label>
          ))}
          {detail.toolsets.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              The gateway listed no configurable toolsets.
            </p>
          ) : null}
        </div>
        {toolSelectionUnavailable ? (
          <p className="text-xs text-muted-foreground">
            Update Hermes to expose the complete saved tool selection before changing these grants.
          </p>
        ) : null}
        {emptyToolsetsEdited ? (
          <p className="text-xs text-destructive">
            Select at least one toolset before saving. An empty selection restores gateway defaults.
          </p>
        ) : null}
      </section>

      <section className="space-y-3">
        <SectionHeading
          title="Skills"
          description="Installed on this profile. Unchecked skills stay installed but disabled."
        />
        <div className="grid gap-2 sm:grid-cols-2">
          {detail.skills.map((skill) => (
            <label key={skill.name} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={skillsEnabled.includes(skill.name)}
                onChange={(event) =>
                  setSkillsEnabled((current) =>
                    event.target.checked
                      ? [...current, skill.name]
                      : current.filter((entry) => entry !== skill.name),
                  )
                }
              />
              {skill.name}
            </label>
          ))}
          {detail.skills.length === 0 ? (
            <p className="text-xs text-muted-foreground">No skills installed on this profile.</p>
          ) : null}
        </div>
        {detail.mcpServers.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            MCP servers:{" "}
            {detail.mcpServers
              .map((server) => `${server.name}${server.enabled ? "" : " (off)"}`)
              .join(", ")}
          </p>
        ) : null}
      </section>

      {notApplied.length > 0 ? (
        <Alert variant="warning" size="sm">
          <AlertTitle>The gateway did not apply: {notApplied.join(", ")}</AlertTitle>
          <AlertDescription>
            Everything else saved. Reload the profile and try that section again.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex justify-end">
        <Button disabled={busy || !dirty || emptyToolsetsEdited} onClick={() => save(false)}>
          {mutations.configure.isPending ? "Saving…" : "Save profile"}
        </Button>
      </div>
    </div>
  );
}

function ProfileEditor({ profile }: { profile: HermesProfile }) {
  const detail = useHermesProfileDetail(profile.name);
  if (detail.isLoading) return <p className="text-sm text-muted-foreground">Loading profile…</p>;
  if (detail.error || !detail.data) {
    return (
      <ErrorNotice
        title="Could not load this profile"
        message={detail.error?.message ?? "No data."}
        onRetry={() => void detail.refetch()}
      />
    );
  }
  return (
    <div className="space-y-6">
      <ProfileEditorForm
        key={`${profile.name}:${detail.dataUpdatedAt}`}
        profile={profile}
        detail={detail.data}
      />
      <HermesConnectionsPanel key={profile.name} profile={profile.name} />
    </div>
  );
}

// ── Routines ───────────────────────────────────────────────────────────────────

function routineResultLabel(status: string | null) {
  switch (status) {
    case null:
      return null;
    case "ok":
      return "Succeeded";
    case "error":
      return "Failed";
    case "delivery_failed":
      return "Ran, but delivery failed";
    case "blocked_config":
      return "Blocked by configuration (not run)";
    default:
      return status;
  }
}

function RoutineRow({
  routine,
  busy,
  onControl,
}: {
  routine: HermesRoutine;
  busy: boolean;
  onControl: (action: "pause" | "resume" | "remove") => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const result = routineResultLabel(routine.lastStatus);
  return (
    <div className="space-y-1.5 rounded-xl border border-border p-3">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            routine.active ? "bg-success" : "bg-muted-foreground/40",
          )}
          aria-hidden
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium",
            !routine.active && "text-muted-foreground",
          )}
        >
          {routine.title}
        </span>
        <Switch
          checked={routine.active}
          disabled={busy}
          onCheckedChange={(next) => onControl(next ? "resume" : "pause")}
        />
        {confirmRemove ? (
          <>
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => onControl("remove")}
            >
              Confirm delete
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmRemove(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => setConfirmRemove(true)}>
            Delete
          </Button>
        )}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 pl-3.5 text-[11px]">
        <dt className="text-muted-foreground">Schedule</dt>
        <dd className="font-mono">{routine.schedule || "—"}</dd>
        <dt className="text-muted-foreground">Next run</dt>
        <dd>
          {routine.active ? (absoluteIso(routine.nextRunAtIso) ?? "Not scheduled") : "Paused"}
        </dd>
        {routine.lastRunAtIso ? (
          <>
            <dt className="text-muted-foreground">Last run</dt>
            <dd>
              {absoluteIso(routine.lastRunAtIso)}
              {result ? ` · ${result}` : ""}
            </dd>
          </>
        ) : null}
        {routine.deliver ? (
          <>
            <dt className="text-muted-foreground">Delivers to</dt>
            <dd>{routine.deliver}</dd>
          </>
        ) : null}
      </dl>
      {routine.issue ? (
        <p className="pl-3.5 text-[11px] text-destructive">{routine.issue}</p>
      ) : null}
      {routine.promptPreview ? (
        <EvidenceDisclosure
          label="Instruction"
          className="pl-3.5"
          rows={[
            ["job_id", routine.jobId],
            ["model", routine.model],
            ["repeat", routine.repeat],
          ]}
          json={routine.promptPreview}
        />
      ) : null}
    </div>
  );
}

function RoutinesPanel({ profile }: { profile: HermesProfile }) {
  const routines = useHermesRoutines(profile.name);
  const mutations = useHermesRoutineMutations(profile.name);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [schedule, setSchedule] = useState("");
  const [instruction, setInstruction] = useState("");
  const [deliverToChat, setDeliverToChat] = useState(true);
  const scoped = routines.data?.scoped?.toLowerCase() === profile.name.toLowerCase();
  const jobs = useMemo(() => {
    const all = routines.data?.jobs ?? [];
    return scoped ? all : all.filter((job) => job.ownerTag === profile.name.toLowerCase());
  }, [routines.data, scoped, profile.name]);
  const busy = mutations.create.isPending || mutations.control.isPending;
  const canCreate = routines.data !== undefined && scoped;

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Routines"
        description="Scheduled jobs the gateway runs for this bot. The schedule and next run come from its cron store."
        action={
          <Button
            size="sm"
            variant="outline"
            disabled={!canCreate}
            onClick={() => setCreateOpen((current) => !current)}
          >
            <PlusIcon /> New routine
          </Button>
        }
      />
      {routines.data && !scoped ? (
        <Alert variant="info" size="sm">
          <AlertTitle>This gateway did not scope the cron store to @{profile.name}</AlertTitle>
          <AlertDescription>
            Only jobs tagged for this bot are listed, and new routines cannot be created from here.
          </AlertDescription>
        </Alert>
      ) : null}
      <DisclosureRegion open={createOpen && canCreate}>
        <form
          className="space-y-3 rounded-xl border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !title.trim() || !schedule.trim() || !instruction.trim()) return;
            void mutations.create
              .mutateAsync({
                title: title.trim(),
                schedule: schedule.trim(),
                instruction: instruction.trim(),
                deliverToChat,
              })
              .then(() => {
                setTitle("");
                setSchedule("");
                setInstruction("");
                setCreateOpen(false);
              })
              .catch(() => undefined);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs font-medium">
              Name
              <Input
                value={title}
                placeholder="Weekly prospect sweep"
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="space-y-1 text-xs font-medium">
              Schedule
              <Input
                value={schedule}
                placeholder="every 1d · 0 9 * * 1 · 30m"
                className="font-mono"
                onChange={(event) => setSchedule(event.target.value)}
              />
              <span className="block font-normal text-muted-foreground">
                Hermes schedule syntax: an interval, a cron line, or a one-shot delay.
              </span>
            </label>
          </div>
          <label className="block space-y-1 text-xs font-medium">
            Instruction
            <Textarea
              value={instruction}
              placeholder="What the bot should do each run"
              onChange={(event) => setInstruction(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={deliverToChat}
              onChange={(event) => setDeliverToChat(event.target.checked)}
            />
            Post each result into this bot&apos;s chat
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={busy || !title.trim() || !schedule.trim() || !instruction.trim()}
            >
              {mutations.create.isPending ? "Creating…" : "Create routine"}
            </Button>
          </div>
        </form>
      </DisclosureRegion>
      {routines.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading routines…</p>
      ) : routines.error ? (
        <ErrorNotice
          title="Could not load routines"
          message={routines.error.message}
          onRetry={() => void routines.refetch()}
        />
      ) : jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No routines for this bot yet.</p>
      ) : (
        <div className="space-y-2">
          {jobs.map((routine) => (
            <RoutineRow
              key={routine.jobId}
              routine={routine}
              busy={busy}
              onControl={(action) => mutations.control.mutate({ jobId: routine.jobId, action })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Bot page ───────────────────────────────────────────────────────────────────

const VIEW_TABS: ReadonlyArray<{ id: HermesBotsViewKind; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "profile", label: "Profile" },
  { id: "routines", label: "Routines" },
];

function BotPage({
  profile,
  view,
  onView,
}: {
  profile: HermesProfile;
  view: HermesBotsViewKind;
  onView: (view: HermesBotsViewKind) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-4 py-2" role="tablist">
        {VIEW_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              view === tab.id
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onView(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {view === "chat" ? (
        <HermesBotChat profile={profile} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <header className="mb-6 flex items-center gap-3">
            <HermesAvatar profile={profile} className="size-12 text-base" />
            <div className="min-w-0">
              <h2 className="truncate font-heading text-lg font-semibold">
                {hermesProfileLabel(profile)}
              </h2>
              <p className="truncate text-xs text-muted-foreground">
                @{profile.name}
                {profile.model ? ` · ${profile.model}` : ""}
                {profile.skillCount ? ` · ${profile.skillCount} skills` : ""}
              </p>
            </div>
          </header>
          {view === "profile" ? (
            <ProfileEditor profile={profile} />
          ) : (
            <RoutinesPanel profile={profile} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Shell ──────────────────────────────────────────────────────────────────────

/** Native profiles occupy the existing Bots sidebar; previous agents keep their own history. */
export function HermesBotsSidebar({ children }: { children: ReactNode }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const status = useHermesStatus();
  const pathname = useLocation({ select: (location) => location.pathname });
  const native =
    (pathname === "/bots" || pathname === "/bots/") &&
    (search.runtime === "hermes" ||
      (search.runtime !== "legacy" && status.data?.configured === true));
  const connected = native && status.data?.connected === true;
  const profiles = useHermesProfiles(connected);
  const rooms = useHermesRooms(connected);
  const visibleProfiles = (profiles.data?.profiles ?? []).filter((profile) => !profile.hidden);
  const selection: HermesBotsSelection = {
    profile: typeof search.profile === "string" ? search.profile : null,
    room: typeof search.room === "string" ? search.room : null,
    view: search.botView === "profile" || search.botView === "routines" ? search.botView : "chat",
  };
  const onSelect = (next: Partial<HermesBotsSelection>) => {
    const selected = { ...selection, ...next };
    void navigate({
      to: "/bots",
      search: {
        runtime: "hermes",
        ...(selected.profile ? { profile: selected.profile } : {}),
        ...(selected.room ? { room: selected.room } : {}),
        botView: selected.view,
      },
    });
  };
  if (!native) return children;
  if (!connected)
    return (
      <p className="px-4 py-4 text-xs text-muted-foreground">
        {status.data?.message ?? "Checking Hermes…"}
      </p>
    );
  return (
    <aside className="min-h-0 space-y-5 px-1.5 py-4">
      <div className="space-y-1">
        <p className="px-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Bots
        </p>
        {profiles.isLoading ? (
          <p className="px-2.5 text-xs text-muted-foreground">Loading roster…</p>
        ) : profiles.error ? (
          <ErrorNotice
            title="Roster unavailable"
            message={profiles.error.message}
            onRetry={() => void profiles.refetch()}
          />
        ) : visibleProfiles.length === 0 ? (
          <p className="px-2.5 text-xs text-muted-foreground">No profiles on this gateway yet.</p>
        ) : (
          visibleProfiles.map((profile) => (
            <ProfileRow
              key={profile.name}
              profile={profile}
              active={selection.profile === profile.name && selection.room === null}
              onClick={() =>
                onSelect({
                  profile: profile.name,
                  room: null,
                  view: selection.profile === profile.name ? selection.view : "chat",
                })
              }
            />
          ))
        )}
      </div>
      <div className="space-y-1">
        <p className="px-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Groups
        </p>
        {rooms.isLoading ? (
          <p className="px-2.5 text-xs text-muted-foreground">Loading groups…</p>
        ) : rooms.error ? (
          <ErrorNotice
            title="Groups unavailable"
            message={rooms.error.message}
            onRetry={() => void rooms.refetch()}
          />
        ) : (rooms.data ?? []).length === 0 ? (
          <p className="px-2.5 text-xs text-muted-foreground">No groups yet.</p>
        ) : (
          (rooms.data ?? []).map((room) => (
            <RoomRow
              key={room.roomId}
              room={room}
              active={selection.room === room.roomId}
              onClick={() => onSelect({ room: room.roomId, profile: null })}
            />
          ))
        )}
      </div>
    </aside>
  );
}

export function HermesBotsView({
  selection,
  onSelect,
  onShowLegacy,
  createRequested,
  onCreateRequestHandled,
}: {
  selection: HermesBotsSelection;
  onSelect: (next: Partial<HermesBotsSelection>) => void;
  onShowLegacy: () => void;
  /** The sidebar's "New agent" link lands with `?new=1`; open the create dialog once. */
  createRequested?: boolean;
  onCreateRequestHandled?: () => void;
}) {
  useHermesEventInvalidation();
  const status = useHermesStatus();
  const connected = status.data?.connected === true;
  const profiles = useHermesProfiles(connected);
  const rooms = useHermesRooms(connected);
  const [createBotOpen, setCreateBotOpen] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);

  useEffect(() => {
    if (!createRequested || !connected) return;
    setCreateBotOpen(true);
    onCreateRequestHandled?.();
  }, [createRequested, connected, onCreateRequestHandled]);

  const visibleProfiles = useMemo(
    () => (profiles.data?.profiles ?? []).filter((profile) => !profile.hidden),
    [profiles.data],
  );
  const selectedProfile = selection.profile
    ? (visibleProfiles.find((profile) => profile.name === selection.profile) ?? null)
    : null;
  const selectedRoom = selection.room
    ? ((rooms.data ?? []).find((room) => room.roomId === selection.room) ?? null)
    : null;

  return (
    <main className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2 text-muted-foreground">
            <BotIcon className="size-5" />
            <span className="text-xs font-medium uppercase tracking-wider">Hermes team</span>
            <StatusPill tone={connectionTone(status.data)}>
              {connectionLabel(status.data)}
            </StatusPill>
          </div>
          <h1 className="font-display text-2xl font-semibold">Bots</h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            One runtime on the gateway. Each bot keeps its own chat, memory and routines; groups are
            where they work together.
          </p>
          <div className="mt-2">
            <ConnectionDetails status={status.data} />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onShowLegacy}>
            Legacy agents
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!connected}
            onClick={() => setCreateGroupOpen(true)}
          >
            <UsersIcon /> New group
          </Button>
          <Button size="sm" disabled={!connected} onClick={() => setCreateBotOpen(true)}>
            <PlusIcon /> New bot
          </Button>
        </div>
      </div>

      {status.error ? (
        <div className="px-6 py-4">
          <ErrorNotice
            title="Could not reach the Vulcan bridge"
            message={status.error.message}
            onRetry={() => void status.refetch()}
          />
        </div>
      ) : !connected ? (
        <div className="space-y-4 px-6 py-6">
          {status.isLoading ? (
            <p className="text-sm text-muted-foreground">Checking the gateway connection…</p>
          ) : (
            <>
              {status.data?.message ? (
                <Alert variant={status.data.configured ? "error" : "info"} size="sm">
                  <AlertTitle>
                    {status.data.configured
                      ? "The saved gateway is not reachable"
                      : "Connect a Hermes gateway"}
                  </AlertTitle>
                  <AlertDescription>{status.data.message}</AlertDescription>
                </Alert>
              ) : null}
              <ConnectForm status={status.data} compact={false} />
            </>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-col">
            {selectedRoom ? (
              <HermesGroupRoom
                key={selectedRoom.roomId}
                roomId={selectedRoom.roomId}
                profiles={visibleProfiles}
              />
            ) : selectedProfile ? (
              <BotPage
                key={selectedProfile.name}
                profile={selectedProfile}
                view={selection.view}
                onView={(view) => onSelect({ view })}
              />
            ) : selection.profile || selection.room ? (
              <div className="p-6 text-sm text-muted-foreground">
                {profiles.isLoading || rooms.isLoading
                  ? "Loading…"
                  : "That bot or group is not on this gateway."}
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                <BotIcon className="size-8 text-muted-foreground" />
                <p className="font-heading text-base font-semibold">Pick a bot or a group</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Chat with one bot, or open a group to watch the team hand work to each other.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      <CreateBotDialog
        open={createBotOpen}
        onClose={() => setCreateBotOpen(false)}
        onCreated={(name) => {
          setCreateBotOpen(false);
          onSelect({ profile: name, room: null, view: "chat" });
        }}
      />
      <CreateGroupDialog
        open={createGroupOpen}
        profiles={visibleProfiles}
        onClose={() => setCreateGroupOpen(false)}
        onCreated={(room) => {
          setCreateGroupOpen(false);
          onSelect({ room: room.roomId, profile: null });
        }}
      />
    </main>
  );
}
