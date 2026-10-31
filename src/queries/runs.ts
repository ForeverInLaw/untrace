import { useMutation } from "@tanstack/react-query";
import {
  api,
  type BuildRunRequest,
  type ConnectAccountRequest,
  type ProgressEvent,
  type StartRunRequest,
  type VerifyBackupRequest,
} from "../lib/tauri";

export function useConnectAccountMutation() {
  return useMutation({
    mutationKey: ["accounts", "connect"],
    mutationFn: (req: ConnectAccountRequest) => api.connectAccount(req),
  });
}

export function useDryRunMutation() {
  return useMutation({
    mutationKey: ["runs", "dry-run"],
    mutationFn: (req: BuildRunRequest) => api.dryRun(req),
  });
}

export function useStartRunMutation(onEvent: (event: ProgressEvent) => void) {
  return useMutation({
    mutationKey: ["runs", "start"],
    mutationFn: (req: StartRunRequest) => api.startRun(req, onEvent),
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
    mutationFn: (req: VerifyBackupRequest) => api.verifyBackup(req),
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
