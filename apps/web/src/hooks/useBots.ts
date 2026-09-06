import type {
  Bot,
  BotControlInput,
  BotCreateInput,
  BotEvent,
  BotListResult,
  BotMemorySetInput,
  BotPeerApprovalRespondInput,
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
const EMPTY_BOTS: BotListResult = {
  bots: [],
  tasks: [],
  runtimeStates: [],
  channels: [],
  delegations: [],
  peerApprovals: [],
};

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
        channels: [...(event.channels ?? [])],
        delegations: [...(event.delegations ?? [])],
        peerApprovals: [...(event.peerApprovals ?? [])],
      };
    case "bot.upserted":
      return { ...current, bots: upsertById(current.bots, event.bot) };
    case "bot.deleted":
      return {
        ...current,
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
    case "comms.channel.upserted":
      return { ...current, channels: upsertById(current.channels ?? [], event.channel) };
    case "comms.message.appended":
      // Message bodies are fetched per channel; the channel upsert that follows carries
      // the preview and unread state.
      return current;
    case "delegation.upserted":
      return { ...current, delegations: upsertById(current.delegations ?? [], event.delegation) };
    case "peerApproval.requested":
      return { ...current, peerApprovals: upsertById(current.peerApprovals ?? [], event.request) };
    case "peerApproval.resolved":
      return {
        ...current,
        peerApprovals: (current.peerApprovals ?? []).filter(
          (request) => request.id !== event.requestId,
        ),
      };
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
  const respondPeerApprovalMutation = useMutation({
    mutationFn: (input: BotPeerApprovalRespondInput) =>
      ensureNativeApi().bots.respondPeerApproval(input),
    onSuccess: (result, input) => {
      // The server drops the card from its stream; mirror that locally even when the card
      // had already expired so a stale button never lingers.
      queryClient.setQueryData<BotListResult>(botsQueryKey, (current) =>
        current
          ? {
              ...current,
              peerApprovals: (current.peerApprovals ?? []).filter(
                (request) => request.id !== input.requestId,
              ),
            }
          : current,
      );
      if (!result.resolved) {
        toastManager.add({ type: "info", title: "That request had already been settled." });
      }
    },
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
    respondPeerApprovalMutation,
  };
}
