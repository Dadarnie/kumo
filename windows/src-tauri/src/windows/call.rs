// SPDX-License-Identifier: MIT
//! Calls: which app is using the microphone right now, the default
//! microphone's mute, and bringing the call app to the front.
//!
//! Windows records microphone use per app under CapabilityAccessManager's
//! ConsentStore. An entry whose LastUsedTimeStop is 0 is using the mic now.
//! Nothing here reads call contents, participants or window text.

use serde::Serialize;
use windows::{
    core::{w, BOOL, PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM},
        Media::Audio::{
            eCapture, eCommunications, Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator,
            MMDeviceEnumerator,
        },
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
            },
            Registry::{
                RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER,
                KEY_READ, RRF_RT_REG_QWORD,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::WindowsAndMessaging::{
            EnumWindows, GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
            SetForegroundWindow, ShowWindow, SW_RESTORE,
        },
    },
};

const MIC_KEY: PCWSTR =
    w!("Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone");

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallState {
    /// Friendly name: "Discord", "Zoom", "Teams", or "Browser" for web calls.
    pub app: String,
    /// Executable path for desktop apps; None for Store apps.
    pub path: Option<String>,
    pub started_at_unix_ms: u64,
    /// Default communications microphone mute; None when unreadable.
    pub muted: Option<bool>,
}

/// `C:#Program Files#Zen Browser#zen.exe` or `MSTeams_8wekyb3d8bbwe` → friendly name.
pub(crate) fn friendly_app(entry: &str) -> String {
    let leaf = entry.rsplit('#').next().unwrap_or(entry);
    let stem = leaf
        .strip_suffix(".exe")
        .or_else(|| leaf.strip_suffix(".EXE"))
        .unwrap_or_else(|| leaf.split('_').next().unwrap_or(leaf));
    match stem.to_ascii_lowercase().as_str() {
        "zen" | "chrome" | "msedge" | "firefox" | "brave" | "opera" | "vivaldi" | "arc" => {
            "Browser".into()
        }
        "discord" => "Discord".into(),
        "zoom" => "Zoom".into(),
        "ms-teams" | "teams" | "msteams" => "Teams".into(),
        "slack" => "Slack".into(),
        _ => stem.to_string(),
    }
}

/// FILETIME (100ns since 1601) → Unix milliseconds.
fn unix_ms(filetime: u64) -> u64 {
    (filetime / 10_000).saturating_sub(11_644_473_600_000)
}

fn qword(key: HKEY, subkey: &[u16], value: PCWSTR) -> Option<u64> {
    let mut data = 0u64;
    let mut size = 8u32;
    unsafe {
        RegGetValueW(
            key,
            PCWSTR(subkey.as_ptr()),
            value,
            RRF_RT_REG_QWORD,
            None,
            Some((&mut data as *mut u64).cast()),
            Some(&mut size),
        )
    }
    .is_ok()
    .then_some(data)
}

/// (entry name, start FILETIME) for every app using the mic right now.
fn live_entries(path: PCWSTR) -> Vec<(String, u64)> {
    let mut found = Vec::new();
    let mut key = HKEY::default();
    if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path, Some(0), KEY_READ, &mut key) }.is_err() {
        return found;
    }
    for index in 0.. {
        let mut name = [0u16; 512];
        let mut len = name.len() as u32;
        let status = unsafe {
            RegEnumKeyExW(
                key,
                index,
                Some(PWSTR(name.as_mut_ptr())),
                &mut len,
                None,
                None,
                None,
                None,
            )
        };
        if status.is_err() {
            break;
        }
        let subkey: Vec<u16> = name[..len as usize]
            .iter()
            .copied()
            .chain(Some(0))
            .collect();
        let start = qword(key, &subkey, w!("LastUsedTimeStart")).unwrap_or(0);
        let stop = qword(key, &subkey, w!("LastUsedTimeStop"));
        if start > 0 && stop == Some(0) {
            found.push((String::from_utf16_lossy(&name[..len as usize]), start));
        }
    }
    unsafe {
        let _ = RegCloseKey(key);
    }
    found
}

fn mic_muted() -> Option<bool> {
    with_mic(|volume| {
        unsafe { volume.GetMute() }
            .ok()
            .map(|muted| muted.as_bool())
    })
}

fn with_mic<T>(read: impl FnOnce(&IAudioEndpointVolume) -> Option<T>) -> Option<T> {
    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    let result = (|| {
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.ok()?;
        let device =
            unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, eCommunications) }.ok()?;
        let volume = unsafe { device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None) }.ok()?;
        read(&volume)
    })();
    if initialized {
        unsafe { CoUninitialize() };
    }
    result
}

/// The call in progress: the most recent app still holding the microphone.
/// Kumo's own voice chat and the assistant are not calls.
pub fn active_call() -> Option<CallState> {
    let mut entries = live_entries(MIC_KEY);
    entries.extend(live_entries(w!(
        "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged"
    )));
    let (entry, start) = entries
        .into_iter()
        .filter(|(name, _)| {
            let lower = name.to_ascii_lowercase();
            name != "NonPackaged"
                && !lower.ends_with("#mimo.exe")
                && !lower.ends_with("#kumo.exe")
                && !crate::assistant::is_own_mic_entry(name)
        })
        .max_by_key(|(_, start)| *start)?;
    let path = entry.contains('#').then(|| entry.replace('#', "\\"));
    Some(CallState {
        app: friendly_app(&entry),
        path,
        started_at_unix_ms: unix_ms(start),
        muted: mic_muted(),
    })
}

fn image_path(pid: u32) -> Option<String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut image = [0u16; 1024];
    let mut length = image.len() as u32;
    let read = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(image.as_mut_ptr()),
            &mut length,
        )
    };
    unsafe {
        let _ = CloseHandle(handle);
    }
    read.ok()?;
    Some(String::from_utf16_lossy(&image[..length as usize]))
}

struct Search {
    path: String,
    found: Option<HWND>,
}

unsafe extern "system" fn find_window(hwnd: HWND, data: LPARAM) -> BOOL {
    let search = unsafe { &mut *(data.0 as *mut Search) };
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() || unsafe { GetWindowTextLengthW(hwnd) } == 0 {
        return BOOL(1);
    }
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if image_path(pid).is_some_and(|image| image.eq_ignore_ascii_case(&search.path)) {
        search.found = Some(hwnd);
        return BOOL(0);
    }
    BOOL(1)
}

/// Brings the call app's main window to the front. Store apps are not supported.
pub fn focus_call_app(path: &str) -> bool {
    let mut search = Search {
        path: path.to_string(),
        found: None,
    };
    let _ = unsafe { EnumWindows(Some(find_window), LPARAM(&mut search as *mut _ as isize)) };
    let Some(hwnd) = search.found else {
        return false;
    };
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        SetForegroundWindow(hwnd).as_bool()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_apps_get_friendly_names() {
        assert_eq!(
            friendly_app("C:#Program Files#Zen Browser#zen.exe"),
            "Browser"
        );
        assert_eq!(
            friendly_app("C:#Users#me#AppData#Local#Discord#app-1.0#Discord.exe"),
            "Discord"
        );
        assert_eq!(friendly_app("MSTeams_8wekyb3d8bbwe"), "Teams");
        assert_eq!(friendly_app("C:#Program Files#Zoom#bin#Zoom.exe"), "Zoom");
        assert_eq!(unix_ms(116_444_736_000_000_000), 0);
    }
}
