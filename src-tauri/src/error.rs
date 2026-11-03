//! The one error every command and run sends to the interface: a stable `code` the
//! interface words in the person's language, any details that sentence needs, and
//! the backend's own text for errors that have no sentence yet.

use lethe_adapter::AdapterError;
use lethe_core::EngineError;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CommandError {
    #[serde(flatten)]
    pub(crate) kind: ErrorKind,
    message: String,
}

/// What went wrong, as far as the person can act on it. Anything else is `Unknown`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ErrorKind {
    Unknown,
    Offline,
    RateLimited { wait_secs: u64 },
    SignInRejected,
    SessionExpired,
    RunStopped,
    AnotherRunIsLive,
    NoDiskSpace,
    WrongPassphrase,
    PassphraseNeeded,
    BackupWriteFailed,
    KeychainUnavailable,
    TelegramNotConnected,
    TelegramCodeInvalid,
    TelegramCodeExpired,
    TelegramPasswordInvalid,
    TelegramPhoneInvalid,
    TelegramApiKeyInvalid,
}

impl CommandError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }

    /// An error the interface has no sentence for; it shows `message` as details.
    pub fn msg(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Unknown, message)
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    /// A failed sign-in: here a refusal means the credentials are wrong, not that a
    /// session expired.
    pub fn sign_in(error: AdapterError) -> Self {
        match error {
            AdapterError::Auth(_) => Self::new(ErrorKind::SignInRejected, error.to_string()),
            other => other.into(),
        }
    }

    /// Why a run ended without its receipt. Only here does an IO error mean the
    /// backup could not be written, and an abort that the person stopped the run.
    pub fn run_failure(error: EngineError) -> Self {
        let kind = match error {
            EngineError::Aborted => ErrorKind::RunStopped,
            EngineError::Io(_) => ErrorKind::BackupWriteFailed,
            other => return other.into(),
        };
        Self::new(kind, error.to_string())
    }

    pub fn another_run_is_live() -> Self {
        Self::new(ErrorKind::AnotherRunIsLive, "another cleanup is still running")
    }

    /// An error TDLib answered with: its `code` and the Telegram error name in `message`.
    pub fn telegram(code: i32, message: &str) -> Self {
        let kind = match message {
            "PHONE_CODE_INVALID" | "PHONE_CODE_EMPTY" => ErrorKind::TelegramCodeInvalid,
            "PHONE_CODE_EXPIRED" => ErrorKind::TelegramCodeExpired,
            "PASSWORD_HASH_INVALID" => ErrorKind::TelegramPasswordInvalid,
            "PHONE_NUMBER_INVALID" => ErrorKind::TelegramPhoneInvalid,
            "API_ID_INVALID" | "API_ID_PUBLISHED_FLOOD" => ErrorKind::TelegramApiKeyInvalid,
            _ => telegram_wait(code, message)
                .map_or(ErrorKind::Unknown, |wait_secs| ErrorKind::RateLimited { wait_secs }),
        };
        Self::new(kind, format!("TDLib {code}: {message}"))
    }
}

/// How long Telegram asks to wait, from `FLOOD_WAIT_<secs>` or TDLib's own 429 text;
/// a 429 that names no wait gets a minute.
fn telegram_wait(code: i32, message: &str) -> Option<u64> {
    message
        .strip_prefix("FLOOD_WAIT_")
        .or_else(|| message.strip_prefix("Too Many Requests: retry after "))
        .and_then(|secs| secs.parse().ok())
        .or((code == 429).then_some(60))
}

impl From<AdapterError> for CommandError {
    fn from(error: AdapterError) -> Self {
        let kind = match error {
            AdapterError::Transport(_) => ErrorKind::Offline,
            AdapterError::RateLimited { retry_after_secs } => ErrorKind::RateLimited { wait_secs: retry_after_secs },
            AdapterError::Auth(_) => ErrorKind::SessionExpired,
            _ => ErrorKind::Unknown,
        };
        Self::new(kind, error.to_string())
    }
}

impl From<EngineError> for CommandError {
    fn from(error: EngineError) -> Self {
        match error {
            EngineError::Adapter(adapter) => adapter.into(),
            other => Self::msg(other.to_string()),
        }
    }
}

impl From<keyring::Error> for CommandError {
    fn from(error: keyring::Error) -> Self {
        let kind = match error {
            keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_) => ErrorKind::KeychainUnavailable,
            _ => ErrorKind::Unknown,
        };
        Self::new(kind, error.to_string())
    }
}

/// Errors with no sentence of their own: the interface shows their text as details.
macro_rules! unknown_from {
    ($($source:ty),+ $(,)?) => {
        $(impl From<$source> for CommandError {
            fn from(error: $source) -> Self {
                Self::msg(error.to_string())
            }
        })+
    };
}

unknown_from!(
    std::io::Error,
    serde_json::Error,
    time::error::ComponentRange,
    lethe_crypto::CryptoError,
    lethe_store::StoreError,
    tauri::Error,
);

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn sent(error: CommandError) -> serde_json::Value {
        serde_json::to_value(error).unwrap()
    }

    #[test]
    fn a_lost_connection_reads_as_offline() {
        let error = CommandError::from(AdapterError::Transport("connection refused".into()));

        assert_eq!(sent(error), json!({ "code": "offline", "message": "transport error: connection refused" }));
    }

    #[test]
    fn a_rate_limit_says_how_long_to_wait() {
        let error = CommandError::from(AdapterError::RateLimited { retry_after_secs: 60 });

        assert_eq!(
            sent(error),
            json!({ "code": "rate_limited", "wait_secs": 60, "message": "rate limited; retry after 60s" })
        );
    }

    #[test]
    fn a_session_the_platform_refuses_mid_scan_has_expired() {
        let error = CommandError::from(EngineError::Adapter(AdapterError::Auth("ExpiredToken".into())));

        assert_eq!(sent(error)["code"], "session_expired");
    }

    #[test]
    fn a_refused_sign_in_means_wrong_credentials() {
        let error = CommandError::sign_in(AdapterError::Auth("Invalid identifier or password".into()));

        assert_eq!(sent(error)["code"], "sign_in_rejected");
    }

    #[test]
    fn a_sign_in_without_network_is_not_wrong_credentials() {
        let error = CommandError::sign_in(AdapterError::Transport("dns error".into()));

        assert_eq!(sent(error)["code"], "offline");
    }

    #[test]
    fn a_run_the_person_stopped_says_so() {
        assert_eq!(sent(CommandError::run_failure(EngineError::Aborted))["code"], "run_stopped");
    }

    #[test]
    fn a_run_whose_backup_cannot_be_written_says_so() {
        let error = CommandError::run_failure(EngineError::Io("No space left on device".into()));

        assert_eq!(sent(error)["code"], "backup_write_failed");
    }

    #[test]
    fn a_backup_that_cannot_be_read_is_not_a_failed_write() {
        let error = CommandError::from(EngineError::Io("backup archive is damaged".into()));

        assert_eq!(sent(error)["code"], "unknown");
    }

    #[test]
    fn only_a_keychain_that_cannot_be_reached_asks_to_unlock_it() {
        let locked = keyring::Error::NoStorageAccess("locked".into());

        assert_eq!(sent(locked.into())["code"], "keychain_unavailable");
        assert_eq!(sent(keyring::Error::TooLong("user".into(), 255).into())["code"], "unknown");
    }

    #[test]
    fn telegram_sign_in_errors_name_what_to_fix() {
        let cases = [
            (400, "PHONE_CODE_INVALID", "telegram_code_invalid"),
            (400, "PHONE_CODE_EXPIRED", "telegram_code_expired"),
            (400, "PASSWORD_HASH_INVALID", "telegram_password_invalid"),
            (400, "PHONE_NUMBER_INVALID", "telegram_phone_invalid"),
            (400, "API_ID_INVALID", "telegram_api_key_invalid"),
        ];
        for (code, name, expected) in cases {
            assert_eq!(sent(CommandError::telegram(code, name))["code"], expected, "{name}");
        }
    }

    #[test]
    fn telegram_flood_waits_say_how_long() {
        assert_eq!(
            sent(CommandError::telegram(420, "FLOOD_WAIT_120")),
            json!({ "code": "rate_limited", "wait_secs": 120, "message": "TDLib 420: FLOOD_WAIT_120" })
        );
        assert_eq!(sent(CommandError::telegram(429, "Too Many Requests: retry after 30"))["wait_secs"], 30);
        assert_eq!(sent(CommandError::telegram(429, "Too Many Requests"))["wait_secs"], 60);
    }

    #[test]
    fn an_error_without_a_sentence_keeps_its_text() {
        let error = CommandError::from(std::io::Error::other("disk on fire"));

        assert_eq!(sent(error), json!({ "code": "unknown", "message": "disk on fire" }));
    }
}
