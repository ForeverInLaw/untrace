import { hashKey, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
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

/// Every own-message count; a deletion changes them without changing any chat's last message.
export const OWN_COUNTS_KEY = ["telegram", "own-message-count"] as const;

/// Counts of one account, or of one of its chats in every version seen so far.
const ownCountKey = (account: string, chatId?: string) =>
  [...OWN_COUNTS_KEY, account, ...(chatId === undefined ? [] : [chatId])] as const;

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

/// A chat's title from the chat list, or its id once the chat is no longer listed.
export function useChatTitle(enabled: boolean) {
  const chats = useTelegramScopeStatusQuery(enabled).data?.chats;
  return (chatId: string) => chats?.find((chat) => chat.id === chatId)?.title || chatId;
}

/// Signing in or out changes the Telegram status, its chats and the list of accounts.
/// The chat list is dropped, not kept while it reloads, so another account's chats
/// never show under the new one.
export function useSessionRefresh() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: AUTH_KEY }),
      queryClient.resetQueries({ queryKey: SCOPE_STATUS_KEY }),
      queryClient.invalidateQueries({ queryKey: ["accounts"] }),
    ]);
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
/// A count cancelled while it waits its turn is skipped.
function oneAtATime<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  const run = countQueue.then(() => {
    signal.throwIfAborted();
    return task();
  });
  countQueue = run.catch(() => undefined);
  return run;
}

/// Counts the account's own messages chat by chat, in list order, and keeps each
/// count until that chat gets a new message. A chat being recounted shows its
/// latest count meanwhile. Leaving the step stops the scan; a count that failed is
/// tried again the next time the step opens. TDLib can't search secret chats, so
/// those stay unknown.
export function useTelegramOwnMessageCounts(account: string, chats: TelegramChatSummary[]) {
  const queryClient = useQueryClient();
  const latestCount = (chatId: string) =>
    queryClient
      .getQueriesData<number>({ queryKey: ownCountKey(account, chatId) })
      .reverse()
      .find(([, count]) => count !== undefined)?.[1];

  return useQueries({
    queries: chats.map((chat) => ({
      queryKey: [...ownCountKey(account, chat.id), chat.last_message_id],
      queryFn: async ({ signal, queryKey }) => {
        const count = await oneAtATime(signal, () => api.telegramOwnMessageCount(chat.id));
        // Counts of the chat's earlier versions are of no further use.
        queryClient.removeQueries({
          queryKey: ownCountKey(account, chat.id),
          predicate: (query) => query.queryHash !== hashKey(queryKey),
        });
        return count;
      },
      enabled: chat.kind !== "secret",
      placeholderData: () => latestCount(chat.id),
      // The backend already sits out FLOOD_WAIT; retrying here would only add searches.
      retry: false,
      staleTime: Infinity,
      gcTime: Infinity,
    })),
    combine: (results) => {
      const counts: OwnMessageCounts = {};
      results.forEach((result, index) => {
        const count = result.isError || !result.isEnabled ? null : result.data;
        if (count !== undefined) counts[chats[index].id] = count;
      });
      return { counts, uncounted: results.filter((result) => result.isFetching).length };
    },
  });
}

/// Recounts every chat of the account, changed or not.
export function useRecountOwnMessages(account: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ownCountKey(account) });
}

export function useTelegramDryRunChatsMutation() {
  return useMutation({
    mutationKey: ["telegram", "dry-run-chats"],
    mutationFn: (req: TelegramDryRunRequest) => api.telegramDryRunChats(req),
  });
}
