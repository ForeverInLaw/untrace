use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use lethe_adapter::PlatformAdapter;
use lethe_telegram::tdlib_bridge::{
    list_chat_scopes, search_own_messages, OwnMessagePage, TdlibClientId, TelegramChatKind,
};
use tauri::ipc::Channel;
use tauri::State;
use tdlib_rs::{enums, functions};
use tokio::sync::{watch, Mutex, OnceCell};

use crate::secrets::{hex_encode, keychain_data_key, SESSION_KEY_USER};
use crate::telegram::{
    TelegramAuthCodeRequest, TelegramAuthPasswordRequest, TelegramAuthPhase,
    TelegramAuthStartRequest, TelegramAuthStatus, TelegramChatSummary, TelegramDryRunRequest,
    TelegramScopeKind, TelegramScopeStatus,
};
use crate::{AppState, CommandError, DryRunResult, ErrorKind};

#[path = "telegram_snapshot.rs"]
mod snapshot;

#[path = "telegram_api_key.rs"]
mod api_key;

use api_key::{ApiKey, ApiKeyKeeper, KeychainVault};

const AUTH_WAIT: Duration = Duration::from_secs(20);

pub struct TelegramState {
    root_dir: PathBuf,
    inner: Mutex<TelegramInner>,
    auth_states: Arc<Mutex<HashMap<i32, TelegramAuthStatus>>>,
    /// Whether TDLib last reported a working connection to Telegram.
    online: Arc<watch::Sender<bool>>,
    receiver_started: AtomicBool,
    api_key: ApiKeyKeeper<KeychainVault>,
    /// Set once the saved session has had its chance to reconnect.
    resumed: OnceCell<()>,
    /// Why the saved session did not reconnect; cleared by the next sign-in attempt.
    resume_failure: Mutex<Option<CommandError>>,
    /// Held for a whole sign-out, so two of them never race on one client.
    signing_out: Mutex<()>,
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
            online: Arc::new(watch::Sender::new(false)),
            receiver_started: AtomicBool::new(false),
            api_key: ApiKeyKeeper::new(KeychainVault),
            resumed: OnceCell::new(),
            resume_failure: Mutex::new(None),
            signing_out: Mutex::new(()),
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
        let online = self.online.clone();
        // `receive` already blocks until TDLib has something, so the loop reads back to
        // back: every answer to a request passes through here, and a pause between
        // reads would hold all of them up behind the flood of updates after sign-in.
        std::thread::spawn(move || loop {
            match tdlib_rs::receive() {
                Some((enums::Update::AuthorizationState(update), client_id)) => {
                    let status = status_from_authorization(update.authorization_state);
                    auth_states.blocking_lock().insert(client_id, status);
                }
                Some((enums::Update::ConnectionState(update), _)) => {
                    let reachable = matches!(
                        update.state,
                        enums::ConnectionState::Ready | enums::ConnectionState::Updating
                    );
                    online.send_replace(reachable);
                }
                _ => {}
            }
        });
    }

    /// The live client, replacing one that has closed after a sign-out.
    async fn ensure_client(&self) -> TdlibClientId {
        self.ensure_receiver();

        let mut inner = self.inner.lock().await;
        let mut auth_states = self.auth_states.lock().await;
        if let Some(client) = inner.client {
            let closed = auth_states
                .get(&client.raw())
                .is_some_and(|status| matches!(status.phase, TelegramAuthPhase::Closed));
            if !closed {
                return client;
            }
        }

        let client = TdlibClientId::new(tdlib_rs::create_client());
        *inner = TelegramInner {
            client: Some(client),
            ..TelegramInner::default()
        };
        self.online.send_replace(false);
        auth_states.insert(client.raw(), starting_status());
        client
    }

    /// The live client and where its sign-in stands, read from TDLib itself.
    async fn started_client(&self) -> Result<(TdlibClientId, TelegramAuthStatus), CommandError> {
        let client = self.ensure_client().await;
        // A new client stays silent until its first request.
        functions::set_log_verbosity_level(2, client.raw())
            .await
            .map_err(map_tdlib_error)?;
        let state = functions::get_authorization_state(client.raw())
            .await
            .map_err(map_tdlib_error)?;
        let status = status_from_authorization(state);
        self.restore_status(client, status.clone()).await;
        Ok((client, status))
    }

    /// Reconnects the session an earlier sign-in saved. Runs once per launch, and
    /// every command that needs the session waits for it.
    async fn resumed(&self) {
        self.resumed
            .get_or_init(|| async {
                if let Err(error) = self.resume().await {
                    // A cause the person can act on, such as a locked keychain, stays.
                    let kind = match error.kind {
                        ErrorKind::Unknown => ErrorKind::SessionExpired,
                        known => known,
                    };
                    *self.resume_failure.lock().await = Some(CommandError::new(
                        kind,
                        format!("Could not reconnect the saved Telegram session: {}", error.message()),
                    ));
                }
            })
            .await;
    }

    async fn resume(&self) -> Result<(), CommandError> {
        let Some(key) = self.api_key.key_to_resume()? else {
            return Ok(());
        };
        let (client, status) = self.started_client().await?;
        if matches!(status.phase, TelegramAuthPhase::WaitParameters) {
            self.apply_api_key(client, key).await?;
        }
        self.settled_status(client).await.map(drop)
    }

    async fn client(&self) -> Result<TdlibClientId, CommandError> {
        self.inner
            .lock()
            .await
            .client
            .ok_or_else(not_connected)
    }

    async fn current_status(&self) -> TelegramAuthStatus {
        if let Some(failure) = self.resume_failure.lock().await.clone() {
            return error_status(failure);
        }
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

    /// Where the sign-in stands once the saved session has had its chance to
    /// reconnect. A sign-in that reached Ready only after its wait timed out
    /// learns here who is signed in.
    async fn known_status(&self) -> Result<TelegramAuthStatus, CommandError> {
        self.resumed().await;
        let status = self.current_status().await;
        let (client, identified) = {
            let inner = self.inner.lock().await;
            (inner.client, inner.current_user_id.is_some())
        };
        match client {
            Some(client) if matches!(status.phase, TelegramAuthPhase::Ready) && !identified => {
                self.settled_status(client).await
            }
            Some(_) if matches!(status.phase, TelegramAuthPhase::Ready) => {
                // Saves a key the keychain refused at sign-in.
                self.api_key.signed_in()?;
                Ok(status)
            }
            _ => Ok(status),
        }
    }

    /// Follows TDLib's connection to Telegram, for a run to wait out an outage.
    pub(super) fn connection(&self) -> watch::Receiver<bool> {
        self.online.subscribe()
    }

    pub(super) async fn ready_context(
        &self,
    ) -> Result<(TelegramAuthStatus, TdlibClientId, i64), CommandError> {
        let auth = self.known_status().await?;
        if !matches!(auth.phase, TelegramAuthPhase::Ready) {
            return Err(not_connected());
        }

        let inner = self.inner.lock().await;
        let client = inner
            .client
            .ok_or_else(not_connected)?;
        let current_user_id = inner
            .current_user_id
            .ok_or_else(|| CommandError::msg("Telegram user id is not loaded"))?;
        Ok((auth, client, current_user_id))
    }

    /// The signed-in account, once the saved session has had its chance to reconnect.
    pub async fn signed_in_account(&self) -> Result<Option<String>, CommandError> {
        let status = self.known_status().await?;
        Ok(match status.phase {
            TelegramAuthPhase::Ready => status.account_label,
            _ => None,
        })
    }

    /// Ends the session on Telegram's side, then removes what it left on this
    /// device. Without a connection nothing changes, so the session never lingers
    /// half-closed.
    pub async fn log_out(&self) -> Result<(), CommandError> {
        let _one_at_a_time = self.signing_out.lock().await;
        self.resumed().await;
        let client = self.inner.lock().await.client;
        let Some(client) = client else {
            // No session opened in this launch, so none can be ended. TDLib's folder
            // stays: it may hold a session that only signing in again can close.
            *self.resume_failure.lock().await = None;
            return self.api_key.signed_out();
        };
        self.close_client(client).await?;
        // Until the folder is gone the closed client stays, so another try removes it.
        match std::fs::remove_dir_all(&self.root_dir) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
        *self.inner.lock().await = TelegramInner::default();
        *self.resume_failure.lock().await = None;
        self.api_key.signed_out()
    }

    async fn close_client(&self, client: TdlibClientId) -> Result<(), CommandError> {
        let closed = self
            .auth_states
            .lock()
            .await
            .get(&client.raw())
            .is_some_and(|status| matches!(status.phase, TelegramAuthPhase::Closed));
        if closed {
            return Ok(());
        }
        let state = functions::get_authorization_state(client.raw())
            .await
            .map_err(map_tdlib_error)?;
        let request = match state {
            enums::AuthorizationState::Closed => return Ok(()),
            // Nothing is signed in yet, so there is no session to end on the server.
            enums::AuthorizationState::WaitTdlibParameters => functions::close(client.raw()).await,
            enums::AuthorizationState::Ready if !*self.online.borrow() => {
                return Err(CommandError::new(
                    ErrorKind::Offline,
                    "Telegram is unreachable. Sign out again once the connection is back.",
                ));
            }
            _ => functions::log_out(client.raw()).await,
        };
        request.map_err(map_tdlib_error)?;
        self.wait_until(client, |status| {
            matches!(status.phase, TelegramAuthPhase::Closed)
        })
        .await
        .map(drop)
        .ok_or_else(|| CommandError::msg("Telegram is still signing out. Try again in a moment."))
    }

    async fn mark_starting(&self, client: TdlibClientId) {
        self.auth_states
            .lock()
            .await
            .insert(client.raw(), starting_status());
    }

    /// A rejected request brings no update from TDLib, so its last state still holds.
    async fn restore_status(&self, client: TdlibClientId, status: TelegramAuthStatus) {
        self.auth_states.lock().await.insert(client.raw(), status);
    }

    /// Hands TDLib the API pair; it opens the saved session, if there is one.
    async fn apply_api_key(&self, client: TdlibClientId, key: ApiKey) -> Result<(), CommandError> {
        self.mark_starting(client).await;
        if let Err(error) = set_tdlib_parameters(self, client, &key).await {
            let waiting = status_from_authorization(enums::AuthorizationState::WaitTdlibParameters);
            self.restore_status(client, waiting).await;
            return Err(error);
        }
        self.api_key.entered(key);
        Ok(())
    }

    /// Where the sign-in stands after a step; once it is done, records who signed in
    /// and keeps the API pair for the next launch.
    async fn settled_status(
        &self,
        client: TdlibClientId,
    ) -> Result<TelegramAuthStatus, CommandError> {
        let status = self.wait_for_auth_update(client).await;
        if !matches!(status.phase, TelegramAuthPhase::Ready) {
            return Ok(status);
        }
        self.fill_account_label(client).await?;
        self.api_key.signed_in()?;
        Ok(self.current_status().await)
    }

    async fn wait_for_auth_update(&self, client: TdlibClientId) -> TelegramAuthStatus {
        self.wait_until(client, |status| !matches!(status.phase, TelegramAuthPhase::Starting))
            .await
            .unwrap_or_else(|| {
                error_status(CommandError::msg("Timed out waiting for TDLib authorization state."))
            })
    }

    async fn wait_until(
        &self,
        client: TdlibClientId,
        done: impl Fn(&TelegramAuthStatus) -> bool,
    ) -> Option<TelegramAuthStatus> {
        let started = std::time::Instant::now();
        while started.elapsed() <= AUTH_WAIT {
            let status = self
                .auth_states
                .lock()
                .await
                .get(&client.raw())
                .cloned()
                .unwrap_or_else(starting_status);
            if done(&status) {
                return Some(status);
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
        None
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

/// The sign-in state alone, answered without loading the chat list.
#[tauri::command]
pub async fn telegram_auth_status(
    state: State<'_, TelegramState>,
) -> Result<TelegramAuthStatus, CommandError> {
    state.known_status().await
}

#[tauri::command]
pub async fn telegram_scope_status(
    state: State<'_, TelegramState>,
) -> Result<TelegramScopeStatus, CommandError> {
    let auth = state.known_status().await?;
    let client = state.inner.lock().await.client;

    if !matches!(auth.phase, TelegramAuthPhase::Ready) {
        return Ok(TelegramScopeStatus {
            available: false,
            blocker: Some(auth.error.clone().unwrap_or_else(not_connected)),
            auth,
            chats: Vec::new(),
        });
    }

    let Some(client) = client else {
        return Ok(TelegramScopeStatus {
            available: false,
            blocker: Some(not_connected()),
            auth,
            chats: Vec::new(),
        });
    };

    let chats = list_chat_scopes(client)
        .await?
        .into_iter()
        .map(TelegramChatSummary::from)
        .collect();

    Ok(TelegramScopeStatus {
        available: true,
        blocker: None,
        auth,
        chats,
    })
}

#[tauri::command]
pub async fn telegram_auth_start(
    state: State<'_, TelegramState>,
    req: TelegramAuthStartRequest,
) -> Result<TelegramAuthStatus, CommandError> {
    if req.phone_number.trim().is_empty() {
        return Err(CommandError::msg("Telegram phone number is required"));
    }
    state.resumed().await;
    // A sign-out in progress finishes first, so this does not start on a closing client.
    drop(state.signing_out.lock().await);
    state.resume_failure.lock().await.take();

    let (client, status) = state.started_client().await?;
    if matches!(status.phase, TelegramAuthPhase::WaitParameters) {
        let key = ApiKey::checked(req.api_id, req.api_hash)?;
        state.apply_api_key(client, key).await?;
    }
    let status = state.settled_status(client).await?;

    // TDLib also accepts a new number while it waits for a code or password.
    let accepts_phone = matches!(
        status.phase,
        TelegramAuthPhase::WaitPhoneNumber
            | TelegramAuthPhase::WaitCode
            | TelegramAuthPhase::WaitPassword
    );
    if !accepts_phone {
        return Ok(status);
    }

    state.mark_starting(client).await;
    if let Err(error) =
        functions::set_authentication_phone_number(req.phone_number, None, client.raw()).await
    {
        state.restore_status(client, status).await;
        return Err(map_tdlib_error(error));
    }
    state.settled_status(client).await
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
    state.settled_status(client).await
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
    state.settled_status(client).await
}

/// Longest FLOOD_WAIT worth sitting through; anything longer surfaces as an error.
const MAX_FLOOD_WAIT_SECS: u64 = 300;

/// Own-message search that honors Telegram's FLOOD_WAIT instead of failing the run.
async fn own_message_page(
    client: TdlibClientId,
    chat_id: i64,
    current_user_id: i64,
    from_message_id: i64,
    limit: i32,
) -> Result<OwnMessagePage, lethe_adapter::AdapterError> {
    loop {
        match search_own_messages(client, chat_id, current_user_id, from_message_id, limit).await {
            Err(lethe_adapter::AdapterError::RateLimited { retry_after_secs })
                if retry_after_secs <= MAX_FLOOD_WAIT_SECS =>
            {
                tokio::time::sleep(Duration::from_secs(retry_after_secs)).await;
            }
            result => return result,
        }
    }
}

/// How many of the user's messages a chat holds; the count is approximate for large chats.
#[tauri::command]
pub async fn telegram_own_message_count(
    state: State<'_, TelegramState>,
    chat_id: String,
) -> Result<usize, CommandError> {
    let (_auth, client, current_user_id) = state.ready_context().await?;
    let page = own_message_page(client, parse_chat_id(&chat_id)?, current_user_id, 0, 1).await?;
    Ok(usize::try_from(page.total_count)
        .unwrap_or(0)
        .max(page.messages.len()))
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
    consent: crate::RunConsent,
    on_event: Channel<crate::RunEvent>,
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
    // store, so the execute adapter needs only the client + whose messages they are.
    let (_auth, client, current_user_id) = state.ready_context().await?;
    let adapter: Arc<dyn PlatformAdapter> = Arc::new(
        snapshot::TelegramSnapshotAdapter::for_execute(client, current_user_id, state.connection()),
    );

    crate::execute_previewed_run(
        &app,
        adapter,
        run_id,
        pending,
        backup_passphrase,
        consent,
        on_event,
    )
    .await
}

async fn set_tdlib_parameters(
    state: &TelegramState,
    client: TdlibClientId,
    key: &ApiKey,
) -> Result<(), CommandError> {
    std::fs::create_dir_all(&state.root_dir)?;
    let database_dir = state.root_dir.join("db");
    let files_dir = state.root_dir.join(super::FILES_DIR);
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
        key.api_id,
        key.api_hash.clone(),
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
            last_message_id: scope.last_message_id.map(|id| id.to_string()),
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
            phase: TelegramAuthPhase::WaitParameters,
            error: None,
            account_label: None,
            confirmation_link: None,
        },
        enums::AuthorizationState::WaitPhoneNumber => TelegramAuthStatus {
            phase: TelegramAuthPhase::WaitPhoneNumber,
            error: None,
            account_label: None,
            confirmation_link: None,
        },
        enums::AuthorizationState::WaitCode(_) => TelegramAuthStatus {
            phase: TelegramAuthPhase::WaitCode,
            error: None,
            account_label: None,
            confirmation_link: None,
        },
        enums::AuthorizationState::WaitPassword(_) => TelegramAuthStatus {
            phase: TelegramAuthPhase::WaitPassword,
            error: None,
            account_label: None,
            confirmation_link: None,
        },
        enums::AuthorizationState::WaitOtherDeviceConfirmation(data) => TelegramAuthStatus {
            phase: TelegramAuthPhase::WaitOtherDeviceConfirmation,
            error: None,
            account_label: None,
            confirmation_link: Some(data.link),
        },
        enums::AuthorizationState::Ready => TelegramAuthStatus {
            phase: TelegramAuthPhase::Ready,
            error: None,
            account_label: None,
            confirmation_link: None,
        },
        enums::AuthorizationState::LoggingOut | enums::AuthorizationState::Closing => {
            TelegramAuthStatus {
                phase: TelegramAuthPhase::SigningOut,
                error: None,
                account_label: None,
                confirmation_link: None,
            }
        }
        enums::AuthorizationState::Closed => TelegramAuthStatus {
            phase: TelegramAuthPhase::Closed,
            error: None,
            account_label: None,
            confirmation_link: None,
        },
        other => error_status(CommandError::msg(format!("Unsupported Telegram auth state: {other:?}"))),
    }
}

fn starting_status() -> TelegramAuthStatus {
    TelegramAuthStatus {
        phase: TelegramAuthPhase::Starting,
        error: None,
        account_label: None,
        confirmation_link: None,
    }
}

fn error_status(error: CommandError) -> TelegramAuthStatus {
    TelegramAuthStatus {
        phase: TelegramAuthPhase::Error,
        error: Some(error),
        account_label: None,
        confirmation_link: None,
    }
}

fn idle_status() -> TelegramAuthStatus {
    TelegramAuthStatus {
        phase: TelegramAuthPhase::Idle,
        error: None,
        account_label: None,
        confirmation_link: None,
    }
}

fn map_tdlib_error(error: tdlib_rs::types::Error) -> CommandError {
    CommandError::telegram(error.code, &error.message)
}

/// Telegram has no live, signed-in client to act with.
fn not_connected() -> CommandError {
    CommandError::new(ErrorKind::TelegramNotConnected, "Telegram is not signed in")
}

#[cfg(test)]
mod tests {
    use super::*;
    use enums::AuthorizationState as Td;

    fn phase(state: Td) -> TelegramAuthPhase {
        status_from_authorization(state).phase
    }

    #[test]
    fn the_form_can_tell_whether_tdlib_still_needs_the_api_key() {
        assert!(matches!(
            phase(Td::WaitTdlibParameters),
            TelegramAuthPhase::WaitParameters
        ));
        assert!(matches!(
            phase(Td::WaitPhoneNumber),
            TelegramAuthPhase::WaitPhoneNumber
        ));
    }

    #[test]
    fn signing_out_is_a_step_on_the_way_to_closed() {
        assert!(matches!(
            phase(Td::LoggingOut),
            TelegramAuthPhase::SigningOut
        ));
        assert!(matches!(phase(Td::Closing), TelegramAuthPhase::SigningOut));
        assert!(matches!(phase(Td::Closed), TelegramAuthPhase::Closed));
    }
}
