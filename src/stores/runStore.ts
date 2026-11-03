import { create } from "zustand";
import type { CommandError, RunEvent } from "../lib/tauri";

export type RunStatus =
  | "idle"
  | "enumerating"
  | "preview"
  | "deleting"
  | "done"
  | "error";

interface RunState {
  seen: number;
  deleted: number;
  skipped: number;
  failed: number;
  total: number;
  protected: number;
  archivedBytes: number;
  archiveTotalBytes: number;
  /// Seconds until the platform's rate limit lifts; null when not limited.
  throttleWaitSecs: number | null;
  /// The platform stopped answering; the run waits for it.
  offline: boolean;
  paused: boolean;
  status: RunStatus;
  failure: CommandError | null;
  /// The run these numbers describe, from its start; null for a preview.
  runId: string | null;
  apply: (e: RunEvent) => void;
  setRunId: (runId: string | null) => void;
  setPaused: (paused: boolean) => void;
  reset: () => void;
}

const initial = {
  seen: 0,
  deleted: 0,
  skipped: 0,
  failed: 0,
  total: 0,
  protected: 0,
  archivedBytes: 0,
  archiveTotalBytes: 0,
  throttleWaitSecs: null,
  offline: false,
  paused: false,
  status: "idle" as RunStatus,
  failure: null,
  runId: null as string | null,
};

/// Live, ephemeral run telemetry. Components MUST read via selectors.
export const useRunStore = create<RunState>((set) => ({
  ...initial,
  apply: (e) =>
    set(() => {
      switch (e.event) {
        case "enumerating":
          return { seen: e.data.seen, status: "enumerating" };
        case "preview_ready":
          return { total: e.data.pending, protected: e.data.protected, status: "preview" };
        case "archiving":
          return { archivedBytes: e.data.done_bytes, archiveTotalBytes: e.data.total_bytes };
        case "deleting":
          return { ...e.data, status: "deleting", throttleWaitSecs: null };
        case "throttled":
          return { throttleWaitSecs: e.data.wait_secs };
        case "offline":
          return { offline: true, throttleWaitSecs: null };
        case "online":
          return { offline: false };
        case "done":
          return { status: "done", throttleWaitSecs: null, offline: false };
        case "error":
          return { status: "error", failure: e.data, throttleWaitSecs: null, offline: false };
      }
    }),
  setPaused: (paused) => set({ paused }),
  setRunId: (runId) => set({ runId }),
  reset: () => set(initial),
}));

/// Whether a run has started and not yet ended. The engine runs one at a time.
export const selectRunLive = (s: RunState) => s.runId !== null && s.status !== "done" && s.status !== "error";
