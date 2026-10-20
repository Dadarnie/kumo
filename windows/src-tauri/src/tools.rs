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

const INBOX: &str = "Mimo Inbox.md";

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

/// Appends `- HH:MM text` to the vault's Mimo Inbox note.
pub fn quick_note(vault_id: &str, text: &str) -> Result<(), String> {
    let text: String = text
        .chars()
        .filter(|c| !c.is_control())
        .take(2000)
        .collect();
    let text = text.trim();
    if text.is_empty() {
        return Err("The note is empty".into());
    }
    let (_, path) = vault_paths()
        .into_iter()
        .find(|(id, _)| id == vault_id)
        .ok_or("That vault is not available")?;
    let time = windows::local_time();
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path.join(INBOX))
        .map_err(|error| format!("Could not write the note: {error}"))?;
    writeln!(file, "- {:02}:{:02} {text}", time.hour, time.minute)
        .map_err(|error| format!("Could not write the note: {error}"))
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

/// Opens the vault's Mimo Inbox in Obsidian.
pub fn open_inbox(vault_id: &str) -> Result<(), String> {
    let vault = vaults()
        .into_iter()
        .find(|vault| vault.id == vault_id)
        .ok_or("That vault is not available")?;
    windows::open_url(&format!(
        "obsidian://open?vault={}&file={}",
        encode(&vault.name),
        encode(INBOX.trim_end_matches(".md"))
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_ids_and_actions_are_strict() {
        assert!(container_id_ok("0123456789ab"));
        assert!(!container_id_ok("abc"));
        assert!(!container_id_ok("0123456789ab; rm"));
        assert!(docker_action("0123456789ab", "rm").is_err());
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
