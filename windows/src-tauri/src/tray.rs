// SPDX-License-Identifier: MIT
// Notification-area icon: Open, Settings, Pause, Quit.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

use crate::island::WINDOW_LABEL;

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Mimo", true, None::<&str>)?;
    let dock = MenuItem::with_id(app, "quick-dock", "Return to top", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&open, &dock, &sep1, &settings, &pause, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id("mimo")
        .tooltip("Mimo")
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            id => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", id.to_string());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// OS popup menus remain clickable outside the minimized working lip.
pub fn popup(app: &AppHandle) -> tauri::Result<()> {
    let settings = app
        .state::<crate::Shared>()
        .settings
        .lock()
        .unwrap()
        .clone();
    let dock = MenuItem::with_id(app, "quick-dock", "Return to top", true, None::<&str>)?;
    let working = CheckMenuItem::with_id(
        app,
        "quick-working",
        "Working mode",
        true,
        settings.working_mode_enabled,
        None::<&str>,
    )?;
    let sound = CheckMenuItem::with_id(
        app,
        "quick-sound",
        "Sound",
        true,
        settings.sound_enabled,
        None::<&str>,
    )?;
    let usage = CheckMenuItem::with_id(
        app,
        "quick-usage",
        "Limits",
        true,
        settings.usage_enabled,
        None::<&str>,
    )?;
    let clock = CheckMenuItem::with_id(
        app,
        "quick-clock",
        "Island clock",
        true,
        settings.clock_enabled,
        None::<&str>,
    )?;
    let settings_item = MenuItem::with_id(app, "quick-settings", "Settings…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &dock,
            &separator,
            &working,
            &sound,
            &usage,
            &clock,
            &settings_item,
        ],
    )?;
    if let Some(win) = crate::island::window(app) {
        win.popup_menu(&menu)?;
    }
    Ok(())
}

pub fn quick_action(app: &AppHandle, id: &str) {
    if id == "quick-dock" {
        crate::island::finish_move(app, true);
        let _ = app.emit_to(WINDOW_LABEL, "tray", "dock".to_string());
        return;
    }
    if id == "quick-settings" {
        crate::show_settings_window(app);
        return;
    }
    let shared = app.state::<crate::Shared>();
    let settings = {
        let mut current = shared.settings.lock().unwrap();
        match id {
            "quick-working" => current.working_mode_enabled = !current.working_mode_enabled,
            "quick-sound" => current.sound_enabled = !current.sound_enabled,
            "quick-usage" => current.usage_enabled = !current.usage_enabled,
            "quick-clock" => current.clock_enabled = !current.clock_enabled,
            _ => return,
        }
        current.clone()
    };
    if let Err(error) = crate::settings::save(&settings) {
        crate::log::line(format!("Quick setting: {error}"));
    }
    let _ = app.emit("settings-changed", settings);
}
