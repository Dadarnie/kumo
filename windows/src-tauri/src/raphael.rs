// SPDX-License-Identifier: MIT
//! Raphael, the local voice assistant, as a supervised child process.
//!
//! Kumo starts `<raphael dir>\.venv\Scripts\python.exe chat.py --kumo`. Raphael writes
//! one JSON event per line on stdout; each becomes a `raphael` event for the island.
//! The island's commands go back as JSON lines on stdin (`kumo_bridge.py` documents
//! both directions). Closing stdin is Raphael's signal to save its session and quit,
//! so stopping is graceful, and if Kumo itself dies the pipe closes the same way.
//! A crash restarts it with backoff; stderr goes to `raphael.log`.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::log;
use crate::settings::Settings;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Time Raphael gets to write its daily session summary after stdin closes.
const QUIT_GRACE: Duration = Duration::from_secs(20);
const MAX_LINE: usize = 64 * 1024;
const BACKOFF: [u64; 4] = [2, 5, 15, 30];

#[derive(Default)]
pub struct Raphael(Mutex<Option<Running>>);

/// Everything Raphael is started with; a change restarts it.
#[derive(Clone, PartialEq)]
struct Launch {
    dir: PathBuf,
    always_listen: bool,
    model: String,
}

struct Running {
    launch: Launch,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    stop: Arc<AtomicBool>,
}

/// The microphone-consent entry of the running Raphael, so the call pill ignores it.
static MIC_ENTRY: Mutex<Option<String>> = Mutex::new(None);

pub fn is_own_mic_entry(entry: &str) -> bool {
    MIC_ENTRY
        .lock()
        .unwrap()
        .as_deref()
        .is_some_and(|own| own.eq_ignore_ascii_case(entry))
}

fn python(dir: &Path) -> PathBuf {
    dir.join(".venv").join("Scripts").join("python.exe")
}

/// The venv's python.exe only launches the base interpreter (`home` in pyvenv.cfg),
/// and that interpreter is the one Windows records as using the microphone.
fn mic_user(dir: &Path) -> PathBuf {
    std::fs::read_to_string(dir.join(".venv").join("pyvenv.cfg"))
        .ok()
        .and_then(|cfg| {
            cfg.lines()
                .find_map(|l| l.split_once('=').filter(|(k, _)| k.trim() == "home").map(|(_, v)| v.trim().to_string()))
        })
        .map(|home| Path::new(&home).join("python.exe"))
        .filter(|exe| exe.is_file())
        .unwrap_or_else(|| python(dir))
        .canonicalize() // uv's `home` is a junction; Windows records the resolved folder
        .map(|p| PathBuf::from(p.to_string_lossy().trim_start_matches(r"\\?\")))
        .unwrap_or_else(|_| python(dir))
}

/// A folder is usable when it holds Raphael's chat.py and its virtual environment.
pub fn valid_dir(dir: &Path) -> bool {
    dir.is_absolute() && dir.join("chat.py").is_file() && python(dir).is_file()
}

/// Raphael's saved headlines (`data/news.json`, written by news.py), newest first.
pub fn news(dir: &Path) -> Value {
    let items = std::fs::read(dir.join("data").join("news.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|v| v.get("items").cloned())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    Value::Array(items.into_iter().take(300).collect())
}

/// Only the commands kumo_bridge.py understands, with the fields it reads.
fn command_line(msg: &Value) -> Option<String> {
    let ok = match msg.get("t")?.as_str()? {
        "answer" => msg.get("id")?.is_u64() && msg.get("allow")?.is_boolean(),
        "text" => msg.get("v")?.as_str().is_some_and(|v| !v.trim().is_empty() && v.len() <= 4000),
        "mute" => msg.get("v")?.is_boolean(),
        "stop" | "news_refresh" => true,
        _ => false,
    };
    ok.then(|| msg.to_string())
}

impl Raphael {
    /// Start, restart or stop Raphael to match the settings.
    pub fn sync(&self, app: &AppHandle, settings: &Settings) {
        let want = settings.raphael_enabled.then(|| Launch {
            dir: PathBuf::from(settings.raphael_dir.trim()),
            always_listen: settings.raphael_always_listen,
            model: settings.raphael_model.trim().to_string(),
        });
        let mut slot = self.0.lock().unwrap();
        if slot.as_ref().map(|r| &r.launch) == want.as_ref() {
            return;
        }
        if let Some(old) = slot.take() {
            old.stop.store(true, Ordering::SeqCst);
            old.stdin.lock().unwrap().take(); // EOF: Raphael saves its session and exits
        }
        let Some(launch) = want else { return };
        if !valid_dir(&launch.dir) {
            log::line(&format!("raphael: not started, no chat.py or .venv in {}", launch.dir.display()));
            let _ = app.emit("raphael", serde_json::json!({"t": "unavailable"}));
            return;
        }
        let running = Running {
            launch: launch.clone(),
            stdin: Arc::default(),
            stop: Arc::default(),
        };
        let (stdin, stop, app) = (running.stdin.clone(), running.stop.clone(), app.clone());
        std::thread::Builder::new()
            .name("raphael".into())
            .spawn(move || supervise(app, launch, stdin, stop))
            .ok();
        *slot = Some(running);
    }

    pub fn send(&self, msg: &Value) -> Result<(), String> {
        let line = command_line(msg).ok_or("unsupported Raphael command")?;
        let slot = self.0.lock().unwrap();
        let running = slot.as_ref().ok_or("Raphael is off")?;
        let mut stdin = running.stdin.lock().unwrap();
        let pipe = stdin.as_mut().ok_or("Raphael is starting")?;
        writeln!(pipe, "{line}").and_then(|()| pipe.flush()).map_err(|e| e.to_string())
    }
}

fn supervise(app: AppHandle, launch: Launch, stdin: Arc<Mutex<Option<ChildStdin>>>, stop: Arc<AtomicBool>) {
    let dir = &launch.dir;
    let mut failures = 0usize;
    while !stop.load(Ordering::SeqCst) {
        let started = Instant::now();
        match spawn(&launch) {
            Ok(mut child) => {
                *stdin.lock().unwrap() = child.stdin.take();
                *MIC_ENTRY.lock().unwrap() = Some(mic_user(&dir).to_string_lossy().replace('\\', "#"));
                if let Some(out) = child.stdout.take() {
                    relay(&app, out);
                }
                // stdout closed: Raphael is quitting (or Kumo asked it to).
                stdin.lock().unwrap().take();
                let code = finish(&mut child);
                *MIC_ENTRY.lock().unwrap() = None;
                log::line(&format!("raphael: exited ({code:?})"));
                let _ = app.emit("raphael", serde_json::json!({"t": "exit", "code": code}));
            }
            Err(err) => log::line(&format!("raphael: could not start: {err}")),
        }
        if stop.load(Ordering::SeqCst) {
            break;
        }
        failures = if started.elapsed() > Duration::from_secs(60) { 0 } else { failures + 1 };
        let wait = Instant::now() + Duration::from_secs(BACKOFF[failures.min(BACKOFF.len() - 1)]);
        while Instant::now() < wait && !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

fn spawn(launch: &Launch) -> std::io::Result<Child> {
    let log = std::fs::File::create(crate::settings::local_dir().join("raphael.log"))?;
    let mut command = Command::new(python(&launch.dir));
    if !launch.model.is_empty() {
        command.env("RAPHAEL_MODEL", &launch.model);
    }
    command
        .args(["chat.py", "--kumo"])
        .current_dir(&launch.dir)
        .env("RAPHAEL_ALWAYS_LISTEN", if launch.always_listen { "1" } else { "0" })
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(log)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
}

/// Every stdout line that is a JSON object goes to the island; anything else is dropped.
fn relay(app: &AppHandle, out: std::process::ChildStdout) {
    let mut reader = BufReader::new(out);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.by_ref().take(MAX_LINE as u64).read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if let Ok(event @ Value::Object(_)) = serde_json::from_str::<Value>(line.trim()) {
            let _ = app.emit("raphael", event);
        }
    }
}

/// Wait for a quitting Raphael, killing it if it outlives the grace period.
fn finish(child: &mut Child) -> Option<i32> {
    let deadline = Instant::now() + QUIT_GRACE;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.code(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(200)),
            _ => {
                let _ = child.kill();
                return child.wait().ok().and_then(|s| s.code());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_bridge_commands_reach_raphael() {
        assert!(command_line(&json!({"t": "answer", "id": 3, "allow": true})).is_some());
        assert!(command_line(&json!({"t": "answer", "id": "3", "allow": true})).is_none());
        assert!(command_line(&json!({"t": "text", "v": "what time is it"})).is_some());
        assert!(command_line(&json!({"t": "text", "v": "  "})).is_none());
        assert!(command_line(&json!({"t": "mute", "v": false})).is_some());
        assert!(command_line(&json!({"t": "stop"})).is_some());
        assert!(command_line(&json!({"t": "news_refresh"})).is_some());
        assert!(command_line(&json!({"t": "quit"})).is_none());
        assert!(command_line(&json!({"t": "eval", "v": "x"})).is_none());
        assert!(command_line(&json!("stop")).is_none());
    }

    #[test]
    fn a_folder_needs_chat_py_and_its_venv() {
        assert!(!valid_dir(Path::new("relative")));
        assert!(!valid_dir(&std::env::temp_dir()));
    }
}

#[cfg(test)]
mod live {
    /// Run with --ignored on a PC that has Raphael: the mic entry must match what Windows records.
    #[test]
    #[ignore]
    fn mic_user_resolves_the_uv_junction() {
        let dir = std::path::Path::new(r"C:\Users\darnie\own projects\raphael");
        let entry = super::mic_user(dir).to_string_lossy().replace('\\', "#");
        assert!(entry.contains("cpython-3.11.15"), "{entry}");
    }
}
