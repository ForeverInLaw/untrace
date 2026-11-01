import { create } from "zustand";
import type { ProgressEvent } from "../lib/tauri";

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
  /// Seconds until the platform's rate limit lifts; null when not limited.
  throttleWaitSecs: number | null;
  paused: boolean;
  status: RunStatus;
  message: string | null;
  apply: (e: ProgressEvent) => void;
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
  throttleWaitSecs: null,
  paused: false,
  status: "idle" as RunStatus,
  message: null,
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
        case "deleting":
          return { ...e.data, status: "deleting", throttleWaitSecs: null };
        case "throttled":
          return { throttleWaitSecs: e.data.wait_secs };
        case "done":
          return { status: "done", throttleWaitSecs: null };
        case "error":
          return { status: "error", message: e.data.message, throttleWaitSecs: null };
      }
    }),
  setPaused: (paused) => set({ paused }),
  reset: () => set(initial),
}));
