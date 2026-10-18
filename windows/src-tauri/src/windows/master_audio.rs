// SPDX-License-Identifier: MIT
//! Core Audio endpoint control on its own MTA. Callbacks only enqueue a wake;
//! device binding, writes, reads and unregistering stay on this worker.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, SyncSender},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};

use tokio::sync::oneshot;
use windows::core::{implement, Result as WinResult, PCWSTR};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Media::Audio::Endpoints::{
    IAudioEndpointVolume, IAudioEndpointVolumeCallback, IAudioEndpointVolumeCallback_Impl,
};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, EDataFlow, ERole, IMMDeviceEnumerator, IMMNotificationClient,
    IMMNotificationClient_Impl, MMDeviceEnumerator, AUDIO_VOLUME_NOTIFICATION_DATA, DEVICE_STATE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};

use super::{update_audio, AudioAction, AudioLevel, AudioSnapshot, PublishAudio, PublishMeter};
use crate::windows::audio_devices as devices;

enum Message {
    Refresh,
    Control(AudioAction, oneshot::Sender<Result<AudioSnapshot, String>>),
    Stop,
}

struct Signals {
    commands: SyncSender<Message>,
    rebind: AtomicBool,
    meter_active: AtomicBool,
}
impl Signals {
    fn wake(&self, rebind: bool) {
        if rebind {
            self.rebind.store(true, Ordering::Release);
        }
        // A full queue already wakes the worker; no callback waits on a lock.
        let _ = self.commands.try_send(Message::Refresh);
    }
}

#[implement(IAudioEndpointVolumeCallback)]
struct VolumeEvents {
    signals: Arc<Signals>,
}
#[allow(non_snake_case)]
impl IAudioEndpointVolumeCallback_Impl for VolumeEvents_Impl {
    fn OnNotify(&self, _: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> WinResult<()> {
        self.signals.wake(false);
        Ok(())
    }
}

#[implement(IMMNotificationClient)]
struct DeviceEvents {
    signals: Arc<Signals>,
}
#[allow(non_snake_case)]
impl IMMNotificationClient_Impl for DeviceEvents_Impl {
    fn OnDeviceStateChanged(&self, _: &PCWSTR, _: DEVICE_STATE) -> WinResult<()> {
        self.signals.wake(true);
        Ok(())
    }
    fn OnDeviceAdded(&self, _: &PCWSTR) -> WinResult<()> {
        self.signals.wake(true);
        Ok(())
    }
    fn OnDeviceRemoved(&self, _: &PCWSTR) -> WinResult<()> {
        self.signals.wake(true);
        Ok(())
    }
    fn OnDefaultDeviceChanged(&self, flow: EDataFlow, role: ERole, _: &PCWSTR) -> WinResult<()> {
        if (flow == eRender || flow == eCapture) && role == eConsole {
            self.signals.wake(true);
        }
        Ok(())
    }
    fn OnPropertyValueChanged(&self, _: &PCWSTR, _: &PROPERTYKEY) -> WinResult<()> {
        self.signals.wake(true);
        Ok(())
    }
}

struct Endpoint {
    id: String,
    volume: IAudioEndpointVolume,
    events: IAudioEndpointVolumeCallback,
}
impl Endpoint {
    fn bind(enumerator: &IMMDeviceEnumerator, signals: &Arc<Signals>) -> WinResult<Self> {
        unsafe {
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
            let raw_id = device.GetId()?;
            let id = raw_id.to_string();
            CoTaskMemFree(Some(raw_id.0.cast()));
            let id = id?;
            let volume = device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)?;
            let events: IAudioEndpointVolumeCallback = VolumeEvents {
                signals: signals.clone(),
            }
            .into();
            volume.RegisterControlChangeNotify(&events)?;
            Ok(Self { id, volume, events })
        }
    }
    fn snapshot(&self) -> WinResult<AudioSnapshot> {
        unsafe {
            Ok(AudioSnapshot {
                available: true,
                device_id: Some(self.id.clone()),
                volume: (self.volume.GetMasterVolumeLevelScalar()?.clamp(0.0, 1.0) * 100.0).round()
                    as u16,
                muted: self.volume.GetMute()?.as_bool(),
                revision: 0,
                ..Default::default()
            })
        }
    }
    fn control(&self, action: &AudioAction) -> Result<(), String> {
        action.validate(&self.snapshot().map_err(|error| error.to_string())?)?;
        unsafe {
            if let Some(volume) = action.volume {
                self.volume
                    .SetMasterVolumeLevelScalar(volume as f32 / 100.0, std::ptr::null())
                    .map_err(|error| error.to_string())?;
            }
            if let Some(muted) = action.muted {
                self.volume
                    .SetMute(muted, std::ptr::null())
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }
}
impl Drop for Endpoint {
    fn drop(&mut self) {
        unsafe {
            let _ = self.volume.UnregisterControlChangeNotify(&self.events);
        }
    }
}

struct DeviceRegistration {
    enumerator: IMMDeviceEnumerator,
    events: IMMNotificationClient,
}
impl Drop for DeviceRegistration {
    fn drop(&mut self) {
        unsafe {
            let _ = self
                .enumerator
                .UnregisterEndpointNotificationCallback(&self.events);
        }
    }
}

pub(crate) struct AudioWorker {
    signals: Arc<Signals>,
    worker: Option<JoinHandle<()>>,
}
impl AudioWorker {
    #[cfg(test)]
    pub fn start(latest: Arc<Mutex<AudioSnapshot>>, publish: PublishAudio) -> Result<Self, String> {
        Self::start_meter(latest, publish, None)
    }
    pub fn start_meter(
        latest: Arc<Mutex<AudioSnapshot>>,
        publish: PublishAudio,
        meter: Option<PublishMeter>,
    ) -> Result<Self, String> {
        let (commands, receive) = mpsc::sync_channel(16);
        let signals = Arc::new(Signals {
            commands,
            rebind: AtomicBool::new(false),
            meter_active: AtomicBool::new(false),
        });
        let events = signals.clone();
        let worker = thread::Builder::new()
            .name("mimo-master-audio".into())
            .spawn(move || {
                if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
                    return;
                }
                let result = (|| -> WinResult<()> {
                    let enumerator: IMMDeviceEnumerator =
                        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
                    let notifications: IMMNotificationClient = DeviceEvents {
                        signals: events.clone(),
                    }
                    .into();
                    unsafe {
                        enumerator.RegisterEndpointNotificationCallback(&notifications)?;
                    }
                    let _registration = DeviceRegistration {
                        enumerator: enumerator.clone(),
                        events: notifications,
                    };
                    let mut endpoint = Endpoint::bind(&enumerator, &events).ok();
                    let can_switch = devices::can_switch();
                    let inventory = std::cell::RefCell::new((
                        std::time::Instant::now() - std::time::Duration::from_secs(2),
                        Vec::new(),
                        Vec::new(),
                        Vec::new(),
                    ));
                    let meters = std::cell::RefCell::new(std::collections::BTreeMap::new());
                    let read = |endpoint: &Option<Endpoint>| {
                        let mut snapshot = endpoint
                            .as_ref()
                            .and_then(|endpoint| endpoint.snapshot().ok())
                            .unwrap_or_default();
                        let mut inventory = inventory.borrow_mut();
                        if inventory.0.elapsed() >= std::time::Duration::from_secs(1) {
                            let (outputs, sessions) =
                                devices::inspect(&enumerator).unwrap_or_default();
                            *meters.borrow_mut() =
                                crate::windows::audio_sessions::app_meters(&enumerator);
                            *inventory = (
                                std::time::Instant::now(),
                                outputs,
                                sessions,
                                devices::endpoints(&enumerator, eCapture).unwrap_or_default(),
                            );
                        }
                        snapshot.outputs = inventory.1.clone();
                        snapshot.sessions = inventory.2.clone();
                        snapshot.can_switch_output = can_switch;
                        snapshot.inputs = inventory.3.clone();
                        snapshot.input_id = devices::input_id(&enumerator);
                        snapshot.can_switch_input = can_switch;
                        snapshot
                    };
                    update_audio(&latest, read(&endpoint), &publish);
                    let mut meter_revision = 0u64;
                    let mut meter_at =
                        std::time::Instant::now() - std::time::Duration::from_secs(2);
                    let mut metering = false;
                    loop {
                        let sample_peaks = events.meter_active.load(Ordering::Acquire);
                        if let Some(publish_meter) = meter.as_ref().filter(|_| sample_peaks) {
                            if meter_at.elapsed() >= std::time::Duration::from_millis(50) {
                                let meters = meters.borrow();
                                let mut sources = std::collections::BTreeMap::new();
                                for (source, meters) in meters.iter() {
                                    let peak = meters
                                        .iter()
                                        .filter_map(|value| unsafe { value.GetPeakValue().ok() })
                                        .filter(|value| value.is_finite())
                                        .reduce(f32::max);
                                    if let Some(peak) = peak {
                                        sources.insert(
                                            source.clone(),
                                            (peak.clamp(0.0, 1.0) * 1000.0).round() as u16,
                                        );
                                    }
                                }
                                let available = !sources.is_empty();
                                if available || metering {
                                    meter_revision += 1;
                                    let peak = sources.values().copied().max().unwrap_or(0);
                                    publish_meter(AudioLevel {
                                        revision: meter_revision,
                                        available,
                                        peak,
                                        sources,
                                    });
                                }
                                metering = available;
                                meter_at = std::time::Instant::now();
                            }
                        }
                        // Core Audio exposes active sessions without GSMTC metadata.
                        // One worker scans them; views never start their own pollers.
                        let message = match receive.recv_timeout(
                            if meter.is_some() && sample_peaks && !meters.borrow().is_empty() {
                                std::time::Duration::from_millis(50)
                            } else {
                                std::time::Duration::from_secs(1)
                            },
                        ) {
                            Ok(message) => message,
                            Err(mpsc::RecvTimeoutError::Timeout) => {
                                if inventory.borrow().0.elapsed()
                                    < std::time::Duration::from_secs(1)
                                {
                                    continue;
                                }
                                Message::Refresh
                            }
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        };
                        if matches!(message, Message::Stop) {
                            break;
                        }
                        if events.rebind.swap(false, Ordering::AcqRel) || endpoint.is_none() {
                            endpoint = Endpoint::bind(&enumerator, &events).ok();
                            inventory.borrow_mut().0 =
                                std::time::Instant::now() - std::time::Duration::from_secs(2);
                        }
                        if let Message::Control(action, reply) = message {
                            if let Some(device) =
                                action.output_id.as_ref().or(action.input_id.as_ref())
                            {
                                let result = action.validate(&read(&endpoint)).and_then(|_| {
                                    if action.input_id.is_some() {
                                        devices::switch_input(&enumerator, device)
                                    } else {
                                        devices::switch(&enumerator, device)
                                    }
                                });
                                endpoint = Endpoint::bind(&enumerator, &events).ok();
                                inventory.borrow_mut().0 =
                                    std::time::Instant::now() - std::time::Duration::from_secs(2);
                                let confirmed = update_audio(&latest, read(&endpoint), &publish);
                                let result = result.and_then(|_| {
                                    if (if action.input_id.is_some() {
                                        &confirmed.input_id
                                    } else {
                                        &confirmed.device_id
                                    })
                                    .as_ref()
                                        == Some(device)
                                    {
                                        Ok(confirmed)
                                    } else {
                                        Err("Windows did not confirm the device change".into())
                                    }
                                });
                                let _ = reply.send(result);
                                continue;
                            }
                            // Check the default endpoint again before every write, guarding
                            // the race where a device callback has not arrived yet.
                            let fresh = Endpoint::bind(&enumerator, &events).ok();
                            if fresh.as_ref().map(|e| &e.id) != endpoint.as_ref().map(|e| &e.id) {
                                endpoint = fresh;
                            }
                            let current = read(&endpoint);
                            let result = endpoint
                                .as_ref()
                                .ok_or_else(|| "Windows audio is unavailable".to_string())
                                .and_then(|endpoint| {
                                    if action.session_id.is_some() {
                                        action.validate(&current)?;
                                        crate::windows::audio_sessions::control(
                                            &enumerator,
                                            &action,
                                        )
                                    } else {
                                        endpoint.control(&action)
                                    }
                                });
                            inventory.borrow_mut().0 =
                                std::time::Instant::now() - std::time::Duration::from_secs(2);
                            let confirmed = update_audio(&latest, read(&endpoint), &publish);
                            let _ = reply.send(result.map(|_| confirmed));
                        } else {
                            update_audio(&latest, read(&endpoint), &publish);
                        }
                    }
                    Ok(())
                })();
                if let Err(error) = result {
                    crate::log::line(format!("Windows audio worker: {error}"));
                }
                update_audio(&latest, AudioSnapshot::default(), &publish);
                unsafe {
                    CoUninitialize();
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            signals,
            worker: Some(worker),
        })
    }
    pub fn control(
        &self,
        action: AudioAction,
    ) -> Result<oneshot::Receiver<Result<AudioSnapshot, String>>, String> {
        let (reply, receive) = oneshot::channel();
        self.signals
            .commands
            .try_send(Message::Control(action, reply))
            .map_err(|_| "Windows audio is busy or stopped".to_string())?;
        Ok(receive)
    }

    pub fn set_meter_active(&self, active: bool) {
        if self.signals.meter_active.swap(active, Ordering::AcqRel) != active {
            // Wake immediately when a waveform appears; volume/device callbacks
            // and the one-second inventory scan keep their existing lifecycle.
            self.signals.wake(false);
        }
    }
}
impl Drop for AudioWorker {
    fn drop(&mut self) {
        let _ = self.signals.commands.send(Message::Stop);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    #[ignore = "reads real Windows endpoint/session inventory; requires an interactive desktop"]
    fn live_audio_inventory() {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
        }
        let result = (|| -> WinResult<()> {
            let enumerator: IMMDeviceEnumerator =
                unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
            let (outputs, sessions) = devices::inspect(&enumerator)?;
            let inputs = devices::endpoints(&enumerator, eCapture)?;
            println!(
                "Outputs: {:?}; inputs: {:?}; sessions: {:?}",
                outputs, inputs, sessions
            );
            assert!(outputs
                .iter()
                .all(|item| !item.id.is_empty() && !item.name.is_empty()));
            assert!(inputs
                .iter()
                .all(|item| !item.id.is_empty() && !item.name.is_empty()));
            for session in sessions {
                if session.can_control {
                    assert!(session.volume.is_some_and(|level| level <= 100));
                    assert!(session.muted.is_some());
                }
                assert!(!session.id.is_empty() && !session.name.is_empty());
            }
            Ok(())
        })();
        unsafe {
            CoUninitialize();
        }
        result.unwrap();
    }

    #[test]
    #[ignore = "changes the real Windows master volume briefly and restores it; requires an interactive desktop"]
    fn live_master_audio_commands_external_notifications_and_volume_keys() {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
        }
        struct Com;
        impl Drop for Com {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        let _com = Com;
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).unwrap() };
        let (commands, _receive) = mpsc::sync_channel(16);
        let signals = Arc::new(Signals {
            commands,
            rebind: AtomicBool::new(false),
            meter_active: AtomicBool::new(false),
        });
        let external =
            Endpoint::bind(&enumerator, &signals).expect("a default Windows output is required");
        struct Restore {
            volume: IAudioEndpointVolume,
            scalar: f32,
            muted: bool,
        }
        impl Drop for Restore {
            fn drop(&mut self) {
                unsafe {
                    let _ = self
                        .volume
                        .SetMasterVolumeLevelScalar(self.scalar, std::ptr::null());
                    let _ = self.volume.SetMute(self.muted, std::ptr::null());
                }
            }
        }
        let _restore = Restore {
            volume: external.volume.clone(),
            scalar: unsafe { external.volume.GetMasterVolumeLevelScalar().unwrap() },
            muted: unsafe { external.volume.GetMute().unwrap().as_bool() },
        };
        let latest = Arc::new(Mutex::new(AudioSnapshot::default()));
        let (send, receive) = mpsc::channel();
        let worker = AudioWorker::start(
            latest.clone(),
            Arc::new(move |snapshot| {
                let _ = send.send(snapshot);
            }),
        )
        .unwrap();
        let wait = |volume: u16, muted: bool| {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let snapshot = latest.lock().unwrap().clone();
                if snapshot.available && snapshot.volume == volume && snapshot.muted == muted {
                    return snapshot;
                }
                receive
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .expect("endpoint notification timed out");
            }
        };
        receive.recv_timeout(Duration::from_secs(3)).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let control = |volume, muted| {
            runtime.block_on(async {
                let reply = worker
                    .control(AudioAction {
                        device_id: external.id.clone(),
                        volume,
                        muted,
                        ..Default::default()
                    })
                    .unwrap();
                tokio::time::timeout(Duration::from_secs(3), reply)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap()
            })
        };
        assert_eq!(control(Some(50), Some(false)).volume, 50);
        assert_eq!(control(Some(48), Some(false)).volume, 48);
        assert_eq!(control(Some(50), Some(false)).volume, 50);
        assert!(control(None, Some(true)).muted);
        let unmuted = control(None, Some(false));
        assert!(!unmuted.muted);
        assert_eq!(unmuted.volume, 50);
        // A second Core Audio client exercises the same notifications as Quick Settings.
        external
            .control(&AudioAction {
                device_id: external.id.clone(),
                volume: Some(52),
                muted: Some(false),
                ..Default::default()
            })
            .unwrap();
        let changed = wait(52, false);
        assert!(changed.revision > unmuted.revision);
        external
            .control(&AudioAction {
                device_id: external.id.clone(),
                volume: None,
                muted: Some(true),
                ..Default::default()
            })
            .unwrap();
        wait(52, true);
        external
            .control(&AudioAction {
                device_id: external.id.clone(),
                volume: None,
                muted: Some(false),
                ..Default::default()
            })
            .unwrap();
        wait(52, false);
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            keybd_event, KEYEVENTF_KEYUP, VK_VOLUME_DOWN, VK_VOLUME_UP,
        };
        unsafe {
            keybd_event(VK_VOLUME_DOWN.0 as u8, 0, Default::default(), 0);
            keybd_event(VK_VOLUME_DOWN.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        }
        wait(50, false);
        unsafe {
            keybd_event(VK_VOLUME_UP.0 as u8, 0, Default::default(), 0);
            keybd_event(VK_VOLUME_UP.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        }
        wait(52, false);
        println!("Live Windows master audio: up/down, mute/unmute, external endpoint changes and keyboard volume keys confirmed; original scalar and mute restored on exit.");
        drop(worker);
    }
}
