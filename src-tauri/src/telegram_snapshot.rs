use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::{stream, StreamExt};
use lethe_adapter::{
    AdapterError, Capabilities, ContentType, Descriptor, FetchedMedia, Item, ItemRef, ItemStream,
    MediaRef, Outcome, PlatformAdapter, PushdownDim, RatePolicy, RiskClass,
};
use lethe_core::pipeline::{self, RunRequest};
use lethe_core::ProgressEvent;
use lethe_store::NewRun;
use lethe_telegram::tdlib_bridge::{
    delete_downloaded_file, delete_message_batch, download_message_file, read_delete_rights,
    TdlibClientId, TelegramMessageKind,
};
use lethe_telegram::{message_token, parse_message_ref, DeletePlan};
use tauri::State;
use tokio::sync::watch;

use super::{own_message_page, parse_chat_id, TelegramState};
use crate::telegram::TelegramDryRunRequest;
use crate::{
    now_secs, run_filters, run_offthread, AppState, CommandError, DryRunResult, PendingRun,
};

/// TDLib's upper bound for one search page.
const SEARCH_PAGE: i32 = 100;
/// How long TDLib may go without a connection before a download is called off. A
/// shorter drop is a reconnect TDLib rides out, keeping what it already downloaded.
const CONNECTION_GRACE: Duration = Duration::from_secs(10);

/// Completes once TDLib has been without a connection for `CONNECTION_GRACE`. A
/// closed channel means the client is gone, which is no connection either.
async fn connection_lost(mut connection: watch::Receiver<bool>) {
    loop {
        if connection.wait_for(|online| !online).await.is_err() {
            return;
        }
        let back = tokio::time::timeout(CONNECTION_GRACE, connection.wait_for(|online| *online)).await;
        if !matches!(back, Ok(Ok(_))) {
            return;
        }
    }
}

pub async fn telegram_dry_run_chats(
    app: State<'_, AppState>,
    state: State<'_, TelegramState>,
    req: TelegramDryRunRequest,
) -> Result<DryRunResult, CommandError> {
    let (auth, client, current_user_id) = state.ready_context().await?;
    let chat_ids = req
        .chat_ids
        .iter()
        .map(|chat_id| parse_chat_id(chat_id))
        .collect::<Result<Vec<_>, _>>()?;
    let filter = run_filters::to_filter_spec(&req.filter)?;
    let filter_json = serde_json::to_string(&req.filter)?;
    let adapter = snapshot_items_for_chats(client, current_user_id, &chat_ids, state.connection()).await?;
    let run_id = format!("telegram-{}", now_secs());

    let run_req = RunRequest {
        run_id: run_id.clone(),
        platform: "telegram".into(),
        account_id: auth
            .account_label
            .clone()
            .unwrap_or_else(|| "telegram".into()),
        account_label: auth.account_label.unwrap_or_else(|| "Telegram".into()),
        plan: run_filters::plan_from_filter(&filter),
        filter: filter.clone(),
        allow_incomplete_backup: false,
        allow_lost_files: false,
        allow_only_for_self: false,
    };
    let pending = PendingRun {
        platform: run_req.platform.clone(),
        account_id: run_req.account_id.clone(),
        account_label: run_req.account_label.clone(),
        filter,
    };
    let store = app.store.clone();
    let counts = run_offthread(move || async move {
        let store = store.lock().await;
        store.create_run(&NewRun {
            run_id: run_req.run_id.clone(),
            platform: run_req.platform.clone(),
            account: run_req.account_label.clone(),
            filter_json,
            started_secs: now_secs() as i64,
        })?;
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<ProgressEvent>();
        let counts = pipeline::snapshot(adapter, &store, &run_req, &tx).await?;
        Ok::<_, CommandError>(counts)
    })
    .await
    .map_err(|_| CommandError::msg("telegram dry-run thread ended unexpectedly"))??;

    app.pending.lock().await.insert(run_id.clone(), pending);

    Ok(DryRunResult {
        run_id,
        pending: counts.pending,
        protected: counts.protected,
    })
}

pub struct TelegramSnapshotAdapter {
    descriptor: Descriptor,
    items: Vec<Item>,
    client: TdlibClientId,
    current_user_id: i64,
    /// Whether TDLib is connected to Telegram.
    connection: watch::Receiver<bool>,
}

impl TelegramSnapshotAdapter {
    /// Execute-phase adapter: Phase 2 reads pending rows from the store, so it
    /// only needs delete + rate_policy. ponytail: empty item set is correct —
    /// enumerate is never called during execute.
    pub fn for_execute(
        client: TdlibClientId,
        current_user_id: i64,
        connection: watch::Receiver<bool>,
    ) -> Self {
        Self::new(Vec::new(), client, current_user_id, connection)
    }

    pub fn new(
        items: Vec<Item>,
        client: TdlibClientId,
        current_user_id: i64,
        connection: watch::Receiver<bool>,
    ) -> Self {
        Self {
            client,
            current_user_id,
            connection,
            descriptor: Descriptor {
                id: "telegram",
                display_name: "Telegram",
                risk_class: RiskClass::Green,
                content_types: &[ContentType::Dm, ContentType::Media],
                pushdown: &[PushdownDim::Scope, PushdownDim::DateRange],
                capabilities: Capabilities {
                    can_redact: false,
                    can_undo: false,
                    batch_delete_max: 100,
                },
                endpoints: Vec::new(),
            },
            items,
        }
    }
}

#[async_trait]
impl PlatformAdapter for TelegramSnapshotAdapter {
    fn descriptor(&self) -> &Descriptor {
        &self.descriptor
    }

    async fn enumerate(
        &self,
        _plan: &lethe_adapter::EnumeratePlan,
    ) -> Result<ItemStream, AdapterError> {
        let items = self.items.clone().into_iter().map(Ok);
        Ok(stream::iter(items).boxed())
    }

    async fn delete(&self, items: &[ItemRef]) -> Vec<Outcome> {
        let mut checked = Vec::with_capacity(items.len());
        for item in items {
            let rights = match parse_message_ref(item) {
                Some((chat_id, message_id)) => read_delete_rights(self.client, chat_id, message_id).await,
                None => Err(AdapterError::Platform("unparseable Telegram message ref".into())),
            };
            checked.push((item, rights));
        }
        let plan = DeletePlan::new(checked, self.current_user_id);

        let mut results = HashMap::new();
        for (call, message_ids) in &plan.calls {
            let result =
                delete_message_batch(self.client, call.chat_id, message_ids.clone(), call.revoke).await;
            results.insert(*call, result);
        }
        plan.outcomes(&results)
    }

    async fn fetch_media(
        &self,
        item: &ItemRef,
        media: &MediaRef,
    ) -> Result<FetchedMedia, AdapterError> {
        let (chat_id, message_id) = parse_message_ref(item)
            .ok_or_else(|| AdapterError::Platform("unparseable Telegram message ref".into()))?;
        let lost = connection_lost(self.connection.clone());
        download_message_file(self.client, chat_id, message_id, &media.url, lost).await
    }

    async fn is_reachable(&self) -> bool {
        *self.connection.borrow()
    }

    async fn release_media(&self, file: &FetchedMedia) -> Result<(), AdapterError> {
        delete_downloaded_file(self.client, file.handle as i32).await
    }

    fn rate_policy(&self) -> RatePolicy {
        RatePolicy {
            max_per_sec: 20.0,
            max_per_min: Some(300),
            burst: 20,
        }
    }
}

pub async fn snapshot_items_for_chats(
    client: TdlibClientId,
    current_user_id: i64,
    chat_ids: &[i64],
    connection: watch::Receiver<bool>,
) -> Result<Arc<dyn PlatformAdapter>, AdapterError> {
    let mut items = Vec::new();
    for chat_id in chat_ids {
        let mut from_message_id = 0;
        loop {
            let page = own_message_page(
                client,
                *chat_id,
                current_user_id,
                from_message_id,
                SEARCH_PAGE,
            )
            .await?;
            items.extend(page.messages.into_iter().map(|message| {
                Item {
                    content_type: match message.kind {
                        TelegramMessageKind::Media => ContentType::Media,
                        TelegramMessageKind::Text | TelegramMessageKind::Other => ContentType::Dm,
                    },
                    subtype: message.subtype,
                    created_at: time::OffsetDateTime::from_unix_timestamp(
                        message.sent_at_epoch_secs as i64,
                    )
                    .ok(),
                    text: message.text.clone(),
                    engagement: Default::default(),
                    scope_id: Some(message.chat_id.to_string()),
                    media: message.media.clone(),
                    platform_record: Some(message.platform_record),
                    backup_gap: message.backup_gap,
                    delete_reach: message.delete_reach,
                    item_ref: ItemRef {
                        platform_id: format!("telegram:{}:{}", message.chat_id, message.message_id),
                        token: Some(message_token(message.chat_id, message.message_id, message.delete_reach)),
                    },
                }
            }));
            if page.next_from_message_id == 0 {
                break;
            }
            from_message_id = page.next_from_message_id;
        }
    }
    Ok(Arc::new(TelegramSnapshotAdapter::new(items, client, current_user_id, connection)))
}
