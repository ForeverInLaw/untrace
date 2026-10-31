use std::fs;
use std::path::{Path, PathBuf};

use lethe_core::pipeline::BackupTarget;
use lethe_crypto::container::{derive_data_key, ContainerReader, ContainerWriter};
use lethe_crypto::DataKey;
use serde::{Deserialize, Serialize};

use crate::secrets::{hex_encode, keychain_data_key, BACKUP_KEY_USER};
use crate::CommandError;

const BACKUP_KEY_FILE_EXT: &str = "key.bin";
const BACKUP_KEY_META_EXT: &str = "key.json";

#[derive(Debug, Serialize)]
pub struct BackupVerification {
    pub ok: bool,
    pub chunks: u64,
}

#[derive(Debug, Deserialize)]
struct BackupKeySidecar {
    version: u8,
    mode: String,
    kdf: String,
    salt_hex: String,
    wrapped_key_file: String,
}

pub fn backup_path(base_dir: &Path, run_id: &str) -> PathBuf {
    base_dir.join(format!("untrace-backup-{run_id}.bin"))
}

pub fn backup_target(
    base_dir: &Path,
    run_id: &str,
    backup_passphrase: Option<&str>,
) -> Result<BackupTarget, CommandError> {
    let path = backup_path(base_dir, run_id);
    let key = match backup_passphrase {
        Some(passphrase) => passphrase_backup_key(&path, passphrase)?,
        None => backup_data_key()?,
    };
    Ok(BackupTarget { path, key })
}

pub fn verify_backup(
    base_dir: &Path,
    run_id: &str,
    backup_passphrase: Option<&str>,
) -> Result<BackupVerification, CommandError> {
    let path = backup_path(base_dir, run_id);
    let key = match backup_passphrase {
        Some(passphrase) => unwrap_passphrase_backup_key(&path, passphrase)?,
        None => backup_data_key()?,
    };
    let file = fs::File::open(&path)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                CommandError::msg("backup archive not found; start the run first")
            } else {
                e.into()
            }
        })?;
    let mut reader = ContainerReader::open(file, &key)?;
    let mut chunks = 0;
    while reader.read_chunk()?.is_some() {
        chunks += 1;
    }
    if chunks == 0 {
        return Err(CommandError::msg("backup archive contains no chunks"));
    }
    Ok(BackupVerification { ok: true, chunks })
}

fn backup_data_key() -> Result<DataKey, CommandError> {
    keychain_data_key(BACKUP_KEY_USER, "backup key")
}

fn passphrase_backup_key(archive_path: &Path, passphrase: &str) -> Result<DataKey, CommandError> {
    if passphrase.is_empty() {
        return Err(CommandError::msg("backup passphrase must not be empty"));
    }
    let data_key = lethe_crypto::random_data_key();
    let salt = lethe_crypto::random_data_key();
    let wrapping_key = derive_data_key(passphrase, &salt)?;
    let wrap_path = archive_path.with_extension(BACKUP_KEY_FILE_EXT);
    let wrap_file_name = file_name(&wrap_path, "backup wrapped-key path")?;

    let wrap_file = fs::File::create(&wrap_path)?;
    let mut writer = ContainerWriter::create(wrap_file, &wrapping_key)?;
    writer.write_chunk(&data_key)?;
    writer.finish()?;

    let sidecar = serde_json::json!({
        "version": 1,
        "mode": "passphrase_wrapped_data_key",
        "kdf": "argon2id",
        "salt_hex": hex_encode(&salt),
        "wrapped_key_file": wrap_file_name,
    });
    let sidecar_json = serde_json::to_vec_pretty(&sidecar)?;
    fs::write(
        archive_path.with_extension(BACKUP_KEY_META_EXT),
        sidecar_json,
    )?;
    Ok(data_key)
}

fn unwrap_passphrase_backup_key(
    archive_path: &Path,
    passphrase: &str,
) -> Result<DataKey, CommandError> {
    if passphrase.is_empty() {
        return Err(CommandError::msg("backup passphrase must not be empty"));
    }
    let sidecar: BackupKeySidecar =
        serde_json::from_slice(&fs::read(archive_path.with_extension(BACKUP_KEY_META_EXT))?)?;
    if sidecar.version != 1
        || sidecar.mode != "passphrase_wrapped_data_key"
        || sidecar.kdf != "argon2id"
    {
        return Err(CommandError::msg("unsupported backup key sidecar"));
    }
    let salt = hex_decode(&sidecar.salt_hex)?;
    let wrapping_key = derive_data_key(passphrase, &salt)?;
    if sidecar.wrapped_key_file.contains('/') || sidecar.wrapped_key_file.contains('\\') {
        return Err(CommandError::msg(
            "wrapped backup key file must be a file name",
        ));
    }
    let mut reader = ContainerReader::open(
        fs::File::open(archive_path.with_file_name(sidecar.wrapped_key_file))?,
        &wrapping_key,
    )?;
    let bytes = reader
        .read_chunk()?
        .ok_or_else(|| CommandError::msg("wrapped backup key is empty"))?;
    if reader.read_chunk()?.is_some() {
        return Err(CommandError::msg("wrapped backup key has trailing chunks"));
    }
    bytes
        .try_into()
        .map_err(|_| CommandError::msg("wrapped backup key has wrong length"))
}

fn file_name(path: &Path, label: &str) -> Result<String, CommandError> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
        .ok_or_else(|| CommandError::msg(format!("{label} is not UTF-8")))
}

fn hex_decode(value: &str) -> Result<Vec<u8>, CommandError> {
    if value.len() % 2 != 0 {
        return Err(CommandError::msg("hex value has odd length"));
    }
    let mut out = Vec::with_capacity(value.len() / 2);
    for pair in value.as_bytes().chunks(2) {
        let hi = (pair[0] as char)
            .to_digit(16)
            .ok_or_else(|| CommandError::msg("hex value contains invalid digit"))?;
        let lo = (pair[1] as char)
            .to_digit(16)
            .ok_or_else(|| CommandError::msg("hex value contains invalid digit"))?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lethe_crypto::container::ContainerWriter;

    #[test]
    fn passphrase_backup_roundtrip_verifies_chunks() {
        let dir = std::env::temp_dir().join(format!(
            "untrace-backup-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();

        let target = backup_target(&dir, "r1", Some("correct horse")).unwrap();
        let mut writer =
            ContainerWriter::create(fs::File::create(&target.path).unwrap(), &target.key).unwrap();
        writer.write_chunk(br#"{"manifest":true}"#).unwrap();
        writer.finish().unwrap();

        let ok = verify_backup(&dir, "r1", Some("correct horse")).unwrap();
        assert!(ok.ok);
        assert_eq!(ok.chunks, 1);
        assert!(verify_backup(&dir, "r1", Some("wrong horse")).is_err());

        fs::remove_dir_all(dir).ok();
    }
}
