use serde::{Deserialize, Serialize};

use crate::CommandError;

/// TDLib's files folder under the Telegram folder. A downloaded file sits there
/// unencrypted until the backup has it and it is deleted.
pub const FILES_DIR: &str = "files";


/// Built only with TDLib, which lists the chats.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(
    not(any(
        feature = "telegram-tdlib-docs",
        feature = "telegram-tdlib-local",
        feature = "telegram-tdlib-download"
    )),
    allow(dead_code)
)]
pub enum TelegramScopeKind {
    PrivateChat,
    Group,
    Channel,
    Secret,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum TelegramAuthPhase {
    Disabled,
    Idle,
    Starting,
    /// TDLib needs the API pair before anything else.
    WaitParameters,
    /// TDLib holds the API pair and waits for a phone number.
    WaitPhoneNumber,
    WaitCode,
    WaitPassword,
    WaitOtherDeviceConfirmation,
    Ready,
    SigningOut,
    Closed,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct TelegramAuthStatus {
    pub phase: TelegramAuthPhase,
    /// Why sign-in failed; set only in the `Error` phase.
    pub error: Option<CommandError>,
    pub account_label: Option<String>,
    pub confirmation_link: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TelegramChatSummary {
    pub id: String,
    pub title: String,
    pub kind: TelegramScopeKind,
    /// Changes with each new message, so the UI knows when a count is out of date.
    pub last_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TelegramScopeStatus {
    pub available: bool,
    /// Why chats cannot be listed; `None` once they can.
    pub blocker: Option<CommandError>,
    pub auth: TelegramAuthStatus,
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

#[cfg(not(any(
    feature = "telegram-tdlib-docs",
    feature = "telegram-tdlib-local",
    feature = "telegram-tdlib-download"
)))]
mod fallback {
    use std::path::PathBuf;

    use tauri::State;

    use super::*;

    const TDLIB_DISABLED: &str = "Telegram TDLib is not enabled in this build";

    pub struct TelegramState;

    impl TelegramState {
        pub fn new(_root_dir: PathBuf) -> Self {
            Self
        }

        pub async fn signed_in_account(&self) -> Result<Option<String>, CommandError> {
            Ok(None)
        }

        pub async fn log_out(&self) -> Result<(), CommandError> {
            Err(CommandError::msg(TDLIB_DISABLED))
        }
    }

    #[tauri::command]
    pub async fn telegram_scope_status(
        _state: State<'_, TelegramState>,
    ) -> Result<TelegramScopeStatus, CommandError> {
        Ok(TelegramScopeStatus {
            available: false,
            blocker: Some(CommandError::msg(TDLIB_DISABLED)),
            auth: disabled_status(),
            chats: Vec::new(),
        })
    }

    #[tauri::command]
    pub async fn telegram_auth_status(
        _state: State<'_, TelegramState>,
    ) -> Result<TelegramAuthStatus, CommandError> {
        Ok(disabled_status())
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
        Err(CommandError::msg(TDLIB_DISABLED))
    }

    #[tauri::command]
    pub async fn telegram_dry_run_chats(
        _app: State<'_, crate::AppState>,
        _state: State<'_, TelegramState>,
        req: TelegramDryRunRequest,
    ) -> Result<crate::DryRunResult, CommandError> {
        let _ = (&req.chat_ids, &req.filter);
        Err(CommandError::msg(TDLIB_DISABLED))
    }

    #[tauri::command]
    pub async fn telegram_start_run(
        _app: State<'_, crate::AppState>,
        _state: State<'_, TelegramState>,
        run_id: String,
        _backup_passphrase: Option<String>,
        _consent: crate::RunConsent,
        _on_event: tauri::ipc::Channel<crate::RunEvent>,
    ) -> Result<(), CommandError> {
        let _ = run_id;
        Err(CommandError::msg(TDLIB_DISABLED))
    }

    fn disabled_status() -> TelegramAuthStatus {
        TelegramAuthStatus {
            phase: TelegramAuthPhase::Disabled,
            error: None,
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
