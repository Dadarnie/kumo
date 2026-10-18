// SPDX-License-Identifier: MIT
// Relay server for mimo-hook.
//
// Windows: the named pipe `\\.\pipe\mimo-<sid>`, one instance per connection.
// Every hook event is
// forwarded to the island as a `hook` event. `PermissionRequest` is the only one
// that keeps its connection open: it waits for the island's decision and writes
// it back on the same connection, which is how approving from the island works.
//
// Claude Code is never blocked by us. Three things guarantee it:
//   * mimo-hook gives the connection 300 ms and exits cleanly if we are closed;
//   * we only wait for a human once the island has *confirmed* the card is on
//     screen, so a paused island or a webview that is not listening costs a few
//     hundred milliseconds, not two minutes;
//   * whatever happens we drop the connection after the decision timeout, and
//     the terminal takes over.
//
// What we write back is the bare word `allow` or `deny`. Turning that into the
// documented hookSpecificOutput JSON is mimo-hook's job, so the wire format
// Claude Code expects lives in exactly one place.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc;

use crate::island::WINDOW_LABEL;
use crate::log;
#[path = "../../hook/src/questions.rs"]
mod question_protocol;

/// Slightly under mimo-hook's own 110 s wait, so we always answer first.
const DECISION_TIMEOUT: Duration = Duration::from_secs(108);
/// How long the island gets to say "the card is up". This is the whole of B4:
/// without it, an island that is paused, hidden behind a crashed webview or
/// simply not listening would leave Claude Code staring at a prompt nobody can
/// see for nearly two minutes.
const ACK_TIMEOUT: Duration = Duration::from_millis(800);
const MAX_PAYLOAD: usize = 1 << 20;

/// What the island can say about a permission request.
pub enum Reply {
    /// The card is on screen and a human can act on it.
    Ack,
    /// A human clicked: `allow` or `deny`.
    Decision(String),
    /// Nobody can act on it — paused, or another request already holds the card.
    Decline,
}

/// Permission requests the island has been told about.
#[derive(Default)]
pub struct Pending(Mutex<HashMap<String, PendingRequest>>);

struct PendingRequest {
    sender: mpsc::Sender<Reply>,
    questions: Option<Value>,
    mcp: bool,
}

static COUNTER: AtomicU64 = AtomicU64::new(1);

/// `\\.\pipe\mimo-<sid>` — must match mimo-hook's `pipe_path()` exactly.
pub fn pipe_name() -> String {
    let key = crate::windows::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\mimo-{key}")
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let name = pipe_name();
        // first_pipe_instance also means we refuse to join a pipe somebody else
        // already owns under our name, rather than serving on top of it.
        let mut server = match ServerOptions::new().first_pipe_instance(true).create(&name) {
            Ok(s) => s,
            Err(err) => {
                log::line(format!("cannot open the relay pipe: {err}"));
                return;
            }
        };
        loop {
            if server.connect().await.is_err() {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            // Hand the connected instance to a task and listen on a fresh one.
            let next = match ServerOptions::new().create(&name) {
                Ok(s) => s,
                Err(err) => {
                    log::line(format!("cannot reopen the relay pipe: {err}"));
                    return;
                }
            };
            let connected = std::mem::replace(&mut server, next);
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, connected).await });
        }
    });
}

async fn handle(app: AppHandle, mut pipe: NamedPipeServer) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') || buf.len() > MAX_PAYLOAD {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    if buf.len() > MAX_PAYLOAD {
        return;
    }
    let line = match buf.iter().position(|b| *b == b'\n') {
        Some(i) => &buf[..i],
        None => &buf[..],
    };
    let Ok(mut payload) = serde_json::from_slice::<Value>(line) else {
        return;
    };
    if !payload.is_object() {
        return;
    }
    // Keep the relay available so installed hooks return to the terminal at once.
    if !app
        .state::<crate::Shared>()
        .settings
        .lock()
        .unwrap()
        .modules
        .vscode
    {
        let _ = pipe.disconnect();
        return;
    }

    let provider = payload
        .get("mimo_provider")
        .and_then(Value::as_str)
        .unwrap_or("claude");
    let Some(provider) = crate::settings::CodingAssistant::ALL
        .into_iter()
        .find(|p| p.id() == provider)
    else {
        return;
    };

    let event = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if event == "UsageUpdate" {
        let enabled = app
            .state::<crate::Shared>()
            .settings
            .lock()
            .unwrap()
            .usage_enabled;
        if enabled && payload.get("mimo_provider").and_then(Value::as_str) == Some("claude") {
            if let Some(snapshot) = app
                .state::<crate::claude_usage::UsageCache>()
                .update(&payload)
            {
                let _ = app.emit_to(WINDOW_LABEL, "agent-usage", snapshot);
            }
        }
        let _ = pipe.disconnect();
        return;
    }
    if ![
        "SessionStart",
        "SessionEnd",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "PostToolUseFailure",
        "PermissionRequest",
        "Notification",
        "Stop",
        "StopFailure",
        "Interrupt",
        "SubagentStart",
        "SubagentStop",
        "BeforeModel",
        "BackgroundWork",
    ]
    .contains(&event.as_str())
    {
        return;
    }

    let questions = question_protocol::from_event(&payload, provider.id());
    let mcp = questions.is_some()
        && payload["mimo_response_channel"] == "mcp"
        && payload["tool_name"] == "mimo.ask_user";
    if event != "PermissionRequest" && questions.is_none() {
        log::line(format!("hook {event}"));
        let _ = app.emit_to(WINDOW_LABEL, "hook", payload);
        let _ = pipe.disconnect();
        return;
    }
    if questions.is_none() && !provider.approvals() {
        return;
    }
    let end_session = mcp.then(|| {
        json!({"hook_event_name":"SessionEnd",
        "mimo_provider":provider.id(),"mimo_response_channel":"mcp",
        "session_id":payload["session_id"],"cwd":payload["cwd"]})
    });

    let id = format!(
        "{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let (tx, mut rx) = mpsc::channel::<Reply>(4);
    {
        let pending = app.state::<Pending>();
        pending.0.lock().unwrap().insert(
            id.clone(),
            PendingRequest {
                sender: tx,
                questions: questions.clone(),
                mcp,
            },
        );
    }
    payload["request_id"] = json!(id);
    if questions.is_some() {
        payload["hook_event_name"] = json!("QuestionRequest");
    }
    log::line(format!(
        "hook {} id={id}",
        if questions.is_some() {
            "QuestionRequest"
        } else {
            "PermissionRequest"
        }
    ));
    let _ = app.emit_to(WINDOW_LABEL, "hook", payload);

    let decision = if mcp {
        // Cancellation, a disconnected MCP client, or its deadline closes the
        // pipe. Release only this question without keeping a stale Review card.
        let mut closed = [0u8; 1];
        let mut answer = Box::pin(wait_for_decision(&id, &mut rx));
        let mut disconnected = Box::pin(pipe.read(&mut closed));
        std::future::poll_fn(|context| {
            if let std::task::Poll::Ready(answer) = answer.as_mut().poll(context) {
                return std::task::Poll::Ready(answer);
            }
            if disconnected.as_mut().poll(context).is_ready() {
                return std::task::Poll::Ready(None);
            }
            std::task::Poll::Pending
        })
        .await
    } else {
        wait_for_decision(&id, &mut rx).await
    };
    app.state::<Pending>().0.lock().unwrap().remove(&id);

    // No decision: say nothing at all. mimo-hook then writes nothing to stdout
    // and Claude Code asks in the terminal, exactly as if Mimo were closed.
    if let Some(d) = decision {
        let _ = pipe.write_all(format!("{d}\n").as_bytes()).await;
        let _ = pipe.flush().await;
    }
    let _ = pipe.disconnect();
    if let Some(payload) = end_session {
        let _ = app.emit_to(WINDOW_LABEL, "hook", payload);
    }
}

/// Two waits: a short one for "the card is up", then the long one for a human.
async fn wait_for_decision(id: &str, rx: &mut mpsc::Receiver<Reply>) -> Option<String> {
    match tokio::time::timeout(ACK_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Ack)) => {}
        // A click that beats the ack is still a click.
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered"));
            return Some(d);
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} not shown — terminal takes over"));
            return None;
        }
        Ok(None) => return None,
        Err(_) => {
            log::line(format!(
                "hook id={id} island never acknowledged — terminal takes over"
            ));
            return None;
        }
    }

    match tokio::time::timeout(DECISION_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered"));
            Some(d)
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} released without a decision"));
            None
        }
        _ => {
            log::line(format!("hook id={id} timed out — terminal takes over"));
            None
        }
    }
}

fn send(app: &AppHandle, request_id: &str, reply: Reply, keep: bool) {
    let sender = {
        let pending = app.state::<Pending>();
        let mut map = pending.0.lock().unwrap();
        if keep {
            map.get(request_id).map(|request| request.sender.clone())
        } else {
            map.remove(request_id).map(|request| request.sender)
        }
    };
    match sender {
        Some(tx) => {
            let _ = tx.try_send(reply);
        }
        None => log::line(format!("reply for id={request_id} — no pending request")),
    }
}

/// The island has the card on screen; the long wait may begin.
pub fn acknowledge(app: &AppHandle, request_id: &str) {
    send(app, request_id, Reply::Ack, true);
}

/// Nobody can act on this one — paused, or another card already holds the view.
pub fn decline(app: &AppHandle, request_id: &str) {
    log::line(format!("decline id={request_id}"));
    send(app, request_id, Reply::Decline, false);
}

pub fn decline_all(app: &AppHandle) {
    let senders = std::mem::take(&mut *app.state::<Pending>().0.lock().unwrap());
    for request in senders.into_values() {
        let _ = request.sender.try_send(Reply::Decline);
    }
}

/// Called by the island's Allow / Deny buttons. Only ever a bare word: turning
/// it into Claude Code's JSON is mimo-hook's job.
pub fn answer(app: &AppHandle, request_id: &str, decision: &str) {
    // A permission shortcut must never answer a question without collecting input.
    if app
        .state::<Pending>()
        .0
        .lock()
        .unwrap()
        .get(request_id)
        .is_some_and(|r| r.questions.is_some())
    {
        return;
    }
    let word = match decision {
        "allow" | "always" => "allow",
        _ => "deny",
    };
    log::line(format!("decision id={request_id} {word}"));
    send(app, request_id, Reply::Decision(word.to_string()), false);
}

/// Validate the exact live question before returning answers to its original hook.
pub fn answer_question(app: &AppHandle, request_id: &str, answers: Value) -> Result<(), String> {
    let pending = app.state::<Pending>();
    let mut requests = pending.0.lock().unwrap();
    let request = requests
        .get(request_id)
        .ok_or("This question has returned to your tool. Open the tool to answer.")?;
    let questions = request
        .questions
        .as_ref()
        .ok_or("This request is a permission check.")?;
    let output = if request.mcp {
        let answers = question_protocol::answers(questions, &answers)
            .ok_or("Answer every question before sending.")?;
        json!({"answers":answers}).to_string()
    } else {
        question_protocol::hook_output(questions, &answers)
            .ok_or("Answer every question before sending.")?
    };
    request
        .sender
        .try_send(Reply::Decision(output))
        .map_err(|_| "This question is no longer waiting. Open the tool to answer.".to_string())?;
    requests.remove(request_id);
    Ok(())
}
