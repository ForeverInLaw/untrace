//! Untrace Tauri shell. The core owns the run; these commands start/observe it.
//! Live progress flows over a Tauri `Channel<RunEvent>`: the engine's own events,
//! then how the run ended if it did not finish. Run state lives in the core + SQLite, so a
//! run survives UI navigation.
//!
//! Concurrency note: the run-state `Store` wraps a rusqlite `Connection`, which
//! is `Send` but `!Sync`. The engine borrows the store across `.await` points
//! (it interleaves network calls with checkpoint writes), so a run future is
//! `!Send` and cannot live on Tauri's multi-thread runtime. Each store-touching
//! job therefore runs on a dedicated OS thread with a current-thread runtime
//! (`run_offthread`); the future is built inside that thread and never crosses a
//! thread boundary, so it is never required to be `Send`.

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use lethe_adapter::{AuthProvider, Consent, Credential, PlatformAdapter, SecretBlob};
use lethe_bluesky::{BlueskyAdapter, BlueskyAuth};
use lethe_core::filter::FilterSpec;
use lethe_core::pipeline::{self, RunRequest};
use lethe_core::scheduler::Scheduler;
use lethe_core::{ProgressEvent, RunControl};
use lethe_store::{Consents, NewRun, ScopeOutcome, Store};
use serde::{Deserialize, Serialize};
use tauri_plugin_dialog::DialogExt;
use tauri::ipc::Channel;
use tauri::{async_runtime, Manager, State};
use tokio::sync::Mutex;

pub use error::{CommandError, ErrorKind};

mod backup;
mod error;
mod platform_registry;
mod run_filters;
mod run_reads;
mod secrets;
mod session;
mod telegram;

const STORE_FILE: &str = "untrace.db";
const BACKUP_DIR: &str = "backups";
const SESSION_DIR: &str = "sessions";
const TELEGRAM_DIR: &str = "telegram";
/// Where a Bluesky file waits, unencrypted, until the backup has it.
const DOWNLOADS_DIR: &str = "downloads";

pub struct AppState {
    pub egress: Arc<lethe_net::Egress>,
    pub store: Arc<Mutex<Store>>,
    /// Separate connection for UI reads: a run holds `store` until it finishes.
    pub reader: Arc<Mutex<Store>>,
    pub controls: Arc<Mutex<HashMap<String, RunControl>>>,
    /// Exports under way, by run, with the flag that stops each.
    pub exports: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub pending: Arc<Mutex<HashMap<String, PendingRun>>>,
    /// What each finished run did per chat, until the app closes. Kept nowhere
    /// else: the receipt names no chat, and the store forgets the run's items.
    pub scope_results: Arc<Mutex<HashMap<String, Vec<ScopeOutcome>>>>,
    pub pds_host: String,
    pub backup_dir: PathBuf,
    pub session_dir: PathBuf,
    pub downloads_dir: PathBuf,
}

#[derive(Clone)]
pub struct PendingRun {
    platform: String,
    account_id: String,
    account_label: String,
    filter: FilterSpec,
}

/// What a run tells the interface over its channel.
#[derive(Serialize)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
pub enum RunEvent {
    /// The run stopped before its receipt; sent last.
    Error(CommandError),
    #[serde(untagged)]
    Progress(ProgressEvent),
}

#[derive(Debug, Deserialize)]
pub struct BuildRunRequest {
    pub platform: String,
    pub account_id: String,
    pub account_label: String,
    #[serde(default)]
    pub filter: run_filters::FilterRequest,
}

/// What the person agrees to delete with a run, beyond what goes without asking.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConsent {
    allow_incomplete_backup: bool,
    allow_lost_files: bool,
    allow_only_for_self: bool,
}

/// The agreements that decide which waiting rows go with the run.
impl From<RunConsent> for Consents {
    fn from(consent: RunConsent) -> Self {
        Self {
            backup_gaps: consent.allow_incomplete_backup,
            only_for_self: consent.allow_only_for_self,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct DryRunResult {
    pub run_id: String,
    pub pending: u64,
    pub protected: u64,
}

struct FormConsent {
    identifier: String,
    app_password: String,
}

#[async_trait::async_trait]
impl Consent for FormConsent {
    async fn confirm(&self, _prompt: &str) -> bool {
        true
    }
    async fn input(&self, _prompt: &str, secret: bool) -> Option<String> {
        // BlueskyAuth asks for the handle (secret=false) then the app-password
        // (secret=true), in that order.
        Some(if secret {
            self.app_password.clone()
        } else {
            self.identifier.clone()
        })
    }
}

/// Run a store-touching async job on a dedicated OS thread with a current-thread
/// runtime. The future is built by `make` *inside* the thread, so it never has
/// to be `Send` (it holds the `!Sync` rusqlite `Connection` across `.await`).
/// Returns a receiver for the job's result; drop it to fire-and-forget.
fn run_offthread<C, F, T>(make: C) -> tokio::sync::oneshot::Receiver<T>
where
    C: FnOnce() -> F + Send + 'static,
    F: Future<Output = T>,
    T: Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("run-thread runtime");
        let _ = tx.send(rt.block_on(make()));
    });
    rx
}

/// Load the stored credential and return an authenticated adapter ready for the
/// pipeline. Concrete until after `authenticate` (an inherent method), then
/// coerced to the trait object the pipeline consumes.
async fn authed_adapter(
    state: &AppState,
    platform: &str,
    account_label: &str,
) -> Result<Arc<dyn PlatformAdapter>, CommandError> {
    if platform != "bluesky" {
        return Err(CommandError::msg(format!(
            "unsupported platform: {platform}"
        )));
    }
    let blob = session::load(&state.session_dir, platform, account_label)?;
    let cred = Credential {
        account_label: account_label.to_owned(),
        secret: SecretBlob(blob),
    };
    let mut adapter = BlueskyAdapter::new(state.egress.clone(), &state.pds_host)
        .download_to(state.downloads_dir.clone());
    adapter.authenticate(&cred).await?;
    Ok(Arc::new(adapter))
}

fn open_app_store<R: tauri::Runtime>(
    app: &tauri::App<R>,
) -> Result<Store, Box<dyn std::error::Error>> {
    let store_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&store_dir)?;
    let store_path = store_dir.join(STORE_FILE);
    let key = secrets::store_key_passphrase()
        .map_err(|e| io::Error::other(e.message().to_owned()))?;
    let path = store_path
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "store path is not UTF-8"))?;
    Ok(Store::open(path, &key)?)
}

#[tauri::command]
fn platforms(state: State<'_, AppState>) -> Vec<platform_registry::PlatformSummary> {
    platform_registry::all(&state.pds_host)
}

#[tauri::command]
async fn connect_account(
    state: State<'_, AppState>,
    platform: String,
    identifier: String,
    app_password: String,
) -> Result<String, CommandError> {
    if platform != "bluesky" {
        return Err(CommandError::msg(format!(
            "unsupported platform: {platform}"
        )));
    }
    let auth = BlueskyAuth::new(state.egress.clone());
    let consent = FormConsent {
        identifier,
        app_password,
    };
    let cred = auth.connect(&consent).await.map_err(CommandError::sign_in)?;

    session::save(
        &state.session_dir,
        &platform,
        &cred.account_label,
        &cred.secret.0,
    )?;
    Ok(cred.account_label)
}

#[tauri::command]
async fn dry_run(
    state: State<'_, AppState>,
    req: BuildRunRequest,
) -> Result<DryRunResult, CommandError> {
    let filter = run_filters::to_filter_spec(&req.filter)?;
    let filter_json = serde_json::to_string(&req.filter)?;
    let plan = run_filters::plan_from_filter(&filter);
    let adapter = authed_adapter(&state, &req.platform, &req.account_label).await?;
    let run_id = format!("{}-{}", req.platform, now_secs());

    let run_req = RunRequest {
        run_id: run_id.clone(),
        platform: req.platform.clone(),
        account_id: req.account_id.clone(),
        account_label: req.account_label.clone(),
        plan,
        filter: filter.clone(),
        allow_incomplete_backup: false,
        allow_lost_files: false,
        allow_only_for_self: false,
    };

    let store = state.store.clone();
    let counts = run_offthread(move || async move {
        let store = store.lock().await;
        store.create_run(&NewRun {
            run_id: run_req.run_id.clone(),
            platform: run_req.platform.clone(),
            account: run_req.account_label.clone(),
            filter_json,
            started_secs: now_secs() as i64,
        })?;
        // Drained sink: dry-run has no live channel; the counts are the result.
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<ProgressEvent>();
        let counts = pipeline::snapshot(adapter, &store, &run_req, &tx).await?;
        Ok::<_, CommandError>(counts)
    })
    .await
    .map_err(|_| CommandError::msg("dry-run thread ended unexpectedly"))??;

    state.pending.lock().await.insert(
        run_id.clone(),
        PendingRun {
            platform: req.platform,
            account_id: req.account_id,
            account_label: req.account_label,
            filter,
        },
    );

    Ok(DryRunResult {
        run_id,
        pending: counts.pending,
        protected: counts.protected,
    })
}

/// Phase 2: execute the previewed run on a background thread, streaming progress
/// over the channel. Backup-on-by-default; receipt signed + stored at the end.
#[tauri::command]
async fn start_run(
    state: State<'_, AppState>,
    run_id: String,
    backup_passphrase: Option<String>,
    consent: RunConsent,
    on_event: Channel<RunEvent>,
) -> Result<(), CommandError> {
    let pending = state
        .pending
        .lock()
        .await
        .get(&run_id)
        .cloned()
        .ok_or_else(|| {
            CommandError::msg(format!("no previewed run {run_id}; call dry_run first"))
        })?;

    // Authenticate up front so any failure surfaces synchronously to the caller —
    // never start deleting a run we cannot back up or receipt.
    let adapter = authed_adapter(&state, &pending.platform, &pending.account_label).await?;

    execute_previewed_run(
        &state,
        adapter,
        run_id,
        pending,
        backup_passphrase,
        consent,
        on_event,
    )
    .await
}

/// Opens a follow-up run for what stayed in `run_id` because its files could not be
/// saved. It starts through the same command as any previewed run.
#[tauri::command]
async fn retry_unsaved_files(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<DryRunResult, CommandError> {
    if !state.controls.lock().await.is_empty() {
        return Err(CommandError::another_run_is_live());
    }
    let retry_id = format!("retry-{}", now_secs());
    let retry = state
        .reader
        .lock()
        .await
        .retry_unsaved_files(&run_id, &retry_id, now_secs() as i64)?;
    state.pending.lock().await.insert(
        retry_id.clone(),
        PendingRun {
            platform: retry.platform,
            account_id: retry.account.clone(),
            account_label: retry.account,
            filter: run_filters::to_filter_spec(&Default::default())?,
        },
    );
    Ok(DryRunResult {
        run_id: retry_id,
        pending: retry.items,
        protected: 0,
    })
}

/// Drops a follow-up run that could not start.
#[tauri::command]
async fn discard_retry(state: State<'_, AppState>, run_id: String) -> Result<(), CommandError> {
    state.pending.lock().await.remove(&run_id);
    state.reader.lock().await.discard_retry(&run_id)?;
    Ok(())
}

/// One run at a time: a second one would wait on the store while its progress
/// overwrites what the screen shows for the first.
fn claim_run_slot(
    controls: &mut HashMap<String, RunControl>,
    run_id: &str,
    control: RunControl,
) -> Result<(), CommandError> {
    if !controls.is_empty() {
        return Err(CommandError::another_run_is_live());
    }
    controls.insert(run_id.to_owned(), control);
    Ok(())
}

/// Phase-2 machinery shared by every platform's start command: wire backup +
/// receipt + controls and fire the run on its own thread. The authed adapter is
/// the only platform-specific input, so a new platform's start command just
/// builds its adapter and calls this.
pub(crate) async fn execute_previewed_run(
    state: &AppState,
    adapter: Arc<dyn PlatformAdapter>,
    run_id: String,
    pending: PendingRun,
    backup_passphrase: Option<String>,
    consent: RunConsent,
    on_event: Channel<RunEvent>,
) -> Result<(), CommandError> {
    // Claimed first, so a second start of a live run is refused before it writes a
    // key over the one the running backup needs. Given back if the run cannot start.
    let control = RunControl::new();
    claim_run_slot(&mut *state.controls.lock().await, &run_id, control.clone())?;
    let prepared = async {
        // Checked before the backup target, which writes key files for the run.
        if !run_reads::backup_space_for(state, &run_id, consent).await?.fits {
            return Err(CommandError::new(ErrorKind::NoDiskSpace, "not enough free disk space for the backup"));
        }
        // Load keys/backup target up front: never start deleting what we cannot seal.
        let signer = secrets::receipt_signer()?;
        let backup = backup::backup_target(
            &state.backup_dir,
            &run_id,
            backup_passphrase
                .as_deref()
                .filter(|passphrase| !passphrase.is_empty()),
        )?;
        let started = now_secs();
        state
            .reader
            .lock()
            .await
            .set_run_started(&run_id, started as i64)?;
        Ok((signer, backup, started))
    }
    .await;
    if prepared.is_err() {
        state.controls.lock().await.remove(&run_id);
    }
    let (signer, backup, started) = prepared?;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ProgressEvent>();
    let store = state.store.clone();
    let controls = state.controls.clone();
    let scope_results = state.scope_results.clone();
    let plan = run_filters::plan_from_filter(&pending.filter);
    let run_req = RunRequest {
        run_id: run_id.clone(),
        platform: pending.platform,
        account_id: pending.account_id,
        account_label: pending.account_label,
        plan,
        filter: pending.filter,
        allow_incomplete_backup: consent.allow_incomplete_backup,
        allow_lost_files: consent.allow_lost_files,
        allow_only_for_self: consent.allow_only_for_self,
    };

    // On its own thread; the run outlives this command and reports over `on_event`.
    let run = run_offthread(move || async move {
        let mut scheduler = Scheduler::new();
        let mut guard = store.lock().await;

        let result = pipeline::execute(
            adapter,
            &mut guard,
            &mut scheduler,
            &run_req,
            control,
            &tx,
            Some(backup),
        )
        .await;
        // Before the receipt, which drops the rows they are counted from. A run
        // that stopped or failed has its own to show too.
        match guard.scope_outcomes(&run_req.run_id) {
            Ok(scopes) => {
                scope_results.lock().await.insert(run_req.run_id.clone(), scopes);
            }
            Err(error) => eprintln!("could not count the run per chat: {error}"),
        }
        let failure = match result {
            Ok(outcome) => {
                let summary = outcome.summary(&run_req, started, now_secs());
                pipeline::store_receipt(&guard, &signer, &summary)
                    .err()
                    .map(CommandError::from)
            }
            Err(e) => Some(CommandError::run_failure(e)),
        };

        drop(guard);
        controls.lock().await.remove(&run_req.run_id);
        failure
    });
    // Engine events until the run drops `tx`, then how it ended. The run's slot is
    // free by then, so whoever hears of a failure can already see the run as interrupted.
    async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let _ = on_event.send(RunEvent::Progress(ev));
        }
        let failure = run.await.unwrap_or_else(|_| Some(CommandError::msg("the run ended unexpectedly")));
        if let Some(failure) = failure {
            let _ = on_event.send(RunEvent::Error(failure));
        }
    });

    Ok(())
}

#[tauri::command]
async fn verify_backup(
    state: State<'_, AppState>,
    run_id: String,
    backup_passphrase: Option<String>,
) -> Result<backup::BackupVerification, CommandError> {
    backup::verify_backup(&state.backup_dir, &run_id, backup_passphrase.as_deref())
}

/// Off the async runtime, because decrypting a large backup takes a while and the
/// folder dialog blocks until the person answers. Progress goes over `on_progress`
/// until the export ends; `stop_export` stops it.
#[tauri::command]
async fn export_backup(
    window: tauri::Window,
    state: State<'_, AppState>,
    run_id: String,
    backup_passphrase: Option<String>,
    on_progress: Channel<backup::ExportProgress>,
) -> Result<backup::ExportOutcome, CommandError> {
    let stop = Arc::new(AtomicBool::new(false));
    // One export of a backup at a time: a second one would write a second folder.
    match state.exports.lock().await.entry(run_id.clone()) {
        Entry::Occupied(_) => return Err(CommandError::msg("this backup is already being exported")),
        Entry::Vacant(slot) => {
            slot.insert(stop.clone());
        }
    }
    let backup_dir = state.backup_dir.clone();
    let exporting = run_id.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        backup::export_backup(
            &backup_dir,
            &exporting,
            backup_passphrase.as_deref(),
            || {
                let folder = window
                    .dialog()
                    .file()
                    .set_parent(&window)
                    .blocking_pick_folder();
                folder
                    .map(|folder| folder.into_path())
                    .transpose()
                    .map_err(|e| CommandError::msg(e.to_string()))
            },
            |progress| {
                let _ = on_progress.send(progress);
            },
            || stop.load(Ordering::SeqCst),
        )
    })
    .await;
    state.exports.lock().await.remove(&run_id);
    outcome?
}

#[tauri::command]
async fn stop_export(state: State<'_, AppState>, run_id: String) -> Result<(), CommandError> {
    if let Some(stop) = state.exports.lock().await.get(&run_id) {
        stop.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
async fn pause_run(state: State<'_, AppState>, run_id: String) -> Result<(), CommandError> {
    if let Some(c) = state.controls.lock().await.get(&run_id) {
        c.pause();
    }
    Ok(())
}

#[tauri::command]
async fn resume_run(state: State<'_, AppState>, run_id: String) -> Result<(), CommandError> {
    if let Some(c) = state.controls.lock().await.get(&run_id) {
        c.resume();
    }
    Ok(())
}

#[tauri::command]
async fn stop_run(state: State<'_, AppState>, run_id: String) -> Result<(), CommandError> {
    if let Some(c) = state.controls.lock().await.get(&run_id) {
        c.stop();
    }
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // One instance only: a second one would share the store, and its start-up
        // cleanup would take the rows of a run the first one is previewing or running.
        // Registered first, as the plugin requires.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                // Bringing the window forward is a courtesy; failing to changes nothing.
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let pds_host = std::env::var("LETHE_PDS_HOST").unwrap_or_else(|_| "bsky.social".into());

            let allow: Vec<String> = {
                let probe = BlueskyAdapter::new(
                    Arc::new(lethe_net::Egress::new(std::iter::empty::<String>())),
                    &pds_host,
                );
                probe
                    .descriptor()
                    .endpoints
                    .iter()
                    .map(|e| e.host.clone())
                    .collect()
            };
            let egress = Arc::new(lethe_net::Egress::new(allow));

            let app_data_dir = app.path().app_data_dir()?;
            let backup_dir = app_data_dir.join(BACKUP_DIR);
            let session_dir = app_data_dir.join(SESSION_DIR);
            let telegram_dir = app_data_dir.join(TELEGRAM_DIR);
            let downloads_dir = app_data_dir.join(DOWNLOADS_DIR);
            fs::create_dir_all(&backup_dir)?;
            fs::create_dir_all(&session_dir)?;
            fs::create_dir_all(&telegram_dir)?;
            // Before TDLib starts, so its files folder is not in use. A file held open
            // elsewhere, by an antivirus for one, must not keep the app from starting:
            // the next start tries again.
            if let Err(error) = backup::empty_download_dirs(&[
                downloads_dir.clone(),
                telegram_dir.join(telegram::FILES_DIR),
            ]) {
                eprintln!("could not remove files left from an interrupted backup: {error}");
            }
            let store = open_app_store(app)?;
            // No run is previewed or under way yet, so what none can use goes now.
            store.forget_stale_runs()?;
            let reader = open_app_store(app)?;

            app.manage(AppState {
                egress,
                store: Arc::new(Mutex::new(store)),
                reader: Arc::new(Mutex::new(reader)),
                controls: Arc::new(Mutex::new(HashMap::new())),
                exports: Arc::new(Mutex::new(HashMap::new())),
                pending: Arc::new(Mutex::new(HashMap::new())),
                scope_results: Arc::new(Mutex::new(HashMap::new())),
                pds_host,
                backup_dir,
                session_dir,
                downloads_dir,
            });
            app.manage(telegram::TelegramState::new(telegram_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            platforms,
            telegram::telegram_auth_status,
            telegram::telegram_scope_status,
            telegram::telegram_auth_start,
            telegram::telegram_auth_code,
            telegram::telegram_auth_password,
            telegram::telegram_own_message_count,
            telegram::telegram_dry_run_chats,
            telegram::telegram_start_run,
            connect_account,
            dry_run,
            start_run,
            retry_unsaved_files,
            discard_retry,
            verify_backup,
            export_backup,
            stop_export,
            pause_run,
            resume_run,
            stop_run,
            run_reads::preview_summary,
            run_reads::preview_backup_space,
            run_reads::preview_scopes,
            run_reads::run_scope_results,
            run_reads::preview_items,
            run_reads::set_item_protected,
            run_reads::list_receipts,
            run_reads::get_receipt,
            run_reads::list_interrupted_runs,
            run_reads::list_unsaved_files,
            run_reads::list_accounts,
            run_reads::disconnect_account,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Untrace");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_reports_progress_as_the_engine_words_it_and_its_failure_with_a_code() {
        let progress = RunEvent::Progress(ProgressEvent::Offline);
        let failure = RunEvent::Error(CommandError::run_failure(lethe_core::EngineError::Aborted));

        assert_eq!(serde_json::to_value(progress).unwrap(), serde_json::json!({ "event": "offline" }));
        assert_eq!(
            serde_json::to_value(failure).unwrap(),
            serde_json::json!({ "event": "error", "data": { "code": "run_stopped", "message": "aborted by user" } })
        );
    }

    #[test]
    fn a_second_run_is_refused_until_the_first_ends() {
        let mut controls = HashMap::new();

        claim_run_slot(&mut controls, "first", RunControl::new()).unwrap();
        assert!(claim_run_slot(&mut controls, "second", RunControl::new()).is_err());
        assert!(!controls.contains_key("second"));

        controls.remove("first");
        claim_run_slot(&mut controls, "second", RunControl::new()).unwrap();
    }
}
