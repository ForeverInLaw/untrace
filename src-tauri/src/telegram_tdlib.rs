use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use lethe_adapter::PlatformAdapter;
use lethe_core::ProgressEvent;
use lethe_telegram::tdlib_bridge::{
    list_chat_scopes, list_own_message_page, TdlibClientId, TelegramChatKind, TelegramCleanability,
};
use tauri::ipc::Channel;
use tauri::{async_runtime, State};
use tdlib_rs::{enums, functions};
use tokio::sync::Mutex;

use crate::secrets::{hex_encode, keychain_data_key, SESSION_KEY_USER};
use crate::telegram::{
    default_rules, TelegramAuthCodeRequest, TelegramAuthPasswordRequest, TelegramAuthPhase,
    TelegramAuthStartRequest, TelegramAuthStatus, TelegramChatSummary, TelegramDryRunRequest,
    TelegramPreviewRequest, TelegramPreviewResult, TelegramScopeKind, TelegramScopeStatus,
};
use crate::{AppState, CommandError, DryRunResult};

#[path = "telegram_snapshot.rs"]
mod snapshot;

const AUTH_WAIT: Duration = Duration::from_secs(20);
const STARTING_MESSAGE: &str = "Starting Telegram TDLib client.";

pub struct TelegramState {
    root_dir: PathBuf,
    inner: Mutex<TelegramInner>,
    auth_states: Arc<Mutex<HashMap<i32, TelegramAuthStatus>>>,
    receiver_started: AtomicBool,
}

#[derive(Default)]
struct TelegramInner {
    client: Option<TdlibClientId>,
    account_label: Option<String>,
    current_user_id: Option<i64>,
}

impl TelegramState {
    pub fn new(root_dir: PathBuf) -> Self {
        Self {
            root_dir,
            inner: Mutex::new(TelegramInner::default()),
            auth_states: Arc::new(Mutex::new(HashMap::new())),
            receiver_started: AtomicBool::new(false),
        }
    }

    fn ensure_receiver(&self) {
        if self
            .receiver_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }

        let auth_states = self.auth_states.clone();
        async_runtime::spawn(async move {
            loop {
                let update = tokio::task::spawn_blocking(tdlib_rs::receive).await;
                let Ok(Some((enums::Update::AuthorizationState(update), client_id))) = update
                else {
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    continue;
                };

                let status = status_from_authorization(update.authorization_state);
                auth_states.lock().await.insert(client_id, status);
            }
        });
    }

    async fn ensure_client(&self) -> Result<TdlibClientId, CommandError> {
        self.ensure_receiver();

        let mut inner = self.inner.lock().await;
        if let Some(client) = inner.client {
            return Ok(client);
        }

        let client = TdlibClientId::new(tdlib_rs::create_client());
        inner.client = Some(client);
        self.auth_states
            .lock()
            .await
            .insert(client.raw(), starting_status());
        Ok(client)
    }

    async fn client(&self) -> Result<TdlibClientId, CommandError> {
        self.inner
            .lock()
            .await
            .client
            .ok_or_else(|| CommandError::msg("Telegram is not connected yet"))
    }

    async fn current_status(&self) -> TelegramAuthStatus {
        let inner = self.inner.lock().await;
        let Some(client) = inner.client else {
            return idle_status();
        };
        let mut status = self
            .auth_states
            .lock()
            .await
            .get(&client.raw())
            .cloned()
            .unwrap_or_else(starting_status);
        if status.account_label.is_none() {
            status.account_label = inner.account_label.clone();
        }
        status
    }

    pub(super) async fn ready_context(
        &self,
    ) -> Result<(TelegramAuthStatus, TdlibClientId, i64), CommandError> {
        let auth = self.current_status().await;
        if !matches!(auth.phase, TelegramAuthPhase::Ready) {
            return Err(CommandError::msg("Telegram is not authenticated"));
        }

        let inner = self.inner.lock().await;
        let client = inner
            .client
            .ok_or_else(|| CommandError::msg("Telegram client is not initialized"))?;
        let current_user_id = inner
            .current_user_id
            .ok_or_else(|| CommandError::msg("Telegram user id is not loaded"))?;
        Ok((auth, client, current_user_id))
    }

    async fn mark_starting(&self, client: TdlibClientId) {
        self.auth_states
            .lock()
            .await
            .insert(client.raw(), starting_status());
    }

    async fn wait_for_auth_update(&self, client: TdlibClientId) -> TelegramAuthStatus {
        let started = std::time::Instant::now();
        loop {
            let status = self
                .auth_states
                .lock()
                .await
                .get(&client.raw())
                .cloned()
                .unwrap_or_else(starting_status);
            if status.message != STARTING_MESSAGE {
                return status;
            }
            if started.elapsed() > AUTH_WAIT {
                return TelegramAuthStatus {
                    phase: TelegramAuthPhase::Error,
                    message: "Timed out waiting for TDLib authorization state.".into(),
                    account_label: None,
                    confirmation_link: None,
                };
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    }

    async fn fill_account_label(&self, client: TdlibClientId) -> Result<(), CommandError> {
        let enums::User::User(me) = functions::get_me(client.raw())
            .await
            .map_err(map_tdlib_error)?;
        let current_user_id = me.id;
        let label = if me.phone_number.is_empty() {
            format!("telegram:{}", me.id)
        } else {
            format!("+{}", me.phone_number)
        };

        {
            let mut inner = self.inner.lock().await;
            inner.account_label = Some(label.clone());
            inner.current_user_id = Some(current_user_id);
        }
        if let Some(status) = self.auth_states.lock().await.get_mut(&client.raw()) {
            status.account_label = Some(label);
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn telegram_scope_status(
    state: State<'_, TelegramState>,
) -> Result<TelegramScopeStatus, CommandError> {
    let auth = state.current_status().await;
    let client = state.inner.lock().await.client;

    if !matches!(auth.phase, TelegramAuthPhase::Ready) {
        return Ok(TelegramScopeStatus {
            available: false,
            blocker: auth.message.clone(),
            auth,
            rules: default_rules(),
            chats: Vec::new(),
        });
    }

    let Some(client) = client else {
        return Ok(TelegramScopeStatus {
            available: false,
            blocker: "Telegram client is not initialized.".into(),
            auth,
            rules: default_rules(),
            chats: Vec::new(),
        });
    };

    let chats = list_chat_scopes(client, 100)
        .await
        .map_err(|e| CommandError::msg(e.to_string()))?
        .into_iter()
        .map(TelegramChatSummary::from)
        .collect();

    Ok(TelegramScopeStatus {
        available: true,
        blocker: String::new(),
        auth,
        rules: default_rules(),
        chats,
    })
}

#[tauri::command]
pub async fn telegram_auth_start(
    state: State<'_, TelegramState>,
    req: TelegramAuthStartRequest,
) -> Result<TelegramAuthStatus, CommandError> {
    if req.api_id <= 0 {
        return Err(CommandError::msg("Telegram api_id must be positive"));
    }
    if req.api_hash.trim().is_empty() || req.phone_number.trim().is_empty() {
        return Err(CommandError::msg(
            "Telegram api_hash and phone number are required",
        ));
    }

    let client = state.ensure_client().await?;
    functions::set_log_verbosity_level(2, client.raw())
        .await
        .map_err(map_tdlib_error)?;

    let mut status = state.wait_for_auth_update(client).await;
    if matches!(status.phase, TelegramAuthPhase::Starting) && status.message.contains("parameters")
    {
        state.mark_starting(client).await;
        set_tdlib_parameters(&state, client, req.api_id, req.api_hash).await?;
        status = state.wait_for_auth_update(client).await;
    }

    if matches!(status.phase, TelegramAuthPhase::Ready) {
        state.fill_account_label(client).await?;
        return Ok(state.current_status().await);
    }

    if !status.message.contains("phone number") {
        return Ok(status);
    }

    state.mark_starting(client).await;
    functions::set_authentication_phone_number(req.phone_number, None, client.raw())
        .await
        .map_err(map_tdlib_error)?;
    status = state.wait_for_auth_update(client).await;

    if matches!(status.phase, TelegramAuthPhase::Ready) {
        state.fill_account_label(client).await?;
        return Ok(state.current_status().await);
    }

    Ok(status)
}

#[tauri::command]
pub async fn telegram_auth_code(
    state: State<'_, TelegramState>,
    req: TelegramAuthCodeRequest,
) -> Result<TelegramAuthStatus, CommandError> {
    let client = state.client().await?;
    state.mark_starting(client).await;
    functions::check_authentication_code(req.code, client.raw())
        .await
        .map_err(map_tdlib_error)?;
    let status = state.wait_for_auth_update(client).await;
    if matches!(status.phase, TelegramAuthPhase::Ready) {
        state.fill_account_label(client).await?;
        return Ok(state.current_status().await);
    }
    Ok(status)
}

#[tauri::command]
pub async fn telegram_auth_password(
    state: State<'_, TelegramState>,
    req: TelegramAuthPasswordRequest,
) -> Result<TelegramAuthStatus, CommandError> {
    let client = state.client().await?;
    state.mark_starting(client).await;
    functions::check_authentication_password(req.password, client.raw())
        .await
        .map_err(map_tdlib_error)?;
    let status = state.wait_for_auth_update(client).await;
    if matches!(status.phase, TelegramAuthPhase::Ready) {
        state.fill_account_label(client).await?;
        return Ok(state.current_status().await);
    }
    Ok(status)
}

#[tauri::command]
pub async fn telegram_preview_chats(
    state: State<'_, TelegramState>,
    req: TelegramPreviewRequest,
) -> Result<TelegramPreviewResult, CommandError> {
    let (_auth, client, current_user_id) = state.ready_context().await?;
    let page_limit = req.page_limit.unwrap_or(100).clamp(1, 100);
    let mut own_messages = 0usize;

    for chat_id in &req.chat_ids {
        let chat_id = parse_chat_id(chat_id)?;
        let page = list_own_message_page(client, chat_id, current_user_id, 0, page_limit)
            .await
            .map_err(|e| CommandError::msg(e.to_string()))?;
        own_messages += page.len();
    }

    Ok(TelegramPreviewResult {
        scanned_chats: req.chat_ids.len(),
        own_messages,
        page_limit,
    })
}

#[tauri::command]
pub async fn telegram_dry_run_chats(
    app: State<'_, AppState>,
    state: State<'_, TelegramState>,
    req: TelegramDryRunRequest,
) -> Result<DryRunResult, CommandError> {
    snapshot::telegram_dry_run_chats(app, state, req).await
}

/// Phase 2 for Telegram: execute the already-previewed selected-chat snapshot
/// with backup + receipt, streaming progress over the channel. Reuses the
/// shared run machinery; only the adapter is Telegram-specific.
#[tauri::command]
pub async fn telegram_start_run(
    app: State<'_, AppState>,
    state: State<'_, TelegramState>,
    run_id: String,
    backup_passphrase: Option<String>,
    on_event: Channel<ProgressEvent>,
) -> Result<(), CommandError> {
    let pending = app
        .pending
        .lock()
        .await
        .get(&run_id)
        .cloned()
        .ok_or_else(|| {
            CommandError::msg(format!(
                "no previewed run {run_id}; call telegram_dry_run_chats first"
            ))
        })?;
    if pending.platform != "telegram" {
        return Err(CommandError::msg(format!(
            "run {run_id} is not a Telegram run"
        )));
    }

    // Reuse the authenticated TDLib client. Phase 2 reads pending rows from the
    // store, so the execute adapter needs only the client + revoke policy.
    let (_auth, client, _user_id) = state.ready_context().await?;
    let adapter: Arc<dyn PlatformAdapter> =
        Arc::new(snapshot::TelegramSnapshotAdapter::for_execute(client, true));

    crate::execute_previewed_run(&app, adapter, run_id, pending, backup_passphrase, on_event).await
}

async fn set_tdlib_parameters(
    state: &TelegramState,
    client: TdlibClientId,
    api_id: i32,
    api_hash: String,
) -> Result<(), CommandError> {
    std::fs::create_dir_all(&state.root_dir)?;
    let database_dir = state.root_dir.join("db");
    let files_dir = state.root_dir.join("files");
    std::fs::create_dir_all(&database_dir)?;
    std::fs::create_dir_all(&files_dir)?;
    let db_key = hex_encode(&keychain_data_key(
        SESSION_KEY_USER,
        "telegram database key",
    )?);

    functions::set_tdlib_parameters(
        false,
        database_dir.to_string_lossy().into_owned(),
        files_dir.to_string_lossy().into_owned(),
        db_key,
        true,
        true,
        true,
        false,
        api_id,
        api_hash,
        "en".into(),
        "Untrace Desktop".into(),
        std::env::consts::OS.into(),
        env!("CARGO_PKG_VERSION").into(),
        client.raw(),
    )
    .await
    .map_err(map_tdlib_error)
}

impl From<lethe_telegram::tdlib_bridge::TelegramChatScope> for TelegramChatSummary {
    fn from(scope: lethe_telegram::tdlib_bridge::TelegramChatScope) -> Self {
        Self {
            id: scope.id.to_string(),
            title: scope.title,
            kind: match scope.kind {
                TelegramChatKind::Private => TelegramScopeKind::PrivateChat,
                TelegramChatKind::Group => TelegramScopeKind::Group,
                TelegramChatKind::Channel => TelegramScopeKind::Channel,
                TelegramChatKind::Secret => TelegramScopeKind::Secret,
            },
            cleanability: match scope.cleanability {
                TelegramCleanability::DeleteForEveryone => "Can delete for everyone".into(),
                TelegramCleanability::OnlyForSelf => "Can delete only for this account".into(),
                TelegramCleanability::NotCleanable => "Not cleanable by this account".into(),
            },
        }
    }
}

pub(super) fn parse_chat_id(chat_id: &str) -> Result<i64, CommandError> {
    chat_id
        .parse::<i64>()
        .map_err(|e| CommandError::msg(format!("invalid Telegram chat id {chat_id}: {e}")))
}

fn status_from_authorization(state: enums::AuthorizationState) -> TelegramAuthStatus {
    match state {
        enums::AuthorizationState::WaitTdlibParameters => TelegramAuthStatus {
            phase: TelegramAuthPhase::Starting,
            message: "TDLib is waiting for initialization parameters.".into(),
            account_label: None,
            confirmation_link: None,
        },
        enums::AuthorizationState::WaitPhoneNumber => TelegramAuthStatus {
            phase: TelegramAuthPhase::Starting,
            message: "TDLib is ready for the phone number.".into(),
            account_label: None,
            confirmation_link: None,
        },
        enums::AuthorizationState::WaitCode(_) => TelegramAuthStatus {
            phase: TelegramAuthPhase::WaitCode,
            message: "Enter the Telegram login code.".into(),
            account_label: None,
            confirmation_link: None,
        },
        enums::AuthorizationState::WaitPassword(_) => TelegramAuthStatus {
            phase: TelegramAuthPhase::WaitPassword,
            message: "Enter the Telegram two-step verification password.".into(),
            account_label: None,
            confirmation_link: None,
        },
        enums::AuthorizationState::WaitOtherDeviceConfirmation(data) => TelegramAuthStatus {
            phase: TelegramAuthPhase::WaitOtherDeviceConfirmation,
            message: "Confirm this login from another Telegram session.".into(),
            account_label: None,
            confirmation_link: Some(data.link),
        },
        enums::AuthorizationState::Ready => TelegramAuthStatus {
            phase: TelegramAuthPhase::Ready,
            message: "Telegram is authenticated; chat discovery is available.".into(),
            account_label: None,
            confirmation_link: None,
        },
        enums::AuthorizationState::Closed => TelegramAuthStatus {
            phase: TelegramAuthPhase::Closed,
            message: "Telegram client is closed.".into(),
            account_label: None,
            confirmation_link: None,
        },
        other => TelegramAuthStatus {
            phase: TelegramAuthPhase::Error,
            message: format!("Unsupported Telegram auth state: {other:?}"),
            account_label: None,
            confirmation_link: None,
        },
    }
}

fn starting_status() -> TelegramAuthStatus {
    TelegramAuthStatus {
        phase: TelegramAuthPhase::Starting,
        message: STARTING_MESSAGE.into(),
        account_label: None,
        confirmation_link: None,
    }
}

fn idle_status() -> TelegramAuthStatus {
    TelegramAuthStatus {
        phase: TelegramAuthPhase::Idle,
        message: "Connect Telegram to discover chats where your messages can be cleaned.".into(),
        account_label: None,
        confirmation_link: None,
    }
}

fn map_tdlib_error(error: tdlib_rs::types::Error) -> CommandError {
    CommandError::msg(format!("TDLib {}: {}", error.code, error.message))
}
