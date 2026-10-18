// SPDX-License-Identifier: MIT
//! Endpoint enumeration and Windows audio policy, confined to the audio MTA.
use crate::audio_runtime::{AudioActivity, AudioOutput};
use windows::core::{Interface, GUID, HRESULT, PCWSTR, PWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eMultimedia, eRender, EDataFlow, ERole, IMMDevice, IMMDeviceEnumerator,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToStringAlloc};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL, STGM_READ};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

pub(crate) fn device_id(device: &IMMDevice) -> windows::core::Result<String> {
    unsafe {
        let raw = device.GetId()?;
        let id = raw.to_string();
        CoTaskMemFree(Some(raw.0.cast()));
        Ok(id?)
    }
}

fn device_name(device: &IMMDevice) -> Option<String> {
    unsafe {
        let store = device.OpenPropertyStore(STGM_READ).ok()?;
        let mut value = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
        let name = PropVariantToStringAlloc(&value).ok().and_then(|raw| {
            let text = raw.to_string().ok();
            CoTaskMemFree(Some(raw.0.cast()));
            text
        });
        let _ = PropVariantClear(&mut value);
        name.filter(|text| !text.trim().is_empty())
    }
}

/// Source identity comes from Windows processes, never guesses about a call.
pub(crate) fn app_kind(source: &str) -> Option<(&'static str, &'static str)> {
    let source = source
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(source)
        .to_ascii_lowercase();
    if source.starts_with("msteams_") || source.starts_with("microsoftteams_") {
        return Some(("Microsoft Teams", "communication"));
    }
    match source.as_str() {
        "teams.exe" | "ms-teams.exe" => Some(("Microsoft Teams", "communication")),
        "zoom.exe" => Some(("Zoom", "communication")),
        "discord.exe" => Some(("Discord", "communication")),
        "spotify.exe" => Some(("Spotify", "audio-only")),
        "chrome.exe" => Some(("Google Chrome", "audio-only")),
        "msedge.exe" => Some(("Microsoft Edge", "audio-only")),
        "firefox.exe" => Some(("Firefox", "audio-only")),
        _ => None,
    }
}

pub(crate) fn process_name(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut path = vec![0u16; 32768];
        let mut length = path.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(process);
        result.ok()?;
        Some(String::from_utf16_lossy(&path[..length as usize]))
    }
}

pub(crate) fn endpoints(
    enumerator: &IMMDeviceEnumerator,
    flow: EDataFlow,
) -> windows::core::Result<Vec<AudioOutput>> {
    unsafe {
        let endpoints = enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)?;
        let mut devices = Vec::new();
        for index in 0..endpoints.GetCount()? {
            let device = endpoints.Item(index)?;
            devices.push(AudioOutput {
                id: device_id(&device)?,
                name: device_name(&device).unwrap_or_else(|| {
                    if flow == eCapture {
                        "Microphone".into()
                    } else {
                        "Windows output".into()
                    }
                }),
            });
        }
        devices.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
        Ok(devices)
    }
}
pub(crate) fn input_id(enumerator: &IMMDeviceEnumerator) -> Option<String> {
    unsafe {
        enumerator
            .GetDefaultAudioEndpoint(eCapture, eConsole)
            .ok()
            .and_then(|device| device_id(&device).ok())
    }
}
pub(crate) fn inspect(
    enumerator: &IMMDeviceEnumerator,
) -> windows::core::Result<(Vec<AudioOutput>, Vec<AudioActivity>)> {
    Ok((
        endpoints(enumerator, eRender)?,
        super::audio_sessions::inspect(enumerator)?,
    ))
}

// Windows has no public default-output setter. This small policy interface is
// isolated, probed at runtime, and never used for the communications role.
windows_core::define_interface!(
    IPolicyConfig,
    PolicyVTable,
    0xf8679f50_850a_41cf_9c72_430f290290c8
);
#[repr(C)]
pub struct PolicyVTable {
    base__: windows_core::IUnknown_Vtbl,
    unused: [usize; 10],
    set_default_endpoint:
        unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, ERole) -> HRESULT,
}
fn policy() -> windows::core::Result<IPolicyConfig> {
    unsafe {
        CoCreateInstance(
            &GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9),
            None,
            CLSCTX_ALL,
        )
    }
}
pub(crate) fn can_switch() -> bool {
    policy().is_ok()
}
pub(crate) fn switch(enumerator: &IMMDeviceEnumerator, id: &str) -> Result<(), String> {
    switch_device(enumerator, id, eRender)
}
pub(crate) fn switch_input(enumerator: &IMMDeviceEnumerator, id: &str) -> Result<(), String> {
    switch_device(enumerator, id, eCapture)
}
fn switch_device(
    enumerator: &IMMDeviceEnumerator,
    id: &str,
    flow: EDataFlow,
) -> Result<(), String> {
    let outputs = endpoints(enumerator, flow).map_err(|e| e.to_string())?;
    if !outputs.iter().any(|output| output.id == id) {
        return Err("Windows audio device disconnected".into());
    }
    let policy =
        policy().map_err(|_| "Windows audio device switching is unavailable".to_string())?;
    let id: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
    unsafe {
        for role in [eConsole, eMultimedia] {
            (policy.vtable().set_default_endpoint)(policy.as_raw(), PCWSTR(id.as_ptr()), role)
                .ok()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "switches real output/input devices briefly and restores all affected defaults"]
    fn live_device_switches_restore_defaults() {
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
        }
        let result = (|| -> Result<(), String> {
            let enumerator: IMMDeviceEnumerator = unsafe {
                CoCreateInstance(
                    &windows::Win32::Media::Audio::MMDeviceEnumerator,
                    None,
                    CLSCTX_ALL,
                )
            }
            .map_err(|e| e.to_string())?;
            struct Restore {
                policy: IPolicyConfig,
                roles: Vec<(ERole, String)>,
            }
            impl Drop for Restore {
                fn drop(&mut self) {
                    for (role, id) in &self.roles {
                        let id: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
                        unsafe {
                            let _ = (self.policy.vtable().set_default_endpoint)(
                                self.policy.as_raw(),
                                PCWSTR(id.as_ptr()),
                                *role,
                            );
                        }
                    }
                }
            }
            for flow in [eRender, eCapture] {
                let original = unsafe { enumerator.GetDefaultAudioEndpoint(flow, eConsole) }
                    .map_err(|e| e.to_string())?;
                let original = device_id(&original).map_err(|e| e.to_string())?;
                let alternate = endpoints(&enumerator, flow)
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .find(|device| device.id != original)
                    .ok_or("Live switching requires two active devices of each type")?;
                let roles = [eConsole, eMultimedia]
                    .into_iter()
                    .map(|role| {
                        let device = unsafe { enumerator.GetDefaultAudioEndpoint(flow, role) }
                            .map_err(|e| e.to_string())?;
                        Ok((role, device_id(&device).map_err(|e| e.to_string())?))
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                let _restore = Restore {
                    policy: policy().map_err(|e| e.to_string())?,
                    roles,
                };
                switch_device(&enumerator, &alternate.id, flow)?;
                let actual = unsafe { enumerator.GetDefaultAudioEndpoint(flow, eConsole) }
                    .map_err(|e| e.to_string())?;
                assert_eq!(device_id(&actual).map_err(|e| e.to_string())?, alternate.id);
                println!(
                    "Confirmed {} selection: {}; defaults restored on exit",
                    if flow == eCapture { "input" } else { "output" },
                    alternate.name
                );
            }
            Ok(())
        })();
        unsafe {
            CoUninitialize();
        }
        result.unwrap();
    }

    #[test]
    fn communication_apps_are_audio_activity_not_song_metadata() {
        assert_eq!(
            app_kind("C:\\Teams\\ms-teams.exe"),
            Some(("Microsoft Teams", "communication"))
        );
        assert_eq!(app_kind("Zoom.EXE"), Some(("Zoom", "communication")));
        assert_eq!(app_kind("discord.exe"), Some(("Discord", "communication")));
        assert_eq!(
            app_kind("chrome.exe"),
            Some(("Google Chrome", "audio-only"))
        );
        assert_eq!(app_kind("spotify.exe"), Some(("Spotify", "audio-only")));
        assert_eq!(app_kind("not-discord.exe"), None);
    }
}
