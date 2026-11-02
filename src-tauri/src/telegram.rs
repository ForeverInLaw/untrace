use serde::{Deserialize, Serialize};

#[cfg(not(any(
    feature = "telegram-tdlib-docs",
    feature = "telegram-tdlib-local",
    feature = "telegram-tdlib-download"
)))]
use crate::CommandError;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TelegramScopeKind {
    PrivateChat,
    Group,
    Channel,
    Secret,
}

#[derive(Debug, Clone, Serialize)]
pub struct TelegramScopeRule {
    pub kind: TelegramScopeKind,
    pub label: &'static str,
    pub cleanability: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum TelegramAuthPhase {
    Disabled,
    Idle,
    Starting,
    WaitCode,
    WaitPassword,
    WaitOtherDeviceConfirmation,
    Ready,
    Closed,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct TelegramAuthStatus {
    pub phase: TelegramAuthPhase,
    pub message: String,
    pub account_label: Option<String>,
    pub confirmation_link: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TelegramChatSummary {
    pub id: String,
    pub title: String,
    pub kind: TelegramScopeKind,
    pub cleanability: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TelegramScopeStatus {
    pub available: bool,
    pub blocker: String,
    pub auth: TelegramAuthStatus,
    pub rules: Vec<TelegramScopeRule>,
    pub chats: Vec<TelegramChatSummary>,
}

#[derive(Debug, Deserialize)]
pub struct TelegramAuthStartRequest {
    pub api_id: i32,
    pub api_hash: String,
    pub phone_number: String,
}

#[derive(Debug, Deserialize)]
pub struct TelegramAuthCodeRequest {
    pub code: String,
}

#[derive(Debug, Deserialize)]
pub struct TelegramAuthPasswordRequest {
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct TelegramDryRunRequest {
    pub chat_ids: Vec<String>,
    #[serde(default)]
    pub filter: crate::run_filters::FilterRequest,
}

pub fn default_rules() -> Vec<TelegramScopeRule> {
    vec![
        TelegramScopeRule {
            kind: TelegramScopeKind::PrivateChat,
            label: "Private chats",
            cleanability: "Own messages can be revoked for both sides where Telegram permits it.",
        },
        TelegramScopeRule {
            kind: TelegramScopeKind::Group,
            label: "Groups",
            cleanability:
                "Own messages are cleanable; older messages can be limited by Telegram/admin rules.",
        },
        TelegramScopeRule {
            kind: TelegramScopeKind::Channel,
            label: "Channels",
            cleanability: "Cleanup depends on authorship and channel permissions.",
        },
        TelegramScopeRule {
            kind: TelegramScopeKind::Secret,
            label: "Secret chats",
            cleanability: "Secret-chat cleanup follows TDLib availability and local session state.",
        },
    ]
}

#[cfg(not(any(
    feature = "telegram-tdlib-docs",
    feature = "telegram-tdlib-local",
    feature = "telegram-tdlib-download"
)))]
mod fallback {
    use std::path::PathBuf;

    use tauri::State;

    use super::*;

    pub struct TelegramState;

    impl TelegramState {
        pub fn new(_root_dir: PathBuf) -> Self {
            Self
        }
    }

    #[tauri::command]
    pub async fn telegram_scope_status(
        _state: State<'_, TelegramState>,
    ) -> Result<TelegramScopeStatus, CommandError> {
        Ok(TelegramScopeStatus {
            available: false,
            blocker: "Telegram TDLib is feature-gated. Run the Tauri shell with telegram-tdlib-local or telegram-tdlib-download to authenticate.".into(),
            auth: disabled_status(),
            rules: default_rules(),
            chats: Vec::new(),
        })
    }

    #[tauri::command]
    pub async fn telegram_auth_start(
        _state: State<'_, TelegramState>,
        req: TelegramAuthStartRequest,
    ) -> Result<TelegramAuthStatus, CommandError> {
        let _ = (&req.api_id, &req.api_hash, &req.phone_number);
        Ok(disabled_status())
    }

    #[tauri::command]
    pub async fn telegram_auth_code(
        _state: State<'_, TelegramState>,
        req: TelegramAuthCodeRequest,
    ) -> Result<TelegramAuthStatus, CommandError> {
        let _ = &req.code;
        Ok(disabled_status())
    }

    #[tauri::command]
    pub async fn telegram_auth_password(
        _state: State<'_, TelegramState>,
        req: TelegramAuthPasswordRequest,
    ) -> Result<TelegramAuthStatus, CommandError> {
        let _ = &req.password;
        Ok(disabled_status())
    }

    #[tauri::command]
    pub async fn telegram_own_message_count(
        _state: State<'_, TelegramState>,
        chat_id: String,
    ) -> Result<usize, CommandError> {
        let _ = chat_id;
        Err(CommandError::msg(
            "Telegram TDLib is not enabled in this build",
        ))
    }

    #[tauri::command]
    pub async fn telegram_dry_run_chats(
        _app: State<'_, crate::AppState>,
        _state: State<'_, TelegramState>,
        req: TelegramDryRunRequest,
    ) -> Result<crate::DryRunResult, CommandError> {
        let _ = (&req.chat_ids, &req.filter);
        Err(CommandError::msg(
            "Telegram TDLib is not enabled in this build",
        ))
    }

    #[tauri::command]
    pub async fn telegram_start_run(
        _app: State<'_, crate::AppState>,
        _state: State<'_, TelegramState>,
        run_id: String,
        _backup_passphrase: Option<String>,
        _allow_incomplete_backup: bool,
        _on_event: tauri::ipc::Channel<lethe_core::ProgressEvent>,
    ) -> Result<(), CommandError> {
        let _ = run_id;
        Err(CommandError::msg(
            "Telegram TDLib is not enabled in this build",
        ))
    }

    fn disabled_status() -> TelegramAuthStatus {
        TelegramAuthStatus {
            phase: TelegramAuthPhase::Disabled,
            message: "TDLib is not enabled in this build.".into(),
            account_label: None,
            confirmation_link: None,
        }
    }
}

#[cfg(any(
    feature = "telegram-tdlib-docs",
    feature = "telegram-tdlib-local",
    feature = "telegram-tdlib-download"
))]
#[path = "telegram_tdlib.rs"]
mod tdlib;

#[cfg(not(any(
    feature = "telegram-tdlib-docs",
    feature = "telegram-tdlib-local",
    feature = "telegram-tdlib-download"
)))]
pub use fallback::*;

#[cfg(any(
    feature = "telegram-tdlib-docs",
    feature = "telegram-tdlib-local",
    feature = "telegram-tdlib-download"
))]
pub use tdlib::*;
