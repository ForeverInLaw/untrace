import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type ProgressEvent,
  type StartRunRequest,
  type TelegramAuthCodeRequest,
  type TelegramAuthPasswordRequest,
  type TelegramAuthStartRequest,
  type TelegramDryRunRequest,
  type TelegramPreviewRequest,
} from "../lib/tauri";

export function useTelegramScopeStatusQuery(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["telegram", "scope-status"],
    queryFn: api.telegramScopeStatus,
  });
}

export function useTelegramAuthStartMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["telegram", "auth-start"],
    mutationFn: (req: TelegramAuthStartRequest) => api.telegramAuthStart(req),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["telegram", "scope-status"] }),
  });
}

export function useTelegramAuthCodeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["telegram", "auth-code"],
    mutationFn: (req: TelegramAuthCodeRequest) => api.telegramAuthCode(req),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["telegram", "scope-status"] }),
  });
}

export function useTelegramAuthPasswordMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["telegram", "auth-password"],
    mutationFn: (req: TelegramAuthPasswordRequest) => api.telegramAuthPassword(req),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["telegram", "scope-status"] }),
  });
}

export function useTelegramPreviewChatsMutation() {
  return useMutation({
    mutationKey: ["telegram", "preview-chats"],
    mutationFn: (req: TelegramPreviewRequest) => api.telegramPreviewChats(req),
  });
}

export function useTelegramDryRunChatsMutation() {
  return useMutation({
    mutationKey: ["telegram", "dry-run-chats"],
    mutationFn: (req: TelegramDryRunRequest) => api.telegramDryRunChats(req),
  });
}

export function useTelegramStartRunMutation(onEvent: (event: ProgressEvent) => void) {
  return useMutation({
    mutationKey: ["telegram", "start-run"],
    mutationFn: (req: StartRunRequest) => api.telegramStartRun(req, onEvent),
  });
}
