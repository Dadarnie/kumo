// SPDX-License-Identifier: MIT
//! Claude supplies these numeric fields to its documented status-line command.
//! Keep one reading, in memory only; never read auth files or transcripts.
use crate::codex_usage::{CodexUsage, UsageWindow};
use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    #[serde(flatten)]
    pub account: CodexUsage,
    pub context_used_percent: Option<f64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub session_cost_usd: Option<f64>,
}

fn percent(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && (0.0..=100.0).contains(n))
}
fn window(value: &Value, minutes: u64) -> Option<UsageWindow> {
    Some(UsageWindow {
        used_percent: percent(value.get("used_percentage")?)?,
        window_minutes: Some(minutes),
        resets_at: value
            .get("resets_at")
            .and_then(Value::as_u64)
            .filter(|&n| n <= 4102444800),
    })
}
pub fn parse(payload: &Value) -> Option<ClaudeUsage> {
    let usage = payload.get("usage")?;
    let rates = usage.get("rate_limits").unwrap_or(&Value::Null);
    let context = usage.get("context_window").unwrap_or(&Value::Null);
    let primary = rates.get("five_hour").and_then(|v| window(v, 300));
    let secondary = rates.get("seven_day").and_then(|v| window(v, 10080));
    let context_used_percent = context.get("used_percentage").and_then(percent);
    let tokens = |name| {
        context
            .get(name)
            .and_then(Value::as_u64)
            .filter(|&n| n <= 9_007_199_254_740_991)
    };
    let input_tokens = tokens("total_input_tokens");
    let output_tokens = tokens("total_output_tokens");
    let session_cost_usd = usage
        .pointer("/cost/total_cost_usd")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && (0.0..=1_000_000.0).contains(n));
    if primary.is_none()
        && secondary.is_none()
        && context_used_percent.is_none()
        && input_tokens.is_none()
        && output_tokens.is_none()
        && session_cost_usd.is_none()
    {
        return None;
    }
    Some(ClaudeUsage {
        account: CodexUsage {
            primary,
            secondary,
            checked_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            ..CodexUsage::default()
        },
        context_used_percent,
        input_tokens,
        output_tokens,
        session_cost_usd,
    })
}

#[derive(Default)]
pub struct UsageCache(Mutex<Option<ClaudeUsage>>);
impl UsageCache {
    pub fn update(&self, payload: &Value) -> Option<ClaudeUsage> {
        let snapshot = parse(payload)?;
        *self.0.lock().unwrap() = Some(snapshot.clone());
        Some(snapshot)
    }
    pub fn read(&self) -> Option<ClaudeUsage> {
        self.0.lock().unwrap().clone()
    }
    pub fn clear(&self) {
        *self.0.lock().unwrap() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn retains_only_valid_numbers_and_replaces_previous_reading() {
        let cache = UsageCache::default();
        let payload = json!({"usage":{
            "rate_limits":{"five_hour":{"used_percentage":24,"resets_at":1900000000,"access_token":"synthetic-private"}},
            "context_window":{"used_percentage":30,"total_input_tokens":100,"total_output_tokens":20,"transcript":"synthetic-private"},
            "cost":{"total_cost_usd":0.25},"session_id":"synthetic-private","model":"synthetic-private"
        }});
        let snapshot = cache.update(&payload).unwrap();
        assert_eq!(snapshot.account.primary.unwrap().used_percent, 24.0);
        assert!(!serde_json::to_string(&cache.read())
            .unwrap()
            .contains("synthetic-private"));
        cache
            .update(&json!({"usage":{"context_window":{"used_percentage":10}}}))
            .unwrap();
        assert!(cache.read().unwrap().account.primary.is_none());
        cache.clear();
        assert!(cache.read().is_none());
        assert!(
            parse(&json!({"usage":{"rate_limits":{"five_hour":{"used_percentage":101}}}}))
                .is_none()
        );
    }
}
