import { invoke, Channel } from "@tauri-apps/api/core";

/// Mirrors lethe_core::ProgressEvent (serde tag="event", snake_case).
export type ProgressEvent =
  | { event: "enumerating"; data: { seen: number } }
  | { event: "preview_ready"; data: { pending: number; protected: number } }
  | { event: "archiving"; data: { done_bytes: number; total_bytes: number } }
  | { event: "deleting"; data: { deleted: number; skipped: number; failed: number; total: number } }
  | { event: "throttled"; data: { rate_per_sec: number; wait_secs: number } }
  | { event: "done"; data: { run_id: string } }
  | { event: "error"; data: { message: string } };

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
  message: string;
  account_label: string | null;
  confirmation_link: string | null;
}

export interface TelegramScopeRule {
  kind: TelegramScopeKind;
  label: string;
  cleanability: string;
}

export interface TelegramChatSummary {
  id: string;
  title: string;
  kind: TelegramScopeKind;
  cleanability: string;
  last_message_id: string | null;
}

export interface TelegramDryRunRequest {
  chat_ids: string[];
  filter: FilterRequest;
}

export interface TelegramScopeStatus {
  available: boolean;
  blocker: string;
  auth: TelegramAuthStatus;
  rules: TelegramScopeRule[];
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
  created_at_secs: number | null;
  text: string | null;
  failure: "unavailable" | "unreachable";
}

/// What stayed in a run because its files could not be saved, with the first rows.
export interface UnsavedFiles {
  total: number;
  /// How many may go without their file, with the person's consent.
  unavailable: number;
  items: UnsavedItem[];
}

/// Bytes: the media going into the backup, what that takes on disk, what is free.
export interface BackupSpace {
  media: number;
  needed: number;
  available: number;
  fits: boolean;
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

export interface PreviewItem {
  platform_id: string;
  content_type: ContentType;
  created_at_secs: number | null;
  text: string | null;
  state: "pending" | "protected" | "undeletable";
  only_for_self: boolean;
}

/// Which preview rows a list shows. `all` leaves out what cannot be deleted.
export type ItemGroup = "all" | "protected" | "only_for_self" | "undeletable";

export interface PreviewItemsRequest {
  runId: string;
  group: ItemGroup;
  contentType: ContentType | null;
  offset: number;
  limit: number;
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
  telegramStartRun: (req: StartRunRequest, onEvent: (e: ProgressEvent) => void) => {
    const channel = new Channel<ProgressEvent>();
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
  startRun: (req: StartRunRequest, onEvent: (e: ProgressEvent) => void) => {
    const channel = new Channel<ProgressEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("start_run", {
      runId: req.runId,
      backupPassphrase: req.backupPassphrase,
      consent: req.consent,
      onEvent: channel,
    });
  },

  listUnsavedFiles: (runId: string) => invoke<UnsavedFiles>("list_unsaved_files", { runId }),
  retryUnsavedFiles: (runId: string) => invoke<DryRunResult>("retry_unsaved_files", { runId }),
  discardRetry: (runId: string) => invoke<void>("discard_retry", { runId }),

  verifyBackup: (req: BackupRequest) =>
    invoke<BackupVerification>("verify_backup", {
      runId: req.runId,
      backupPassphrase: req.backupPassphrase,
    }),

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
  previewItems: (req: PreviewItemsRequest) => invoke<PreviewItem[]>("preview_items", { ...req }),
  setItemProtected: (runId: string, platformId: string, isProtected: boolean) =>
    invoke<boolean>("set_item_protected", { runId, platformId, protected: isProtected }),
  listReceipts: () => invoke<Receipt[]>("list_receipts"),
  getReceipt: (runId: string) => invoke<Receipt | null>("get_receipt", { runId }),
  listInterruptedRuns: () => invoke<InterruptedRun[]>("list_interrupted_runs"),
  listAccounts: () => invoke<StoredAccount[]>("list_accounts"),
  disconnectAccount: (account: StoredAccount) => invoke<void>("disconnect_account", { ...account }),

  pauseRun: (runId: string) => invoke<void>("pause_run", { runId }),
  resumeRun: (runId: string) => invoke<void>("resume_run", { runId }),
  stopRun: (runId: string) => invoke<void>("stop_run", { runId }),
};
