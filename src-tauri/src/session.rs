use std::{
    fs,
    path::{Path, PathBuf},
};

use lethe_crypto::container::{ContainerReader, ContainerWriter};

use crate::secrets::{hex_encode, keychain_data_key, SESSION_KEY_USER};
use crate::CommandError;

pub fn save(
    session_dir: &Path,
    platform: &str,
    account_label: &str,
    blob: &str,
) -> Result<(), CommandError> {
    fs::create_dir_all(session_dir)?;
    let key = session_data_key()?;
    let file = fs::File::create(session_path(session_dir, platform, account_label))?;
    let mut writer = ContainerWriter::create(file, &key)?;
    writer.write_chunk(blob.as_bytes())?;
    writer.finish()?;
    Ok(())
}

pub fn load(
    session_dir: &Path,
    platform: &str,
    account_label: &str,
) -> Result<String, CommandError> {
    let key = session_data_key()?;
    let path = session_path(session_dir, platform, account_label);
    let file = fs::File::open(&path)
        .map_err(|e| CommandError::msg(format!("no stored session for {account_label}: {e}")))?;
    let mut reader = ContainerReader::open(file, &key)?;
    let bytes = reader
        .read_chunk()?
        .ok_or_else(|| CommandError::msg("stored session is empty"))?;
    if reader.read_chunk()?.is_some() {
        return Err(CommandError::msg("stored session has trailing chunks"));
    }
    String::from_utf8(bytes)
        .map_err(|e| CommandError::msg(format!("stored session is not UTF-8: {e}")))
}

fn session_data_key() -> Result<lethe_crypto::DataKey, CommandError> {
    keychain_data_key(SESSION_KEY_USER, "session key")
}

fn session_path(session_dir: &Path, platform: &str, account_label: &str) -> PathBuf {
    let name = hex_encode(format!("{platform}:{account_label}").as_bytes());
    session_dir.join(format!("{name}.bin"))
}

#[cfg(test)]
mod tests {
    use super::session_path;
    use std::path::Path;

    #[test]
    fn session_file_name_is_path_safe() {
        let path = session_path(Path::new("sessions"), "bluesky", "a/b\\c.bsky.social");
        assert_eq!(path.parent(), Some(Path::new("sessions")));
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with(".bin"));
    }
}
