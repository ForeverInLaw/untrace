import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type TelegramAuthCodeRequest,
  type TelegramAuthPasswordRequest,
  type TelegramAuthStartRequest,
  type TelegramChatSummary,
  type TelegramDryRunRequest,
} from "../lib/tauri";

export function useTelegramScopeStatusQuery(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["telegram", "scope-status"],
    queryFn: api.telegramScopeStatus,
    // Listing loads every chat, too slow to repeat on each window focus.
    refetchOnWindowFocus: false,
  });
}

/// Signing in or out changes both the Telegram status and the list of accounts.
export function useSessionRefresh() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["telegram", "scope-status"] }),
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

/// Checks chats one at a time and publishes partial results, so the list fills in
/// as the scan runs. TDLib can't search secret chats, so those stay unknown.
export function useTelegramOwnMessageCountsQuery(chats: TelegramChatSummary[]) {
  return useQuery<OwnMessageCounts>({
    enabled: chats.length > 0,
    queryKey: ["telegram", "own-message-counts", chats.map((chat) => chat.id).join()],
    staleTime: Infinity,
    queryFn: async ({ client, queryKey, signal }) => {
      const counts: OwnMessageCounts = {};
      for (const chat of chats) {
        if (signal.aborted) break;
        counts[chat.id] =
          chat.kind === "secret" ? null : await api.telegramOwnMessageCount(chat.id).catch(() => null);
        client.setQueryData<OwnMessageCounts>(queryKey, { ...counts });
      }
      return counts;
    },
  });
}

export function useTelegramDryRunChatsMutation() {
  return useMutation({
    mutationKey: ["telegram", "dry-run-chats"],
    mutationFn: (req: TelegramDryRunRequest) => api.telegramDryRunChats(req),
  });
}
