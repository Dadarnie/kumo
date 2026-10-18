// SPDX-License-Identifier: MIT
//! Application-owned media transport. Revisions belong to this cache, not to
//! the normalized Phase 1 contract or the platform provider.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use crate::media::{MediaProvider, MediaState, ProviderStatus};
use crate::media_player::{MediaAction, MediaPlayerState, MediaUpdate};

#[derive(Debug, Clone, Serialize)]
pub struct MediaSnapshot {
    pub revision: u64,
    pub state: MediaState,
    pub player: MediaPlayerState,
}

impl MediaSnapshot {
    pub(crate) fn new(update: impl Into<MediaUpdate>) -> Self {
        let update = update.into();
        Self {
            revision: 0,
            state: update.state,
            player: update.player,
        }
    }

    fn update(&mut self, next: impl Into<MediaUpdate>) -> bool {
        let next = next.into();
        if self.state == next.state && self.player == next.player {
            return false;
        }
        self.revision = self
            .revision
            .checked_add(1)
            .expect("media revision exhausted");
        self.state = next.state;
        self.player = next.player;
        true
    }
}

struct Lifetime {
    provider: Option<Box<dyn MediaProvider>>,
    forwarder: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Lifetime {
    fn shutdown(&mut self) {
        if let Some(forwarder) = self.forwarder.take() {
            forwarder.abort();
        }
        // The Windows provider's Drop signals, unregisters, and joins its MTA
        // worker. Do this explicitly before Tauri calls process::exit.
        self.provider.take();
    }
}

pub struct MediaRuntime {
    latest: Arc<Mutex<MediaSnapshot>>,
    lifetime: Mutex<Lifetime>,
    publish: Arc<dyn Fn(MediaSnapshot) + Send + Sync>,
    pub audio: crate::audio_runtime::AudioRuntime,
}

impl MediaRuntime {
    pub fn start(app: AppHandle) -> Self {
        let provider = crate::windows::media::WindowsMediaProvider::new();
        let updates = Some(provider.updates());

        let audio = crate::audio_runtime::AudioRuntime::start(app.clone());
        let mut runtime = Self::with_provider(
            provider,
            updates,
            move |snapshot| {
                if let Err(error) = app.emit("media-changed", snapshot) {
                    crate::log::line(format!("media event failed: {error}"));
                }
            },
            crate::log::line,
        );
        runtime.audio = audio;
        runtime
    }

    fn with_provider<T: Clone + Into<MediaUpdate> + Send + Sync + 'static>(
        provider: impl MediaProvider + 'static,
        updates: Option<watch::Receiver<T>>,
        publish: impl Fn(MediaSnapshot) + Send + Sync + 'static,
        report: impl Fn(String) + Send + 'static,
    ) -> Self {
        let initial = if updates.as_ref().is_some_and(|rx| rx.has_changed().is_err()) {
            // Thread creation or acquisition can fail before setup finishes.
            MediaState::empty(ProviderStatus::Unavailable).into()
        } else {
            provider.update()
        };
        let latest = Arc::new(Mutex::new(MediaSnapshot::new(initial)));
        let publish = Arc::new(publish);
        let emit = publish.clone();
        let forwarder = updates.map(|updates| {
            tauri::async_runtime::spawn(forward_changes(
                updates,
                latest.clone(),
                move |snapshot| emit(snapshot),
                report,
            ))
        });
        Self {
            latest,
            publish,
            audio: crate::audio_runtime::AudioRuntime::unavailable(),
            lifetime: Mutex::new(Lifetime {
                provider: Some(Box::new(provider)),
                forwarder,
            }),
        }
    }

    pub fn snapshot(&self) -> MediaSnapshot {
        self.latest.lock().unwrap().clone()
    }

    pub fn shutdown(&self) {
        self.lifetime.lock().unwrap().shutdown();
        self.audio.shutdown();
    }

    pub async fn control(
        &self,
        session_id: String,
        action: MediaAction,
    ) -> Result<MediaSnapshot, String> {
        let reply = self
            .lifetime
            .lock()
            .unwrap()
            .provider
            .as_ref()
            .ok_or("Media provider has stopped")?
            .control(session_id, action)?;
        tokio::time::timeout(std::time::Duration::from_secs(5), reply)
            .await
            .map_err(|_| "Media action timed out".to_string())?
            .map_err(|_| "Media provider has stopped".to_string())??;
        let lifetime = self.lifetime.lock().unwrap();
        let mut latest = self.latest.lock().unwrap();
        // Read the provider while holding the cache lock, just like the event
        // forwarder. A pre-read older update cannot overwrite this confirmation.
        let update = lifetime
            .provider
            .as_ref()
            .ok_or("Media provider has stopped")?
            .update();
        if latest.update(update) {
            (self.publish)(latest.clone());
        }
        Ok(latest.clone())
    }
}

impl Drop for MediaRuntime {
    fn drop(&mut self) {
        self.lifetime.get_mut().unwrap().shutdown();
        self.audio.shutdown();
    }
}

async fn forward_changes<T: Clone + Into<MediaUpdate>>(
    mut updates: watch::Receiver<T>,
    latest: Arc<Mutex<MediaSnapshot>>,
    publish: impl Fn(MediaSnapshot),
    report: impl Fn(String),
) {
    loop {
        let stopped = {
            let mut current = latest.lock().unwrap();
            // Read before waiting, inside the same serialization boundary as
            // command confirmations. Never cache a snapshot read before this lock.
            let mut next: MediaUpdate = updates.borrow_and_update().clone().into();
            let stopped = updates.has_changed().is_err();
            if stopped {
                report(format!(
                    "media provider stopped; last state: {:?}",
                    next.state
                ));
                next = MediaState::empty(ProviderStatus::Unavailable).into();
            }
            if current.update(next) {
                publish(current.clone());
            }
            stopped
        };
        if stopped {
            return;
        }
        // This is event-driven; no polling or idle timer is introduced.
        let _ = updates.changed().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::{MediaSession, PlaybackState};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    struct TestProvider {
        updates: watch::Receiver<MediaState>,
        dropped: Arc<AtomicBool>,
    }

    impl MediaProvider for TestProvider {
        fn snapshot(&self) -> MediaState {
            self.updates.borrow().clone()
        }
    }

    impl Drop for TestProvider {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::Release);
        }
    }

    fn test_provider() -> (watch::Sender<MediaState>, TestProvider) {
        let (cache, updates) = watch::channel(MediaState::default());
        (
            cache,
            TestProvider {
                updates,
                dropped: Arc::new(AtomicBool::new(false)),
            },
        )
    }

    fn playing(title: &str) -> MediaState {
        let mut state = MediaState::default();
        state.set_session(Some(MediaSession {
            playback_state: PlaybackState::Playing,
            title: Some(title.into()),
            artist: None,
            album_title: None,
            source_app_id: None,
        }));
        state
    }

    #[test]
    fn native_command_replies_and_events_cannot_regress_confirmed_playback() {
        struct Controlled {
            updates: watch::Sender<MediaUpdate>,
        }
        impl MediaProvider for Controlled {
            fn snapshot(&self) -> MediaState {
                self.updates.borrow().state.clone()
            }
            fn update(&self) -> MediaUpdate {
                self.updates.borrow().clone()
            }
            fn control(
                &self,
                _: String,
                action: MediaAction,
            ) -> Result<crate::media_player::ControlReceiver, String> {
                let mut next = self.update();
                next.state
                    .set_playback_state(if action == MediaAction::Pause {
                        PlaybackState::Paused
                    } else {
                        PlaybackState::Playing
                    });
                self.updates.send_replace(next);
                let (reply, receive) = tokio::sync::oneshot::channel();
                reply.send(Ok(())).unwrap();
                Ok(receive)
            }
        }
        let mut initial: MediaUpdate = playing("Track").into();
        initial.player.session_id = Some("one".into());
        let (updates, receive) = watch::channel(initial);
        let (published, events) = mpsc::channel();
        let runtime = MediaRuntime::with_provider(
            Controlled { updates },
            Some(receive),
            move |snapshot| {
                published.send(snapshot).unwrap();
            },
            |_| {},
        );
        let executor = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        executor.block_on(async {
            for index in 0..64 {
                let pause = index % 2 == 0;
                let confirmed = runtime
                    .control(
                        "one".into(),
                        if pause {
                            MediaAction::Pause
                        } else {
                            MediaAction::Play
                        },
                    )
                    .await
                    .unwrap();
                let expected = if pause {
                    PlaybackState::Paused
                } else {
                    PlaybackState::Playing
                };
                assert_eq!(confirmed.state.playback_state(), expected);
                assert_eq!(confirmed.revision, index + 1);
                tokio::task::yield_now().await;
                assert_eq!(runtime.snapshot().state.playback_state(), expected);
            }
        });
        // Check command ordering while the provider is live. Dropping its last
        // sender during shutdown can legitimately publish an unavailable state
        // before the aborted forwarder stops; that is not a command regression.
        let revisions: Vec<_> = events
            .try_iter()
            .map(|snapshot| snapshot.revision)
            .collect();
        assert_eq!(revisions, (1..=64).collect::<Vec<_>>());
        runtime.shutdown();
    }

    #[test]
    fn media_revisions_only_advance_for_changed_normalized_contents() {
        let mut snapshot = MediaSnapshot::new(MediaState::default());
        assert_eq!(snapshot.revision, 0);
        assert!(!snapshot.update(MediaState::default()));
        assert!(snapshot.update(playing("Track")));
        assert_eq!(snapshot.revision, 1);
        assert!(!snapshot.update(playing("Track")));
        assert_eq!(snapshot.revision, 1);
        let mut paused = playing("Track");
        paused.set_playback_state(PlaybackState::Paused);
        assert!(snapshot.update(paused));
        assert_eq!(snapshot.revision, 2);
        assert!(snapshot.update(playing("Next track")));
        assert_eq!(snapshot.revision, 3);
        assert!(snapshot.update(MediaState::empty(ProviderStatus::Ready)));
        assert_eq!(snapshot.revision, 4);
    }

    #[test]
    fn media_revision_is_an_envelope_field_and_reads_do_not_increment_it() {
        let runtime = MediaRuntime::with_provider(
            crate::media::UnavailableMediaProvider,
            None::<watch::Receiver<MediaState>>,
            |_| panic!("an unavailable provider must not emit events"),
            |_| panic!("an unavailable provider is not an initialization failure"),
        );
        let wire = serde_json::to_value(runtime.snapshot()).unwrap();
        assert_eq!(wire["revision"], 0);
        assert_eq!(wire["state"]["providerStatus"], "unavailable");
        assert!(wire["state"].get("revision").is_none());
        assert_eq!(runtime.snapshot().revision, 0);
        runtime.shutdown();
        runtime.shutdown();
    }

    #[test]
    fn media_player_changes_share_revisions_without_extending_media_state() {
        let mut update: MediaUpdate = playing("Track").into();
        update.player.session_id = Some("1".into());
        let mut snapshot = MediaSnapshot::new(update.clone());
        assert!(!snapshot.update(update.clone()));
        update.player.controls.pause = true;
        assert!(snapshot.update(update.clone()));
        assert_eq!(snapshot.revision, 1);
        update.player.artwork = Some(Arc::new(crate::media_player::MediaArtwork {
            data_url: "data:image/png;base64,example".into(),
        }));
        assert!(snapshot.update(update.clone()));
        assert_eq!(snapshot.revision, 2);
        assert!(!snapshot.update(update.clone()));
        update.player.timeline = crate::media_player::MediaTimeline::from_native(
            0,
            2_400_000_000,
            840_000_000,
            116_444_736_000_000_000,
            Some(1.0),
        );
        assert!(snapshot.update(update.clone()));
        assert_eq!(snapshot.revision, 3);
        assert!(!snapshot.update(update));
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire["player"]["controls"]["pause"], true);
        assert!(wire["state"].get("artwork").is_none());
        assert!(wire["state"].get("controls").is_none());
        assert!(snapshot.update(MediaState::empty(ProviderStatus::Ready)));
        assert_eq!(snapshot.revision, 4);
        assert_eq!(snapshot.player, MediaPlayerState::default());
    }

    #[test]
    fn media_forwarder_suppresses_duplicate_events_and_keeps_snapshot_current() {
        let (cache, provider) = test_provider();
        let updates = provider.updates.clone();
        let (events, received) = mpsc::channel();
        let runtime = MediaRuntime::with_provider(
            provider,
            Some(updates),
            move |event| events.send(event).unwrap(),
            |_| panic!("unexpected provider failure"),
        );
        cache.send_replace(playing("Track"));
        let first = received.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(runtime.snapshot().state, first.state);
        // send_replace deliberately notifies even for identical contents.
        cache.send_replace(playing("Track"));
        cache.send_replace(playing("Next track"));
        let second = received.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(second.revision, 2);
        assert_eq!(second.state, playing("Next track"));
        assert_eq!(runtime.snapshot().revision, 2);
        assert!(received.try_recv().is_err());
        runtime.shutdown();
    }

    #[test]
    fn media_forwarder_catches_changes_before_its_first_wait() {
        let (cache, provider) = test_provider();
        let updates = provider.updates.clone();
        let latest = Arc::new(Mutex::new(MediaSnapshot::new(provider.snapshot())));
        cache.send_replace(playing("Changed before task startup"));
        // A standalone forwarding future lets this test start deterministically.
        let (events, received) = mpsc::channel();
        let task = tauri::async_runtime::spawn(forward_changes(
            updates,
            latest.clone(),
            move |event| events.send(event).unwrap(),
            |_| panic!("unexpected provider failure"),
        ));
        let event = received.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(event.revision, 1);
        assert_eq!(event.state, playing("Changed before task startup"));
        task.abort();
        let _ = tauri::async_runtime::block_on(task);
        drop(cache);
    }

    #[test]
    fn media_startup_failure_is_unavailable_and_reports_the_native_error() {
        let (cache, provider) = test_provider();
        cache.send_replace(MediaState::failed("GSMTC acquisition failed".into()));
        drop(cache);
        let updates = provider.updates.clone();
        let (reports, received) = mpsc::channel();
        let runtime = MediaRuntime::with_provider(
            provider,
            Some(updates),
            |_| panic!("the initial unavailable state must not emit duplicates"),
            move |message| reports.send(message).unwrap(),
        );
        assert_eq!(
            runtime.snapshot().state,
            MediaState::empty(ProviderStatus::Unavailable)
        );
        assert!(received
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .contains("GSMTC acquisition failed"));
        assert_eq!(runtime.snapshot().revision, 0);
        runtime.shutdown();
    }

    #[test]
    fn media_provider_failure_after_startup_publishes_unavailable_state() {
        let (cache, provider) = test_provider();
        let updates = provider.updates.clone();
        let (events, received) = mpsc::channel();
        let (reports, reported) = mpsc::channel();
        let runtime = MediaRuntime::with_provider(
            provider,
            Some(updates),
            move |event| events.send(event).unwrap(),
            move |message| reports.send(message).unwrap(),
        );
        cache.send_replace(playing("Track"));
        assert_eq!(
            received
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .revision,
            1
        );
        cache.send_replace(MediaState::failed("WinRT initialization failed".into()));
        drop(cache);
        let mut revision = 1;
        loop {
            let event = received.recv_timeout(Duration::from_secs(2)).unwrap();
            assert_eq!(event.revision, revision + 1);
            revision = event.revision;
            if event.state == MediaState::empty(ProviderStatus::Unavailable) {
                break;
            }
        }
        assert!(reported
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .contains("WinRT initialization failed"));
        assert_eq!(runtime.snapshot().revision, revision);
        runtime.shutdown();
    }

    #[test]
    fn media_shutdown_and_drop_release_the_retained_provider() {
        let (_cache, provider) = test_provider();
        let dropped = provider.dropped.clone();
        let updates = provider.updates.clone();
        let runtime = MediaRuntime::with_provider(provider, Some(updates), |_| {}, |_| {});
        assert!(!dropped.load(Ordering::Acquire));
        runtime.shutdown();
        assert!(dropped.load(Ordering::Acquire));
        runtime.shutdown();

        let (_cache, provider) = test_provider();
        let dropped = provider.dropped.clone();
        let updates = provider.updates.clone();
        let runtime = MediaRuntime::with_provider(provider, Some(updates), |_| {}, |_| {});
        drop(runtime);
        assert!(dropped.load(Ordering::Acquire));
    }
}
