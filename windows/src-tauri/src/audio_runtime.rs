// SPDX-License-Identifier: MIT
//! Revisioned Windows endpoints and application sessions, owned by one runtime.
//! Audio commands never modify GSMTC playback state.
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioSnapshot {
    pub revision: u64,
    pub available: bool,
    pub device_id: Option<String>,
    pub volume: u16,
    pub muted: bool,
    pub outputs: Vec<AudioOutput>,
    pub can_switch_output: bool,
    pub input_id: Option<String>,
    pub inputs: Vec<AudioOutput>,
    pub can_switch_input: bool,
    pub sessions: Vec<AudioActivity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AudioOutput {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioActivity {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    pub output_id: String,
    pub source: String,
    pub volume: Option<u16>,
    pub muted: Option<bool>,
    pub can_control: bool,
    pub mixed: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioAction {
    pub device_id: String,
    pub volume: Option<u16>,
    pub muted: Option<bool>,
    pub output_id: Option<String>,
    pub input_id: Option<String>,
    pub session_id: Option<String>,
}

impl AudioAction {
    pub fn validate(&self, current: &AudioSnapshot) -> Result<(), String> {
        if self.output_id.is_some() || self.input_id.is_some() {
            let allowed = match (&self.output_id, &self.input_id) {
                (Some(id), None) => {
                    current.can_switch_output && current.outputs.iter().any(|item| &item.id == id)
                }
                (None, Some(id)) => {
                    current.can_switch_input && current.inputs.iter().any(|item| &item.id == id)
                }
                _ => false,
            };
            return if allowed
                && self.session_id.is_none()
                && self.volume.is_none()
                && self.muted.is_none()
            {
                Ok(())
            } else {
                Err("This Windows audio device is unavailable".into())
            };
        }
        if !current.available || current.device_id.as_deref() != Some(&self.device_id) {
            return Err("Windows audio output changed or is unavailable".into());
        }
        if let Some(id) = &self.session_id {
            if !current.sessions.iter().any(|session| {
                &session.id == id
                    && session.can_control
                    && session.volume.is_some()
                    && session.muted.is_some()
            }) {
                return Err("Windows audio session expired or is unavailable".into());
            }
        }
        if self.volume.is_some_and(|volume| volume > 100)
            || (self.volume.is_none() && self.muted.is_none())
        {
            return Err("Invalid Windows volume action".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioLevel {
    pub revision: u64,
    pub available: bool,
    pub peak: u16,
    pub sources: std::collections::BTreeMap<String, u16>,
}
pub(crate) type PublishMeter = Arc<dyn Fn(AudioLevel) + Send + Sync>;

pub(crate) type PublishAudio = Arc<dyn Fn(AudioSnapshot) + Send + Sync>;

pub(crate) fn update_audio(
    latest: &Mutex<AudioSnapshot>,
    mut next: AudioSnapshot,
    publish: &PublishAudio,
) -> AudioSnapshot {
    let mut current = latest.lock().unwrap();
    next.revision = current.revision;
    if *current != next {
        next.revision = current
            .revision
            .checked_add(1)
            .expect("audio revision exhausted");
        *current = next;
        // Publish in revision order; all endpoint calls occur outside this lock.
        publish(current.clone());
    }
    current.clone()
}

pub struct AudioRuntime {
    latest: Arc<Mutex<AudioSnapshot>>,
    worker: Mutex<Option<endpoint::AudioWorker>>,
}

#[path = "windows/master_audio.rs"]
mod endpoint;

impl AudioRuntime {
    pub fn unavailable() -> Self {
        Self {
            latest: Arc::new(Mutex::new(AudioSnapshot::default())),
            worker: Mutex::new(None),
        }
    }

    pub fn start(app: AppHandle) -> Self {
        let runtime = Self::unavailable();
        let meter_app = app.clone();
        let meter: PublishMeter = Arc::new(move |level| {
            let _ = meter_app.emit("audio-levels", level);
        });
        let publish: PublishAudio = Arc::new(move |snapshot| {
            if let Err(error) = app.emit("audio-changed", snapshot) {
                crate::log::line(format!("audio event failed: {error}"));
            }
        });
        match endpoint::AudioWorker::start_meter(runtime.latest.clone(), publish, Some(meter)) {
            Ok(worker) => *runtime.worker.lock().unwrap() = Some(worker),
            Err(error) => crate::log::line(format!("Windows audio failed: {error}")),
        }
        runtime
    }

    pub fn snapshot(&self) -> AudioSnapshot {
        self.latest.lock().unwrap().clone()
    }

    pub fn set_meter_active(&self, active: bool) {
        if let Some(worker) = self.worker.lock().unwrap().as_ref() {
            worker.set_meter_active(active);
        }
    }

    pub async fn control(&self, action: AudioAction) -> Result<AudioSnapshot, String> {
        action.validate(&self.snapshot())?;
        let reply = self
            .worker
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("Windows audio stopped")?
            .control(action)?;
        tokio::time::timeout(std::time::Duration::from_secs(3), reply)
            .await
            .map_err(|_| "Windows audio timed out".to_string())?
            .map_err(|_| "Windows audio stopped".to_string())?
    }

    pub fn shutdown(&self) {
        self.worker.lock().unwrap().take();
    }
}

impl Drop for AudioRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_switching_requires_a_real_available_endpoint_and_a_separate_action() {
        let current = AudioSnapshot {
            can_switch_output: true,
            outputs: vec![AudioOutput {
                id: "speakers".into(),
                name: "Speakers".into(),
            }],
            ..Default::default()
        };
        let mut action = AudioAction {
            output_id: Some("speakers".into()),
            ..Default::default()
        };
        assert!(action.validate(&current).is_ok());
        action.volume = Some(73);
        assert!(action.validate(&current).is_err());
        action.volume = None;
        action.output_id = Some("disconnected".into());
        assert!(action.validate(&current).is_err());
        action.output_id = Some("speakers".into());
        assert!(action
            .validate(&AudioSnapshot {
                can_switch_output: false,
                ..current
            })
            .is_err());
    }
    #[test]
    fn microphone_switches_are_real_exclusive_actions() {
        let current = AudioSnapshot {
            can_switch_input: true,
            inputs: vec![AudioOutput {
                id: "mic".into(),
                name: "Microphone".into(),
            }],
            ..Default::default()
        };
        let mut action = AudioAction {
            input_id: Some("mic".into()),
            ..Default::default()
        };
        assert!(action.validate(&current).is_ok());
        action.output_id = Some("speakers".into());
        assert!(action.validate(&current).is_err());
        action.output_id = None;
        action.session_id = Some("spotify".into());
        assert!(action.validate(&current).is_err());
        action.session_id = None;
        action.input_id = Some("unplugged".into());
        assert!(action.validate(&current).is_err());
        action.input_id = Some("mic".into());
        assert!(action
            .validate(&AudioSnapshot {
                can_switch_input: false,
                ..current
            })
            .is_err());
    }

    #[test]
    fn app_actions_require_the_current_controllable_session() {
        let current = AudioSnapshot {
            available: true,
            device_id: Some("speakers".into()),
            sessions: vec![AudioActivity {
                id: "spotify".into(),
                name: "Spotify".into(),
                kind: "audio-only",
                output_id: "speakers".into(),
                source: "spotify.exe".into(),
                volume: Some(80),
                muted: Some(false),
                can_control: true,
                mixed: false,
            }],
            ..Default::default()
        };
        let mut action = AudioAction {
            device_id: "speakers".into(),
            session_id: Some("spotify".into()),
            volume: Some(65),
            ..Default::default()
        };
        assert!(action.validate(&current).is_ok());
        action.session_id = Some("expired".into());
        assert!(action.validate(&current).is_err());
        action.session_id = Some("spotify".into());
        action.volume = Some(101);
        assert!(action.validate(&current).is_err());
        action.volume = Some(65);
        let mut unavailable = current.clone();
        unavailable.sessions[0].can_control = false;
        assert!(action.validate(&unavailable).is_err());
        unavailable.sessions.clear();
        assert!(action.validate(&unavailable).is_err());
    }

    #[test]
    fn audio_revisions_track_endpoint_state_and_reject_old_device_commands() {
        let latest = Mutex::new(AudioSnapshot::default());
        let publish: PublishAudio = Arc::new(|_| {});
        let mut speakers = AudioSnapshot {
            available: true,
            device_id: Some("speakers".into()),
            volume: 48,
            ..Default::default()
        };
        assert_eq!(
            update_audio(&latest, speakers.clone(), &publish).revision,
            1
        );
        assert_eq!(
            update_audio(&latest, speakers.clone(), &publish).revision,
            1
        );
        speakers.muted = true;
        assert_eq!(
            update_audio(&latest, speakers.clone(), &publish).revision,
            2
        );
        assert_eq!(latest.lock().unwrap().volume, 48); // Mute preserves the unmute level.
        for action in [
            AudioAction {
                device_id: "old".into(),
                volume: Some(50),
                muted: None,
                ..Default::default()
            },
            AudioAction {
                device_id: "speakers".into(),
                volume: Some(101),
                muted: None,
                ..Default::default()
            },
            AudioAction {
                device_id: "speakers".into(),
                volume: None,
                muted: None,
                ..Default::default()
            },
        ] {
            assert!(action.validate(&speakers).is_err());
        }
        assert!(AudioAction {
            device_id: "speakers".into(),
            volume: Some(50),
            muted: Some(false),
            ..Default::default()
        }
        .validate(&speakers)
        .is_ok());
        assert_eq!(
            update_audio(&latest, AudioSnapshot::default(), &publish).revision,
            3
        );
    }
}
