import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { newCommandId, newMessageId } from "~/lib/utils";
import { BotAvatar } from "~/components/bots/BotAvatar";
import { BotWorkGraph } from "~/components/bots/BotWorkGraph";
import {
  HermesBotsView,
  type HermesBotsSelection,
  type HermesBotsViewKind,
} from "~/components/bots/HermesBotsView";
import { NewBotChat } from "~/components/bots/NewBotChat";
import { DEFAULT_BOT_AVATAR, type Bot, type BotTask } from "@vulcan/contracts";
import { Button } from "~/components/ui/button";
import { useBots } from "~/hooks/useBots";
import { useHermesBotsApi, useHermesStatus } from "~/hooks/useHermesBots";
import { useOpenBotChat } from "~/hooks/useOpenBotChat";
import { BotIcon, PlusIcon } from "~/lib/icons";

type BotsRuntime = "hermes" | "legacy";

/** The same search without the one-shot `new` flag (exact optional types forbid `new: undefined`). */
function withoutNewFlag(search: BotsIndexSearch): BotsIndexSearch {
  return Object.fromEntries(
    Object.entries(search).filter(([key]) => key !== "new"),
  ) as BotsIndexSearch;
}

/**
 * The legacy Vulcan-managed bots. Untouched until the migration gate: it never lists native
 * Hermes profiles, and the native view never lists these.
 */
function LegacyBotsIndex({
  search,
  hermesAvailable,
  onShowHermes,
}: {
  search: BotsIndexSearch;
  hermesAvailable: boolean;
  onShowHermes: () => void;
}) {
  const bots = useBots();
  const navigate = useNavigate();
  const openBotChat = useOpenBotChat();
  const firstTurnIds = useRef({ commandId: newCommandId(), messageId: newMessageId() });
  const [draftBot, setDraftBot] = useState<Bot | null>(null);
  const [draftTask, setDraftTask] = useState<BotTask | null>(null);
  const [createOpen, setCreateOpen] = useState(search.new === true);

  // The sidebar's "New agent" action lands here with `?new=1`; consume it so the dialog opens
  // once and a refresh or back navigation does not reopen it.
  useEffect(() => {
    if (search.new !== true) return;
    setCreateOpen(true);
    void navigate({ to: "/bots", search: withoutNewFlag(search), replace: true });
  }, [navigate, search]);

  if (createOpen)
    return (
      <NewBotChat
        pending={bots.createMutation.isPending}
        onCancel={() => setCreateOpen(false)}
        onCreate={async (input) => {
          const bot =
            draftBot ??
            (
              await bots.createMutation.mutateAsync({
                name: "New agent",
                title: "",
                description: "",
                avatar: DEFAULT_BOT_AVATAR,
                modelSelection: { provider: input.provider, model: input.model },
                autonomy: { enabled: true, maxActiveRuns: 1 },
                runtimeMode: "approval-required",
                capabilityGrants: [
                  "thread.read",
                  "thread.write",
                  "filesystem.read",
                  "filesystem.write",
                  "shell.execute",
                  "network.external",
                  "browser.read",
                  "browser.control",
                  "automation.write",
                ],
              })
            ).bot;
          setDraftBot(bot);
          const task =
            draftTask ??
            (await bots.createTaskMutation.mutateAsync({ botId: bot.id, title: "Getting started" }))
              .task;
          setDraftTask(task);
          await ensureNativeApi().orchestration.dispatchCommand({
            type: "thread.turn.start",
            commandId: firstTurnIds.current.commandId,
            threadId: task.threadId,
            message: {
              messageId: firstTurnIds.current.messageId,
              role: "user",
              text: input.message,
              attachments: [],
            },
            modelSelection: bot.modelSelection,
            runtimeMode: bot.runtimeMode,
            interactionMode: bot.interactionMode,
            dispatchMode: "queue",
            createdAt: new Date().toISOString(),
          });
          firstTurnIds.current = { commandId: newCommandId(), messageId: newMessageId() };
          setCreateOpen(false);
          setDraftBot(null);
          setDraftTask(null);
          await navigate({ to: "/$threadId", params: { threadId: task.threadId } });
        }}
      />
    );

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-muted-foreground">
              <BotIcon className="size-5" />
              <span className="text-xs font-medium uppercase tracking-wider">Standing team</span>
            </div>
            <h1 className="font-display text-3xl font-semibold">Bots</h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Pick an agent and chat — tasks are fresh contexts, not a separate instruct flow.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {hermesAvailable ? (
              <Button variant="outline" onClick={onShowHermes}>
                Hermes team
              </Button>
            ) : null}
            <Button onClick={() => setCreateOpen(true)}>
              <PlusIcon /> New agent
            </Button>
          </div>
        </div>

        {bots.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading agents…</p>
        ) : bots.error ? (
          <div className="rounded-xl border border-destructive/30 p-4 text-sm text-destructive">
            Could not load agents: {bots.error.message}
          </div>
        ) : bots.data.bots.length === 0 ? (
          <button
            type="button"
            className="flex w-full flex-col items-center rounded-2xl border border-dashed border-border px-6 py-16 text-center hover:bg-muted/30"
            onClick={() => setCreateOpen(true)}
          >
            <BotIcon className="mb-4 size-8 text-muted-foreground" />
            <span className="font-heading text-base font-semibold">Create your first agent</span>
            <span className="mt-1 text-sm text-muted-foreground">
              Start a conversation and describe what it should own.
            </span>
          </button>
        ) : (
          <div className="space-y-7">
            <BotWorkGraph
              data={bots.data}
              onOpenBot={(bot) => {
                void openBotChat(bot);
              }}
            />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {bots.data.bots.map((bot) => {
                const taskCount = bots.data.tasks.filter(
                  (task) => task.botId === bot.id && task.archivedAt === null,
                ).length;
                return (
                  <button
                    key={bot.id}
                    type="button"
                    className="group rounded-2xl border border-border p-4 text-left transition-colors hover:bg-muted/40"
                    onClick={() => void openBotChat(bot)}
                  >
                    <BotAvatar avatar={bot.avatar} name={bot.name} />
                    <h2 className="mt-4 truncate font-heading text-base font-semibold">
                      {bot.name}
                    </h2>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {bot.title || "No role set"}
                    </p>
                    <p className="mt-4 text-xs text-muted-foreground">
                      {taskCount} {taskCount === 1 ? "task" : "tasks"}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function BotsIndexRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const hermesApi = useHermesBotsApi();
  const status = useHermesStatus();

  // Without a bridge the legacy view is the only view. With one, an explicit `runtime` wins;
  // otherwise a configured gateway opens the native team and an unconfigured one stays legacy.
  const runtime: BotsRuntime | null = !hermesApi
    ? "legacy"
    : (search.runtime ??
      (status.data
        ? status.data.configured
          ? "hermes"
          : "legacy"
        : status.error
          ? "legacy"
          : null));

  const setSearch = useCallback(
    (next: BotsIndexSearch, replace = false) => navigate({ to: "/bots", search: next, replace }),
    [navigate],
  );
  const selection: HermesBotsSelection = {
    profile: search.profile ?? null,
    room: search.room ?? null,
    view: search.botView ?? "chat",
  };
  const selectNative = useCallback(
    (next: Partial<HermesBotsSelection>) => {
      const merged: HermesBotsSelection = {
        profile: search.profile ?? null,
        room: search.room ?? null,
        view: search.botView ?? "chat",
        ...next,
      };
      void setSearch({
        runtime: "hermes",
        ...(merged.profile ? { profile: merged.profile } : {}),
        ...(merged.room ? { room: merged.room } : {}),
        ...(merged.view !== "chat" ? { botView: merged.view } : {}),
      });
    },
    [search, setSearch],
  );
  const consumeCreateRequest = useCallback(
    () => void setSearch(withoutNewFlag(search), true),
    [search, setSearch],
  );

  if (runtime === null) {
    return <main className="p-8 text-sm text-muted-foreground">Checking the Hermes gateway…</main>;
  }
  if (runtime === "hermes") {
    return (
      <HermesBotsView
        selection={selection}
        onSelect={selectNative}
        onShowLegacy={() => void setSearch({ runtime: "legacy" })}
        createRequested={search.new === true}
        onCreateRequestHandled={consumeCreateRequest}
      />
    );
  }
  return (
    <LegacyBotsIndex
      search={search}
      hermesAvailable={hermesApi !== null}
      onShowHermes={() => void setSearch({ runtime: "hermes" })}
    />
  );
}

export interface BotsIndexSearch {
  readonly new?: true;
  readonly runtime?: BotsRuntime;
  readonly profile?: string;
  readonly room?: string;
  readonly botView?: HermesBotsViewKind;
}

export const Route = createFileRoute("/_chat/bots/")({
  validateSearch: (raw: Record<string, unknown>): BotsIndexSearch => ({
    ...(raw.new === true || raw.new === "1" || raw.new === 1 ? { new: true } : {}),
    ...(raw.runtime === "hermes" || raw.runtime === "legacy" ? { runtime: raw.runtime } : {}),
    ...(typeof raw.profile === "string" && raw.profile ? { profile: raw.profile } : {}),
    ...(typeof raw.room === "string" && raw.room ? { room: raw.room } : {}),
    ...(raw.botView === "chat" || raw.botView === "profile" || raw.botView === "routines"
      ? { botView: raw.botView }
      : {}),
  }),
  component: BotsIndexRoute,
});
