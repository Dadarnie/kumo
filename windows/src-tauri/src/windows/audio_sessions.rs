// SPDX-License-Identifier: MIT
//! Active Core Audio sessions, grouped by executable and endpoint. All COM
//! references stay on the audio MTA; commands re-enumerate before writing.
use super::audio_devices::{app_kind, device_id, process_name};
use crate::audio_runtime::{AudioAction, AudioActivity};
use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};
use windows::core::{Interface, HRESULT};
use windows::Win32::Media::Audio::{
    eCapture, eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
    IMMDeviceEnumerator, ISimpleAudioVolume, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoTaskMemFree, CLSCTX_ALL};

use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;

struct Group {
    activity: AudioActivity,
    members: Vec<(String, Option<ISimpleAudioVolume>)>,
    levels: Vec<(u16, bool)>,
    meters: Vec<IAudioMeterInformation>,
}

fn activity_id(endpoint: &str, executable: &str, mut members: Vec<&str>) -> String {
    members.sort_unstable();
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    endpoint.hash(&mut hash);
    executable.hash(&mut hash);
    members.hash(&mut hash);
    format!("app-{:016x}", hash.finish())
}

fn levels_summary(levels: &[(u16, bool)], members: usize) -> Option<(u16, bool, bool)> {
    if members == 0 || levels.len() != members {
        return None;
    }
    let volume = (levels.iter().map(|(v, _)| *v as u32).sum::<u32>() / members as u32) as u16;
    Some((
        volume,
        levels.iter().all(|(_, muted)| *muted),
        levels.iter().any(|level| *level != levels[0]),
    ))
}

fn groups(enumerator: &IMMDeviceEnumerator) -> windows::core::Result<Vec<Group>> {
    let mut grouped: BTreeMap<(String, String), Group> = BTreeMap::new();
    let mut capture = HashMap::new();
    unsafe {
        // Capture activity identifies a browser's voice audio without guessing
        // its tab title, provider, call status, or microphone privacy state.
        for flow in [eCapture, eRender] {
            let endpoints = enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)?;
            for index in 0..endpoints.GetCount()? {
                let device = endpoints.Item(index)?;
                let output = device_id(&device)?;
                let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                    continue;
                };
                let Ok(sessions) = manager.GetSessionEnumerator() else {
                    continue;
                };
                for index in 0..sessions.GetCount()? {
                    let Ok(control) = sessions.GetSession(index) else {
                        continue;
                    };
                    if control.GetState().ok() != Some(AudioSessionStateActive) {
                        continue;
                    }
                    let Ok(details) = control.cast::<IAudioSessionControl2>() else {
                        continue;
                    };
                    if details.IsSystemSoundsSession() == HRESULT(0) {
                        continue;
                    }
                    let Some(path) = details.GetProcessId().ok().and_then(process_name) else {
                        continue;
                    };
                    let source = path
                        .rsplit(['\\', '/'])
                        .next()
                        .unwrap_or(&path)
                        .to_ascii_lowercase();
                    if source == "kumo.exe" || source == "mimo.exe" {
                        continue; // Kumo's own sounds are not an app to mix
                    }
                    if flow == eCapture {
                        capture.insert(path.to_ascii_lowercase(), source);
                        continue;
                    }
                    let Ok(raw) = details.GetSessionInstanceIdentifier() else {
                        continue;
                    };
                    let instance = raw.to_string();
                    CoTaskMemFree(Some(raw.0.cast()));
                    let Ok(instance) = instance else { continue };
                    let (name, kind) = app_kind(&source)
                        .map(|(name, kind)| (name.to_string(), kind))
                        .unwrap_or_else(|| {
                            (source.trim_end_matches(".exe").to_string(), "audio-only")
                        });
                    // The voice assistant runs as a plain python.exe; name it.
                    let name = if crate::assistant::is_own_mic_entry(&path.replace('\\', "#")) {
                        "Kumo assistant".to_string()
                    } else {
                        name
                    };
                    let group = grouped
                        .entry((output.clone(), path.to_ascii_lowercase()))
                        .or_insert_with(|| Group {
                            activity: AudioActivity {
                                id: String::new(),
                                name,
                                kind,
                                output_id: output.clone(),
                                source: source.clone(),
                                volume: None,
                                muted: None,
                                can_control: false,
                                mixed: false,
                            },
                            members: Vec::new(),
                            levels: Vec::new(),
                            meters: Vec::new(),
                        });
                    if group.members.iter().any(|(id, _)| id == &instance) {
                        continue;
                    }
                    let volume = control.cast::<ISimpleAudioVolume>().ok();
                    if let Some(level) = volume.as_ref().and_then(|v| {
                        Some((v.GetMasterVolume().ok()?, v.GetMute().ok()?.as_bool()))
                    }) {
                        group
                            .levels
                            .push(((level.0.clamp(0.0, 1.0) * 100.0).round() as u16, level.1));
                    }
                    if let Ok(meter) = control.cast::<IAudioMeterInformation>() {
                        group.meters.push(meter);
                    }
                    group.members.push((instance, volume));
                }
            }
        }
    }
    let mut result = Vec::new();
    for ((output, executable), mut group) in grouped {
        // Changed membership produces a new ID, invalidating stale queued writes.
        group.activity.id = activity_id(
            &output,
            &executable,
            group.members.iter().map(|(id, _)| id.as_str()).collect(),
        );
        if capture.contains_key(&executable) {
            group.activity.kind = "communication";
        }
        if let Some((volume, muted, mixed)) = levels_summary(&group.levels, group.members.len()) {
            group.activity.can_control = true;
            group.activity.volume = Some(volume);
            group.activity.muted = Some(muted);
            group.activity.mixed = mixed;
        }
        result.push(group);
    }
    // A mic-only session still represents active voice audio. It has no
    // render-session volume, so expose a status row without invented controls.
    for (executable, source) in capture {
        if result.iter().any(|group| group.activity.source == source) {
            continue;
        }
        let name = app_kind(&source)
            .map(|(name, _)| name.to_string())
            .unwrap_or_else(|| source.trim_end_matches(".exe").to_string());
        result.push(Group {
            activity: AudioActivity {
                id: activity_id("", &executable, Vec::new()),
                name,
                kind: "communication",
                output_id: String::new(),
                source,
                volume: None,
                muted: None,
                can_control: false,
                mixed: false,
            },
            members: Vec::new(),
            levels: Vec::new(),
            meters: Vec::new(),
        });
    }
    result.sort_by(|a, b| {
        a.activity
            .name
            .cmp(&b.activity.name)
            .then(a.activity.id.cmp(&b.activity.id))
    });
    Ok(result)
}

/// Cache render meters by app on the shared audio worker, never a view poller.
pub(crate) fn app_meters(
    enumerator: &IMMDeviceEnumerator,
) -> BTreeMap<String, Vec<IAudioMeterInformation>> {
    let mut meters = BTreeMap::<String, Vec<IAudioMeterInformation>>::new();
    for group in groups(enumerator).unwrap_or_default() {
        if group.activity.muted != Some(true)
            && group.activity.volume != Some(0)
            && !group.meters.is_empty()
        {
            meters
                .entry(group.activity.source)
                .or_default()
                .extend(group.meters);
        }
    }
    meters
}

#[cfg(test)]
pub(crate) fn spotify_meters(enumerator: &IMMDeviceEnumerator) -> Vec<IAudioMeterInformation> {
    app_meters(enumerator)
        .remove("spotify.exe")
        .unwrap_or_default()
}

pub(crate) fn inspect(
    enumerator: &IMMDeviceEnumerator,
) -> windows::core::Result<Vec<AudioActivity>> {
    Ok(groups(enumerator)?
        .into_iter()
        .map(|group| group.activity)
        .collect())
}

pub(crate) fn control(
    enumerator: &IMMDeviceEnumerator,
    action: &AudioAction,
) -> Result<(), String> {
    let group = groups(enumerator)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|group| {
            Some(&group.activity.id) == action.session_id.as_ref() && group.activity.can_control
        })
        .ok_or("Windows audio session expired or is unavailable")?;
    unsafe {
        for (_, volume) in group.members {
            let volume = volume.ok_or("Application volume is unavailable")?;
            if let Some(level) = action.volume {
                volume
                    .SetMasterVolume(level as f32 / 100.0, std::ptr::null())
                    .map_err(|error| error.to_string())?;
            }
            if let Some(muted) = action.muted {
                volume
                    .SetMute(muted, std::ptr::null())
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "changes an active app volume/mute briefly, then restores every session level"]
    fn live_app_volume_and_external_changes_restore_levels() {
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED,
        };
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
            // Device tests may just have changed default endpoints. Wait for
            // active application sessions to settle before capturing a token.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            let mut previous = String::new();
            let group = loop {
                let candidate = groups(&enumerator)
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .filter(|group| group.activity.can_control)
                    .min_by_key(|group| group.activity.source != "spotify.exe");
                if let Some(group) = candidate {
                    if group.activity.id == previous {
                        break group;
                    }
                    previous = group.activity.id.clone();
                }
                if std::time::Instant::now() >= deadline {
                    return Err(
                        "Live app control requires a stable active audio application".into(),
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            };
            struct Restore(Vec<(ISimpleAudioVolume, f32, bool)>);
            impl Drop for Restore {
                fn drop(&mut self) {
                    for (volume, scalar, muted) in &self.0 {
                        unsafe {
                            let _ = volume.SetMasterVolume(*scalar, std::ptr::null());
                            let _ = volume.SetMute(*muted, std::ptr::null());
                        }
                    }
                }
            }
            let levels = group
                .members
                .iter()
                .map(|(_, volume)| {
                    let volume = volume.clone().ok_or("Application volume unavailable")?;
                    unsafe {
                        Ok((
                            volume.clone(),
                            volume.GetMasterVolume().map_err(|e| e.to_string())?,
                            volume.GetMute().map_err(|e| e.to_string())?.as_bool(),
                        ))
                    }
                })
                .collect::<Result<Vec<_>, String>>()?;
            let restore = Restore(levels);
            let id = group.activity.id.clone();
            let target = if group.activity.volume == Some(98) {
                97
            } else {
                98
            };
            control(
                &enumerator,
                &AudioAction {
                    session_id: Some(id.clone()),
                    volume: Some(target),
                    muted: Some(false),
                    ..Default::default()
                },
            )?;
            let observed = inspect(&enumerator)
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|session| session.id == id)
                .ok_or("Session expired")?;
            assert_eq!(observed.volume, Some(target));
            assert_eq!(observed.muted, Some(false));
            for (volume, _, _) in &restore.0 {
                unsafe {
                    volume
                        .SetMasterVolume(0.96, std::ptr::null())
                        .map_err(|e| e.to_string())?;
                }
            }
            assert_eq!(
                inspect(&enumerator)
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .find(|session| session.id == id)
                    .unwrap()
                    .volume,
                Some(96)
            );
            control(
                &enumerator,
                &AudioAction {
                    session_id: Some(id),
                    muted: Some(true),
                    ..Default::default()
                },
            )?;
            println!("Confirmed {} app volume, external changes, and mute; original levels restored on exit", group.activity.name);
            Ok(())
        })();
        unsafe {
            CoUninitialize();
        }
        result.unwrap();
    }

    #[test]
    fn session_identity_is_order_independent_but_expires_with_membership_or_endpoint() {
        let id = activity_id("speakers", "spotify.exe", vec!["session-a", "session-b"]);
        assert_eq!(
            id,
            activity_id("speakers", "spotify.exe", vec!["session-b", "session-a"])
        );
        assert_ne!(
            id,
            activity_id("headphones", "spotify.exe", vec!["session-a", "session-b"])
        );
        assert_ne!(
            id,
            activity_id("speakers", "spotify.exe", vec!["session-a"])
        );
        assert_ne!(
            id,
            activity_id("speakers", "discord.exe", vec!["session-a", "session-b"])
        );
    }

    #[test]
    fn grouped_levels_are_honest_and_require_every_session_to_be_controllable() {
        assert_eq!(
            levels_summary(&[(80, false), (40, true)], 2),
            Some((60, false, true))
        );
        assert_eq!(
            levels_summary(&[(45, true), (45, true)], 2),
            Some((45, true, false))
        );
        assert_eq!(levels_summary(&[(80, false)], 2), None);
        assert_eq!(levels_summary(&[], 0), None);
    }

    #[test]
    #[ignore = "reads real Spotify peaks; briefly resumes paused Spotify and restores playback"]
    fn live_spotify_peak_meter() {
        use crate::media::{MediaProvider, PlaybackState};
        use crate::media_player::MediaAction;
        use crate::windows::media::WindowsMediaProvider;
        use std::time::Duration;
        use windows::Win32::Media::Audio::MMDeviceEnumerator;
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED,
        };
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
        }
        let result = (|| -> Result<(), String> {
            let provider = WindowsMediaProvider::new();
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .map_err(|error| error.to_string())?;
            let mut updates = provider.updates();
            runtime.block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(5),
                    updates.wait_for(|update| {
                        update.player.session_id.is_some()
                            && update
                                .state
                                .source_app_id()
                                .is_some_and(|source| source.eq_ignore_ascii_case("Spotify.exe"))
                    }),
                )
                .await
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())?;
                Ok::<(), String>(())
            })?;
            let original = provider.update();
            let session = original
                .player
                .session_id
                .clone()
                .ok_or("Spotify session missing")?;
            let resume = original.state.playback_state() == PlaybackState::Paused;
            let perform = |action| {
                runtime.block_on(async {
                    let reply = provider.control(session.clone(), action)?;
                    tokio::time::timeout(Duration::from_secs(5), reply)
                        .await
                        .map_err(|error| error.to_string())?
                        .map_err(|error| error.to_string())?
                })
            };
            let measured = (|| -> Result<(), String> {
                if resume {
                    perform(MediaAction::Play)?;
                }
                let enumerator: IMMDeviceEnumerator =
                    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                        .map_err(|error| error.to_string())?;
                let mut meters = spotify_meters(&enumerator);
                for _ in 0..20 {
                    if !meters.is_empty() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                    meters = spotify_meters(&enumerator);
                }
                if meters.is_empty() {
                    return Err("No active, unmuted Spotify session meter".into());
                }
                let mut peak = 0.0f32;
                for _ in 0..20 {
                    for meter in &meters {
                        peak = peak.max(
                            unsafe { meter.GetPeakValue() }.map_err(|error| error.to_string())?,
                        );
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                if peak <= 0.0 || !peak.is_finite() {
                    return Err("Spotify did not produce a measured audio peak".into());
                }
                println!(
                    "Measured Spotify session peak: {peak:.3}; {} source-specific meter(s)",
                    meters.len()
                );
                Ok(())
            })();
            // Restore even when metering or playback confirmation failed.
            let restored = if resume {
                perform(MediaAction::Pause)
            } else {
                Ok(())
            };
            measured.and(restored)
        })();
        unsafe {
            CoUninitialize();
        }
        result.unwrap();
    }
}
