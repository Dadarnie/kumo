// SPDX-License-Identifier: MIT
//! Explicit keyboard access and verified editor window returns. No polling.
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, AtomicIsize, AtomicU8, Ordering},
    Mutex, OnceLock,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, FILETIME, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT,
    MOD_SHIFT,
};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, EnumWindows, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
    PostMessageW, SetForegroundWindow, SetWindowsHookExW, ShowWindow, UnhookWindowsHookEx, HHOOK,
    KBDLLHOOKSTRUCT, SW_RESTORE, WH_KEYBOARD_LL, WM_APP, WM_HOTKEY, WM_KEYDOWN, WM_KEYUP,
    WM_NCDESTROY, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

const SUBCLASS: usize = 0x4d49_5746;
const HOTKEY: i32 = 0x4d49;
const VOICE_HOTKEY: i32 = 0x4d4b;
const GRAB_CONTROL: u32 = WM_APP + 0x44;
const GRAB_CANCEL: u32 = WM_APP + 0x45;
static CAPTURE_ACTIVE: AtomicBool = AtomicBool::new(false);
pub(crate) fn capture_active(active: bool) {
    CAPTURE_ACTIVE.store(active, Ordering::SeqCst);
}
static CONTROL_TARGET: AtomicIsize = AtomicIsize::new(0);
static CONTROL_MASK: AtomicU8 = AtomicU8::new(0);
struct Shortcuts {
    app: AppHandle,
    control_hook: Option<HHOOK>,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShortcutStatus {
    pub shortcut: String,
    pub registered: bool,
    pub error: Option<String>,
}
static STATUS: OnceLock<Mutex<ShortcutStatus>> = OnceLock::new();
static VOICE_STATUS: OnceLock<Mutex<ShortcutStatus>> = OnceLock::new();
pub(crate) fn voice_status() -> ShortcutStatus {
    VOICE_STATUS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .clone()
}
pub(crate) fn configure_voice(win: &WebviewWindow, value: &str) -> ShortcutStatus {
    if let Err(error) = parse_shortcut(value) {
        return ShortcutStatus {
            error: Some(error),
            ..voice_status()
        };
    }
    if value.is_empty() {
        return configure_slot(win, "", VOICE_HOTKEY, &VOICE_STATUS);
    }
    let preferences = win
        .app_handle()
        .state::<crate::Shared>()
        .settings
        .lock()
        .unwrap()
        .clone();
    let connected = preferences.assistant_enabled;
    let mut status = configure_slot(
        win,
        if connected { value } else { "" },
        VOICE_HOTKEY,
        &VOICE_STATUS,
    );
    if !connected {
        status.shortcut = value.into();
        status.error = Some("Turn on the assistant in Settings to use this shortcut.".into());
    }
    *VOICE_STATUS.get_or_init(Default::default).lock().unwrap() = status.clone();
    status
}
pub(crate) fn refresh_voice(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = crate::island::window(&handle) {
            let shortcut = handle
                .state::<crate::Shared>()
                .settings
                .lock()
                .unwrap()
                .voice_shortcut
                .clone();
            let result = configure_voice(&win, &shortcut);
            let _ = handle.emit("voice-shortcut-status", result);
        }
    });
}
pub(crate) fn status() -> ShortcutStatus {
    STATUS.get_or_init(Default::default).lock().unwrap().clone()
}

fn parse_shortcut(value: &str) -> Result<Option<(HOT_KEY_MODIFIERS, u32)>, String> {
    if value.is_empty() {
        return Ok(None);
    }
    let mut modifiers = MOD_NOREPEAT;
    let mut key = None;
    for part in value.split('+') {
        match part {
            "Ctrl" => modifiers |= MOD_CONTROL,
            "Alt" => modifiers |= MOD_ALT,
            "Shift" => modifiers |= MOD_SHIFT,
            "Space" if key.is_none() => key = Some(32),
            p if p.len() == 1 && p.as_bytes()[0].is_ascii_uppercase() && key.is_none() => {
                key = Some(p.as_bytes()[0] as u32)
            }
            _ => return Err("Use Ctrl, Alt or Shift with one letter or Space.".into()),
        }
    }
    if modifiers.0 == MOD_NOREPEAT.0 {
        return Err("Include Ctrl, Alt or Shift.".into());
    }
    key.map(|k| Some((modifiers, k)))
        .ok_or_else(|| "Choose a shortcut key.".into())
}

pub(crate) fn configure(win: &WebviewWindow, value: &str) -> ShortcutStatus {
    configure_slot(win, value, HOTKEY, &STATUS)
}
fn configure_slot(
    win: &WebviewWindow,
    value: &str,
    hotkey: i32,
    slot: &OnceLock<Mutex<ShortcutStatus>>,
) -> ShortcutStatus {
    let mut current = slot.get_or_init(Default::default).lock().unwrap();
    let old = current.clone();
    let parsed = match parse_shortcut(value) {
        Ok(v) => v,
        Err(e) => {
            return ShortcutStatus {
                error: Some(e),
                ..old
            }
        }
    };
    let Ok(raw) = win.hwnd() else {
        return ShortcutStatus {
            error: Some("Kumo window is unavailable.".into()),
            ..old
        };
    };
    let hwnd = HWND(raw.0);
    if old.registered && old.shortcut == value {
        return old;
    }
    if old.registered {
        let _ = unsafe { UnregisterHotKey(Some(hwnd), hotkey) };
    }
    if let Some((mods, key)) = parsed {
        if unsafe { RegisterHotKey(Some(hwnd), hotkey, mods, key) }.is_err() {
            // A conflict must not silently remove a previously working shortcut.
            let mut restored = false;
            if old.registered {
                if let Ok(Some((m, k))) = parse_shortcut(&old.shortcut) {
                    restored = unsafe { RegisterHotKey(Some(hwnd), hotkey, m, k) }.is_ok();
                }
            }
            *current = ShortcutStatus {
                shortcut: if old.registered {
                    old.shortcut
                } else {
                    value.into()
                },
                registered: restored,
                error: Some("That shortcut is already in use. Choose another.".into()),
            };
            return current.clone();
        }
    }
    *current = ShortcutStatus {
        shortcut: value.into(),
        registered: parsed.is_some(),
        error: None,
    };
    current.clone()
}

pub(crate) fn observe(win: &WebviewWindow, value: &str) {
    let Ok(raw) = win.hwnd() else { return };
    let app = Box::into_raw(Box::new(Shortcuts {
        app: win.app_handle().clone(),
        control_hook: None,
    }));
    if !unsafe { SetWindowSubclass(HWND(raw.0), Some(shortcut_proc), SUBCLASS, app as usize) }
        .as_bool()
    {
        drop(unsafe { Box::from_raw(app) });
        return;
    }
    let result = configure(win, value);
    refresh_voice(win.app_handle());
    if let Some(error) = result.error {
        crate::log::line(format!("Workflow shortcut: {error}"));
    }
    CONTROL_TARGET.store(raw.0 as isize, Ordering::SeqCst);
    // Observe only Control transitions. Pass every key through untouched.
    let module = unsafe { windows::Win32::System::LibraryLoader::GetModuleHandleW(None) }
        .ok()
        .map(|h| windows::Win32::Foundation::HINSTANCE(h.0));
    match unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(control_proc), module, 0) } {
        Ok(hook) => unsafe { (*app).control_hook = Some(hook) },
        Err(error) => crate::log::line(format!("Grab Control shortcut unavailable: {error}")),
    }
}
unsafe extern "system" fn control_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let key = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let bit = match key.vkCode {
            0xA2 | 0x11 => 1,
            0xA3 => 2,
            _ => 0,
        };
        let down = [WM_KEYDOWN, WM_SYSKEYDOWN].contains(&(wparam.0 as u32));
        let up = [WM_KEYUP, WM_SYSKEYUP].contains(&(wparam.0 as u32));
        if key.vkCode == 0x1b && down && CAPTURE_ACTIVE.load(Ordering::SeqCst) {
            let target = CONTROL_TARGET.load(Ordering::SeqCst);
            if target != 0 {
                let _ = unsafe {
                    PostMessageW(
                        Some(HWND(target as *mut _)),
                        GRAB_CANCEL,
                        WPARAM(0),
                        LPARAM(0),
                    )
                };
            }
        }
        if bit != 0 && (down || up) {
            let old = if down {
                CONTROL_MASK.fetch_or(bit, Ordering::SeqCst)
            } else {
                CONTROL_MASK.fetch_and(!bit, Ordering::SeqCst)
            };
            let current = CONTROL_MASK.load(Ordering::SeqCst);
            let target = CONTROL_TARGET.load(Ordering::SeqCst);
            if (old != 0) != (current != 0) && target != 0 {
                let _ = unsafe {
                    PostMessageW(
                        Some(HWND(target as *mut _)),
                        GRAB_CONTROL,
                        WPARAM(usize::from(current != 0)),
                        LPARAM(0),
                    )
                };
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn shortcut_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    data: usize,
) -> LRESULT {
    if message == WM_NCDESTROY {
        let _ = unsafe { UnregisterHotKey(Some(hwnd), HOTKEY) };
        let _ = unsafe { UnregisterHotKey(Some(hwnd), VOICE_HOTKEY) };
        CONTROL_TARGET.store(0, Ordering::SeqCst);
        CONTROL_MASK.store(0, Ordering::SeqCst);
        CAPTURE_ACTIVE.store(false, Ordering::SeqCst);
        let context = unsafe { &*(data as *const Shortcuts) };
        if let Some(hook) = context.control_hook {
            let _ = unsafe { UnhookWindowsHookEx(hook) };
        }
        let _ = unsafe { RemoveWindowSubclass(hwnd, Some(shortcut_proc), id) };
        drop(unsafe { Box::from_raw(data as *mut Shortcuts) });
    } else if message == WM_HOTKEY && wparam.0 == VOICE_HOTKEY as usize {
        // The assistant's mic toggle: never take focus from the app the user is in.
        let context = unsafe { &*(data as *const Shortcuts) };
        let _ = context
            .app
            .emit_to(crate::island::WINDOW_LABEL, "voice-shortcut", ());
    } else if message == GRAB_CONTROL {
        let context = unsafe { &*(data as *const Shortcuts) };
        let _ = context
            .app
            .emit_to(crate::island::WINDOW_LABEL, "grab-control", wparam.0 != 0);
    } else if message == GRAB_CANCEL {
        let app = unsafe { &*(data as *const Shortcuts) }.app.clone();
        tauri::async_runtime::spawn_blocking(move || crate::grab::return_to_panel(&app));
    } else if message == WM_HOTKEY && wparam.0 == HOTKEY as usize {
        let app = &unsafe { &*(data as *const Shortcuts) }.app;
        if let Some(win) = crate::island::window(app) {
            crate::windows::set_activating(&win, true);
        }
        let _ = unsafe { SetForegroundWindow(hwnd) };
        let _ = app.emit_to(crate::island::WINDOW_LABEL, "workflow-shortcut", ());
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReturnTarget {
    pub pid: u32,
    pub created_at: String,
    pub hwnd: String,
}
fn process_stamp(pid: u32) -> Option<String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let result = (|| {
        let mut image = [0u16; 1024];
        let mut length = image.len() as u32;
        unsafe {
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(image.as_mut_ptr()),
                &mut length,
            )
        }
        .ok()?;
        let image = String::from_utf16_lossy(&image[..length as usize]).to_lowercase();
        if !editor_process(&image) {
            return None;
        }
        let (mut created, mut exit, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        unsafe { GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) }.ok()?;
        Some((((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64).to_string())
    })();
    let _ = unsafe { CloseHandle(handle) };
    result
}
fn editor_process(image: &str) -> bool {
    let name = image.rsplit(['\\', '/']).next().unwrap_or("");
    [
        "code.exe",
        "code - insiders.exe",
        "vscodium.exe",
        "cursor.exe",
    ]
    .iter()
    .any(|editor| name.eq_ignore_ascii_case(editor))
}
struct WindowsForPid {
    pid: u32,
    windows: Vec<usize>,
}
unsafe extern "system" fn collect_window(hwnd: HWND, data: LPARAM) -> BOOL {
    let found = unsafe { &mut *(data.0 as *mut WindowsForPid) };
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == found.pid && unsafe { IsWindowVisible(hwnd) }.as_bool() {
        found.windows.push(hwnd.0 as usize);
    }
    BOOL(1)
}
pub(crate) fn capture(pid: u32) -> Option<ReturnTarget> {
    let created_at = process_stamp(pid)?;
    let mut found = WindowsForPid {
        pid,
        windows: vec![],
    };
    let _ = unsafe { EnumWindows(Some(collect_window), LPARAM(&mut found as *mut _ as isize)) };
    // Multiple windows cannot identify the originating one without more evidence.
    if found.windows.len() != 1 {
        return None;
    }
    Some(ReturnTarget {
        pid,
        created_at,
        hwnd: found.windows[0].to_string(),
    })
}
pub(crate) fn activate(target: &ReturnTarget) -> bool {
    if process_stamp(target.pid).as_ref() != Some(&target.created_at) {
        return false;
    }
    let Ok(raw) = target.hwnd.parse::<usize>() else {
        return false;
    };
    let hwnd = HWND(raw as *mut _);
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return false;
    }
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid != target.pid {
        return false;
    }
    if unsafe { IsIconic(hwnd) }.as_bool() {
        let _ = unsafe { ShowWindow(hwnd, SW_RESTORE) };
    }
    unsafe { SetForegroundWindow(hwnd) }.as_bool()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shortcuts_require_modifiers_and_one_supported_key() {
        assert!(parse_shortcut("Ctrl+Alt+M").unwrap().is_some());
        assert!(parse_shortcut("").unwrap().is_none());
        for invalid in ["M", "Ctrl", "Ctrl+F12", "Ctrl+M+N", "Win+M"] {
            assert!(parse_shortcut(invalid).is_err());
        }
    }
    #[test]
    fn stale_or_foreign_origin_never_activates() {
        assert!(!activate(&ReturnTarget {
            pid: std::process::id(),
            created_at: "stale".into(),
            hwnd: "0".into()
        }));
    }
    #[test]
    fn cursor_returns_only_to_the_verified_editor_process() {
        assert!(editor_process(r"C:\Apps\Cursor\Cursor.exe"));
        assert!(editor_process(r"C:\Apps\VS Code\Code.exe"));
        assert!(editor_process(r"C:\Apps\VSCodium\VSCodium.exe"));
        for other in [
            r"C:\Apps\not-cursor.exe",
            r"C:\Apps\Cursor.exe.helper",
            "powershell.exe",
        ] {
            assert!(!editor_process(other));
        }
    }
}
