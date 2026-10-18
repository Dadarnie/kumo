// SPDX-License-Identifier: MIT
//! Normalize documented local hook protocols before the relay drops unknown fields.
use serde_json::{json, Value};
pub const PROVIDERS: &[&str] = &[
    "claude",
    "codex",
    "cursor",
    "gemini",
    "antigravity",
    "muse",
    "opencode",
    "copilot",
    "hermes",
];

/// Cursor expects a valid native response even when the observer is unavailable.
/// Other hooks and Cursor's own permissions still make the policy decisions.
pub fn cursor_response(event: &str) -> &'static str {
    match event {
        "PreToolUse" => r#"{"permission":"allow"}"#,
        "UserPromptSubmit" => r#"{"continue":true}"#,
        _ => "{}",
    }
}

fn alias(payload: &mut Value, target: &str, names: &[&str]) {
    if payload.get(target).is_some() {
        return;
    }
    if let Some(value) = names.iter().find_map(|name| payload.get(*name)).cloned() {
        payload[target] = value;
    }
}
pub fn normalize(payload: &mut Value, provider: &str, fallback_event: &str) -> Option<()> {
    payload.as_object()?;
    let event = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback_event)
        .to_owned();
    let event = match event.as_str() {
        "BeforeAgent" | "userPromptSubmitted" | "pre_llm_call" | "beforeSubmitPrompt" => {
            "UserPromptSubmit"
        }
        "AfterAgent" | "agentStop" | "post_llm_call" => "Stop",
        "BeforeTool" | "preToolUse" | "pre_tool_call" => "PreToolUse",
        "AfterTool" | "postToolUse" | "post_tool_call" => "PostToolUse",
        "postToolUseFailure" => "PostToolUseFailure",
        "sessionStart" => "SessionStart",
        "sessionEnd" => "SessionEnd",
        "stop" => "Stop",
        "subagentStop" => "SubagentStop",
        "errorOccurred" => "StopFailure",
        "PreInvocation" | "PreLLMCall" => "BeforeModel",
        // New connections observe only. Permission control remains in their app.
        "permissionRequest" if provider == "copilot" => "Notification",
        other => other,
    };
    let event = if provider == "cursor" && event == "Stop" {
        match payload.get("status").and_then(Value::as_str) {
            Some("error") => "StopFailure",
            Some("aborted") => "Interrupt",
            _ => event,
        }
    } else {
        event
    };
    payload["hook_event_name"] = json!(event);
    alias(
        payload,
        "session_id",
        &["sessionId", "conversationId", "conversation_id"],
    );
    alias(payload, "tool_name", &["toolName"]);
    alias(payload, "tool_input", &["toolArgs", "toolInput", "args"]);
    alias(
        payload,
        "tool_use_id",
        &["toolCallId", "tool_call_id", "callID"],
    );
    alias(
        payload,
        "tool_response",
        &["toolResult", "result", "tool_output"],
    );
    alias(payload, "prompt", &["user_message", "userPrompt"]);
    alias(
        payload,
        "last_assistant_message",
        &["assistant_response", "prompt_response"],
    );
    if provider == "cursor" {
        if payload.get("cwd").is_none() {
            if let Some(cwd) = payload.pointer("/workspace_roots/0").cloned() {
                payload["cwd"] = cwd;
            }
        }
        if let Some(text) = payload.get("tool_response").and_then(Value::as_str) {
            if let Ok(value) = serde_json::from_str::<Value>(text) {
                payload["tool_response"] = value;
            }
        }
    }
    if provider == "antigravity" {
        if let Some(tool) = payload.pointer("/toolCall/name").cloned() {
            payload["tool_name"] = tool;
        }
        if let Some(args) = payload.pointer("/toolCall/args").cloned() {
            payload["tool_input"] = args;
        }
        if let Some(cwd) = payload.pointer("/workspacePaths/0").cloned() {
            payload["cwd"] = cwd;
        }
        if let Some(step) = payload.get("stepIdx").and_then(Value::as_u64) {
            payload["tool_use_id"] = json!(format!("step-{step}"));
        }
    }
    let failed = payload
        .get("error")
        .is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()))
        || payload
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|s| matches!(s, "error" | "blocked" | "cancelled"))
        || payload
            .pointer("/tool_response/resultType")
            .and_then(Value::as_str)
            == Some("failure")
        || payload
            .pointer("/tool_response/isError")
            .and_then(Value::as_bool)
            == Some(true);
    if event == "PostToolUse" && failed {
        payload["hook_event_name"] = json!("PostToolUseFailure");
    }
    if provider == "antigravity" && event == "Stop" {
        if failed
            || payload
                .get("terminationReason")
                .and_then(Value::as_str)
                .is_some_and(|s| matches!(s, "error" | "max_steps_exceeded"))
        {
            payload["hook_event_name"] = json!("StopFailure");
        } else if payload.get("fullyIdle").and_then(Value::as_bool) == Some(false) {
            payload["hook_event_name"] = json!("BackgroundWork");
        }
    }
    if let Some(tool) = payload.get("tool_name").and_then(Value::as_str) {
        let tool = match tool {
            "read" | "view" | "read_file" | "view_file" | "read_text_file" => "Read",
            "write" | "create" | "write_file" | "write_to_file" => "Write",
            "edit" | "replace" | "replace_file_content" | "patch" => "Edit",
            "multi_replace_file_content" => "MultiEdit",
            "bash" | "terminal" | "run_shell_command" | "Shell" => "Bash",
            "powershell" => "PowerShell",
            "glob" | "find_files" => "Glob",
            "grep" | "search_file_content" | "grep_search" => "Grep",
            "list_directory" | "list_dir" => "LS",
            other => other,
        }
        .to_owned();
        let tool = crate::coding::tool_name(&tool).to_owned();
        let mut input = crate::coding::normalize_input(
            &tool,
            payload.get("tool_input").unwrap_or(&Value::Null),
        );
        if !input.is_object() {
            input = json!({});
        }
        alias(
            &mut input,
            "file_path",
            &["filePath", "filepath", "AbsolutePath", "TargetFile"],
        );
        alias(&mut input, "command", &["cmd", "CommandLine"]);
        alias(
            &mut input,
            "old_string",
            &["oldString", "old_text", "TargetContent"],
        );
        alias(
            &mut input,
            "new_string",
            &["newString", "new_text", "ReplacementContent"],
        );
        alias(&mut input, "content", &["CodeContent"]);
        alias(&mut input, "description", &["Description"]);
        alias(&mut input, "offset", &["StartLine", "start_line"]);
        if provider == "gemini" && tool == "Read" {
            if let Some(offset) = input.get("offset").and_then(Value::as_u64) {
                input["offset"] = json!(offset.saturating_add(1));
            }
        }
        if tool == "MultiEdit" {
            if let Some(chunks) = input.get("ReplacementChunks").and_then(Value::as_array) {
                input["edits"] = json!(chunks
                    .iter()
                    .take(64)
                    .map(|chunk| json!({
                    "old_string":chunk["TargetContent"], "new_string":chunk["ReplacementContent"]}))
                    .collect::<Vec<_>>());
            }
        }
        payload["tool_name"] = json!(crate::coding::tool_name(&tool));
        payload["tool_input"] = input;
    }
    if let Some(response) = payload.get_mut("tool_response") {
        if let Some(text) = response
            .get("textResultForLlm")
            .or_else(|| response.get("llmContent"))
            .filter(|v| v.is_string())
            .cloned()
        {
            *response = json!({"content":text,"output":text});
        }
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_activity_uses_stable_conversations_and_reported_tool_results() {
        let mut input = json!({"hook_event_name":"preToolUse","conversation_id":"cursor-conversation",
            "generation_id":"turn-one","workspace_roots":["C:/work/shop"],"tool_name":"Shell",
            "tool_input":{"command":"npm test"},"tool_use_id":"shell-1"});
        normalize(&mut input, "cursor", "preToolUse").unwrap();
        assert_eq!(input["hook_event_name"], "PreToolUse");
        assert_eq!(input["session_id"], "cursor-conversation");
        assert_eq!(input["cwd"], "C:/work/shop");
        assert_eq!(input["tool_name"], "Bash");
        assert_eq!(input["tool_input"]["command"], "npm test");
        let mut result = json!({"hook_event_name":"postToolUse","conversation_id":"cursor-conversation",
            "generation_id":"turn-two","tool_name":"Shell","tool_use_id":"shell-1",
            "tool_output":"{\"exitCode\":0,\"stdout\":\"All tests passed\"}"});
        normalize(&mut result, "cursor", "postToolUse").unwrap();
        assert_eq!(result["session_id"], input["session_id"]);
        assert_eq!(result["tool_response"]["exitCode"], 0);
        assert_eq!(result["hook_event_name"], "PostToolUse");
        let mut error =
            json!({"hook_event_name":"postToolUseFailure","error_message":"Command failed"});
        normalize(&mut error, "cursor", "postToolUseFailure").unwrap();
        assert_eq!(error["hook_event_name"], "PostToolUseFailure");
        for (status, expected) in [
            ("completed", "Stop"),
            ("error", "StopFailure"),
            ("aborted", "Interrupt"),
        ] {
            let mut stop = json!({"hook_event_name":"stop","status":status});
            normalize(&mut stop, "cursor", "stop").unwrap();
            assert_eq!(stop["hook_event_name"], expected);
        }
        assert_eq!(cursor_response("PreToolUse"), r#"{"permission":"allow"}"#);
        assert_eq!(cursor_response("UserPromptSubmit"), r#"{"continue":true}"#);
        assert_eq!(
            cursor_response("Stop"),
            "{}",
            "Observer never starts automatic follow-ups"
        );
    }
    #[test]
    fn documented_provider_payloads_keep_session_tool_and_failure_identity() {
        let mut gravity = json!({"conversationId":"gravity-session","workspacePaths":["C:/work"],
            "toolCall":{"name":"replace_file_content","args":{"TargetFile":"C:/work/a.ts","TargetContent":"old","ReplacementContent":"new"}},"stepIdx":19});
        normalize(&mut gravity, "antigravity", "PreToolUse").unwrap();
        assert_eq!(gravity["session_id"], "gravity-session");
        assert_eq!(gravity["tool_input"]["file_path"], "C:/work/a.ts");
        assert_eq!(gravity["tool_input"]["new_string"], "new");
        assert_eq!(gravity["tool_use_id"], "step-19");
        let mut copilot = json!({"sessionId":"copilot-session","toolName":"view","toolArgs":"{\"path\":\"a.ts\"}",
            "toolResult":{"resultType":"failure","textResultForLlm":"private error"}});
        normalize(&mut copilot, "copilot", "postToolUse").unwrap();
        assert_eq!(copilot["hook_event_name"], "PostToolUseFailure");
        assert_eq!(copilot["tool_name"], "Read");
        assert_eq!(copilot["tool_input"]["path"], "a.ts");
        let mut gemini = json!({"hook_event_name":"BeforeTool","tool_name":"read_file","tool_input":{"file_path":"a.ts","offset":12}});
        normalize(&mut gemini, "gemini", "BeforeTool").unwrap();
        assert_eq!(gemini["hook_event_name"], "PreToolUse");
        assert_eq!(gemini["tool_input"]["offset"], 13);
    }

    #[test]
    fn antigravity_background_work_and_failures_never_masquerade_as_done() {
        for (idle, reason, expected) in [
            (false, "model_stop", "BackgroundWork"),
            (true, "model_stop", "Stop"),
            (true, "error", "StopFailure"),
            (true, "max_steps_exceeded", "StopFailure"),
        ] {
            let mut payload = json!({"fullyIdle":idle,"terminationReason":reason});
            normalize(&mut payload, "antigravity", "Stop").unwrap();
            assert_eq!(payload["hook_event_name"], expected);
        }
    }
}
