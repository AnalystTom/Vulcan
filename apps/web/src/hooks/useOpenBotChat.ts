// FILE: useOpenBotChat.ts
// Purpose: Navigate to a bot the OpenBot way — active task chat, creating New task if needed.
// Layer: Web hook
// Exports: useOpenBotChat

import type { Bot } from "@vulcan/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";

import { useBots } from "~/hooks/useBots";
import { writeLastBotId } from "~/lib/lastBotId";
import { openBotChat } from "~/lib/openBotChat";

export function useOpenBotChat() {
  const navigate = useNavigate();
  const bots = useBots();
  const botsRef = useRef(bots);
  botsRef.current = bots;

  return async (bot: Bot) => {
    const roster = botsRef.current;
    writeLastBotId(bot.id);
    await openBotChat({
      bot,
      tasks: roster.data.tasks,
      createTask: (input) => roster.createTaskMutation.mutateAsync(input),
      setActiveTask: (task) => roster.setActiveTaskMutation.mutateAsync(task),
      navigateToThread: (threadId) =>
        navigate({
          to: "/$threadId",
          params: { threadId },
        }),
    });
  };
}
