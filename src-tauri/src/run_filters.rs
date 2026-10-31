use std::collections::BTreeSet;

use lethe_adapter::{ContentType, EnumeratePlan};
use lethe_core::filter::{FilterSpec, KeywordMatch};
use serde::{Deserialize, Serialize};
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time};

use crate::CommandError;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FilterRequest {
    #[serde(default)]
    pub content_types: Vec<ContentType>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub keyword: Option<String>,
    #[serde(default)]
    pub keyword_regex: bool,
    #[serde(default = "default_true")]
    pub keyword_case_insensitive: bool,
    #[serde(default = "default_true")]
    pub fold_yo_ye: bool,
    #[serde(default)]
    pub allowlist_ids: Vec<String>,
}

pub fn plan_from_filter(filter: &FilterSpec) -> EnumeratePlan {
    EnumeratePlan {
        content_types: filter.content_types.clone(),
        scope: None,
        date_from: filter.date_from,
        date_to: filter.date_to,
    }
}

pub fn to_filter_spec(req: &FilterRequest) -> Result<FilterSpec, CommandError> {
    let keyword = req
        .keyword
        .as_deref()
        .map(str::trim)
        .filter(|pattern| !pattern.is_empty())
        .map(|pattern| KeywordMatch {
            pattern: pattern.to_owned(),
            regex: req.keyword_regex,
            case_insensitive: req.keyword_case_insensitive,
            fold_yo_ye: req.fold_yo_ye,
        });

    Ok(FilterSpec {
        content_types: req.content_types.iter().copied().collect(),
        date_from: parse_date_boundary(req.date_from.as_deref(), false)?,
        date_to: parse_date_boundary(req.date_to.as_deref(), true)?,
        keyword,
        engagement_max: None,
        allowlist_ids: trimmed_set(&req.allowlist_ids),
    })
}

fn default_true() -> bool {
    true
}

fn trimmed_set(values: &[String]) -> BTreeSet<String> {
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn parse_date_boundary(
    value: Option<&str>,
    end_of_day: bool,
) -> Result<Option<OffsetDateTime>, CommandError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let date = parse_date(value)?;
    let time = if end_of_day {
        Time::from_hms(23, 59, 59)?
    } else {
        Time::MIDNIGHT
    };
    Ok(Some(PrimitiveDateTime::new(date, time).assume_utc()))
}

fn parse_date(value: &str) -> Result<Date, CommandError> {
    let mut parts = value.split('-');
    let year = parts
        .next()
        .and_then(|part| part.parse::<i32>().ok())
        .ok_or_else(|| CommandError::msg(format!("invalid date: {value}")))?;
    let month = parts
        .next()
        .and_then(|part| part.parse::<u8>().ok())
        .and_then(|month| Month::try_from(month).ok())
        .ok_or_else(|| CommandError::msg(format!("invalid date: {value}")))?;
    let day = parts
        .next()
        .and_then(|part| part.parse::<u8>().ok())
        .ok_or_else(|| CommandError::msg(format!("invalid date: {value}")))?;
    if parts.next().is_some() {
        return Err(CommandError::msg(format!("invalid date: {value}")));
    }
    Date::from_calendar_date(year, month, day).map_err(CommandError::from)
}
