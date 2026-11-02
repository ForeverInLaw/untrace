import { create } from "zustand";
import type { ContentType, FilterRequest } from "../lib/tauri";

export type View = "cleanup" | "receipts" | "accounts";

/// The cleanup steps in order. `StepBar` and the screens index into this.
export const STEPS = ["account", "scope", "preview", "backup", "run", "receipt"] as const;
export type Step = (typeof STEPS)[number];

/// What the person typed on the "what to delete" step, before it becomes a request.
export interface ScopeDraft {
  /// Null means every type the platform offers.
  contentTypes: ContentType[] | null;
  dateFrom: string;
  dateTo: string;
  keyword: string;
  keywordRegex: boolean;
  foldYoYe: boolean;
  allowlistIds: string;
}

const initialDraft: ScopeDraft = {
  contentTypes: null,
  dateFrom: "",
  dateTo: "",
  keyword: "",
  keywordRegex: false,
  foldYoYe: true,
  allowlistIds: "",
};

const initialCleanup = {
  step: "account" as Step,
  platformId: "bluesky",
  account: null as string | null,
  draft: initialDraft,
  chatIds: [] as string[],
  runId: null as string | null,
  passphrase: "",
};

interface FlowState {
  view: View;
  openReceiptId: string | null;
  step: Step;
  platformId: string;
  account: string | null;
  draft: ScopeDraft;
  chatIds: string[];
  runId: string | null;
  passphrase: string;
  openView: (view: View) => void;
  openReceipt: (runId: string | null) => void;
  goTo: (step: Step) => void;
  selectPlatform: (platformId: string) => void;
  chooseAccount: (account: string) => void;
  editDraft: (patch: Partial<ScopeDraft>) => void;
  toggleChat: (chatId: string) => void;
  previewed: (runId: string) => void;
  setPassphrase: (passphrase: string) => void;
  retryStarted: (retry: { runId: string; platformId: string; account: string; passphrase: string }) => void;
  startOver: () => void;
  /// A disconnected account can no longer carry the cleanup it was chosen for.
  accountRemoved: (platformId: string, account: string) => void;
}

/// Where the person is and what they chose. Server data stays in TanStack Query,
/// live run telemetry stays in `runStore`.
export const useFlowStore = create<FlowState>((set) => ({
  view: "cleanup",
  openReceiptId: null,
  ...initialCleanup,
  // Coming back to an unfinished cleanup keeps it; a finished one has nothing left to return to.
  openView: (view) =>
    set((state) => ({
      ...(view === "cleanup" && state.step === "receipt" ? initialCleanup : {}),
      view,
      openReceiptId: null,
    })),
  openReceipt: (openReceiptId) => set({ view: "receipts", openReceiptId }),
  goTo: (step) => set({ step, view: "cleanup" }),
  selectPlatform: (platformId) => set({ platformId, account: null, draft: initialDraft, chatIds: [], runId: null }),
  chooseAccount: (account) => set({ account, step: "scope", view: "cleanup", runId: null }),
  editDraft: (patch) => set((state) => ({ draft: { ...state.draft, ...patch }, runId: null })),
  toggleChat: (chatId) =>
    set((state) => ({
      runId: null,
      chatIds: state.chatIds.includes(chatId)
        ? state.chatIds.filter((id) => id !== chatId)
        : [...state.chatIds, chatId],
    })),
  previewed: (runId) => set({ runId, step: "preview" }),
  setPassphrase: (passphrase) => set({ passphrase }),
  retryStarted: (retry) => set({ ...retry, step: "run", view: "cleanup", openReceiptId: null }),
  startOver: () => set({ ...initialCleanup, view: "cleanup", openReceiptId: null }),
  accountRemoved: (platformId, account) =>
    set((state) =>
      state.platformId === platformId && state.account === account ? { ...initialCleanup, platformId } : {},
    ),
}));

/// The content types a run will cover, limited to what the platform has.
export function effectiveContentTypes(draft: ScopeDraft, available: ContentType[]): ContentType[] {
  return draft.contentTypes
    ? draft.contentTypes.filter((type) => available.includes(type))
    : available;
}

export function toFilterRequest(draft: ScopeDraft, available: ContentType[]): FilterRequest {
  const keyword = draft.keyword.trim();
  return {
    content_types: effectiveContentTypes(draft, available),
    date_from: draft.dateFrom || null,
    date_to: draft.dateTo || null,
    keyword: keyword.length > 0 ? keyword : null,
    keyword_regex: draft.keywordRegex,
    keyword_case_insensitive: true,
    fold_yo_ye: draft.foldYoYe,
    allowlist_ids: draft.allowlistIds
      .split(/[\n,]+/)
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  };
}
