// SPDX-License-Identifier: MIT
//! Bounded AskUserQuestion input and answers, shared by the relay and native host.
use serde_json::{json, Map, Value};

/// Native Claude hooks and the explicit MCP tool have actual answer channels.
/// Ordinary activity hooks for other providers must remain observational.
pub fn from_event(payload: &Value, provider: &str) -> Option<Value> {
    let tool = payload.get("tool_name").and_then(Value::as_str);
    let supported = (provider == "claude" && tool == Some("AskUserQuestion"))
        || (tool == Some("mimo.ask_user") && payload["mimo_response_channel"] == "mcp");
    if payload["hook_event_name"] != "PreToolUse" || !supported {
        return None;
    }
    normalize(&payload["mimo_questions"])
}

fn text(value: &Value, limit: usize) -> Option<&str> {
    value
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= limit)
}

/// Keep question content only. Unknown tool fields and prefilled answers stay local.
pub fn normalize(value: &Value) -> Option<Value> {
    let questions = value.as_array().filter(|q| !q.is_empty() && q.len() <= 4)?;
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for question in questions {
        let title = text(question.get("question")?, 2_000)?;
        if !seen.insert(title) {
            return None;
        }
        let header = question
            .get("header")
            .and_then(|v| text(v, 80))
            .unwrap_or("Question");
        let options = question
            .get("options")?
            .as_array()
            .filter(|v| v.len() <= 8)?;
        let mut labels = std::collections::HashSet::new();
        let mut choices = Vec::new();
        for option in options {
            let label = text(option.get("label")?, 200)?;
            if !labels.insert(label) {
                return None;
            }
            let description = option
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            if description.len() > 1_000 {
                return None;
            }
            choices.push(json!({"label":label,"description":description}));
        }
        let multi = match question.get("multiSelect") {
            None => false,
            Some(value) => value.as_bool()?,
        };
        result
            .push(json!({"question":title,"header":header,"options":choices,"multiSelect":multi}));
    }
    Some(Value::Array(result))
}

/// Validate every answer against the pending request, including exact question keys.
pub fn answers(questions: &Value, value: &Value) -> Option<Value> {
    let questions = normalize(questions)?;
    let questions = questions.as_array()?;
    let supplied = value
        .as_object()
        .filter(|map| map.len() == questions.len())?;
    let mut result = Map::new();
    for question in questions {
        let key = question["question"].as_str()?;
        result.insert(
            key.into(),
            Value::String(text(supplied.get(key)?, 2_000)?.to_owned()),
        );
    }
    Some(Value::Object(result))
}

/// Claude's documented PreToolUse answer contract. An allow without answers is invalid.
pub fn hook_output(questions: &Value, supplied: &Value) -> Option<String> {
    let answers = answers(questions, supplied)?;
    Some(
        json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow",
        "updatedInput":{"questions":normalize(questions)?,"answers":answers}}})
        .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        json!([{ "question":"Which framework?", "header":"Framework",
        "options":[{"label":"React","description":"Components"},{"label":"Vue"}],"multiSelect":false }])
    }

    #[test]
    fn question_answers_round_trip_through_the_documented_hook_shape() {
        let original = normalize(&fixture()).unwrap();
        let output: Value = serde_json::from_str(
            &hook_output(&original, &json!({"Which framework?":"Vue"})).unwrap(),
        )
        .unwrap();
        assert_eq!(output["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(output["hookSpecificOutput"]["permissionDecision"], "allow");
        assert_eq!(
            output["hookSpecificOutput"]["updatedInput"]["questions"],
            original
        );
        assert_eq!(
            output["hookSpecificOutput"]["updatedInput"]["answers"]["Which framework?"],
            "Vue"
        );
        assert!(hook_output(&original, &json!({})).is_none());
        assert!(hook_output(&original, &json!({"Wrong question":"Vue"})).is_none());
        assert!(hook_output(&original, &json!({"Which framework?":"  "})).is_none());
        assert!(hook_output(&original, &json!({"Which framework?":"Vue","extra":"No"})).is_none());
    }

    #[test]
    fn rejects_ambiguous_or_oversized_questions_and_preserves_free_text() {
        let mut input = fixture();
        let duplicate = input[0].clone();
        input.as_array_mut().unwrap().push(duplicate);
        assert!(normalize(&input).is_none());
        input = fixture();
        input[0]["question"] = json!("x".repeat(2_001));
        assert!(normalize(&input).is_none());
        input = fixture();
        input[0]["options"][1]["label"] = json!("React");
        assert!(normalize(&input).is_none());
        assert_eq!(
            answers(
                &fixture(),
                &json!({"Which framework?":"A custom answer\nwith details"})
            )
            .unwrap()["Which framework?"],
            "A custom answer\nwith details"
        );
    }
}
