// SPDX-License-Identifier: MIT
//! Small edit excerpts for the island. Complete inputs/responses never cross the relay.
use serde_json::{json, Value};
use std::{fs::File, io::Read, path::Path};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

const MAX_TEXT: usize = 64_000;
const MAX_FILE: u64 = 512 * 1024;
const MAX_LINES: usize = 30;

pub fn tool_name(name: &str) -> &str {
    let short = name.strip_prefix("functions.").unwrap_or(name);
    match short {
        "apply_patch" | "exec_command" | "run_command" | "update_plan" => short,
        _ => name,
    }
}

pub fn normalize_input(tool: &str, input: &Value) -> Value {
    let mut input = if let Some(text) = input.as_str() {
        serde_json::from_str(text).unwrap_or_else(|_| {
            if tool == "apply_patch" {
                json!({"input": text})
            } else {
                json!({})
            }
        })
    } else {
        input.clone()
    };
    if matches!(tool, "exec_command" | "run_command") && input.get("command").is_none() {
        if let Some(cmd) = input.get("cmd").and_then(Value::as_str) {
            let cmd = cmd.to_owned();
            input["command"] = json!(cmd);
        }
    }
    input
}

/// Only three concise pending plan labels cross the relay, never raw plan fields.
pub fn next_actions(payload: &Value) -> Option<Value> {
    let tool = payload.get("tool_name")?.as_str()?;
    let key = match tool {
        "TodoWrite" => "todos",
        "update_plan" => "plan",
        _ => return None,
    };
    let plan = payload.pointer(&format!("/tool_input/{key}"))?.as_array()?;
    let steps: Vec<String> = plan
        .iter()
        .take(64)
        .filter_map(|step| {
            if step.get("status").and_then(Value::as_str) != Some("pending") {
                return None;
            }
            let label = step.get("step").or_else(|| step.get("content"))?.as_str()?;
            let label: String = label
                .chars()
                .take(120)
                .filter(|c| !c.is_control())
                .collect();
            let label = label.trim();
            (!label.is_empty()).then(|| label.to_owned())
        })
        .take(3)
        .collect();
    Some(json!(steps))
}

pub fn safe_path(path: &str) -> bool {
    let basename = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    !path.is_empty()
        && basename != ".env"
        && !basename.starts_with(".env.")
        && !matches!(
            basename.as_str(),
            "credentials.json" | "auth.json" | "id_rsa" | "id_ed25519"
        )
}

fn text(value: Option<&Value>) -> Option<&str> {
    value?
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= MAX_TEXT)
}

fn lines(text: &str) -> Vec<String> {
    text.strip_suffix('\n')
        .unwrap_or(text)
        .split('\n')
        .map(|line| line.trim_end_matches('\r').to_owned())
        .collect()
}

#[derive(Default)]
struct Hunk {
    old_start: Option<usize>,
    new_start: Option<usize>,
    lines: Vec<(char, String)>,
}

struct Edit {
    path: String,
    hunks: Vec<Hunk>,
    content: Option<String>,
}

fn header_start(header: &str) -> Option<(usize, usize)> {
    let mut parts = header.strip_prefix("@@ -")?.split_whitespace();
    let old = parts.next()?.split(',').next()?.parse().ok()?;
    let new = parts
        .next()?
        .strip_prefix('+')?
        .split(',')
        .next()?
        .parse()
        .ok()?;
    (old <= 1_000_000 && new <= 1_000_000).then_some((old, new))
}

fn patch_edits(patch: &str) -> Vec<Edit> {
    let mut edits = Vec::<Edit>::new();
    let mut in_hunk = false;
    for line in patch.lines() {
        let header = ["*** Update File: ", "*** Add File: ", "*** Delete File: "]
            .iter()
            .find_map(|prefix| line.strip_prefix(prefix).map(|path| (path, *prefix)));
        if let Some((path, prefix)) = header {
            if edits.len() == 32 {
                break;
            }
            edits.push(Edit {
                path: path.to_owned(),
                content: None,
                hunks: vec![Hunk {
                    old_start: (prefix == "*** Add File: ").then_some(1),
                    new_start: (prefix == "*** Add File: ").then_some(1),
                    ..Hunk::default()
                }],
            });
            in_hunk = true;
            continue;
        }
        if let Some(paths) = line.strip_prefix("diff --git a/") {
            if edits.len() == 32 {
                break;
            }
            if let Some((_, path)) = paths.split_once(" b/") {
                edits.push(Edit {
                    path: path.to_owned(),
                    hunks: vec![],
                    content: None,
                });
                in_hunk = false;
            }
            continue;
        }
        if !in_hunk {
            if let Some(path) = line.strip_prefix("+++ b/") {
                if let Some(edit) = edits.last_mut() {
                    edit.path = path.to_owned();
                } else if edits.len() < 32 {
                    edits.push(Edit {
                        path: path.to_owned(),
                        hunks: vec![],
                        content: None,
                    });
                }
                continue;
            }
        }
        let Some(edit) = edits.last_mut() else {
            continue;
        };
        if line.starts_with("@@") {
            in_hunk = true;
            let (old_start, new_start) = header_start(line)
                .map(|(a, b)| (Some(a), Some(b)))
                .unwrap_or_default();
            edit.hunks.push(Hunk {
                old_start,
                new_start,
                ..Hunk::default()
            });
        } else if in_hunk && !line.starts_with("***") {
            if let Some(kind @ ('+' | '-' | ' ')) = line.chars().next() {
                if edit.hunks.is_empty() {
                    edit.hunks.push(Hunk::default());
                }
                edit.hunks
                    .last_mut()
                    .unwrap()
                    .lines
                    .push((kind, line[1..].to_owned()));
            }
        }
    }
    edits
}

fn reported_hunks(response: &Value) -> Option<Vec<Hunk>> {
    let hunks = response.get("structuredPatch")?.as_array()?;
    if hunks.len() > 64 {
        return None;
    }
    let mut result = Vec::new();
    for hunk in hunks {
        let old = hunk.get("oldStart")?.as_u64()? as usize;
        let new = hunk.get("newStart")?.as_u64()? as usize;
        let values = hunk.get("lines")?.as_array()?;
        if old > 1_000_000 || new > 1_000_000 || values.len() > 2_000 {
            return None;
        }
        let mut lines = Vec::new();
        for value in values {
            let line = value.as_str()?;
            if line.starts_with('\\') {
                continue;
            }
            if line.len() > MAX_TEXT {
                return None;
            }
            let kind = line.chars().next()?;
            if !matches!(kind, '+' | '-' | ' ') {
                return None;
            }
            lines.push((kind, line[1..].to_owned()));
        }
        result.push(Hunk {
            old_start: Some(old),
            new_start: Some(new),
            lines,
        });
    }
    (!result.is_empty()).then_some(result)
}

/// Only a completed edit may locate its excerpt in the file it just changed.
/// Canonical paths keep this bounded read in that session's actual workspace.
fn edited_file(cwd: &str, path: &str, budget: Duration) -> Option<String> {
    if budget.is_zero() {
        return None;
    }
    let (tx, rx) = mpsc::channel();
    let cwd = cwd.to_owned();
    let path = path.to_owned();
    std::thread::spawn(move || {
        let _ = tx.send(read_edited_file(&cwd, &path));
    });
    rx.recv_timeout(budget).ok().flatten()
}

fn read_edited_file(cwd: &str, path: &str) -> Option<String> {
    if !safe_path(path) || !Path::new(cwd).is_absolute() {
        return None;
    }
    let base = Path::new(cwd).canonicalize().ok()?;
    let candidate = if Path::new(path).is_absolute() {
        Path::new(path).to_path_buf()
    } else {
        base.join(path)
    };
    let resolved = candidate.canonicalize().ok()?;
    if !resolved.starts_with(&base) || !safe_path(&resolved.to_string_lossy()) {
        return None;
    }
    let file = File::open(resolved).ok()?;
    if !file.metadata().ok()?.is_file() || file.metadata().ok()?.len() > MAX_FILE {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_FILE || bytes.contains(&0) {
        return None;
    }
    Some(String::from_utf8(bytes).ok()?.replace("\r\n", "\n"))
}

fn locate_hunks(hunks: &mut [Hunk], content: &str) {
    let source: Vec<&str> = content.lines().collect();
    for hunk in hunks.iter_mut() {
        if hunk.new_start.is_none() {
            let after: Vec<&str> = hunk
                .lines
                .iter()
                .filter(|(kind, _)| *kind != '-')
                .map(|(_, text)| text.as_str())
                .collect();
            if !after.is_empty() && source.len() >= after.len() {
                let mut matches = source
                    .windows(after.len())
                    .enumerate()
                    .filter(|(_, candidate)| *candidate == after);
                if let Some((index, _)) = matches.next() {
                    if matches.next().is_none() {
                        hunk.new_start = Some(index + 1);
                    }
                }
            }
        }
    }
    // Derive the old gutter from changes above this location, independently of
    // the order the agent supplied its edits. Unlocated changes stay excerpts.
    let positions: Vec<_> = hunks
        .iter()
        .map(|hunk| {
            (
                hunk.new_start,
                hunk.lines.iter().filter(|(kind, _)| *kind == '+').count() as isize
                    - hunk.lines.iter().filter(|(kind, _)| *kind == '-').count() as isize,
            )
        })
        .collect();
    for hunk in hunks.iter_mut().filter(|hunk| hunk.old_start.is_none()) {
        let Some(new) = hunk.new_start else { continue };
        if positions
            .iter()
            .any(|(start, delta)| start.is_none() && *delta != 0)
        {
            continue;
        }
        let delta: isize = positions
            .iter()
            .filter(|(start, _)| start.is_some_and(|start| start < new))
            .map(|(_, delta)| delta)
            .sum();
        let old = new as isize - delta;
        hunk.old_start = (old > 0).then_some(old as usize);
    }
}

fn excerpt(edit: &Edit) -> Option<Value> {
    let first = edit
        .hunks
        .iter()
        .flat_map(|hunk| &hunk.lines)
        .position(|(kind, _)| *kind != ' ')
        .unwrap_or(0)
        .saturating_sub(2);
    let mut rows = Vec::with_capacity(MAX_LINES);
    let mut index = 0;
    let mut added = 0;
    let mut removed = 0;
    for hunk in &edit.hunks {
        let mut old = hunk.old_start;
        let mut new = hunk.new_start;
        for (kind, text) in &hunk.lines {
            let number = if *kind == '-' { old } else { new };
            let name = match kind {
                '+' => {
                    added += 1;
                    "added"
                }
                '-' => {
                    removed += 1;
                    "removed"
                }
                _ => "context",
            };
            if index >= first && rows.len() < MAX_LINES {
                rows.push((text.as_str(), name, number.filter(|n| *n > 0)));
            }
            index += 1;
            if *kind != '+' {
                old = old.map(|n| n + 1);
            }
            if *kind != '-' {
                new = new.map(|n| n + 1);
            }
        }
    }
    if let Some(content) = &edit.content {
        rows.extend(
            content
                .lines()
                .take(MAX_LINES)
                .enumerate()
                .map(|(i, text)| (text, "context", Some(i + 1))),
        );
    }
    let mut value = json!({ "target": edit.path });
    if !rows.is_empty() {
        value["preview"] = json!({
            "lines": rows.iter().map(|(text,_,_)| crate::short_preview_line(text)).collect::<Vec<_>>(),
            "kinds": rows.iter().map(|(_,kind,_)| *kind).collect::<Vec<_>>(),
            "lineNumbers": rows.iter().map(|(_,_,number)| *number).collect::<Vec<_>>() });
    }
    if added > 0 || removed > 0 {
        value["changes"] = json!({"added": added, "removed": removed});
    }
    Some(value)
}

pub fn prepare_edits(payload: &Value) -> Option<Value> {
    // Network files must never delay the agent. All source lookups share this budget.
    let lookup_deadline = Instant::now() + Duration::from_millis(100);
    let event = payload.get("hook_event_name")?.as_str()?;
    if !matches!(
        event,
        "PreToolUse" | "PermissionRequest" | "PostToolUse" | "PostToolUseFailure"
    ) {
        return None;
    }
    let tool = tool_name(payload.get("tool_name")?.as_str()?);
    let input = normalize_input(tool, payload.get("tool_input").unwrap_or(&Value::Null));
    let response = payload
        .get("tool_response")
        .or_else(|| payload.get("tool_result"))
        .unwrap_or(&Value::Null);
    let path = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut edits = match tool {
        "apply_patch" => patch_edits(text(
            input
                .get("patch")
                .or_else(|| input.get("input"))
                .or_else(|| input.get("command")),
        )?),
        "Edit" | "MultiEdit" => {
            let values = input
                .get("edits")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_else(|| vec![input.clone()]);
            let mut hunks = Vec::new();
            for value in values.iter().take(64) {
                let before = text(value.get("old_string")).map(lines).unwrap_or_default();
                let after = text(value.get("new_string")).map(lines).unwrap_or_default();
                if !before.is_empty() || !after.is_empty() {
                    hunks.push(Hunk {
                        lines: before
                            .into_iter()
                            .map(|line| ('-', line))
                            .chain(after.into_iter().map(|line| ('+', line)))
                            .collect(),
                        ..Hunk::default()
                    });
                }
            }
            if event == "PostToolUse" {
                if let Some(reported) = reported_hunks(response) {
                    hunks = reported;
                }
            }
            vec![Edit {
                path: path.to_owned(),
                hunks,
                content: None,
            }]
        }
        "Write" => vec![Edit {
            path: path.to_owned(),
            hunks: vec![],
            content: text(input.get("content")).map(str::to_owned),
        }],
        _ => return None,
    };
    let cwd = payload.get("cwd").and_then(Value::as_str).unwrap_or("");
    let mut results = Vec::new();
    for edit in &mut edits {
        if !safe_path(&edit.path) {
            continue;
        }
        if event == "PostToolUse" && edit.hunks.iter().any(|hunk| hunk.new_start.is_none()) {
            if let Some(content) = edited_file(
                cwd,
                &edit.path,
                lookup_deadline.saturating_duration_since(Instant::now()),
            ) {
                locate_hunks(&mut edit.hunks, &content);
            }
        }
        if let Some(value) = excerpt(edit) {
            results.push(value);
        }
    }
    (!results.is_empty()).then_some(json!(results))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_rows_starting_with_plus_or_minus_are_code_not_file_headers() {
        let result = prepare_edits(&json!({"hook_event_name":"PostToolUse", "tool_name":"apply_patch",
            "tool_input":{"input":"diff --git a/counter.ts b/counter.ts\n--- a/counter.ts\n+++ b/counter.ts\n@@ -71,3 +71,3 @@\n function step() {\n---counter;\n+++counter;\n }"}})).unwrap();
        assert_eq!(result[0]["target"], "counter.ts");
        assert_eq!(
            result[0]["preview"]["lines"],
            json!(["function step() {", "--counter;", "++counter;", "}"])
        );
        assert_eq!(
            result[0]["preview"]["kinds"],
            json!(["context", "removed", "added", "context"])
        );
        assert_eq!(result[0]["preview"]["lineNumbers"], json!([71, 72, 72, 73]));
        assert_eq!(result[0]["changes"], json!({"added":1, "removed":1}));
    }

    #[test]
    fn trailing_blank_lines_are_retained_in_edits_for_both_line_endings() {
        for newline in ["\n", "\r\n"] {
            let result = prepare_edits(&json!({"hook_event_name":"PreToolUse", "tool_name":"Edit",
                "tool_input":{"file_path":"spacing.ts", "old_string":format!("before{newline}{newline}"),
                    "new_string":format!("after{newline}{newline}{newline}")}})).unwrap();
            assert_eq!(
                result[0]["preview"]["lines"],
                json!(["before", "", "after", "", ""])
            );
            assert_eq!(result[0]["changes"], json!({"added":3, "removed":2}));
        }
    }

    #[test]
    fn large_hunks_keep_the_excerpt_near_the_change_and_count_every_edit() {
        let mut rows = (0..100)
            .map(|i| format!(" context {i}"))
            .collect::<Vec<_>>();
        rows.push("-before".to_string());
        rows.extend((0..40).map(|i| format!("+after {i}")));
        let result = prepare_edits(&json!({"hook_event_name":"PostToolUse", "tool_name":"Edit",
            "tool_input":{"file_path":"large.ts"},
            "tool_response":{"structuredPatch":[{"oldStart":200,"newStart":200,"lines":rows}]}}))
        .unwrap();
        let preview = &result[0]["preview"];
        assert_eq!(preview["lines"].as_array().unwrap().len(), MAX_LINES);
        assert_eq!(preview["lines"][0], "context 98");
        assert_eq!(preview["lines"][2], "before");
        assert_eq!(preview["lineNumbers"][2], 300);
        assert_eq!(preview["lineNumbers"][3], 300);
        assert_eq!(result[0]["changes"], json!({"added":40, "removed":1}));
    }

    #[test]
    fn source_positions_account_for_edits_above_each_hunk_even_in_reverse_input_order() {
        let mut hunks = vec![
            Hunk {
                lines: vec![('-', 'x'.to_string()), ('+', "lastAfter".to_string())],
                ..Hunk::default()
            },
            Hunk {
                lines: vec![
                    ('-', 'y'.to_string()),
                    ('+', "firstAfter".to_string()),
                    ('+', "extraAdded".to_string()),
                ],
                ..Hunk::default()
            },
        ];
        locate_hunks(
            &mut hunks,
            "header\nfirstAfter\nextraAdded\nbridge\nlastAfter\n",
        );
        assert_eq!(hunks[0].new_start, Some(5));
        assert_eq!(hunks[0].old_start, Some(4));
        assert_eq!(hunks[1].new_start, Some(2));
        assert_eq!(hunks[1].old_start, Some(2));
    }

    #[test]
    fn codex_command_wrapped_patches_keep_diff_signs_source_positions_and_file_names() {
        let result = prepare_edits(&json!({"hook_event_name":"PostToolUse","tool_name":"apply_patch",
            "tool_input":{"command":"*** Begin Patch\n*** Update File: src/invoice.ts\n@@ -71,1 +71,1 @@\n-return 0;\n+return 42;\n*** End Patch"},
            "tool_response":"Exit code: 0\nWall time: 4.4 seconds\nOutput:"})).unwrap();
        assert_eq!(result[0]["target"], "src/invoice.ts");
        assert_eq!(result[0]["preview"]["kinds"], json!(["removed", "added"]));
        assert_eq!(result[0]["preview"]["lineNumbers"], json!([71, 71]));
    }

    #[test]
    fn edits_report_real_hunk_positions_and_counts_without_whole_inputs() {
        let result = prepare_edits(&json!({"hook_event_name":"PostToolUse", "tool_name":"Edit",
            "tool_input":{"file_path":"src/invoice.ts", "old_string":"return 0;", "new_string":"return 42;"},
            "tool_response":{"structuredPatch":[{"oldStart":14,"newStart":14,
                "lines":[" const sum = 42;","-return 0;","+return sum;","+// done"]}],"private":"not forwarded"}})).unwrap();
        assert_eq!(result[0]["preview"]["lineNumbers"], json!([14, 15, 15, 16]));
        assert_eq!(result[0]["changes"], json!({"added":2,"removed":1}));
        assert!(!result.to_string().contains("not forwarded"));
        assert!(!result.to_string().contains("old_string"));
    }

    #[test]
    fn multiple_files_get_separate_excerpts_and_no_invented_source_positions() {
        let result = prepare_edits(&json!({"hook_event_name":"PreToolUse", "tool_name":"functions.apply_patch",
            "tool_input":"*** Begin Patch\n*** Update File: src/a.ts\n@@\n-return 0;\n+return 42;\n*** Update File: src/b.ts\n@@ -71,1 +71,2 @@\n-before\n+after\n+more\n*** End Patch"})).unwrap();
        assert_eq!(result.as_array().unwrap().len(), 2);
        assert_eq!(result[0]["target"], "src/a.ts");
        assert_eq!(result[0]["changes"], json!({"added":1,"removed":1}));
        assert_eq!(result[0]["preview"]["lineNumbers"], json!([null, null]));
        assert_eq!(result[1]["preview"]["lineNumbers"], json!([71, 71, 72]));
        assert_eq!(result[1]["changes"], json!({"added":2,"removed":1}));
    }

    #[test]
    fn successful_codex_edits_locate_unique_source_lines_in_the_changed_workspace_file() {
        let workspace =
            std::env::temp_dir().join(format!("mimo-edit-lines-{}", std::process::id()));
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            workspace.join("invoice.ts"),
            "// invoice\nconst sum = 42;\nconst tax = sum * 0.196;\nreturn sum + tax;\n",
        )
        .unwrap();
        let mut event = json!({"hook_event_name":"PostToolUse", "tool_name":"apply_patch", "cwd":workspace,
            "tool_input":{"input":"*** Begin Patch\n*** Update File: invoice.ts\n@@\n const sum = 42;\n-return sum;\n+const tax = sum * 0.196;\n+return sum + tax;\n*** End Patch"}});
        let result = prepare_edits(&event).unwrap();
        assert_eq!(result[0]["preview"]["lineNumbers"], json!([2, 3, 3, 4]));
        event["hook_event_name"] = json!("PreToolUse");
        assert_eq!(
            prepare_edits(&event).unwrap()[0]["preview"]["lineNumbers"],
            json!([null, null, null, null])
        );
        assert!(edited_file(
            workspace.to_str().unwrap(),
            "../other-workspace.ts",
            Duration::from_millis(100)
        )
        .is_none());
        std::fs::write(
            workspace.join("invoice.ts"),
            "header\nafter\n\n\nbridge\nlastAfter\n",
        )
        .unwrap();
        let result = prepare_edits(
            &json!({"hook_event_name":"PostToolUse", "tool_name":"MultiEdit", "cwd":workspace,
            "tool_input":{"file_path":"invoice.ts", "edits":[
                {"old_string":"before\n\n", "new_string":"after\n\n\n"},
                {"old_string":"lastBefore", "new_string":"lastAfter"}]}}),
        )
        .unwrap();
        assert_eq!(
            result[0]["preview"]["lineNumbers"],
            json!([2, 3, 2, 3, 4, 5, 6])
        );
        assert_eq!(result[0]["changes"], json!({"added":4, "removed":3}));
        std::fs::remove_file(workspace.join("invoice.ts")).unwrap();
        std::fs::remove_dir(workspace).unwrap();
    }

    #[test]
    fn ambiguous_matches_stay_snippets_and_sensitive_files_never_get_previews() {
        let mut hunks = vec![Hunk {
            lines: vec![('-', 'x'.to_string()), ('+', 'y'.to_string())],
            ..Hunk::default()
        }];
        locate_hunks(&mut hunks, "y\ny\n");
        assert!(hunks[0].new_start.is_none());
        for path in [".env", ".env.local", "C:/work/auth.json"] {
            assert!(
                prepare_edits(&json!({"hook_event_name":"PreToolUse", "tool_name":"Edit",
                "tool_input":{"file_path":path,"old_string":"private","new_string":"private-new"}}))
                .is_none()
            );
        }
        assert_eq!(
            normalize_input("exec_command", &json!({"cmd":"npm test"}))["command"],
            "npm test"
        );
    }
}
