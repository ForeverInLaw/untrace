import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type TelegramAuthCodeRequest,
  type TelegramAuthPasswordRequest,
  type TelegramAuthStartRequest,
  type TelegramChatSummary,
  type TelegramDryRunRequest,
} from "../lib/tauri";

const AUTH_KEY = ["telegram", "auth"] as const;
const SCOPE_STATUS_KEY = ["telegram", "scope-status"] as const;
const OWN_COUNT_KEY = ["telegram", "own-message-count"] as const;

/// Sign-in state alone; it answers at once, without waiting for the chat list.
export function useTelegramAuthStatusQuery() {
  return useQuery({ queryKey: AUTH_KEY, queryFn: api.telegramAuthStatus });
}

/// Sign-in state together with every chat of the account.
export function useTelegramScopeStatusQuery(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: SCOPE_STATUS_KEY,
    queryFn: api.telegramScopeStatus,
    // Listing loads every chat, too slow to repeat on each window focus.
    refetchOnWindowFocus: false,
  });
}

/// Signing in or out changes the Telegram status, its chats and the list of accounts.
export function useSessionRefresh() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [AUTH_KEY, SCOPE_STATUS_KEY, ["accounts"]].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
}

export function useTelegramAuthStartMutation() {
  const onSuccess = useSessionRefresh();
  return useMutation({
    mutationKey: ["telegram", "auth-start"],
    mutationFn: (req: TelegramAuthStartRequest) => api.telegramAuthStart(req),
    onSuccess,
  });
}

export function useTelegramAuthCodeMutation() {
  const onSuccess = useSessionRefresh();
  return useMutation({
    mutationKey: ["telegram", "auth-code"],
    mutationFn: (req: TelegramAuthCodeRequest) => api.telegramAuthCode(req),
    onSuccess,
  });
}

export function useTelegramAuthPasswordMutation() {
  const onSuccess = useSessionRefresh();
  return useMutation({
    mutationKey: ["telegram", "auth-password"],
    mutationFn: (req: TelegramAuthPasswordRequest) => api.telegramAuthPassword(req),
    onSuccess,
  });
}

/// Own-message count per chat id; null when it could not be determined.
export type OwnMessageCounts = Record<string, number | null>;

let countQueue: Promise<unknown> = Promise.resolve();

/// Telegram answers a burst of searches with FLOOD_WAIT, so counts go one at a time.
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = countQueue.then(task);
  countQueue = run.catch(() => undefined);
  return run;
}

/// Counts the account's own messages chat by chat, in list order, and keeps each
/// count until that chat gets a new message. The scan goes on if the step is left,
/// and a chat being recounted shows its last count meanwhile. TDLib can't search
/// secret chats, so those stay unknown.
export function useTelegramOwnMessageCounts(account: string, chats: TelegramChatSummary[]) {
  const queryClient = useQueryClient();
  const lastCount = (chatId: string) =>
    queryClient
      .getQueriesData<number | null>({ queryKey: [...OWN_COUNT_KEY, account, chatId] })
      .find(([, count]) => count !== undefined)?.[1];

  return useQueries({
    queries: chats.map((chat) => ({
      queryKey: [...OWN_COUNT_KEY, account, chat.id, chat.last_message_id],
      queryFn: () => oneAtATime(() => api.telegramOwnMessageCount(chat.id).catch(() => null)),
      enabled: chat.kind !== "secret",
      placeholderData: () => lastCount(chat.id),
      staleTime: Infinity,
      gcTime: Infinity,
    })),
    combine: (results) => {
      const counts: OwnMessageCounts = {};
      chats.forEach((chat, index) => {
        const count = chat.kind === "secret" ? null : results[index].data;
        if (count !== undefined) counts[chat.id] = count;
      });
      return { counts, checking: results.filter((result) => result.isFetching).length };
    },
  });
}

/// Recounts every chat of the account, changed or not.
export function useRecountOwnMessages(account: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [...OWN_COUNT_KEY, account] });
}

export function useTelegramDryRunChatsMutation() {
  return useMutation({
    mutationKey: ["telegram", "dry-run-chats"],
    mutationFn: (req: TelegramDryRunRequest) => api.telegramDryRunChats(req),
  });
}
