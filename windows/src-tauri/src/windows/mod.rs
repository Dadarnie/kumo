// SPDX-License-Identifier: MIT
// Windows: Win32 for the island window and the cursor, %APPDATA% for files.

pub(crate) mod audio_devices;
pub(crate) mod audio_sessions;
pub(crate) mod call;
pub(crate) mod file_drop;
pub(crate) mod media;
pub(crate) mod power;
pub(crate) mod surface;
pub(crate) mod topmost;

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

use tauri::{AppHandle, WebviewWindow};

use ::windows::core::PWSTR;
use ::windows::Win32::Foundation::{
    CloseHandle, LocalFree, HANDLE, HLOCAL, HWND, LPARAM, LRESULT, POINT, WPARAM,
};
use ::windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use ::windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use ::windows::Win32::System::SystemInformation::GetLocalTime;
use ::windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use ::windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use ::windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use ::windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, GWL_STYLE,
    STYLESTRUCT, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
    SWP_NOZORDER, WM_ERASEBKGND, WM_NCACTIVATE, WM_NCDESTROY, WM_NCPAINT, WM_STYLECHANGING,
    WS_EX_CLIENTEDGE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_WINDOWEDGE, WS_OVERLAPPEDWINDOW,
};

/// File name of the Claude Code relay.
pub const HOOK_EXE: &str = "mimo-hook.exe";

/// Environment variable holding the home directory.
pub const HOME_VAR: &str = "USERPROFILE";

/// Keeps spawned helpers from flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Files ─────────────────────────────────────────────────────────────────────

/// %APPDATA%\Mimo — preferences.
pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Mimo")
}

/// %LOCALAPPDATA%\Mimo — where mimo-hook.exe, the inbox and the log live.
pub fn local_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Mimo")
}

/// %APPDATA% and %LOCALAPPDATA% are already private to the user.
pub fn ensure_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

pub fn local_time() -> LocalTime {
    let t = unsafe { GetLocalTime() };
    LocalTime {
        year: t.wYear.into(),
        month: t.wMonth.into(),
        day: t.wDay.into(),
        hour: t.wHour.into(),
        minute: t.wMinute.into(),
        second: t.wSecond.into(),
    }
}

// ── Processes ─────────────────────────────────────────────────────────────────

/// Spawned helpers must never flash a console window.
pub fn no_console(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}

pub fn open_url(url: &str) {
    let _ =
        no_console(Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url])).spawn();
}

pub fn reveal_folder(path: &str) {
    let _ = Command::new("explorer").arg(path).spawn();
}

/// Our own `where`: walks %PATH% against %PATHEXT%, no shell involved.
/// Rust quotes arguments correctly for `.cmd`/`.bat` targets since 1.77, so
/// spawning `code.cmd` directly is safe.
pub fn find_on_path(stem: &str) -> Option<PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let dirs = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&dirs) {
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let candidate = dir.join(format!("{stem}{}", ext.to_lowercase()));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

// ── Who we are ────────────────────────────────────────────────────────────────
//
// Named pipes share one machine-wide namespace, so the SID in the name is what
// keeps two accounts on the same machine from ever meeting on `mimo-*`.
// mimo-hook computes the same string (hook/src/win.rs) and additionally checks
// that the process serving the pipe really is us.

/// The SID of the account this process runs as, as `S-1-5-21-…`.
pub fn current_user_sid() -> Option<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;

        // First call sizes the buffer, second fills it.
        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        if needed == 0 {
            let _ = CloseHandle(token);
            return None;
        }
        let mut buf = vec![0u8; needed as usize];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr().cast()),
            needed,
            &mut needed,
        )
        .is_ok();
        let _ = CloseHandle(token);
        if !ok {
            return None;
        }

        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text).ok()?;
        let sid = text.to_string().ok();
        let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
        sid
    }
}

// ── Cursor ────────────────────────────────────────────────────────────────────

/// Cursor position in physical screen pixels.
pub fn cursor_physical() -> Option<(f64, f64)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x as f64, p.y as f64))
}

/// True while the left mouse button is held — the only signal we get that a
/// drag might be in flight before it reaches the window.
pub fn left_button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

// ── Island window ─────────────────────────────────────────────────────────────

fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
    let raw = win.hwnd().ok()?.0 as isize;
    if raw == 0 {
        return None;
    }
    Some(HWND(raw as *mut _))
}

/// Refresh after WebView2 adds or replaces its native child windows.
pub fn unblock_webview_drops(app: &AppHandle) {
    file_drop::refresh(app);
}

/// WS_EX_NOACTIVATE keeps clicks from stealing focus; WS_EX_TOOLWINDOW keeps the
/// island out of Alt-Tab.
pub fn make_non_activating(win: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(win) else { return };
    // Install on the GUI thread before any subsequent framework style refresh.
    // Removing a caption after it paints still leaves a white frame on screen.
    if !unsafe { SetWindowSubclass(hwnd, Some(island_frame_proc), ISLAND_FRAME_SUBCLASS, 0) }
        .as_bool()
    {
        crate::log::line("island frame guard could not be installed");
    }
    remove_native_frame(hwnd);
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

const ISLAND_FRAME_SUBCLASS: usize = 0x4d49_4d4f;

unsafe extern "system" fn island_frame_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    _data: usize,
) -> LRESULT {
    match message {
        WM_STYLECHANGING => {
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            if let Some(styles) = unsafe { (lparam.0 as *mut STYLESTRUCT).as_mut() } {
                if wparam.0 as i32 == GWL_STYLE.0 {
                    styles.styleNew &= !WS_OVERLAPPEDWINDOW.0;
                } else if wparam.0 as i32 == GWL_EXSTYLE.0 {
                    styles.styleNew &= !(WS_EX_WINDOWEDGE.0 | WS_EX_CLIENTEDGE.0);
                }
            }
            result
        }
        WM_NCPAINT => LRESULT(0),
        // WebView2 owns the transparent pixels. Native background erasure can
        // flash an opaque rectangle during clipping or focus changes.
        WM_ERASEBKGND => LRESULT(1),
        // Keep Tao's focus bookkeeping while suppressing the native caption
        // repaint when focus passes between the island and Settings.
        WM_NCACTIVATE => unsafe { DefSubclassProc(hwnd, message, wparam, LPARAM(-1)) },
        WM_NCDESTROY => {
            let _ = unsafe { RemoveWindowSubclass(hwnd, Some(island_frame_proc), id) };
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }
        _ => unsafe { DefSubclassProc(hwnd, message, wparam, lparam) },
    }
}

/// Tao keeps caption styles on undecorated windows and only hides their layout.
/// DWM can still repaint that caption on activation or when the region expands.
/// The island has no native frame; remove those styles without changing input,
/// transparency or z-order. Settings retains its normal window decorations.
pub(super) fn remove_native_frame(hwnd: HWND) -> bool {
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want_style = style & !(WS_OVERLAPPEDWINDOW.0 as isize);
        let want_ex = ex & !((WS_EX_WINDOWEDGE.0 | WS_EX_CLIENTEDGE.0) as isize);
        if style == want_style && ex == want_ex {
            return false;
        }
        SetWindowLongPtrW(hwnd, GWL_STYLE, want_style);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want_ex);
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED
                | SWP_NOACTIVATE
                | SWP_NOOWNERZORDER
                | SWP_NOZORDER
                | SWP_NOMOVE
                | SWP_NOSIZE,
        );
        true
    }
}

/// Temporarily allow activation so a text field inside the island can be typed in.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = if activating {
            ex & !(WS_EX_NOACTIVATE.0 as isize)
        } else {
            ex | WS_EX_NOACTIVATE.0 as isize
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// Called on the GUI thread. Preserve the island's non-activating flags rather
/// than asking Tao to rewrite every style and show the window again on hover.
pub fn set_click_through(win: &WebviewWindow, ignore: bool) -> bool {
    let Some(hwnd) = hwnd_of(win) else {
        return false;
    };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let layered = windows::Win32::UI::WindowsAndMessaging::WS_EX_LAYERED.0 as isize;
        let transparent = windows::Win32::UI::WindowsAndMessaging::WS_EX_TRANSPARENT.0 as isize;
        // Keep the DWM alpha surface alive when the pointer crosses the shell.
        // Removing WS_EX_LAYERED on every entry destroys its transparent frame.
        let want = if ignore {
            ex | layered | transparent
        } else {
            (ex | layered) & !transparent
        };
        let alpha_changed = ex & layered == 0;
        if ex != want {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
        }
        alpha_changed
    }
}

/// Wall-clock time in the user's time zone, for log lines and backup names.
pub struct LocalTime {
    pub year: u32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

/// The user's home directory, where `.claude/settings.json` lives.
pub fn home_dir() -> PathBuf {
    std::env::var_os(HOME_VAR)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
