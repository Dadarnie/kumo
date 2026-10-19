// SPDX-License-Identifier: MIT
//! Spotify's own accessible slider. This never writes Windows mixer volume.
use super::{process_matches, Signals, VOLUME};
use ::windows::core::{implement, Interface, Ref, Result as WinResult, BOOL};
use ::windows::Win32::Foundation::{HWND, LPARAM};
use ::windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use ::windows::Win32::System::Variant::VARIANT;
use ::windows::Win32::UI::Accessibility::{
    CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationElement,
    IUIAutomationPropertyChangedEventHandler, IUIAutomationPropertyChangedEventHandler_Impl,
    IUIAutomationRangeValuePattern, TreeScope_Descendants, TreeScope_Element,
    UIA_RangeValuePatternId, UIA_RangeValueValuePropertyId, UIA_SliderControlTypeId,
    UIA_PROPERTY_ID,
};
use ::windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId};
use std::sync::{atomic::Ordering, Arc};

#[implement(IUIAutomationPropertyChangedEventHandler)]
struct VolumeChanged {
    signals: Arc<Signals>,
    generation: u64,
}
impl IUIAutomationPropertyChangedEventHandler_Impl for VolumeChanged_Impl {
    fn HandlePropertyChangedEvent(
        &self,
        _: Ref<'_, IUIAutomationElement>,
        _: UIA_PROPERTY_ID,
        _: &VARIANT,
    ) -> WinResult<()> {
        if self.signals.active_generation.load(Ordering::Acquire) == self.generation {
            self.signals.schedule(VOLUME);
        }
        Ok(())
    }
}

pub(in crate::windows::media) struct SpotifyVolume {
    client: IUIAutomation,
    element: IUIAutomationElement,
    range: IUIAutomationRangeValuePattern,
    changed: IUIAutomationPropertyChangedEventHandler,
}

unsafe extern "system" fn spotify_window(window: HWND, data: LPARAM) -> BOOL {
    let mut process = 0;
    unsafe {
        GetWindowThreadProcessId(window, Some(&mut process));
    }
    if process_matches("Spotify.exe", process) {
        unsafe { &mut *(data.0 as *mut Vec<HWND>) }.push(window);
    }
    BOOL(1)
}

impl SpotifyVolume {
    pub(super) fn find(signals: &Arc<Signals>, generation: u64) -> Option<Self> {
        unsafe {
            let client: IUIAutomation =
                CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER).ok()?;
            let limits: IUIAutomation2 = client.cast().ok()?;
            limits.SetConnectionTimeout(200).ok()?;
            limits.SetTransactionTimeout(200).ok()?;
            let mut windows = Vec::<HWND>::new();
            EnumWindows(
                Some(spotify_window),
                LPARAM(&mut windows as *mut _ as isize),
            )
            .ok()?;
            let condition = client.CreateTrueCondition().ok()?;
            let mut found = None;
            for window in windows {
                let Ok(root) = client.ElementFromHandle(window) else {
                    continue;
                };
                let Ok(elements) = root.FindAll(TreeScope_Descendants, &condition) else {
                    continue;
                };
                for index in 0..elements.Length().ok()?.min(2_000) {
                    let Ok(element) = elements.GetElement(index) else {
                        continue;
                    };
                    if element.CurrentControlType().ok()? != UIA_SliderControlTypeId {
                        continue;
                    }
                    let name = element.CurrentName().ok()?.to_string().to_lowercase();
                    if !["volume", "lautst", "音量", "볼륨", "громк"]
                        .iter()
                        .any(|label| name.contains(label))
                    {
                        continue;
                    }
                    let Ok(range) = element.GetCurrentPatternAs::<IUIAutomationRangeValuePattern>(
                        UIA_RangeValuePatternId,
                    ) else {
                        continue;
                    };
                    if range.CurrentIsReadOnly().ok()?.as_bool()
                        || range.CurrentMaximum().ok()? <= range.CurrentMinimum().ok()?
                    {
                        continue;
                    }
                    // Never guess if Spotify exposes several different volume sliders.
                    if found.is_some() {
                        return None;
                    }
                    found = Some((element, range));
                }
            }
            let (element, range) = found?;
            let changed: IUIAutomationPropertyChangedEventHandler = VolumeChanged {
                signals: signals.clone(),
                generation,
            }
            .into();
            client
                .AddPropertyChangedEventHandlerNativeArray(
                    &element,
                    TreeScope_Element,
                    None,
                    &changed,
                    &[UIA_RangeValueValuePropertyId],
                )
                .ok()?;
            Some(Self {
                client,
                element,
                range,
                changed,
            })
        }
    }

    pub(super) fn level(&self) -> WinResult<u16> {
        unsafe {
            let min = self.range.CurrentMinimum()?;
            let max = self.range.CurrentMaximum()?;
            Ok(((self.range.CurrentValue()? - min) / (max - min) * 100.0)
                .round()
                .clamp(0.0, 100.0) as u16)
        }
    }

    pub(super) fn set(&self, level: u16) -> Result<(), String> {
        if level > 100 {
            return Err("Volume must be between 0 and 100".into());
        }
        unsafe {
            let min = self.range.CurrentMinimum().map_err(|e| e.to_string())?;
            let max = self.range.CurrentMaximum().map_err(|e| e.to_string())?;
            // Chromium's range provider truncates to its reported small change.
            // A tiny interior epsilon keeps an exact step above float error.
            let epsilon = if level > 0 && level < 100 {
                (max - min) * 0.000001
            } else {
                0.0
            };
            let value = (min + (max - min) * f64::from(level) / 100.0 + epsilon).clamp(min, max);
            self.range.SetValue(value).map_err(|e| e.to_string())
        }
    }

    pub(super) fn step(&self) -> WinResult<u16> {
        unsafe {
            let span = self.range.CurrentMaximum()? - self.range.CurrentMinimum()?;
            let step = self.range.CurrentSmallChange()? / span * 100.0;
            Ok(if step.is_finite() && step > 0.0 {
                step.round().clamp(1.0, 100.0) as u16
            } else {
                1
            })
        }
    }
}

impl Drop for SpotifyVolume {
    fn drop(&mut self) {
        unsafe {
            let _ = self
                .client
                .RemovePropertyChangedEventHandler(&self.element, &self.changed);
        }
    }
}
