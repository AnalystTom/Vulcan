import type { Bot, BotListResult, BotRuntimeState } from "@vulcan/contracts";

import { buildBotWorkGraph } from "~/lib/botWorkGraph";
import { cn } from "~/lib/utils";

import { BotAvatar } from "./BotAvatar";

const GRAPH_WIDTH = 1000;
const GRAPH_HEIGHT = 430;

const STATE_STYLE: Record<BotRuntimeState["phase"], string> = {
  idle: "bg-muted-foreground/50",
  running: "bg-emerald-500",
  "waiting-for-approval": "bg-amber-500",
  "takeover-requested": "bg-amber-500",
  "human-control": "bg-blue-500",
  paused: "bg-muted-foreground/50",
  error: "bg-destructive",
};

type Position = { readonly x: number; readonly y: number };

function circlePosition(index: number, count: number, center: Position, radius: number): Position {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(count, 1);
  return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
}

export function BotWorkGraph({
  data,
  onOpenBot,
}: {
  data: BotListResult;
  onOpenBot: (bot: Bot) => void;
}) {
  const graph = buildBotWorkGraph(data);
  const botNodes = graph.nodes.filter((node) => node.kind === "bot");
  const taskNodes = graph.nodes.filter((node) => node.kind === "task");
  const botById = new Map(data.bots.map((bot) => [bot.id, bot]));
  const stateByBotId = new Map((data.runtimeStates ?? []).map((state) => [state.botId, state]));
  const positions = new Map<string, Position>();

  botNodes.forEach((node, index) =>
    positions.set(node.id, circlePosition(index, botNodes.length, { x: 500, y: 215 }, 116)),
  );
  taskNodes.forEach((node, index) =>
    positions.set(node.id, circlePosition(index, taskNodes.length, { x: 500, y: 215 }, 188)),
  );

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="font-heading text-base font-semibold">Agent work graph</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Live task ownership across your standing team. Click an agent to chat.
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <i className="size-2 rounded-full bg-foreground" /> Agent
          </span>
          <span className="flex items-center gap-1.5">
            <i className="size-2 rounded-sm border border-muted-foreground" /> Task thread
          </span>
        </div>
      </div>

      {taskNodes.length === 0 ? (
        <div className="px-5 py-12 text-center text-sm text-muted-foreground">
          No task links yet. Create a task for an agent to map its work here.
        </div>
      ) : (
        <div className="relative min-h-[430px] overflow-x-auto bg-[radial-gradient(circle_at_center,hsl(var(--muted))_0,transparent_64%)]">
          <svg
            aria-hidden="true"
            className="absolute inset-0 h-full min-w-[680px] w-full"
            viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id="bot-work-link" x1="0" x2="1">
                <stop offset="0" stopColor="hsl(var(--foreground))" stopOpacity="0.32" />
                <stop offset="1" stopColor="hsl(var(--muted-foreground))" stopOpacity="0.18" />
              </linearGradient>
            </defs>
            {graph.edges.map((edge) => {
              const from = positions.get(edge.from);
              const to = positions.get(edge.to);
              if (!from || !to) return null;
              return (
                <line
                  key={edge.id}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke="url(#bot-work-link)"
                  strokeWidth="2"
                />
              );
            })}
          </svg>

          <div className="relative h-[430px] min-w-[680px]">
            {botNodes.map((node) => {
              const bot = botById.get(node.botId);
              const position = positions.get(node.id);
              if (!bot || !position) return null;
              const phase = stateByBotId.get(bot.id)?.phase ?? "idle";
              return (
                <BotNode
                  key={node.id}
                  bot={bot}
                  phase={phase}
                  position={position}
                  onOpen={() => onOpenBot(bot)}
                />
              );
            })}
            {taskNodes.map((node) => {
              const position = positions.get(node.id);
              if (!position) return null;
              return <TaskNode key={node.id} label={node.label} position={position} />;
            })}
          </div>
        </div>
      )}

      {graph.omittedTaskCount > 0 ? (
        <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
          Showing the 24 most recently updated tasks; {graph.omittedTaskCount} older task
          {graph.omittedTaskCount === 1 ? "" : "s"} omitted.
        </p>
      ) : null}
    </section>
  );
}

function BotNode({
  bot,
  phase,
  position,
  onOpen,
}: {
  bot: Bot;
  phase: BotRuntimeState["phase"];
  position: Position;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="absolute z-10 flex w-28 -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-xl px-2 py-2 text-center transition-colors hover:bg-background/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{
        left: `${(position.x / GRAPH_WIDTH) * 100}%`,
        top: `${(position.y / GRAPH_HEIGHT) * 100}%`,
      }}
    >
      <span className="relative">
        <BotAvatar
          avatar={bot.avatar}
          name={bot.name}
          className="size-11 border border-background shadow-sm"
        />
        <i
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-card",
            STATE_STYLE[phase],
          )}
        />
      </span>
      <span className="mt-1 w-full truncate text-xs font-semibold">{bot.name}</span>
    </button>
  );
}

function TaskNode({ label, position }: { label: string; position: Position }) {
  return (
    <div
      className="absolute z-10 w-32 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background/90 px-3 py-2 text-center text-[11px] font-medium shadow-sm backdrop-blur"
      style={{
        left: `${(position.x / GRAPH_WIDTH) * 100}%`,
        top: `${(position.y / GRAPH_HEIGHT) * 100}%`,
      }}
      title={label}
    >
      <span className="block truncate">{label}</span>
    </div>
  );
}
