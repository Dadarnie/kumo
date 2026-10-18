// SPDX-License-Identifier: MIT
//! Player details and actions extend the transport without changing MediaState.
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::media::MediaState;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaAction {
    Previous,
    Play,
    Pause,
    Next,
    #[serde(untagged)]
    Shuffle {
        shuffle: bool,
    },
    #[serde(untagged)]
    Repeat {
        #[serde(rename = "repeatMode")]
        repeat_mode: RepeatMode,
    },
    #[serde(untagged)]
    Volume {
        volume: u16,
    },
    #[serde(untagged)]
    Seek {
        #[serde(rename = "seekMs")]
        seek_ms: u64,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct MediaControls {
    pub previous: bool,
    pub play: bool,
    pub pause: bool,
    pub next: bool,
    pub volume: bool,
    pub seek: bool,
    pub shuffle: bool,
    pub repeat: bool,
}

impl MediaControls {
    pub fn supports(self, action: MediaAction) -> bool {
        match action {
            MediaAction::Previous => self.previous,
            MediaAction::Play => self.play,
            MediaAction::Pause => self.pause,
            MediaAction::Next => self.next,
            MediaAction::Shuffle { .. } => self.shuffle,
            MediaAction::Repeat { .. } => self.repeat,
            MediaAction::Volume { volume } => self.volume && volume <= 100,
            MediaAction::Seek { seek_ms } => self.seek && seek_ms <= (i64::MAX / 10_000) as u64,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaArtwork {
    pub data_url: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPlayerState {
    pub session_id: Option<String>,
    pub controls: MediaControls,
    pub artwork: Option<Arc<MediaArtwork>>,
    pub timeline: Option<MediaTimeline>,
    pub volume: Option<u16>,
    pub shuffle: Option<bool>,
    pub repeat_mode: Option<RepeatMode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RepeatMode {
    Off,
    List,
    Track,
}

/// Read-only timeline, normalized to milliseconds relative to the item start.
/// The source timestamp stays stable between native events (no polling/revisions
/// invented by the clock). Playback rate is optional and is not fabricated here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaTimeline {
    pub position_ms: u64,
    pub duration_ms: u64,
    pub updated_at_unix_ms: i64,
    pub playback_rate_milli: Option<i64>,
}

impl MediaTimeline {
    pub fn from_native(
        start: i64,
        end: i64,
        position: i64,
        updated: i64,
        rate: Option<f64>,
    ) -> Option<Self> {
        let duration = end.checked_sub(start)?;
        if duration < 10_000 {
            return None;
        }
        let position = position.checked_sub(start)?.clamp(0, duration);
        let updated = updated.checked_sub(116_444_736_000_000_000)? / 10_000;
        if updated < 0 {
            return None;
        }
        Some(Self {
            position_ms: (position / 10_000) as u64,
            duration_ms: (duration / 10_000) as u64,
            updated_at_unix_ms: updated,
            playback_rate_milli: rate
                .filter(|rate| rate.is_finite() && *rate >= 0.0 && *rate <= 16.0)
                .map(|rate| (rate * 1000.0).round() as i64),
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MediaUpdate {
    pub state: MediaState,
    pub player: MediaPlayerState,
}

impl From<MediaState> for MediaUpdate {
    fn from(state: MediaState) -> Self {
        Self {
            state,
            player: MediaPlayerState::default(),
        }
    }
}

pub type ControlReply = Result<(), String>;
pub type ControlReceiver = oneshot::Receiver<ControlReply>;

pub fn authorize_action(
    requested: &str,
    current: Option<&str>,
    controls: MediaControls,
    action: MediaAction,
) -> ControlReply {
    if current != Some(requested) {
        return Err("The media session is no longer available".into());
    }
    if !controls.supports(action) {
        return Err("This player does not support that action".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeline_normalizes_offsets_clamps_positions_and_rejects_unavailable_ranges() {
        let epoch = 116_444_736_000_000_000;
        let timeline =
            MediaTimeline::from_native(50_000, 150_000, 90_000, epoch + 120_000, Some(1.0))
                .unwrap();
        assert_eq!(
            (
                timeline.position_ms,
                timeline.duration_ms,
                timeline.updated_at_unix_ms
            ),
            (4, 10, 12)
        );
        assert_eq!(timeline.playback_rate_milli, Some(1000));
        assert_eq!(
            MediaTimeline::from_native(0, 100_000, -1, epoch, None)
                .unwrap()
                .position_ms,
            0
        );
        assert_eq!(
            MediaTimeline::from_native(0, 100_000, 200_000, epoch, None)
                .unwrap()
                .position_ms,
            10
        );
        assert!(MediaTimeline::from_native(0, 0, 0, epoch, None).is_none());
        assert!(MediaTimeline::from_native(i64::MIN, i64::MAX, 0, epoch, None).is_none());
        assert!(MediaTimeline::from_native(0, 100_000, 0, 0, None).is_none());
        assert_eq!(
            MediaTimeline::from_native(0, 100_000, 0, epoch, Some(f64::NAN))
                .unwrap()
                .playback_rate_milli,
            None
        );
    }

    #[test]
    fn media_actions_require_a_current_session_and_its_capability() {
        let controls = MediaControls {
            pause: true,
            next: true,
            ..Default::default()
        };
        assert!(authorize_action("1", Some("1"), controls, MediaAction::Pause).is_ok());
        assert!(authorize_action("1", Some("1"), controls, MediaAction::Next).is_ok());
        assert!(authorize_action("1", Some("1"), controls, MediaAction::Play).is_err());
        assert!(authorize_action("1", Some("2"), controls, MediaAction::Next).is_err());
        assert!(authorize_action("1", None, controls, MediaAction::Pause).is_err());
    }

    #[test]
    fn seek_requires_position_capability_and_safe_ticks() {
        let seek = MediaAction::Seek { seek_ms: 90_000 };
        assert_eq!(
            serde_json::from_str::<MediaAction>(r#"{"seekMs":90000}"#).unwrap(),
            seek
        );
        assert!(!MediaControls::default().supports(seek));
        let controls = MediaControls {
            seek: true,
            ..Default::default()
        };
        assert!(controls.supports(seek));
        assert!(!controls.supports(MediaAction::Seek { seek_ms: u64::MAX }));
        assert!(authorize_action("old", Some("current"), controls, seek).is_err());
    }

    #[test]
    fn mode_commands_are_structured_and_require_the_current_capability() {
        for action in [r#""repeat""#, r#""shuffle""#] {
            assert!(serde_json::from_str::<MediaAction>(action).is_err());
        }
        let shuffle = serde_json::from_str::<MediaAction>(r#"{"shuffle":true}"#).unwrap();
        let repeat = serde_json::from_str::<MediaAction>(r#"{"repeatMode":"track"}"#).unwrap();
        assert!(!MediaControls::default().supports(shuffle));
        assert!(!MediaControls::default().supports(repeat));
        let modes = MediaControls {
            shuffle: true,
            repeat: true,
            ..Default::default()
        };
        assert!(authorize_action("1", Some("1"), modes, shuffle).is_ok());
        assert!(authorize_action("1", Some("1"), modes, repeat).is_ok());
        assert!(authorize_action("1", Some("2"), modes, repeat).is_err());
        assert!(serde_json::from_str::<MediaAction>(r#"{"shuffle":"true"}"#).is_err());
        assert!(serde_json::from_str::<MediaAction>(r#"{"repeatMode":"all"}"#).is_err());
        let controls = MediaControls {
            volume: true,
            ..Default::default()
        };
        assert!(
            authorize_action("1", Some("1"), controls, MediaAction::Volume { volume: 50 }).is_ok()
        );
        assert!(authorize_action(
            "1",
            Some("1"),
            controls,
            MediaAction::Volume { volume: 101 }
        )
        .is_err());
    }
}
