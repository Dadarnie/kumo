// SPDX-License-Identifier: MIT
// Island window: display placement, three visibility bounds, click-through
// and a cursor poll which parks while the working lip is minimized.
//
// There is no notch on a PC, so the island is a black shape drawn at the top
// centre of the main display inside a borderless, transparent, always-on-top
// window that never takes focus.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::settings::{DesktopCompanionPosition, IslandVisibility};
use crate::windows::{self, cursor_physical, left_button_down};

/// Logical size of the full window — the largest island view, like the macOS panel.
pub const PANEL_W: f64 = 1080.0;
pub const PANEL_H: f64 = 680.0;
pub const ISLAND_W: f64 = 320.0;
pub const ISLAND_H: f64 = 56.0;
pub const PEEK_W: f64 = 156.0;
pub const PEEK_H: f64 = 18.0;

pub const WINDOW_LABEL: &str = "island";

/// Margin around the island that still counts as "on the island", in logical px.
/// Wider than the macOS 6 pt because a click must never be swallowed.
const HIT_MARGIN: f64 = 14.0;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CursorPayload {
    pub x: f64,
    pub y: f64,
    pub screen_x: f64,
    pub screen_y: f64,
    pub window_width: f64,
    pub control: bool,
    pub down: bool,
}

#[derive(Serialize, Clone)]
pub struct ScreenInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PositionInfo {
    pub anchor_x: f64,
    pub ratio: Option<f64>,
    pub anchor_y: f64,
    pub desktop_companion: Option<DesktopCompanionPosition>,
    pub dock_ready: bool,
    pub drag_moved: bool,
    pub pickup_held: bool,
    pub pickup_offset_x: f64,
    pub pickup_offset_y: f64,
    pub dock_target_x: f64,
    pub dock_target_y: f64,
}

/// The island shape in window-logical coordinates, pushed by the front end.
/// The poll thread owns the click-through decision so it lands in the same 16 ms
/// tick as the cursor read — an IPC round trip here loses clicks.
#[derive(Clone, Copy, Default)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub radius: f64,
}

/// Wakes / parks the cursor poll thread so a hidden island costs literally nothing.
pub struct PollGate {
    active: Mutex<bool>,
    cv: Condvar,
    pub visibility: Mutex<IslandVisibility>,
    pub rect: Mutex<IslandRect>,
    pub anchor: Mutex<Option<f64>>,
    pub desktop: Mutex<Option<DesktopCompanionPosition>>,
    pub(crate) surface: windows::surface::NativeSurface,
    /// Mirrors the window flag so we only call into the OS when it changes.
    ignoring: AtomicBool,
}

impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(false),
            cv: Condvar::new(),
            visibility: Mutex::new(IslandVisibility::Island),
            rect: Mutex::new(IslandRect::default()),
            anchor: Mutex::new(None),
            desktop: Mutex::new(None),
            surface: windows::surface::NativeSurface::new(),
            ignoring: AtomicBool::new(false),
        }
    }

    pub fn set_rect(&self, rect: IslandRect) {
        *self.rect.lock().unwrap() = rect;
    }

    /// Forces the next poll tick to re-apply the flag (after a window resize).
    pub fn forget_ignore_state(&self) {
        self.ignoring.store(false, Ordering::Relaxed);
    }

    pub fn set_active(&self, on: bool) {
        let mut guard = self.active.lock().unwrap();
        *guard = on;
        self.cv.notify_all();
    }

    fn wait_until_active(&self) {
        let mut guard = self.active.lock().unwrap();
        while !*guard {
            guard = self.cv.wait(guard).unwrap();
        }
    }

    fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64
        && x < (p.x + s.width as i32) as f64
        && y >= p.y as f64
        && y < (p.y + s.height as i32) as f64
}

/// The display the island lives on: the primary one, or the one under the cursor.
fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    if pref == "cursor" {
        if let Some((cx, cy)) = cursor_physical() {
            if let Some(m) = monitors.iter().find(|m| monitor_contains(m, cx, cy)) {
                return Some(m.clone());
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
}

pub fn screen_info(app: &AppHandle, pref: &str) -> ScreenInfo {
    match target_monitor(app, pref) {
        Some(m) => {
            let scale = m.scale_factor();
            let p = m.position();
            let s = m.size();
            ScreenInfo {
                x: p.x as f64 / scale,
                y: p.y as f64 / scale,
                width: s.width as f64 / scale,
                height: s.height as f64 / scale,
                scale,
            }
        }
        None => ScreenInfo {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
            scale: 1.0,
        },
    }
}

pub fn logical_size(visibility: IslandVisibility) -> (f64, f64) {
    match visibility {
        IslandVisibility::Expanded => (PANEL_W, PANEL_H),
        IslandVisibility::Island => (ISLAND_W, ISLAND_H),
        IslandVisibility::Peek => (PEEK_W, PEEK_H),
    }
}

fn physical_bounds(
    _visibility: IslandVisibility,
    monitor: (i32, i32, u32),
    scale: f64,
) -> (i32, i32, u32, u32) {
    // WebView2 keeps one backing surface through every hover state. The native
    // window region supplies the tight compact/peek envelopes instead of resize.
    let pw = (PANEL_W * scale).round().max(1.0) as u32;
    let ph = (PANEL_H * scale).round().max(1.0) as u32;
    (
        monitor.0 + (monitor.2 as i32 - pw as i32) / 2,
        monitor.1,
        pw,
        ph,
    )
}

pub fn position_info(_app: &AppHandle, _pref: &str) -> PositionInfo {
    PositionInfo {
        anchor_x: PANEL_W / 2.0,
        ratio: None,
        anchor_y: 0.0,
        desktop_companion: None,
        dock_ready: false,
        drag_moved: false,
        pickup_held: false,
        pickup_offset_x: 0.0,
        pickup_offset_y: 0.0,
        dock_target_x: PANEL_W / 2.0,
        dock_target_y: 0.0,
    }
}

// Keep old IPC move commands callable without restoring detached/sleeping mode.
pub fn begin_move(_app: &AppHandle, _offset_x: f64, _offset_y: f64) {}
pub fn move_anchor(_app: &AppHandle) {}
pub fn cancel_move(_app: &AppHandle) {}
pub fn finish_move(app: &AppHandle) {
    let Some(shared) = app.try_state::<crate::Shared>() else {
        return;
    };
    *shared.gate.desktop.lock().unwrap() = None;
    *shared.gate.anchor.lock().unwrap() = None;
    let settings = {
        let mut settings = shared.settings.lock().unwrap();
        settings.island_anchor = None;
        settings.desktop_companion = None;
        settings.clone()
    };
    if let Err(error) = crate::settings::save(&settings) {
        crate::log::line(format!("Island position: {error}"));
    }
    apply_geometry(
        app,
        &settings.screen,
        *shared.gate.visibility.lock().unwrap(),
    );
    let _ = app.emit("settings-changed", settings);
}

/// Keep one rendering surface, anchored to the display's physical top edge.
pub fn apply_geometry(app: &AppHandle, pref: &str, visibility: IslandVisibility) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, pref) else {
        return;
    };

    let scale = m.scale_factor();
    let mp = *m.position();
    let ms = *m.size();

    let (x, y, pw, ph) = physical_bounds(visibility, (mp.x, mp.y, ms.width), scale);

    if win.inner_size().ok() != Some(PhysicalSize::new(pw, ph)) {
        let _ = win.set_size(PhysicalSize::new(pw, ph));
    }
    if win.outer_position().ok() != Some(PhysicalPosition::new(x, y)) {
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    // Moving across displays can rescale the window: re-assert the physical size.
    if win.inner_size().ok() != Some(PhysicalSize::new(pw, ph)) {
        let _ = win.set_size(PhysicalSize::new(pw, ph));
    }
    if !win.is_always_on_top().unwrap_or(false) {
        let _ = win.set_always_on_top(true);
    }
    if let Some(shared) = app.try_state::<crate::Shared>() {
        refresh_surface(app, &shared.gate);
    }
    let _ = app.emit_to(WINDOW_LABEL, "island-position", position_info(app, pref));
}

/// Coalesce shape changes onto the GUI thread; no queued stale clipping frames.
pub fn refresh_surface(app: &AppHandle, gate: &Arc<PollGate>) {
    if gate.surface.queued.swap(true, Ordering::AcqRel) {
        return;
    }
    let handle = app.clone();
    let gate = gate.clone();
    let pending = gate.clone();
    if app
        .run_on_main_thread(move || {
            gate.surface.queued.store(false, Ordering::Release);
            let Some(win) = window(&handle) else { return };
            let rect = *gate.rect.lock().unwrap();
            let visibility = *gate.visibility.lock().unwrap();
            gate.surface.update(&win, visibility, rect);
        })
        .is_err()
    {
        pending.surface.queued.store(false, Ordering::Release);
    }
}

/// Position, size and scale of the monitor the island lives on. Any change here
/// means the island has to be placed again.
fn current_screen_key(app: &AppHandle) -> Option<(i32, i32, u32, u32, u64)> {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let p = m.position();
    let size = m.size();
    Some((
        p.x,
        p.y,
        size.width,
        size.height,
        m.scale_factor().to_bits(),
    ))
}

/// Emits `cursor` (window-logical coordinates) at ~60 Hz while the island is
/// visible. Parked on a condvar the rest of the time.
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        let mut was_down = false;
        // Remembered across wakes so a display change while hidden is noticed the
        // moment the island comes back.
        let mut last_screen: Option<(i32, i32, u32, u32, u64)> = None;
        loop {
            gate.wait_until_active();
            let mut last = (f64::MIN, f64::MIN);
            let mut last_control = false;
            let mut last_raw = (
                f64::NAN,
                f64::NAN,
                false,
                false,
                0.0,
                0.0,
                0.0,
                0.0,
                u8::MAX,
            );
            let mut ticks: u32 = 0;
            while gate.is_active() {
                std::thread::sleep(Duration::from_millis(16));

                // Monitors get plugged in, unplugged, rearranged and rescaled, and
                // an island pinned to coordinates that no longer exist is an island
                // nobody can reach. Checked about twice a second — the cursor poll
                // is already running, so this costs one monitor query.
                ticks = ticks.wrapping_add(1);
                if ticks % 30 == 0 {
                    let now = current_screen_key(&app);
                    if now.is_some() && now != last_screen {
                        let first = last_screen.is_none();
                        last_screen = now;
                        if !first {
                            crate::log::line("display layout changed — repositioning".to_string());
                            let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
                        }
                    }
                }

                // Cheap reads first: a still mouse with unchanged buttons costs
                // three Win32 calls per tick and nothing else.
                let Some((cx, cy)) = cursor_physical() else {
                    continue;
                };
                let down = left_button_down();
                let control = unsafe {
                    ::windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(0x11)
                } < 0;
                // The island shape and state count too: it can resize under a still cursor.
                let shape = *gate.rect.lock().unwrap();
                let state = *gate.visibility.lock().unwrap();
                let raw = (
                    cx,
                    cy,
                    down,
                    control,
                    shape.x,
                    shape.y,
                    shape.w,
                    shape.h,
                    state as u8,
                );
                if raw == last_raw {
                    continue;
                }
                last_raw = raw;
                let Some(win) = window(&app) else { continue };
                let Ok(origin) = win.outer_position() else {
                    continue;
                };
                let scale = win.scale_factor().unwrap_or(1.0);
                crate::grab::track_drag(
                    &app,
                    cx,
                    cy,
                    down,
                    (cx - (last.0 * scale + origin.x as f64)).abs() >= 1.0
                        || (cy - (last.1 * scale + origin.y as f64)).abs() >= 1.0,
                );
                if down && !was_down {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || windows::unblock_webview_drops(&handle));
                }
                if !down && was_down {
                    windows::file_drop::set_active(&app, false);
                }
                was_down = down;
                let x = (cx - origin.x as f64) / scale;
                let y = (cy - origin.y as f64) / scale;
                let size = match win.inner_size() {
                    Ok(s) => (s.width as f64 / scale, s.height as f64 / scale),
                    Err(_) => (PANEL_W, PANEL_H),
                };
                if (x - last.0).abs() < 1.0 && (y - last.1).abs() < 1.0 && control == last_control {
                    continue;
                }
                last = (x, y);
                last_control = control;

                // Click-through: the window only takes the mouse over the island
                // shape. A small entry margin means the flag is already off by the
                // time a moving cursor reaches a button.
                let r = *gate.rect.lock().unwrap();
                let visibility = *gate.visibility.lock().unwrap();
                let on_island = accepts_pointer(visibility, r, x, y);

                // A file being dragged has to be able to find us. WS_EX_TRANSPARENT
                // — what click-through is on Windows — hides the window from
                // WindowFromPoint, so OLE finds no drop target and shows the "no
                // drop" cursor. macOS has no such problem: AppKit delivers drags to
                // registered destinations whatever ignoresMouseEvents says. So while
                // a button is held anywhere over the panel, the whole panel takes
                // the mouse, which also makes the drop zone as forgiving as the Mac's.
                // A press may be the start of a drag: make sure the drop target is
                // ours before the file arrives.
                let dragging = visibility != IslandVisibility::Peek
                    && down
                    && x >= 0.0
                    && x <= size.0
                    && y >= 0.0
                    && y <= size.1;

                let accept = on_island
                    || dragging
                    || app
                        .state::<crate::grab::Grab>()
                        .detached
                        .load(Ordering::SeqCst);
                // The native region already excludes every pixel outside the lip.
                // A final poll tick must not leave the whole lip click-through when
                // this thread parks, because no further cursor tick would reopen it.
                let current = gate.visibility.lock().unwrap();
                if *current == IslandVisibility::Peek {
                    // Only on change: the poll keeps running in the lip now.
                    if gate.ignoring.swap(false, Ordering::Relaxed) {
                        set_ignore_cursor(&app, false);
                    }
                } else if gate.ignoring.load(Ordering::Relaxed) == accept {
                    gate.ignoring.store(!accept, Ordering::Relaxed);
                    set_ignore_cursor(&app, !accept);
                }
                drop(current);

                let _ = win.emit(
                    "cursor",
                    CursorPayload {
                        x,
                        y,
                        screen_x: cx,
                        screen_y: cy,
                        window_width: size.0,
                        control,
                        down,
                    },
                );
            }
        }
    });
}

/// Reset the Windows flag; the next cursor-poll tick decides click-through.
pub fn refresh_click_through(app: &AppHandle, gate: &PollGate) {
    set_ignore_cursor(app, false);
    gate.forget_ignore_state();
}

fn accepts_pointer(visibility: IslandVisibility, rect: IslandRect, x: f64, y: f64) -> bool {
    if visibility == IslandVisibility::Peek {
        let left = (PANEL_W - PEEK_W) / 2.0;
        return x >= left && x < left + PEEK_W && y >= 0.0 && y < PEEK_H;
    }
    rect.w > 0.0
        && x >= rect.x - HIT_MARGIN
        && x < rect.x + rect.w + HIT_MARGIN
        && y >= rect.y - HIT_MARGIN
        && y < rect.y + rect.h + HIT_MARGIN
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rendering_surface_stays_top_centered_and_constant_across_visibility_and_scale() {
        assert_eq!(logical_size(IslandVisibility::Expanded), (1080.0, 680.0));
        assert_eq!(logical_size(IslandVisibility::Island), (320.0, 56.0));
        assert_eq!(logical_size(IslandVisibility::Peek), (156.0, 18.0));
        for visibility in [
            IslandVisibility::Expanded,
            IslandVisibility::Island,
            IslandVisibility::Peek,
        ] {
            for scale in [1.0, 1.25, 1.5, 2.0] {
                let (x, y, w, h) = physical_bounds(visibility, (-2560, -300, 2560), scale);
                assert!((x as f64 + w as f64 / 2.0 + 1280.0).abs() <= 0.5);
                assert_eq!(y, -300);
                assert_eq!(w, (PANEL_W * scale).round() as u32);
                assert_eq!(h, (PANEL_H * scale).round() as u32);
            }
        }
    }
    #[test]
    fn minimized_lip_excludes_browser_tabs_shadow_and_old_expanded_rectangle() {
        let stale = IslandRect {
            x: 220.0,
            y: 0.0,
            w: 640.0,
            h: 240.0,
            radius: 26.0,
        };
        assert!(accepts_pointer(IslandVisibility::Peek, stale, 540.0, 6.0));
        for (x, y) in [
            (540.0, 22.0),
            (540.0, 30.0),
            (540.0, 42.0),
            (430.0, 6.0),
            (620.0, 6.0),
            (780.0, 100.0),
        ] {
            assert!(
                !accepts_pointer(IslandVisibility::Peek, stale, x, y),
                "browser or shadow point {x},{y}"
            );
        }
    }
}

pub fn set_ignore_cursor(app: &AppHandle, ignore: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = window(&handle) {
            let alpha_changed = windows::set_click_through(&win, ignore);
            let shared = handle.state::<crate::Shared>();
            if alpha_changed {
                shared.gate.surface.invalidate_window_style();
                refresh_surface(&handle, &shared.gate);
            }
        }
    });
}
