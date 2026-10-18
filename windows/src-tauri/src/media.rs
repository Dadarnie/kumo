// SPDX-License-Identifier: MIT
//! Media contracts shared by native providers and the future Tauri bridge.
//! Providers are constructed explicitly; nothing is started at app boot or
//! connected to the frontend here.

use serde::Serialize;

/// Preserve the Windows states; None means no selected session, while Unknown
/// means a selected session exists but its playback status is not understood.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackState {
    None,
    Closed,
    Opened,
    Changing,
    Stopped,
    Playing,
    Paused,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderStatus {
    Initializing,
    Ready,
    Unavailable,
    Error,
}

/// Raw selected-session data. MediaState owns normalization and session loss.
#[derive(Debug, Clone)]
pub struct MediaSession {
    pub playback_state: PlaybackState,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album_title: Option<String>,
    pub source_app_id: Option<String>,
}

/// Camel-case wire contract, matching src/core/media.ts. Fields stay private so
/// callers cannot bypass normalization or leave metadata after session loss.
/// isPlaying is computed from playbackState and is not a serialized field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    provider_status: ProviderStatus,
    playback_state: PlaybackState,
    title: Option<String>,
    artist: Option<String>,
    album_title: Option<String>,
    source_app_id: Option<String>,
    error: Option<String>,
}

impl Default for MediaState {
    fn default() -> Self {
        Self::empty(ProviderStatus::Initializing)
    }
}

impl MediaState {
    pub fn empty(provider_status: ProviderStatus) -> Self {
        Self {
            provider_status,
            playback_state: PlaybackState::None,
            title: None,
            artist: None,
            album_title: None,
            source_app_id: None,
            error: None,
        }
    }

    pub fn failed(error: String) -> Self {
        Self {
            error: Some(error),
            ..Self::empty(ProviderStatus::Error)
        }
    }

    pub fn playback_state(&self) -> PlaybackState {
        self.playback_state
    }

    pub fn is_playing(&self) -> bool {
        self.playback_state == PlaybackState::Playing
    }

    pub fn source_app_id(&self) -> Option<&str> {
        self.source_app_id.as_deref()
    }
    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }
    pub fn artist(&self) -> Option<&str> {
        self.artist.as_deref()
    }

    /// A successful observation replaces the selected session, including any
    /// previous source's metadata. None clears the session rather than pausing it.
    pub fn set_session(&mut self, session: Option<MediaSession>) {
        *self = Self::empty(ProviderStatus::Ready);
        if let Some(session) = session.filter(|s| s.playback_state != PlaybackState::None) {
            self.playback_state = session.playback_state;
            self.title = normalize_text(session.title);
            self.artist = normalize_text(session.artist);
            self.album_title = normalize_text(session.album_title);
            self.source_app_id = normalize_text(session.source_app_id);
        }
    }

    /// Playback-only updates retain metadata, including when paused. A status
    /// update cannot invent a session; providers must select one with set_session.
    pub fn set_playback_state(&mut self, playback_state: PlaybackState) {
        if playback_state == PlaybackState::None {
            self.playback_state = PlaybackState::None;
            self.title = None;
            self.artist = None;
            self.album_title = None;
            self.source_app_id = None;
        } else if self.playback_state != PlaybackState::None {
            self.playback_state = playback_state;
        }
    }
}

fn normalize_text(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.trim().is_empty())
}

/// Provider boundary: snapshots contain normalized data and perform no UI work.
/// Windows snapshots read the cache maintained by native media events.
pub trait MediaProvider: Send + Sync {
    fn snapshot(&self) -> MediaState;

    fn update(&self) -> crate::media_player::MediaUpdate {
        self.snapshot().into()
    }

    fn control(
        &self,
        _session_id: String,
        _action: crate::media_player::MediaAction,
    ) -> Result<crate::media_player::ControlReceiver, String> {
        Err("Native media controls are unavailable".into())
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct UnavailableMediaProvider;

#[cfg(test)]
impl MediaProvider for UnavailableMediaProvider {
    fn snapshot(&self) -> MediaState {
        MediaState::empty(ProviderStatus::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, to_value};

    fn session(playback_state: PlaybackState) -> MediaSession {
        MediaSession {
            playback_state,
            title: Some("Track".into()),
            artist: Some("Artist".into()),
            album_title: Some("Album".into()),
            source_app_id: Some("Player.App".into()),
        }
    }

    #[test]
    fn wire_states_and_derived_playing_are_consistent() {
        let states = [
            (PlaybackState::None, "none"),
            (PlaybackState::Closed, "closed"),
            (PlaybackState::Opened, "opened"),
            (PlaybackState::Changing, "changing"),
            (PlaybackState::Stopped, "stopped"),
            (PlaybackState::Playing, "playing"),
            (PlaybackState::Paused, "paused"),
            (PlaybackState::Unknown, "unknown"),
        ];
        for (playback_state, expected) in states {
            let mut state = MediaState::default();
            state.set_session(Some(session(playback_state)));
            let wire = to_value(&state).unwrap();
            assert_eq!(wire["playbackState"], expected);
            assert_eq!(state.is_playing(), expected == "playing");
            assert!(wire.get("isPlaying").is_none());
        }
    }

    #[test]
    fn pausing_retains_metadata_and_session_loss_clears_it() {
        let mut state = MediaState::default();
        state.set_session(Some(session(PlaybackState::Playing)));
        state.set_playback_state(PlaybackState::Paused);
        assert!(!state.is_playing());
        assert_eq!(
            to_value(&state).unwrap(),
            json!({
                "providerStatus": "ready", "playbackState": "paused",
                "title": "Track", "artist": "Artist", "albumTitle": "Album",
                "sourceAppId": "Player.App", "error": null,
            })
        );

        state.set_session(None);
        assert_eq!(state, MediaState::empty(ProviderStatus::Ready));
        state.set_playback_state(PlaybackState::Playing);
        assert_eq!(state.playback_state(), PlaybackState::None);

        state.set_session(Some(session(PlaybackState::Playing)));
        state.set_playback_state(PlaybackState::None);
        assert_eq!(state, MediaState::empty(ProviderStatus::Ready));
    }

    #[test]
    fn missing_and_blank_metadata_are_null_and_new_sources_replace_old_data() {
        let mut state = MediaState::default();
        state.set_session(Some(session(PlaybackState::Playing)));
        state.set_session(Some(MediaSession {
            playback_state: PlaybackState::Paused,
            title: Some(String::new()),
            artist: Some(" \t\n".into()),
            album_title: None,
            source_app_id: Some("Browser.App".into()),
        }));
        assert_eq!(
            to_value(&state).unwrap(),
            json!({
                "providerStatus": "ready", "playbackState": "paused",
                "title": null, "artist": null, "albumTitle": null,
                "sourceAppId": "Browser.App", "error": null,
            })
        );
        state.set_session(Some(session(PlaybackState::None)));
        assert_eq!(state, MediaState::empty(ProviderStatus::Ready));
    }

    #[test]
    fn unavailable_and_failed_providers_are_distinct_from_no_media() {
        let unavailable = UnavailableMediaProvider.snapshot();
        assert_eq!(
            to_value(&unavailable).unwrap()["providerStatus"],
            "unavailable"
        );
        assert!(!unavailable.is_playing());
        let mut failed = MediaState::failed("Unavailable session".into());
        assert_eq!(to_value(&failed).unwrap()["providerStatus"], "error");
        failed.set_playback_state(PlaybackState::None);
        assert_eq!(to_value(&failed).unwrap()["error"], "Unavailable session");
        failed.set_session(None);
        assert_eq!(failed, MediaState::empty(ProviderStatus::Ready));
    }
}
