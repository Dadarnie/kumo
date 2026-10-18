// SPDX-License-Identifier: MIT
//! Keep the island above other applications without activating it or polling.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use tauri::WebviewWindow;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, IsIconic, IsWindowVisible, PostMessageW, SetWindowPos,
    EVENT_SYSTEM_DESKTOPSWITCH, EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND, GWL_EXSTYLE,
    HWND_TOPMOST, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
    SWP_NOZORDER, WINDOWPOS, WINEVENT_OUTOFCONTEXT, WM_APP, WM_NCDESTROY, WM_SHOWWINDOW,
    WM_WINDOWPOSCHANGED, WM_WINDOWPOSCHANGING, WS_EX_TOPMOST,
};

const SUBCLASS: usize = 0x4d49_544f;
const REFRESH: u32 = WM_APP + 0x54;
static ISLAND: AtomicIsize = AtomicIsize::new(0);
static QUEUED: AtomicBool = AtomicBool::new(false);

struct Observer {
    hook: HWINEVENTHOOK,
}

impl Drop for Observer {
    fn drop(&mut self) {
        if !self.hook.0.is_null() {
            let _ = unsafe { UnhookWinEvent(self.hook) };
        }
    }
}

/// The GUI thread owns the hook and subclass until this island is destroyed.
pub(crate) fn observe(win: &WebviewWindow) {
    let Some(hwnd) = super::hwnd_of(win) else {
        return;
    };
    let observer = Box::new(Observer {
        hook: unsafe {
            SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_DESKTOPSWITCH,
                None,
                Some(desktop_event),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            )
        },
    });
    if observer.hook.0.is_null() {
        crate::log::line("island foreground observer could not be installed");
    }
    let data = Box::into_raw(observer);
    if !unsafe { SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS, data as usize) }.as_bool() {
        drop(unsafe { Box::from_raw(data) });
        crate::log::line("island topmost guard could not be installed");
        return;
    }
    ISLAND.store(hwnd.0 as isize, Ordering::Release);
    raise(hwnd);
}

fn raise(hwnd: HWND) {
    // Hidden/minimized windows must stay hidden; the visible working lip is
    // covered too, even though its cursor poll is parked.
    if unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() } {
        let _ = unsafe {
            SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            )
        };
    }
}

fn queue_refresh(hwnd: HWND) {
    if !hwnd.0.is_null() && !QUEUED.swap(true, Ordering::AcqRel) {
        if unsafe { PostMessageW(Some(hwnd), REFRESH, WPARAM(0), LPARAM(0)) }.is_err() {
            QUEUED.store(false, Ordering::Release);
        }
    }
}

unsafe extern "system" fn desktop_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    _window: HWND,
    _object: i32,
    _child: i32,
    _thread: u32,
    _time: u32,
) {
    if matches!(
        event,
        EVENT_SYSTEM_FOREGROUND | EVENT_SYSTEM_MINIMIZEEND | EVENT_SYSTEM_DESKTOPSWITCH
    ) {
        // Post rather than changing z-order inside a reentrant WinEvent callback.
        queue_refresh(HWND(ISLAND.load(Ordering::Acquire) as *mut _));
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    data: usize,
) -> LRESULT {
    match message {
        WM_WINDOWPOSCHANGING => {
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            if let Some(position) = unsafe { (lparam.0 as *mut WINDOWPOS).as_mut() } {
                if !position.flags.contains(SWP_NOZORDER)
                    && !position.flags.contains(SWP_HIDEWINDOW)
                {
                    position.hwndInsertAfter = HWND_TOPMOST;
                }
            }
            result
        }
        WM_WINDOWPOSCHANGED => {
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            // SWP_NOSENDCHANGING can bypass the guard above. Repair the native
            // state after that change instead of trusting Tauri's cached flag.
            if unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } & WS_EX_TOPMOST.0 as isize == 0 {
                queue_refresh(hwnd);
            }
            result
        }
        REFRESH => {
            QUEUED.store(false, Ordering::Release);
            raise(hwnd);
            LRESULT(0)
        }
        WM_SHOWWINDOW if wparam.0 != 0 => {
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            queue_refresh(hwnd);
            result
        }
        WM_NCDESTROY => {
            ISLAND.store(0, Ordering::Release);
            QUEUED.store(false, Ordering::Release);
            let _ = unsafe { RemoveWindowSubclass(hwnd, Some(window_proc), id) };
            drop(unsafe { Box::from_raw(data as *mut Observer) });
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }
        _ => unsafe { DefSubclassProc(hwnd, message, wparam, lparam) },
    }
}
