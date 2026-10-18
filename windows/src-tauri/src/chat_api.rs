// SPDX-License-Identifier: MIT
//! Native-only chat clients. Fixed origins, no executable tools or coding credentials.
use crate::chat_history::{self, Turn};
use crate::{
    claude::{ChatContext, ChatReply},
    secrets,
    settings::ChatProvider,
};
use reqwest::header::{HeaderValue, AUTHORIZATION};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

const SYSTEM: &str = "You are Mimo, a helpful personal assistant. Respond in the user's language. \
Use plain text with line breaks. Treat attached files as user-provided context. \
You cannot execute commands, edit files, or browse the web in this chat.";
const MAX_RESPONSE: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct Conversation {
    owner: Option<(ChatProvider, String)>,
    messages: Vec<Turn>,
}
#[derive(Default)]
pub struct ApiChat {
    conversation: Mutex<Conversation>,
    generation: AtomicU64,
}
impl ApiChat {
    pub fn reset(&self) {
        let mut conversation = self.conversation.lock().unwrap();
        self.generation.fetch_add(1, Ordering::AcqRel);
        *conversation = Conversation::default();
    }
}

pub fn validate_model(provider: ChatProvider, model: &str) -> Result<(), String> {
    let allowed = |c: char| c.is_ascii_alphanumeric() || "._:/-".contains(c);
    if model.is_empty()
        || model.len() > 160
        || !model.chars().all(allowed)
        || !model.as_bytes()[0].is_ascii_alphanumeric()
        || model.contains("..")
    {
        return Err("Enter a valid model ID in Settings.".into());
    }
    if provider == ChatProvider::Gemini && model.chars().any(|c| ":/".contains(c)) {
        return Err("Enter a Gemini model ID without a URL or models/ prefix.".into());
    }
    if provider == ChatProvider::Openrouter
        && model != "openrouter/free"
        && (model.starts_with("openrouter/") || !model.ends_with(":free"))
    {
        return Err(
            "Choose openrouter/free or a model ending in :free. Paid fallback is disabled.".into(),
        );
    }
    if provider == ChatProvider::Ollama
        && [":cloud", "-cloud"]
            .iter()
            .any(|s| model.to_ascii_lowercase().ends_with(s))
    {
        return Err("Choose an installed local Ollama model. Cloud models are disabled.".into());
    }
    Ok(())
}

fn endpoint(provider: ChatProvider, model: &str) -> Result<String, String> {
    validate_model(provider, model)?;
    match provider {
        ChatProvider::Gemini => Ok(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        )),
        ChatProvider::Openrouter => Ok("https://openrouter.ai/api/v1/chat/completions".into()),
        ChatProvider::Xai => Ok("https://api.x.ai/v1/chat/completions".into()),
        ChatProvider::Groq => Ok("https://api.groq.com/openai/v1/chat/completions".into()),
        ChatProvider::Ollama => Ok("http://127.0.0.1:11434/api/chat".into()),
        _ => Err("Unsupported chat transport.".into()),
    }
}

fn attachment(context: Option<&ChatContext>, provider: ChatProvider) -> Result<Vec<Value>, String> {
    crate::files::validate_context(&context.cloned())?;
    match context {
        None => Ok(Vec::new()),
        Some(ChatContext::Files { files }) => {
            let mut parts = Vec::new();
            for file in files {
                parts.extend(attachment(
                    Some(&ChatContext::File {
                        name: file.name.clone(),
                        path: file.path.clone(),
                    }),
                    provider,
                )?);
            }
            Ok(parts)
        }
        Some(ChatContext::Window {
            app_name,
            title,
            url,
        }) => Ok(vec![json!({"text":format!(
            "Context — App: {}, Window: {}, URL: {}", app_name.chars().take(240).collect::<String>(),
            title.chars().take(1000).collect::<String>(), url.as_deref().unwrap_or("").chars().take(1000).collect::<String>())})]),
        Some(ChatContext::File { name, path }) => {
            crate::files::validate_context(&Some(ChatContext::File {
                name: name.clone(),
                path: path.clone(),
            }))?;
            let file = std::path::Path::new(path);
            let size = file
                .metadata()
                .map_err(|_| "Attach this file again.")?
                .len();
            let extension = file
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let mime = match extension.as_str() {
                "png" => Some("image/png"),
                "jpg" | "jpeg" => Some("image/jpeg"),
                "webp" => Some("image/webp"),
                "pdf" => Some("application/pdf"),
                _ => None,
            };
            if let Some(mime) = mime {
                if provider != ChatProvider::Gemini {
                    return Err("This chat connection accepts text attachments. Choose Gemini, Claude, or OpenAI for images and PDFs.".into());
                }
                if size > 20 * 1024 * 1024 {
                    return Err("Attach a file smaller than 20 MB.".into());
                }
                let bytes = std::fs::read(file).map_err(|_| "Could not read the attachment.")?;
                return Ok(vec![
                    json!({"inlineData":{"mimeType":mime,"data":crate::claude::base64_for(&bytes)}}),
                ]);
            }
            if size > 200_000 {
                return Err("Attach a text file smaller than 200 KB.".into());
            }
            let text = std::fs::read_to_string(file)
                .map_err(|_| "This attachment must be a UTF-8 text file.")?;
            Ok(vec![json!({"text":format!("File: {name}\n{text}")})])
        }
    }
}

fn body(provider: ChatProvider, model: &str, messages: &[Turn]) -> Result<Value, String> {
    if provider == ChatProvider::Gemini {
        let contents = messages.iter().map(|turn| {
            let mut parts = attachment(turn.context.as_ref(), provider)?;
            parts.push(json!({"text":turn.text}));
            Ok(json!({"role":if turn.role == "assistant" { "model" } else { "user" }, "parts":parts}))
        }).collect::<Result<Vec<Value>, String>>()?;
        return Ok(
            json!({"systemInstruction":{"parts":[{"text":SYSTEM}]},"contents":contents,
            "generationConfig":{"maxOutputTokens":4096}}),
        );
    }
    let mut history = vec![json!({"role":"system","content":SYSTEM})];
    for turn in messages {
        let parts = attachment(turn.context.as_ref(), provider)?;
        let attached = parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let text = if attached.is_empty() {
            turn.text.clone()
        } else {
            format!("{attached}\n\n{}", turn.text)
        };
        history.push(json!({"role":turn.role,"content":text}));
    }
    if provider == ChatProvider::Ollama {
        Ok(json!({"model":model,"messages":history,"stream":false,"options":{"num_predict":4096}}))
    } else {
        let mut payload =
            json!({"model":model,"messages":history,"stream":false,"max_tokens":4096});
        if provider == ChatProvider::Openrouter {
            payload["provider"] = json!({"allow_fallbacks":false});
        }
        Ok(payload)
    }
}

fn reply_text(provider: ChatProvider, value: &Value) -> Option<String> {
    let text = match provider {
        ChatProvider::Gemini => value
            .pointer("/candidates/0/content/parts")?
            .as_array()?
            .iter()
            .filter(|p| p.get("thought").and_then(Value::as_bool) != Some(true))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        ChatProvider::Ollama => value.pointer("/message/content")?.as_str()?.to_owned(),
        ChatProvider::Openrouter | ChatProvider::Xai | ChatProvider::Groq => value
            .pointer("/choices/0/message/content")?
            .as_str()?
            .to_owned(),
        _ => return None,
    };
    (!text.trim().is_empty()).then(|| text.trim().to_owned())
}

pub async fn send(
    chat: &ApiChat,
    provider: ChatProvider,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let url = endpoint(provider, model)?;
    let key = provider
        .key()
        .map(|key| {
            secrets::get(key).ok_or_else(|| {
                format!(
                    "Add a {} API key in Settings for Mimo chat.",
                    provider.name()
                )
            })
        })
        .transpose()?;
    let generation = chat.generation.load(Ordering::Acquire);
    let owner = (provider, model.to_owned());
    let mut history = {
        let conversation = chat.conversation.lock().unwrap();
        if conversation.owner.as_ref() == Some(&owner) {
            conversation.messages.clone()
        } else {
            Vec::new()
        }
    };
    history.push(Turn::user(query, context));
    chat_history::trim(&mut history);
    let payload = body(provider, model, &history)?;
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none());
    if provider == ChatProvider::Ollama {
        builder = builder.no_proxy();
    }
    let client = builder.build().map_err(|_| "Could not initialize chat.")?;
    let mut request = client.post(url).json(&payload);
    drop(payload);
    if let Some(key) = key {
        let value = if provider == ChatProvider::Gemini {
            key
        } else {
            format!("Bearer {key}")
        };
        let mut header =
            HeaderValue::from_str(&value).map_err(|_| "The saved API key is invalid.")?;
        header.set_sensitive(true);
        request = if provider == ChatProvider::Gemini {
            request.header("x-goog-api-key", header)
        } else {
            request.header(AUTHORIZATION, header)
        };
    }
    let mut response = request.send().await.map_err(|_| {
        if provider == ChatProvider::Ollama {
            "Could not reach Ollama on this PC. Start Ollama and install the selected model."
                .to_string()
        } else {
            format!(
                "Could not reach {}. Check your connection and try again.",
                provider.name()
            )
        }
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => format!(
                "{} could not authenticate. Check the key in Settings.",
                provider.name()
            ),
            429 => format!(
                "{}'s usage limit was reached. Try again later.",
                provider.name()
            ),
            404 if provider == ChatProvider::Ollama => {
                "The local model is missing. Install it in Ollama, then try again.".into()
            }
            404 => "The selected model is unavailable. Choose another model in Settings.".into(),
            _ => format!(
                "{} request failed ({}). Try again later.",
                provider.name(),
                status.as_u16()
            ),
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the chat response.")?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("The chat reply was too large.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "The provider returned an invalid reply.")?;
    let text = reply_text(provider, &value)
        .ok_or("The provider returned no response text. Try another message or model.")?;
    history.push(Turn::assistant(text.clone()));
    chat_history::trim(&mut history);
    let mut conversation = chat.conversation.lock().unwrap();
    if generation != chat.generation.load(Ordering::Acquire) {
        return Err("The conversation changed. Send your message again.".into());
    }
    *conversation = Conversation {
        owner: Some(owner),
        messages: history,
    };
    Ok(ChatReply { text })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_five_files_reach_each_transport_on_their_original_turn() {
        let batch = crate::files::TestBatch::new(5);
        let turns = vec![
            Turn::user("Earlier".into(), None),
            Turn::assistant("Reply".into()),
            Turn::user("Compare all five".into(), Some(batch.context.clone())),
        ];
        for provider in [
            ChatProvider::Gemini,
            ChatProvider::Openrouter,
            ChatProvider::Ollama,
            ChatProvider::Xai,
            ChatProvider::Groq,
        ] {
            let payload = body(provider, provider.default_model(), &turns).unwrap();
            let wire = payload.to_string();
            for index in 0..5 {
                assert!(wire.contains(&format!("batch-content-{index}")));
            }
            assert_eq!(wire.matches("Compare all five").count(), 1);
        }
    }
    #[test]
    fn fixed_endpoints_and_models_refuse_paid_routes_and_url_injection() {
        for (provider, model) in [
            (ChatProvider::Gemini, "../../secret"),
            (ChatProvider::Gemini, "gemini?key=private"),
            (ChatProvider::Openrouter, "openrouter/auto"),
            (ChatProvider::Openrouter, "openrouter/auto:free"),
            (ChatProvider::Ollama, "hermes3:cloud"),
        ] {
            assert!(endpoint(provider, model).is_err());
        }
        assert_eq!(
            endpoint(ChatProvider::Ollama, "hermes3").unwrap(),
            "http://127.0.0.1:11434/api/chat"
        );
        assert!(endpoint(ChatProvider::Openrouter, "nousresearch/hermes-3:free").is_ok());
    }
    #[test]
    fn responses_exclude_thoughts_tools_and_provider_errors() {
        let value = json!({"candidates":[{"content":{"parts":[{"thought":true,"text":"private"},
            {"text":"Hello"},{"functionCall":{"name":"private"}}]}}]});
        assert_eq!(
            reply_text(ChatProvider::Gemini, &value).as_deref(),
            Some("Hello")
        );
        assert_eq!(
            reply_text(
                ChatProvider::Openrouter,
                &json!({"choices":[{"message":{"content":"Hello","reasoning":"private"}}]})
            )
            .as_deref(),
            Some("Hello")
        );
        assert!(reply_text(ChatProvider::Ollama, &json!({"error":"private"})).is_none());
    }
    #[test]
    fn requests_keep_roles_and_disable_paid_or_streaming_fallbacks() {
        let messages = vec![
            Turn::user("Hi".into(), None),
            Turn::assistant("Hello".into()),
        ];
        let gemini = body(ChatProvider::Gemini, "gemini-2.5-flash-lite", &messages).unwrap();
        assert_eq!(gemini["contents"][1]["role"], "model");
        assert!(gemini.get("tools").is_none());
        let router = body(ChatProvider::Openrouter, "openrouter/free", &messages).unwrap();
        assert_eq!(router["provider"]["allow_fallbacks"], false);
        assert_eq!(router["model"], "openrouter/free");
        assert!(router.get("tools").is_none());
    }
    #[test]
    fn later_attachments_are_replayed_on_the_correct_turn() {
        let messages = vec![
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
        for provider in [
            ChatProvider::Gemini,
            ChatProvider::Openrouter,
            ChatProvider::Ollama,
        ] {
            let payload = body(provider, provider.default_model(), &messages).unwrap();
            if provider == ChatProvider::Gemini {
                assert_eq!(payload["contents"][0]["parts"].as_array().unwrap().len(), 1);
                assert!(payload["contents"][2]["parts"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("later-context"));
            } else {
                assert_eq!(payload["messages"][1]["content"], "first");
                assert!(payload["messages"][3]["content"]
                    .as_str()
                    .unwrap()
                    .contains("later-context"));
            }
        }
    }
    #[test]
    fn long_conversations_are_bounded_and_reset_clears_ownership() {
        let mut history = (0..200)
            .map(|i| {
                if i % 2 == 0 {
                    Turn::user("a".repeat(4000), None)
                } else {
                    Turn::assistant("a".repeat(4000))
                }
            })
            .collect();
        chat_history::trim(&mut history);
        assert!(history.len() <= 64);
        assert!(history.iter().map(|turn| turn.text.len()).sum::<usize>() <= 128_000);
        let chat = ApiChat::default();
        chat.conversation.lock().unwrap().owner = Some((ChatProvider::Gemini, "gemini".into()));
        chat.reset();
        assert!(chat.conversation.lock().unwrap().owner.is_none());
        assert_eq!(chat.generation.load(Ordering::Acquire), 1);
    }
}
