use std::fs;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};

use lethe_core::archive::{audit_archive, ArchiveExport};
use lethe_core::pipeline::BackupTarget;
use lethe_core::EngineError;
use lethe_crypto::container::{derive_data_key, ContainerReader, ContainerWriter};
use lethe_crypto::{CryptoError, DataKey};
use lethe_store::PendingMedia;
use serde::{Deserialize, Serialize};

use crate::secrets::{hex_encode, keychain_data_key, BACKUP_KEY_USER};
use crate::{CommandError, ErrorKind};

const BACKUP_KEY_FILE_EXT: &str = "key.bin";
const BACKUP_KEY_META_EXT: &str = "key.json";

#[derive(Debug, Serialize)]
pub struct BackupVerification {
    pub ok: bool,
    pub items: u64,
    pub media_files: u64,
    /// False when the backup breaks off before it was sealed. What it holds up to
    /// there is intact and counted.
    pub complete: bool,
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

/// How an export ended.
#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ExportOutcome {
    /// The person closed the folder choice, so nothing was written.
    NoFolder,
    Exported(BackupExport),
    /// The person stopped it, and the folder it had begun is gone.
    Stopped,
}

/// How much of the backup file an export has read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ExportProgress {
    pub done_bytes: u64,
    pub total_bytes: u64,
}

/// An export tells its progress about once per this many bytes, and at the end.
const PROGRESS_STEP: u64 = 1024 * 1024;

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

/// Refuses a run that already has a backup before it writes any key, because a new
/// passphrase key would replace the one that backup needs.
pub fn backup_target(
    base_dir: &Path,
    run_id: &str,
    backup_passphrase: Option<&str>,
) -> Result<BackupTarget, CommandError> {
    let path = backup_path(base_dir, run_id);
    if path.try_exists()? {
        return Err(CommandError::msg("this run already has a backup"));
    }
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
        complete: audit.complete,
    })
}

/// Empties the folders where a file waits, unencrypted, until the backup has it.
/// Anything there on startup was left by a run that died first, and no run can be
/// using it yet.
/// Every folder is tried, so one that fails does not leave the others full; the
/// first failure is returned.
pub fn empty_download_dirs(dirs: &[PathBuf]) -> std::io::Result<()> {
    let mut first_error = None;
    for dir in dirs {
        let emptied = match fs::remove_dir_all(dir) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => fs::create_dir_all(dir),
        };
        if let Err(error) = emptied {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Exports a backup into a new folder under the one `pick_folder` returns. The key
/// is checked first, so a wrong passphrase never gets as far as asking where to
/// export. `report` hears how far the export is: before the folder is asked for,
/// about once per `PROGRESS_STEP`, and once the whole backup is read. `stopped`
/// is asked after every record and every chunk of a file.
pub fn export_backup(
    base_dir: &Path,
    run_id: &str,
    backup_passphrase: Option<&str>,
    pick_folder: impl FnOnce() -> Result<Option<PathBuf>, CommandError>,
    mut report: impl FnMut(ExportProgress),
    stopped: impl Fn() -> bool,
) -> Result<ExportOutcome, CommandError> {
    let (file, key) = open_backup(base_dir, run_id, backup_passphrase)?;
    let total_bytes = file.metadata()?.len();
    let archive = ArchiveExport::open(file, &key)?;
    report(ExportProgress { done_bytes: 0, total_bytes });
    if stopped() {
        return Ok(ExportOutcome::Stopped);
    }
    let Some(parent) = pick_folder()? else {
        return Ok(ExportOutcome::NoFolder);
    };
    let mut told = 0;
    let written = archive.write_to(&parent, &format!("untrace-export-{run_id}"), |done_bytes| {
        if done_bytes >= told + PROGRESS_STEP || done_bytes == total_bytes {
            told = done_bytes;
            report(ExportProgress { done_bytes, total_bytes });
        }
        if stopped() {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    });
    let report = match written {
        Err(EngineError::Aborted) => return Ok(ExportOutcome::Stopped),
        written => written?,
    };
    Ok(ExportOutcome::Exported(BackupExport {
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
    // The key wrapped with another passphrase does not open at all.
    let wrong_passphrase = |error: CryptoError| match error {
        CryptoError::Open => CommandError::new(ErrorKind::WrongPassphrase, error.to_string()),
        other => other.into(),
    };
    let mut reader = ContainerReader::open(
        fs::File::open(archive_path.with_file_name(sidecar.wrapped_key_file))?,
        &wrapping_key,
    )
    .map_err(wrong_passphrase)?;
    let bytes = reader
        .read_chunk()
        .map_err(wrong_passphrase)?
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

    fn ignore(_: ExportProgress) {}

    fn keep_going() -> bool {
        false
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

        let ExportOutcome::Exported(done) =
            export_backup(&dir, "r1", Some("correct horse"), || Ok(Some(chosen.clone())), ignore, keep_going)
                .unwrap()
        else {
            panic!("the export did not finish");
        };

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

        let result = export_backup(
            &dir,
            "r1",
            Some("wrong horse"),
            || -> Result<_, CommandError> { panic!("asked for a folder with a wrong passphrase") },
            ignore,
            keep_going,
        );

        assert_eq!(result.err().map(|error| error.kind), Some(ErrorKind::WrongPassphrase));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn cancelling_the_folder_choice_writes_nothing() {
        let dir = test_dir("export-cancel");
        write_backup(&dir, "correct horse");
        let before = fs::read_dir(&dir).unwrap().count();

        let done = export_backup(&dir, "r1", Some("correct horse"), || Ok(None), ignore, keep_going).unwrap();

        assert!(matches!(done, ExportOutcome::NoFolder));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), before);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn export_tells_how_far_it_is_through_the_backup() {
        let dir = test_dir("export-progress");
        let chosen = dir.join("chosen");
        fs::create_dir(&chosen).unwrap();
        write_backup(&dir, "correct horse");
        let size = fs::metadata(backup_path(&dir, "r1")).unwrap().len();
        let mut told = Vec::new();

        export_backup(
            &dir,
            "r1",
            Some("correct horse"),
            || Ok(Some(chosen.clone())),
            |progress| told.push(progress),
            keep_going,
        )
        .unwrap();

        let at = |done_bytes| ExportProgress { done_bytes, total_bytes: size };
        assert_eq!(told.first(), Some(&at(0)));
        assert_eq!(told.last(), Some(&at(size)));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn an_export_stopped_once_it_has_begun_leaves_nothing_in_the_chosen_folder() {
        let dir = test_dir("export-stop");
        let chosen = dir.join("chosen");
        fs::create_dir(&chosen).unwrap();
        write_backup(&dir, "correct horse");

        let picked = std::cell::Cell::new(false);

        let done = export_backup(
            &dir,
            "r1",
            Some("correct horse"),
            || {
                picked.set(true);
                Ok(Some(chosen.clone()))
            },
            ignore,
            || picked.get(),
        )
        .unwrap();

        assert!(matches!(done, ExportOutcome::Stopped));
        assert_eq!(fs::read_dir(&chosen).unwrap().count(), 0);
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
        assert!(ok.complete);
        assert_eq!(ok.items, 1);
        assert_eq!(ok.media_files, 1);
        assert!(verify_backup(&dir, "r1", Some("wrong horse")).is_err());

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_run_with_a_backup_already_cannot_replace_its_key() {
        let dir = test_dir("backup-again");
        write_backup(&dir, "correct horse");

        let refused = backup_target(&dir, "r1", Some("other horse")).err().unwrap();
        assert_eq!(refused.message(), "this run already has a backup");
        assert!(verify_backup(&dir, "r1", Some("correct horse")).unwrap().complete);

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_backup_that_breaks_off_verifies_as_incomplete_with_what_it_holds() {
        let dir = test_dir("backup");
        let target = backup_target(&dir, "r1", Some("correct horse")).unwrap();
        let mut writer =
            ContainerWriter::create(fs::File::create(&target.path).unwrap(), &target.key).unwrap();
        writer.write_chunk(br#"{"manifest":true}"#).unwrap();
        writer.write_chunk(br#"{"media":[{"archived_bytes":3,"chunks":1}]}"#).unwrap();
        writer.write_chunk(b"abc").unwrap();
        writer.write_chunk(br#"{"media":[{"archived_bytes":3,"chunks":1}]}"#).unwrap();
        drop(writer);

        let verified = verify_backup(&dir, "r1", Some("correct horse")).unwrap();
        assert!(verified.ok);
        assert!(!verified.complete);
        assert_eq!(verified.items, 1);
        assert_eq!(verified.media_files, 1);

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn emptying_download_dirs_removes_files_left_waiting_for_a_backup() {
        let dir = test_dir("downloads");
        let downloads = dir.join("downloads");
        let tdlib_files = dir.join("files");
        fs::create_dir_all(tdlib_files.join("photos")).unwrap();
        fs::write(tdlib_files.join("photos").join("1.jpg"), b"plain").unwrap();

        empty_download_dirs(&[downloads.clone(), tdlib_files.clone()]).unwrap();

        assert_eq!(fs::read_dir(&downloads).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&tdlib_files).unwrap().count(), 0);

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_folder_that_cannot_be_emptied_does_not_spare_the_next_one() {
        let dir = test_dir("downloads");
        let not_a_folder = dir.join("downloads");
        fs::write(&not_a_folder, b"").unwrap();
        let tdlib_files = dir.join("files");
        fs::create_dir_all(&tdlib_files).unwrap();
        fs::write(tdlib_files.join("1.jpg"), b"plain").unwrap();

        assert!(empty_download_dirs(&[not_a_folder, tdlib_files.clone()]).is_err());
        assert_eq!(fs::read_dir(&tdlib_files).unwrap().count(), 0);

        fs::remove_dir_all(dir).ok();
    }
}
