import { invoke, Channel } from "@tauri-apps/api/core";

/// Mirrors lethe_core::ProgressEvent (serde tag="event", snake_case).
export type ProgressEvent =
  | { event: "enumerating"; data: { seen: number } }
  | { event: "preview_ready"; data: { pending: number; protected: number } }
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
  | "wait_code"
  | "wait_password"
  | "wait_other_device_confirmation"
  | "ready"
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

export interface StartRunRequest {
  runId: string;
  backupPassphrase: string | null;
}

export interface VerifyBackupRequest extends StartRunRequest {}

export interface BackupVerification {
  ok: boolean;
  chunks: number;
}

export const api = {
  platforms: () => invoke<PlatformSummary[]>("platforms"),
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
      onEvent: channel,
    });
  },

  verifyBackup: (req: VerifyBackupRequest) =>
    invoke<BackupVerification>("verify_backup", {
      runId: req.runId,
      backupPassphrase: req.backupPassphrase,
    }),

  pauseRun: (runId: string) => invoke<void>("pause_run", { runId }),
  resumeRun: (runId: string) => invoke<void>("resume_run", { runId }),
  stopRun: (runId: string) => invoke<void>("stop_run", { runId }),
};
