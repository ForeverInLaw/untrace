use std::fs;
use std::path::{Path, PathBuf};

use lethe_core::archive::{audit_archive, ArchiveExport};
use lethe_core::pipeline::BackupTarget;
use lethe_crypto::container::{derive_data_key, ContainerReader, ContainerWriter};
use lethe_crypto::DataKey;
use lethe_store::PendingMedia;
use serde::{Deserialize, Serialize};

use crate::secrets::{hex_encode, keychain_data_key, BACKUP_KEY_USER};
use crate::CommandError;

const BACKUP_KEY_FILE_EXT: &str = "key.bin";
const BACKUP_KEY_META_EXT: &str = "key.json";

#[derive(Debug, Serialize)]
pub struct BackupVerification {
    pub ok: bool,
    pub items: u64,
    pub media_files: u64,
}

/// What an export left in the folder the person chose.
#[derive(Debug, Serialize)]
pub struct BackupExport {
    pub folder: String,
    pub items: u64,
    pub media_files: u64,
    pub complete: bool,
    pub partial_file: Option<String>,
}

/// Whether the disk can hold a run's backup, in bytes.
#[derive(Debug, Serialize)]
pub struct BackupSpace {
    pub media: u64,
    pub needed: u64,
    pub available: u64,
    pub fits: bool,
}

impl BackupSpace {
    /// The archive grows to the size of all files, and the file being downloaded
    /// sits next to it in plaintext until it is archived.
    fn new(media: &PendingMedia, available: u64) -> Self {
        let needed = media.bytes + media.largest_bytes;
        Self {
            media: media.bytes,
            needed,
            available,
            fits: needed <= available,
        }
    }
}

#[derive(Debug, Deserialize)]
struct BackupKeySidecar {
    version: u8,
    mode: String,
    kdf: String,
    salt_hex: String,
    wrapped_key_file: String,
}

pub fn backup_space(base_dir: &Path, media: &PendingMedia) -> Result<BackupSpace, CommandError> {
    Ok(BackupSpace::new(media, fs4::available_space(base_dir)?))
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
    let (file, key) = open_backup(base_dir, run_id, backup_passphrase)?;
    let audit = audit_archive(file, &key)?;
    Ok(BackupVerification {
        ok: true,
        items: audit.items,
        media_files: audit.media_files,
    })
}

/// Exports a backup into a new folder under the one `pick_folder` returns. The key
/// is checked first, so a wrong passphrase never gets as far as asking where to
/// export. `None` means the person cancelled the choice.
pub fn export_backup(
    base_dir: &Path,
    run_id: &str,
    backup_passphrase: Option<&str>,
    pick_folder: impl FnOnce() -> Result<Option<PathBuf>, CommandError>,
) -> Result<Option<BackupExport>, CommandError> {
    let (file, key) = open_backup(base_dir, run_id, backup_passphrase)?;
    let archive = ArchiveExport::open(file, &key)?;
    let Some(parent) = pick_folder()? else {
        return Ok(None);
    };
    let report = archive.write_to(&parent, &format!("untrace-export-{run_id}"))?;
    Ok(Some(BackupExport {
        folder: report.folder.to_string_lossy().into_owned(),
        items: report.items,
        media_files: report.media_files,
        complete: report.complete,
        partial_file: report.partial_file,
    }))
}

fn open_backup(
    base_dir: &Path,
    run_id: &str,
    backup_passphrase: Option<&str>,
) -> Result<(fs::File, DataKey), CommandError> {
    let path = backup_path(base_dir, run_id);
    let key = match backup_passphrase.filter(|passphrase| !passphrase.is_empty()) {
        Some(passphrase) => unwrap_passphrase_backup_key(&path, passphrase)?,
        None => backup_data_key()?,
    };
    let file = fs::File::open(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CommandError::msg("backup archive not found; start the run first")
        } else {
            e.into()
        }
    })?;
    Ok((file, key))
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
    fn needed_space_covers_the_archive_and_the_file_being_downloaded() {
        let media = PendingMedia {
            bytes: 1_000,
            largest_bytes: 700,
        };

        assert!(BackupSpace::new(&media, 1_700).fits);
        assert!(!BackupSpace::new(&media, 1_699).fits);
    }

    fn test_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "untrace-{label}-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A sealed backup with one item and one file.
    fn write_backup(dir: &Path, passphrase: &str) {
        let target = backup_target(dir, "r1", Some(passphrase)).unwrap();
        let mut writer =
            ContainerWriter::create(fs::File::create(&target.path).unwrap(), &target.key).unwrap();
        writer.write_chunk(br#"{"run_id":"r1"}"#).unwrap();
        writer
            .write_chunk(
                br#"{"platform_id":"1","text":"hi","media":[{"url":"u","file_name":"a.txt","archived_bytes":3,"chunks":1}]}"#,
            )
            .unwrap();
        writer.write_chunk(b"abc").unwrap();
        writer.finish().unwrap();
    }

    #[test]
    fn export_writes_a_folder_where_the_person_chose() {
        let dir = test_dir("export");
        let chosen = dir.join("chosen");
        fs::create_dir(&chosen).unwrap();
        write_backup(&dir, "correct horse");

        let done = export_backup(&dir, "r1", Some("correct horse"), || Ok(Some(chosen.clone())))
            .unwrap()
            .unwrap();

        assert_eq!(done.items, 1);
        assert_eq!(done.media_files, 1);
        assert!(done.complete);
        let folder = chosen.join("untrace-export-r1");
        assert_eq!(done.folder, folder.to_string_lossy());
        assert_eq!(fs::read(folder.join("files/a.txt")).unwrap(), b"abc");

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_wrong_passphrase_fails_before_the_person_picks_a_folder() {
        let dir = test_dir("export-wrong");
        write_backup(&dir, "correct horse");

        let result = export_backup(&dir, "r1", Some("wrong horse"), || -> Result<_, CommandError> {
            panic!("asked for a folder with a wrong passphrase")
        });

        assert!(result.is_err());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn cancelling_the_folder_choice_writes_nothing() {
        let dir = test_dir("export-cancel");
        write_backup(&dir, "correct horse");
        let before = fs::read_dir(&dir).unwrap().count();

        let done = export_backup(&dir, "r1", Some("correct horse"), || Ok(None)).unwrap();

        assert!(done.is_none());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), before);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn passphrase_backup_roundtrip_verifies_items() {
        let dir = test_dir("backup");

        let target = backup_target(&dir, "r1", Some("correct horse")).unwrap();
        let mut writer =
            ContainerWriter::create(fs::File::create(&target.path).unwrap(), &target.key).unwrap();
        writer.write_chunk(br#"{"manifest":true}"#).unwrap();
        writer
            .write_chunk(br#"{"media":[{"archived_bytes":3,"chunks":1}]}"#)
            .unwrap();
        writer.write_chunk(b"abc").unwrap();
        writer.finish().unwrap();

        let ok = verify_backup(&dir, "r1", Some("correct horse")).unwrap();
        assert!(ok.ok);
        assert_eq!(ok.items, 1);
        assert_eq!(ok.media_files, 1);
        assert!(verify_backup(&dir, "r1", Some("wrong horse")).is_err());

        fs::remove_dir_all(dir).ok();
    }
}
