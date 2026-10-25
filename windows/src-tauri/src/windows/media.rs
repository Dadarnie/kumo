// SPDX-License-Identifier: MIT
//! GSMTC owns no Tauri/frontend state. All COM objects and registration tokens
//! live on one MTA worker; callbacks only coalesce signals into a bounded queue.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use ::windows::core::{IUnknown, Interface, Result as WinResult, RuntimeType};
use ::windows::Foundation::TypedEventHandler;
use ::windows::Media::Control::{
    CurrentSessionChangedEventArgs, GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionMediaProperties as MediaProperties,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as NativePlaybackState,
    MediaPropertiesChangedEventArgs, PlaybackInfoChangedEventArgs, SessionsChangedEventArgs,
    TimelinePropertiesChangedEventArgs,
};
use ::windows::Media::MediaPlaybackAutoRepeatMode as NativeRepeatMode;
use ::windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
use tokio::sync::watch;
use windows_future::{AsyncOperationCompletedHandler, IAsyncOperation};

use crate::media::{MediaProvider, MediaSession, MediaState, PlaybackState};
use crate::media_player::{
    authorize_action, ControlReceiver, ControlReply, MediaAction, MediaControls, MediaPlayerState,
    MediaSessionInfo, MediaTimeline, MediaUpdate, RepeatMode,
};
use tokio::sync::oneshot;

#[path = "media_artwork.rs"]
mod artwork;
use artwork::ArtworkRead;
#[path = "media_volume.rs"]
mod volume;
use volume::VolumeBinding;

const ASYNC_TIMEOUT: Duration = Duration::from_secs(3);
const SESSIONS: u32 = 1;
const CURRENT: u32 = 2;
const PLAYBACK: u32 = 4;
const METADATA: u32 = 8;
const COMPLETED: u32 = 16;
const COMMANDS: u32 = 32;
const TIMELINE: u32 = 64;
const VOLUME: u32 = 128;
const SELECTION: u32 = SESSIONS | CURRENT | PLAYBACK;

pub struct WindowsMediaProvider {
    updates: watch::Receiver<MediaUpdate>,
    signals: Arc<Signals>,
    worker: Option<JoinHandle<()>>,
    commands: SyncSender<ControlRequest>,
}

impl WindowsMediaProvider {
    /// Clone the existing change channel for the application transport layer.
    pub fn updates(&self) -> watch::Receiver<MediaUpdate> {
        self.updates.clone()
    }

    pub fn new() -> Self {
        let (cache, updates) = watch::channel(MediaUpdate::default());
        let (commands, requests) = mpsc::sync_channel(8);
        let (signals, receiver) = Signals::new();
        let worker_signals = signals.clone();
        let worker_cache = cache.clone();
        let worker = match thread::Builder::new()
            .name("mimo-media".into())
            .spawn(move || run_worker(worker_signals, receiver, requests, worker_cache))
        {
            Ok(worker) => Some(worker),
            Err(error) => {
                publish(&cache, MediaState::failed(format!("Media worker: {error}")));
                None
            }
        };
        Self {
            updates,
            signals,
            worker,
            commands,
        }
    }
}

impl MediaProvider for WindowsMediaProvider {
    fn snapshot(&self) -> MediaState {
        self.updates.borrow().state.clone()
    }

    fn update(&self) -> MediaUpdate {
        self.updates.borrow().clone()
    }

    fn control(&self, session_id: String, action: MediaAction) -> Result<ControlReceiver, String> {
        let (reply, receive) = oneshot::channel();
        self.commands
            .try_send(ControlRequest {
                session_id,
                action,
                reply,
            })
            .map_err(|_| "Media provider is busy or unavailable".to_string())?;
        self.signals.schedule(COMMANDS);
        Ok(receive)
    }
}

impl Drop for WindowsMediaProvider {
    fn drop(&mut self) {
        self.signals.stop();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn publish(cache: &watch::Sender<MediaUpdate>, next: impl Into<MediaUpdate>) -> bool {
    let next = next.into();
    cache.send_if_modified(|current| {
        if *current == next {
            return false;
        }
        *current = next;
        true
    })
}

struct Signals {
    wake: SyncSender<()>,
    flags: AtomicU32,
    stopping: AtomicBool,
    selection_epoch: AtomicU64,
    metadata_epoch: AtomicU64,
    active_generation: AtomicU64,
}

impl Signals {
    fn new() -> (Arc<Self>, Receiver<()>) {
        let (wake, receiver) = mpsc::sync_channel(1);
        (
            Arc::new(Self {
                wake,
                flags: AtomicU32::new(0),
                stopping: AtomicBool::new(false),
                selection_epoch: AtomicU64::new(0),
                metadata_epoch: AtomicU64::new(0),
                active_generation: AtomicU64::new(0),
            }),
            receiver,
        )
    }

    fn signal(&self, flags: u32) {
        if self.stopping.load(Ordering::Acquire) {
            return;
        }
        #[cfg(test)]
        if flags & SELECTION != 0 && std::env::var_os("MIMO_MEDIA_LIVE_TRACE").is_some() {
            eprintln!(
                "GSMTC event: SessionsChanged={}, CurrentSessionChanged={}, PlaybackInfoChanged={}",
                flags & SESSIONS != 0,
                flags & CURRENT != 0,
                flags & PLAYBACK != 0
            );
        }
        if flags & SELECTION != 0 {
            self.selection_epoch.fetch_add(1, Ordering::AcqRel);
        }
        if flags & METADATA != 0 {
            self.metadata_epoch.fetch_add(1, Ordering::AcqRel);
        }
        self.schedule(flags);
    }

    fn schedule(&self, flags: u32) {
        self.flags.fetch_or(flags, Ordering::Release);
        // A full queue already has a wake pending; flags retain every reason.
        let _ = self.wake.try_send(());
    }

    fn metadata_changed(&self, generation: u64) {
        if self.active_generation.load(Ordering::Acquire) == generation {
            self.signal(METADATA);
        }
    }

    fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
        let _ = self.wake.try_send(());
    }
}

struct Apartment;

impl Apartment {
    fn initialize() -> WinResult<Self> {
        // Success includes S_FALSE. Only successful initialization gets a guard.
        unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

/// Completion callbacks only mark readiness and wake the worker. GetResults,
/// Cancel, Close, and timeout handling all run on the worker, without .get().
struct Pending<T: RuntimeType + 'static> {
    operation: IAsyncOperation<T>,
    completed: Arc<AtomicBool>,
    deadline: Instant,
}

impl<T: RuntimeType + 'static> Pending<T> {
    fn new(operation: IAsyncOperation<T>, signals: Arc<Signals>) -> WinResult<Self> {
        let pending = Self {
            operation,
            completed: Arc::new(AtomicBool::new(false)),
            deadline: Instant::now() + ASYNC_TIMEOUT,
        };
        let completed = pending.completed.clone();
        pending
            .operation
            .SetCompleted(&AsyncOperationCompletedHandler::new(move |_, _| {
                completed.store(true, Ordering::Release);
                signals.signal(COMPLETED);
                Ok(())
            }))?;
        Ok(pending)
    }

    fn result(&self, now: Instant) -> Option<Result<T, String>> {
        if now >= self.deadline {
            Some(Err("WinRT media operation timed out".into()))
        } else if self.completed.load(Ordering::Acquire) {
            Some(
                self.operation
                    .GetResults()
                    .map_err(|error| error.to_string()),
            )
        } else {
            None
        }
    }
}

impl<T: RuntimeType + 'static> Drop for Pending<T> {
    fn drop(&mut self) {
        if !self.completed.load(Ordering::Acquire) {
            let _ = self.operation.Cancel();
        }
        let _ = self.operation.Close();
    }
}

/// RAII covers partially installed subscriptions and early error returns too.
struct Registration<T> {
    owner: T,
    token: i64,
    remove: fn(&T, i64) -> WinResult<()>,
}

impl<T> Drop for Registration<T> {
    fn drop(&mut self) {
        let _ = (self.remove)(&self.owner, self.token);
    }
}

struct ManagerSubscriptions {
    manager: SessionManager,
    _sessions: Registration<SessionManager>,
    _current: Registration<SessionManager>,
}

impl ManagerSubscriptions {
    fn new(manager: SessionManager, signals: &Arc<Signals>) -> WinResult<Self> {
        let changed = signals.clone();
        let token = manager.SessionsChanged(
            &TypedEventHandler::<_, SessionsChangedEventArgs>::new(move |_, _| {
                changed.signal(SESSIONS);
                Ok(())
            }),
        )?;
        let sessions = Registration {
            owner: manager.clone(),
            token,
            remove: SessionManager::RemoveSessionsChanged,
        };
        let changed = signals.clone();
        let token = manager.CurrentSessionChanged(&TypedEventHandler::<
            _,
            CurrentSessionChangedEventArgs,
        >::new(move |_, _| {
            changed.signal(CURRENT);
            Ok(())
        }))?;
        Ok(Self {
            _current: Registration {
                owner: manager.clone(),
                token,
                remove: SessionManager::RemoveCurrentSessionChanged,
            },
            _sessions: sessions,
            manager,
        })
    }
}

/// Canonical identity of an enumerated session, not SourceAppUserModelId. The
/// entry owns that IUnknown so its address cannot be reused while selected.
/// GetCurrentSession can return a different wrapper for the same remote session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SessionId(usize);

fn identity(session: &Session) -> WinResult<(SessionId, IUnknown)> {
    let unknown = session.cast::<IUnknown>()?;
    Ok((SessionId(unknown.as_raw() as usize), unknown))
}

struct SessionEntry {
    id: SessionId,
    session: Session,
    _identity: IUnknown,
    _playback: Registration<Session>,
    playback: PlaybackState,
    source_app_id: Option<String>,
    controls: MediaControls,
    shuffle: Option<bool>,
    repeat_mode: Option<RepeatMode>,
}

impl SessionEntry {
    fn new(session: Session, signals: &Arc<Signals>) -> WinResult<Self> {
        let (id, unknown) = identity(&session)?;
        let source_app_id = session
            .SourceAppUserModelId()
            .ok()
            .map(|value| value.to_string());
        let changed = signals.clone();
        let token = session.PlaybackInfoChanged(&TypedEventHandler::<
            _,
            PlaybackInfoChangedEventArgs,
        >::new(move |_, _| {
            changed.signal(PLAYBACK);
            Ok(())
        }))?;
        Ok(Self {
            id,
            _identity: unknown,
            _playback: Registration {
                owner: session.clone(),
                token,
                remove: Session::RemovePlaybackInfoChanged,
            },
            session,
            playback: PlaybackState::Unknown,
            source_app_id,
            controls: MediaControls::default(),
            shuffle: None,
            repeat_mode: None,
        })
    }
}

struct SelectedSession {
    id: SessionId,
    data: MediaSession,
    _metadata: Registration<Session>,
    _timeline: Registration<Session>,
    player: MediaPlayerState,
    shuffle_mode: ConfirmedMode<bool>,
    repeat_mode: ConfirmedMode<RepeatMode>,
    volume: Option<VolumeBinding>,
}

// Spotify can complete a mode command without updating its GSMTC readback.
// Keep the successful command until the source reports a different value.
struct ConfirmedMode<T> {
    reported: Option<T>,
    acknowledged: Option<T>,
}
impl<T: Copy + Eq> ConfirmedMode<T> {
    fn new(reported: Option<T>) -> Self {
        Self {
            reported,
            acknowledged: None,
        }
    }
    fn read(&mut self, reported: Option<T>) -> Option<T> {
        if reported != self.reported {
            self.acknowledged = None;
        }
        self.reported = reported;
        self.acknowledged.or(reported)
    }
    fn acknowledge(&mut self, value: T) {
        self.acknowledged = Some(value);
    }
}

struct ControlRequest {
    session_id: String,
    action: MediaAction,
    reply: oneshot::Sender<ControlReply>,
}
struct ControlOperation {
    pending: Pending<bool>,
    reply: oneshot::Sender<ControlReply>,
    session_id: String,
    expected: Option<PlaybackExpectation>,
}

#[derive(Clone, Copy, Debug)]
enum PlaybackExpectation {
    Playback(PlaybackState),
    Shuffle(bool),
    Repeat(RepeatMode),
}

impl PlaybackExpectation {
    fn confirmed(self, player: &MediaPlayerState, playback: PlaybackState) -> bool {
        match self {
            Self::Playback(expected) => playback == expected,
            Self::Shuffle(expected) => player.shuffle == Some(expected),
            Self::Repeat(expected) => player.repeat_mode == Some(expected),
        }
    }
}

struct PlaybackConfirmation {
    session_id: String,
    expected: PlaybackExpectation,
    reply: oneshot::Sender<ControlReply>,
    deadline: Instant,
}

#[derive(Clone, Copy)]
struct ReadVersion {
    session: SessionId,
    generation: u64,
    selection_epoch: u64,
    metadata_epoch: u64,
}

impl ReadVersion {
    fn matches(&self, selected: Option<SessionId>, generation: u64, signals: &Signals) -> bool {
        selected == Some(self.session)
            && generation == self.generation
            && self.selection_epoch == signals.selection_epoch.load(Ordering::Acquire)
            && self.metadata_epoch == signals.metadata_epoch.load(Ordering::Acquire)
    }

    fn matches_artwork(
        &self,
        selected: Option<SessionId>,
        generation: u64,
        signals: &Signals,
    ) -> bool {
        selected == Some(self.session)
            && generation == self.generation
            && self.metadata_epoch == signals.metadata_epoch.load(Ordering::Acquire)
    }
}

struct MetadataRead {
    version: ReadVersion,
    pending: Pending<MediaProperties>,
}

/// Match Windows' current-session wrapper back to an enumerated session. Prefer
/// exact identity; a source app is a safe fallback only with a single match.
/// Never merge multiple sessions from the same app into one identity.
fn resolve_current_session(
    available: &[(SessionId, Option<&str>)],
    current: SessionId,
    source_app_id: Option<&str>,
) -> Option<SessionId> {
    if available.iter().any(|(id, _)| *id == current) {
        return Some(current);
    }
    let source = source_app_id.filter(|source| !source.trim().is_empty())?;
    let mut matches = available.iter().filter(|(_, app)| *app == Some(source));
    let (id, _) = matches.next()?;
    matches.next().is_none().then_some(*id)
}

fn select_session(
    available: &[(SessionId, PlaybackState)],
    current: Option<SessionId>,
    previous: Option<SessionId>,
) -> Option<SessionId> {
    let playing = |id| {
        available
            .iter()
            .any(|&(candidate, status)| candidate == id && status == PlaybackState::Playing)
    };
    current
        .filter(|&id| playing(id))
        .or_else(|| previous.filter(|&id| playing(id)))
        .or_else(|| {
            available
                .iter()
                .find(|(_, status)| *status == PlaybackState::Playing)
                .map(|(id, _)| *id)
        })
        .or_else(|| current.filter(|id| available.iter().any(|(candidate, _)| candidate == id)))
        // Absence of a Windows current session does not mean session loss. Keep
        // a paused/unreadable selection only while it still exists in the list.
        .or_else(|| previous.filter(|id| available.iter().any(|(candidate, _)| candidate == id)))
        // Also support starting while media is already paused and Windows has
        // no current session. None is reserved for an empty session list.
        .or_else(|| available.first().map(|(id, _)| *id))
}

struct Worker {
    signals: Arc<Signals>,
    cache: watch::Sender<MediaUpdate>,
    pending_manager: Option<Pending<SessionManager>>,
    manager: Option<ManagerSubscriptions>,
    sessions: Vec<SessionEntry>,
    selected: Option<SelectedSession>,
    generation: u64,
    selection_epoch: u64,
    /// The session the notch follows: the app that most recently started
    /// playing, or the one you picked. Falls back to Windows' choice.
    pinned: Option<SessionId>,
    last_playback: Option<Vec<(SessionId, PlaybackState)>>,
    metadata: Option<MetadataRead>,
    artwork: Option<ArtworkRead>,
    control: Option<ControlOperation>,
    confirmation: Option<PlaybackConfirmation>,
}

fn run_worker(
    signals: Arc<Signals>,
    receiver: Receiver<()>,
    requests: Receiver<ControlRequest>,
    cache: watch::Sender<MediaUpdate>,
) {
    // Declared first, dropped last: release operations, tokens, and COM objects
    // before RoUninitialize, including on early errors and unwinding.
    let _apartment = match Apartment::initialize() {
        Ok(apartment) => apartment,
        Err(error) => {
            publish(
                &cache,
                MediaState::failed(format!("WinRT initialization: {error}")),
            );
            return;
        }
    };
    let mut worker = Worker {
        signals,
        cache,
        pending_manager: None,
        manager: None,
        sessions: Vec::new(),
        selected: None,
        generation: 0,
        selection_epoch: 0,
        pinned: None,
        last_playback: None,
        metadata: None,
        artwork: None,
        control: None,
        confirmation: None,
    };
    if let Err(error) = worker.run(receiver, requests) {
        publish(&worker.cache, MediaState::failed(error));
    }
}

impl Worker {
    fn run(
        &mut self,
        receiver: Receiver<()>,
        requests: Receiver<ControlRequest>,
    ) -> Result<(), String> {
        if self.signals.stopping.load(Ordering::Acquire) {
            return Ok(());
        }
        let operation = SessionManager::RequestAsync().map_err(|error| error.to_string())?;
        self.pending_manager =
            Some(Pending::new(operation, self.signals.clone()).map_err(|error| error.to_string())?);
        loop {
            if self.signals.stopping.load(Ordering::Acquire) {
                return Ok(());
            }
            let epoch = self.signals.selection_epoch.load(Ordering::Acquire);
            let flags = self.signals.flags.swap(0, Ordering::AcqRel);
            // Selection changes precede completions in the same batch. Epochs
            // also reject native events queued during synchronous reads.
            if self.manager.is_some() && flags & (SELECTION | METADATA | COMMANDS) != 0 {
                if flags & (SESSIONS | COMMANDS) != 0 {
                    if let Err(error) = self.refresh_sessions() {
                        self.read_failed(error);
                        continue;
                    }
                }
                if let Err(error) = self.refresh_selection(flags & METADATA != 0, epoch) {
                    self.read_failed(error);
                    continue;
                }
            }
            if flags & TIMELINE != 0 {
                self.refresh_timeline();
                self.publish_selected();
            }
            if flags & VOLUME != 0 {
                self.refresh_volume();
                self.publish_selected();
            }
            self.finish_reads()?;
            if self.signals.flags.load(Ordering::Acquire) & SELECTION != 0 {
                continue;
            }
            while let Ok(request) = requests.try_recv() {
                self.start_control(request);
            }
            if self.signals.flags.load(Ordering::Acquire) != 0 {
                continue;
            }
            let deadline = self
                .pending_manager
                .as_ref()
                .map(|pending| pending.deadline)
                .into_iter()
                .chain(self.metadata.as_ref().map(|read| read.pending.deadline))
                .chain(self.artwork.as_ref().map(ArtworkRead::deadline))
                .chain(
                    self.control
                        .as_ref()
                        .map(|operation| operation.pending.deadline),
                )
                .chain(
                    self.confirmation
                        .as_ref()
                        .map(|confirmation| confirmation.deadline),
                )
                .min();
            // No timer when idle. Timed waits exist only for outstanding requests.
            match deadline {
                Some(deadline) => match receiver
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                {
                    Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return Ok(()),
                },
                None => {
                    if receiver.recv().is_err() {
                        return Ok(());
                    }
                }
            }
        }
    }

    fn refresh_sessions(&mut self) -> WinResult<()> {
        let list = self.manager.as_ref().unwrap().manager.GetSessions()?;
        // Replace registrations on topology changes; retain selection metadata
        // when its canonical identity remains in the new list.
        let mut sessions = Vec::new();
        for index in 0..list.Size()? {
            sessions.push(SessionEntry::new(list.GetAt(index)?, &self.signals)?);
        }
        self.sessions = sessions;
        Ok(())
    }

    fn refresh_selection(&mut self, metadata_changed: bool, epoch: u64) -> WinResult<()> {
        for entry in &mut self.sessions {
            (
                entry.playback,
                entry.controls,
                entry.shuffle,
                entry.repeat_mode,
            ) = playback_details(&entry.session);
        }
        // A closed app's id can be reused by Windows; never keep pinning it.
        if let Some(pinned) = self.pinned {
            if !self.sessions.iter().any(|entry| entry.id == pinned) {
                self.pinned = None;
            }
        }
        // Follow the latest: an app that starts playing takes over the notch.
        if let Some(last) = &self.last_playback {
            for entry in &self.sessions {
                let was = last
                    .iter()
                    .find(|(id, _)| *id == entry.id)
                    .map(|(_, state)| *state);
                if entry.playback == PlaybackState::Playing && was != Some(PlaybackState::Playing) {
                    self.pinned = Some(entry.id);
                }
            }
        }
        self.last_playback = Some(
            self.sessions
                .iter()
                .map(|entry| (entry.id, entry.playback))
                .collect(),
        );
        let current = match self.manager.as_ref().unwrap().manager.GetCurrentSession() {
            Ok(session) => {
                let (id, _identity) = identity(&session)?;
                let source = session
                    .SourceAppUserModelId()
                    .ok()
                    .map(|value| value.to_string());
                #[cfg(test)]
                if std::env::var_os("MIMO_MEDIA_LIVE_TRACE").is_some() {
                    eprintln!("GSMTC native current: wrapper={id:?}, source={source:?}");
                }
                let identities: Vec<_> = self
                    .sessions
                    .iter()
                    .map(|entry| (entry.id, entry.source_app_id.as_deref()))
                    .collect();
                resolve_current_session(&identities, id, source.as_deref())
            }
            // windows-core 0.61 maps a successful null interface to Error::empty.
            // Real failures are provider errors, not "no selected session".
            Err(error) if error.code() == ::windows::core::Error::empty().code() => None,
            Err(error) => return Err(error),
        };
        let available: Vec<_> = self
            .sessions
            .iter()
            .filter(|entry| {
                !super::audio_devices::app_kind(entry.source_app_id.as_deref().unwrap_or(""))
                    .is_some_and(|(_, kind)| kind == "communication")
            })
            .map(|entry| (entry.id, entry.playback))
            .collect();
        let previous = self.selected.as_ref().map(|selected| selected.id);
        let next = self
            .pinned
            .filter(|id| available.iter().any(|(candidate, _)| candidate == id))
            .or_else(|| select_session(&available, current, previous));
        let session_list: Vec<MediaSessionInfo> = self
            .sessions
            .iter()
            .filter(|entry| available.iter().any(|(id, _)| *id == entry.id))
            .map(|entry| MediaSessionInfo {
                id: entry.id.0.to_string(),
                source_app_id: entry.source_app_id.clone(),
                playing: entry.playback == PlaybackState::Playing,
            })
            .collect();
        #[cfg(test)]
        if std::env::var_os("MIMO_MEDIA_LIVE_TRACE").is_some() {
            eprintln!(
                "GSMTC selection: current={current:?}, previous={previous:?}, next={next:?}, available={available:?}"
            );
            for entry in &self.sessions {
                eprintln!(
                    "GSMTC session {:?}: source={:?}, playback={:?}",
                    entry.id, entry.source_app_id, entry.playback
                );
            }
        }
        if epoch != self.signals.selection_epoch.load(Ordering::Acquire) {
            // An event may have been consumed in this batch after epoch was
            // sampled. Reschedule its work without inventing another OS version.
            self.signals.schedule(SESSIONS | METADATA);
            return Ok(());
        }
        let changed = next != previous;
        if changed {
            self.generation = self.generation.wrapping_add(1);
            self.signals
                .active_generation
                .store(self.generation, Ordering::Release);
            self.metadata = None;
            self.artwork = None;
            self.selected = None;
        }
        let Some(id) = next else {
            let mut state = MediaState::default();
            state.set_session(None);
            publish(&self.cache, state);
            return Ok(());
        };
        let entry = self.sessions.iter().find(|entry| entry.id == id).unwrap();
        if changed {
            let signals = self.signals.clone();
            let generation = self.generation;
            let token =
                entry.session.MediaPropertiesChanged(&TypedEventHandler::<
                    _,
                    MediaPropertiesChangedEventArgs,
                >::new(move |_, _| {
                    signals.metadata_changed(generation);
                    Ok(())
                }))?;
            let metadata_registration = Registration {
                owner: entry.session.clone(),
                token,
                remove: Session::RemoveMediaPropertiesChanged,
            };
            let timeline_signals = self.signals.clone();
            let timeline_token = entry
                .session
                .TimelinePropertiesChanged(&TypedEventHandler::<
                    _,
                    TimelinePropertiesChangedEventArgs,
                >::new(move |_, _| {
                    if timeline_signals.active_generation.load(Ordering::Acquire) == generation {
                        timeline_signals.schedule(TIMELINE);
                    }
                    Ok(())
                }))?;
            self.selected = Some(SelectedSession {
                id,
                data: MediaSession {
                    playback_state: entry.playback,
                    title: None,
                    artist: None,
                    album_title: None,
                    source_app_id: entry.source_app_id.clone(),
                },
                _metadata: metadata_registration,
                _timeline: Registration {
                    owner: entry.session.clone(),
                    token: timeline_token,
                    remove: Session::RemoveTimelinePropertiesChanged,
                },
                player: MediaPlayerState {
                    session_id: Some(self.generation.to_string()),
                    controls: entry.controls,
                    shuffle: entry.shuffle,
                    repeat_mode: entry.repeat_mode,
                    artwork: None,
                    timeline: None,
                    ..Default::default()
                },
                shuffle_mode: ConfirmedMode::new(entry.shuffle),
                repeat_mode: ConfirmedMode::new(entry.repeat_mode),
                volume: None,
            });
        } else {
            self.selected.as_mut().unwrap().data.playback_state = entry.playback;
            self.selected.as_mut().unwrap().player.controls = entry.controls;
            let selected = self.selected.as_mut().unwrap();
            selected.player.shuffle = selected.shuffle_mode.read(entry.shuffle);
            selected.player.repeat_mode = selected.repeat_mode.read(entry.repeat_mode);
        }
        if epoch != self.signals.selection_epoch.load(Ordering::Acquire) {
            self.signals.schedule(SESSIONS | METADATA);
            return Ok(());
        }
        self.selection_epoch = epoch;
        self.selected.as_mut().unwrap().player.sessions = session_list;
        self.refresh_volume();
        self.refresh_timeline();
        self.publish_selected();
        let stale = self
            .metadata
            .as_ref()
            .is_some_and(|read| !read.version.matches(next, self.generation, &self.signals));
        if changed || metadata_changed || stale {
            self.start_metadata();
        }
        Ok(())
    }

    fn refresh_volume(&mut self) {
        let Some(selected) = self.selected.as_mut() else {
            return;
        };
        // Keep Spotify's UIA subscription while dragging. Rediscovering its
        // window tree on every value notification stalls successive changes.
        if !selected.volume.as_ref().is_some_and(VolumeBinding::spotify) {
            selected.volume = selected
                .data
                .source_app_id
                .as_deref()
                .and_then(|source| VolumeBinding::find(source, &self.signals, self.generation));
        }
        selected.player.volume = selected
            .volume
            .as_ref()
            .and_then(|binding| binding.level().ok());
        selected.player.controls.volume = selected.player.volume.is_some();
        selected.player.volume_step = selected
            .volume
            .as_ref()
            .and_then(|binding| binding.step().ok());
        if selected.player.volume.is_none() {
            selected.volume = None;
        }
    }

    fn refresh_timeline(&mut self) {
        let Some(selected) = self.selected.as_mut() else {
            return;
        };
        let Some(entry) = self.sessions.iter().find(|entry| entry.id == selected.id) else {
            selected.player.timeline = None;
            return;
        };
        let session = &entry.session;
        selected.player.timeline = (|| -> WinResult<Option<MediaTimeline>> {
            let timeline = session.GetTimelineProperties()?;
            let rate = session
                .GetPlaybackInfo()
                .ok()
                .and_then(|info| info.PlaybackRate().ok())
                .and_then(|rate| rate.Value().ok());
            Ok(MediaTimeline::from_native(
                timeline.StartTime()?.Duration,
                timeline.EndTime()?.Duration,
                timeline.Position()?.Duration,
                timeline.LastUpdatedTime()?.UniversalTime,
                rate,
            ))
        })()
        .ok()
        .flatten();
    }

    fn start_metadata(&mut self) {
        self.metadata = None; // cancel/close any superseded operation on the worker
        self.artwork = None;
        let selected = self.selected.as_ref().unwrap();
        let version = ReadVersion {
            session: selected.id,
            generation: self.generation,
            selection_epoch: self.selection_epoch,
            metadata_epoch: self.signals.metadata_epoch.load(Ordering::Acquire),
        };
        let session = &self
            .sessions
            .iter()
            .find(|entry| entry.id == selected.id)
            .unwrap()
            .session;
        match session
            .TryGetMediaPropertiesAsync()
            .and_then(|operation| Pending::new(operation, self.signals.clone()))
        {
            Ok(pending) => self.metadata = Some(MetadataRead { version, pending }),
            Err(error) => eprintln!("[kumo] media properties: {error}"),
        }
    }

    fn finish_reads(&mut self) -> Result<(), String> {
        let now = Instant::now();
        if let Some(result) = self
            .pending_manager
            .as_ref()
            .and_then(|pending| pending.result(now))
        {
            self.pending_manager = None;
            self.manager = Some(
                ManagerSubscriptions::new(result?, &self.signals)
                    .map_err(|error| error.to_string())?,
            );
            self.signals.schedule(SESSIONS);
        }
        let selected = self.selected.as_ref().map(|selected| selected.id);
        if self.metadata.as_ref().is_some_and(|read| {
            !read
                .version
                .matches(selected, self.generation, &self.signals)
        }) {
            self.metadata = None;
            if self.selected.is_some() {
                self.signals.schedule(METADATA);
            }
        }
        if let Some(result) = self
            .metadata
            .as_ref()
            .and_then(|read| read.pending.result(now))
        {
            let read = self.metadata.take().unwrap();
            match result {
                Ok(properties) => {
                    let title = properties.Title().map(|value| value.to_string());
                    let artist = properties.Artist().map(|value| value.to_string());
                    let album = properties.AlbumTitle().map(|value| value.to_string());
                    if read.version.matches(
                        self.selected.as_ref().map(|selected| selected.id),
                        self.generation,
                        &self.signals,
                    ) {
                        let selected = self.selected.as_mut().unwrap();
                        let old = (
                            selected.data.title.clone(),
                            selected.data.artist.clone(),
                            selected.data.album_title.clone(),
                        );
                        apply_metadata(&mut selected.data, title, artist, album);
                        if old
                            != (
                                selected.data.title.clone(),
                                selected.data.artist.clone(),
                                selected.data.album_title.clone(),
                            )
                        {
                            selected.player.artwork = None;
                        }
                        match ArtworkRead::new(&properties, &self.signals, read.version) {
                            Ok(read) => {
                                if read.is_none() {
                                    selected.player.artwork = None;
                                }
                                self.artwork = read;
                            }
                            Err(error) => {
                                selected.player.artwork = None;
                                eprintln!("[kumo] artwork: {error}");
                            }
                        }
                        self.publish_selected();
                    } else {
                        self.signals.schedule(METADATA);
                    }
                }
                // Keep the last metadata for this identity, including while
                // paused. A new identity always starts with empty metadata.
                Err(error) => eprintln!("[kumo] media properties: {error}"),
            }
        }
        if self.artwork.as_ref().is_some_and(|read| {
            !read.version.matches_artwork(
                self.selected.as_ref().map(|session| session.id),
                self.generation,
                &self.signals,
            )
        }) {
            self.artwork = None;
        }
        if let Some(result) = self
            .artwork
            .as_mut()
            .and_then(|read| read.advance(now, &self.signals))
        {
            let read = self.artwork.take().unwrap();
            match result {
                Ok(artwork) => {
                    // A track event can arrive while ReadBytes completes. Guard
                    // again before committing the image, as with metadata.
                    if read.version.matches_artwork(
                        self.selected.as_ref().map(|session| session.id),
                        self.generation,
                        &self.signals,
                    ) {
                        let selected = self.selected.as_mut().unwrap();
                        selected.player.artwork = artwork;
                        self.publish_selected();
                    }
                }
                Err(error) => eprintln!("[kumo] artwork: {error}"),
            }
        }
        if let Some(result) = self
            .control
            .as_ref()
            .and_then(|operation| operation.pending.result(now))
        {
            let mut operation = self.control.take().unwrap();
            let result = result.and_then(|performed| {
                if performed {
                    Ok(())
                } else {
                    Err("The player could not perform that action".into())
                }
            });
            if result.is_ok() {
                if let Some(selected) = self.selected.as_mut().filter(|selected| {
                    selected.player.session_id.as_deref() == Some(operation.session_id.as_str())
                }) {
                    match operation.expected {
                        Some(PlaybackExpectation::Shuffle(value)) => {
                            selected.shuffle_mode.acknowledge(value);
                            selected.player.shuffle = Some(value);
                            operation.expected = None;
                        }
                        Some(PlaybackExpectation::Repeat(value)) => {
                            selected.repeat_mode.acknowledge(value);
                            selected.player.repeat_mode = Some(value);
                            operation.expected = None;
                        }
                        _ => {}
                    }
                    self.publish_selected();
                }
                self.signals.signal(PLAYBACK);
            }
            if let (Ok(()), Some(expected)) = (&result, operation.expected) {
                self.confirmation = Some(PlaybackConfirmation {
                    session_id: operation.session_id,
                    expected,
                    reply: operation.reply,
                    deadline: now + ASYNC_TIMEOUT,
                });
            } else {
                let _ = operation.reply.send(result);
            }
        }
        self.finish_confirmation(now);
        Ok(())
    }

    fn finish_confirmation(&mut self, now: Instant) {
        let Some(confirmation) = self.confirmation.as_ref() else {
            return;
        };
        let selected = self.selected.as_ref().filter(|selected| {
            selected.player.session_id.as_deref() == Some(&confirmation.session_id)
        });
        let confirmed = selected.is_some_and(|selected| {
            confirmation
                .expected
                .confirmed(&selected.player, selected.data.playback_state)
        });
        if confirmed || selected.is_none() || now >= confirmation.deadline {
            let confirmation = self.confirmation.take().unwrap();
            let result = if confirmed {
                Ok(())
            } else if selected.is_none() {
                Err("The media session changed; try again".into())
            } else {
                Err(
                    "The player did not confirm this change. Try again or use the player controls."
                        .into(),
                )
            };
            let _ = confirmation.reply.send(result);
        }
    }

    fn start_control(&mut self, request: ControlRequest) {
        if request.action == MediaAction::Select {
            let target = request
                .session_id
                .parse::<usize>()
                .ok()
                .map(SessionId)
                .filter(|id| self.sessions.iter().any(|entry| entry.id == *id));
            let result = match target {
                Some(id) => {
                    self.pinned = Some(id);
                    self.signals.signal(SELECTION);
                    Ok(())
                }
                None => Err("That app is no longer playing".into()),
            };
            let _ = request.reply.send(result);
            return;
        }
        // Re-resolve audio ownership before writing, including after topology changes.
        if matches!(request.action, MediaAction::Volume { .. }) {
            self.refresh_volume();
        }
        let mut expected = None;
        let result = (|| -> Result<Option<Pending<bool>>, String> {
            if self.control.is_some() || self.confirmation.is_some() {
                return Err("A media action is already in progress".into());
            }
            if self.selection_epoch != self.signals.selection_epoch.load(Ordering::Acquire) {
                return Err("The media session changed; try again".into());
            }
            let selected = self
                .selected
                .as_mut()
                .ok_or("No media session is available")?;
            let entry = self
                .sessions
                .iter()
                .find(|entry| entry.id == selected.id)
                .ok_or("The media session closed")?;
            let (playback, mut controls, shuffle, repeat_mode) = playback_details(&entry.session);
            controls.volume = selected.player.controls.volume;
            selected.player.controls = controls;
            selected.player.shuffle = selected.shuffle_mode.read(shuffle);
            selected.player.repeat_mode = selected.repeat_mode.read(repeat_mode);
            authorize_action(
                &request.session_id,
                selected.player.session_id.as_deref(),
                controls,
                request.action,
            )?;
            if matches!(
                playback,
                PlaybackState::None
                    | PlaybackState::Unknown
                    | PlaybackState::Closed
                    | PlaybackState::Changing
            ) {
                return Err("Playback information is unavailable".into());
            }
            let operation = match request.action {
                MediaAction::Select => unreachable!("handled before playback checks"),
                MediaAction::Previous => entry.session.TrySkipPreviousAsync(),
                MediaAction::Play => {
                    expected = Some(PlaybackExpectation::Playback(PlaybackState::Playing));
                    entry.session.TryPlayAsync()
                }
                MediaAction::Pause => {
                    expected = Some(PlaybackExpectation::Playback(PlaybackState::Paused));
                    entry.session.TryPauseAsync()
                }
                MediaAction::Next => entry.session.TrySkipNextAsync(),
                MediaAction::Shuffle { shuffle } => {
                    expected = Some(PlaybackExpectation::Shuffle(shuffle));
                    entry.session.TryChangeShuffleActiveAsync(shuffle)
                }
                MediaAction::Repeat { repeat_mode } => {
                    expected = Some(PlaybackExpectation::Repeat(repeat_mode));
                    entry
                        .session
                        .TryChangeAutoRepeatModeAsync(match repeat_mode {
                            RepeatMode::Off => NativeRepeatMode::None,
                            RepeatMode::List => NativeRepeatMode::List,
                            RepeatMode::Track => NativeRepeatMode::Track,
                        })
                }
                MediaAction::Seek { seek_ms } => {
                    let timeline = entry
                        .session
                        .GetTimelineProperties()
                        .map_err(|error| error.to_string())?;
                    let start = timeline
                        .StartTime()
                        .map_err(|error| error.to_string())?
                        .Duration;
                    let end = timeline
                        .EndTime()
                        .map_err(|error| error.to_string())?
                        .Duration;
                    let target = start
                        .checked_add(
                            (seek_ms as i64)
                                .checked_mul(10_000)
                                .ok_or("Playback position is invalid")?,
                        )
                        .ok_or("Playback position is invalid")?;
                    if target < start || target > end {
                        return Err("Playback position is outside this item".into());
                    }
                    entry.session.TryChangePlaybackPositionAsync(target)
                }
                MediaAction::Volume { volume } => {
                    let binding = selected
                        .volume
                        .as_ref()
                        .ok_or("App volume is unavailable")?;
                    binding.set(volume)?;
                    selected.player.volume = binding.level().ok();
                    return Ok(None);
                }
            }
            .map_err(|error| error.to_string())?;
            Pending::new(operation, self.signals.clone())
                .map(Some)
                .map_err(|error| error.to_string())
        })();
        self.publish_selected();
        match result {
            Ok(Some(pending)) => {
                self.control = Some(ControlOperation {
                    pending,
                    reply: request.reply,
                    session_id: request.session_id,
                    expected,
                })
            }
            Ok(None) => {
                let _ = request.reply.send(Ok(()));
            }
            Err(error) => {
                let _ = request.reply.send(Err(error));
            }
        }
    }

    fn publish_selected(&self) {
        let mut state = MediaState::default();
        state.set_session(self.selected.as_ref().map(|selected| selected.data.clone()));
        publish(
            &self.cache,
            MediaUpdate {
                state,
                player: self
                    .selected
                    .as_ref()
                    .map(|selected| selected.player.clone())
                    .unwrap_or_default(),
            },
        );
    }

    fn read_failed(&mut self, error: ::windows::core::Error) {
        self.metadata = None;
        self.artwork = None;
        if let Some(selected) = &mut self.selected {
            selected.data.playback_state = PlaybackState::Unknown;
            selected.player.controls = MediaControls::default();
            self.publish_selected();
        } else {
            publish(&self.cache, MediaState::failed(error.to_string()));
        }
        // Session removal can race an RPC. Keep the manager subscriptions alive
        // and recover on the next native event, without a retry/polling timer.
        eprintln!("[kumo] media refresh: {error}");
    }
}

fn apply_metadata(
    data: &mut MediaSession,
    title: WinResult<String>,
    artist: WinResult<String>,
    album: WinResult<String>,
) {
    // A successful blank value clears a field through Phase 1 normalization;
    // an unreadable property preserves its last value for this same session.
    if let Ok(value) = title {
        data.title = Some(value);
    }
    if let Ok(value) = artist {
        data.artist = Some(value);
    }
    if let Ok(value) = album {
        data.album_title = Some(value);
    }
}

fn playback_details(
    session: &Session,
) -> (
    PlaybackState,
    MediaControls,
    Option<bool>,
    Option<RepeatMode>,
) {
    let Ok(info) = session.GetPlaybackInfo() else {
        return (PlaybackState::Unknown, MediaControls::default(), None, None);
    };
    let playback = info
        .PlaybackStatus()
        .map(PlaybackState::from)
        .unwrap_or(PlaybackState::Unknown);
    let shuffle = info
        .IsShuffleActive()
        .ok()
        .and_then(|value| value.Value().ok());
    let repeat_mode = info
        .AutoRepeatMode()
        .ok()
        .and_then(|value| value.Value().ok())
        .and_then(|mode| match mode {
            NativeRepeatMode::None => Some(RepeatMode::Off),
            NativeRepeatMode::List => Some(RepeatMode::List),
            NativeRepeatMode::Track => Some(RepeatMode::Track),
            _ => None,
        });
    let controls = if matches!(playback, PlaybackState::Unknown | PlaybackState::Closed) {
        MediaControls::default()
    } else {
        info.Controls()
            .map(|controls| MediaControls {
                previous: controls.IsPreviousEnabled().unwrap_or(false),
                play: controls.IsPlayEnabled().unwrap_or(false),
                pause: controls.IsPauseEnabled().unwrap_or(false),
                next: controls.IsNextEnabled().unwrap_or(false),
                seek: controls.IsPlaybackPositionEnabled().unwrap_or(false),
                volume: false,
                shuffle: shuffle.is_some() && controls.IsShuffleEnabled().unwrap_or(false),
                repeat: repeat_mode.is_some() && controls.IsRepeatEnabled().unwrap_or(false),
            })
            .unwrap_or_default()
    };
    (playback, controls, shuffle, repeat_mode)
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.metadata = None;
        self.artwork = None;
        self.control = None;
        self.confirmation = None;
        self.selected = None;
        self.sessions.clear();
        self.manager = None;
        self.pending_manager = None;
    }
}

impl From<NativePlaybackState> for PlaybackState {
    fn from(value: NativePlaybackState) -> Self {
        match value {
            NativePlaybackState::Closed => Self::Closed,
            NativePlaybackState::Opened => Self::Opened,
            NativePlaybackState::Changing => Self::Changing,
            NativePlaybackState::Stopped => Self::Stopped,
            NativePlaybackState::Playing => Self::Playing,
            NativePlaybackState::Paused => Self::Paused,
            _ => Self::Unknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::ProviderStatus;

    #[test]
    fn playback_confirmation_requires_the_requested_native_state() {
        let mut mode = ConfirmedMode::new(Some(false));
        mode.acknowledge(true);
        assert_eq!(
            mode.read(Some(false)),
            Some(true),
            "Successful command survives stale readback"
        );
        mode.acknowledge(false);
        assert_eq!(
            mode.read(Some(false)),
            Some(false),
            "A second command can toggle back"
        );
        assert_eq!(
            mode.read(Some(true)),
            Some(true),
            "A changed source value becomes authoritative"
        );
        assert_eq!(
            mode.read(None),
            None,
            "Session capability loss clears acknowledged mode"
        );
        let mut modes = MediaPlayerState::default();
        assert!(!PlaybackExpectation::Shuffle(true).confirmed(&modes, PlaybackState::Playing));
        modes.shuffle = Some(false);
        modes.repeat_mode = Some(RepeatMode::List);
        assert!(!PlaybackExpectation::Shuffle(true).confirmed(&modes, PlaybackState::Playing));
        assert!(PlaybackExpectation::Shuffle(false).confirmed(&modes, PlaybackState::Playing));
        assert!(
            PlaybackExpectation::Repeat(RepeatMode::List).confirmed(&modes, PlaybackState::Playing)
        );
        assert!(!PlaybackExpectation::Repeat(RepeatMode::Track)
            .confirmed(&modes, PlaybackState::Playing));
        let player = MediaPlayerState::default();
        assert!(!PlaybackExpectation::Playback(PlaybackState::Paused)
            .confirmed(&player, PlaybackState::Playing));
        assert!(PlaybackExpectation::Playback(PlaybackState::Paused)
            .confirmed(&player, PlaybackState::Paused));
    }

    #[test]
    fn native_status_mapping_preserves_every_windows_state() {
        for (native, normalized) in [
            (NativePlaybackState::Closed, PlaybackState::Closed),
            (NativePlaybackState::Opened, PlaybackState::Opened),
            (NativePlaybackState::Changing, PlaybackState::Changing),
            (NativePlaybackState::Stopped, PlaybackState::Stopped),
            (NativePlaybackState::Playing, PlaybackState::Playing),
            (NativePlaybackState::Paused, PlaybackState::Paused),
            (NativePlaybackState(99), PlaybackState::Unknown),
        ] {
            assert_eq!(PlaybackState::from(native), normalized);
        }
    }

    #[test]
    fn selection_policy_uses_session_identity_and_all_fallbacks() {
        let (a, b, c) = (SessionId(1), SessionId(2), SessionId(3));
        let playing = [
            (a, PlaybackState::Playing),
            (b, PlaybackState::Playing),
            (c, PlaybackState::Paused),
        ];
        assert_eq!(select_session(&playing, Some(a), Some(b)), Some(a));
        assert_eq!(select_session(&playing, Some(c), Some(b)), Some(b));
        assert_eq!(
            select_session(&playing, Some(c), Some(SessionId(99))),
            Some(a)
        );
        let paused = [(a, PlaybackState::Unknown), (b, PlaybackState::Paused)];
        assert_eq!(select_session(&paused, Some(b), Some(a)), Some(b));
        assert_eq!(select_session(&paused, None, Some(b)), Some(b));
        assert_eq!(select_session(&[], Some(a), Some(b)), None);
    }

    #[test]
    fn communication_sessions_cannot_displace_playing_spotify() {
        let spotify = SessionId(1);
        let teams = SessionId(2);
        let sessions = [
            (spotify, "Spotify.exe", PlaybackState::Playing),
            (
                teams,
                "MSTeams_8wekyb3d8bbwe!MSTeams",
                PlaybackState::Playing,
            ),
        ];
        let media: Vec<_> = sessions
            .iter()
            .filter(|(_, source, _)| {
                !super::super::audio_devices::app_kind(source)
                    .is_some_and(|(_, kind)| kind == "communication")
            })
            .map(|(id, _, state)| (*id, *state))
            .collect();
        assert_eq!(
            select_session(&media, Some(teams), Some(spotify)),
            Some(spotify)
        );
    }

    #[test]
    fn current_session_wrapper_resolves_to_its_unique_enumerated_source() {
        let (game_bar, spotify, wrapper) = (SessionId(1), SessionId(2), SessionId(3));
        let identities = [
            (game_bar, Some("GameBar.App")),
            (spotify, Some("Spotify.exe")),
        ];
        let current = resolve_current_session(&identities, wrapper, Some("Spotify.exe"));
        assert_eq!(current, Some(spotify));
        let paused = [
            (game_bar, PlaybackState::Paused),
            (spotify, PlaybackState::Paused),
        ];
        assert_eq!(select_session(&paused, current, None), Some(spotify));
        // Windows current remains the fallback even if a different previous
        // session is paused; playing sessions still take priority above it.
        assert_eq!(
            select_session(&paused, current, Some(game_bar)),
            Some(spotify)
        );
    }

    #[test]
    fn current_session_matching_does_not_merge_sessions_from_the_same_app() {
        let (a, b, wrapper) = (SessionId(1), SessionId(2), SessionId(3));
        let identities = [(a, Some("Browser.App")), (b, Some("Browser.App"))];
        assert_eq!(
            resolve_current_session(&identities, a, Some("Browser.App")),
            Some(a)
        );
        assert_eq!(resolve_current_session(&identities, b, None), Some(b));
        assert_eq!(
            resolve_current_session(&identities, wrapper, Some("Browser.App")),
            None
        );
        assert_eq!(
            resolve_current_session(&identities, wrapper, Some("Other.App")),
            None
        );
        assert_eq!(
            resolve_current_session(&identities, wrapper, Some(" \t")),
            None
        );
        assert_eq!(resolve_current_session(&identities, wrapper, None), None);
    }

    #[test]
    fn playing_to_paused_retains_the_selected_session() {
        let spotify = SessionId(1);
        let selected = select_session(&[(spotify, PlaybackState::Playing)], Some(spotify), None);
        assert_eq!(selected, Some(spotify));
        assert_eq!(
            select_session(&[(spotify, PlaybackState::Paused)], None, selected),
            selected
        );
    }

    #[test]
    fn paused_to_playing_retains_the_selected_session() {
        let spotify = SessionId(1);
        let selected = select_session(&[(spotify, PlaybackState::Paused)], Some(spotify), None);
        assert_eq!(selected, Some(spotify));
        assert_eq!(
            select_session(
                &[(spotify, PlaybackState::Playing)],
                Some(spotify),
                selected
            ),
            selected
        );
    }

    #[test]
    fn playing_to_app_closed_clears_selection_even_with_a_stale_current_pointer() {
        let spotify = SessionId(1);
        let selected = select_session(&[(spotify, PlaybackState::Playing)], Some(spotify), None);
        assert_eq!(selected, Some(spotify));
        assert_eq!(select_session(&[], Some(spotify), selected), None);
        assert_eq!(select_session(&[], None, selected), None);
    }

    #[test]
    fn paused_to_app_closed_clears_selection_even_with_a_stale_current_pointer() {
        let spotify = SessionId(1);
        let selected = select_session(&[(spotify, PlaybackState::Paused)], Some(spotify), None);
        assert_eq!(selected, Some(spotify));
        assert_eq!(select_session(&[], Some(spotify), selected), None);
        assert_eq!(select_session(&[], None, selected), None);
    }

    #[test]
    fn paused_previous_session_survives_a_temporarily_absent_current_session() {
        let (other, spotify) = (SessionId(1), SessionId(2));
        let available = [
            (other, PlaybackState::Paused),
            (spotify, PlaybackState::Paused),
        ];
        assert_eq!(
            select_session(&available, None, Some(spotify)),
            Some(spotify)
        );
        // A replacement session must not inherit the closed session's identity.
        assert_eq!(
            select_session(&[(other, PlaybackState::Paused)], None, Some(spotify)),
            Some(other)
        );
    }

    #[test]
    fn another_playing_session_takes_priority_over_a_paused_previous_session() {
        let (spotify, other) = (SessionId(1), SessionId(2));
        let available = [
            (spotify, PlaybackState::Paused),
            (other, PlaybackState::Playing),
        ];
        assert_eq!(
            select_session(&available, Some(spotify), Some(spotify)),
            Some(other)
        );
        assert_eq!(select_session(&available, None, Some(spotify)), Some(other));
    }

    #[test]
    fn startup_can_select_a_paused_session_without_a_current_or_previous_session() {
        let spotify = SessionId(1);
        assert_eq!(
            select_session(&[(spotify, PlaybackState::Paused)], None, None),
            Some(spotify)
        );
    }

    #[test]
    fn an_unreadable_previous_session_remains_selected_as_unknown() {
        let spotify = SessionId(1);
        assert_eq!(
            select_session(&[(spotify, PlaybackState::Unknown)], None, Some(spotify)),
            Some(spotify)
        );
    }

    #[test]
    fn callback_bursts_coalesce_without_losing_reasons_or_shutdown() {
        let (signals, receiver) = Signals::new();
        for _ in 0..1000 {
            signals.signal(SESSIONS);
            signals.signal(PLAYBACK);
        }
        assert_eq!(receiver.try_iter().count(), 1);
        assert_eq!(signals.flags.swap(0, Ordering::AcqRel), SESSIONS | PLAYBACK);
        signals.signal(CURRENT);
        signals.stop();
        assert!(signals.stopping.load(Ordering::Acquire));
        assert_eq!(receiver.try_iter().count(), 1);
    }

    #[test]
    fn generation_guards_reject_session_switches_and_queued_events() {
        let (signals, _) = Signals::new();
        let version = ReadVersion {
            session: SessionId(1),
            generation: 1,
            selection_epoch: 0,
            metadata_epoch: 0,
        };
        assert!(version.matches(Some(SessionId(1)), 1, &signals));
        assert!(!version.matches(Some(SessionId(2)), 2, &signals));
        assert!(!version.matches(Some(SessionId(1)), 3, &signals)); // A -> B -> A
        signals.signal(CURRENT);
        assert!(!version.matches(Some(SessionId(1)), 1, &signals));
        signals.active_generation.store(2, Ordering::Release);
        signals.metadata_changed(1);
        assert_eq!(signals.metadata_epoch.load(Ordering::Acquire), 0);
        signals.metadata_changed(2);
        assert_eq!(signals.metadata_epoch.load(Ordering::Acquire), 1);
    }

    #[test]
    fn artwork_guards_retain_pause_reads_but_reject_other_tracks_and_sessions() {
        let (signals, _) = Signals::new();
        let version = ReadVersion {
            session: SessionId(1),
            generation: 1,
            selection_epoch: 0,
            metadata_epoch: 0,
        };
        signals.signal(PLAYBACK);
        assert!(version.matches_artwork(Some(SessionId(1)), 1, &signals));
        assert!(!version.matches_artwork(Some(SessionId(2)), 2, &signals));
        signals.signal(METADATA);
        assert!(!version.matches_artwork(Some(SessionId(1)), 1, &signals));
    }

    #[test]
    fn normalized_cache_only_notifies_when_contents_change() {
        let (cache, mut updates) = watch::channel(MediaUpdate::default());
        assert!(!publish(&cache, MediaState::default()));
        assert!(!updates.has_changed().unwrap());
        let ready = MediaState::empty(ProviderStatus::Ready);
        assert!(publish(&cache, ready.clone()));
        assert!(updates.has_changed().unwrap());
        updates.borrow_and_update();
        assert!(!publish(&cache, ready));
        assert!(!updates.has_changed().unwrap());
    }

    #[test]
    fn metadata_reads_preserve_unreadable_fields_and_normalize_blank_fields() {
        let mut data = MediaSession {
            playback_state: PlaybackState::Paused,
            title: Some("Previous title".into()),
            artist: Some("Previous artist".into()),
            album_title: Some("Previous album".into()),
            source_app_id: Some("source".into()),
        };
        apply_metadata(
            &mut data,
            Err(::windows::core::Error::empty()),
            Ok(" \t ".into()),
            Ok("New album".into()),
        );
        let mut state = MediaState::default();
        state.set_session(Some(data));
        let wire = serde_json::to_value(&state).unwrap();
        assert_eq!(wire["title"], "Previous title");
        assert!(wire["artist"].is_null());
        assert_eq!(wire["albumTitle"], "New album");
        assert_eq!(state.playback_state(), PlaybackState::Paused);
        assert!(!state.is_playing());
        state.set_session(None);
        let cleared = serde_json::to_value(state).unwrap();
        for field in ["title", "artist", "albumTitle", "sourceAppId"] {
            assert!(cleared[field].is_null());
        }
    }

    #[test]
    fn pending_operations_complete_or_timeout_without_blocking() {
        let _apartment = Apartment::initialize().unwrap();
        let (signals, _) = Signals::new();
        let ready = Pending::new(IAsyncOperation::ready(Ok(true)), signals.clone()).unwrap();
        assert_eq!(ready.result(Instant::now()).unwrap().unwrap(), true);
        let (release, wait) = mpsc::channel();
        let operation = IAsyncOperation::spawn(move || {
            wait.recv().unwrap();
            Ok(true)
        });
        let stalled = Pending::new(operation, signals).unwrap();
        assert!(stalled.result(Instant::now()).is_none());
        assert!(stalled.result(stalled.deadline).unwrap().is_err());
        drop(stalled);
        release.send(()).unwrap();
    }

    #[test]
    fn registrations_unregister_exactly_once() {
        let removed = Arc::new(AtomicU64::new(0));
        {
            let _registration = Registration {
                owner: removed.clone(),
                token: 7,
                remove: |owner, token| {
                    owner.fetch_add(token as u64, Ordering::AcqRel);
                    Ok(())
                },
            };
        }
        assert_eq!(removed.load(Ordering::Acquire), 7);
    }

    #[test]
    #[ignore = "requires an interactive Windows GSMTC service; run explicitly for a live smoke check"]
    fn live_supported_player_actions_restore_original_state() {
        let provider = WindowsMediaProvider::new();
        let mut updates = provider.updates();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            tokio::time::timeout(
                Duration::from_secs(5),
                updates.wait_for(|update| {
                    update.player.session_id.is_some()
                        && serde_json::to_value(&update.state).unwrap()["title"].is_string()
                }),
            )
            .await
            .unwrap()
            .unwrap();
        });
        let original = provider.update();
        let session_id = original.player.session_id.clone().unwrap();
        let mut perform = |action, predicate: &dyn Fn(&MediaUpdate) -> bool| {
            runtime.block_on(async {
                let reply = provider.control(session_id.clone(), action).unwrap();
                let result = tokio::time::timeout(Duration::from_secs(5), reply)
                    .await
                    .unwrap()
                    .unwrap();
                if let Err(error) = result {
                    assert!(
                        error.contains("did not confirm"),
                        "Unexpected native error: {error}"
                    );
                    println!("Live {action:?}: source failed confirmation; no fabricated state");
                    return false;
                }
                tokio::time::timeout(
                    Duration::from_secs(5),
                    updates.wait_for(|update| {
                        update.player.session_id.as_deref() == Some(&session_id)
                            && predicate(update)
                    }),
                )
                .await
                .unwrap()
                .unwrap();
                true
            })
        };
        if let Some(level) = original.player.volume.filter(|level| *level > 0) {
            if original.player.controls.volume {
                perform(MediaAction::Volume { volume: level - 1 }, &|update| {
                    update.player.volume == Some(level - 1)
                });
                perform(MediaAction::Volume { volume: level }, &|update| {
                    update.player.volume == Some(level)
                });
                println!(
                    "Live app volume: {level} -> {} -> {level} confirmed",
                    level - 1
                );
            }
        }
        if original.state.playback_state() == PlaybackState::Playing
            && original.player.controls.pause
        {
            perform(MediaAction::Pause, &|update| {
                update.state.playback_state() == PlaybackState::Paused
            });
            perform(MediaAction::Play, &|update| {
                update.state.playback_state() == PlaybackState::Playing
            });
            println!("Live pause/play confirmed and restored");
        }
        assert_eq!(provider.update().player.volume, original.player.volume);
    }

    #[test]
    #[ignore = "toggles real shuffle/repeat repeatedly and restores both; requires Spotify playback"]
    fn live_repeat_shuffle_repeated_clicks_restore_original_modes() {
        let provider = WindowsMediaProvider::new();
        let mut updates = provider.updates();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            tokio::time::timeout(
                Duration::from_secs(5),
                updates.wait_for(|update| {
                    update.player.controls.shuffle
                        && update.player.controls.repeat
                        && update.player.shuffle.is_some()
                        && update.player.repeat_mode.is_some()
                }),
            )
            .await
            .unwrap()
            .unwrap();
        });
        let original = provider.update().player;
        let session = original.session_id.clone().unwrap();
        let shuffle = original.shuffle.unwrap();
        let repeat_mode = original.repeat_mode.unwrap();
        let alternate = if repeat_mode == RepeatMode::Off {
            RepeatMode::List
        } else {
            RepeatMode::Off
        };
        let perform = |action| -> Result<(), String> {
            let start = Instant::now();
            let result = runtime.block_on(async {
                let reply = provider.control(session.clone(), action)?;
                tokio::time::timeout(Duration::from_secs(7), reply)
                    .await
                    .map_err(|_| "Native mode request did not settle".to_string())?
                    .map_err(|_| "Native mode request closed".to_string())?
            });
            let player = provider.update().player;
            println!(
                "Live {action:?}: {result:?} in {:?}, shuffle={:?}, repeat={:?}",
                start.elapsed(),
                player.shuffle,
                player.repeat_mode
            );
            result
        };
        let mut failure = None;
        for action in [
            MediaAction::Shuffle { shuffle: !shuffle },
            MediaAction::Shuffle { shuffle },
            MediaAction::Shuffle { shuffle: !shuffle },
            MediaAction::Shuffle { shuffle },
            MediaAction::Repeat {
                repeat_mode: alternate,
            },
            MediaAction::Repeat { repeat_mode },
            MediaAction::Repeat {
                repeat_mode: alternate,
            },
            MediaAction::Repeat { repeat_mode },
        ] {
            if let Err(error) = perform(action) {
                failure = Some(error);
                break;
            }
        }
        // Restore even when the investigation finds a failed confirmation.
        let restore_shuffle = perform(MediaAction::Shuffle { shuffle });
        let restore_repeat = perform(MediaAction::Repeat { repeat_mode });
        assert!(
            failure.is_none(),
            "Repeated mode request failed: {failure:?}"
        );
        assert!(restore_shuffle.is_ok() && restore_repeat.is_ok());
        assert_eq!(provider.update().player.shuffle, Some(shuffle));
        assert_eq!(provider.update().player.repeat_mode, Some(repeat_mode));
    }

    #[test]
    #[ignore = "requires an interactive Windows GSMTC service; run explicitly for a live smoke check"]
    fn live_provider_snapshot_and_shutdown() {
        // Optional assertions turn a manual smoke check into a failing regression
        // when run with MIMO_MEDIA_LIVE_EXPECT=playing or paused.
        let expected = std::env::var("MIMO_MEDIA_LIVE_EXPECT").ok();
        if let Some(expected) = &expected {
            assert!(matches!(expected.as_str(), "playing" | "paused"));
        }
        let provider = WindowsMediaProvider::new();
        let mut updates = provider.updates.clone();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let state = runtime.block_on(async {
            tokio::time::timeout(
                ASYNC_TIMEOUT + Duration::from_secs(2),
                updates.wait_for(|state| {
                    serde_json::to_value(&state.state).unwrap()["providerStatus"] != "initializing"
                }),
            )
            .await
            .unwrap()
            .unwrap()
            .clone()
        });
        let wire = serde_json::to_value(&state.state).unwrap();
        assert_eq!(
            wire["providerStatus"], "ready",
            "GSMTC acquisition failed: {wire}"
        );
        if state.state.playback_state() != PlaybackState::None {
            let _ = runtime.block_on(async {
                tokio::time::timeout(
                    ASYNC_TIMEOUT + Duration::from_secs(1),
                    updates.wait_for(|state| {
                        let wire = serde_json::to_value(&state.state).unwrap();
                        wire["title"].is_string()
                            && (expected.is_none()
                                || ["artist", "albumTitle"]
                                    .iter()
                                    .all(|field| wire[field].is_string()))
                    }),
                )
                .await
                .map(|result| result.map(|state| state.clone()))
            });
        }
        let latest = serde_json::to_value(provider.snapshot()).unwrap();
        println!(
            "Live GSMTC: playback={}, title available={}, artist available={}, album available={}",
            latest["playbackState"],
            latest["title"].is_string(),
            latest["artist"].is_string(),
            latest["albumTitle"].is_string()
        );
        let player = provider.update().player;
        println!(
            "Live GSMTC player: source={}, controls={:?}, app volume={:?}",
            latest["sourceAppId"], player.controls, player.volume
        );
        if std::env::var_os("MIMO_MEDIA_LIVE_TIMELINE").is_some() {
            runtime.block_on(async {
                tokio::time::timeout(
                    ASYNC_TIMEOUT + Duration::from_secs(1),
                    updates.wait_for(|update| {
                        update.player.timeline.is_some() && update.player.artwork.is_some()
                    }),
                )
                .await
                .unwrap()
                .unwrap();
            });
            let player = provider.update().player;
            println!(
                "Live GSMTC player: timeline={:?}, artwork available={}",
                player.timeline,
                player.artwork.is_some()
            );
            assert!(player.timeline.unwrap().duration_ms > 0);
        }
        if let Some(expected) = expected {
            assert_eq!(latest["playbackState"], expected);
            for field in ["title", "artist", "albumTitle"] {
                assert!(latest[field].is_string(), "Missing live {field}: {latest}");
            }
        }
        // Optional interactive sequence exercises the same retained provider's
        // native callbacks. A live test driver changes Spotify after each log.
        let sequence = std::env::var("MIMO_MEDIA_LIVE_SEQUENCE").unwrap_or_default();
        for expected in sequence.split(',').filter(|value| !value.is_empty()) {
            assert!(matches!(expected, "playing" | "paused"));
            let state = runtime.block_on(async {
                tokio::time::timeout(Duration::from_secs(15), async {
                    loop {
                        updates.changed().await.unwrap();
                        let state = updates.borrow_and_update().clone();
                        let wire = serde_json::to_value(&state.state).unwrap();
                        assert_ne!(state.state.playback_state(), PlaybackState::None);
                        for field in ["title", "artist", "albumTitle", "sourceAppId"] {
                            assert_eq!(
                                wire[field], latest[field],
                                "Live metadata changed: {field}"
                            );
                        }
                        if wire["playbackState"] == expected {
                            return state;
                        }
                    }
                })
                .await
                .expect("Expected native playback event was not received")
            });
            println!(
                "Live GSMTC transition: playback={}, metadata retained=true",
                serde_json::to_value(state.state).unwrap()["playbackState"]
            );
        }
        let start = Instant::now();
        drop(provider);
        assert!(start.elapsed() < ASYNC_TIMEOUT + Duration::from_secs(2));
    }
}
