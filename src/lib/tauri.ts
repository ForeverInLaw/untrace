import { invoke, Channel } from "@tauri-apps/api/core";

/// Mirrors the shell's CommandError: a code the interface words in the person's
/// language, the details that sentence needs, and the backend's own text.
export type CommandError = { message: string } & (
  | { code: "rate_limited"; wait_secs: number }
  | {
      code:
        | "unknown"
        | "offline"
        | "sign_in_rejected"
        | "session_expired"
        | "run_stopped"
        | "another_run_is_live"
        | "no_disk_space"
        | "wrong_passphrase"
        | "passphrase_needed"
        | "backup_write_failed"
        | "keychain_unavailable"
        | "telegram_not_connected"
        | "telegram_code_invalid"
        | "telegram_code_expired"
        | "telegram_password_invalid"
        | "telegram_phone_invalid"
        | "telegram_api_key_invalid";
    }
);

/// Mirrors the shell's RunEvent: lethe_core::ProgressEvent (serde tag="event",
/// snake_case), then the run's failure if it ended without a receipt.
export type RunEvent =
  | { event: "enumerating"; data: { seen: number } }
  | { event: "preview_ready"; data: { pending: number; protected: number } }
  | { event: "archiving"; data: { done_bytes: number; total_bytes: number } }
  | { event: "deleting"; data: { deleted: number; skipped: number; failed: number; total: number } }
  | { event: "throttled"; data: { rate_per_sec: number; wait_secs: number } }
  | { event: "offline" }
  | { event: "online" }
  | { event: "done"; data: { run_id: string } }
  | { event: "error"; data: CommandError };

export interface PreviewCounts {
  pending: number;
  protected: number;
}

export interface DryRunResult extends PreviewCounts {
  run_id: string;
}

export type PlatformStatus = "live" | "queued";
export type RiskClass = "green" | "yellow" | "red";
export type ContentType = "post" | "comment" | "reaction" | "media" | "dm";
export type PushdownDim = "content_type" | "scope" | "date_range";
export type AuthMode = "app_password" | "oauth_planned" | "byo_credentials";

export interface PlatformSummary {
  id: string;
  display_name: string;
  status: PlatformStatus;
  risk_class: RiskClass;
  content_types: ContentType[];
  pushdown: PushdownDim[];
  capabilities: {
    can_redact: boolean;
    can_undo: boolean;
    batch_delete_max: number;
  };
  auth_mode: AuthMode;
  note: string;
}

export type TelegramScopeKind = "private_chat" | "group" | "channel" | "secret";
export type TelegramAuthPhase =
  | "disabled"
  | "idle"
  | "starting"
  | "wait_parameters"
  | "wait_phone_number"
  | "wait_code"
  | "wait_password"
  | "wait_other_device_confirmation"
  | "ready"
  | "signing_out"
  | "closed"
  | "error";

export interface TelegramAuthStatus {
  phase: TelegramAuthPhase;
  error: CommandError | null;
  account_label: string | null;
  confirmation_link: string | null;
}

export interface TelegramChatSummary {
  id: string;
  title: string;
  kind: TelegramScopeKind;
  last_message_id: string | null;
}

export interface TelegramDryRunRequest {
  chat_ids: string[];
  filter: FilterRequest;
}

export interface TelegramScopeStatus {
  available: boolean;
  blocker: CommandError | null;
  auth: TelegramAuthStatus;
  chats: TelegramChatSummary[];
}

export interface TelegramAuthStartRequest {
  api_id: number;
  api_hash: string;
  phone_number: string;
}

export interface TelegramAuthCodeRequest {
  code: string;
}

export interface TelegramAuthPasswordRequest {
  password: string;
}

export interface ConnectAccountRequest {
  platform: string;
  identifier: string;
  appPassword: string;
}

export interface FilterRequest {
  content_types: ContentType[];
  date_from: string | null;
  date_to: string | null;
  keyword: string | null;
  keyword_regex: boolean;
  keyword_case_insensitive: boolean;
  fold_yo_ye: boolean;
  allowlist_ids: string[];
}

export interface BuildRunRequest {
  platform: string;
  account_id: string;
  account_label: string;
  filter: FilterRequest;
}

export interface BackupRequest {
  runId: string;
  backupPassphrase: string | null;
}

export interface RunConsent {
  /// The person agreed to delete items the backup cannot hold in full.
  allowIncompleteBackup: boolean;
  /// The person agreed to delete items whose files the platform refuses to hand over.
  allowLostFiles: boolean;
  /// The person agreed to delete items that only this account stops seeing.
  allowOnlyForSelf: boolean;
}

export interface StartRunRequest extends BackupRequest {
  consent: RunConsent;
}

export interface BackupVerification {
  ok: boolean;
  items: number;
  media_files: number;
  /** False when the backup breaks off; what it holds up to there is intact. */
  complete: boolean;
}

export interface BackupExport {
  folder: string;
  items: number;
  media_files: number;
  /// False when the backup broke or ended before it was sealed, so it may have held more.
  complete: boolean;
  partial_file: string | null;
}

/// How an export ended. Mirrors backup::ExportOutcome.
export type ExportOutcome =
  | { outcome: "no_folder" }
  | ({ outcome: "exported" } & BackupExport)
  | { outcome: "stopped" };

/// How much of the backup file an export has read.
export interface ExportProgress {
  done_bytes: number;
  total_bytes: number;
}

/// A run that ended without a receipt, reachable only through its backup.
export interface InterruptedRun {
  run_id: string;
  platform: string;
  account_label: string;
  started_epoch_secs: number;
  deleted: number;
  /// How many of `deleted` other people can still see.
  deleted_only_for_self: number;
}

export interface UnsavedItem {
  platform_id: string;
  /// One of `ITEM_SUBTYPES`, unless the engine is newer than this interface.
  subtype: string | null;
  created_at_secs: number | null;
  text: string | null;
  failure: "unavailable" | "unreachable";
}

/// The last row of a page of unsaved items; the next page starts past it.
export type UnsavedCursor = Pick<UnsavedItem, "platform_id" | "created_at_secs">;

/// How much stayed in a run because its files could not be saved.
export interface UnsavedFiles {
  total: number;
  /// How many may go without their file, with the person's consent.
  unavailable: number;
}

/// Bytes: the media going into the backup, what that takes on disk, what is free.
export interface BackupSpace {
  media: number;
  needed: number;
  available: number;
  fits: boolean;
}

/// How many items a previewed run would delete from one chat.
export interface ScopeCount {
  scope_id: string;
  items: number;
}

/// What a finished run deleted and failed to delete in one chat.
export interface ScopeOutcome {
  scope_id: string;
  deleted: number;
  failed: number;
}

export interface PreviewSummary extends PreviewCounts {
  types: { content_type: ContentType; count: number }[];
  /// Pending items the backup cannot hold in full; they go only with consent.
  backup_gaps: number;
  /// Pending items other people keep seeing; they go only with consent.
  only_for_self: number;
  /// How many pending items need both of those agreements.
  consents_overlap: number;
  /// Items in the set that the platform does not let this account delete.
  undeletable: number;
}

/// What an item is when its content type is too coarse, as the engine names it.
export const ITEM_SUBTYPES = [
  "animation", "audio", "document", "paid_media", "photo", "sticker", "video", "video_note",
  "voice_note", "expired_media", "location", "venue", "contact", "dice", "game", "poll", "story",
  "checklist", "checklist_changed", "invoice", "call", "video_chat", "chat_create",
  "chat_change_title", "chat_change_photo", "chat_delete_photo", "chat_add_members", "chat_join",
  "chat_leave", "chat_remove_member", "chat_upgrade", "pin_message", "screenshot_taken",
  "chat_set_theme", "auto_delete_timer", "topic_create", "topic_change", "game_score",
  "joined_telegram", "gift", "giveaway", "payment", "unsupported", "service",
] as const;
export type ItemSubtype = (typeof ITEM_SUBTYPES)[number];

export function isItemSubtype(subtype: string): subtype is ItemSubtype {
  return (ITEM_SUBTYPES as readonly string[]).includes(subtype);
}

export interface PreviewItem {
  platform_id: string;
  content_type: ContentType;
  /// One of `ITEM_SUBTYPES`, unless the engine is newer than this interface.
  subtype: string | null;
  created_at_secs: number | null;
  text: string | null;
  /// The name of its first named file.
  file_name: string | null;
  /// Bytes of its files; null unless every file's size is known.
  file_size: number | null;
  state: "pending" | "protected" | "undeletable";
  only_for_self: boolean;
}

/// Which preview rows a list shows. `all` leaves out what cannot be deleted.
export type ItemGroup = "all" | "protected" | "only_for_self" | "undeletable";

/// The preview rows a list or a choice over all of them covers.
export interface PreviewFilter {
  group: ItemGroup;
  contentType: ContentType | null;
  /// Text the rows must contain; blank covers them all.
  search: string;
  /// Subtypes whose wording holds the search; their rows match as well.
  matchingSubtypes: ItemSubtype[];
}

/// How the rows of a filter stand: going with the run, or kept.
export interface ChoiceCounts {
  going: number;
  kept: number;
}

export interface RunSummary {
  run_id: string;
  platform: string;
  account_label: string;
  started_epoch_secs: number;
  finished_epoch_secs: number;
  deleted: number;
  /// How many of `deleted` other people can still see. Absent when none.
  deleted_only_for_self?: number;
  skipped: number;
  failed: number;
  /// Items kept because only this account would have stopped seeing them. Absent when none.
  kept_only_for_self?: number;
  /// Items in the set the platform did not let this account delete. Absent when none.
  undeletable?: number;
}

export interface Receipt {
  summary: RunSummary;
  public_key_hex: string;
  signature_hex: string;
}

export interface StoredAccount {
  platform: string;
  label: string;
}

export const api = {
  platforms: () => invoke<PlatformSummary[]>("platforms"),
  telegramAuthStatus: () => invoke<TelegramAuthStatus>("telegram_auth_status"),
  telegramScopeStatus: () => invoke<TelegramScopeStatus>("telegram_scope_status"),
  telegramAuthStart: (req: TelegramAuthStartRequest) =>
    invoke<TelegramAuthStatus>("telegram_auth_start", { req }),
  telegramAuthCode: (req: TelegramAuthCodeRequest) =>
    invoke<TelegramAuthStatus>("telegram_auth_code", { req }),
  telegramAuthPassword: (req: TelegramAuthPasswordRequest) =>
    invoke<TelegramAuthStatus>("telegram_auth_password", { req }),
  telegramOwnMessageCount: (chatId: string) =>
    invoke<number>("telegram_own_message_count", { chatId }),
  telegramDryRunChats: (req: TelegramDryRunRequest) =>
    invoke<DryRunResult>("telegram_dry_run_chats", { req }),

  /// Phase 2 for a previewed Telegram run; same progress channel as startRun.
  telegramStartRun: (req: StartRunRequest, onEvent: (e: RunEvent) => void) => {
    const channel = new Channel<RunEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("telegram_start_run", {
      runId: req.runId,
      backupPassphrase: req.backupPassphrase,
      consent: req.consent,
      onEvent: channel,
    });
  },

  connectAccount: (req: ConnectAccountRequest) =>
    invoke<string>("connect_account", {
      platform: req.platform,
      identifier: req.identifier,
      appPassword: req.appPassword,
    }),

  dryRun: (req: BuildRunRequest) => invoke<DryRunResult>("dry_run", { req }),

  /// Streams progress over a Tauri Channel; the run lives in the core.
  startRun: (req: StartRunRequest, onEvent: (e: RunEvent) => void) => {
    const channel = new Channel<RunEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("start_run", {
      runId: req.runId,
      backupPassphrase: req.backupPassphrase,
      consent: req.consent,
      onEvent: channel,
    });
  },

  unsavedFiles: (runId: string) => invoke<UnsavedFiles>("unsaved_files", { runId }),
  unsavedItems: (runId: string, after: UnsavedCursor | null, limit: number) =>
    invoke<UnsavedItem[]>("unsaved_items", { runId, after, limit }),
  retryUnsavedFiles: (runId: string) => invoke<DryRunResult>("retry_unsaved_files", { runId }),
  discardRetry: (runId: string) => invoke<void>("discard_retry", { runId }),

  verifyBackup: (req: BackupRequest) =>
    invoke<BackupVerification>("verify_backup", {
      runId: req.runId,
      backupPassphrase: req.backupPassphrase,
    }),
  backupNeedsPassphrase: (runId: string) => invoke<boolean>("backup_needs_passphrase", { runId }),

  /// Streams how far it is over a Tauri Channel until it ends.
  exportBackup: (req: BackupRequest, onProgress: (progress: ExportProgress) => void) => {
    const channel = new Channel<ExportProgress>();
    channel.onmessage = onProgress;
    return invoke<ExportOutcome>("export_backup", {
      runId: req.runId,
      backupPassphrase: req.backupPassphrase,
      onProgress: channel,
    });
  },
  stopExport: (runId: string) => invoke<void>("stop_export", { runId }),

  previewSummary: (runId: string) => invoke<PreviewSummary>("preview_summary", { runId }),
  previewBackupSpace: (runId: string, consent: RunConsent) =>
    invoke<BackupSpace>("preview_backup_space", { runId, consent }),
  previewScopes: (runId: string, consent: RunConsent) =>
    invoke<ScopeCount[]>("preview_scopes", { runId, consent }),
  runScopeResults: (runId: string) => invoke<ScopeOutcome[]>("run_scope_results", { runId }),
  previewItems: (runId: string, filter: PreviewFilter, offset: number, limit: number) =>
    invoke<PreviewItem[]>("preview_items", { runId, filter, offset, limit }),
  setItemProtected: (runId: string, platformId: string, isProtected: boolean) =>
    invoke<boolean>("set_item_protected", { runId, platformId, protected: isProtected }),
  setItemsProtected: (runId: string, filter: PreviewFilter, isProtected: boolean) =>
    invoke<number>("set_items_protected", { runId, filter, protected: isProtected }),
  previewChoice: (runId: string, filter: PreviewFilter) =>
    invoke<ChoiceCounts>("preview_choice", { runId, filter }),
  listReceipts: () => invoke<Receipt[]>("list_receipts"),
  getReceipt: (runId: string) => invoke<Receipt | null>("get_receipt", { runId }),
  /// Where the receipt file went, or null when the person closed the save dialog.
  exportReceipt: (runId: string) => invoke<string | null>("export_receipt", { runId }),
  listInterruptedRuns: () => invoke<InterruptedRun[]>("list_interrupted_runs"),
  listAccounts: () => invoke<StoredAccount[]>("list_accounts"),
  disconnectAccount: (account: StoredAccount) => invoke<void>("disconnect_account", { ...account }),

  pauseRun: (runId: string) => invoke<void>("pause_run", { runId }),
  resumeRun: (runId: string) => invoke<void>("resume_run", { runId }),
  stopRun: (runId: string) => invoke<void>("stop_run", { runId }),
};
