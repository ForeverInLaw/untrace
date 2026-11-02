//! Read models and small edits for the UI. A run holds `AppState::store` until it
//! finishes, so everything here goes through the separate `reader` connection.

use lethe_adapter::ContentType;
use lethe_crypto::receipt::RunSummary;
use lethe_store::{ItemQuery, StoredReceipt};
use serde::Serialize;
use tauri::State;

use crate::backup::{self, BackupSpace};
use crate::session::{self, StoredSession};
use crate::{AppState, CommandError};

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
    backup_space: BackupSpace,
    /// Pending items the backup cannot hold in full; they go only with consent.
    backup_gaps: u64,
}

#[derive(Serialize)]
pub struct PreviewItem {
    platform_id: String,
    content_type: ContentType,
    created_at_secs: Option<i64>,
    text: Option<String>,
    protected: bool,
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
    let backup_space = backup::backup_space(&state.backup_dir, &store.pending_media(&run_id)?)?;
    Ok(PreviewSummary {
        pending: counts.pending,
        protected: counts.protected,
        types,
        backup_space,
        backup_gaps: store.pending_backup_gaps(&run_id)?,
    })
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

#[tauri::command]
pub async fn list_accounts(state: State<'_, AppState>) -> Result<Vec<StoredSession>, CommandError> {
    session::list(&state.session_dir)
}

#[tauri::command]
pub async fn disconnect_account(
    state: State<'_, AppState>,
    platform: String,
    label: String,
) -> Result<(), CommandError> {
    session::remove(&state.session_dir, &platform, &label)
}
