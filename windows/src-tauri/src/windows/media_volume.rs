// SPDX-License-Identifier: MIT
//! Player volume on the existing MTA media worker: Spotify's own slider, and
//! app-session volume for other sources. Never changes endpoint/master volume.
use std::sync::{atomic::Ordering, Arc};

use ::windows::core::{implement, Interface, BOOL, GUID, PCWSTR, PWSTR};
use ::windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS};
use ::windows::Win32::Media::Audio::{
    eRender, AudioSessionDisconnectReason, AudioSessionState, AudioSessionStateActive,
    AudioSessionStateExpired, IAudioSessionControl, IAudioSessionControl2, IAudioSessionEvents,
    IAudioSessionEvents_Impl, IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume,
    MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use ::windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
use ::windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use ::windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::{Signals, WinResult, VOLUME};
#[path = "spotify_volume.rs"]
mod spotify;

pub(super) enum VolumeBinding {
    Session(SessionVolumeBinding),
    Spotify(spotify::SpotifyVolume),
}
impl VolumeBinding {
    pub(super) fn find(source: &str, signals: &Arc<Signals>, generation: u64) -> Option<Self> {
        if source.eq_ignore_ascii_case("Spotify.exe")
            || source
                .to_ascii_lowercase()
                .starts_with("spotifyab.spotifymusic")
        {
            return spotify::SpotifyVolume::find(signals, generation).map(Self::Spotify);
        }
        SessionVolumeBinding::find(source, signals, generation).map(Self::Session)
    }
    pub(super) fn spotify(&self) -> bool {
        matches!(self, Self::Spotify(_))
    }
    pub(super) fn step(&self) -> WinResult<u16> {
        match self {
            Self::Session(_) => Ok(1),
            Self::Spotify(binding) => binding.step(),
        }
    }
    pub(super) fn level(&self) -> WinResult<u16> {
        match self {
            Self::Session(binding) => binding.level(),
            Self::Spotify(binding) => binding.level(),
        }
    }
    pub(super) fn set(&self, level: u16) -> Result<(), String> {
        match self {
            Self::Session(binding) => binding.set(level),
            Self::Spotify(binding) => binding.set(level),
        }
    }
}

#[implement(IAudioSessionEvents)]
struct VolumeEvents {
    signals: Arc<Signals>,
    generation: u64,
}

impl VolumeEvents {
    fn changed(&self) {
        if self.signals.active_generation.load(Ordering::Acquire) == self.generation {
            self.signals.schedule(VOLUME);
        }
    }
}

#[allow(non_snake_case)]
impl IAudioSessionEvents_Impl for VolumeEvents_Impl {
    fn OnDisplayNameChanged(&self, _: &PCWSTR, _: *const GUID) -> WinResult<()> {
        Ok(())
    }
    fn OnIconPathChanged(&self, _: &PCWSTR, _: *const GUID) -> WinResult<()> {
        Ok(())
    }
    fn OnSimpleVolumeChanged(&self, _: f32, _: BOOL, _: *const GUID) -> WinResult<()> {
        self.changed();
        Ok(())
    }
    fn OnChannelVolumeChanged(
        &self,
        _: u32,
        _: *const f32,
        _: u32,
        _: *const GUID,
    ) -> WinResult<()> {
        Ok(())
    }
    fn OnGroupingParamChanged(&self, _: *const GUID, _: *const GUID) -> WinResult<()> {
        self.changed();
        Ok(())
    }
    fn OnStateChanged(&self, _: AudioSessionState) -> WinResult<()> {
        self.changed();
        Ok(())
    }
    fn OnSessionDisconnected(&self, _: AudioSessionDisconnectReason) -> WinResult<()> {
        self.changed();
        Ok(())
    }
}

pub(super) struct SessionVolumeBinding {
    control: IAudioSessionControl,
    volume: ISimpleAudioVolume,
    events: IAudioSessionEvents,
}

impl SessionVolumeBinding {
    pub(super) fn find(source: &str, signals: &Arc<Signals>, generation: u64) -> Option<Self> {
        let control = find_unique_session(source).ok()??;
        let volume = control.cast::<ISimpleAudioVolume>().ok()?;
        let events: IAudioSessionEvents = VolumeEvents {
            signals: signals.clone(),
            generation,
        }
        .into();
        unsafe {
            control.RegisterAudioSessionNotification(&events).ok()?;
        }
        Some(Self {
            control,
            volume,
            events,
        })
    }

    pub(super) fn level(&self) -> WinResult<u16> {
        unsafe {
            if self.volume.GetMute()?.as_bool() {
                return Ok(0);
            }
            Ok((self.volume.GetMasterVolume()?.clamp(0.0, 1.0) * 100.0).round() as u16)
        }
    }

    pub(super) fn set(&self, level: u16) -> Result<(), String> {
        if level > 100 {
            return Err("Volume must be between 0 and 100".into());
        }
        // Stay above the f32 boundary for apps that truncate integer percentages
        // when resuming (for example, 0.51f32 is slightly below 51 percent).
        let scalar = level as f32 / 100.0;
        let scalar = if level > 0 && level < 100 {
            f32::from_bits(scalar.to_bits() + 1)
        } else {
            scalar
        };
        unsafe {
            self.volume
                .SetMasterVolume(scalar, std::ptr::null())
                .map_err(|error| error.to_string())?;
            self.volume
                .SetMute(level == 0, std::ptr::null())
                .map_err(|error| error.to_string())
        }
    }
}

impl Drop for SessionVolumeBinding {
    fn drop(&mut self) {
        unsafe {
            let _ = self
                .control
                .UnregisterAudioSessionNotification(&self.events);
        }
    }
}

fn matches_source(source: &str, executable: &str, app_id: Option<&str>) -> bool {
    let source = source.trim();
    if source.is_empty() {
        return false;
    }
    if app_id.is_some_and(|id| source.eq_ignore_ascii_case(id)) {
        return true;
    }
    // Desktop GSMTC sources normally expose an executable name. Restrict this
    // fallback to exact names; substring/brand matches could affect another app.
    let basename = executable.rsplit(['\\', '/']).next().unwrap_or(executable);
    source.to_ascii_lowercase().ends_with(".exe") && source.eq_ignore_ascii_case(basename)
}

fn process_matches(source: &str, pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut path = vec![0u16; 32768];
        let mut len = path.len() as u32;
        let executable = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut len,
        )
        .ok()
        .map(|_| String::from_utf16_lossy(&path[..len as usize]))
        .unwrap_or_default();
        let mut id = vec![0u16; 512];
        let mut id_len = id.len() as u32;
        let app_id =
            (GetApplicationUserModelId(process, &mut id_len, Some(PWSTR(id.as_mut_ptr())))
                == ERROR_SUCCESS)
                .then(|| String::from_utf16_lossy(&id[..id_len.saturating_sub(1) as usize]));
        let _ = CloseHandle(process);
        matches_source(source, &executable, app_id.as_deref())
    }
}

fn unique_session<T>(active: Vec<T>, inactive: Vec<T>) -> Option<T> {
    let mut candidates = if active.is_empty() { inactive } else { active };
    if candidates.len() == 1 {
        candidates.pop()
    } else {
        None
    }
}

fn find_unique_session(source: &str) -> WinResult<Option<IAudioSessionControl>> {
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let endpoints = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        let mut active = Vec::new();
        let mut inactive = Vec::new();
        for index in 0..endpoints.GetCount()? {
            let endpoint = endpoints.Item(index)?;
            let Ok(manager) = endpoint.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                continue;
            };
            let sessions = manager.GetSessionEnumerator()?;
            for index in 0..sessions.GetCount()? {
                let control = sessions.GetSession(index)?;
                let state = control.GetState()?;
                if state == AudioSessionStateExpired {
                    continue;
                }
                let info = control.cast::<IAudioSessionControl2>()?;
                if !process_matches(source, info.GetProcessId()?) {
                    continue;
                }
                if state == AudioSessionStateActive {
                    active.push(control);
                } else {
                    inactive.push(control);
                }
            }
        }
        Ok(unique_session(active, inactive))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "changes real Spotify volume by one supported step, then restores it; run explicitly"]
    fn live_spotify_volume_settles_and_restores() {
        let _apartment = super::super::Apartment::initialize().unwrap();
        let (signals, _) = Signals::new();
        let binding =
            VolumeBinding::find("Spotify.exe", &signals, 0).expect("Spotify's own volume slider");
        let original = binding.level().unwrap();
        let mixer = SessionVolumeBinding::find("Spotify.exe", &signals, 0);
        let mixer_original = mixer.as_ref().and_then(|mixer| mixer.level().ok());
        let restore = original;
        let step = binding.step().unwrap();
        let alternate = if original < step {
            step
        } else {
            original - step
        };
        let changed = binding.set(alternate);
        std::thread::sleep(std::time::Duration::from_millis(250));
        let observed = binding.level();
        let restored = binding.set(restore);
        std::thread::sleep(std::time::Duration::from_millis(250));
        let final_level = binding.level().unwrap();
        let mixer_final = mixer.as_ref().and_then(|mixer| mixer.level().ok());
        println!("Live Spotify internal volume: {original} -> {observed:?} -> {final_level}; Windows mixer: {mixer_original:?} -> {mixer_final:?}");
        assert!(changed.is_ok() && restored.is_ok());
        assert_eq!(observed.unwrap(), alternate);
        assert_eq!(final_level, restore);
        assert_eq!(mixer_final, mixer_original);
    }

    #[test]
    fn volume_prefers_a_unique_active_session_and_rejects_ambiguity() {
        assert_eq!(unique_session(vec![1], vec![2, 3]), Some(1));
        assert_eq!(unique_session(vec![1, 2], vec![3]), None);
        assert_eq!(unique_session(vec![], vec![3]), Some(3));
        assert_eq!(unique_session(vec![], vec![2, 3]), None);
        assert_eq!(unique_session(Vec::<u8>::new(), vec![]), None);
    }
    #[test]
    fn volume_matches_exact_executables_or_app_ids_and_rejects_brand_guesses() {
        assert!(matches_source("Spotify.exe", "C:\\Apps\\spotify.exe", None));
        assert!(matches_source("chrome.exe", "C:\\Apps\\chrome.exe", None));
        assert!(matches_source(
            "Vendor.Player_123!App",
            "C:\\Apps\\player.exe",
            Some("Vendor.Player_123!App")
        ));
        assert!(!matches_source("Spotify", "C:\\Apps\\spotify.exe", None));
        assert!(!matches_source(
            "chrome.exe",
            "C:\\Apps\\chromedriver.exe",
            None
        ));
        assert!(!matches_source("", "", None));
    }
}
