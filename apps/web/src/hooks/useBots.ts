import type {
  Bot,
  BotControlInput,
  BotCreateInput,
  BotEvent,
  BotListResult,
  BotMemorySetInput,
  BotTask,
  BotTaskCreateInput,
  BotTaskRunInput,
  BotUpdateInput,
} from "@vulcan/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { ensureNativeApi } from "../nativeApi";
import { toastManager } from "../components/ui/toast";

export const botsQueryKey = ["bots"] as const;
const EMPTY_BOTS: BotListResult = { bots: [], tasks: [], runtimeStates: [] };

function upsertById<T extends { readonly id: string }>(items: readonly T[], item: T): T[] {
  const existing = items.findIndex((candidate) => candidate.id === item.id);
  if (existing < 0) return [...items, item];
  return items.map((candidate, index) => (index === existing ? item : candidate));
}

export function reduceBotEvent(current: BotListResult, event: BotEvent): BotListResult {
  switch (event.type) {
    case "snapshot":
      return {
        bots: [...event.bots],
        tasks: [...event.tasks],
        runtimeStates: [...(event.runtimeStates ?? [])],
      };
    case "bot.upserted":
      return { ...current, bots: upsertById(current.bots, event.bot) };
    case "bot.deleted":
      return {
        bots: current.bots.filter((bot) => bot.id !== event.botId),
        tasks: current.tasks.filter((task) => task.botId !== event.botId),
        runtimeStates: (current.runtimeStates ?? []).filter((state) => state.botId !== event.botId),
      };
    case "task.upserted":
      return { ...current, tasks: upsertById(current.tasks, event.task) };
    case "task.deleted":
      return { ...current, tasks: current.tasks.filter((task) => task.id !== event.taskId) };
    case "runtime.updated": {
      const runtimeStates = current.runtimeStates ?? [];
      const existing = runtimeStates.findIndex((state) => state.botId === event.state.botId);
      return {
        ...current,
        runtimeStates:
          existing < 0
            ? [...runtimeStates, event.state]
            : runtimeStates.map((state, index) => (index === existing ? event.state : state)),
      };
    }
    case "audit.appended":
      return current;
  }
}

export function useBots() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: botsQueryKey,
    queryFn: () => ensureNativeApi().bots.list({}),
  });

  useEffect(
    () =>
      ensureNativeApi().bots.onEvent((event) => {
        queryClient.setQueryData<BotListResult>(botsQueryKey, (current) =>
          reduceBotEvent(current ?? EMPTY_BOTS, event),
        );
      }),
    [queryClient],
  );

  const mutationOptions = {
    onError: (error: Error) => toastManager.add({ type: "error" as const, title: error.message }),
  };
  const createMutation = useMutation({
    mutationFn: (input: BotCreateInput) => ensureNativeApi().bots.create(input),
    ...mutationOptions,
  });
  const updateMutation = useMutation({
    mutationFn: (input: BotUpdateInput) => ensureNativeApi().bots.update(input),
    ...mutationOptions,
  });
  const deleteMutation = useMutation({
    mutationFn: (bot: Bot) => ensureNativeApi().bots.delete({ id: bot.id }),
    ...mutationOptions,
  });
  const createTaskMutation = useMutation({
    mutationFn: (input: BotTaskCreateInput) => ensureNativeApi().bots.createTask(input),
    ...mutationOptions,
  });
  const runTaskMutation = useMutation({
    mutationFn: (input: BotTaskRunInput) => ensureNativeApi().bots.runTask(input),
    ...mutationOptions,
  });
  const setActiveTaskMutation = useMutation({
    mutationFn: (task: BotTask) =>
      ensureNativeApi().bots.setActiveTask({ botId: task.botId, taskId: task.id }),
    ...mutationOptions,
  });
  const archiveTaskMutation = useMutation({
    mutationFn: (task: BotTask) => ensureNativeApi().bots.archiveTask({ taskId: task.id }),
    ...mutationOptions,
  });
  const saveMemoryMutation = useMutation({
    mutationFn: (input: BotMemorySetInput) => ensureNativeApi().bots.setMemory(input),
    ...mutationOptions,
  });
  const controlMutation = useMutation({
    mutationFn: (input: BotControlInput) => ensureNativeApi().bots.control(input),
    ...mutationOptions,
  });

  return {
    data: query.data ?? EMPTY_BOTS,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    createMutation,
    updateMutation,
    deleteMutation,
    createTaskMutation,
    runTaskMutation,
    setActiveTaskMutation,
    archiveTaskMutation,
    saveMemoryMutation,
    controlMutation,
  };
}
