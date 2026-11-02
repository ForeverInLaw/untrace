import { useInfiniteQuery, useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type BuildRunRequest,
  type ConnectAccountRequest,
  type ContentType,
  type ProgressEvent,
  type StartRunRequest,
  type BackupRequest,
} from "../lib/tauri";

const PREVIEW_PAGE_SIZE = 100;
const RECEIPT_POLL_MS = 500;

export function useConnectAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["accounts", "connect"],
    mutationFn: (req: ConnectAccountRequest) => api.connectAccount(req),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["accounts"] }),
  });
}

export function useAccountsQuery() {
  return useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
}

export function useDisconnectAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["accounts", "disconnect"],
    mutationFn: api.disconnectAccount,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["accounts"] }),
  });
}

export function usePreviewSummaryQuery(runId: string | null) {
  return useQuery({
    enabled: runId !== null,
    queryKey: ["preview", runId, "summary"],
    queryFn: () => api.previewSummary(runId ?? ""),
  });
}

export function usePreviewItemsQuery(runId: string, protectedOnly: boolean, contentType: ContentType | null) {
  return useInfiniteQuery({
    queryKey: ["preview", runId, "items", protectedOnly, contentType],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.previewItems({ runId, protectedOnly, contentType, offset: pageParam, limit: PREVIEW_PAGE_SIZE }),
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === PREVIEW_PAGE_SIZE ? pages.length * PREVIEW_PAGE_SIZE : undefined,
  });
}

function protectMutationKey(runId: string) {
  return ["preview", runId, "protect"];
}

export function useSetItemProtectedMutation(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: protectMutationKey(runId),
    mutationFn: ({ platformId, isProtected }: { platformId: string; isProtected: boolean }) =>
      api.setItemProtected(runId, platformId, isProtected),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["preview", runId] }),
  });
}

/// True from a click on a row until the choice is stored and the counts are fresh.
export function useIsSavingProtection(runId: string) {
  return useIsMutating({ mutationKey: protectMutationKey(runId) }) > 0;
}

export function useReceiptsQuery() {
  return useQuery({ queryKey: ["receipts"], queryFn: api.listReceipts });
}

export function useInterruptedRunsQuery() {
  return useQuery({ queryKey: ["interrupted-runs"], queryFn: api.listInterruptedRuns });
}

/// The engine reports `done` just before it stores the receipt, so keep asking
/// until the receipt is there or reading it fails.
export function useReceiptQuery(runId: string) {
  return useQuery({
    queryKey: ["receipts", runId],
    queryFn: () => api.getReceipt(runId),
    refetchInterval: (query) => (query.state.data || query.state.status === "error" ? false : RECEIPT_POLL_MS),
  });
}

export function useDryRunMutation() {
  return useMutation({
    mutationKey: ["runs", "dry-run"],
    mutationFn: (req: BuildRunRequest) => api.dryRun(req),
  });
}

/// Starts the previewed run on whichever engine the platform uses.
export function useStartRunMutation(platformId: string, onEvent: (event: ProgressEvent) => void) {
  const queryClient = useQueryClient();
  const handleEvent = (event: ProgressEvent) => {
    onEvent(event);
    if (event.event === "error") {
      void queryClient.invalidateQueries({ queryKey: ["interrupted-runs"] });
    }
  };
  return useMutation({
    mutationKey: ["runs", "start"],
    mutationFn: (req: StartRunRequest) =>
      platformId === "telegram" ? api.telegramStartRun(req, handleEvent) : api.startRun(req, handleEvent),
  });
}

export function useUnsavedFilesQuery(runId: string) {
  return useQuery({ queryKey: ["unsaved-files", runId], queryFn: () => api.listUnsavedFiles(runId) });
}

interface RetryUnsavedFiles {
  runId: string;
  backupPassphrase: string | null;
  allowLostFiles: boolean;
}

/// Starts a follow-up run for what stayed, and resolves to its id. Whatever is in it
/// that the backup cannot hold in full, the person already agreed to in the first run.
export function useRetryUnsavedFilesMutation(platformId: string, onEvent: (event: ProgressEvent) => void) {
  const start = useStartRunMutation(platformId, onEvent);
  return useMutation({
    mutationKey: ["runs", "retry-unsaved"],
    mutationFn: async ({ runId, backupPassphrase, allowLostFiles }: RetryUnsavedFiles) => {
      const { run_id: retryId } = await api.retryUnsavedFiles(runId);
      try {
        await start.mutateAsync({
          runId: retryId,
          backupPassphrase,
          consent: { allowIncompleteBackup: true, allowLostFiles },
        });
      } catch (error) {
        await api.discardRetry(retryId);
        throw error;
      }
      return retryId;
    },
  });
}

export function usePauseRunMutation() {
  return useMutation({
    mutationKey: ["runs", "pause"],
    mutationFn: (runId: string) => api.pauseRun(runId),
  });
}

export function useVerifyBackupMutation() {
  return useMutation({
    mutationKey: ["backups", "verify"],
    mutationFn: (req: BackupRequest) => api.verifyBackup(req),
  });
}

export function useExportBackupMutation() {
  return useMutation({
    mutationKey: ["backups", "export"],
    mutationFn: (req: BackupRequest) => api.exportBackup(req),
  });
}

export function useResumeRunMutation() {
  return useMutation({
    mutationKey: ["runs", "resume"],
    mutationFn: (runId: string) => api.resumeRun(runId),
  });
}

export function useStopRunMutation() {
  return useMutation({
    mutationKey: ["runs", "stop"],
    mutationFn: (runId: string) => api.stopRun(runId),
  });
}
