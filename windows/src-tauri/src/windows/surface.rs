// SPDX-License-Identifier: MIT
//! Keep WebView2's transparent rendering surface fixed; change only its native clip.

#[cfg(test)]
use crate::island::PANEL_H;
use crate::island::{IslandRect, PANEL_W};
use crate::settings::IslandVisibility;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tauri::WebviewWindow;
use windows::core::BOOL;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{
    DwmEnableBlurBehindWindow, DWM_BB_BLURREGION, DWM_BB_ENABLE, DWM_BLURBEHIND,
};
use windows::Win32::Graphics::Gdi::{CreateRectRgn, DeleteObject, SetWindowRgn, HGDIOBJ};

/// A layered click-through toggle resets the transparent host's DWM alpha.
/// The empty blur region restores transparency without adding another blur.
pub(super) fn restore_alpha(hwnd: HWND) -> windows::core::Result<()> {
    unsafe {
        let region = CreateRectRgn(0, 0, -1, -1);
        if region.0.is_null() {
            return Err(windows::core::Error::from_win32());
        }
        let result = DwmEnableBlurBehindWindow(
            hwnd,
            &DWM_BLURBEHIND {
                dwFlags: DWM_BB_ENABLE | DWM_BB_BLURREGION,
                fEnable: BOOL(1),
                hRgnBlur: region,
                fTransitionOnMaximized: BOOL(0),
            },
        );
        let _ = DeleteObject(HGDIOBJ(region.0));
        result
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Mask {
    Full,
    Rect(i32, i32, i32, i32),
}

fn window_mask(visibility: IslandVisibility, rect: IslandRect, scale: f64) -> Mask {
    if visibility == IslandVisibility::Expanded {
        return Mask::Full;
    }
    if visibility == IslandVisibility::Peek {
        // Clip immediately, even if the DOM still reports its expanded animation.
        // Neither the old surface nor its shadow may cover Chrome's tab row.
        let left = (((PANEL_W - crate::island::PEEK_W) / 2.0) * scale).round() as i32;
        return Mask::Rect(
            left,
            0,
            left + (crate::island::PEEK_W * scale).round() as i32,
            (crate::island::PEEK_H * scale).round() as i32,
        );
    }
    let (rest_w, rest_h) = crate::island::logical_size(visibility);
    // The DOM can still be expanded while a collapse is in flight. Keep its
    // entire animated shell until it settles, instead of cutting a rectangle
    // through the curves while the shell is still visible.
    let w = if rect.w > rest_w {
        rect.w + 32.0
    } else {
        rest_w
    };
    let h = if rect.h > rest_h {
        rect.h + 16.0
    } else {
        rest_h
    };
    let center = if rect.w > 0.0 {
        rect.x + rect.w / 2.0
    } else {
        PANEL_W / 2.0
    };
    // A held companion can extend the temporary backing surface beyond PANEL_W.
    // Windows clips this region to the actual host; do not cut off the old shell.
    let left = ((center - w / 2.0).max(0.0) * scale).round() as i32;
    let top = ((rect.y - 2.0).max(0.0) * scale).floor() as i32;
    Mask::Rect(
        left,
        top,
        left + (w * scale).round() as i32,
        top + (h * scale).round() as i32,
    )
}

pub(crate) struct NativeSurface {
    pub queued: AtomicBool,
    mask: Mutex<Option<Mask>>,
}

impl NativeSurface {
    pub fn new() -> Self {
        Self {
            queued: AtomicBool::new(false),
            mask: Mutex::new(None),
        }
    }

    pub fn invalidate_window_style(&self) {
        *self.mask.lock().unwrap() = None;
    }

    pub fn update(&self, win: &WebviewWindow, visibility: IslandVisibility, rect: IslandRect) {
        let scale = win.scale_factor().unwrap_or(1.0);
        let mask = window_mask(visibility, rect, scale);
        let Some(hwnd) = super::hwnd_of(win) else {
            return;
        };
        let mut previous = self.mask.lock().unwrap();
        if super::remove_native_frame(hwnd) {
            *previous = None;
        }
        if previous.is_none() {
            if let Err(error) = restore_alpha(hwnd) {
                crate::log::line(format!("island transparency: {error}"));
            }
        }
        if previous.as_ref() != Some(&mask) && apply_mask(hwnd, &mask) {
            *previous = Some(mask);
        }
    }
}

fn apply_mask(hwnd: HWND, mask: &Mask) -> bool {
    unsafe {
        let region = match mask {
            Mask::Full => return SetWindowRgn(hwnd, None, true) != 0,
            Mask::Rect(left, top, right, bottom) => CreateRectRgn(*left, *top, *right, *bottom),
        };
        if region.0.is_null() {
            return false;
        }
        // Windows owns the region after success; retain no handles between frames.
        if SetWindowRgn(hwnd, Some(region), true) == 0 {
            let _ = DeleteObject(HGDIOBJ(region.0));
            return false;
        }
        true
    }
}

#[cfg(test)]
fn shell_points(rect: IslandRect, scale: f64) -> Vec<(i32, i32)> {
    let w = rect.w.clamp(1.0, PANEL_W);
    let h = rect.h.clamp(1.0, PANEL_H);
    let edge = 8.0f64.min(w / 4.0);
    let corner = rect.radius.clamp(0.0, h / 2.0).min(w / 2.0 - edge);
    let mut path = vec![(0.0, 0.0), (w, 0.0)];
    fn quadratic(path: &mut Vec<(f64, f64)>, control: (f64, f64), end: (f64, f64)) {
        let start = *path.last().unwrap();
        for step in 1..=8 {
            let t = step as f64 / 8.0;
            let a = 1.0 - t;
            path.push((
                a * a * start.0 + 2.0 * a * t * control.0 + t * t * end.0,
                a * a * start.1 + 2.0 * a * t * control.1 + t * t * end.1,
            ));
        }
    }
    quadratic(&mut path, (w - 2.0, 0.0), (w - 4.0, 3.0));
    path.push((w - 6.0, 5.0));
    quadratic(&mut path, (w - edge, 7.0), (w - edge, 11.0));
    path.push((w - edge, (h - corner).max(11.0)));
    quadratic(&mut path, (w - edge, h), (w - edge - corner, h));
    path.push((edge + corner, h));
    quadratic(&mut path, (edge, h), (edge, (h - corner).max(11.0)));
    path.push((edge, 11.0));
    quadratic(&mut path, (edge, 7.0), (6.0, 5.0));
    path.push((4.0, 3.0));
    quadratic(&mut path, (2.0, 0.0), (0.0, 0.0));
    path.into_iter()
        .map(|(x, y)| {
            (
                ((rect.x + x) * scale).round() as i32,
                ((rect.y + y) * scale).round() as i32,
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn collapse_keeps_the_animated_shell_inside_the_webview_clip() {
        for scale in [1.0, 1.25, 1.5, 2.0, 4.0] {
            for (w, h) in [(640.0, 240.0), (420.0, 160.0), (340.0, 70.0)] {
                let rect = IslandRect {
                    x: (PANEL_W - w) / 2.0,
                    w,
                    h,
                    radius: 26.0,
                    ..Default::default()
                };
                let Mask::Rect(left, top, right, bottom) =
                    window_mask(IslandVisibility::Island, rect, scale)
                else {
                    panic!("expected a bounded native clip")
                };
                assert!(
                    shell_points(rect, scale)
                        .iter()
                        .all(|&(x, y)| x >= left && x <= right && y >= top && y <= bottom),
                    "the native clip must contain the whole curved shell during collapse"
                );
            }
        }
    }

    #[test]
    fn settled_modes_keep_tight_native_envelopes_for_the_current_shell() {
        assert_eq!(
            window_mask(
                IslandVisibility::Island,
                IslandRect {
                    x: (PANEL_W - 288.0) / 2.0,
                    w: 288.0,
                    h: 40.0,
                    ..Default::default()
                },
                1.0
            ),
            Mask::Rect(200, 0, 520, 56)
        );
        assert_eq!(
            window_mask(
                IslandVisibility::Peek,
                IslandRect {
                    x: (PANEL_W - 216.0) / 2.0,
                    y: 10.0,
                    w: 216.0,
                    h: 36.0,
                    ..Default::default()
                },
                1.0
            ),
            Mask::Rect(282, 0, 438, 12)
        );
        assert_eq!(
            window_mask(IslandVisibility::Expanded, IslandRect::default(), 1.0),
            Mask::Full
        );
    }

    #[test]
    fn working_lip_clips_stale_expanded_rect_and_shadow_above_browser_tabs() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            for rect in [
                IslandRect::default(),
                IslandRect {
                    x: 40.0,
                    y: 10.0,
                    w: 640.0,
                    h: 320.0,
                    radius: 26.0,
                },
            ] {
                let Mask::Rect(left, top, right, bottom) =
                    window_mask(IslandVisibility::Peek, rect, scale)
                else {
                    panic!("working mode needs a tight native region")
                };
                assert_eq!(top, 0);
                assert_eq!(right - left, (crate::island::PEEK_W * scale).round() as i32);
                assert_eq!(bottom, (crate::island::PEEK_H * scale).round() as i32);
                assert!(
                    bottom < (20.0 * scale) as i32,
                    "tab strip remains outside the region"
                );
            }
        }
    }

    #[test]
    fn shell_curve_stays_inside_the_native_gutters() {
        for scale in [1.0, 1.25, 1.5, 2.0, 4.0] {
            let points = shell_points(
                IslandRect {
                    x: 40.0,
                    y: 0.0,
                    w: 640.0,
                    h: 428.0,
                    radius: 26.0,
                },
                scale,
            );
            assert!(points.iter().all(|&(x, y)| x >= (40.0 * scale) as i32
                && x <= (680.0 * scale) as i32
                && y >= 0
                && y <= (428.0 * scale) as i32));
            assert!(points.contains(&(
                (646.0 * scale).round() as i32,
                (428.0 * scale).round() as i32
            )));
            assert!(!points.contains(&(
                (680.0 * scale).round() as i32,
                (428.0 * scale).round() as i32
            )));
        }
    }
}
