// SPDX-License-Identifier: MIT
//! User-level Codex hooks. Never edit auth.json, config.toml, or hook trust.
use crate::{
    hook_config,
    hooks::{self, HookPreview, HookStatus},
    settings, windows,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const MARKER: &str = "Kumo Codex companion";
/// Hooks installed before the Kumo rebrand carry this marker.
const LEGACY_MARKER: &str = "Mimo Codex companion";
const EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 3),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PostToolUse", 10),
    ("PermissionRequest", 120),
    ("Stop", 10),
    ("Interrupt", 3),
    ("SubagentStart", 10),
    ("SubagentStop", 10),
];

pub fn settings_path() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| windows::home_dir().join(".codex"))
        .join("hooks.json")
}

fn command(event: &str) -> String {
    // An encoded, literal invocation survives either Bash or PowerShell as the
    // outer hook shell. No profile, interpolated path, credential, or user input.
    let exe = settings::hook_exe_path()
        .to_string_lossy()
        .replace('\'', "''");
    let script = format!("& '{exe}' --provider codex {event}");
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "powershell.exe -NoProfile -NonInteractive -EncodedCommand {}",
        STANDARD.encode(bytes)
    )
}

fn ours(handler: &Value) -> bool {
    if legacy_agent_command(handler) {
        return true;
    }
    let marker = handler.get("statusMessage").and_then(Value::as_str);
    if marker != Some(MARKER) && marker != Some(LEGACY_MARKER) {
        return false;
    }
    let Some(script) = decoded_command(handler) else {
        return false;
    };
    let previous = crate::migration::legacy_name().to_ascii_lowercase();
    script.starts_with("& '")
        && EVENTS.iter().any(|(event, _)| {
            script.ends_with(&format!("kumo-hook.exe' --provider codex {event}"))
                || script.ends_with(&format!("{previous}-hook.exe' --provider codex {event}"))
        })
}

// The original Windows relay used a quoted executable plus --agent codex.
// That invocation is invalid in PowerShell and predates our status marker.
// Match only that complete command, so foreign wrappers remain untouched.
fn legacy_agent_command(handler: &Value) -> bool {
    if handler.get("type").and_then(Value::as_str) != Some("command") {
        return false;
    }
    let Some(command) = handler.get("command").and_then(Value::as_str) else {
        return false;
    };
    let Some(quote @ ('\'' | '"')) = command.chars().next() else {
        return false;
    };
    let Some((exe, args)) = command[1..].rsplit_once(&format!("{quote} ")) else {
        return false;
    };
    let previous = crate::migration::legacy_name().to_ascii_lowercase();
    args == "--agent codex"
        && Path::new(exe).is_absolute()
        && !exe.contains(['\'', '"', '\n', '\r'])
        && exe
            .replace('\\', "/")
            .to_ascii_lowercase()
            .ends_with(&format!("/{previous}-hook.exe"))
}

fn decoded_command(handler: &Value) -> Option<String> {
    let encoded = handler
        .get("command")
        .and_then(Value::as_str)
        .and_then(|value| {
            value.strip_prefix("powershell.exe -NoProfile -NonInteractive -EncodedCommand ")
        })?;
    let bytes = STANDARD.decode(encoded).ok()?;
    if bytes.len() % 2 != 0 {
        return None;
    }
    let words: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|part| u16::from_le_bytes([part[0], part[1]]))
        .collect();
    String::from_utf16(&words).ok()
}

fn migrate_legacy_at(path: &Path) -> Result<(), String> {
    let bytes = read(path)?;
    if bytes.is_empty() {
        return Ok(());
    }
    let current = parse(&bytes)?;
    hook_config::validate(&current)?;
    let previous = format!(
        "{}-hook.exe",
        crate::migration::legacy_name().to_ascii_lowercase()
    );
    let legacy = current
        .get("hooks")
        .and_then(Value::as_object)
        .is_some_and(|events| {
            events
                .values()
                .filter_map(Value::as_array)
                .flatten()
                .filter_map(|group| group.get("hooks").and_then(Value::as_array))
                .flatten()
                .any(|handler| {
                    legacy_agent_command(handler)
                        || (ours(handler)
                            && decoded_command(handler)
                                .is_some_and(|script| script.contains(&previous)))
                })
        });
    if legacy {
        hook_config::save(path, &bytes, &merged(&current)?)?;
    }
    Ok(())
}

pub fn migrate_legacy_installation() -> Result<(), String> {
    migrate_legacy_at(&settings_path())
}

fn without_ours(existing: &Value) -> Value {
    let mut next = existing.clone();
    if let Some(events) = next.get_mut("hooks").and_then(Value::as_object_mut) {
        events.retain(|_, value| {
            let Some(groups) = value.as_array_mut() else {
                return true;
            };
            let mut removed = false;
            groups.retain_mut(|group| {
                if let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                    let before = handlers.len();
                    handlers.retain(|handler| !ours(handler));
                    if before != handlers.len() {
                        removed = true;
                        return !handlers.is_empty();
                    }
                }
                true
            });
            !removed || !groups.is_empty()
        });
    }
    next
}

fn merged(existing: &Value) -> Result<Value, String> {
    let mut next = without_ours(existing);
    let root = next
        .as_object_mut()
        .ok_or("Codex hooks must be a JSON object.")?;
    let events = root
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("Codex hooks has an invalid hooks table. Nothing was changed.")?;
    for (event, timeout) in EVENTS {
        let groups = events
            .entry(*event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("Codex has an invalid event list. Nothing was changed.")?;
        groups.push(
            json!({ "hooks": [{ "type":"command", "command":command(event),
            "statusMessage":MARKER, "timeout":timeout }] }),
        );
    }
    Ok(next)
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    hook_config::read(path)
}

fn parse(bytes: &[u8]) -> Result<Value, String> {
    hooks::parse_settings(bytes, "Codex hooks.json")
        .map_err(|_| "Codex hooks.json is invalid. Fix it before installing hooks.".into())
}

pub fn status() -> HookStatus {
    let path = settings_path();
    let installed = read(&path)
        .and_then(|bytes| parse(&bytes))
        .ok()
        .is_some_and(|value| {
            value
                .get("hooks")
                .and_then(Value::as_object)
                .is_some_and(|events| {
                    events
                        .values()
                        .filter_map(Value::as_array)
                        .flatten()
                        .filter_map(|group| group.get("hooks").and_then(Value::as_array))
                        .flatten()
                        .any(ours)
                })
        });
    let exe = settings::hook_exe_path();
    HookStatus {
        installed,
        settings_path: path.to_string_lossy().into(),
        hook_path: exe.to_string_lossy().into(),
        hook_ready: exe.is_file(),
        usage_ready: true,
        usage_command: None,
    }
}

fn preview_at(path: &Path, install: bool) -> Result<HookPreview, String> {
    let bytes = read(path)?;
    let current = parse(&bytes)?;
    hook_config::validate(&current)?;
    if install {
        merged(&current)?;
    }
    // Only our change reaches the UI. Foreign hook commands may contain secrets.
    let sign = if install { "+" } else { "-" };
    let diff = EVENTS
        .iter()
        .map(|(event, _)| format!("{sign} {event}: Mimo Codex companion"))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(HookPreview {
        diff,
        backup: backup_path(path).to_string_lossy().into(),
        settings_path: path.to_string_lossy().into(),
        fingerprint: hooks::fingerprint(&bytes),
    })
}

fn backup_path(path: &Path) -> PathBuf {
    hook_config::backup_path(path)
}
pub fn preview(install: bool) -> Result<HookPreview, String> {
    preview_at(&settings_path(), install)
}
pub fn write(install: bool, fingerprint: &str) -> Result<String, String> {
    write_at(&settings_path(), install, fingerprint)
}
fn write_at(path: &Path, install: bool, fingerprint: &str) -> Result<String, String> {
    let bytes = read(path)?;
    if hooks::fingerprint(&bytes) != fingerprint {
        return Err("Hooks changed since the preview. Review a fresh preview.".into());
    }
    let current = parse(&bytes)?;
    hook_config::validate(&current)?;
    let next = if install {
        merged(&current)?
    } else {
        without_ours(&current)
    };
    hook_config::save(path, &bytes, &next)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_agent_hooks_migrate_once_without_claiming_foreign_wrappers() {
        let previous = crate::migration::legacy_name().to_ascii_lowercase();
        let legacy = format!("\"C:\\Users\\Example User\\AppData\\Local\\Coucou\\bin\\{previous}-hook.exe\" --agent codex");
        let handler = json!({"type":"command", "command":legacy});
        assert!(ours(&handler));
        for foreign in [
            format!("{legacy}; echo keep"),
            format!("echo {legacy}"),
            format!("{legacy} --other"),
            format!("\"{previous}-hook.exe\" --agent codex"),
        ] {
            assert!(!ours(&json!({"type":"command", "command":foreign})));
        }
        let original = json!({"hooks":{"Stop":[{"matcher":"keep", "hooks":[
            handler, {"type":"command", "command":"foreign"}
        ]}]}});
        let next = merged(&merged(&original).unwrap()).unwrap();
        let handlers: Vec<_> = next["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|group| group["hooks"].as_array())
            .flatten()
            .collect();
        assert_eq!(handlers.iter().filter(|handler| ours(handler)).count(), 1);
        assert_eq!(
            handlers
                .iter()
                .filter(|handler| handler["command"] == "foreign")
                .count(),
            1
        );
        assert!(!handlers.iter().any(|handler| legacy_agent_command(handler)));
    }

    #[test]
    fn migration_repairs_original_quoted_agent_hooks_with_backup() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("mimo-codex-legacy-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("hooks.json");
        let previous = crate::migration::legacy_name().to_ascii_lowercase();
        let original = json!({"hooks":{"Stop":[{"hooks":[
            {"type":"command", "command":format!("\"C:/Previous/{previous}-hook.exe\" --agent codex")},
            {"type":"command", "command":"foreign"}
        ]}]}});
        let bytes = serde_json::to_vec(&original).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        migrate_legacy_at(&path).unwrap();
        let once = std::fs::read(&path).unwrap();
        migrate_legacy_at(&path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), once);
        assert!(std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.path() != path && std::fs::read(entry.path()).unwrap() == bytes));
        for entry in std::fs::read_dir(&dir).unwrap() {
            std::fs::remove_file(entry.unwrap().path()).unwrap();
        }
        std::fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn rename_reinstall_owns_previous_relay_and_installs_once() {
        let previous = crate::migration::legacy_name().to_ascii_lowercase();
        let script = format!("& 'C:\\Previous\\{previous}-hook.exe' --provider codex Stop");
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let handler = json!({"type":"command", "statusMessage":MARKER, "command":format!("powershell.exe -NoProfile -NonInteractive -EncodedCommand {}", STANDARD.encode(bytes))});
        assert!(ours(&handler));
        let original = json!({"hooks":{"Stop":[{"hooks":[handler,{"command":"foreign"}]}]}});
        let next = merged(&merged(&original).unwrap()).unwrap();
        assert_eq!(
            next["hooks"]["Stop"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|group| group.get("hooks").and_then(Value::as_array))
                .flatten()
                .filter(|handler| ours(handler))
                .count(),
            1
        );
        assert_eq!(
            without_ours(&next)["hooks"]["Stop"][0]["hooks"][0]["command"],
            "foreign"
        );
    }
    #[test]
    fn reinstall_and_uninstall_preserve_foreign_handlers_in_shared_groups() {
        let original = json!({"description":"keep", "hooks":{"SessionStart":[
            {"matcher":"startup", "hooks":[{"type":"command","command":"foreign","token":"synthetic-private"},
                {"type":"command","command":command("SessionStart"),"statusMessage":MARKER}]}
        ],"Custom":[{"hooks":[{"command":"other"}]}]}});
        let merged = merged(&merged(&original).unwrap()).unwrap();
        let cleaned = without_ours(&merged);
        assert_eq!(
            cleaned["hooks"]["SessionStart"][0]["hooks"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(cleaned["description"], "keep");
        assert_eq!(cleaned["hooks"]["Custom"], original["hooks"]["Custom"]);
        assert_eq!(merged["hooks"]["SessionStart"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn corrupt_hook_tables_are_not_replaced() {
        assert!(merged(&json!({"hooks":42})).is_err());
        assert!(merged(&json!({"hooks":{"SessionStart":"invalid"}})).is_err());
        assert!(parse(b"not json").is_err());
    }
    #[test]
    fn unrelated_empty_groups_and_events_are_preserved() {
        let original =
            json!({"hooks":{"SessionStart":[{"matcher":"keep","hooks":[]}],"Custom":[]}});
        assert_eq!(without_ours(&merged(&original).unwrap()), original);
    }
    #[test]
    fn writes_backup_original_bytes_and_uninstall_preserves_foreign_hooks() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("mimo-codex-write-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("hooks.json");
        let original = json!({"description":"keep","hooks":{"SessionStart":[{"hooks":[{"command":"foreign"}]}],"Custom":[]}});
        let bytes = serde_json::to_vec(&original).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        let preview = preview_at(&path, true).unwrap();
        let backup = write_at(&path, true, &preview.fingerprint).unwrap();
        assert_eq!(std::fs::read(&backup).unwrap(), bytes);
        let preview = preview_at(&path, false).unwrap();
        let second = write_at(&path, false, &preview.fingerprint).unwrap();
        assert_eq!(parse(&std::fs::read(&path).unwrap()).unwrap(), original);
        assert!(!path
            .with_extension(format!("mimo-{}.tmp", std::process::id()))
            .exists());
        for file in [path, PathBuf::from(backup), PathBuf::from(second)] {
            std::fs::remove_file(file).unwrap();
        }
        std::fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn preview_does_not_export_foreign_secrets_and_changed_files_are_refused() {
        let dir = std::env::temp_dir().join(format!("mimo-codex-hooks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("hooks.json");
        std::fs::write(&path, r#"{"token":"synthetic-private","hooks":{}}"#).unwrap();
        let preview = preview_at(&path, true).unwrap();
        assert!(!preview.diff.contains("synthetic-private"));
        std::fs::write(&path, "{}").unwrap();
        assert!(write_at(&path, true, &preview.fingerprint).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
