// SPDX-License-Identifier: MIT
// Claude Code hook installation.
//
// The rule from CLAUDE.md is strict and is followed to the letter:
// read %USERPROFILE%\.claude\settings.json, take a dated backup, merge without
// touching anybody else's hooks, show the diff, and write only after an explicit
// click. Uninstall removes Mimo's entries and nothing else.
//
// Claude Code's Windows hooks run through Git Bash. Quote the executable as a
// literal argument; Codex's PowerShell quoting lives in codex_hooks instead.

use std::path::{Path, PathBuf};

use crate::{hook_config, settings, windows};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

/// Every event the island reacts to, with the hook timeout written to settings.json.
/// PermissionRequest and PreToolUse AskUserQuestion can wait for a human.
/// Other PreToolUse calls keep the relay's two-second fire-and-forget budget.
pub const HOOK_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 120),
    ("PostToolUse", 10),
    ("PostToolUseFailure", 10),
    ("PermissionRequest", 120),
    ("Notification", 10),
    ("Stop", 10),
    ("StopFailure", 10),
    ("SubagentStart", 10),
    ("SubagentStop", 10),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub installed: bool,
    pub settings_path: String,
    pub hook_path: String,
    pub hook_ready: bool,
    pub usage_ready: bool,
    pub usage_command: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookPreview {
    pub diff: String,
    pub backup: String,
    pub settings_path: String,
    /// Identifies the bytes this diff was computed from; handed back to `write`
    /// so we only ever apply what the user actually looked at.
    pub fingerprint: String,
}

pub fn settings_path() -> PathBuf {
    windows::home_dir().join(".claude").join("settings.json")
}

/// Reads `~/.claude/settings.json`.
///
/// The only error that means "start from nothing" is the file not being there.
/// Everything else — a lock held by another process, a permission problem, JSON
/// we cannot parse — is reported, because the alternative is treating somebody's
/// unreadable settings as an empty object and then writing that back over them.
fn read_settings() -> Result<Value, String> {
    let bytes = hook_config::read(&settings_path())?;
    let parsed = parse_settings(&bytes, "Claude Code settings.json")?;
    hook_config::validate(&parsed)?;
    Ok(parsed)
}

/// The parsing half of `read_settings`, split out so it can be tested without a
/// home directory.
pub(crate) fn parse_settings(bytes: &[u8], path: &str) -> Result<Value, String> {
    // PowerShell writes a UTF-8 BOM with `Set-Content -Encoding utf8`, and
    // serde_json refuses it. Stripping it is safe and well defined; guessing at
    // anything else is not.
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if text.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    match serde_json::from_slice::<Value>(text) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err(format!("{path} isn't a JSON object — Kumo won't touch it.")),
        Err(_) => Err(format!(
            "{path} isn't valid JSON. Fix it before installing hooks."
        )),
    }
}

/// The settings as they are, or an empty object when we cannot tell. Only for
/// read-only paths like `status()`, which must never fail loudly; anything that
/// writes uses `read_settings()` and surfaces the error instead.
fn read_settings_lossy() -> Value {
    read_settings().unwrap_or_else(|_| json!({}))
}

fn hook_command(event: &str) -> String {
    // Claude runs hooks in Git Bash. Quote the literal path, including apostrophes.
    let exe = settings::hook_exe_path()
        .to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "'\"'\"'");
    format!("'{exe}' {event}")
}

fn relay_command_args(command: &str) -> Option<&str> {
    let quote = command.chars().next()?;
    if !matches!(quote, '\'' | '"') {
        return None;
    }
    let (exe, args) = command[1..].rsplit_once(&format!("{quote} "))?;
    let previous = crate::migration::legacy_name().to_ascii_lowercase();
    if !(exe.ends_with("/kumo-hook.exe")
        || exe.ends_with("\\kumo-hook.exe")
        || exe.ends_with("/kumo-hook")
        || exe.ends_with(&format!("/{previous}-hook.exe"))
        || exe.ends_with(&format!("\\{previous}-hook.exe"))
        || exe.ends_with(&format!("/{previous}-hook")))
    {
        return None;
    }
    Some(args)
}

fn is_legacy_command(command: &str) -> bool {
    relay_command_args(command).is_some()
        && command.contains(&format!(
            "{}-hook",
            crate::migration::legacy_name().to_ascii_lowercase()
        ))
}

fn has_legacy_hooks(value: &Value) -> bool {
    if let Some(line) = value.get("statusLine") {
        if own_status_line(line)
            && line
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(is_legacy_command)
        {
            return true;
        }
    }
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
                .any(|handler| {
                    ours(handler)
                        && handler
                            .get("command")
                            .and_then(Value::as_str)
                            .is_some_and(is_legacy_command)
                })
        })
}

fn migrate_legacy_at(path: &Path) -> Result<(), String> {
    let bytes = hook_config::read(path)?;
    if bytes.is_empty() {
        return Ok(());
    }
    let current = parse_settings(&bytes, "Claude Code settings.json")?;
    hook_config::validate(&current)?;
    if has_legacy_hooks(&current) {
        hook_config::save(path, &bytes, &merged(&current))?;
    }
    Ok(())
}

pub fn migrate_legacy_installation() -> Result<(), String> {
    migrate_legacy_at(&settings_path())
}
fn ours(handler: &Value) -> bool {
    handler.get("type").and_then(Value::as_str) == Some("command")
        && handler
            .get("command")
            .and_then(Value::as_str)
            .and_then(relay_command_args)
            .is_some_and(|args| HOOK_EVENTS.iter().any(|(event, _)| args == *event))
}
fn entry_is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|handlers| handlers.iter().any(ours))
}
fn own_status_line(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("command")
        && value
            .get("command")
            .and_then(Value::as_str)
            .and_then(relay_command_args)
            .is_some_and(|args| matches!(args, "--usage" | "--usage --quiet"))
}

/// Remove individual owned handlers; never remove a shared foreign group.
fn without_ours(existing: &Value) -> Value {
    let mut next = existing.clone();
    let mut removed_any = false;
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
                        removed_any = true;
                        return !handlers.is_empty();
                    }
                }
                true
            });
            !removed || !groups.is_empty()
        });
    }
    if removed_any
        && next
            .get("hooks")
            .and_then(Value::as_object)
            .is_some_and(Map::is_empty)
    {
        next.as_object_mut().unwrap().remove("hooks");
    }
    if next.get("statusLine").is_some_and(own_status_line) {
        next.as_object_mut().unwrap().remove("statusLine");
    }
    next
}

fn merged(existing: &Value) -> Value {
    // The read boundary validates tables before we reach this mutation.
    let mut next = without_ours(existing);
    let root = next.as_object_mut().unwrap();
    let events = root
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .unwrap();
    for (event, timeout) in HOOK_EVENTS {
        let groups = events
            .entry(*event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .unwrap();
        groups.push(json!({ "hooks": [{ "type": "command", "command": hook_command(event), "timeout": timeout }] }));
    }
    // A foreign status line remains byte-for-byte equivalent as JSON data.
    if !root.contains_key("statusLine") {
        root.insert(
            "statusLine".into(),
            json!({"type":"command","command":hook_command("--usage")}),
        );
    }
    next
}

pub(crate) fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// Down to the second: installing then uninstalling in the same minute must not
/// quietly overwrite the first backup.
pub(crate) fn stamp() -> String {
    let t = windows::local_time();
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    )
}

/// Identifies the exact bytes a preview was computed from. FNV-1a is plenty:
/// the question is only "is this still the file I showed the user?".
pub(crate) fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn status() -> HookStatus {
    let current = read_settings_lossy();
    let installed = current
        .get("hooks")
        .and_then(Value::as_object)
        .map(|hooks| {
            hooks
                .values()
                .filter_map(Value::as_array)
                .flatten()
                .any(entry_is_ours)
        })
        .unwrap_or(false);
    let hook_path = settings::hook_exe_path();
    HookStatus {
        installed,
        settings_path: settings_path().to_string_lossy().to_string(),
        hook_ready: hook_path.is_file(),
        usage_ready: current.get("statusLine").is_some_and(own_status_line),
        usage_command: Some(hook_command("--usage")),
        hook_path: hook_path.to_string_lossy().to_string(),
    }
}

pub fn preview(install: bool) -> Result<HookPreview, String> {
    let bytes = hook_config::read(&settings_path())?;
    let current = parse_settings(&bytes, "Claude Code settings.json")?;
    hook_config::validate(&current)?;
    let sign = if install { "+" } else { "-" };
    let mut lines: Vec<String> = HOOK_EVENTS
        .iter()
        .map(|(event, timeout)| format!("{sign} {event}: kumo-hook ({timeout}s)"))
        .collect();
    if (install && current.get("statusLine").is_none())
        || current.get("statusLine").is_some_and(own_status_line)
    {
        lines.push(format!(
            "{sign} statusLine: kumo-hook --usage (numbers only, no polling)"
        ));
    } else if install {
        lines.push("  Your existing status line stays as it is.".into());
    }
    Ok(HookPreview {
        diff: lines.join("\n"),
        backup: hook_config::backup_path(&settings_path())
            .to_string_lossy()
            .into(),
        settings_path: settings_path().to_string_lossy().into(),
        fingerprint: fingerprint(&bytes),
    })
}

pub fn write(install: bool, preview_fingerprint: &str) -> Result<String, String> {
    let path = settings_path();
    let bytes = hook_config::read(&path)?;
    if fingerprint(&bytes) != preview_fingerprint {
        return Err("Hooks changed since the preview. Review a fresh preview.".into());
    }
    let current = parse_settings(&bytes, "Claude Code settings.json")?;
    hook_config::validate(&current)?;
    let next = if install {
        merged(&current)
    } else {
        without_ours(&current)
    };
    hook_config::save(&path, &bytes, &next)
}

/// Copies the relay (kumo-hook.exe / kumo-hook) into the local data dir's
/// bin/ on launch. In a bundled install it comes from the app resources; in
/// `tauri dev` it sits next to the app binary in the workspace target directory.
///
/// Every candidate is tried rather than just the first, because getting this
/// wrong is silent and fatal: `resources` used to be a glob, which made NSIS
/// mirror the source path into `_up_\target\release\`, no candidate matched, and
/// the relay was simply never installed. It only looked healthy on a developer
/// machine, where a leftover copy from `tauri dev` was already sitting in bin/.
pub fn ensure_hook_exe(app: &AppHandle) -> bool {
    let dest = settings::hook_exe_path();
    let Some(dir) = dest.parent() else {
        return false;
    };
    // Nobody else may swap the relay Claude Code runs: its folder is ours only.
    if windows::ensure_private_dir(&settings::local_dir()).is_err()
        || std::fs::create_dir_all(dir).is_err()
    {
        return false;
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app
        .path()
        .resolve(windows::HOOK_EXE, tauri::path::BaseDirectory::Resource)
    {
        candidates.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // Installed build, then `tauri dev` (target/debug) next to the
            // release hook the pre-build step produces.
            candidates.push(parent.join(windows::HOOK_EXE));
            candidates.push(parent.join("../release").join(windows::HOOK_EXE));
            // Belt and braces: where the old glob form used to land it.
            candidates.push(parent.join("_up_/target/release").join(windows::HOOK_EXE));
        }
    }

    let tried: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
    let Some(src) = candidates.into_iter().find(|p| p.is_file()) else {
        crate::log::line(format!(
            "{} not found — Claude Code hooks cannot work. Looked in: {}",
            windows::HOOK_EXE,
            tried.join(", ")
        ));
        return false;
    };
    install_relay(&src, &dest)
}

fn relay_matches(src: &Path, dest: &Path) -> std::io::Result<bool> {
    use std::io::Read;
    let mut source = std::fs::File::open(src)?;
    let mut destination = std::fs::File::open(dest)?;
    if source.metadata()?.len() != destination.metadata()?.len() {
        return Ok(false);
    }
    let mut source_bytes = [0u8; 8192];
    let mut destination_bytes = [0u8; 8192];
    loop {
        let length = source.read(&mut source_bytes)?;
        if length == 0 {
            return Ok(destination.read(&mut destination_bytes)? == 0);
        }
        destination.read_exact(&mut destination_bytes[..length])?;
        if source_bytes[..length] != destination_bytes[..length] {
            return Ok(false);
        }
    }
}

/// Relays moved aside while they were running; gone once nothing runs them.
fn remove_old_relays(dest: &Path) {
    let (Some(dir), Some(stem)) = (dest.parent(), dest.file_stem().and_then(|s| s.to_str())) else {
        return;
    };
    let prefix = format!("{stem}.old-");
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if entry.file_name().to_str().is_some_and(|n| n.starts_with(&prefix) && n.ends_with(".exe")) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn install_relay(src: &Path, dest: &Path) -> bool {
    remove_old_relays(dest);
    if relay_matches(src, dest).unwrap_or(false) {
        return true;
    }
    // Claude Code or a virus scanner may hold the relay open for a moment (sharing violation,
    // access denied): try again shortly instead of keeping an old relay until the next start.
    const ATTEMPTS: u32 = 4;
    for attempt in 1..=ATTEMPTS {
        match try_install_relay(src, dest) {
            Ok(ready) => return ready,
            Err(err) if attempt < ATTEMPTS && matches!(err.raw_os_error(), Some(5 | 32)) => {
                std::thread::sleep(std::time::Duration::from_millis(400 * u64::from(attempt)));
            }
            Err(err) => {
                crate::log::line(format!("could not install {}: {err}", windows::HOOK_EXE));
                return false;
            }
        }
    }
    false
}

fn try_install_relay(src: &Path, dest: &Path) -> std::io::Result<bool> {
    // Stage beside the destination and verify all bytes before replacement.
    // A failed copy or a running helper's lock must leave the old file intact.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staged = dest.with_extension(format!("mimo-stage-{}-{nonce}.tmp", std::process::id()));
    let mut created = false;
    let installed = (|| -> std::io::Result<bool> {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)?;
        created = true;
        std::fs::copy(src, &staged)?;
        if !relay_matches(src, &staged)? {
            return Ok(false);
        }
        std::fs::rename(&staged, dest).or_else(|err| {
            if !dest.exists() {
                return Err(err);
            }
            // Claude Code may be running the relay right now: Windows refuses to replace a
            // running .exe but lets it be renamed, so move it aside and put the new one in place.
            let aside = dest.with_extension(format!("old-{nonce}.exe"));
            std::fs::rename(dest, &aside)?;
            std::fs::rename(&staged, dest).inspect_err(|_| {
                let _ = std::fs::rename(&aside, dest);
            })
        })?;
        relay_matches(src, dest)
    })();
    if created && staged.exists() {
        let _ = std::fs::remove_file(&staged);
    }
    installed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relay_held_open_for_a_moment_is_replaced_on_retry() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = std::env::temp_dir().join(format!("kumo-relay-busy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (src, dest) = (dir.join("new.exe"), dir.join("relay.exe"));
        std::fs::write(&src, b"new relay").unwrap();
        std::fs::write(&dest, b"old relay").unwrap();
        // Like a scanner reading it: open with no sharing, released after half a second.
        let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&dest).unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            drop(held);
        });
        assert!(install_relay(&src, &dest));
        release.join().unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new relay");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_running_relay_is_still_replaced() {
        let dir = std::env::temp_dir().join(format!("kumo-relay-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("relay.exe");
        let system = Path::new(r"C:\Windows\System32");
        std::fs::copy(system.join("PING.EXE"), &dest).unwrap();
        let mut running = std::process::Command::new(&dest)
            .args(["-n", "20", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let new = system.join("where.exe");
        assert!(std::fs::copy(&new, &dest).is_err(), "a running exe can't be overwritten");
        assert!(install_relay(&new, &dest));
        assert!(relay_matches(&new, &dest).unwrap());
        let _ = running.kill();
        let _ = running.wait();
        install_relay(&new, &dest); // a later start removes the copy that was moved aside
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from("relay.exe")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn relay_readiness_requires_current_bytes_and_a_successful_upgrade() {
        use std::os::windows::fs::OpenOptionsExt;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "mimo-relay-readiness-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let source = directory.join("bundled.exe");
        let destination = directory.join("kumo-hook.exe");
        std::fs::write(&source, b"current relay").unwrap();
        std::fs::write(&destination, b"earlier relay").unwrap();
        // Even equal lengths and timestamps must not mistake a stale relay for
        // the one shipped with this installation.
        let timestamp = std::fs::metadata(&source).unwrap().modified().unwrap();
        std::fs::File::options()
            .write(true)
            .open(&destination)
            .unwrap()
            .set_modified(timestamp)
            .unwrap();
        assert!(!relay_matches(&source, &destination).unwrap());
        let locked = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&destination)
            .unwrap();
        assert!(!install_relay(&source, &destination));
        drop(locked);
        assert_eq!(std::fs::read(&destination).unwrap(), b"earlier relay");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 2);
        assert!(install_relay(&source, &destination));
        assert!(relay_matches(&source, &destination).unwrap());
        assert!(!install_relay(&directory.join("missing.exe"), &destination));
        assert_eq!(std::fs::read(&destination).unwrap(), b"current relay");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 2);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rename_migration_backs_up_owned_hooks_and_preserves_foreign_configuration() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "kumo-hook-migration-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("settings.json");
        let previous = crate::migration::legacy_name().to_ascii_lowercase();
        let legacy = format!("'C:/Previous/{previous}-hook.exe' Stop");
        let original = json!({"model":"keep", "hooks":{"Stop":[{"matcher":"keep", "hooks":[
            {"type":"command","command":"foreign-tool"}, {"type":"command","command":legacy},
            {"type":"command","command":hook_command("Stop")}
        ]}]}, "statusLine":{"type":"command", "command":format!("'C:/Previous/{previous}-hook.exe' --usage")}});
        let bytes = serde_json::to_vec(&original).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        migrate_legacy_at(&path).unwrap();
        let next: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(!has_legacy_hooks(&next));
        assert_eq!(next["model"], "keep");
        assert_eq!(
            next["hooks"]["Stop"][0]["hooks"][0]["command"],
            "foreign-tool"
        );
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
        let backups: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name() != "settings.json")
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read(backups[0].path()).unwrap(), bytes);
        migrate_legacy_at(&path).unwrap();
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 2);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn foreign_handlers_and_status_lines_survive_shared_groups_and_reinstalls() {
        let original = json!({"hooks":{"Stop":[{"matcher":"keep","hooks":[
            {"type":"command","command":"foreign-tool --token synthetic-private"},
            {"type":"command","command":hook_command("Stop")}
        ]}], "Foreign":[]}, "statusLine":{"type":"command","command":"foreign-status --token synthetic-private","padding":2}});
        let installed = merged(&merged(&original));
        assert_eq!(installed["statusLine"], original["statusLine"]);
        let cleaned = without_ours(&installed);
        assert_eq!(
            cleaned["hooks"]["Stop"][0]["hooks"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(cleaned["statusLine"], original["statusLine"]);
        assert_eq!(cleaned["hooks"]["Foreign"], json!([]));
        assert!(!ours(
            &json!({"type":"command","command":"echo kumo-hook.exe"})
        ));
        assert!(!ours(
            &json!({"type":"command","command":format!("{}; echo foreign", hook_command("Stop"))})
        ));
    }

    const WHERE: &str = "settings.json";

    #[test]
    fn a_utf8_bom_is_stripped_not_treated_as_corruption() {
        // PowerShell 5's `Set-Content -Encoding utf8` produces exactly this.
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(br#"{"model":"opus","hooks":{}}"#);
        let parsed = parse_settings(&bytes, WHERE).expect("a BOM must not defeat the parser");
        assert_eq!(parsed["model"], "opus");
    }

    #[test]
    fn unreadable_content_is_an_error_never_an_empty_object() {
        // This is the whole bug: returning {} here meant `merged()` produced a
        // file containing nothing but Mimo's hooks, and the write replaced
        // everything the user had.
        for bad in [&b"{ not json"[..], &b"[1,2,3]"[..], &b"\"a string\""[..]] {
            assert!(
                parse_settings(bad, WHERE).is_err(),
                "content we cannot use must refuse, not come back empty"
            );
        }
    }

    #[test]
    fn empty_and_whitespace_files_start_from_nothing() {
        assert_eq!(parse_settings(b"", WHERE).unwrap(), json!({}));
        assert_eq!(parse_settings(b"  \n\t ", WHERE).unwrap(), json!({}));
    }

    #[test]
    fn merging_keeps_every_other_setting_and_every_foreign_hook() {
        let existing = serde_json::json!({
            "model": "claude-opus-5",
            "theme": "dark",
            "enabledPlugins": ["a", "b"],
            "hooks": {
                "PreToolUse": [
                    { "hooks": [{ "type": "command", "command": "someone-elses-tool.exe" }] }
                ],
                "SomeEventWeDoNotTouch": [
                    { "hooks": [{ "type": "command", "command": "keep-me.exe" }] }
                ]
            }
        });

        let after = merged(&existing);
        assert_eq!(after["model"], "claude-opus-5");
        assert_eq!(after["theme"], "dark");
        assert_eq!(after["enabledPlugins"], serde_json::json!(["a", "b"]));

        let pre = after["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(
            pre.iter().any(|e| serde_json::to_string(e)
                .unwrap()
                .contains("someone-elses-tool.exe")),
            "another tool's hook was dropped"
        );
        assert!(pre.iter().any(entry_is_ours), "our own hook was not added");
        assert!(after["hooks"]["SomeEventWeDoNotTouch"].is_array());

        // And removing ours puts it back exactly as it was.
        let cleaned = without_ours(&after);
        assert_eq!(cleaned, existing);
    }

    #[test]
    fn a_fingerprint_notices_any_change() {
        assert_eq!(fingerprint(b"{}"), fingerprint(b"{}"));
        assert_ne!(fingerprint(b"{}"), fingerprint(b"{ }"));
        assert_ne!(fingerprint(b""), fingerprint(b"{}"));
    }

    /// Everything filesystem-shaped lives in one test on purpose: it points
    /// the home directory at a temp directory, and that is process-wide.
    #[test]
    fn writing_backs_up_preserves_and_refuses_a_changed_file() {
        let tmp = std::env::temp_dir().join(format!("kumo-hooks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".claude")).unwrap();
        std::env::set_var(windows::HOME_VAR, &tmp);

        let path = settings_path();
        assert!(
            path.starts_with(&tmp),
            "the test must not touch the real home"
        );

        // A real-shaped file, written the way PowerShell 5 would: UTF-8 with BOM.
        let original = r#"{"model":"claude-opus-5","theme":"dark","tui":{"x":1},"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"other-tool.exe"}]}]}}"#;
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(original.as_bytes());
        std::fs::write(&path, &bytes).unwrap();

        // Install.
        let plan = preview(true).expect("a BOM must not stop the preview");
        assert!(
            plan.diff.contains("kumo-hook"),
            "the diff must show what changes"
        );
        let backup = write(true, &plan.fingerprint).expect("install should succeed");

        // The backup holds the original bytes, BOM and all.
        assert_eq!(std::fs::read(&backup).unwrap(), bytes);

        // Everything else survived, and so did the other tool's hook.
        let after: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(after["model"], "claude-opus-5");
        assert_eq!(after["theme"], "dark");
        assert_eq!(after["tui"]["x"], 1);
        let pre = after["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(pre
            .iter()
            .any(|e| serde_json::to_string(e).unwrap().contains("other-tool.exe")));
        assert!(status().installed);

        // A file that moved since the preview is refused, and left alone.
        let stale = preview(false).unwrap();
        std::fs::write(&path, br#"{"model":"someone-else-edited-this"}"#).unwrap();
        let err = write(false, &stale.fingerprint).unwrap_err();
        assert!(err.contains("changed since the preview"), "got: {err}");
        let untouched: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(untouched["model"], "someone-else-edited-this");

        // Content we cannot parse is refused before anything is written.
        std::fs::write(&path, b"{ broken").unwrap();
        assert!(preview(true).is_err());
        assert!(write(true, "whatever").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{ broken");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
