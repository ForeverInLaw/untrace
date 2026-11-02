//! Read models and small edits for the UI. A run holds `AppState::store` until it
//! finishes, so everything here goes through the separate `reader` connection.

use std::collections::HashSet;

use lethe_adapter::ContentType;
use lethe_crypto::receipt::RunSummary;
use lethe_store::{ItemQuery, StoredReceipt};
use serde::Serialize;
use tauri::State;

use crate::backup::{self, BackupSpace};
use crate::session::{self, StoredSession};
use crate::telegram::TelegramState;
use crate::{AppState, CommandError, RunConsent};

const TELEGRAM: &str = "telegram";

#[derive(Serialize)]
pub struct TypeCount {
    content_type: ContentType,
    count: u64,
}

#[derive(Serialize)]
pub struct PreviewSummary {
    pending: u64,
    protected: u64,
    types: Vec<TypeCount>,
    /// Pending items the backup cannot hold in full; they go only with consent.
    backup_gaps: u64,
    /// Pending items other people keep seeing; they go only with consent.
    only_for_self: u64,
    /// How many pending items need both of those agreements.
    consents_overlap: u64,
    /// Items in the set that the platform does not let this account delete.
    undeletable: u64,
}

#[derive(Serialize)]
pub struct PreviewItem {
    platform_id: String,
    content_type: ContentType,
    created_at_secs: Option<i64>,
    text: Option<String>,
    protected: bool,
    only_for_self: bool,
}

#[derive(Serialize)]
pub struct ReceiptView {
    summary: RunSummary,
    public_key_hex: String,
    signature_hex: String,
}

impl TryFrom<StoredReceipt> for ReceiptView {
    type Error = CommandError;

    fn try_from(stored: StoredReceipt) -> Result<Self, CommandError> {
        Ok(Self {
            summary: serde_json::from_str(&stored.summary_json)?,
            public_key_hex: stored.public_key_hex,
            signature_hex: stored.signature_hex,
        })
    }
}

#[tauri::command]
pub async fn preview_summary(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<PreviewSummary, CommandError> {
    let store = state.reader.lock().await;
    let counts = store.preview_counts(&run_id)?;
    let types = store
        .pending_type_counts(&run_id)?
        .into_iter()
        .map(|(content_type, count)| TypeCount {
            content_type,
            count,
        })
        .collect();
    let consents = store.pending_consents(&run_id)?;
    Ok(PreviewSummary {
        pending: counts.pending,
        protected: counts.protected,
        types,
        backup_gaps: consents.backup_gaps,
        only_for_self: consents.only_for_self,
        consents_overlap: consents.both,
        undeletable: counts.undeletable,
    })
}

/// Whether the disk holds the backup of what goes with these agreements.
#[tauri::command]
pub async fn preview_backup_space(
    state: State<'_, AppState>,
    run_id: String,
    consent: RunConsent,
) -> Result<BackupSpace, CommandError> {
    backup_space_for(&state, &run_id, consent).await
}

/// Space for the backup of a previewed run, given what the person agreed to delete.
/// The start of a run checks the same, so the screen and the start never disagree.
pub(crate) async fn backup_space_for(
    state: &AppState,
    run_id: &str,
    consent: RunConsent,
) -> Result<BackupSpace, CommandError> {
    let media = state.reader.lock().await.pending_media(run_id, consent.into())?;
    backup::backup_space(&state.backup_dir, &media)
}

#[tauri::command]
pub async fn preview_items(
    state: State<'_, AppState>,
    run_id: String,
    protected_only: bool,
    content_type: Option<ContentType>,
    offset: u32,
    limit: u32,
) -> Result<Vec<PreviewItem>, CommandError> {
    let store = state.reader.lock().await;
    let rows = store.preview_items(
        &run_id,
        &ItemQuery {
            protected_only,
            content_type,
            offset,
            limit,
        },
    )?;
    Ok(rows
        .into_iter()
        .map(|row| PreviewItem {
            platform_id: row.platform_id,
            content_type: row.content_type,
            created_at_secs: row.created_at_secs,
            text: row.text,
            protected: row.protected,
            only_for_self: row.only_for_self,
        })
        .collect())
}

#[tauri::command]
pub async fn set_item_protected(
    state: State<'_, AppState>,
    run_id: String,
    platform_id: String,
    protected: bool,
) -> Result<bool, CommandError> {
    Ok(state
        .reader
        .lock()
        .await
        .set_item_protected(&run_id, &platform_id, protected)?)
}

#[tauri::command]
pub async fn list_receipts(state: State<'_, AppState>) -> Result<Vec<ReceiptView>, CommandError> {
    let stored = state.reader.lock().await.receipts()?;
    stored.into_iter().map(ReceiptView::try_from).collect()
}

#[tauri::command]
pub async fn get_receipt(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<Option<ReceiptView>, CommandError> {
    let stored = state.reader.lock().await.receipt(&run_id)?;
    stored.map(ReceiptView::try_from).transpose()
}

/// A run that ended without a receipt, for reaching its backup.
#[derive(Debug, Serialize)]
pub struct InterruptedRun {
    run_id: String,
    platform: String,
    account_label: String,
    started_epoch_secs: i64,
    deleted: u64,
    /// How many of `deleted` other people can still see.
    deleted_only_for_self: u64,
}

/// Runs without a receipt that have a backup to open. A run still going is left out.
#[tauri::command]
pub async fn list_interrupted_runs(
    state: State<'_, AppState>,
) -> Result<Vec<InterruptedRun>, CommandError> {
    let running: HashSet<String> = state.controls.lock().await.keys().cloned().collect();
    let runs = state.reader.lock().await.runs_without_receipt()?;
    Ok(runs
        .into_iter()
        .filter(|run| {
            !running.contains(&run.run_id)
                && backup::backup_path(&state.backup_dir, &run.run_id).exists()
        })
        .map(|run| InterruptedRun {
            run_id: run.run_id,
            platform: run.platform,
            account_label: run.account,
            started_epoch_secs: run.started_secs,
            deleted: run.deleted,
            deleted_only_for_self: run.deleted_only_for_self,
        })
        .collect())
}

/// Every account signed in on this device. Telegram keeps its session in TDLib's
/// own folder, so it is asked directly.
#[tauri::command]
pub async fn list_accounts(
    state: State<'_, AppState>,
    telegram: State<'_, TelegramState>,
) -> Result<Vec<StoredSession>, CommandError> {
    let mut accounts = session::list(&state.session_dir)?;
    if let Some(label) = telegram.signed_in_account().await? {
        accounts.push(StoredSession {
            platform: TELEGRAM.into(),
            label,
        });
    }
    Ok(accounts)
}

/// Forgets an account. For Telegram that ends the session itself, which a
/// cleanup still deleting through it would lose.
#[tauri::command]
pub async fn disconnect_account(
    state: State<'_, AppState>,
    telegram: State<'_, TelegramState>,
    platform: String,
    label: String,
) -> Result<(), CommandError> {
    if platform != TELEGRAM {
        return session::remove(&state.session_dir, &platform, &label);
    }
    if !state.controls.lock().await.is_empty() {
        return Err(CommandError::msg(
            "Wait for the cleanup to finish before signing out of Telegram",
        ));
    }
    telegram.log_out().await
}

/// As many rows as a receipt shows; the total covers the rest.
const UNSAVED_FILES_SHOWN: u32 = 50;

#[derive(Serialize)]
pub struct UnsavedItem {
    platform_id: String,
    created_at_secs: Option<i64>,
    text: Option<String>,
    /// `unavailable`: the platform refused the file. `unreachable`: anything else.
    failure: &'static str,
}

#[derive(Serialize)]
pub struct UnsavedFiles {
    total: u64,
    /// How many may go without their file, with the person's consent.
    unavailable: u64,
    items: Vec<UnsavedItem>,
}

/// What stayed in a run because its files could not be saved.
#[tauri::command]
pub async fn list_unsaved_files(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<UnsavedFiles, CommandError> {
    let unsaved = state
        .reader
        .lock()
        .await
        .unsaved_files(&run_id, UNSAVED_FILES_SHOWN)?;
    Ok(UnsavedFiles {
        total: unsaved.total,
        unavailable: unsaved.unavailable,
        items: unsaved
            .items
            .into_iter()
            .map(|item| UnsavedItem {
                platform_id: item.platform_id,
                created_at_secs: item.created_at_secs,
                text: item.text,
                failure: item.failure.as_str(),
            })
            .collect(),
    })
}
