//! The Telegram API pair (`api_id`, `api_hash`) kept between launches, so a saved
//! session reconnects without asking for it again.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::secrets::keychain_entry;
use crate::CommandError;

const KEYCHAIN_USER: &str = "telegram-api-key";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiKey {
    pub api_id: i32,
    pub api_hash: String,
}

impl ApiKey {
    /// The pair as typed into the sign-in form.
    pub fn checked(api_id: i32, api_hash: String) -> Result<Self, CommandError> {
        if api_id <= 0 {
            return Err(CommandError::msg("Telegram api_id must be positive"));
        }
        let api_hash = api_hash.trim();
        if api_hash.is_empty() {
            return Err(CommandError::msg("Telegram api_hash is required"));
        }
        Ok(Self {
            api_id,
            api_hash: api_hash.to_owned(),
        })
    }
}

/// Where the pair lives between launches.
pub trait ApiKeyVault: Send + Sync {
    fn load(&self) -> Result<Option<ApiKey>, CommandError>;
    fn save(&self, key: &ApiKey) -> Result<(), CommandError>;
    fn forget(&self) -> Result<(), CommandError>;
}

/// The OS keychain, next to the app's other secrets.
pub struct KeychainVault;

impl ApiKeyVault for KeychainVault {
    fn load(&self) -> Result<Option<ApiKey>, CommandError> {
        match keychain_entry(KEYCHAIN_USER)?.get_password() {
            Ok(json) => serde_json::from_str(&json).map(Some).map_err(|e| {
                CommandError::msg(format!("stored Telegram API key is unreadable: {e}"))
            }),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn save(&self, key: &ApiKey) -> Result<(), CommandError> {
        keychain_entry(KEYCHAIN_USER)?.set_password(&serde_json::to_string(key)?)?;
        Ok(())
    }

    fn forget(&self) -> Result<(), CommandError> {
        match keychain_entry(KEYCHAIN_USER)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// Keeps a pair only once it has signed someone in, so a mistyped one is never
/// replayed on the next launch.
pub struct ApiKeyKeeper<V> {
    vault: V,
    entered: Mutex<Option<ApiKey>>,
}

impl<V: ApiKeyVault> ApiKeyKeeper<V> {
    pub fn new(vault: V) -> Self {
        Self {
            vault,
            entered: Mutex::new(None),
        }
    }

    /// The pair a saved session was signed in with, if any.
    pub fn key_to_resume(&self) -> Result<Option<ApiKey>, CommandError> {
        self.vault.load()
    }

    /// A pair typed into the sign-in form; held until the sign-in finishes.
    pub fn entered(&self, key: ApiKey) {
        *self.entered_key() = Some(key);
    }

    /// Saves the entered pair; one the keychain refused stays here for the next try.
    pub fn signed_in(&self) -> Result<(), CommandError> {
        let mut entered = self.entered_key();
        // None means a resumed session: the saved pair is the one in use.
        if let Some(key) = entered.as_ref() {
            self.vault.save(key)?;
            *entered = None;
        }
        Ok(())
    }

    pub fn signed_out(&self) -> Result<(), CommandError> {
        self.entered_key().take();
        self.vault.forget()
    }

    fn entered_key(&self) -> std::sync::MutexGuard<'_, Option<ApiKey>> {
        self.entered
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct MemoryVault {
        key: Mutex<Option<ApiKey>>,
        refuses_saves: Mutex<bool>,
    }

    impl ApiKeyVault for MemoryVault {
        fn load(&self) -> Result<Option<ApiKey>, CommandError> {
            Ok(self.key.lock().unwrap().clone())
        }
        fn save(&self, key: &ApiKey) -> Result<(), CommandError> {
            if *self.refuses_saves.lock().unwrap() {
                return Err(CommandError::msg("keychain is locked"));
            }
            *self.key.lock().unwrap() = Some(key.clone());
            Ok(())
        }
        fn forget(&self) -> Result<(), CommandError> {
            *self.key.lock().unwrap() = None;
            Ok(())
        }
    }

    fn key(api_id: i32) -> ApiKey {
        ApiKey {
            api_id,
            api_hash: format!("hash-{api_id}"),
        }
    }

    #[test]
    fn nothing_to_resume_before_the_first_sign_in() {
        let keeper = ApiKeyKeeper::new(MemoryVault::default());
        assert_eq!(keeper.key_to_resume().unwrap(), None);
    }

    #[test]
    fn an_entered_key_is_kept_only_once_sign_in_succeeds() {
        let keeper = ApiKeyKeeper::new(MemoryVault::default());
        keeper.entered(key(1));
        assert_eq!(keeper.key_to_resume().unwrap(), None);

        keeper.signed_in().unwrap();
        assert_eq!(keeper.key_to_resume().unwrap(), Some(key(1)));
    }

    #[test]
    fn signing_in_on_a_resumed_session_keeps_the_saved_key() {
        let vault = MemoryVault::default();
        vault.save(&key(1)).unwrap();
        let keeper = ApiKeyKeeper::new(vault);

        keeper.signed_in().unwrap();
        assert_eq!(keeper.key_to_resume().unwrap(), Some(key(1)));
    }

    #[test]
    fn the_last_entered_key_wins() {
        let keeper = ApiKeyKeeper::new(MemoryVault::default());
        keeper.entered(key(1));
        keeper.entered(key(2));
        keeper.signed_in().unwrap();
        assert_eq!(keeper.key_to_resume().unwrap(), Some(key(2)));
    }

    #[test]
    fn a_key_the_keychain_refused_is_saved_on_the_next_try() {
        let keeper = ApiKeyKeeper::new(MemoryVault::default());
        keeper.entered(key(1));
        *keeper.vault.refuses_saves.lock().unwrap() = true;
        assert!(keeper.signed_in().is_err());

        *keeper.vault.refuses_saves.lock().unwrap() = false;
        keeper.signed_in().unwrap();
        assert_eq!(keeper.key_to_resume().unwrap(), Some(key(1)));
    }

    #[test]
    fn signing_out_forgets_the_key() {
        let keeper = ApiKeyKeeper::new(MemoryVault::default());
        keeper.entered(key(1));
        keeper.signed_in().unwrap();

        keeper.signed_out().unwrap();
        assert_eq!(keeper.key_to_resume().unwrap(), None);
        // A key entered before the sign-out does not come back with the next sign-in.
        keeper.signed_in().unwrap();
        assert_eq!(keeper.key_to_resume().unwrap(), None);
    }
}
