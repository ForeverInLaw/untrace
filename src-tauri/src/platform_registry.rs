use std::sync::Arc;

use lethe_adapter::{
    Capabilities, ContentType, Descriptor, PlatformAdapter, PushdownDim, RiskClass,
};
use lethe_bluesky::BlueskyAdapter;
use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlatformStatus {
    Live,
    Queued,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    AppPassword,
    OAuthPlanned,
    ByoCredentials,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlatformCapabilities {
    pub can_redact: bool,
    pub can_undo: bool,
    pub batch_delete_max: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlatformSummary {
    pub id: String,
    pub display_name: String,
    pub status: PlatformStatus,
    pub risk_class: RiskClass,
    pub content_types: Vec<ContentType>,
    pub pushdown: Vec<PushdownDim>,
    pub capabilities: PlatformCapabilities,
    pub auth_mode: AuthMode,
    pub note: String,
}

pub fn all(pds_host: &str) -> Vec<PlatformSummary> {
    let bluesky = BlueskyAdapter::new(
        Arc::new(lethe_net::Egress::new(std::iter::empty::<String>())),
        pds_host,
    );

    let mut platforms = vec![from_descriptor(
        bluesky.descriptor(),
        PlatformStatus::Live,
        AuthMode::AppPassword,
        "AT Protocol tracer: posts and reactions",
    )];

    let mut telegram = planned(
        "telegram",
        "Telegram",
        RiskClass::Green,
        vec![ContentType::Dm, ContentType::Media],
        vec![PushdownDim::Scope, PushdownDim::DateRange],
        AuthMode::ByoCredentials,
        "Own messages in selected chats",
    );
    if cfg!(any(
        feature = "telegram-tdlib-docs",
        feature = "telegram-tdlib-local",
        feature = "telegram-tdlib-download"
    )) {
        telegram.status = PlatformStatus::Live;
    }

    platforms.extend([
        planned(
            "x",
            "X / Twitter",
            RiskClass::Red,
            vec![ContentType::Post, ContentType::Reaction, ContentType::Media],
            vec![PushdownDim::ContentType, PushdownDim::DateRange],
            AuthMode::OAuthPlanned,
            "API policy map before live delete",
        ),
        planned(
            "reddit",
            "Reddit",
            RiskClass::Yellow,
            vec![ContentType::Post, ContentType::Comment],
            vec![PushdownDim::ContentType, PushdownDim::Scope],
            AuthMode::OAuthPlanned,
            "Posts and comments next contract",
        ),
        planned(
            "instagram",
            "Instagram",
            RiskClass::Red,
            vec![ContentType::Post, ContentType::Comment, ContentType::Media],
            vec![PushdownDim::ContentType],
            AuthMode::OAuthPlanned,
            "Media backup comes first",
        ),
        telegram,
        planned(
            "vk",
            "VK",
            RiskClass::Green,
            vec![
                ContentType::Post,
                ContentType::Comment,
                ContentType::Reaction,
                ContentType::Media,
            ],
            vec![PushdownDim::ContentType, PushdownDim::Scope],
            AuthMode::OAuthPlanned,
            "Regional adapter contract exists",
        ),
    ]);

    platforms
}

fn from_descriptor(
    descriptor: &Descriptor,
    status: PlatformStatus,
    auth_mode: AuthMode,
    note: impl Into<String>,
) -> PlatformSummary {
    PlatformSummary {
        id: descriptor.id.to_owned(),
        display_name: descriptor.display_name.to_owned(),
        status,
        risk_class: descriptor.risk_class,
        content_types: descriptor.content_types.to_vec(),
        pushdown: descriptor.pushdown.to_vec(),
        capabilities: capabilities(&descriptor.capabilities),
        auth_mode,
        note: note.into(),
    }
}

fn planned(
    id: impl Into<String>,
    display_name: impl Into<String>,
    risk_class: RiskClass,
    content_types: Vec<ContentType>,
    pushdown: Vec<PushdownDim>,
    auth_mode: AuthMode,
    note: impl Into<String>,
) -> PlatformSummary {
    PlatformSummary {
        id: id.into(),
        display_name: display_name.into(),
        status: PlatformStatus::Queued,
        risk_class,
        content_types,
        pushdown,
        capabilities: PlatformCapabilities {
            can_redact: false,
            can_undo: false,
            batch_delete_max: 0,
        },
        auth_mode,
        note: note.into(),
    }
}

fn capabilities(capabilities: &Capabilities) -> PlatformCapabilities {
    PlatformCapabilities {
        can_redact: capabilities.can_redact,
        can_undo: capabilities.can_undo,
        batch_delete_max: capabilities.batch_delete_max,
    }
}
