//! Untrace Tauri shell. The core owns the run; these commands start/observe it.
//! Live progress flows over a Tauri `Channel<ProgressEvent>` (reusing the
//! engine's event type verbatim). Run state lives in the core + SQLite, so a
//! run survives UI navigation.
//!
//! Concurrency note: the run-state `Store` wraps a rusqlite `Connection`, which
//! is `Send` but `!Sync`. The engine borrows the store across `.await` points
//! (it interleaves network calls with checkpoint writes), so a run future is
//! `!Send` and cannot live on Tauri's multi-thread runtime. Each store-touching
//! job therefore runs on a dedicated OS thread with a current-thread runtime
//! (`run_offthread`); the future is built inside that thread and never crosses a
//! thread boundary, so it is never required to be `Send`.

use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use lethe_adapter::{AuthProvider, Consent, Credential, PlatformAdapter, SecretBlob};
use lethe_bluesky::{BlueskyAdapter, BlueskyAuth};
use lethe_core::filter::FilterSpec;
use lethe_core::pipeline::{self, RunRequest};
use lethe_core::scheduler::Scheduler;
use lethe_core::{ProgressEvent, RunControl};
use lethe_crypto::receipt::RunSummary;
use lethe_store::{NewRun, Store};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{async_runtime, Manager, State};
use tokio::sync::Mutex;

mod backup;
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

pub struct AppState {
    pub egress: Arc<lethe_net::Egress>,
    pub store: Arc<Mutex<Store>>,
    /// Separate connection for UI reads: a run holds `store` until it finishes.
    pub reader: Arc<Mutex<Store>>,
    pub controls: Arc<Mutex<HashMap<String, RunControl>>>,
    pub pending: Arc<Mutex<HashMap<String, PendingRun>>>,
    pub pds_host: String,
    pub backup_dir: PathBuf,
    pub session_dir: PathBuf,
}

#[derive(Clone)]
pub struct PendingRun {
    platform: String,
    account_id: String,
    account_label: String,
    filter: FilterSpec,
}

#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}
impl CommandError {
    fn msg(m: impl Into<String>) -> Self {
        Self { message: m.into() }
    }
}
impl<E: std::fmt::Display> From<E> for CommandError {
    fn from(e: E) -> Self {
        Self {
            message: e.to_string(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct BuildRunRequest {
    pub platform: String,
    pub account_id: String,
    pub account_label: String,
    #[serde(default)]
    pub filter: run_filters::FilterRequest,
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
    egress: Arc<lethe_net::Egress>,
    pds_host: &str,
    session_dir: &std::path::Path,
    platform: &str,
    account_label: &str,
) -> Result<Arc<dyn PlatformAdapter>, CommandError> {
    if platform != "bluesky" {
        return Err(CommandError::msg(format!(
            "unsupported platform: {platform}"
        )));
    }
    let blob = session::load(session_dir, platform, account_label)?;
    let cred = Credential {
        account_label: account_label.to_owned(),
        secret: SecretBlob(blob),
    };
    let mut adapter = BlueskyAdapter::new(egress, pds_host);
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
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.message))?;
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
    let cred = auth.connect(&consent).await?;

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
    let adapter = authed_adapter(
        state.egress.clone(),
        &state.pds_host,
        &state.session_dir,
        &req.platform,
        &req.account_label,
    )
    .await?;
    let run_id = format!("{}-{}", req.platform, now_secs());

    let run_req = RunRequest {
        run_id: run_id.clone(),
        platform: req.platform.clone(),
        account_id: req.account_id.clone(),
        account_label: req.account_label.clone(),
        plan,
        filter: filter.clone(),
        backup: true,
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
    on_event: Channel<ProgressEvent>,
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
    let adapter = authed_adapter(
        state.egress.clone(),
        &state.pds_host,
        &state.session_dir,
        &pending.platform,
        &pending.account_label,
    )
    .await?;

    execute_previewed_run(
        &state,
        adapter,
        run_id,
        pending,
        backup_passphrase,
        on_event,
    )
    .await
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
    on_event: Channel<ProgressEvent>,
) -> Result<(), CommandError> {
    // Load keys/backup target up front: never start deleting what we cannot seal.
    let signer = secrets::receipt_signer()?;
    let backup = backup::backup_target(
        &state.backup_dir,
        &run_id,
        backup_passphrase
            .as_deref()
            .filter(|passphrase| !passphrase.is_empty()),
    )?;
    let media = state.reader.lock().await.pending_media(&run_id)?;
    if !backup::backup_space(&state.backup_dir, &media)?.fits {
        return Err(CommandError::msg("not enough free disk space for the backup"));
    }

    let control = RunControl::new();
    state
        .controls
        .lock()
        .await
        .insert(run_id.clone(), control.clone());

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ProgressEvent>();
    // Forward engine events to the frontend channel until the run drops `tx`.
    async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let _ = on_event.send(ev);
        }
    });

    let store = state.store.clone();
    let controls = state.controls.clone();
    let plan = run_filters::plan_from_filter(&pending.filter);
    let run_req = RunRequest {
        run_id: run_id.clone(),
        platform: pending.platform,
        account_id: pending.account_id,
        account_label: pending.account_label,
        plan,
        filter: pending.filter,
        backup: true,
    };

    // Fire-and-forget on its own thread; the run outlives this command. The
    // result receiver is dropped — the run reports via the progress channel.
    let _run_rx = run_offthread(move || async move {
        let mut scheduler = Scheduler::new();
        let started = now_secs();
        let mut guard = store.lock().await;

        match pipeline::execute(
            adapter,
            &mut guard,
            &mut scheduler,
            &run_req,
            control,
            &tx,
            Some(backup),
        )
        .await
        {
            Ok(outcome) => {
                let summary = RunSummary {
                    run_id: run_req.run_id.clone(),
                    platform: run_req.platform.clone(),
                    account_label: run_req.account_label.clone(),
                    started_epoch_secs: started,
                    finished_epoch_secs: now_secs(),
                    deleted: outcome.deleted,
                    skipped: outcome.skipped,
                    failed: outcome.failed,
                };
                if let Err(e) = pipeline::store_receipt(&guard, &signer, &summary) {
                    let _ = tx.send(ProgressEvent::Error {
                        message: e.to_string(),
                    });
                }
            }
            Err(e) => {
                let _ = tx.send(ProgressEvent::Error {
                    message: e.to_string(),
                });
            }
        }

        drop(guard);
        controls.lock().await.remove(&run_req.run_id);
    });

    Ok(())
}

#[tauri::command]
async fn verify_backup(
    state: State<'_, AppState>,
    run_id: String,
    backup_passphrase: Option<String>,
) -> Result<backup::BackupVerification, CommandError> {
    backup::verify_backup(
        &state.backup_dir,
        &run_id,
        backup_passphrase
            .as_deref()
            .filter(|passphrase| !passphrase.is_empty()),
    )
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
            fs::create_dir_all(&backup_dir)?;
            fs::create_dir_all(&session_dir)?;
            fs::create_dir_all(&telegram_dir)?;
            let store = open_app_store(app)?;
            let reader = open_app_store(app)?;

            app.manage(AppState {
                egress,
                store: Arc::new(Mutex::new(store)),
                reader: Arc::new(Mutex::new(reader)),
                controls: Arc::new(Mutex::new(HashMap::new())),
                pending: Arc::new(Mutex::new(HashMap::new())),
                pds_host,
                backup_dir,
                session_dir,
            });
            app.manage(telegram::TelegramState::new(telegram_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            platforms,
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
            verify_backup,
            pause_run,
            resume_run,
            stop_run,
            run_reads::preview_summary,
            run_reads::preview_items,
            run_reads::set_item_protected,
            run_reads::list_receipts,
            run_reads::get_receipt,
            run_reads::list_accounts,
            run_reads::disconnect_account,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Untrace");
}
