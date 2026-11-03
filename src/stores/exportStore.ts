import { create } from "zustand";
import type { ExportProgress } from "../lib/tauri";

interface ExportState {
  /// Exports under way, by run. Kept here so leaving a screen and coming back
  /// still shows an export that never stopped.
  progress: Record<string, ExportProgress>;
  report: (runId: string, progress: ExportProgress) => void;
  end: (runId: string) => void;
}

/// Components MUST read via selectors.
export const useExportStore = create<ExportState>((set) => ({
  progress: {},
  report: (runId, progress) => set((s) => ({ progress: { ...s.progress, [runId]: progress } })),
  end: (runId) =>
    set((s) => {
      const { [runId]: _ended, ...rest } = s.progress;
      return { progress: rest };
    }),
}));
