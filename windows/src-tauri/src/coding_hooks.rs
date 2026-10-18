// SPDX-License-Identifier: MIT
//! Documented user-level coding hooks. Activity only; never edit authentication or trust.
use crate::{
    hook_config,
    hooks::{self, HookPreview, HookStatus},
    settings::{self, CodingAssistant},
    windows,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const NAME: &str = "mimo-companion";
const GEMINI: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "BeforeAgent",
    "AfterAgent",
    "BeforeTool",
    "AfterTool",
];
const MUSE: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "SubagentStart",
    "SubagentStop",
];
const COPILOT: &[&str] = &[
    "sessionStart",
    "sessionEnd",
    "userPromptSubmitted",
    "preToolUse",
    "postToolUse",
    "postToolUseFailure",
    "agentStop",
    "errorOccurred",
    "subagentStop",
];
const ANTIGRAVITY: &[&str] = &["PreInvocation", "PreToolUse", "PostToolUse", "Stop"];
// Native Cursor hooks use flat command lists, not Claude-style hook groups.
const CURSOR: &[&str] = &[
    "sessionStart",
    "sessionEnd",
    "beforeSubmitPrompt",
    "preToolUse",
    "postToolUse",
    "postToolUseFailure",
    "stop",
];
fn events(provider: CodingAssistant) -> &'static [&'static str] {
    match provider {
        CodingAssistant::Cursor => CURSOR,
        CodingAssistant::Gemini => GEMINI,
        CodingAssistant::Muse => MUSE,
        CodingAssistant::Copilot => COPILOT,
        CodingAssistant::Antigravity => ANTIGRAVITY,
        _ => &[],
    }
}
fn environment_dir(name: &str, fallback: PathBuf) -> PathBuf {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or(fallback)
}
pub fn settings_path(provider: CodingAssistant) -> PathBuf {
    let home = windows::home_dir();
    let config = environment_dir("XDG_CONFIG_HOME", home.join(".config"));
    match provider {
        CodingAssistant::Cursor => home.join(".cursor/hooks.json"),
        CodingAssistant::Gemini => home.join(".gemini/settings.json"),
        CodingAssistant::Antigravity => home.join(".gemini/config/hooks.json"),
        CodingAssistant::Muse => config.join("muse/settings.json"),
        CodingAssistant::Copilot => {
            environment_dir("COPILOT_HOME", home.join(".copilot")).join("hooks/mimo-companion.json")
        }
        CodingAssistant::Opencode => config.join("opencode/plugins/mimo-companion.js"),
        CodingAssistant::Hermes => environment_dir("HERMES_HOME", home.join(".hermes"))
            .join("plugins/mimo-companion/__init__.py"),
        _ => unreachable!("existing providers use their own installer"),
    }
}
fn command(provider: CodingAssistant, event: &str) -> String {
    command_for_relay(provider, event, &settings::hook_exe_path())
}
fn command_for_relay(provider: CodingAssistant, event: &str, relay: &Path) -> String {
    let exe = relay.to_string_lossy().replace('\'', "''");
    let script = format!("& '{exe}' --provider {} {event}", provider.id());
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "powershell.exe -NoProfile -NonInteractive -EncodedCommand {}",
        STANDARD.encode(bytes)
    )
}
fn ours(provider: CodingAssistant, handler: &Value) -> bool {
    let field = if provider == CodingAssistant::Copilot {
        "powershell"
    } else {
        "command"
    };
    events(provider).iter().any(|event| {
        let value = handler.get(field).and_then(Value::as_str);
        value == Some(command(provider, event).as_str())
            || value
                == Some(
                    command_for_relay(provider, event, &crate::migration::legacy_hook_path())
                        .as_str(),
                )
    })
}
fn parse(bytes: &[u8]) -> Result<Value, String> {
    let value = hooks::parse_settings(bytes, "Assistant hooks")?;
    if !value.is_object() {
        return Err("The hooks file must be a JSON object. Nothing was changed.".into());
    }
    Ok(value)
}
fn validate(provider: CodingAssistant, current: &Value) -> Result<(), String> {
    match provider {
        CodingAssistant::Muse => {
            if current
                .get("schema_version")
                .is_some_and(|v| v.as_u64() != Some(1))
            {
                return Err(
                    "Muse settings use an unsupported schema version. Nothing was changed.".into(),
                );
            }
            hook_config::validate(current)
        }
        CodingAssistant::Cursor | CodingAssistant::Copilot => {
            if current
                .get("version")
                .is_some_and(|v| v.as_u64() != Some(1))
            {
                return Err(format!(
                    "{} hooks use an unsupported version. Nothing was changed.",
                    provider.name()
                ));
            }
            hook_config::validate(current)
        }
        CodingAssistant::Antigravity => {
            if let Some(definition) = current.get(NAME) {
                if !definition.is_object() {
                    return Err("The Mimo hook name is already used. Nothing was changed.".into());
                }
                for event in events(provider) {
                    if definition.get(*event).is_some_and(|v| !v.is_array()) {
                        return Err(
                            "Antigravity has an invalid event list. Nothing was changed.".into(),
                        );
                    }
                }
            }
            Ok(())
        }
        _ => hook_config::validate(current),
    }
}
fn without_ours(provider: CodingAssistant, current: &Value) -> Value {
    let mut next = current.clone();
    let table = if provider == CodingAssistant::Antigravity {
        next.get_mut(NAME)
    } else {
        next.get_mut("hooks")
    };
    if let Some(table) = table.and_then(Value::as_object_mut) {
        table.retain(|event, list| {
            if !events(provider).contains(&event.as_str()) {
                return true;
            }
            let Some(groups) = list.as_array_mut() else {
                return true;
            };
            let mut changed = false;
            groups.retain_mut(|group| {
                if matches!(provider, CodingAssistant::Cursor | CodingAssistant::Copilot)
                    || (provider == CodingAssistant::Antigravity
                        && matches!(event.as_str(), "PreInvocation" | "Stop"))
                {
                    if ours(provider, group) {
                        changed = true;
                        return false;
                    }
                } else if let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut)
                {
                    let len = handlers.len();
                    handlers.retain(|h| !ours(provider, h));
                    if handlers.len() != len {
                        changed = true;
                        return !handlers.is_empty();
                    }
                }
                true
            });
            !changed || !groups.is_empty()
        });
    }
    if provider == CodingAssistant::Antigravity
        && next
            .get(NAME)
            .and_then(Value::as_object)
            .is_some_and(|v| v.is_empty() || (v.len() == 1 && v.contains_key("enabled")))
    {
        next.as_object_mut().unwrap().remove(NAME);
    }
    next
}
fn merged(provider: CodingAssistant, current: &Value, install: bool) -> Result<Value, String> {
    validate(provider, current)?;
    let mut next = without_ours(provider, current);
    if !install {
        return Ok(next);
    }
    let root = next.as_object_mut().unwrap();
    if provider == CodingAssistant::Muse {
        root.entry("schema_version").or_insert(json!(1));
    }
    if matches!(provider, CodingAssistant::Cursor | CodingAssistant::Copilot) {
        root.entry("version").or_insert(json!(1));
    }
    let key = if provider == CodingAssistant::Antigravity {
        NAME
    } else {
        "hooks"
    };
    let table = root
        .entry(key)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("Invalid hook table. Nothing was changed.")?;
    for event in events(provider) {
        let list = table
            .entry(*event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("Invalid hook event list. Nothing was changed.")?;
        let handler = match provider {
            CodingAssistant::Copilot => {
                json!({"type":"command","powershell":command(provider, event),"timeoutSec":3})
            }
            CodingAssistant::Gemini => json!({"type":"command","command":command(provider, event),
                "name":format!("mimo-{}",event.to_lowercase()),"description":"Mimo activity observer","timeout":3000}),
            CodingAssistant::Muse => {
                json!({"type":"command","command":command(provider, event),"statusMessage":"Mimo activity observer","timeout":3})
            }
            _ => json!({"type":"command","command":command(provider, event),"timeout":3}),
        };
        if matches!(provider, CodingAssistant::Cursor | CodingAssistant::Copilot)
            || (provider == CodingAssistant::Antigravity
                && matches!(*event, "PreInvocation" | "Stop"))
        {
            list.push(handler);
        } else {
            let group = if provider == CodingAssistant::Antigravity
                && matches!(*event, "PreToolUse" | "PostToolUse")
            {
                json!({"matcher":".*","hooks":[handler]})
            } else {
                json!({"hooks":[handler]})
            };
            list.push(group);
        }
    }
    Ok(next)
}

fn plugin(provider: CodingAssistant, install: bool) -> String {
    plugin_for_relay(provider, install, &settings::hook_exe_path())
}
fn plugin_for_relay(provider: CodingAssistant, install: bool, path: &Path) -> String {
    let relay = serde_json::to_string(&path.to_string_lossy()).unwrap();
    match (provider, install) {
        (CodingAssistant::Opencode, true) => include_str!("../../integrations/opencode.mjs").replace("__MIMO_RELAY__", &relay),
        (CodingAssistant::Opencode, false) => "// Mimo companion: activity observer removed\nexport const MimoCompanion = async () => ({});\n".into(),
        (CodingAssistant::Hermes, true) => include_str!("../../integrations/hermes.py").replace("__MIMO_RELAY__", &relay),
        (CodingAssistant::Hermes, false) => "# Mimo companion: activity observer removed\ndef register(ctx):\n    pass\n".into(),
        _ => unreachable!(),
    }
}
fn manifest(install: bool) -> Vec<u8> {
    let hooks = if install {
        "[pre_llm_call, post_llm_call, pre_tool_call, post_tool_call]"
    } else {
        "[]"
    };
    format!("# Mimo companion — no credentials or tools\nname: mimo-companion\nversion: 1.0.0\ndescription: Local Mimo activity observer\nprovides_tools: []\nprovides_hooks: {hooks}\n").into_bytes()
}

struct Artifact {
    path: PathBuf,
    before: Vec<u8>,
    after: Vec<u8>,
}
fn artifacts(
    provider: CodingAssistant,
    path: &Path,
    install: bool,
) -> Result<Vec<Artifact>, String> {
    let before = hook_config::read(path)?;
    let after = if matches!(
        provider,
        CodingAssistant::Opencode | CodingAssistant::Hermes
    ) {
        if !before.is_empty()
            && before != plugin(provider, true).as_bytes()
            && before != plugin(provider, false).as_bytes()
            && before
                != plugin_for_relay(provider, true, &crate::migration::legacy_hook_path())
                    .as_bytes()
        {
            return Err("The Mimo plugin file contains other code. Rename it before installing; nothing was changed.".into());
        }
        plugin(provider, install).into_bytes()
    } else {
        format!(
            "{}\n",
            hooks::pretty(&merged(provider, &parse(&before)?, install)?)
        )
        .into_bytes()
    };
    let mut files = vec![Artifact {
        path: path.into(),
        before,
        after,
    }];
    if provider == CodingAssistant::Hermes {
        let path = path.with_file_name("plugin.yaml");
        let before = hook_config::read(&path)?;
        if !before.is_empty() && before != manifest(true) && before != manifest(false) {
            return Err("The Mimo manifest contains other configuration. Rename it before installing; nothing was changed.".into());
        }
        files.push(Artifact {
            path,
            before,
            after: manifest(install),
        });
    }
    Ok(files)
}
fn fingerprint(files: &[Artifact]) -> String {
    // Length-delimited files bind the reviewed preview to the complete package.
    let mut bytes = Vec::new();
    for file in files {
        bytes.extend_from_slice(&(file.before.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&file.before);
    }
    hooks::fingerprint(&bytes)
}
fn preview_at(
    provider: CodingAssistant,
    path: &Path,
    install: bool,
) -> Result<HookPreview, String> {
    let files = artifacts(provider, path, install)?;
    let sign = if install { "+" } else { "-" };
    let diff = if events(provider).is_empty() {
        format!("{sign} {}: local activity observer\n{sign} Reading, editing, commands, and turn completion\n  Permissions remain in {}. No credentials are accessed.", provider.name(), provider.name())
    } else {
        events(provider)
            .iter()
            .map(|e| format!("{sign} {e}: Mimo activity observer"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok(HookPreview {
        diff,
        backup: hook_config::backup_path(path).to_string_lossy().into(),
        settings_path: path.to_string_lossy().into(),
        fingerprint: fingerprint(&files),
    })
}
pub fn preview(provider: CodingAssistant, install: bool) -> Result<HookPreview, String> {
    preview_at(provider, &settings_path(provider), install)
}
fn write_at(
    provider: CodingAssistant,
    path: &Path,
    install: bool,
    expected: &str,
) -> Result<String, String> {
    let files = artifacts(provider, path, install)?;
    if fingerprint(&files) != expected {
        return Err("Hooks changed since the preview. Review a fresh preview.".into());
    }
    // Preflight the entire package before any mutation. Each atomic save checks again.
    for file in &files {
        if hook_config::read(&file.path)? != file.before {
            return Err("Hooks changed since the preview. Review a fresh preview.".into());
        }
    }
    let mut backups = Vec::new();
    for (i, file) in files.iter().enumerate() {
        match hook_config::save_bytes(&file.path, &file.before, &file.after) {
            Ok(backup) => backups.push(backup),
            Err(error) => {
                // Roll back only bytes we just wrote; never replace a concurrent edit.
                for previous in files[..i].iter().rev() {
                    if hook_config::read(&previous.path).ok().as_deref()
                        == Some(previous.after.as_slice())
                    {
                        let _ = hook_config::save_bytes(
                            &previous.path,
                            &previous.after,
                            &previous.before,
                        );
                    }
                }
                return Err(error);
            }
        }
    }
    Ok(backups.join("\n"))
}
pub fn write(provider: CodingAssistant, install: bool, expected: &str) -> Result<String, String> {
    write_at(provider, &settings_path(provider), install, expected)
}
pub fn status(provider: CodingAssistant) -> HookStatus {
    let path = settings_path(provider);
    let installed = hook_config::read(&path).ok().is_some_and(|bytes| {
        if matches!(
            provider,
            CodingAssistant::Opencode | CodingAssistant::Hermes
        ) {
            bytes == plugin(provider, true).as_bytes()
                && (provider != CodingAssistant::Hermes
                    || hook_config::read(&path.with_file_name("plugin.yaml")).ok()
                        == Some(manifest(true)))
        } else {
            parse(&bytes).ok().is_some_and(|value| {
                let table = if provider == CodingAssistant::Antigravity {
                    value.get(NAME)
                } else {
                    value.get("hooks")
                };
                table.and_then(Value::as_object).is_some_and(|table| {
                    events(provider).iter().all(|event| {
                        table
                            .get(*event)
                            .and_then(Value::as_array)
                            .is_some_and(|groups| {
                                groups.iter().any(|group| {
                                    ours(provider, group)
                                        || group.get("hooks").and_then(Value::as_array).is_some_and(
                                            |handlers| handlers.iter().any(|h| ours(provider, h)),
                                        )
                                })
                            })
                    })
                })
            })
        }
    });
    let exe = settings::hook_exe_path();
    HookStatus {
        installed,
        settings_path: path.to_string_lossy().into(),
        hook_path: exe.to_string_lossy().into(),
        hook_ready: exe.is_file(),
        usage_ready: false,
        usage_command: None,
    }
}

fn has_legacy_handler(provider: CodingAssistant, value: &Value) -> bool {
    let field = if provider == CodingAssistant::Copilot {
        "powershell"
    } else {
        "command"
    };
    let legacy = |handler: &Value| {
        events(provider).iter().any(|event| {
            handler.get(field).and_then(Value::as_str)
                == Some(
                    command_for_relay(provider, event, &crate::migration::legacy_hook_path())
                        .as_str(),
                )
        })
    };
    let table = if provider == CodingAssistant::Antigravity {
        value.get(NAME)
    } else {
        value.get("hooks")
    };
    table.and_then(Value::as_object).is_some_and(|table| {
        events(provider).iter().any(|event| {
            table
                .get(*event)
                .and_then(Value::as_array)
                .is_some_and(|groups| {
                    groups.iter().any(|group| {
                        legacy(group)
                            || group
                                .get("hooks")
                                .and_then(Value::as_array)
                                .is_some_and(|handlers| handlers.iter().any(legacy))
                    })
                })
        })
    })
}

pub fn migrate_legacy_installations() {
    for provider in [
        CodingAssistant::Gemini,
        CodingAssistant::Muse,
        CodingAssistant::Copilot,
        CodingAssistant::Antigravity,
        CodingAssistant::Opencode,
        CodingAssistant::Hermes,
    ] {
        let path = settings_path(provider);
        let migration = (|| -> Result<(), String> {
            let bytes = hook_config::read(&path)?;
            if bytes.is_empty() {
                return Ok(());
            }
            if matches!(
                provider,
                CodingAssistant::Opencode | CodingAssistant::Hermes
            ) {
                if bytes
                    == plugin_for_relay(provider, true, &crate::migration::legacy_hook_path())
                        .as_bytes()
                {
                    let preview = preview_at(provider, &path, true)?;
                    write_at(provider, &path, true, &preview.fingerprint)?;
                }
            } else {
                let current = parse(&bytes)?;
                if has_legacy_handler(provider, &current) {
                    hook_config::save(&path, &bytes, &merged(provider, &current, true)?)?;
                }
            }
            Ok(())
        })();
        if migration.is_err() {
            crate::log::line(format!(
                "{} hook migration left the original configuration intact",
                provider.name()
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_native_hooks_are_flat_idempotent_and_preserve_existing_policies() {
        let provider = CodingAssistant::Cursor;
        let original = json!({"version":1,"private":"synthetic-secret","hooks":{
            "preToolUse":[{"command":"company-policy.exe","matcher":"Shell","failClosed":true}],
            "afterFileEdit":[{"command":"formatter.exe"}]}});
        let installed = merged(provider, &original, true).unwrap();
        assert_eq!(installed["version"], 1);
        for event in CURSOR {
            let handlers = installed["hooks"][*event].as_array().unwrap();
            let owned: Vec<_> = handlers
                .iter()
                .filter(|handler| ours(provider, handler))
                .collect();
            assert_eq!(owned.len(), 1, "One observer for {event}");
            assert!(owned[0].get("command").is_some());
            assert!(
                owned[0].get("hooks").is_none(),
                "Cursor uses flat command handlers"
            );
        }
        assert_eq!(
            installed["hooks"]["preToolUse"][0],
            original["hooks"]["preToolUse"][0]
        );
        assert_eq!(merged(provider, &installed, true).unwrap(), installed);
        assert_eq!(merged(provider, &installed, false).unwrap(), original);
        assert!(merged(provider, &json!({"version":2}), true).is_err());
        assert!(merged(provider, &json!({"hooks":{"stop":{}}}), true).is_err());
        assert!(settings_path(provider).ends_with(".cursor/hooks.json"));
    }

    #[test]
    fn cursor_preview_backs_up_and_refuses_configuration_changed_after_review() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("mimo-cursor-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("hooks.json");
        let original = br#"{"version":1,"private":"synthetic-secret","hooks":{"stop":[{"command":"foreign.exe"}]}}"#;
        std::fs::write(&path, original).unwrap();
        let preview = preview_at(CodingAssistant::Cursor, &path, true).unwrap();
        assert!(!preview.diff.contains("synthetic-secret"));
        let changed = br#"{"version":1,"concurrent":true}"#;
        std::fs::write(&path, changed).unwrap();
        assert!(write_at(CodingAssistant::Cursor, &path, true, &preview.fingerprint).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), changed);
        std::fs::write(&path, original).unwrap();
        let preview = preview_at(CodingAssistant::Cursor, &path, true).unwrap();
        let backup = write_at(CodingAssistant::Cursor, &path, true, &preview.fingerprint).unwrap();
        assert_eq!(std::fs::read(backup).unwrap(), original);
        assert_eq!(
            parse(&std::fs::read(&path).unwrap()).unwrap()["hooks"]["stop"][0]["command"],
            "foreign.exe"
        );
        // Fixed, test-owned directory: remove generated files individually.
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            std::fs::remove_file(entry.path()).unwrap();
        }
        std::fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn renamed_adapters_recognize_previous_relay_preserve_foreign_handlers_and_do_not_duplicate() {
        for provider in [
            CodingAssistant::Gemini,
            CodingAssistant::Muse,
            CodingAssistant::Copilot,
            CodingAssistant::Antigravity,
        ] {
            let original = json!({"hooks":{"Custom":[{"command":"foreign"}]}});
            let installed = merged(provider, &original, true).unwrap();
            let from = settings::hook_exe_path()
                .to_string_lossy()
                .replace('\'', "''");
            let to = crate::migration::legacy_hook_path()
                .to_string_lossy()
                .replace('\'', "''");
            fn previous_commands(value: &mut Value, from: &str, to: &str) {
                match value {
                    Value::String(command)
                        if command.starts_with(
                            "powershell.exe -NoProfile -NonInteractive -EncodedCommand ",
                        ) =>
                    {
                        let encoded = command.rsplit(' ').next().unwrap();
                        let bytes = STANDARD.decode(encoded).unwrap();
                        let words: Vec<_> = bytes
                            .chunks_exact(2)
                            .map(|part| u16::from_le_bytes([part[0], part[1]]))
                            .collect();
                        let script = String::from_utf16(&words).unwrap().replace(from, to);
                        let bytes: Vec<u8> =
                            script.encode_utf16().flat_map(u16::to_le_bytes).collect();
                        *command = format!(
                            "powershell.exe -NoProfile -NonInteractive -EncodedCommand {}",
                            STANDARD.encode(bytes)
                        );
                    }
                    Value::Array(values) => {
                        for value in values {
                            previous_commands(value, from, to);
                        }
                    }
                    Value::Object(values) => {
                        for value in values.values_mut() {
                            previous_commands(value, from, to);
                        }
                    }
                    _ => {}
                }
            }
            let mut previous = installed;
            previous_commands(&mut previous, &from, &to);
            assert!(has_legacy_handler(provider, &previous));
            let renamed = merged(provider, &previous, true).unwrap();
            assert!(!has_legacy_handler(provider, &renamed));
            assert_eq!(merged(provider, &renamed, true).unwrap(), renamed);
            assert_eq!(renamed["hooks"]["Custom"], original["hooks"]["Custom"]);
            assert!(!has_legacy_handler(
                provider,
                &json!({"other":{"command":command_for_relay(provider, events(provider)[0], &crate::migration::legacy_hook_path())}})
            ));
        }
        for provider in [CodingAssistant::Opencode, CodingAssistant::Hermes] {
            assert_ne!(
                plugin(provider, true),
                plugin_for_relay(provider, true, &crate::migration::legacy_hook_path())
            );
        }
    }
    #[test]
    fn json_adapters_preserve_foreign_hooks_and_never_install_permission_overrides() {
        for provider in [
            CodingAssistant::Gemini,
            CodingAssistant::Muse,
            CodingAssistant::Copilot,
            CodingAssistant::Antigravity,
        ] {
            let original = json!({"private":"synthetic-secret","hooks":{"Custom":[{"command":"foreign"}]},
                "other-hook":{"Stop":[{"command":"foreign"}]}});
            let next = merged(provider, &merged(provider, &original, true).unwrap(), true).unwrap();
            let mut cleaned = without_ours(provider, &next);
            if provider == CodingAssistant::Muse {
                cleaned.as_object_mut().unwrap().remove("schema_version");
            }
            if provider == CodingAssistant::Copilot {
                cleaned.as_object_mut().unwrap().remove("version");
            }
            assert_eq!(cleaned, original);
            assert!(!hooks::pretty(&next).contains("PermissionRequest"));
        }
    }
    #[test]
    fn malformed_foreign_settings_and_plugin_collisions_are_refused() {
        for provider in [
            CodingAssistant::Gemini,
            CodingAssistant::Muse,
            CodingAssistant::Copilot,
        ] {
            assert!(merged(provider, &json!({"hooks":42}), true).is_err());
        }
        assert!(merged(CodingAssistant::Muse, &json!({"schema_version":2}), true).is_err());
        assert!(merged(CodingAssistant::Copilot, &json!({"version":3}), true).is_err());
        assert!(merged(CodingAssistant::Antigravity, &json!({NAME:42}), true).is_err());
    }
    #[test]
    fn package_backups_and_stale_previews_include_both_hermes_files() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("mimo-providers-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("__init__.py");
        let preview = preview_at(CodingAssistant::Hermes, &path, true).unwrap();
        assert!(!preview.diff.contains("synthetic-secret"));
        write_at(CodingAssistant::Hermes, &path, true, &preview.fingerprint).unwrap();
        let uninstall = preview_at(CodingAssistant::Hermes, &path, false).unwrap();
        std::fs::write(path.with_file_name("plugin.yaml"), "foreign: unchanged").unwrap();
        assert!(write_at(
            CodingAssistant::Hermes,
            &path,
            false,
            &uninstall.fingerprint
        )
        .is_err());
        assert_eq!(
            std::fs::read(&path).unwrap(),
            plugin(CodingAssistant::Hermes, true).as_bytes()
        );
        // Test-owned directory, with fixed generated paths only.
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            std::fs::remove_file(entry.path()).unwrap();
        }
        std::fs::remove_dir(dir).unwrap();
    }
}
