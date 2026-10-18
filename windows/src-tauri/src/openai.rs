// SPDX-License-Identifier: MIT
//! Optional Mimo chat through the OpenAI API. Codex usage uses its own login.
use crate::chat_history::{self, Turn};
use crate::{
    claude::{ChatContext, ChatReply},
    secrets,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

#[derive(Default)]
struct Conversation {
    messages: Vec<Turn>,
}
#[derive(Default)]
pub struct OpenAiChat {
    conversation: Mutex<Conversation>,
    generation: AtomicU64,
}
impl OpenAiChat {
    pub fn reset(&self) {
        let mut conversation = self.conversation.lock().unwrap();
        self.generation.fetch_add(1, Ordering::AcqRel);
        *conversation = Conversation::default();
    }
}

fn content(query: &str, context: Option<&ChatContext>) -> Result<Vec<Value>, String> {
    crate::files::validate_context(&context.cloned())?;
    let mut parts = Vec::new();
    match context {
        Some(context @ (ChatContext::File { .. } | ChatContext::Files { .. })) => {
            for (name, path) in context.file_refs() {
                // Read only the file explicitly attached by the user.
                let path = std::path::Path::new(path);
                let extension = path
                    .extension()
                    .and_then(|v| v.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                let meta = std::fs::metadata(path).map_err(|_| "Attach this file again.")?;
                if meta.len() <= 20 * 1024 * 1024 {
                    let mime = match extension.as_str() {
                        "pdf" => Some("application/pdf"),
                        "png" => Some("image/png"),
                        "jpg" | "jpeg" => Some("image/jpeg"),
                        "webp" => Some("image/webp"),
                        "gif" => Some("image/gif"),
                        _ => None,
                    };
                    if let Some(mime) = mime {
                        let bytes =
                            std::fs::read(path).map_err(|_| "Could not read the attachment.")?;
                        let data =
                            format!("data:{mime};base64,{}", crate::claude::base64_for(&bytes));
                        parts.push(if mime == "application/pdf" {
                            json!({"type":"input_file","filename":name,"file_data":data})
                        } else {
                            json!({"type":"input_image","image_url":data})
                        });
                    } else if meta.len() <= 200_000 {
                        let text = std::fs::read_to_string(path)
                            .map_err(|_| "This attachment must be a UTF-8 text file.")?;
                        parts.push(
                            json!({"type":"input_text","text":format!("File: {name}\n{text}")}),
                        );
                    } else {
                        return Err("Attach a text file smaller than 200 KB.".into());
                    }
                } else {
                    return Err("Attach a file smaller than 20 MB.".into());
                }
            }
        }
        Some(ChatContext::Window {
            app_name,
            title,
            url,
        }) => {
            parts.push(json!({"type":"input_text","text":format!("Context — App: {app_name}, Window: {title}, URL: {}", url.as_deref().unwrap_or(""))}));
        }
        None => {}
    }
    parts.push(json!({"type":"input_text","text":query}));
    Ok(parts)
}

fn input(history: &[Turn]) -> Result<Vec<Value>, String> {
    history
        .iter()
        .map(|turn| {
            if turn.role == "assistant" {
                Ok(json!({"role":"assistant","content":turn.text}))
            } else {
                Ok(json!({"role":"user","content":content(&turn.text, turn.context.as_ref())?}))
            }
        })
        .collect()
}

fn reply_text(value: &Value) -> Option<String> {
    let text = value
        .get("output")?
        .as_array()?
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text.trim().into())
    }
}

pub async fn send(
    chat: &OpenAiChat,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let key = secrets::get("openai-api-key").ok_or("Add an OpenAI API key in Settings for Mimo chat. Codex hooks and usage do not need this key.")?;
    let generation = chat.generation.load(Ordering::Acquire);
    let mut history = {
        let conversation = chat.conversation.lock().unwrap();
        conversation.messages.clone()
    };
    history.push(Turn::user(query, context));
    chat_history::trim(&mut history);
    let input = input(&history)?;
    let body = json!({"model":model,"store":false,
        "instructions":crate::claude::SYSTEM_PROMPT,
        "tools":[{"type":"web_search"}], "max_output_tokens":4096, "input":input});
    drop(input);
    let mut auth = reqwest::header::HeaderValue::from_str(&format!("Bearer {key}"))
        .map_err(|_| "The saved OpenAI key is invalid.")?;
    auth.set_sensitive(true);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize OpenAI chat.")?;
    let request = client
        .post("https://api.openai.com/v1/responses")
        .header(reqwest::header::AUTHORIZATION, auth)
        .json(&body);
    drop(body);
    let response = request
        .send()
        .await
        .map_err(|_| "Could not reach OpenAI. Check your connection and try again.")?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => "OpenAI could not authenticate. Check the key in Settings.".into(),
            429 => "OpenAI's API usage limit was reached. Try again later.".into(),
            _ => format!("OpenAI request failed ({status}). Try again later."),
        });
    }
    // Keep response buffers bounded; error bodies and headers never reach the UI.
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the OpenAI response.")?
    {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err("The OpenAI reply was too large.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "OpenAI returned an invalid reply.")?;
    let text = reply_text(&value).ok_or("OpenAI returned no response text.")?;
    let mut conversation = chat.conversation.lock().unwrap();
    if generation != chat.generation.load(Ordering::Acquire) {
        return Err("The conversation changed. Send your message again.".into());
    }
    // EasyInputMessage accepts assistant text directly for manual replay.
    history.push(Turn::assistant(text.clone()));
    chat_history::trim(&mut history);
    // Keep compact text turns and a file reference, never binary/base64 history.
    *conversation = Conversation { messages: history };
    Ok(ChatReply { text })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn five_attachments_stay_in_order_on_the_same_user_turn() {
        let batch = crate::files::TestBatch::new(5);
        let parts = content("Compare all five", Some(&batch.context)).unwrap();
        assert_eq!(parts.len(), 6);
        for (index, part) in parts[..5].iter().enumerate() {
            assert!(part["text"]
                .as_str()
                .unwrap()
                .contains(&format!("batch-content-{index}")));
        }
        assert_eq!(parts[5]["text"], "Compare all five");
    }
    #[test]
    fn an_attachment_added_later_belongs_to_that_turn() {
        let history = vec![
            Turn::user("first".into(), None),
            Turn::assistant("reply".into()),
            Turn::user(
                "second".into(),
                Some(ChatContext::Window {
                    app_name: "Editor".into(),
                    title: "later-context".into(),
                    url: None,
                }),
            ),
        ];
        let input = input(&history).unwrap();
        assert_eq!(input[0]["content"].as_array().unwrap().len(), 1);
        assert!(input[2]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("later-context"));
        assert_eq!(input[2]["content"][1]["text"], "second");
        assert!(input[1]["content"].is_string());
    }
    #[test]
    fn response_parser_excludes_internal_items_and_raw_errors() {
        assert_eq!(reply_text(&json!({"output":[{"type":"reasoning","content":[{"type":"output_text","text":"synthetic-private"}]},
            {"type":"message","content":[{"type":"output_text","text":"Hello"},{"type":"refusal","refusal":"not plain text"}]}]})).as_deref(), Some("Hello"));
        assert!(reply_text(&json!({"error":{"message":"synthetic-private"}})).is_none());
        assert!(reply_text(&json!({"output":[]})).is_none());
    }
}
