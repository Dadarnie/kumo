// SPDX-License-Identifier: MIT
//! Bounded test summaries from reported command output, before preview truncation.
use serde_json::{json, Map, Value};

fn before(words: &[&str], label: &str) -> Option<u64> {
    words.windows(2).find_map(|pair| {
        (pair[1].trim_matches(|c: char| !c.is_alphabetic()) == label)
            .then(|| {
                pair[0]
                    .trim_matches(|c: char| !c.is_ascii_digit())
                    .parse::<u64>()
                    .ok()
            })
            .flatten()
            .filter(|n| *n <= 1_000_000)
    })
}

fn after(line: &str, label: &str) -> Option<u64> {
    line.strip_prefix(label)?
        .trim()
        .split_whitespace()
        .next()?
        .trim_matches(|c: char| !c.is_ascii_digit())
        .parse::<u64>()
        .ok()
        .filter(|n| *n <= 1_000_000)
}

pub fn parse(text: &str) -> Option<Value> {
    let mut fields = Map::new();
    let mut cases = Vec::new();
    // Bound the scan and strip terminal escape sequences without retaining raw output.
    let mut clean = String::new();
    let mut escape = false;
    let start = text
        .char_indices()
        .rev()
        .nth(127_999)
        .map_or(0, |(index, _)| index);
    for ch in text[start..].chars() {
        if ch == '\x1b' {
            escape = true;
            continue;
        }
        if escape {
            if ch.is_ascii_alphabetic() {
                escape = false;
            }
            continue;
        }
        clean.push(ch);
    }
    for line in clean.lines() {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        let node = lower.trim_start_matches(['#', 'ℹ', ' ']).trim();
        for (label, name) in [
            ("pass ", "passed"),
            ("fail ", "failed"),
            ("tests ", "total"),
            ("skipped ", "skipped"),
        ] {
            if let Some(value) = after(node, label) {
                fields.insert(name.into(), json!(value));
            }
        }
        let summary = lower.starts_with("tests:")
            || lower.starts_with("tests ")
            || lower.starts_with("test result:")
            || lower.starts_with('=') && lower.contains(" passed");
        if summary {
            let words: Vec<_> = lower.split_whitespace().collect();
            for label in ["passed", "failed", "skipped", "total"] {
                if let Some(value) = before(&words, label) {
                    fields.insert(label.into(), json!(value));
                }
            }
            if let Some(total) = lower
                .rsplit_once('(')
                .and_then(|(_, tail)| tail.trim_end_matches(')').parse::<u64>().ok())
                .filter(|n| *n <= 1_000_000)
            {
                fields.insert("total".into(), json!(total));
            }
        }
        let result = line
            .strip_prefix("PASS ")
            .map(|name| (name, "passed", "suite"))
            .or_else(|| {
                line.strip_prefix("FAIL ")
                    .map(|name| (name, "failed", "suite"))
            })
            .or_else(|| line.strip_prefix("✔ ").map(|name| (name, "passed", "test")))
            .or_else(|| line.strip_prefix("✖ ").map(|name| (name, "failed", "test")));
        if let Some((name, status, kind)) = result {
            let name: String = name.chars().take(160).collect();
            let case = json!({"name":name,"status":status,"kind":kind});
            if let Some(index) = cases.iter().position(|existing: &Value| {
                existing["name"] == case["name"] && existing["kind"] == case["kind"]
            }) {
                cases[index] = case;
            } else if cases.len() < 32 {
                cases.push(case);
            }
        }
    }
    // A PASS suite is never counted as an individual passed test.
    if fields.is_empty() && cases.is_empty() {
        return None;
    }
    fields.insert("cases".into(), json!(cases));
    Some(Value::Object(fields))
}

pub fn prepare(payload: &Value) -> Option<Value> {
    let event = payload.get("hook_event_name")?.as_str()?;
    let tool = payload.get("tool_name")?.as_str()?;
    if !matches!(event, "PostToolUse" | "PostToolUseFailure")
        || !matches!(tool, "Bash" | "PowerShell" | "exec_command" | "run_command")
    {
        return None;
    }
    let result = payload
        .get("tool_response")
        .or_else(|| payload.get("tool_result"))?;
    let mut summary = Map::new();
    let mut cases = Vec::new();
    for text in [
        result.as_str(),
        result.get("stdout").and_then(Value::as_str),
        result.get("output").and_then(Value::as_str),
        result.get("stderr").and_then(Value::as_str),
        result.pointer("/content/0/text").and_then(Value::as_str),
    ]
    .into_iter()
    .flatten()
    {
        let Some(Value::Object(fields)) = parse(crate::tool_output(text)) else {
            continue;
        };
        for (key, value) in fields {
            if key != "cases" {
                summary.insert(key, value);
                continue;
            }
            for case in value.as_array().into_iter().flatten() {
                if let Some(index) = cases.iter().position(|existing: &Value| {
                    existing["name"] == case["name"] && existing["kind"] == case["kind"]
                }) {
                    cases[index] = case.clone();
                } else if cases.len() < 32 {
                    cases.push(case.clone());
                }
            }
        }
    }
    if summary.is_empty() && cases.is_empty() {
        return None;
    }
    summary.insert("cases".into(), json!(cases));
    Some(Value::Object(summary))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn summaries_survive_long_output_and_keep_suite_counts_separate() {
        let text = format!(
            "{}\nPASS invoice.test.ts\nTests: 48 passed, 48 total",
            "setup\n".repeat(30_000)
        );
        let result = parse(&text).unwrap();
        assert_eq!(result["passed"], 48);
        assert_eq!(result["total"], 48);
        assert_eq!(result["cases"][0]["kind"], "suite");
        assert!(parse("PASS invoice.test.ts")
            .unwrap()
            .get("passed")
            .is_none());
    }
    #[test]
    fn node_and_cargo_report_actual_counts() {
        let node = parse("ℹ tests 8\nℹ pass 6\nℹ fail 1\nℹ skipped 1").unwrap();
        assert_eq!(node["total"], 8);
        assert_eq!(node["passed"], 6);
        assert_eq!(node["failed"], 1);
        let cargo = parse("test result: ok. 31 passed; 0 failed; 2 ignored; 0 measured").unwrap();
        assert_eq!(cargo["passed"], 31);
        assert_eq!(cargo["failed"], 0);
    }
    #[test]
    fn success_and_code_do_not_invent_results() {
        assert!(parse("Exit code: 0\nbuild succeeded\nconst PASS = true;").is_none());
        assert!(prepare(&json!({"hook_event_name":"PostToolUse","tool_name":"Read","tool_response":"Tests: 5 passed, 5 total"})).is_none());
    }
    #[test]
    fn stderr_summaries_and_retried_cases_keep_the_latest_reported_result() {
        let result = prepare(&json!({"hook_event_name":"PostToolUse","tool_name":"Bash",
            "tool_response":{"stdout":"setup\nPASS invoice.test.ts", "stderr":"FAIL invoice.test.ts\nTests: 1 failed, 1 total"}})).unwrap();
        assert_eq!(result["failed"], 1);
        assert_eq!(result["total"], 1);
        assert_eq!(result["cases"].as_array().unwrap().len(), 1);
        assert_eq!(result["cases"][0]["status"], "failed");
    }
    #[test]
    fn cases_are_bounded_deduplicated_and_strip_ansi() {
        let text = format!(
            "\x1b[32mPASS a.test.ts\x1b[0m\nPASS a.test.ts\n{}",
            (0..50)
                .map(|i| format!("PASS {i}.test.ts"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        let result = parse(&text).unwrap();
        assert_eq!(result["cases"].as_array().unwrap().len(), 32);
        assert_eq!(result["cases"][0]["name"], "a.test.ts");
    }
}
