// SPDX-License-Identifier: MIT
// Claude API client — the same integration as ClaudeService.swift: multi-turn
// chat with web search, and files sent as document/image/text blocks.
//
// Keys are retrieved only by Rust and sent directly to Anthropic over HTTPS.
// Stored keys and attached file bytes are never read back by the WebView.

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::secrets;

const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Server-side fallback: on a policy decline the API retries the same request on
/// a fallback model inside the same call, so the island never shows a dead end.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MAX_TOKENS: u32 = 4096;
/// Text and code files are inlined; anything larger is skipped, as on macOS.
const MAX_INLINE_TEXT: u64 = 200_000;

pub const DEFAULT_MODEL: &str = "claude-opus-5";

pub(crate) const SYSTEM_PROMPT: &str = "You are Mimo, a personal AI assistant living at the top of the user's screen. \
You have web search access and can help with absolutely anything — research, coding, finding places, recommendations, tasks, questions. \
Respond in the user's language. Be thorough and complete — use as much detail as the task requires. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.";

#[derive(Default)]
pub struct Chat {
    /// Full multi-turn history, including tool_use / tool_result blocks.
    messages: Mutex<Vec<Value>>,
    generation: AtomicU64,
}

impl Chat {
    pub fn reset(&self) {
        let mut messages = self.messages.lock().unwrap();
        self.generation.fetch_add(1, Ordering::AcqRel);
        messages.clear();
    }

    fn push(&self, message: Value, generation: u64) -> Result<(), String> {
        let mut messages = self.messages.lock().unwrap();
        if generation != self.generation.load(Ordering::Acquire) {
            return Err("The conversation changed. Send your message again.".into());
        }
        messages.push(message);
        Ok(())
    }

    fn pop(&self, generation: u64) {
        let mut messages = self.messages.lock().unwrap();
        if generation == self.generation.load(Ordering::Acquire) {
            messages.pop();
        }
    }

    fn snapshot(&self) -> Vec<Value> {
        self.messages.lock().unwrap().clone()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatFile {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatContext {
    File {
        name: String,
        path: String,
    },
    Files {
        files: Vec<ChatFile>,
    },
    Window {
        app_name: String,
        title: String,
        url: Option<String>,
    },
}

impl ChatContext {
    pub fn file_refs(&self) -> Vec<(&str, &str)> {
        match self {
            Self::File { name, path } => vec![(name.as_str(), path.as_str())],
            Self::Files { files } => files
                .iter()
                .map(|file| (file.name.as_str(), file.path.as_str()))
                .collect(),
            Self::Window { .. } => Vec::new(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
}

fn context_content(context: &Option<ChatContext>) -> Result<Vec<Value>, String> {
    let mut content = Vec::new();
    // An attachment belongs to this user turn, including files added later.
    crate::files::validate_context(&context)?;
    match &context {
        Some(context @ (ChatContext::File { .. } | ChatContext::Files { .. })) => {
            for (name, path) in context.file_refs() {
                content.push(file_block(path)?);
                content.push(json!({ "type": "text", "text": format!("File: {name}") }));
            }
        }
        Some(ChatContext::Window {
            app_name,
            title,
            url,
        }) => {
            let mut text = format!("Context — App: {app_name}, Window: {title}");
            if let Some(url) = url {
                text.push_str(&format!(", URL: {url}"));
            }
            content.push(json!({ "type": "text", "text": text }));
        }
        None => {}
    }
    Ok(content)
}

/// One chat turn. Returns the assistant's text, or a message the island shows
/// in the note view.
pub async fn send(
    chat: &Chat,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let key = secrets::get("anthropic-api-key")
        .ok_or_else(|| "API key missing. Open settings.".to_string())?;

    let generation = chat.generation.load(Ordering::Acquire);
    let mut content = context_content(&context)?;
    content.push(json!({ "type": "text", "text": query }));

    chat.push(json!({ "role": "user", "content": content }), generation)?;

    let body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "tools": [{ "type": "web_search_20260209", "name": "web_search", "max_uses": 5 }],
        "fallbacks": "default",
        "messages": chat.snapshot(),
    });

    let response = match call(&key, &body).await {
        Ok(v) => v,
        Err(err) => {
            chat.pop(generation); // keep the history consistent with what the model saw
            return Err(err);
        }
    };

    // A policy decline comes back as HTTP 200 with stop_reason "refusal".
    if response.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
        chat.pop(generation);
        let why = response
            .get("stop_details")
            .and_then(|d| d.get("explanation"))
            .and_then(Value::as_str)
            .unwrap_or("Claude declined this one.");
        return Err(why.to_string());
    }

    let Some(blocks) = response.get("content").and_then(Value::as_array).cloned() else {
        chat.pop(generation);
        return Err("Unexpected API response.".into());
    };

    // Store the whole content — tool_use / tool_result blocks included — so the
    // next turn has the right context.
    chat.push(
        json!({ "role": "assistant", "content": blocks.clone() }),
        generation,
    )?;

    let text = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if text.is_empty() {
        return Err("No response text.".into());
    }
    Ok(ChatReply { text })
}

async fn call(key: &str, body: &Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize Claude chat.".to_string())?;
    let mut auth = reqwest::header::HeaderValue::from_str(key)
        .map_err(|_| "The saved Claude key is invalid.".to_string())?;
    auth.set_sensitive(true);

    let response = client
        .post(ENDPOINT)
        .header("x-api-key", auth)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|_| "Could not reach Claude. Check your connection and try again.".to_string())?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // An upstream error can echo a submitted credential. Never forward it.
        return Err(match status.as_u16() {
            401 | 403 => "Claude could not authenticate. Check the key in Settings.".into(),
            429 => "Claude's usage limit was reached. Try again later.".into(),
            _ => format!("Claude request failed ({status}). Try again later."),
        });
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad API response: {e}"))
}

/// PDF → document block, image → image block, text/code → inline text.
/// Mirrors readFileAsBlock() in ClaudeService.swift.
fn file_block(path: &str) -> Result<Value, String> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let media_type = match ext.as_str() {
        "pdf" => Some(("document", "application/pdf")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "png" => Some(("image", "image/png")),
        "gif" => Some(("image", "image/gif")),
        "webp" => Some(("image", "image/webp")),
        _ => None,
    };

    if let Some((block_type, media)) = media_type {
        let len = std::fs::metadata(path)
            .map_err(|_| "Attach this file again.")?
            .len();
        if len > 20 * 1024 * 1024 {
            return Err("Attach a file smaller than 20 MB.".into());
        }
        let bytes = std::fs::read(path).map_err(|_| "Could not read the attachment.")?;
        return Ok(json!({
            "type": block_type,
            "source": { "type": "base64", "media_type": media, "data": base64(&bytes) },
        }));
    }

    let len = std::fs::metadata(path)
        .map_err(|_| "Attach this file again.")?
        .len();
    if len > MAX_INLINE_TEXT {
        return Err("Attach a text file smaller than 200 KB.".into());
    }
    let text =
        std::fs::read_to_string(path).map_err(|_| "This attachment must be a UTF-8 text file.")?;
    Ok(json!({ "type": "text", "text": format!("File contents:\n{text}") }))
}

/// Small standalone base64 encoder — not worth another dependency.
/// Also used for Stripe's basic auth.
pub(crate) fn base64_for(bytes: &[u8]) -> String {
    base64(bytes)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64;

    #[test]
    fn five_files_share_one_claude_user_turn() {
        let batch = crate::files::TestBatch::new(5);
        let parts = super::context_content(&Some(batch.context.clone())).unwrap();
        assert_eq!(parts.len(), 10);
        for index in 0..5 {
            assert!(parts[index * 2]["text"]
                .as_str()
                .unwrap()
                .contains(&format!("batch-content-{index}")));
        }
    }

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
    #[test]
    fn old_turns_cannot_modify_a_reset_conversation() {
        use super::*;
        let chat = Chat::default();
        let generation = chat.generation.load(Ordering::Acquire);
        chat.push(json!({"role":"user","content":"old"}), generation)
            .unwrap();
        chat.reset();
        let current = chat.generation.load(Ordering::Acquire);
        chat.push(json!({"role":"user","content":"new"}), current)
            .unwrap();
        chat.pop(generation);
        assert!(chat
            .push(json!({"role":"assistant","content":"stale"}), generation)
            .is_err());
        assert_eq!(chat.snapshot().len(), 1);
        assert_eq!(chat.snapshot()[0]["content"], "new");
    }
}
