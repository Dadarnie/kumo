// SPDX-License-Identifier: MIT
//! A local MCP stdio adapter for every supported coding agent. Questions use
//! Mimo's existing authenticated pipe, bounded validation and session-owned queue.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PROTOCOL: &str = "2025-11-25";
const MAX_PENDING: usize = 8;
static SESSION: AtomicU64 = AtomicU64::new(1);
type Output = Arc<Mutex<std::io::Stdout>>;
type Requests = Arc<Mutex<HashMap<String, Active>>>;
struct Active {
    id: Value,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
    worker: std::thread::JoinHandle<()>,
    responding: bool,
}

fn emit(output: &Output, value: Value) {
    let mut output = output.lock().unwrap();
    let _ = writeln!(output, "{value}");
    let _ = output.flush();
}
fn result(output: &Output, id: &Value, value: Value) {
    emit(output, json!({"jsonrpc":"2.0","id":id,"result":value}));
}
fn error(output: &Output, id: &Value, code: i32, message: &str) {
    emit(
        output,
        json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}),
    );
}
fn cancel(output: &Output, request: &Active, reason: &str) {
    if request.responding {
        return;
    }
    if !request.cancelled.swap(true, Ordering::AcqRel) {
        error(output, &request.id, -32800, reason);
    }
    crate::win::cancel_io(&request.worker);
}

fn initialization(requested: &str) -> Value {
    let protocol = match requested {
        "2024-11-05" | "2025-03-26" | "2025-06-18" | "2025-11-25" => requested,
        _ => PROTOCOL,
    };
    json!({"protocolVersion":protocol,"capabilities":{"tools":{"listChanged":false}},
        "serverInfo":{"name":"mimo","version":env!("CARGO_PKG_VERSION")},
        "instructions":"Use ask_user when you need a clarification, a choice, or a follow-up answer from the user. Mimo queues requests from connected agents and returns only the user's explicit answers. Never answer your own question. If the tool is unavailable, cancelled, or returns isError, ask the user in your normal interface. Questions do not grant permission to run other tools."})
}

fn tools() -> Value {
    json!({"tools":[{"name":"ask_user","title":"Ask in Mimo",
        "description":"Ask 1-4 follow-up questions in Mimo. Supports choices, multiple selections, and typed answers. Each request joins the shared Review queue; wait for the user's answer. Returns answers keyed by the exact question text. If Mimo is closed, paused, or no answer arrives within 110 seconds, ask in your own interface.",
        "inputSchema":{"type":"object","additionalProperties":false,"required":["questions"],"properties":{
            "cwd":{"type":"string","maxLength":2000,"description":"Absolute project path for Back to work. Defaults to the server's working directory."},
            "questions":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"object","additionalProperties":false,
                "required":["question","options"],"properties":{
                    "question":{"type":"string","minLength":1,"maxLength":2000},
                    "header":{"type":"string","maxLength":80},
                    "multiSelect":{"type":"boolean","default":false},
                    "options":{"type":"array","maxItems":8,"description":"Use an empty array for a typed answer. A custom typed reply is always available.",
                        "items":{"type":"object","additionalProperties":false,"required":["label"],"properties":{
                            "label":{"type":"string","minLength":1,"maxLength":200},
                            "description":{"type":"string","maxLength":1000}}}}}}}}},
        "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":false,"openWorldHint":false}}]})
}

fn question_payload(provider: &str, arguments: &Value) -> Option<Value> {
    if !crate::providers::PROVIDERS.contains(&provider) {
        return None;
    }
    let fields = arguments.as_object()?;
    if fields.keys().any(|key| key != "questions" && key != "cwd") {
        return None;
    }
    let questions = fields.get("questions")?;
    let cwd = match fields.get("cwd") {
        Some(value) => value.as_str()?.to_owned(),
        None => std::env::current_dir().ok()?.to_str()?.to_owned(),
    };
    if cwd.len() > 2_000 || cwd.contains('\0') || !Path::new(&cwd).is_absolute() {
        return None;
    }
    let session = format!(
        "mcp-{}-{}",
        std::process::id(),
        SESSION.fetch_add(1, Ordering::Relaxed)
    );
    let mut payload = json!({"hook_event_name":"PreToolUse","mimo_provider":provider,
        "mimo_response_channel":"mcp","session_id":session,"tool_use_id":session,
        "tool_name":"mimo.ask_user","cwd":cwd,"mimo_questions":questions});
    payload["mimo_questions"] = crate::questions::from_event(&payload, provider)?;
    Some(payload)
}

fn ask(output: &Output, requests: &Requests, id: Value, payload: Value) {
    let key = id.to_string();
    let mut active = requests.lock().unwrap();
    if active.contains_key(&key) || active.len() >= MAX_PENDING {
        error(output, &id, -32000, "Mimo's question connection is busy. Wait for a pending answer, or ask in your own interface.");
        return;
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = cancelled.clone();
    let worker_output = output.clone();
    let worker_requests = requests.clone();
    // Do not let a fast offline result remove the slot before it is registered.
    let (start, ready) = std::sync::mpsc::channel();
    let worker_id = id.clone();
    let worker_key = key.clone();
    let worker = std::thread::spawn(move || {
        if ready.recv().is_err() {
            return;
        }
        let reply = crate::talk_cancellable(&(payload.to_string() + "\n"), true, &worker_cancelled)
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|reply| {
                crate::questions::answers(&payload["mimo_questions"], &reply["answers"])
            });
        // Dropping the pipe also removes this MCP session from the native queue.
        {
            let mut active = worker_requests.lock().unwrap();
            if worker_cancelled.load(Ordering::Acquire) {
                active.remove(&worker_key);
                return;
            }
            if let Some(request) = active.get_mut(&worker_key) {
                request.responding = true;
            }
        }
        let value = match reply {
            Some(answers) => {
                let value = json!({"answers":answers});
                json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":false})
            }
            None => {
                json!({"content":[{"type":"text","text":"Mimo did not return an answer. Ask the user in your own interface."}],"isError":true})
            }
        };
        result(&worker_output, &worker_id, value);
        worker_requests.lock().unwrap().remove(&worker_key);
    });
    active.insert(
        key,
        Active {
            id,
            cancelled,
            deadline: Instant::now() + crate::DECISION_BUDGET,
            worker,
            responding: false,
        },
    );
    let _ = start.send(());
}

pub fn run(arguments: impl Iterator<Item = String>) -> Result<(), &'static str> {
    let mut provider = None;
    let mut arguments = arguments;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--mcp" => {}
            "--provider" => provider = arguments.next(),
            _ => return Err("use --mcp --provider <coding-agent>"),
        }
    }
    let provider = provider
        .filter(|id| crate::providers::PROVIDERS.contains(&id.as_str()))
        .ok_or("--mcp requires a supported --provider")?;
    let output: Output = Arc::new(Mutex::new(std::io::stdout()));
    let requests: Requests = Arc::new(Mutex::new(HashMap::new()));
    let watching = requests.clone();
    let watchdog_output = output.clone();
    let stopped = Arc::new(AtomicBool::new(false));
    let watchdog_stopped = stopped.clone();
    std::thread::spawn(move || {
        while !watchdog_stopped.load(Ordering::Acquire) {
            for request in watching.lock().unwrap().values() {
                if request.cancelled.load(Ordering::Acquire) || Instant::now() >= request.deadline {
                    cancel(
                        &watchdog_output,
                        request,
                        "Mimo question cancelled or timed out. Ask in your own interface.",
                    );
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    });

    let mut initialized = false;
    let mut ready = false;
    let mut input = std::io::stdin().lock();
    loop {
        // Bound every frame without allocating an unbounded read_line buffer.
        let mut frame = Vec::new();
        let count = std::io::Read::by_ref(&mut input)
            .take(crate::MAX_INPUT as u64 + 1)
            .read_until(b'\n', &mut frame)
            .map_err(|_| "could not read MCP input")?;
        if count == 0 {
            break;
        }
        if count > crate::MAX_INPUT {
            break;
        }
        let message = match serde_json::from_slice::<Value>(&frame) {
            Ok(value) => value,
            Err(_) => {
                error(&output, &Value::Null, -32700, "Invalid JSON");
                continue;
            }
        };
        if message["jsonrpc"] != "2.0" || !message["method"].is_string() {
            error(&output, &Value::Null, -32600, "Invalid JSON-RPC request");
            continue;
        }
        if message
            .get("id")
            .is_some_and(|id| !id.is_string() && !id.is_number())
        {
            error(&output, &Value::Null, -32600, "Invalid request id");
            continue;
        }
        let id = message
            .get("id")
            .filter(|id| id.is_string() || id.is_number());
        let method = message["method"].as_str().unwrap();
        let parameters = &message["params"];
        if id.is_none() {
            match method {
                "notifications/initialized" if initialized => ready = true,
                "notifications/cancelled" => {
                    if let Some(request) = requests
                        .lock()
                        .unwrap()
                        .get(&parameters["requestId"].to_string())
                    {
                        cancel(&output, request, "Question cancelled by the calling agent.");
                    }
                }
                _ => {}
            }
            continue;
        }
        let id = id.unwrap();
        match method {
            "initialize" if !initialized => {
                if let Some(protocol) = parameters["protocolVersion"].as_str() {
                    result(&output, id, initialization(protocol));
                    initialized = true;
                } else {
                    error(&output, id, -32602, "protocolVersion is required");
                }
            }
            "ping" => result(&output, id, json!({})),
            _ if !ready => error(&output, id, -32002, "Initialize the MCP connection first"),
            "tools/list" => result(&output, id, tools()),
            "tools/call" => {
                if parameters["name"] != "ask_user" {
                    error(&output, id, -32602, "Unknown tool");
                } else if let Some(payload) = question_payload(&provider, &parameters["arguments"])
                {
                    ask(&output, &requests, id.clone(), payload);
                } else {
                    error(&output, id, -32602, "Supply 1-4 valid questions and an optional absolute cwd. Answers cannot be prefilled.");
                }
            }
            _ => error(&output, id, -32601, "Method not found"),
        }
    }
    for request in requests.lock().unwrap().values() {
        cancel(
            &output,
            request,
            "The agent closed the question connection.",
        );
    }
    stopped.store(true, Ordering::Release);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Value {
        json!({"cwd":"C:/work","questions":[{"question":"Which check?","options":[{"label":"Build"},{"label":"Types"}]}]})
    }

    #[test]
    fn every_registered_agent_gets_an_isolated_question_session() {
        let mut sessions = std::collections::HashSet::new();
        for provider in crate::providers::PROVIDERS {
            let payload = question_payload(provider, &input()).unwrap();
            assert_eq!(payload["mimo_provider"], *provider);
            assert!(sessions.insert(payload["session_id"].as_str().unwrap().to_owned()));
            assert_eq!(
                crate::questions::from_event(&payload, provider).unwrap(),
                payload["mimo_questions"]
            );
        }
        assert!(question_payload("unknown", &input()).is_none());
    }
    #[test]
    fn invalid_questions_paths_and_prefilled_answers_never_enter_the_pipe() {
        for invalid in [
            json!({"questions":[]}),
            json!({"cwd":"relative/path","questions":input()["questions"]}),
            json!({"answers":{"Which check?":"Build"},"questions":input()["questions"]}),
        ] {
            assert!(question_payload("codex", &invalid).is_none());
        }
        let mut payload = question_payload("cursor", &input()).unwrap();
        payload["mimo_response_channel"] = json!("hook");
        assert!(crate::questions::from_event(&payload, "cursor").is_none());
        payload["mimo_response_channel"] = json!("mcp");
        payload["tool_name"] = json!("AskUserQuestion");
        assert!(crate::questions::from_event(&payload, "cursor").is_none());
    }
    #[test]
    fn supported_protocol_versions_negotiate_without_other_capabilities() {
        assert_eq!(
            initialization("2025-06-18")["protocolVersion"],
            "2025-06-18"
        );
        assert_eq!(initialization("unknown")["protocolVersion"], PROTOCOL);
        assert_eq!(
            initialization(PROTOCOL)["capabilities"],
            json!({"tools":{"listChanged":false}})
        );
    }
}
