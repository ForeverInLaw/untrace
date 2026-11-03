//! Read models and small edits for the UI. A run holds `AppState::store` until it
//! finishes, so everything here goes through the separate `reader` connection.

use std::collections::HashSet;

use lethe_adapter::ContentType;
use lethe_crypto::receipt::RunSummary;
use lethe_store::{ChoiceCounts, ItemFilter, ItemGroup, ItemQuery, ScopeCount, ScopeOutcome, StoredReceipt, UnsavedCursor, UnsavedFiles};
use serde::{Deserialize, Serialize};
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
    /// What the item is when its content type is too coarse: `photo`, `poll`, `chat_join`.
    subtype: Option<String>,
    created_at_secs: Option<i64>,
    text: Option<String>,
    file_name: Option<String>,
    file_size: Option<u64>,
    /// `pending`, `protected` or `undeletable`.
    state: &'static str,
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

/// The chats a previewed run would delete from with these agreements.
#[tauri::command]
pub async fn preview_scopes(
    state: State<'_, AppState>,
    run_id: String,
    consent: RunConsent,
) -> Result<Vec<ScopeCount>, CommandError> {
    Ok(state.reader.lock().await.pending_scopes(&run_id, consent.into())?)
}

/// What a run that ended since the app started did per chat; empty for any other.
#[tauri::command]
pub async fn run_scope_results(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<Vec<ScopeOutcome>, CommandError> {
    Ok(state.scope_results.lock().await.get(&run_id).cloned().unwrap_or_default())
}

/// The preview rows a list or a bulk choice covers, as the interface sends them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFilter {
    group: ItemGroup,
    content_type: Option<ContentType>,
    /// Text the rows must contain; blank covers them all.
    search: String,
    /// Subtypes whose wording, in the interface language, holds the search.
    matching_subtypes: Vec<String>,
}

impl PreviewFilter {
    /// Runs `use_filter` with the store's form of this filter.
    fn apply<T>(&self, use_filter: impl FnOnce(&ItemFilter) -> T) -> T {
        let matching_subtypes: Vec<&str> = self.matching_subtypes.iter().map(String::as_str).collect();
        use_filter(&ItemFilter {
            group: self.group,
            content_type: self.content_type,
            search: &self.search,
            matching_subtypes: &matching_subtypes,
        })
    }
}

#[tauri::command]
pub async fn preview_items(
    state: State<'_, AppState>,
    run_id: String,
    filter: PreviewFilter,
    offset: u32,
    limit: u32,
) -> Result<Vec<PreviewItem>, CommandError> {
    let store = state.reader.lock().await;
    let rows = filter.apply(|&filter| store.preview_items(&run_id, &ItemQuery { filter, offset, limit }))?;
    Ok(rows
        .into_iter()
        .map(|row| PreviewItem {
            platform_id: row.platform_id,
            content_type: row.content_type,
            subtype: row.subtype,
            created_at_secs: row.created_at_secs,
            text: row.text,
            file_name: row.file_name,
            file_size: row.file_size,
            state: row.state.as_str(),
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

/// Keeps, or lets go again, every row the filter covers. Returns how many changed.
#[tauri::command]
pub async fn set_items_protected(
    state: State<'_, AppState>,
    run_id: String,
    filter: PreviewFilter,
    protected: bool,
) -> Result<u64, CommandError> {
    let store = state.reader.lock().await;
    Ok(filter.apply(|filter| store.set_items_protected(&run_id, filter, protected))?)
}

/// How the rows the filter covers stand, for the checkbox over all of them.
#[tauri::command]
pub async fn preview_choice(
    state: State<'_, AppState>,
    run_id: String,
    filter: PreviewFilter,
) -> Result<ChoiceCounts, CommandError> {
    let store = state.reader.lock().await;
    Ok(filter.apply(|filter| store.choice_counts(&run_id, filter))?)
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
    // Held through the sign-out, so no cleanup can start on a session that is ending.
    let controls = state.controls.lock().await;
    if !controls.is_empty() {
        return Err(CommandError::another_run_is_live());
    }
    telegram.log_out().await
}

#[derive(Serialize)]
pub struct UnsavedItem {
    platform_id: String,
    subtype: Option<String>,
    created_at_secs: Option<i64>,
    text: Option<String>,
    /// `unavailable`: the platform refused the file. `unreachable`: anything else.
    failure: &'static str,
}

/// How much stayed in a run because its files could not be saved.
#[tauri::command]
pub async fn unsaved_files(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<UnsavedFiles, CommandError> {
    Ok(state.reader.lock().await.unsaved_files(&run_id)?)
}

/// One page of what stayed in a run because its files could not be saved.
#[tauri::command]
pub async fn unsaved_items(
    state: State<'_, AppState>,
    run_id: String,
    after: Option<UnsavedCursor>,
    limit: u32,
) -> Result<Vec<UnsavedItem>, CommandError> {
    let items = state.reader.lock().await.unsaved_items(&run_id, after.as_ref(), limit)?;
    Ok(items
        .into_iter()
        .map(|item| UnsavedItem {
            platform_id: item.platform_id,
            subtype: item.subtype,
            created_at_secs: item.created_at_secs,
            text: item.text,
            failure: item.failure.as_str(),
        })
        .collect())
}
