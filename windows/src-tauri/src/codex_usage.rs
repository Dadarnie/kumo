// SPDX-License-Identifier: MIT
//! On-demand, read-only Codex account usage. Never read auth.json or transcripts.
use crate::windows;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const BUDGET: Duration = Duration::from_secs(15);
const MAX_REPLY: usize = 1024 * 1024;
const READ_ERROR: &str = "Could not read Codex usage. Open Codex, sign in, and refresh.";

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub used_percent: f64,
    pub window_minutes: Option<u64>,
    pub resets_at: Option<u64>,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCredits {
    pub available_count: u64,
    pub next_expires_at: Option<u64>,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsage {
    pub plan: Option<String>,
    pub primary: Option<UsageWindow>,
    pub secondary: Option<UsageWindow>,
    pub reset_credits: Option<ResetCredits>,
    pub lifetime_tokens: Option<u64>,
    pub peak_daily_tokens: Option<u64>,
    pub checked_at: u64,
}

// This optional summary comes from the same supported rateLimits/read reply.
// Keep only reported count and earliest reported available expiry; never retain
// opaque credit IDs, account identity, or backend display strings.
fn reset_credits(value: &Value) -> Option<ResetCredits> {
    let available_count = value.get("availableCount")?.as_u64()?;
    if available_count > 9_007_199_254_740_991 {
        return None;
    }
    let next_expires_at = if available_count > 0 {
        value
            .get("credits")
            .and_then(Value::as_array)
            .and_then(|credits| {
                credits
                    .iter()
                    .take(256)
                    .filter(|credit| {
                        credit.get("status").and_then(Value::as_str) == Some("available")
                            && credit.get("resetType").and_then(Value::as_str)
                                == Some("codexRateLimits")
                    })
                    .filter_map(|credit| credit.get("expiresAt").and_then(Value::as_u64))
                    .filter(|&seconds| seconds > 0 && seconds <= 4102444800)
                    .min()
            })
    } else {
        None
    };
    Some(ResetCredits {
        available_count,
        next_expires_at,
    })
}

fn window(value: &Value) -> Option<UsageWindow> {
    let used = value.get("usedPercent")?.as_f64()?;
    if !used.is_finite() || !(0.0..=100.0).contains(&used) {
        return None;
    }
    Some(UsageWindow {
        used_percent: used,
        window_minutes: value
            .get("windowDurationMins")
            .and_then(Value::as_u64)
            .filter(|&n| n > 0 && n <= 525600),
        resets_at: value
            .get("resetsAt")
            .and_then(Value::as_u64)
            .filter(|&n| n <= 4102444800),
    })
}
fn parse_usage(account: &Value, limits: &Value, totals: &Value) -> CodexUsage {
    let rate = limits
        .get("rateLimitsByLimitId")
        .and_then(|v| v.get("codex"))
        .or_else(|| limits.get("rateLimits"))
        .unwrap_or(&Value::Null);
    let plan = account
        .get("account")
        .and_then(|v| v.get("planType"))
        .and_then(Value::as_str)
        .filter(|value| {
            [
                "free",
                "go",
                "plus",
                "pro",
                "team",
                "business",
                "enterprise",
                "edu",
            ]
            .contains(value)
        })
        .map(str::to_string);
    CodexUsage {
        plan,
        primary: rate.get("primary").and_then(window),
        secondary: rate.get("secondary").and_then(window),
        reset_credits: limits.get("rateLimitResetCredits").and_then(reset_credits),
        lifetime_tokens: totals
            .pointer("/summary/lifetimeTokens")
            .and_then(Value::as_u64),
        peak_daily_tokens: totals
            .pointer("/summary/peakDailyTokens")
            .and_then(Value::as_u64),
        checked_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    }
}

/// Resolve a native executable; do not run shell launchers or inspect their text.
pub fn executable() -> Option<PathBuf> {
    let dirs = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&dirs).filter(|path| path.is_absolute()) {
        let direct = dir.join("codex.exe");
        if direct.is_file() {
            return Some(direct);
        }
        for suffix in [
            "node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
            "node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/codex/codex.exe",
            "node_modules/@openai/codex/node_modules/@openai/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/bin/codex.exe",
        ] {
            let candidate = dir.join(suffix);
            if candidate.is_file() { return Some(candidate); }
        }
    }
    extension_executable(&windows::home_dir().join(".vscode").join("extensions")).or_else(|| {
        extension_executable(
            &windows::home_dir()
                .join(".vscode-insiders")
                .join("extensions"),
        )
    })
}

/// An installed OpenAI VS Code extension also bundles the native app-server.
/// No VS Code settings, tokens, shell scripts, or unrelated extensions are read.
fn extension_executable(root: &Path) -> Option<PathBuf> {
    let mut newest: Option<(Vec<u64>, PathBuf)> = None;
    for entry in std::fs::read_dir(root).ok()?.take(512).flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(version) = name.strip_prefix("openai.chatgpt-") else {
            continue;
        };
        let version = version
            .strip_suffix("-win32-x64")
            .or_else(|| version.strip_suffix("-win32-arm64"))
            .unwrap_or(version);
        if version.len() > 40 {
            continue;
        }
        let Some(parts) = version
            .split('.')
            .map(|part| part.parse::<u64>().ok())
            .collect::<Option<Vec<_>>>()
        else {
            continue;
        };
        if parts.len() != 3 {
            continue;
        }
        for platform in ["windows-x86_64", "windows-aarch64"] {
            let candidate = entry.path().join("bin").join(platform).join("codex.exe");
            if candidate.is_file() && newest.as_ref().is_none_or(|(prior, _)| parts > *prior) {
                newest = Some((parts.clone(), candidate));
            }
        }
    }
    newest.map(|(_, path)| path)
}

/// Own the helper process tree so inherited stdout handles cannot strand its reader.
struct HelperJob(::windows::Win32::Foundation::HANDLE);
impl HelperJob {
    fn attach(child: &Child) -> Result<Self, String> {
        use ::windows::Win32::{Foundation::HANDLE, System::JobObjects::*};
        use std::os::windows::io::AsRawHandle;
        unsafe {
            let job = Self(CreateJobObjectW(None, None).map_err(|_| READ_ERROR)?);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&limits) as u32,
            )
            .map_err(|_| READ_ERROR)?;
            AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle()))
                .map_err(|_| READ_ERROR)?;
            Ok(job)
        }
    }
}
impl Drop for HelperJob {
    fn drop(&mut self) {
        unsafe {
            let _ = ::windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

struct Server {
    child: Child,
    job: Option<HelperJob>,
    input: ChildStdin,
    replies: Option<Receiver<Value>>,
    reader: Option<std::thread::JoinHandle<()>>,
    deadline: Instant,
}
impl Drop for Server {
    fn drop(&mut self) {
        // Release a possibly blocked channel send before joining its reader.
        self.replies.take();
        self.job.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
impl Server {
    fn start(exe: &Path) -> Result<Self, String> {
        let mut command = Command::new(exe);
        command
            .args(["app-server", "--listen", "stdio://"])
            .current_dir(windows::local_dir());
        Self::start_command(&mut command)
    }
    fn start_command(command: &mut Command) -> Result<Self, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = windows::no_console(command)
            .spawn()
            .map_err(|_| READ_ERROR)?;
        let job = match HelperJob::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let (Some(input), Some(output)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(READ_ERROR.into());
        };
        let (send, replies) = mpsc::sync_channel(4);
        let reader = std::thread::Builder::new()
            .name("codex-usage-reader".into())
            .spawn(move || {
                let mut reader = BufReader::new(output);
                // A bounded line reader and bounded channel prevent helper output
                // from becoming an unbounded diagnostics/history buffer.
                loop {
                    let mut line = String::new();
                    let length = Read::by_ref(&mut reader)
                        .take(MAX_REPLY as u64 + 1)
                        .read_line(&mut line);
                    if !matches!(length, Ok(n) if n > 0 && n <= MAX_REPLY && line.ends_with('\n')) {
                        break;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if send.send(value).is_err() {
                        break;
                    }
                }
            });
        let reader = match reader {
            Ok(reader) => reader,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(READ_ERROR.into());
            }
        };
        Ok(Self {
            child,
            job: Some(job),
            input,
            replies: Some(replies),
            reader: Some(reader),
            deadline: Instant::now() + BUDGET,
        })
    }
    fn send(&mut self, message: Value) -> Result<(), String> {
        writeln!(self.input, "{message}")
            .and_then(|_| self.input.flush())
            .map_err(|_| READ_ERROR.into())
    }
    fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, String> {
        self.send(json!({"id":id,"method":method,"params":params}))?;
        loop {
            let remaining = self.deadline.saturating_duration_since(Instant::now());
            let message = self
                .replies
                .as_ref()
                .ok_or(READ_ERROR)?
                .recv_timeout(remaining)
                .map_err(|_| READ_ERROR)?;
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                return message
                    .get("result")
                    .cloned()
                    .ok_or_else(|| READ_ERROR.into());
            }
            // No elicitation or token-sharing handshake belongs to a usage read.
            if let Some(id) = message.get("id") {
                self.send(
                    json!({"id":id, "error":{"code":-32601,"message":"Read-only usage client"}}),
                )?;
            }
        }
    }
}

fn read_usage() -> Result<CodexUsage, String> {
    let exe = executable()
        .ok_or("Codex CLI was not found. Install Codex for Windows and sign in first.")?;
    read_from_server(Server::start(&exe)?)
}

fn read_from_server(mut server: Server) -> Result<CodexUsage, String> {
    server.request(
        1,
        "initialize",
        json!({"clientInfo":{"name":"mimo","title":"Mimo","version":env!("CARGO_PKG_VERSION")}}),
    )?;
    server.send(json!({"method":"initialized","params":{}}))?;
    let account = server.request(2, "account/read", json!({"refreshToken":false}))?;
    let account_type = account.pointer("/account/type").and_then(Value::as_str);
    if account_type != Some("chatgpt") {
        return Err("Codex account limits need a ChatGPT sign-in. Open Codex and sign in with your existing account.".into());
    }
    let limits = server.request(3, "account/rateLimits/read", json!({}))?;
    // Token summaries are optional on older Codex versions. Do not turn a
    // missing summary into a fabricated zero or discard valid rate windows.
    let totals =
        if server.deadline.saturating_duration_since(Instant::now()) > Duration::from_secs(2) {
            server
                .request(4, "account/usage/read", json!({}))
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
    Ok(parse_usage(&account, &limits, &totals))
}

#[derive(Default)]
pub struct UsageCache {
    latest: tokio::sync::Mutex<Option<(Instant, CodexUsage)>>,
}
impl UsageCache {
    pub async fn read(&self, force: bool) -> Result<CodexUsage, String> {
        let mut latest = self.latest.lock().await;
        if let Some((at, snapshot)) = latest.as_ref() {
            if at.elapsed() < Duration::from_secs(if force { 2 } else { 60 }) {
                return Ok(snapshot.clone());
            }
        }
        let snapshot = tauri::async_runtime::spawn_blocking(read_usage)
            .await
            .map_err(|_| READ_ERROR)?;
        let snapshot = snapshot?;
        *latest = Some((Instant::now(), snapshot.clone()));
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vscode_resolver_uses_only_the_installed_openai_native_executable() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("mimo-vscode-codex-{}-{nonce}", std::process::id()));
        let names = [
            "openai.chatgpt-1.2.3-win32-x64",
            "openai.chatgpt-1.2.10-win32-x64",
            "foreign.chatgpt-99.0.0",
        ];
        for name in names {
            let bin = dir.join(name).join("bin").join("windows-x86_64");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(bin.join("codex.exe"), b"unused test fixture").unwrap();
        }
        assert_eq!(
            extension_executable(&dir).unwrap(),
            dir.join(names[1])
                .join("bin")
                .join("windows-x86_64")
                .join("codex.exe")
        );
        for name in names {
            let bin = dir.join(name).join("bin").join("windows-x86_64");
            std::fs::remove_file(bin.join("codex.exe")).unwrap();
            std::fs::remove_dir(&bin).unwrap();
            std::fs::remove_dir(bin.parent().unwrap()).unwrap();
            std::fs::remove_dir(dir.join(name)).unwrap();
        }
        std::fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn publishes_only_compact_usage_fields_without_account_secrets() {
        let usage = parse_usage(
            &json!({"account":{"type":"chatgpt","planType":"pro","email":"private","accessToken":"synthetic-private"}}),
            &json!({"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":25.5,"windowDurationMins":300,"resetsAt":1800000000}}}}),
            &json!({"summary":{"lifetimeTokens":123456,"peakDailyTokens":5000},"dailyUsageBuckets":[{"private":"content"}]}),
        );
        assert_eq!(usage.primary.unwrap().used_percent, 25.5);
        assert_eq!(usage.plan.as_deref(), Some("pro"));
        let json = serde_json::to_string(&parse_usage(
            &json!({"account":{"email":"synthetic-private","planType":"synthetic-private"}}),
            &Value::Null,
            &Value::Null,
        ))
        .unwrap();
        assert!(!json.contains("synthetic-private"));
        assert!(!json.contains("email"));
    }
    #[test]
    fn reset_credits_publish_reported_count_and_expiry_without_private_details() {
        let limits = json!({"rateLimitResetCredits":{"availableCount":2,"credits":[
            {"id":"private-credit","resetType":"codexRateLimits","status":"available","expiresAt":1900000000,"title":"private-title"},
            {"resetType":"codexRateLimits","status":"available","expiresAt":1900600000},
            {"resetType":"codexRateLimits","status":"redeemed","expiresAt":1800000000},
            {"resetType":"unknown","status":"available","expiresAt":1700000000}
        ]}});
        let value = serde_json::to_value(parse_usage(&Value::Null, &limits, &Value::Null)).unwrap();
        assert_eq!(
            value["resetCredits"],
            json!({"availableCount":2,"nextExpiresAt":1900000000})
        );
        assert!(!value.to_string().contains("private-"));
    }
    #[test]
    fn reset_credit_counts_survive_missing_details_and_unknown_is_not_zero() {
        for (input, expected) in [
            (
                json!({"availableCount":3,"credits":null}),
                json!({"availableCount":3,"nextExpiresAt":null}),
            ),
            (
                json!({"availableCount":0,"credits":[]}),
                json!({"availableCount":0,"nextExpiresAt":null}),
            ),
            (
                json!({"availableCount":1,"credits":[{"resetType":"codexRateLimits","status":"available","expiresAt":999999999999_u64}]}),
                json!({"availableCount":1,"nextExpiresAt":null}),
            ),
            (json!({"availableCount":-1}), Value::Null),
            (json!({"availableCount":"unknown"}), Value::Null),
            (Value::Null, Value::Null),
        ] {
            let value = serde_json::to_value(parse_usage(
                &Value::Null,
                &json!({"rateLimitResetCredits":input}),
                &Value::Null,
            ))
            .unwrap();
            assert_eq!(value["resetCredits"], expected);
        }
    }
    #[test]
    fn unknown_and_malformed_usage_are_never_fabricated() {
        let empty = parse_usage(&Value::Null, &Value::Null, &Value::Null);
        assert!(empty.primary.is_none() && empty.lifetime_tokens.is_none());
        assert!(window(&json!({"usedPercent":-1})).is_none());
        assert!(window(&json!({"usedPercent":101})).is_none());
        assert!(window(&json!({"usedPercent":"synthetic-private"})).is_none());
        let valid =
            window(&json!({"usedPercent":0,"resetsAt":999999999999_u64,"windowDurationMins":0}))
                .unwrap();
        assert!(valid.resets_at.is_none() && valid.window_minutes.is_none());
    }
    // The test process doubles as a bounded, isolated protocol fixture. It
    // neither starts Codex nor reads/writes any user's login or hook files.
    #[test]
    fn fake_helper_child() {
        if std::env::var("MIMO_USAGE_PROTOCOL_FIXTURE").as_deref() != Ok("1") {
            return;
        }
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else {
                break;
            };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                break;
            };
            let Some(id) = message.get("id") else {
                continue;
            };
            let result = match message.get("method").and_then(Value::as_str) {
                Some("fixture/descendant") => {
                    let mut command = Command::new(std::env::current_exe().unwrap());
                    command
                        .args([
                            "--exact",
                            "codex_usage::tests::fake_helper_descendant",
                            "--nocapture",
                        ])
                        .env("MIMO_USAGE_DESCENDANT_FIXTURE", "1");
                    let child = windows::no_console(&mut command).spawn().unwrap();
                    json!({"pid":child.id()})
                }
                Some("initialize") => json!({}),
                Some("account/read") if message["params"]["refreshToken"] == false => {
                    json!({"account":{"type":"chatgpt","planType":"plus","email":"synthetic-private","accessToken":"synthetic-private"}})
                }
                Some("account/rateLimits/read") => {
                    json!({"rateLimits":{"primary":{"usedPercent":40,"windowDurationMins":300,"resetsAt":1900000000}}})
                }
                Some("account/usage/read") => json!({"summary":{"lifetimeTokens":1234}}),
                _ => panic!("Unexpected usage method"),
            };
            println!("{}", json!({"id":id,"result":result}));
            std::io::stdout().flush().unwrap();
        }
    }
    #[test]
    fn fake_helper_descendant() {
        if std::env::var("MIMO_USAGE_DESCENDANT_FIXTURE").as_deref() == Ok("1") {
            // Inherit stdout deliberately: dropping the server must close the
            // entire helper tree and release its otherwise blocked reader.
            std::thread::sleep(Duration::from_secs(30));
        }
    }
    fn fixture() -> Server {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "codex_usage::tests::fake_helper_child",
                "--nocapture",
            ])
            .env("MIMO_USAGE_PROTOCOL_FIXTURE", "1")
            .current_dir(std::env::temp_dir());
        Server::start_command(&mut command).unwrap()
    }
    #[test]
    fn usage_handshake_is_read_only_and_helper_is_reaped_on_success_or_error() {
        use ::windows::Win32::{
            Foundation::CloseHandle,
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        for fail in [false, true] {
            let mut server = fixture();
            let process = unsafe {
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, server.child.id()).unwrap()
            };
            if fail {
                server.deadline = Instant::now();
            }
            let result = read_from_server(server);
            if fail {
                assert!(result.is_err());
            } else {
                let usage = result.unwrap();
                assert_eq!(usage.plan.as_deref(), Some("plus"));
                assert_eq!(usage.primary.as_ref().unwrap().used_percent, 40.0);
                assert_eq!(usage.lifetime_tokens, Some(1234));
                assert!(!serde_json::to_string(&usage)
                    .unwrap()
                    .contains("synthetic-private"));
            }
            unsafe {
                let mut exit = 259;
                GetExitCodeProcess(process, &mut exit).unwrap();
                CloseHandle(process).unwrap();
                assert_ne!(exit, 259, "The usage helper must have exited");
            }
        }
    }
    #[test]
    fn helper_descendants_and_inherited_stdout_are_released_on_drop() {
        use ::windows::Win32::{
            Foundation::{CloseHandle, WAIT_OBJECT_0},
            System::Threading::{
                OpenProcess, WaitForSingleObject, PROCESS_ACCESS_RIGHTS,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        let mut server = fixture();
        let reply = server.request(1, "fixture/descendant", json!({})).unwrap();
        let pid = reply["pid"].as_u64().unwrap() as u32;
        let process = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_ACCESS_RIGHTS(0x00100000),
                false,
                pid,
            )
            .unwrap()
        };
        let started = Instant::now();
        drop(server);
        let exited = unsafe { WaitForSingleObject(process, 2000) };
        unsafe {
            CloseHandle(process).unwrap();
        }
        assert_eq!(exited, WAIT_OBJECT_0, "Helper descendants must exit too");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "Reader cleanup must not wait for a descendant"
        );
    }
}
