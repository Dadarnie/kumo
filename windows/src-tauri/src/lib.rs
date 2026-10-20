// SPDX-License-Identifier: MIT
// Mimo for Windows — app wiring and the commands the island calls.

mod audio_runtime;
mod chat_api;
mod chat_history;
mod chat_requests;
mod claude;
mod claude_usage;
mod codex_hooks;
mod codex_usage;
mod coding_hooks;
mod files;
mod grab;
mod grab_capture;
mod grab_clipboard;
mod grab_store;
mod hook_config;
mod hooks;
mod integrations;
mod island;
mod log;
pub mod media;
pub mod media_player;
mod media_runtime;
mod migration;
mod openai;
mod pipe;
mod secrets;
mod settings;
mod tools;
mod tray;
mod voice_chat;
mod webview_memory;
mod windows;
mod workflow_native;

use std::process::Command;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;

use claude::{Chat, ChatContext, ChatReply};
use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::{PollGate, PositionInfo, ScreenInfo};
use media_runtime::{MediaRuntime, MediaSnapshot};
use pipe::Pending;
use settings::{ChatProvider, CodingAssistant, IslandVisibility, Settings};

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    position: PositionInfo,
    version: String,
    hook_path: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
    power: windows::power::PowerSnapshot,
}

#[tauri::command]
fn get_media_state(media: State<MediaRuntime>) -> MediaSnapshot {
    media.snapshot()
}

#[tauri::command]
async fn media_control(
    media: State<'_, MediaRuntime>,
    session_id: String,
    action: media_player::MediaAction,
) -> Result<MediaSnapshot, String> {
    media.control(session_id, action).await
}

#[tauri::command]
fn get_audio_state(media: State<MediaRuntime>) -> audio_runtime::AudioSnapshot {
    media.audio.snapshot()
}

#[tauri::command]
fn set_audio_meter_active(media: State<MediaRuntime>, active: bool) {
    media.audio.set_meter_active(active);
}

#[tauri::command]
async fn audio_control(
    media: State<'_, MediaRuntime>,
    action: audio_runtime::AudioAction,
) -> Result<audio_runtime::AudioSnapshot, String> {
    media.audio.control(action).await
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut current = shared.settings.lock().unwrap();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    current.hooks_installed = hooks::status().installed;
    current.codex_hooks_installed = codex_hooks::status().installed;
    for provider in CodingAssistant::ALL.into_iter().filter(|p| !p.approvals()) {
        current
            .coding_hooks_installed
            .insert(provider, coding_hooks::status(provider).installed);
    }
    let settings = current.clone();
    drop(current);
    let screen = island::screen_info(&app, &settings.screen);
    let position = island::position_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        position,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
        cursor_poll: true,
        power: windows::power::snapshot(),
    }
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    shared: State<Shared>,
    chat: State<Chat>,
    openai_chat: State<openai::OpenAiChat>,
    api_chat: State<chat_api::ApiChat>,
    requests: State<chat_requests::ChatRequests>,
    voice: State<voice_chat::VoiceChat>,
    mut settings: Settings,
) {
    settings.upgrade_hover_behavior();
    let (
        screen_changed,
        appearance_changed,
        autostart_changed,
        monitoring_changed,
        working_mode_changed,
    ) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let working_mode_changed = current.working_mode_enabled != settings.working_mode_enabled;
        let appearance_changed = current.appearance != settings.appearance;
        let autostart_changed = current.autostart != settings.autostart;
        let assistant_changed = current.chat_changed(&settings);
        if assistant_changed
            || current.voice_provider != settings.voice_provider
            || current.voice_replies_enabled != settings.voice_replies_enabled
        {
            voice.cancel();
        }
        let monitoring_changed = current.modules.developer_integrations
            != settings.modules.developer_integrations
            || current.active_integrations != settings.active_integrations;
        // A settings window can hold an older copy of the last visibility.
        settings.last_visibility = current.last_visibility;
        settings.island_anchor = current.island_anchor;
        settings.desktop_companion = None;
        settings.peek_enabled = false;
        settings.hooks_installed = current.hooks_installed;
        settings.codex_hooks_installed = current.codex_hooks_installed;
        settings.coding_hooks_installed = current.coding_hooks_installed.clone();
        settings.workflow_setup_done |= current.workflow_setup_done;
        // A new turn cannot observe new preferences with an old conversation.
        if assistant_changed {
            requests.cancel();
            chat.reset();
            openai_chat.reset();
            api_chat.reset();
        }
        *current = settings.clone();
        (
            screen_changed,
            appearance_changed,
            autostart_changed,
            monitoring_changed,
            working_mode_changed,
        )
    };
    if let Err(err) = settings::save(&settings) {
        eprintln!("[mimo] could not save settings: {err}");
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart {
            manager.enable()
        } else {
            manager.disable()
        };
        if let Err(err) = result {
            eprintln!("[mimo] autostart: {err}");
        }
    }
    if working_mode_changed {
        *shared.gate.desktop.lock().unwrap() = settings.desktop_companion.clone();
    }
    if screen_changed || appearance_changed || working_mode_changed {
        let visibility = *shared.gate.visibility.lock().unwrap();
        island::apply_geometry(&app, &settings.screen, visibility);
    }
    if monitoring_changed {
        integrations::preferences_changed();
    }
    if !settings.modules.vscode {
        pipe::decline_all(&app);
    }
    if !settings.usage_enabled || !settings.modules.vscode {
        app.state::<claude_usage::UsageCache>().clear();
    }
    workflow_native::refresh_voice(&app);
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

#[tauri::command]
fn set_island_visibility(app: AppHandle, shared: State<Shared>, visibility: IslandVisibility) {
    *shared.gate.visibility.lock().unwrap() = visibility;
    let (settings, changed) = {
        let mut settings = shared.settings.lock().unwrap();
        let changed = settings.last_visibility != visibility;
        settings.last_visibility = visibility;
        (settings.clone(), changed)
    };
    island::apply_geometry(&app, &settings.screen, visibility);
    let (w, h) = island::logical_size(visibility);
    shared.gate.set_rect(island::IslandRect {
        x: (island::PANEL_W - w) / 2.0,
        y: 0.0,
        w,
        h,
        ..Default::default()
    });
    island::refresh_click_through(&app, &shared.gate);
    // The poll keeps running in the working lip so its mascot can follow the
    // cursor; the lip still only accepts clicks inside its exact native clip.
    shared.gate.set_active(true);
    if changed {
        if let Err(error) = settings::save(&settings) {
            log::line(format!("visibility preference: {error}"));
        }
        let _ = app.emit("visibility-changed", visibility);
    }
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(
    app: AppHandle,
    shared: State<Shared>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    radius: f64,
) {
    if ![x, y, width, height, radius]
        .iter()
        .all(|value| value.is_finite())
        || width <= 0.0
        || height <= 0.0
    {
        return;
    }
    shared.gate.set_rect(island::IslandRect {
        x,
        y,
        w: width,
        h: height,
        radius: radius.clamp(0.0, 64.0),
    });
    island::refresh_surface(&app, &shared.gate);
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(win) = island::window(&handle) else {
            return;
        };
        windows::set_activating(&win, focused);
        if focused {
            let _ = win.set_focus();
        }
        let shared = handle.state::<Shared>();
        shared.gate.surface.invalidate_window_style();
        island::refresh_surface(&handle, &shared.gate);
    });
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let visibility = *shared.gate.visibility.lock().unwrap();
    island::apply_geometry(&app, &pref, visibility);
}

// Complete each move on the GUI thread before acknowledging it. The page
// coalesces pointer events, so no stale positions accumulate in the IPC queue.
async fn move_island(
    app: AppHandle,
    action: u8,
    offset: (f64, f64),
) -> Result<PositionInfo, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        match action {
            0 => island::begin_move(&handle, offset.0, offset.1),
            1 => island::move_anchor(&handle),
            4 => island::cancel_move(&handle),
            _ => island::finish_move(&handle),
        }
        let pref = handle
            .state::<Shared>()
            .settings
            .lock()
            .unwrap()
            .screen
            .clone();
        let _ = send.send(island::position_info(&handle, &pref));
    })
    .map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn begin_island_move(
    app: AppHandle,
    offset_x: Option<f64>,
    offset_y: Option<f64>,
) -> Result<PositionInfo, String> {
    move_island(app, 0, (offset_x.unwrap_or(0.0), offset_y.unwrap_or(0.0))).await
}
#[tauri::command]
async fn move_island_anchor(app: AppHandle) -> Result<PositionInfo, String> {
    move_island(app, 1, (0.0, 0.0)).await
}
#[tauri::command]
async fn finish_island_move(app: AppHandle) -> Result<PositionInfo, String> {
    move_island(app, 2, (0.0, 0.0)).await
}
#[tauri::command]
async fn cancel_island_move(app: AppHandle) -> Result<PositionInfo, String> {
    move_island(app, 4, (0.0, 0.0)).await
}

#[tauri::command]
fn show_mimo_menu(app: AppHandle) -> Result<(), String> {
    tray::popup(&app).map_err(|error| error.to_string())
}

/// Brings the app that owns the current media session to the front, by its
/// AppUserModelID (e.g. `Simpmusic_ejp2bhxmz1qq6!Simpmusic`). Only plain ID
/// characters pass, so nothing else can ride along to explorer.
fn media_app_id_ok(app_id: &str) -> bool {
    !app_id.is_empty()
        && app_id.len() <= 256
        && app_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-!".contains(c))
}

#[test]
fn media_app_ids_reject_anything_but_plain_ids() {
    assert!(media_app_id_ok("Simpmusic_ejp2bhxmz1qq6!Simpmusic"));
    assert!(media_app_id_ok("Spotify.exe"));
    for bad in ["", "a b", r"x\..\cmd", "a&calc", "\"q\"", "a;b"] {
        assert!(!media_app_id_ok(bad), "{bad}");
    }
}

#[tauri::command]
fn open_media_source(app_id: String) -> bool {
    if !media_app_id_ok(&app_id) {
        return false;
    }
    let mut cmd = Command::new("explorer.exe");
    cmd.arg(format!(r"shell:AppsFolder\{app_id}"));
    windows::no_console(&mut cmd).spawn().is_ok()
}

/// The call in progress (an app holding the microphone), if any.
#[tauri::command]
fn call_state() -> Option<windows::call::CallState> {
    windows::call::active_call()
}

#[tauri::command]
fn call_set_muted(muted: bool) -> Result<bool, String> {
    windows::call::set_mic_muted(muted)
}

/// Focuses only the app that is on the call right now, never an arbitrary path.
#[tauri::command]
fn call_focus() -> bool {
    windows::call::active_call()
        .and_then(|call| call.path)
        .is_some_and(|path| windows::call::focus_call_app(&path))
}

// ── Tools tab ────────────────────────────────────────────────────────────────

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn tools_apps(refresh: bool) -> Result<Vec<tools::StartApp>, String> {
    blocking(move || tools::start_apps(refresh)).await?
}

#[tauri::command]
fn tools_launch(id: String) -> Result<(), String> {
    tools::launch_app(&id)
}

#[tauri::command]
async fn tools_docker() -> Result<tools::DockerState, String> {
    blocking(tools::docker_state).await
}

#[tauri::command]
async fn tools_docker_action(id: String, action: String) -> Result<(), String> {
    blocking(move || tools::docker_action(&id, &action)).await?
}

#[tauri::command]
async fn tools_ollama() -> tools::OllamaState {
    tools::ollama_state().await
}

#[tauri::command]
async fn tools_ollama_unload(name: String) -> Result<(), String> {
    tools::ollama_unload(&name).await
}

#[tauri::command]
fn tools_vaults() -> Vec<tools::Vault> {
    tools::vaults()
}

#[tauri::command]
fn tools_quick_note(vault: String, text: String) -> Result<(), String> {
    tools::quick_note(&vault, &text)
}

#[tauri::command]
fn tools_open_inbox(vault: String) -> Result<(), String> {
    tools::open_inbox(&vault)
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    windows::open_url(&url);
}

/// "Open terminal" opens the working folder in VSCodium (`codium`) or VS Code
/// (`code`), whichever is on PATH first, and falls back to the file manager.
#[tauri::command]
fn open_in_vscode(path: Option<String>) -> bool {
    let launcher = if windows::find_on_path("codium").is_some() {
        "codium"
    } else {
        "code"
    };
    open_in_editor(path, launcher)
}
fn open_in_editor(path: Option<String>, launcher: &str) -> bool {
    // No shell anywhere near this. The path is a project folder chosen by
    // whoever is using Claude Code, and a shell would happily read `&`, `^`, `%`
    // or `$` in a folder name as syntax. Finding the launcher ourselves and
    // handing the path over as a separate argument keeps it a path.
    let path = path.filter(|p| !p.is_empty());
    // It arrives in a hook payload: only an existing folder, given by its full
    // path, goes any further. `code` would read `--something` as an option, and
    // xdg-open would launch a file with whatever handles its type.
    if let Some(p) = path.as_deref() {
        let p = std::path::Path::new(p);
        if !(p.is_absolute() && p.is_dir()) {
            return false;
        }
    }
    if let Some(code) = windows::find_on_path(launcher) {
        let mut cmd = Command::new(code);
        if let Some(p) = path.as_deref() {
            cmd.arg(p);
        }
        if windows::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(p) = path.as_deref() {
        windows::reveal_folder(p);
    }
    false
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

#[tauri::command]
fn hooks_status(provider: Option<CodingAssistant>) -> HookStatus {
    match provider.unwrap_or_default() {
        CodingAssistant::Claude => hooks::status(),
        CodingAssistant::Codex => codex_hooks::status(),
        provider => coding_hooks::status(provider),
    }
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(
    window: tauri::WebviewWindow,
    install: bool,
    provider: Option<CodingAssistant>,
) -> Result<HookPreview, String> {
    settings_only(&window)?;
    match provider.unwrap_or_default() {
        CodingAssistant::Claude => hooks::preview(install),
        CodingAssistant::Codex => codex_hooks::preview(install),
        provider => coding_hooks::preview(provider, install),
    }
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    window: tauri::WebviewWindow,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
    provider: Option<CodingAssistant>,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    settings_only(&window)?;
    let provider = provider.unwrap_or_default();
    let backup = match provider {
        CodingAssistant::Claude => hooks::write(install, &fingerprint)?,
        CodingAssistant::Codex => codex_hooks::write(install, &fingerprint)?,
        provider => coding_hooks::write(provider, install, &fingerprint)?,
    };
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        match provider {
            CodingAssistant::Claude => current.hooks_installed = install,
            CodingAssistant::Codex => current.codex_hooks_installed = install,
            provider => {
                current.coding_hooks_installed.insert(provider, install);
            }
        }
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    pipe::answer(&app, &request_id, &decision);
}

#[tauri::command]
fn question_answer(
    app: AppHandle,
    request_id: String,
    answers: serde_json::Value,
) -> Result<(), String> {
    pipe::answer_question(&app, &request_id, answers)
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    pipe::decline(&app, &request_id);
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// Only credential presence is exposed; keys stay in Windows Credential Manager.
#[tauri::command]
fn chat_connections() -> std::collections::BTreeMap<ChatProvider, bool> {
    ChatProvider::ALL
        .into_iter()
        .map(|provider| (provider, provider.key().is_none_or(secrets::present)))
        .collect()
}

/// Change only chat preferences. Switching cannot overwrite coding settings.
#[tauri::command]
fn chat_select(
    app: AppHandle,
    shared: State<Shared>,
    chat: State<Chat>,
    openai_chat: State<openai::OpenAiChat>,
    api_chat: State<chat_api::ApiChat>,
    requests: State<chat_requests::ChatRequests>,
    voice: State<voice_chat::VoiceChat>,
    provider: ChatProvider,
    model: String,
) -> Result<Settings, String> {
    chat_api::validate_model(provider, &model)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        if provider.key().is_some_and(|key| !secrets::present(key)) {
            return Err(format!(
                "Add a {} API key in Settings first.",
                provider.name()
            ));
        }
        let mut updated = current.clone();
        updated.chat_provider = provider;
        updated.chat_models.insert(provider, model.clone());
        match provider {
            ChatProvider::Anthropic => updated.model = model,
            ChatProvider::Openai => updated.codex_model = model,
            _ => {}
        }
        settings::save(&updated).map_err(|_| "Could not save this chat model. Try again.")?;
        if current.chat_changed(&updated) {
            voice.cancel();
            requests.cancel();
            chat.reset();
            openai_chat.reset();
            api_chat.reset();
        }
        *current = updated.clone();
        updated
    };
    let _ = app.emit("settings-changed", &updated);
    Ok(updated)
}

/// One chat turn. The API key and any file bytes stay on the Rust side.
#[tauri::command]
async fn chat_send(
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    openai_chat: State<'_, openai::OpenAiChat>,
    api_chat: State<'_, chat_api::ApiChat>,
    requests: State<'_, chat_requests::ChatRequests>,
    query: String,
    context: Option<ChatContext>,
    voice_control: Option<bool>,
) -> Result<ChatReply, String> {
    let ticket = requests.ticket();
    let mut preferences = shared.settings.lock().unwrap().clone();
    if voice_control == Some(true) {
        preferences.chat_provider = voice_chat::desktop_chat_provider(&preferences)?;
    }
    if query.trim().is_empty() || query.len() > 32_000 {
        return Err("Enter a message shorter than 32 KB.".into());
    }
    files::validate_context(&context)?;
    chat_api::validate_model(preferences.chat_provider, preferences.chat_model())?;
    match preferences.chat_provider {
        ChatProvider::Openai => {
            requests
                .run_at(
                    ticket,
                    openai::send(&openai_chat, preferences.chat_model(), query, context),
                )
                .await
        }
        ChatProvider::Anthropic => {
            requests
                .run_at(
                    ticket,
                    claude::send(&chat, preferences.chat_model(), query, context),
                )
                .await
        }
        provider => {
            requests
                .run_at(
                    ticket,
                    chat_api::send(
                        &api_chat,
                        provider,
                        preferences.chat_model(),
                        query,
                        context,
                    ),
                )
                .await
        }
    }
}

#[tauri::command]
fn chat_cancel(requests: State<chat_requests::ChatRequests>) {
    requests.cancel();
}

#[tauri::command]
fn chat_reset(
    chat: State<Chat>,
    openai_chat: State<openai::OpenAiChat>,
    api_chat: State<chat_api::ApiChat>,
    requests: State<chat_requests::ChatRequests>,
) {
    requests.cancel();
    chat.reset();
    openai_chat.reset();
    api_chat.reset();
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
async fn ingest_file(path: String) -> Result<DroppedFile, String> {
    tauri::async_runtime::spawn_blocking(move || files::ingest(&path))
        .await
        .map_err(|_| "Could not attach this file. Try again.")?
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

fn settings_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "settings" {
        Ok(())
    } else {
        Err("Open Settings to manage this connection.".into())
    }
}

#[tauri::command]
fn secret_set(
    app: AppHandle,
    window: tauri::WebviewWindow,
    shared: State<Shared>,
    chat: State<Chat>,
    openai_chat: State<openai::OpenAiChat>,
    api_chat: State<chat_api::ApiChat>,
    requests: State<chat_requests::ChatRequests>,
    voice: State<voice_chat::VoiceChat>,
    key: String,
    value: String,
) -> Result<(), String> {
    settings_only(&window)?;
    let preferences = shared.settings.lock().unwrap();
    if preferences.chat_provider.key() == Some(key.as_str()) {
        requests.cancel();
        chat.reset();
        openai_chat.reset();
        api_chat.reset();
    }
    secrets::set(&key, &value)?;
    if [
        "openai-api-key",
        "gemini-api-key",
        "xai-api-key",
        "groq-api-key",
    ]
    .contains(&key.as_str())
    {
        voice.cancel();
    }
    drop(preferences);
    workflow_native::refresh_voice(&app);
    integrations::preferences_changed();
    let _ = app.emit(
        "credentials-changed",
        serde_json::json!({"key":key,"present":true}),
    );
    Ok(())
}

#[tauri::command]
fn secret_clear(
    app: AppHandle,
    window: tauri::WebviewWindow,
    shared: State<Shared>,
    key: String,
    chat: State<Chat>,
    openai_chat: State<openai::OpenAiChat>,
    api_chat: State<chat_api::ApiChat>,
    requests: State<chat_requests::ChatRequests>,
    voice: State<voice_chat::VoiceChat>,
) -> Result<(), String> {
    settings_only(&window)?;
    let preferences = shared.settings.lock().unwrap();
    if preferences.chat_provider.key() == Some(key.as_str()) {
        requests.cancel();
        chat.reset();
        openai_chat.reset();
        api_chat.reset();
    }
    secrets::clear(&key)?;
    if [
        "openai-api-key",
        "gemini-api-key",
        "xai-api-key",
        "groq-api-key",
    ]
    .contains(&key.as_str())
    {
        voice.cancel();
    }
    drop(preferences);
    workflow_native::refresh_voice(&app);
    integrations::preferences_changed();
    let _ = app.emit(
        "credentials-changed",
        serde_json::json!({"key":key,"present":false}),
    );
    Ok(())
}

#[tauri::command]
async fn codex_usage(
    cache: State<'_, codex_usage::UsageCache>,
    shared: State<'_, Shared>,
    force: bool,
) -> Result<codex_usage::CodexUsage, String> {
    {
        let settings = shared.settings.lock().unwrap();
        if !settings.usage_enabled || !settings.modules.vscode {
            return Err("Usage is turned off.".into());
        }
    }
    cache.read(force).await
}

#[tauri::command]
fn claude_usage(
    cache: State<claude_usage::UsageCache>,
    shared: State<Shared>,
) -> Option<claude_usage::ClaudeUsage> {
    let settings = shared.settings.lock().unwrap();
    if settings.usage_enabled && settings.modules.vscode {
        cache.read()
    } else {
        None
    }
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

#[tauri::command]
fn open_n8n_page(page: String, id: String) {
    if !["executions", "workflow"].contains(&page.as_str())
        || id.len() > 100
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return;
    }
    if let Some(base) = secrets::get("n8n-url") {
        if secrets::validate("n8n-url", &base).is_ok() {
            open_url(format!("{}/{page}/{id}", base.trim_end_matches('/')));
        }
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Settings")
        .transparent(false)
        .background_color(tauri::window::Color(11, 13, 18, 255))
        .theme(Some(tauri::Theme::Dark))
        .inner_size(760.0, 640.0)
        .min_inner_size(620.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            webview_memory::settings_visibility(&win, false);
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.emit("settings-hidden", ());
                    let _ = hidden.hide();
                    webview_memory::settings_visibility(&hidden, false);
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(win) = handle.get_webview_window("settings") else {
            log::line("settings window missing");
            return;
        };
        // Restore, show, and focus in order. Worker-thread calls otherwise let
        // focus inspect Tao's still-hidden/minimized state before show runs.
        webview_memory::settings_visibility(&win, true);
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    });
}

#[tauri::command]
fn open_settings_window(app: AppHandle, page: Option<String>) {
    show_settings_window(&app);
    if let Some(page) = page {
        let _ = app.emit_to("settings", "settings-page", page);
    }
}
#[tauri::command]
fn installed_coding_tools() -> Vec<String> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let folders: Vec<_> = std::env::split_paths(&path).collect();
    settings::CodingAssistant::ALL
        .iter()
        .filter(|provider| {
            let name = match provider {
                CodingAssistant::Copilot => "copilot",
                CodingAssistant::Muse => "muse",
                other => other.id(),
            };
            folders.iter().any(|folder| {
                ["exe", "cmd", "bat"]
                    .iter()
                    .any(|ext| folder.join(format!("{name}.{ext}")).is_file())
            })
        })
        .map(|provider| provider.id().into())
        .collect()
}

#[tauri::command]
fn capture_return_target(pid: u32) -> Option<workflow_native::ReturnTarget> {
    workflow_native::capture(pid)
}
#[tauri::command]
fn return_to_work(
    target: Option<workflow_native::ReturnTarget>,
    path: Option<String>,
    provider: Option<CodingAssistant>,
) -> &'static str {
    if target.as_ref().is_some_and(workflow_native::activate) {
        return "window";
    }
    let has_project = path.is_some();
    if open_in_editor(
        path,
        if provider == Some(CodingAssistant::Cursor) {
            "cursor"
        } else {
            "code"
        },
    ) {
        if has_project {
            "project"
        } else {
            "tool"
        }
    } else {
        "unavailable"
    }
}
#[tauri::command]
fn workflow_shortcut_status() -> workflow_native::ShortcutStatus {
    workflow_native::status()
}
#[tauri::command]
fn voice_shortcut_status() -> workflow_native::ShortcutStatus {
    workflow_native::voice_status()
}
#[tauri::command]
fn set_voice_active(app: AppHandle, active: bool, restore_focus: Option<bool>) {
    workflow_native::voice_active(active);
    if !active && restore_focus == Some(true) {
        workflow_native::restore_voice_focus(&app);
    }
}
#[tauri::command]
async fn configure_voice_shortcut(
    app: AppHandle,
    shortcut: String,
) -> Result<workflow_native::ShortcutStatus, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result =
            island::window(&handle).map(|win| workflow_native::configure_voice(&win, &shortcut));
        let _ = send.send(result);
    })
    .map_err(|error| error.to_string())?;
    receive
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Kumo window is unavailable.".into())
}
#[tauri::command]
async fn configure_workflow_shortcut(
    app: AppHandle,
    shortcut: String,
) -> Result<workflow_native::ShortcutStatus, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = island::window(&handle).map(|win| workflow_native::configure(&win, &shortcut));
        let _ = send.send(result);
    })
    .map_err(|e| e.to_string())?;
    receive
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Kumo window is unavailable.".into())
}

pub fn run() {
    if migration::migrate_user_data().is_err() {
        eprintln!("[mimo] some previous user data could not be copied; originals were preserved");
    }
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());
    *gate.desktop.lock().unwrap() = loaded.desktop_companion.clone();

    tauri::Builder::default()
        .on_menu_event(|app, event| {
            tray::quick_action(app, event.id.as_ref());
        })
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
        }))
        // The previous startup entry is migrated after the new plugin is ready.
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Mimo")
                .build(),
        )
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Pending::default())
        .manage(grab::Grab::default())
        .manage(Chat::default())
        .manage(chat_requests::ChatRequests::default())
        .manage(voice_chat::VoiceChat::default())
        .manage(openai::OpenAiChat::default())
        .manage(chat_api::ApiChat::default())
        .manage(codex_usage::UsageCache::default())
        .manage(claude_usage::UsageCache::default())
        .invoke_handler(tauri::generate_handler![
            codex_usage,
            claude_usage,
            set_audio_meter_active,
            boot,
            get_media_state,
            media_control,
            get_audio_state,
            audio_control,
            save_settings,
            set_island_visibility,
            set_island_rect,
            focus_window,
            reposition,
            begin_island_move,
            move_island_anchor,
            finish_island_move,
            cancel_island_move,
            show_mimo_menu,
            open_url,
            open_media_source,
            call_state,
            call_set_muted,
            call_focus,
            tools_apps,
            tools_launch,
            tools_docker,
            tools_docker_action,
            tools_ollama,
            tools_ollama_unload,
            tools_vaults,
            tools_quick_note,
            tools_open_inbox,
            open_in_vscode,
            quit_app,
            hooks_status,
            hooks_preview,
            hooks_apply,
            approval_decision,
            question_answer,
            approval_ack,
            approval_decline,
            log_line,
            chat_send,
            chat_connections,
            chat_select,
            chat_reset,
            chat_cancel,
            voice_chat::voice_ready,
            voice_chat::voice_transcribe,
            voice_chat::voice_speak,
            voice_chat::voice_cancel,
            ingest_file,
            secret_present,
            secret_set,
            secret_clear,
            refresh_integration,
            open_n8n,
            open_n8n_page,
            open_settings_window,
            capture_return_target,
            return_to_work,
            workflow_shortcut_status,
            voice_shortcut_status,
            configure_voice_shortcut,
            set_voice_active,
            configure_workflow_shortcut,
            installed_coding_tools,
            set_paused,
            grab::grab_read,
            grab::grab_action,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            migration::migrate_autostart(&handle, loaded.autostart);
            tray::build(&handle)?;
            app.manage(MediaRuntime::start(handle.clone()));
            // Before the island: see create_settings_window.
            create_settings_window(&handle);

            if let Some(win) = island::window(&handle) {
                island::apply_geometry(&handle, &loaded.screen, loaded.startup_visibility());
                let screen_handle = handle.clone();
                win.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::ScaleFactorChanged { .. }) {
                        let _ = screen_handle.emit_to(island::WINDOW_LABEL, "screen-changed", ());
                    }
                });
                let _ = win.show();
                windows::make_non_activating(&win);
                windows::topmost::observe(&win);
                windows::power::observe(&win);
                workflow_native::observe(&win, &loaded.workflow_shortcut);
                windows::file_drop::watch(&handle);
            }
            *gate.visibility.lock().unwrap() = loaded.startup_visibility();
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!(
                "--- Kumo {} started ---",
                env!("CARGO_PKG_VERSION")
            ));
            if hooks::ensure_hook_exe(&handle) {
                for migration in [
                    hooks::migrate_legacy_installation(),
                    codex_hooks::migrate_legacy_installation(),
                ] {
                    if migration.is_err() {
                        log::line("hook migration left the original configuration intact");
                    }
                }
                coding_hooks::migrate_legacy_installations();
            } else {
                log::line(
                    "current Kumo relay could not be verified; existing assistant hooks were kept",
                );
            }
            pipe::start(handle.clone());
            integrations::start(handle.clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Kumo")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                windows::file_drop::stop(app);
                if let Some(media) = app.try_state::<MediaRuntime>() {
                    media.shutdown();
                }
            }
        });
}
