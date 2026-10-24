// SPDX-License-Identifier: MIT
//! Tools tab: launch any Start-menu app, Docker containers, Ollama models and
//! an Obsidian quick note. Every action is checked against what was just read
//! from the system, so the webview can never name an arbitrary program, path
//! or model.

use crate::windows::{self, no_console};
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

// ── Start-menu apps ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StartApp {
    #[serde(rename(deserialize = "Name", serialize = "name"))]
    pub name: String,
    #[serde(rename(deserialize = "AppID", serialize = "id"))]
    pub id: String,
}

static APPS: Mutex<Vec<StartApp>> = Mutex::new(Vec::new());

/// Every app in the Start menu (`Get-StartApps`), cached until `refresh`.
pub fn start_apps(refresh: bool) -> Result<Vec<StartApp>, String> {
    let mut cache = APPS.lock().unwrap();
    if cache.is_empty() || refresh {
        let output = no_console(Command::new("powershell.exe").args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress",
        ]))
        .output()
        .map_err(|error| format!("Could not list apps: {error}"))?;
        let mut apps: Vec<StartApp> = serde_json::from_slice(&output.stdout)
            .map_err(|_| "Could not read the app list".to_string())?;
        apps.retain(|app| !app.name.trim().is_empty() && !app.id.trim().is_empty());
        apps.sort_by_key(|app| app.name.to_lowercase());
        apps.dedup_by(|a, b| a.id == b.id);
        *cache = apps;
    }
    Ok(cache.clone())
}

/// Launches an app by its Start-menu id. Only ids from the listed apps run.
pub fn launch_app(id: &str) -> Result<(), String> {
    let known = APPS.lock().unwrap().iter().any(|app| app.id == id);
    if !known {
        return Err("That app is not in the Start menu".into());
    }
    no_console(Command::new("explorer.exe").arg(format!(r"shell:AppsFolder\{id}")))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the app: {error}"))
}

// ── Docker ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Container {
    #[serde(rename(deserialize = "ID", serialize = "id"))]
    pub id: String,
    #[serde(rename(deserialize = "Names", serialize = "name"))]
    pub name: String,
    #[serde(rename(deserialize = "Image", serialize = "image"))]
    pub image: String,
    #[serde(rename(deserialize = "State", serialize = "state"))]
    pub state: String,
    #[serde(rename(deserialize = "Status", serialize = "status"))]
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerState {
    /// Docker CLI found on PATH.
    pub installed: bool,
    /// The engine answered (Docker Desktop is running).
    pub running: bool,
    pub containers: Vec<Container>,
}

fn docker() -> Option<std::path::PathBuf> {
    windows::find_on_path("docker")
}

pub fn docker_state() -> DockerState {
    let Some(cli) = docker() else {
        return DockerState {
            installed: false,
            running: false,
            containers: vec![],
        };
    };
    let output =
        no_console(Command::new(cli).args(["ps", "-a", "--format", "{{json .}}"])).output();
    let Some(output) = output.ok().filter(|output| output.status.success()) else {
        return DockerState {
            installed: true,
            running: false,
            containers: vec![],
        };
    };
    let containers = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Container>(line).ok())
        .collect();
    DockerState {
        installed: true,
        running: true,
        containers,
    }
}

pub(crate) fn container_id_ok(id: &str) -> bool {
    (12..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn docker_action(id: &str, action: &str) -> Result<(), String> {
    if !matches!(action, "start" | "stop" | "restart") || !container_id_ok(id) {
        return Err("Unsupported container action".into());
    }
    let cli = docker().ok_or("Docker is not installed")?;
    let output = no_console(Command::new(cli).args([action, id]))
        .output()
        .map_err(|error| format!("Docker: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr)
            .trim()
            .chars()
            .take(200)
            .collect())
    }
}

// ── Ollama ────────────────────────────────────────────────────────────────────

const OLLAMA: &str = "http://127.0.0.1:11434";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModel {
    pub name: String,
    #[serde(default, rename(deserialize = "size_vram"))]
    pub size_vram: u64,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaState {
    pub running: bool,
    pub models: Vec<OllamaModel>,
}

#[derive(Deserialize)]
struct Loaded {
    #[serde(default)]
    models: Vec<OllamaModel>,
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap_or_default()
}

pub async fn ollama_state() -> OllamaState {
    let Ok(response) = http().get(format!("{OLLAMA}/api/ps")).send().await else {
        return OllamaState {
            running: false,
            models: vec![],
        };
    };
    let models = response
        .json::<Loaded>()
        .await
        .map(|loaded| loaded.models)
        .unwrap_or_default();
    OllamaState {
        running: true,
        models,
    }
}

/// Installed chat models that can run the assistant: no embedding models and none of the
/// assistant's own 16k-context copies (those are made by `assistant_variant`).
pub async fn ollama_models() -> Vec<String> {
    #[derive(Deserialize)]
    struct Tags {
        #[serde(default)]
        models: Vec<OllamaModel>,
    }
    let Ok(response) = http().get(format!("{OLLAMA}/api/tags")).send().await else {
        return vec![];
    };
    let mut names: Vec<String> = response
        .json::<Tags>()
        .await
        .map(|tags| tags.models.into_iter().map(|m| m.name).collect())
        .unwrap_or_default();
    names.retain(|n| !n.contains("embed") && !is_variant(n));
    names.sort();
    names
}

fn is_variant(name: &str) -> bool {
    let base = name.trim_end_matches(":latest");
    base.ends_with("-kumo") || base.ends_with("-raphael")
}

/// `qwen3:8b` -> `qwen3-8b-kumo`; `gemma4-e4b:latest` -> `gemma4-e4b-kumo`.
pub fn variant_name(base: &str) -> String {
    format!("{}-kumo", base.trim_end_matches(":latest").replace([':', '/'], "-"))
}

/// The assistant runs a copy of `base` with a 16k context: its prompt and tool list are
/// ~4,100 tokens, and Ollama's 4k default silently cuts the start. Made once, same weights.
pub async fn assistant_variant(base: &str) -> Result<String, String> {
    if !ollama_models().await.iter().any(|m| m == base) {
        return Err("That model is not installed in Ollama".into());
    }
    let name = variant_name(base);
    let installed = http().get(format!("{OLLAMA}/api/tags")).send().await
        .map_err(|e| format!("Ollama: {e}"))?
        .text().await.unwrap_or_default();
    if !installed.contains(&format!("\"{name}:latest\"")) {
        reqwest::Client::builder().timeout(Duration::from_secs(180)).build().unwrap_or_default()
            .post(format!("{OLLAMA}/api/create"))
            .json(&serde_json::json!({"model": name, "from": base, "parameters": {"num_ctx": 16384}, "stream": false}))
            .send().await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Could not prepare {base}: {e}"))?;
    }
    Ok(name)
}

/// Unloads a loaded model (keep_alive 0). Only currently loaded names are accepted.
pub async fn ollama_unload(name: &str) -> Result<(), String> {
    let loaded = ollama_state().await;
    if !loaded.models.iter().any(|model| model.name == name) {
        return Err("That model is not loaded".into());
    }
    http()
        .post(format!("{OLLAMA}/api/generate"))
        .json(&serde_json::json!({ "model": name, "keep_alive": 0 }))
        .send()
        .await
        .map(|_| ())
        .map_err(|error| format!("Ollama: {error}"))
}

// ── Obsidian ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub id: String,
    pub name: String,
}

/// Captures go to the vault's inbox/ staging folder, one note each, like the assistant's
/// "note this" (the vault's SCHEMA.md / AGENTS.md: frontmatter, and one line in log.md).
const INBOX_DIR: &str = "inbox";
/// Folders Kumo may open notes from.
const OPENABLE: [&str; 2] = ["inbox/", "kumo/news/"];

fn vault_paths() -> Vec<(String, std::path::PathBuf)> {
    let Ok(appdata) = std::env::var("APPDATA") else {
        return vec![];
    };
    let Ok(text) =
        std::fs::read_to_string(std::path::Path::new(&appdata).join("obsidian/obsidian.json"))
    else {
        return vec![];
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return vec![];
    };
    json.get("vaults")
        .and_then(|vaults| vaults.as_object())
        .map(|vaults| {
            vaults
                .iter()
                .filter_map(|(id, vault)| Some((id.clone(), vault.get("path")?.as_str()?.into())))
                .filter(|(_, path): &(String, std::path::PathBuf)| path.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

pub fn vaults() -> Vec<Vault> {
    vault_paths()
        .into_iter()
        .map(|(id, path)| Vault {
            id,
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
        })
        .collect()
}

fn vault_path(vault_id: &str) -> Result<std::path::PathBuf, String> {
    vault_paths()
        .into_iter()
        .find(|(id, _)| id == vault_id)
        .map(|(_, path)| path)
        .ok_or_else(|| "That vault is not available".into())
}

/// `My idea: X!` -> `my-idea-x` (same rule as the assistant's vault.py).
fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.trim_matches('-').chars().take(60).collect();
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "note".into() } else { out }
}

/// Appends text keeping the file's own line endings (Obsidian vaults in git care).
fn append_keeping_endings(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    let old = std::fs::read_to_string(path).unwrap_or_default();
    let crlf = old.contains("\r\n");
    let mut joined = old.clone();
    if !joined.is_empty() && !joined.ends_with('\n') {
        joined.push('\n');
    }
    joined.push_str(text);
    let joined = joined.replace("\r\n", "\n");
    std::fs::write(path, if crlf { joined.replace('\n', "\r\n") } else { joined })
}

/// Saves a note to inbox/<slug>.md with frontmatter and logs it. Returns its vault path.
pub fn quick_note(vault_id: &str, text: &str) -> Result<String, String> {
    let text: String = text
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(4000)
        .collect();
    let text = text.trim();
    if text.is_empty() {
        return Err("The note is empty".into());
    }
    let root = vault_path(vault_id)?;
    let inbox = root.join(INBOX_DIR);
    std::fs::create_dir_all(&inbox).map_err(|error| format!("Could not write the note: {error}"))?;
    let first = text.lines().next().unwrap_or(text).trim();
    let title: String = first.chars().take(60).collect();
    let base = slug(&title);
    let mut n = 1;
    let file = loop {
        let name = if n == 1 { format!("{base}.md") } else { format!("{base}-{n}.md") };
        if !inbox.join(&name).exists() {
            break name;
        }
        n += 1;
    };
    let t = windows::local_time();
    let today = format!("{:04}-{:02}-{:02}", t.year, t.month, t.day);
    let quoted = serde_json::to_string(&title).unwrap_or_else(|_| "\"Note\"".into());
    std::fs::write(
        inbox.join(&file),
        format!("---\ntitle: {quoted}\ncreated: {today}\nupdated: {today}\nsource: kumo (quick note)\n---\n\n# {title}\n\n{text}\n"),
    )
    .map_err(|error| format!("Could not write the note: {error}"))?;
    let rel = format!("{INBOX_DIR}/{file}");
    let _ = append_keeping_endings(
        &root.join("log.md"),
        &format!("\n## [{today}] create | {rel}\n- Captured in Kumo; unfiled (inbox).\n"),
    );
    Ok(rel)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub path: String,
    pub title: String,
    pub modified: u64,
}

/// The newest notes in inbox/, with their frontmatter titles.
pub fn recent_notes(vault_id: &str) -> Result<Vec<Note>, String> {
    let inbox = vault_path(vault_id)?.join(INBOX_DIR);
    let Ok(entries) = std::fs::read_dir(&inbox) else {
        return Ok(vec![]);
    };
    let mut notes: Vec<Note> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let modified = e.metadata().ok()?.modified().ok()?
                .duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
            let head: String = std::fs::read_to_string(e.path()).ok()?.chars().take(600).collect();
            let title = head
                .lines()
                .find_map(|l| l.strip_prefix("title:"))
                .map(|t| t.trim().trim_matches('"').to_string())
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| name.trim_end_matches(".md").to_string());
            Some(Note { path: format!("{INBOX_DIR}/{name}"), title, modified })
        })
        .collect();
    notes.sort_by_key(|n| std::cmp::Reverse(n.modified));
    notes.truncate(12);
    Ok(notes)
}

/// Only notes Kumo wrote or lists: inbox/<file>.md and kumo/news/<file>.md.
fn openable(rel: &str) -> bool {
    OPENABLE.iter().any(|dir| {
        rel.strip_prefix(dir).is_some_and(|name| {
            name.ends_with(".md") && !name.contains(['/', '\\']) && !name.contains("..") && name.len() > 3
        })
    })
}

/// A note Kumo may share (inbox/ or kumo/news/), as a file on disk.
pub fn note_file(vault_id: &str, rel: &str) -> Result<std::path::PathBuf, String> {
    if !openable(rel) {
        return Err("Kumo only shares notes from inbox/ and kumo/news/".into());
    }
    let file = vault_path(vault_id)?.join(rel);
    if file.is_file() { Ok(file) } else { Err("That note is gone".into()) }
}

/// Opens one of those notes in Obsidian.
pub fn open_note(vault_id: &str, rel: &str) -> Result<(), String> {
    if !openable(rel) {
        return Err("Kumo only opens notes from inbox/ and kumo/news/".into());
    }
    let root = vault_path(vault_id)?;
    if !root.join(rel).is_file() {
        return Err("That note is gone".into());
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    windows::open_url(&format!(
        "obsidian://open?vault={}&file={}",
        encode(&name),
        encode(rel.trim_end_matches(".md"))
    ));
    Ok(())
}

fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assistant_copies_get_stable_names() {
        assert_eq!(variant_name("gemma4-e4b:latest"), "gemma4-e4b-kumo");
        assert_eq!(variant_name("qwen3:8b"), "qwen3-8b-kumo");
        assert!(is_variant("gemma4-e4b-kumo:latest") && is_variant("gemma4-e4b-raphael:latest"));
        assert!(!is_variant("gemma4-e4b:latest"));
    }

    #[test]
    fn container_ids_and_actions_are_strict() {
        assert!(container_id_ok("0123456789ab"));
        assert!(!container_id_ok("abc"));
        assert!(!container_id_ok("0123456789ab; rm"));
        assert!(docker_action("0123456789ab", "rm").is_err());
    }

    #[test]
    fn the_vault_log_keeps_its_line_endings() {
        let dir = std::env::temp_dir().join(format!("kumo-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (crlf, lf, new) = (dir.join("crlf.md"), dir.join("lf.md"), dir.join("new.md"));
        std::fs::write(&crlf, "# Log\r\n- a").unwrap();
        std::fs::write(&lf, "# Log\n").unwrap();
        for p in [&crlf, &lf, &new] {
            append_keeping_endings(p, "\n## [2026-10-22] create | inbox/x.md\n- note\n").unwrap();
        }
        assert_eq!(std::fs::read_to_string(&crlf).unwrap(),
            "# Log\r\n- a\r\n\r\n## [2026-10-22] create | inbox/x.md\r\n- note\r\n");
        assert_eq!(std::fs::read_to_string(&lf).unwrap(), "# Log\n\n## [2026-10-22] create | inbox/x.md\n- note\n");
        assert!(std::fs::read_to_string(&new).unwrap().starts_with("\n## [2026-10-22]"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn notes_get_safe_names_and_only_known_folders_open() {
        assert_eq!(slug("My idea: X!"), "my-idea-x");
        assert_eq!(slug("!!!"), "note");
        assert!(slug(&"a".repeat(80)).len() <= 60);
        assert!(openable("inbox/my-idea.md") && openable("kumo/news/2026-10-22.md"));
        for bad in ["inbox/../private/x.md", "private/x.md", "inbox/sub/x.md", "inbox/x.txt", "kumo/memory.md", "inbox/.md"] {
            assert!(!openable(bad), "{bad}");
        }
    }

    #[test]
    fn obsidian_uris_are_percent_encoded() {
        assert_eq!(encode("Obsidian Vault"), "Obsidian%20Vault");
        assert_eq!(encode("a&b=c"), "a%26b%3Dc");
    }

    #[test]
    fn unknown_apps_never_launch() {
        assert!(launch_app("C:\\Windows\\System32\\cmd.exe").is_err());
    }
}
