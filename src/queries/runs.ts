import {
  keepPreviousData,
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useMutationState,
  useQuery,
  type InfiniteData,
  type MutationState,
  useQueryClient,
} from "@tanstack/react-query";
import {
  api,
  type BuildRunRequest,
  type ConnectAccountRequest,
  type ContentType,
  type ItemGroup,
  type PreviewItem,
  type RunEvent,
  type RunConsent,
  type StartRunRequest,
  type BackupRequest,
  type ExportOutcome,
} from "../lib/tauri";
import { useExportStore } from "../stores/exportStore";
import { useRunStore } from "../stores/runStore";
import { OWN_COUNTS_KEY, useSessionRefresh } from "./telegram";

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

/// Disconnecting Telegram ends its live session, so its status refreshes too.
export function useDisconnectAccountMutation(accountRemoved: (platform: string, label: string) => void) {
  const refresh = useSessionRefresh();
  return useMutation({
    mutationKey: ["accounts", "disconnect"],
    mutationFn: api.disconnectAccount,
    onSuccess: (_, account) => {
      accountRemoved(account.platform, account.label);
      return refresh();
    },
  });
}

export function usePreviewSummaryQuery(runId: string | null) {
  return useQuery({
    enabled: runId !== null,
    queryKey: ["preview", runId, "summary"],
    queryFn: () => api.previewSummary(runId ?? ""),
  });
}

/// Space for the backup of what goes with the boxes as ticked. The last answer
/// stays on screen while the next one loads.
export function useBackupSpaceQuery(runId: string, consent: RunConsent) {
  return useQuery({
    queryKey: ["preview", runId, "backup-space", consent],
    queryFn: () => api.previewBackupSpace(runId, consent),
    placeholderData: keepPreviousData,
  });
}

/// The chats a run would delete from with these agreements, largest first.
export function usePreviewScopesQuery(runId: string, consent: RunConsent) {
  return useQuery({
    queryKey: ["preview", runId, "scopes", consent],
    queryFn: () => api.previewScopes(runId, consent),
    placeholderData: keepPreviousData,
  });
}

/// What a run did per chat. Known only for a run finished since the app started.
export function useRunScopeResultsQuery(runId: string, enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["runs", runId, "scope-results"],
    queryFn: () => api.runScopeResults(runId),
    staleTime: Infinity,
  });
}

/// Keeps the rows on screen while a new search loads, so typing does not blank the
/// table. A new chip starts empty: rows of another chip would be wrong under it.
export function usePreviewItemsQuery(
  runId: string,
  group: ItemGroup,
  contentType: ContentType | null,
  search: string,
) {
  return useInfiniteQuery({
    queryKey: ["preview", runId, "items", group, contentType, search],
    initialPageParam: 0,
    placeholderData: (previous: InfiniteData<PreviewItem[], number> | undefined, previousQuery) =>
      previousQuery?.queryKey[3] === group && previousQuery.queryKey[4] === contentType ? previous : undefined,
    queryFn: ({ pageParam }) =>
      api.previewItems({ runId, group, contentType, search, offset: pageParam, limit: PREVIEW_PAGE_SIZE }),
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

/// Starts the previewed run on whichever engine the platform uses; its events go to
/// the run store, which holds the run from here on.
export function useStartRunMutation(platformId: string) {
  const queryClient = useQueryClient();
  const apply = useRunStore((s) => s.apply);
  const setRunId = useRunStore((s) => s.setRunId);
  const handleEvent = (event: RunEvent) => {
    apply(event);
    if (event.event === "error") {
      void queryClient.invalidateQueries({ queryKey: ["interrupted-runs"] });
    }
  };
  return useMutation({
    mutationKey: ["runs", "start"],
    mutationFn: (req: StartRunRequest) =>
      platformId === "telegram" ? api.telegramStartRun(req, handleEvent) : api.startRun(req, handleEvent),
    // Before the call, so its first events already belong to it.
    onMutate: (req) => setRunId(req.runId),
    onError: () => setRunId(null),
    // Even a stopped run may have deleted some messages.
    onSettled: () =>
      platformId === "telegram" ? queryClient.invalidateQueries({ queryKey: OWN_COUNTS_KEY }) : undefined,
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
export function useRetryUnsavedFilesMutation(platformId: string) {
  const start = useStartRunMutation(platformId);
  const resetRun = useRunStore((s) => s.reset);
  return useMutation({
    mutationKey: ["runs", "retry-unsaved"],
    mutationFn: async ({ runId, backupPassphrase, allowLostFiles }: RetryUnsavedFiles) => {
      const { run_id: retryId } = await api.retryUnsavedFiles(runId);
      // The engine accepted it, so whatever the store showed before is over.
      resetRun();
      try {
        await start.mutateAsync({
          runId: retryId,
          backupPassphrase,
          // These items reached the run through the same consents, so they need not be asked again.
          consent: { allowIncompleteBackup: true, allowLostFiles, allowOnlyForSelf: true },
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

function exportMutationKey(runId: string) {
  return ["backups", "export", runId];
}

/// Exports `runId`'s backup. Its progress lives in the export store until it ends.
export function useExportBackupMutation(runId: string) {
  const report = useExportStore((s) => s.report);
  const end = useExportStore((s) => s.end);
  return useMutation({
    mutationKey: exportMutationKey(runId),
    // The outcome says where the unencrypted folder went, so it stays until the app closes.
    gcTime: Infinity,
    mutationFn: async (backupPassphrase: string | null) => {
      // A refused second export never reports, and must not end the first one's progress.
      let reported = false;
      try {
        return await api.exportBackup({ runId, backupPassphrase }, (progress) => {
          reported = true;
          report(runId, progress);
        });
      } finally {
        if (reported) {
          end(runId);
        }
      }
    },
  });
}

/// True while `runId`'s backup exports, from whichever screen started it.
export function useIsExporting(runId: string) {
  return useIsMutating({ mutationKey: exportMutationKey(runId) }) > 0;
}

/// The latest export of `runId`'s backup, still there after leaving the screen.
export function useLatestExport(runId: string) {
  const states = useMutationState({
    filters: { mutationKey: exportMutationKey(runId) },
    select: (mutation) => mutation.state as MutationState<ExportOutcome, Error, string | null>,
  });
  return states[states.length - 1];
}

export function useStopExportMutation() {
  return useMutation({
    mutationKey: ["backups", "stop-export"],
    mutationFn: (runId: string) => api.stopExport(runId),
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
