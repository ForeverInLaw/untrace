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
  throttleRate: number | null;
  status: RunStatus;
  message: string | null;
  apply: (e: ProgressEvent) => void;
  reset: () => void;
}

const initial = {
  seen: 0,
  deleted: 0,
  skipped: 0,
  failed: 0,
  total: 0,
  protected: 0,
  throttleRate: null,
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
          return { ...e.data, status: "deleting" };
        case "throttled":
          return { throttleRate: e.data.rate_per_sec };
        case "done":
          return { status: "done" };
        case "error":
          return { status: "error", message: e.data.message };
      }
    }),
  reset: () => set(initial),
}));
