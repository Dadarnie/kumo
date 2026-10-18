// SPDX-License-Identifier: MIT
//! Event-driven power cues for the companion; no polling thread or timer.
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    PBT_APMPOWERSTATUSCHANGE, PBT_APMRESUMEAUTOMATIC, WM_NCDESTROY, WM_POWERBROADCAST,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PowerSnapshot {
    on_battery: Option<bool>,
    percent: Option<u8>,
}

fn normalize(raw: SYSTEM_POWER_STATUS) -> PowerSnapshot {
    if raw.BatteryFlag == 255 || raw.BatteryFlag & 128 != 0 {
        return PowerSnapshot::default();
    }
    PowerSnapshot {
        on_battery: match raw.ACLineStatus {
            0 => Some(true),
            1 => Some(false),
            _ => None,
        },
        percent: (raw.BatteryLifePercent <= 100).then_some(raw.BatteryLifePercent),
    }
}

pub(crate) fn snapshot() -> PowerSnapshot {
    let mut raw = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut raw) }.is_ok() {
        normalize(raw)
    } else {
        PowerSnapshot::default()
    }
}

const POWER_SUBCLASS: usize = 0x4d49_5057;

/// Called once during setup on the GUI thread. Windows owns this observer's
/// lifetime until WM_NCDESTROY, when its single AppHandle is released.
pub(crate) fn observe(win: &WebviewWindow) {
    let Ok(hwnd) = win.hwnd() else { return };
    let app = Box::into_raw(Box::new(win.app_handle().clone()));
    if !unsafe { SetWindowSubclass(HWND(hwnd.0), Some(power_proc), POWER_SUBCLASS, app as usize) }
        .as_bool()
    {
        drop(unsafe { Box::from_raw(app) });
        crate::log::line("companion power observer could not be installed");
    }
}

unsafe extern "system" fn power_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    data: usize,
) -> LRESULT {
    if message == WM_NCDESTROY {
        let _ = unsafe { RemoveWindowSubclass(hwnd, Some(power_proc), id) };
        drop(unsafe { Box::from_raw(data as *mut AppHandle) });
    } else if message == WM_POWERBROADCAST
        && [PBT_APMPOWERSTATUSCHANGE, PBT_APMRESUMEAUTOMATIC].contains(&(wparam.0 as u32))
    {
        let app = unsafe { &*(data as *const AppHandle) };
        let _ = app.emit_to(crate::island::WINDOW_LABEL, "power-status", snapshot());
        if wparam.0 as u32 == PBT_APMRESUMEAUTOMATIC {
            let _ = app.emit_to(crate::island::WINDOW_LABEL, "workflow-reconcile", ());
        }
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(ac: u8, flags: u8, percent: u8) -> PowerSnapshot {
        normalize(SYSTEM_POWER_STATUS {
            ACLineStatus: ac,
            BatteryFlag: flags,
            BatteryLifePercent: percent,
            ..SYSTEM_POWER_STATUS::default()
        })
    }

    #[test]
    fn desktop_and_unknown_hardware_never_report_low_battery() {
        assert_eq!(observation(1, 128, 0), PowerSnapshot::default());
        assert_eq!(observation(0, 255, 0), PowerSnapshot::default());
        assert_eq!(observation(255, 0, 255), PowerSnapshot::default());
    }

    #[test]
    fn real_capacity_is_retained_and_unknown_capacity_is_not_invented() {
        assert_eq!(
            observation(0, 2, 20),
            PowerSnapshot {
                on_battery: Some(true),
                percent: Some(20)
            }
        );
        assert_eq!(
            observation(1, 1, 100),
            PowerSnapshot {
                on_battery: Some(false),
                percent: Some(100)
            }
        );
        assert_eq!(
            observation(0, 0, 255),
            PowerSnapshot {
                on_battery: Some(true),
                percent: None
            }
        );
    }
}
