use lethe_crypto::receipt::ReceiptSigner;
use lethe_crypto::DataKey;

use crate::CommandError;

const KEYRING_SERVICE: &str = "untrace";
const SIGNER_USER: &str = "receipt-signer";
pub const BACKUP_KEY_USER: &str = "backup-data-key";
const STORE_KEY_USER: &str = "store-key";
pub const SESSION_KEY_USER: &str = "session-data-key";

/// Per-install Ed25519 signer, minted on first use and held in the OS keychain.
pub fn receipt_signer() -> Result<ReceiptSigner, CommandError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, SIGNER_USER)?;
    match entry.get_secret() {
        Ok(bytes) => Ok(ReceiptSigner::from_secret_bytes(&bytes)?),
        Err(keyring::Error::NoEntry) => {
            let signer = ReceiptSigner::generate();
            entry.set_secret(signer.secret_bytes())?;
            Ok(signer)
        }
        Err(e) => Err(e.into()),
    }
}

pub fn keychain_data_key(user: &str, label: &str) -> Result<DataKey, CommandError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, user)?;
    match entry.get_secret() {
        Ok(bytes) if bytes.len() == 32 => {
            let mut key: DataKey = [0u8; 32];
            key.copy_from_slice(&bytes);
            Ok(key)
        }
        Ok(_) => Err(CommandError::msg(format!(
            "stored {label} has wrong length"
        ))),
        Err(keyring::Error::NoEntry) => {
            let key = lethe_crypto::random_data_key();
            entry.set_secret(&key)?;
            Ok(key)
        }
        Err(e) => Err(e.into()),
    }
}

pub fn store_key_passphrase() -> Result<String, CommandError> {
    Ok(hex_encode(&keychain_data_key(STORE_KEY_USER, "store key")?))
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}
