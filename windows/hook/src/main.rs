// SPDX-License-Identifier: MIT
//! kumo-hook — the relay Claude Code runs on every hook event.
//!
//! Reads the hook JSON on stdin, adds a little terminal context, and hands it to
//! Mimo over the named pipe `\\.\pipe\mimo-<sid>`.
//!
//! Hard rule (docs/CLAUDE.md): **never block Claude Code.**
//! * If the pipe does not exist — Mimo is closed — we exit 0 immediately with
//!   nothing on stdout, and the session carries on untouched.
//! * Every step runs under a deadline enforced by the main thread, so a pipe that
//!   accepts the connection and then stops reading cannot wedge the session
//!   either: we abandon the worker and exit.
//! * Only `PermissionRequest` waits for an answer, because approving from the
//!   island is the whole point. No answer means empty stdout, and Claude Code
//!   asks in the terminal exactly as if Mimo were not installed.
//!
//! Usage: `kumo-hook <EventName>` (the name is also read from the JSON).

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

/// Budget for getting a pipe connection. Beyond this Claude Code wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Whole-run budget for an event nobody waits on: connect and write, no more.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// How long a permission prompt may stay on screen before the terminal takes over.
const DECISION_BUDGET: Duration = Duration::from_secs(110);

/// Only activity/approval metadata enters the pipe. Whole tool responses stay
/// here; the coding card receives bounded excerpts and source positions only.
const FORWARDED_FIELDS: &[&str] = &[
    "hook_event_name",
    "session_id",
    "cwd",
    "message",
    "notification_type",
    "prompt",
    "tool_name",
    "tool_use_id",
    "tool_input",
    "mimo_agent",
    "term_program",
    "wt_session",
    "term_session_id",
    "vscode_pid",
    "session_pid",
];
const MAX_INPUT: usize = 1024 * 1024;
/// Longest string forwarded for any single field; the island truncates to far
/// less than this anyway.
const MAX_FIELD_LEN: usize = 2_000;

mod coding;
mod mcp;
mod providers;
mod questions;
mod test_results;
mod win;
use win::connect;

fn main() {
    if std::env::args().any(|argument| argument == "--mcp") {
        let code = match mcp::run(std::env::args().skip(1)) {
            Ok(()) => 0,
            Err(message) => {
                eprintln!("kumo-hook: {message}");
                2
            }
        };
        std::process::exit(code);
    }
    let Some((payload, event)) = read_event() else {
        std::process::exit(0)
    };
    if event == "UsageUpdate" && !std::env::args().any(|arg| arg == "--quiet") {
        // Only safe numeric fields are in this payload. No terminal polling.
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload) {
            println!("{}", usage_label(&value));
        }
    }

    let observer_reply = serde_json::from_str::<serde_json::Value>(&payload)
        .ok()
        .filter(|input| input["mimo_provider"] == "cursor")
        .map(|_| providers::cursor_response(&event));
    let waits_for_answer = event == "PermissionRequest"
        || serde_json::from_str::<serde_json::Value>(&payload)
            .ok()
            .is_some_and(|p| p.get("mimo_questions").is_some());
    let budget = if waits_for_answer {
        DECISION_BUDGET
    } else {
        FIRE_AND_FORGET_BUDGET
    };

    // The worker owns every blocking call. If it overruns the budget we simply
    // stop listening and exit: the process dying takes the pipe handle with it.
    // (No catch_unwind here — the release profile is panic = "abort", so it would
    // be dead code. `talk` is written to have nothing to panic on instead.)
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let reply = talk(&payload, waits_for_answer).and_then(|decision| {
            let input = serde_json::from_str::<serde_json::Value>(&payload).ok()?;
            if let Some(prompts) = input.get("mimo_questions") {
                let reply = serde_json::from_str::<serde_json::Value>(&decision).ok()?;
                questions::hook_output(
                    prompts,
                    reply.pointer("/hookSpecificOutput/updatedInput/answers")?,
                )
            } else {
                decision_json(&decision)
            }
        });
        let _ = tx.send(reply);
    });

    if let Some(json) = rx
        .recv_timeout(budget)
        .ok()
        .flatten()
        .or_else(|| observer_reply.map(str::to_owned))
    {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{json}");
        let _ = out.flush();
    }
    // Nothing printed: Claude Code asks in the terminal, as if we were not here.
    std::process::exit(0);
}

/// The documented PermissionRequest output. Anything we do not recognise prints
/// nothing at all rather than guessing — silence is the safe answer.
/// See https://code.claude.com/docs/en/hooks
fn decision_json(decision: &str) -> Option<String> {
    let behavior = match decision.trim() {
        // "always" still answers a plain allow; remembering it is the island's
        // business, not Claude Code's.
        "allow" | "always" => r#"{"behavior":"allow"}"#.to_string(),
        "deny" => r#"{"behavior":"deny","message":"Denied from Mimo"}"#.to_string(),
        _ => return None,
    };
    Some(format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#
    ))
}

#[test]
fn cursor_relay_forwards_bounded_activity_without_account_or_transcript_fields() {
    let input = serde_json::json!({"hook_event_name":"preToolUse","conversation_id":"cursor-thread",
        "workspace_roots":["C:/workspace"],"tool_name":"Shell","tool_input":{"command":"npm test"},
        "user_email":"private@example.test","transcript_path":"C:/private/transcript.txt","model_params":[{"private":true}]});
    let (line, event) = prepare_event(
        input.to_string().into_bytes(),
        [
            "--provider".to_owned(),
            "cursor".to_owned(),
            "preToolUse".to_owned(),
        ]
        .into_iter(),
    )
    .unwrap();
    let forwarded: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(event, "PreToolUse");
    assert_eq!(forwarded["session_id"], "cursor-thread");
    assert_eq!(forwarded["mimo_provider"], "cursor");
    assert_eq!(forwarded["cwd"], "C:/workspace");
    assert!(!line.contains("private"));
    assert!(!line.contains("mimo_questions"));
}

#[test]
fn question_relay_preserves_only_bounded_questions_for_the_supported_response_path() {
    let event = serde_json::json!({"hook_event_name":"PreToolUse","session_id":"question-session","tool_name":"AskUserQuestion",
        "tool_input":{"questions":[{"question":"Which framework?","header":"Framework","options":[{"label":"React"},{"label":"Vue"}]}],
          "answers":{"Which framework?":"Must not prefill"},"private_field":"Must not forward"}});
    let (line, kind) = prepare_event(event.to_string().into_bytes(), [].into_iter()).unwrap();
    let forwarded: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(kind, "PreToolUse");
    assert_eq!(
        forwarded["mimo_questions"][0]["question"],
        "Which framework?"
    );
    assert!(!line.contains("Must not"));
    let (line, _) = prepare_event(
        event.to_string().into_bytes(),
        ["--provider".to_owned(), "codex".to_owned()].into_iter(),
    )
    .unwrap();
    assert!(
        !line.contains("mimo_questions"),
        "An observational provider must never wait on a fake answer path"
    );
}

/// Reads stdin and returns the payload to forward plus the event name.
fn read_event() -> Option<(String, String)> {
    let mut raw = Vec::new();
    if std::io::stdin()
        .take(MAX_INPUT as u64 + 1)
        .read_to_end(&mut raw)
        .is_err()
        || raw.is_empty()
        || raw.len() > MAX_INPUT
    {
        return None;
    }
    prepare_event(raw, std::env::args().skip(1))
}

/// Numeric token metadata only; whole model responses never enter the pipe.
fn prepare_activity_usage(
    payload: &serde_json::Value,
    provider: &str,
) -> Option<serde_json::Value> {
    for (pointer, cumulative) in [
        ("/info/total_token_usage", true),
        ("/usage", provider == "codex"),
        ("/usageMetadata", false),
        ("/llm_response/usageMetadata", false),
        ("/message/usage", false),
    ] {
        let Some(value) = payload.pointer(pointer) else {
            continue;
        };
        let number = |key: &str| {
            value
                .get(key)
                .and_then(|v| v.as_u64())
                .filter(|n| *n <= 1_000_000_000)
        };
        let total = number("total_tokens")
            .or_else(|| number("totalTokenCount"))
            .or_else(|| number("total"))
            .or_else(|| {
                number("input_tokens")
                    .map(|input| input.saturating_add(number("output_tokens").unwrap_or(0)))
            });
        if let Some(total) = total {
            return Some(serde_json::json!({"totalTokens":total,"cumulative":cumulative}));
        }
    }
    None
}

fn prepare_event(mut raw: Vec<u8>, args: impl Iterator<Item = String>) -> Option<(String, String)> {
    // Some shells hand us a UTF-8 BOM; serde_json would choke on it.
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }

    let args: Vec<String> = args.collect();
    let mut payload = serde_json::from_slice::<serde_json::Value>(&raw).ok()?;
    if args.iter().any(|arg| arg == "--usage") {
        return prepare_usage(&payload);
    }
    let mut agent = String::new();
    let mut arg_event = String::new();
    let mut provider = "claude".to_string();
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        if arg == "--agent" {
            agent = it.next().unwrap_or_default();
        } else if arg == "--provider" {
            provider = it.next()?;
            if !providers::PROVIDERS.contains(&provider.as_str()) {
                return None;
            }
        } else if arg_event.is_empty() {
            arg_event = arg;
        }
    }
    providers::normalize(&mut payload, &provider, &arg_event)?;
    if let Some(tool) = payload.get("tool_name").and_then(serde_json::Value::as_str) {
        let tool = coding::tool_name(tool).to_owned();
        let input = coding::normalize_input(
            &tool,
            payload
                .get("tool_input")
                .unwrap_or(&serde_json::Value::Null),
        );
        payload["tool_name"] = serde_json::json!(tool);
        payload["tool_input"] = input;
    }
    let edits = coding::prepare_edits(&payload);
    let question = (provider == "claude"
        && payload.get("hook_event_name").and_then(|v| v.as_str()) == Some("PreToolUse")
        && payload.get("tool_name").and_then(|v| v.as_str()) == Some("AskUserQuestion"))
    .then(|| questions::normalize(&payload["tool_input"]["questions"]))
    .flatten();
    let next_actions = coding::next_actions(&payload);
    let activity_usage = prepare_activity_usage(&payload, &provider);
    let preview = prepare_preview(&payload);
    let tests = test_results::prepare(&payload);
    // Both providers supply the final response directly on Stop. Keep just the
    // card's short summary; transcripts and the complete response stay local.
    let completion = (payload.get("hook_event_name").and_then(|v| v.as_str()) == Some("Stop"))
        .then(|| {
            payload
                .get("last_assistant_message")
                .and_then(|v| v.as_str())
        })
        .flatten()
        .map(|message| short_preview_line(tool_output(message)));
    let map = payload.as_object_mut()?;
    // Unknown fields (including auth data and transcripts) never enter the pipe.
    map.retain(|key, _| FORWARDED_FIELDS.contains(&key.as_str()));
    if let Some(question) = question {
        map.insert("mimo_questions".into(), question);
    }
    if let Some(usage) = activity_usage {
        map.insert("mimo_usage".into(), usage);
    }
    if let Some(steps) = next_actions {
        map.insert("mimo_next_actions".into(), steps);
    }
    if let Some(preview) = preview {
        map.insert("mimo_preview".into(), preview);
    }
    if let Some(tests) = tests {
        map.insert("mimo_tests".into(), tests);
    }
    if let Some(edits) = edits {
        if map.get("tool_name").and_then(|v| v.as_str()) == Some("apply_patch") {
            let target = edits.pointer("/0/target").cloned().unwrap_or_default();
            map.insert(
                "tool_input".into(),
                serde_json::json!({"file_path": target}),
            );
        }
        map.insert("mimo_edits".into(), edits);
    }
    if let Some(completion) = completion.filter(|s| !s.trim().is_empty()) {
        if !map
            .get("message")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.trim().is_empty())
        {
            map.insert("message".into(), serde_json::Value::String(completion));
        }
    }

    // Parse argv: "kumo-hook.exe [--agent <name>] [<EventName>]"
    // --agent tags the payload with mimo_agent so the app routes to the right pill.
    // Absent or invalid names are validated and discarded by the app, not here.
    if !matches!(provider.as_str(), "claude" | "codex")
        && map.get("hook_event_name").and_then(|v| v.as_str()) == Some("PermissionRequest")
    {
        return None; // Never turn an observational connection into an approval relay.
    }
    map.insert("mimo_provider".into(), serde_json::Value::String(provider));
    // Which agent this hook was installed for. Absent means Claude Code,
    // so existing hook commands keep working unchanged.
    if !agent.is_empty() {
        map.insert("mimo_agent".into(), serde_json::Value::String(agent));
    }
    let event = map
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or(arg_event);
    map.insert(
        "hook_event_name".into(),
        serde_json::Value::String(event.clone()),
    );

    let cwd_missing = map
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::is_empty)
        .unwrap_or(true);
    if cwd_missing {
        if let Ok(cwd) = std::env::current_dir() {
            map.insert(
                "cwd".into(),
                serde_json::Value::String(cwd.to_string_lossy().to_string()),
            );
        }
    }

    // Which terminal the session runs in. Unlike macOS, Mimo here accepts
    // events from every terminal, so this is context only — never a filter.
    for (key, var) in [
        ("term_program", "TERM_PROGRAM"),
        ("wt_session", "WT_SESSION"),
        ("term_session_id", "TERM_SESSION_ID"),
        ("vscode_pid", "VSCODE_PID"),
        ("session_pid", "CLAUDE_CODE_SSE_PORT"),
    ] {
        if !map.contains_key(key) {
            let value = std::env::var(var).unwrap_or_default();
            map.insert(key.into(), serde_json::Value::String(value));
        }
    }

    truncate_strings(&mut payload);

    // Never forward complete file contents, binary data, or unused tool fields.
    if let Some(input) = payload
        .get_mut("tool_input")
        .and_then(serde_json::Value::as_object_mut)
    {
        input.retain(|key, _| {
            [
                "command",
                "file_path",
                "path",
                "url",
                "query",
                "pattern",
                "prompt",
                "description",
                "justification",
            ]
            .contains(&key.as_str())
        });
    }

    let mut line = payload.to_string();
    line.push('\n');
    Some((line, event))
}

/// Use only text already supplied by a known tool; never read a file/transcript.
fn short_preview_line(line: &str) -> String {
    let mut chars = line.trim_end_matches('\r').chars();
    let mut short: String = chars.by_ref().take(160).collect();
    if chars.next().is_some() {
        short.pop();
        short.push('…');
    }
    short
}

fn prepare_preview(payload: &serde_json::Value) -> Option<serde_json::Value> {
    use serde_json::{json, Value};
    let event = payload.get("hook_event_name")?.as_str()?;
    let tool = payload.get("tool_name")?.as_str()?;
    let input = payload.get("tool_input").unwrap_or(&Value::Null);
    let response = payload
        .get("tool_response")
        .or_else(|| payload.get("tool_result"))
        .unwrap_or(&Value::Null);
    let is_file = matches!(
        tool,
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit"
    );
    if is_file {
        let path = input
            .get("file_path")
            .or_else(|| input.get("path"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let basename = path
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if basename == ".env"
            || basename.starts_with(".env.")
            || matches!(
                basename.as_str(),
                "credentials.json" | "auth.json" | "id_rsa" | "id_ed25519"
            )
        {
            return None;
        }
    }
    let text = match (event, tool) {
        ("PreToolUse", "Write" | "Edit") => input
            .get("new_string")
            .or_else(|| input.get("content"))?
            .as_str()?,
        ("PostToolUse", "Read") => response
            .pointer("/file/content")
            .or_else(|| response.get("content").filter(|v| v.is_string()))
            .or_else(|| response.is_string().then_some(response))?
            .as_str()?,
        ("PostToolUse", "Bash" | "PowerShell" | "exec_command" | "run_command" | "apply_patch") => {
            response
                .get("stdout")
                .filter(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
                .or_else(|| response.get("output"))
                .or_else(|| response.get("stderr"))
                .or_else(|| response.pointer("/content/0/text"))
                .or_else(|| response.is_string().then_some(response))?
                .as_str()?
        }
        _ => return None,
    };
    // Codex wraps tool output in timing/status lines. Those aren't code or an AI summary.
    let text = if matches!(
        tool,
        "exec_command" | "run_command" | "Bash" | "PowerShell" | "apply_patch"
    ) {
        tool_output(text)
    } else {
        text
    };
    let lines: Vec<String> = text
        .trim_matches(['\r', '\n'])
        .lines()
        .take(12)
        .map(short_preview_line)
        .collect();
    if !lines.iter().any(|line| !line.trim().is_empty()) {
        return None;
    }
    let mut preview = json!({ "text": lines.join("\n") });
    if tool == "Read" {
        if let Some(start) = response
            .pointer("/file/startLine")
            .or_else(|| input.get("offset"))
            .and_then(Value::as_u64)
            .filter(|n| *n > 0)
        {
            preview["start_line"] = json!(start.min(1_000_000));
        }
    }
    Some(preview)
}

fn tool_output(text: &str) -> &str {
    if let Some((_, output)) = text
        .split_once("Final output:\n")
        .or_else(|| text.split_once("Final output:\r\n"))
    {
        return output;
    }
    if text.starts_with("Exit code:") && text.contains("\nWall time:") {
        if let Some((_, output)) = text.split_once("\nOutput:") {
            return output.trim_start_matches(['\r', '\n', ' ']);
        }
    }
    text
}

/// Status-line input can contain repository info and transcripts. Publish numbers only.
fn prepare_usage(input: &serde_json::Value) -> Option<(String, String)> {
    use serde_json::{json, Map, Value};
    if !input.is_object() {
        return None;
    }
    let fields = [
        (
            "rate_limits",
            "five_hour",
            &["used_percentage", "resets_at"][..],
        ),
        (
            "rate_limits",
            "seven_day",
            &["used_percentage", "resets_at"][..],
        ),
        (
            "context_window",
            "",
            &[
                "used_percentage",
                "total_input_tokens",
                "total_output_tokens",
            ][..],
        ),
        ("cost", "", &["total_cost_usd"][..]),
    ];
    let mut usage = json!({});
    for (section, child, keys) in fields {
        let source = if child.is_empty() {
            input.get(section)
        } else {
            input.get(section).and_then(|value| value.get(child))
        };
        let Some(source) = source else {
            continue;
        };
        let mut numbers = Map::new();
        for key in keys {
            if let Some(value) = source.get(*key).filter(|value| value.is_number()) {
                numbers.insert((*key).into(), value.clone());
            }
        }
        if child.is_empty() {
            usage[section] = Value::Object(numbers);
        } else {
            if usage.get(section).is_none() {
                usage[section] = json!({});
            }
            usage[section][child] = Value::Object(numbers);
        }
    }
    let mut line =
        json!({"hook_event_name":"UsageUpdate","mimo_provider":"claude","usage":usage}).to_string();
    line.push('\n');
    Some((line, "UsageUpdate".into()))
}

fn usage_label(value: &serde_json::Value) -> String {
    let mut parts = vec!["Claude".to_string()];
    for (field, label) in [("five_hour", "5h"), ("seven_day", "7d")] {
        if let Some(used) = value
            .pointer(&format!("/usage/rate_limits/{field}/used_percentage"))
            .and_then(serde_json::Value::as_f64)
            .filter(|n| (0.0..=100.0).contains(n))
        {
            parts.push(format!("{label} {:.0}% left", 100.0 - used));
        }
    }
    if parts.len() == 1 {
        if let Some(used) = value
            .pointer("/usage/context_window/used_percentage")
            .and_then(serde_json::Value::as_f64)
            .filter(|n| (0.0..=100.0).contains(n))
        {
            parts.push(format!("context {used:.0}%"));
        }
    }
    parts.join(" · ")
}

/// Caps every string in the payload. A single Write can carry a whole file.
fn truncate_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > MAX_FIELD_LEN {
                // Cut on a char boundary; a lone byte index can split UTF-8.
                let mut end = MAX_FIELD_LEN;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push('…');
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        serde_json::Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

/// Connect, send, and — for a permission request — wait for the island's word.
fn talk(payload: &str, waits_for_answer: bool) -> Option<String> {
    talk_cancellable(
        payload,
        waits_for_answer,
        &std::sync::atomic::AtomicBool::new(false),
    )
}

fn talk_cancellable(
    payload: &str,
    waits_for_answer: bool,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Option<String> {
    let stopped = || cancelled.load(std::sync::atomic::Ordering::Acquire);
    if stopped() {
        return None;
    }
    let mut pipe = connect()?;

    if stopped() || pipe.write_all(payload.as_bytes()).is_err() {
        return None;
    }
    let _ = pipe.flush();

    if !waits_for_answer {
        return None;
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        if stopped() {
            return None;
        }
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > MAX_INPUT {
                    return None;
                }
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_coding_provider_has_explicit_ownership_and_observers_cannot_request_approval() {
        for provider in providers::PROVIDERS {
            let raw = serde_json::json!({"hook_event_name":"PreToolUse","session_id":"session",
                "tool_name":"Read","tool_input":{"file_path":"src/a.ts","api_key":"synthetic-private"},
                "mimo_provider":"spoofed","auth":{"token":"synthetic-private"},"transcript_path":"private"});
            let args = vec![
                "--provider".to_string(),
                provider.to_string(),
                "PreToolUse".into(),
            ];
            let (line, _) = prepare_event(raw.to_string().into_bytes(), args.into_iter()).unwrap();
            let output: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!(output["mimo_provider"], *provider);
            assert!(!line.contains("synthetic-private"));
            assert!(!line.contains("transcript_path"));
            if !matches!(*provider, "claude" | "codex") {
                let raw = serde_json::json!({"hook_event_name":"PermissionRequest"});
                assert!(prepare_event(
                    raw.to_string().into_bytes(),
                    vec!["--provider".to_string(), provider.to_string()].into_iter()
                )
                .is_none());
            }
        }
    }
    #[test]
    fn stop_forwards_a_short_real_summary_without_the_full_response() {
        let raw = serde_json::json!({"hook_event_name":"Stop", "last_assistant_message":
            format!("48 tests passed {} private tail", "😀".repeat(400)),
            "transcript_path":"synthetic-private"});
        let (line, _) = prepare_event(raw.to_string().into_bytes(), [].into_iter()).unwrap();
        let output: serde_json::Value = serde_json::from_str(&line).unwrap();
        let summary = output["message"].as_str().unwrap();
        assert!(summary.starts_with("48 tests passed"));
        assert_eq!(summary.chars().count(), 160);
        assert!(!line.contains("private tail"));
        assert!(!line.contains("synthetic-private"));
        assert!(output.get("last_assistant_message").is_none());
    }

    #[test]
    fn coding_previews_are_bounded_and_do_not_forward_whole_responses() {
        let raw = serde_json::json!({"hook_event_name":"PostToolUse", "tool_name":"Read",
            "tool_use_id":"read-1", "tool_input":{"file_path":"src/invoice.ts"},
            "tool_response":{"file":{"content":format!("{}\n{}\noutside excerpt", "😀".repeat(400),
                (2..=12).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n")), "startLine":12},
                "access_token":"synthetic-private"}, "mimo_preview":{"text":"untrusted override"}});
        for provider in ["claude", "codex"] {
            let (line, _) = prepare_event(
                raw.to_string().into_bytes(),
                ["--provider", provider].map(str::to_string).into_iter(),
            )
            .unwrap();
            let output: serde_json::Value = serde_json::from_str(&line).unwrap();
            let preview = output["mimo_preview"]["text"].as_str().unwrap();
            assert_eq!(preview.lines().count(), 12);
            assert_eq!(preview.lines().next().unwrap().chars().count(), 160);
            assert_eq!(output["mimo_preview"]["start_line"], 12);
            assert_eq!(output["tool_use_id"], "read-1");
            assert!(!line.contains("synthetic-private"));
            assert!(!line.contains("outside excerpt"));
            assert!(!line.contains("untrusted override"));
            assert!(output.get("tool_response").is_none());
        }
    }

    #[test]
    fn previews_use_real_command_output_and_skip_credential_files() {
        let command = serde_json::json!({"hook_event_name":"PostToolUse", "tool_name":"Bash",
            "tool_response":{"stdout":"PASS invoice.test.ts\nTests: 48 passed, 48 total", "private":"not forwarded"}});
        assert_eq!(
            prepare_preview(&command).unwrap()["text"],
            "PASS invoice.test.ts\nTests: 48 passed, 48 total"
        );
        let secret = serde_json::json!({"hook_event_name":"PostToolUse", "tool_name":"Read",
            "tool_input":{"file_path":"C:\\project\\.env.local"}, "tool_response":"secret value"});
        assert!(prepare_preview(&secret).is_none());
        let unknown = serde_json::json!({"hook_event_name":"PostToolUse", "tool_name":"Unknown",
            "tool_response":"unrelated text"});
        assert!(prepare_preview(&unknown).is_none());
    }

    #[test]
    fn native_relay_keeps_bounded_pending_plan_labels_without_forwarding_unused_fields() {
        for (tool, key, label_key) in [
            ("functions.update_plan", "plan", "step"),
            ("TodoWrite", "todos", "content"),
        ] {
            let mut input = serde_json::json!({});
            input[key] = serde_json::json!([
                {label_key: "Read files", "status":"completed", "private":"not forwarded"},
                {label_key: "Update totals", "status":"in_progress"},
                {label_key: "Run tests", "status":"pending"},
                {label_key: "Review diff", "status":"pending", "private":"not forwarded"}
            ]);
            let event = serde_json::json!({"hook_event_name":"PreToolUse", "tool_name":tool, "tool_input":input});
            let (line, _) = prepare_event(
                event.to_string().into_bytes(),
                ["--provider", "codex"].map(str::to_owned).into_iter(),
            )
            .unwrap();
            let result: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!(
                result["mimo_next_actions"],
                serde_json::json!(["Run tests", "Review diff"])
            );
            assert_eq!(result["tool_input"], serde_json::json!({}));
            assert!(!line.contains("not forwarded"));
        }
    }

    #[test]
    fn native_relay_preserves_edit_gutters_after_stripping_raw_tool_inputs_and_responses() {
        let event = serde_json::json!({"hook_event_name":"PostToolUse", "tool_name":"Edit", "tool_use_id":"edit-lines",
            "tool_input":{"file_path":"src/invoice.ts","old_string":"return 0;","new_string":"return 42;","unused":"not forwarded"},
            "tool_response":{"structuredPatch":[{"oldStart":71,"newStart":71,"lines":["-return 0;","+return 42;"]}],
                "private_metadata":"not forwarded"}});
        let (line, _) = prepare_event(
            event.to_string().into_bytes(),
            ["--provider", "claude"].map(str::to_owned).into_iter(),
        )
        .unwrap();
        let result: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            result["mimo_edits"][0]["preview"]["lineNumbers"],
            serde_json::json!([71, 71])
        );
        assert_eq!(
            result["tool_input"],
            serde_json::json!({"file_path":"src/invoice.ts"})
        );
        assert!(!line.contains("structuredPatch"));
        assert!(!line.contains("not forwarded"));
        assert_eq!(result["tool_use_id"], "edit-lines");
        let patch = serde_json::json!({"hook_event_name":"PreToolUse", "tool_name":"functions.apply_patch",
            "tool_input":"*** Begin Patch\n*** Update File: src/a.ts\n@@ -17,1 +17,1 @@\n-a\n+b\n*** End Patch"});
        let (line, _) = prepare_event(
            patch.to_string().into_bytes(),
            ["--provider", "codex"].map(str::to_owned).into_iter(),
        )
        .unwrap();
        let result: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(result["tool_name"], "apply_patch");
        assert_eq!(result["tool_input"]["file_path"], "src/a.ts");
        assert_eq!(
            result["mimo_edits"][0]["preview"]["lineNumbers"],
            serde_json::json!([17, 17])
        );
    }

    #[test]
    fn transport_status_lines_never_become_code_or_empty_completion_summaries() {
        let empty = serde_json::json!({"hook_event_name":"PostToolUse", "tool_name":"apply_patch",
            "tool_response":"Exit code: 0\nWall time: 4.4 seconds\nOutput:"});
        assert!(prepare_preview(&empty).is_none());
        let complete = serde_json::json!({"hook_event_name":"Stop",
            "last_assistant_message":"Exit code: 0\nWall time: 4.4 seconds\nOutput:\n48 tests passed"});
        let (line, _) = prepare_event(
            complete.to_string().into_bytes(),
            ["Stop"].map(str::to_owned).into_iter(),
        )
        .unwrap();
        let result: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(result["message"], "48 tests passed");
    }

    #[test]
    fn usage_relay_never_forwards_identity_auth_or_repository_data() {
        let raw = br#"{"session_id":"synthetic-private","transcript_path":"synthetic-private","model":{"display_name":"synthetic-private"},"rate_limits":{"five_hour":{"used_percentage":20,"resets_at":1900000000,"access_token":"synthetic-private"}},"context_window":{"used_percentage":30,"total_input_tokens":100,"repository":"synthetic-private"}}"#.to_vec();
        let (line, event) =
            prepare_event(raw, ["--usage"].map(str::to_string).into_iter()).unwrap();
        assert_eq!(event, "UsageUpdate");
        assert!(!line.contains("synthetic-private"));
        let parsed = serde_json::from_str(&line).unwrap();
        assert_eq!(usage_label(&parsed), "Claude · 5h 80% left");
    }

    #[test]
    fn decision_json_matches_the_documented_shape() {
        assert_eq!(
            decision_json("allow").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            decision_json("deny").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Mimo"}}}"#
        );
        // "always" is an island concept; Claude Code just gets an allow.
        assert!(decision_json("always")
            .unwrap()
            .contains(r#""behavior":"allow""#));
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("").is_none());
        assert!(decision_json("maybe").is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#).is_none());
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }
    #[test]
    fn provider_is_explicit_and_unknown_private_fields_are_not_forwarded() {
        let raw = br#"{"hook_event_name":"PreToolUse","tool_input":{"command":"dir"},"mimo_provider":"codex","access_token":"synthetic-private","transcript_path":"synthetic-private","tool_response":"synthetic-private"}"#.to_vec();
        let (legacy, _) = prepare_event(raw.clone(), [].into_iter()).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&legacy).unwrap()["mimo_provider"],
            "claude"
        );
        let (codex, event) = prepare_event(
            raw.clone(),
            ["--provider", "codex", "PreToolUse"]
                .map(str::to_string)
                .into_iter(),
        )
        .unwrap();
        assert_eq!(event, "PreToolUse");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&codex).unwrap()["mimo_provider"],
            "codex"
        );
        assert!(!codex.contains("synthetic-private"));
        assert!(prepare_event(
            raw,
            ["--provider", "invalid"].map(str::to_string).into_iter()
        )
        .is_none());
    }
}
