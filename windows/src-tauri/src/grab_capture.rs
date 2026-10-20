// SPDX-License-Identifier: MIT
//! A single frozen desktop image per user request. No recording or capture loop.
use crate::grab_store::{Pixels, MAX_PIXELS};
use windows::Win32::{
    Foundation::{POINT, RECT},
    Graphics::{Dwm::DwmFlush, Gdi::*},
    UI::WindowsAndMessaging::*,
};

/// Capture only the visible client area of the app under the user's drop point.
/// No clicks, browser navigation, offscreen rendering, recording, or page automation.
pub fn target(point: POINT) -> Result<(Pixels, String, RECT), String> {
    unsafe {
        let hwnd = GetAncestor(WindowFromPoint(point), GA_ROOT);
        if hwnd.is_invalid() || !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return Err("Drop Kumo onto a visible app window.".into());
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut class = [0u16; 256];
        let n = GetClassNameW(hwnd, &mut class);
        let class = String::from_utf16_lossy(&class[..n.max(0) as usize]);
        if pid == std::process::id()
            || [
                "Progman",
                "WorkerW",
                "Shell_TrayWnd",
                "Shell_SecondaryTrayWnd",
            ]
            .contains(&class.as_str())
        {
            return Err("Drop Kumo onto an app, rather than the desktop or taskbar.".into());
        }
        let mut rect = RECT::default();
        GetClientRect(hwnd, &mut rect).map_err(|_| "This window cannot be captured.")?;
        let mut origin = POINT {
            x: rect.left,
            y: rect.top,
        };
        if !ClientToScreen(hwnd, &mut origin).as_bool() {
            return Err("This window cannot be captured.".into());
        }
        let client = RECT {
            left: origin.x,
            top: origin.y,
            right: origin.x + rect.right - rect.left,
            bottom: origin.y + rect.bottom - rect.top,
        };
        let desktop = RECT {
            left: GetSystemMetrics(SM_XVIRTUALSCREEN),
            top: GetSystemMetrics(SM_YVIRTUALSCREEN),
            right: GetSystemMetrics(SM_XVIRTUALSCREEN) + GetSystemMetrics(SM_CXVIRTUALSCREEN),
            bottom: GetSystemMetrics(SM_YVIRTUALSCREEN) + GetSystemMetrics(SM_CYVIRTUALSCREEN),
        };
        let rect = visible_rect(client, desktop)?;
        let mut title = [0u16; 256];
        let length = GetWindowTextW(hwnd, &mut title);
        let title = String::from_utf16_lossy(&title[..length.max(0) as usize]);
        let pixels = capture(rect)?;
        if pixels.rgba.chunks_exact(4).all(|p| p[..3] == [0, 0, 0]) {
            return Err("This window returned an empty image. Try a different app window.".into());
        }
        Ok((
            pixels,
            if title.trim().is_empty() {
                "App capture".into()
            } else {
                title
            },
            rect,
        ))
    }
}
fn visible_rect(client: RECT, desktop: RECT) -> Result<RECT, String> {
    let rect = RECT {
        left: client.left.max(desktop.left),
        top: client.top.max(desktop.top),
        right: client.right.min(desktop.right),
        bottom: client.bottom.min(desktop.bottom),
    };
    let w = rect.right as i64 - rect.left as i64;
    let h = rect.bottom as i64 - rect.top as i64;
    if w < 2 || h < 2 || w as u64 * h as u64 > MAX_PIXELS {
        return Err("This app is outside the screen or too large to capture.".into());
    }
    Ok(rect)
}
fn capture(rect: RECT) -> Result<Pixels, String> {
    unsafe {
        let (left, top, w, h) = (
            rect.left,
            rect.top,
            rect.right - rect.left,
            rect.bottom - rect.top,
        );
        let _ = DwmFlush();
        let dc = GetDC(None);
        if dc.is_invalid() {
            return Err("Windows could not capture this desktop.".into());
        }
        let memory = CreateCompatibleDC(Some(dc));
        let bitmap = CreateCompatibleBitmap(dc, w, h);
        if memory.is_invalid() || bitmap.is_invalid() {
            if !bitmap.is_invalid() {
                let _ = DeleteObject(bitmap.into());
            }
            if !memory.is_invalid() {
                let _ = DeleteDC(memory);
            }
            ReleaseDC(None, dc);
            return Err("Windows could not allocate the capture.".into());
        }
        let old = SelectObject(memory, bitmap.into());
        let result = (|| {
            BitBlt(
                memory,
                0,
                0,
                w,
                h,
                Some(dc),
                left,
                top,
                SRCCOPY | CAPTUREBLT,
            )
            .map_err(|_| {
                "This screen could not be captured. Protected windows may block screenshots."
            })?;
            let mut info = BITMAPINFO::default();
            info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth = w;
            info.bmiHeader.biHeight = -h;
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB.0;
            let mut rgba = vec![0; w as usize * h as usize * 4];
            SelectObject(memory, old);
            if GetDIBits(
                memory,
                bitmap,
                0,
                h as u32,
                Some(rgba.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            ) == 0
            {
                return Err("Windows returned no screenshot.");
            }
            for pixel in rgba.chunks_exact_mut(4) {
                pixel.swap(0, 2);
                pixel[3] = 255;
            }
            Ok(Pixels {
                width: w as u32,
                height: h as u32,
                rgba,
            })
        })();
        SelectObject(memory, old);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, dc);
        result.map_err(String::from)
    }
}
pub fn clamp(x: f64, y: f64, w: f64, h: f64) -> (f64, f64) {
    unsafe {
        let point = windows::Win32::Foundation::POINT {
            x: x as i32,
            y: y as i32,
        };
        let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            let r = info.rcWork;
            return (
                x.clamp(r.left as f64, (r.right as f64 - w).max(r.left as f64)),
                y.clamp(r.top as f64, (r.bottom as f64 - h).max(r.top as f64)),
            );
        }
        (x, y)
    }
}

// One brief wave crosses the captured display. A temporary native surface
// reuses its DIB and clears only the previous ring pixels, with no WebView,
// screenshot history, or retained effect after the acknowledgment finishes.
pub fn feedback(point: (f64, f64), scale: f64, captured: RECT) {
    std::thread::spawn(move || {
        if let Err(error) = feedback_window(point, scale, captured) {
            crate::log::line(format!("Capture saved; feedback unavailable: {error}"));
        }
    });
}

struct ScreenRipple {
    width: usize,
    height: usize,
    center: (f64, f64),
    radius: f64,
    scale: f64,
    dirty: Vec<usize>,
}
impl ScreenRipple {
    fn new(bounds: RECT, point: (f64, f64), scale: f64) -> Self {
        let width = (bounds.right - bounds.left).max(1) as usize;
        let height = (bounds.bottom - bounds.top).max(1) as usize;
        let center = (point.0 - bounds.left as f64, point.1 - bounds.top as f64);
        let radius = center
            .0
            .max(width as f64 - center.0)
            .hypot(center.1.max(height as f64 - center.1))
            + 8.0 * scale;
        Self {
            width,
            height,
            center,
            radius,
            scale: scale.clamp(1.0, 2.0),
            dirty: Vec::with_capacity((width + height) * 32),
        }
    }
    fn frame(&mut self, pixels: &mut [u8], t: f64) {
        for offset in self.dirty.drain(..) {
            pixels[offset..offset + 4].fill(0);
        }
        if t >= 1.0 {
            return;
        }
        let t = t.clamp(0.0, 1.0);
        for (delay, strength) in [(0.0, 0.5), (0.12, 0.24)] {
            if t < delay {
                continue;
            }
            let phase = ((t - delay) / (1.0 - delay)).clamp(0.0, 1.0);
            let ease = 1.0 - (1.0 - phase).powi(3);
            self.ring(
                pixels,
                12.0 + (self.radius - 12.0) * ease,
                strength * (1.0 - phase).powf(0.7),
            );
        }
        let radius = 10.0 * self.scale;
        let opacity = (1.0 - t / 0.25).clamp(0.0, 1.0) * 0.4;
        if opacity > 0.0 {
            let half = radius.ceil() as i32;
            for dy in -half..=half {
                for dx in -half..=half {
                    let distance = (dx as f64).hypot(dy as f64) / radius;
                    self.put(
                        pixels,
                        (self.center.0 + dx as f64).round() as i32,
                        (self.center.1 + dy as f64).round() as i32,
                        opacity * (1.0 - distance).clamp(0.0, 1.0),
                    );
                }
            }
        }
    }
    fn ring(&mut self, pixels: &mut [u8], radius: f64, alpha: f64) {
        let stroke = 2.4 * self.scale;
        let outer = (radius + stroke).powi(2);
        let inner = (radius - stroke).max(0.0).powi(2);
        let top = (self.center.1 - radius - stroke).floor().max(0.0) as i32;
        let bottom = (self.center.1 + radius + stroke)
            .ceil()
            .min(self.height as f64 - 1.0) as i32;
        // Walk only the two thin annulus spans on each scanline, never its interior.
        for y in top..=bottom {
            let dy = y as f64 - self.center.1;
            let square = dy * dy;
            if square > outer {
                continue;
            }
            let outside = (outer - square).sqrt();
            let inside = (inner - square).max(0.0).sqrt();
            for (a, b) in [
                (self.center.0 - outside, self.center.0 - inside),
                (self.center.0 + inside, self.center.0 + outside),
            ] {
                let left = a.floor().max(0.0) as i32;
                let right = b.ceil().min(self.width as f64 - 1.0) as i32;
                for x in left..=right {
                    let distance = ((x as f64 - self.center.0).hypot(dy) - radius).abs();
                    self.put(
                        pixels,
                        x,
                        y,
                        alpha * (1.0 - distance / stroke).clamp(0.0, 1.0),
                    );
                }
            }
        }
    }
    fn put(&mut self, pixels: &mut [u8], x: i32, y: i32, alpha: f64) {
        if x < 0 || y < 0 || x >= self.width as i32 || y >= self.height as i32 {
            return;
        }
        let offset = (y as usize * self.width + x as usize) * 4;
        let alpha = (alpha.clamp(0.0, 1.0) * 255.0).round() as u8;
        if alpha > pixels[offset + 3] {
            if pixels[offset + 3] == 0 {
                self.dirty.push(offset);
            }
            pixels[offset] = alpha;
            pixels[offset + 1] = (alpha as f64 * 0.98) as u8;
            pixels[offset + 2] = (alpha as f64 * 0.96) as u8;
            pixels[offset + 3] = alpha;
        }
    }
}

fn feedback_window(point: (f64, f64), scale: f64, captured: RECT) -> windows::core::Result<()> {
    use windows::{
        core::w,
        Win32::Foundation::{COLORREF, SIZE},
    };
    unsafe {
        let monitor = MonitorFromPoint(
            POINT {
                x: point.0 as i32,
                y: point.1 as i32,
            },
            MONITOR_DEFAULTTONEAREST,
        );
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let bounds = if GetMonitorInfoW(monitor, &mut info).as_bool() {
            info.rcMonitor
        } else {
            captured
        };
        let mut ripple = ScreenRipple::new(bounds, point, scale);
        let (width, height) = (ripple.width, ripple.height);
        let (left, top) = (bounds.left, bounds.top);
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
            w!("STATIC"),
            w!("Mimo capture"),
            WS_POPUP,
            left,
            top,
            width as i32,
            height as i32,
            None,
            None,
            None,
            None,
        )?;
        let dc = GetDC(None);
        let memory = CreateCompatibleDC(Some(dc));
        if dc.is_invalid() || memory.is_invalid() {
            if !memory.is_invalid() {
                let _ = DeleteDC(memory);
            }
            if !dc.is_invalid() {
                ReleaseDC(None, dc);
            }
            let _ = DestroyWindow(hwnd);
            return Err(windows::core::Error::from_win32());
        }
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width as i32;
        info.bmiHeader.biHeight = -(height as i32);
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB.0;
        let mut bits = std::ptr::null_mut();
        let bitmap = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(bitmap) => bitmap,
            Err(error) => {
                let _ = DeleteDC(memory);
                ReleaseDC(None, dc);
                let _ = DestroyWindow(hwnd);
                return Err(error);
            }
        };
        let old = SelectObject(memory, bitmap.into());
        let pixels = std::slice::from_raw_parts_mut(bits.cast::<u8>(), width * height * 4);
        pixels.fill(0);
        let origin = POINT { x: left, y: top };
        let source = POINT { x: 0, y: 0 };
        let size = SIZE {
            cx: width as i32,
            cy: height as i32,
        };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let start = std::time::Instant::now();
        let mut result = Ok(());
        loop {
            let t = (start.elapsed().as_secs_f64() / 0.88).min(1.0);
            ripple.frame(pixels, t);
            if let Err(error) = UpdateLayeredWindow(
                hwnd,
                Some(dc),
                Some(&origin),
                Some(&size),
                Some(memory),
                Some(&source),
                COLORREF(0),
                Some(&blend),
                ULW_ALPHA,
            ) {
                result = Err(error);
                break;
            }
            if !IsWindowVisible(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
            let mut message = MSG::default();
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            if t >= 1.0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
        SelectObject(memory, old);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, dc);
        let _ = DestroyWindow(hwnd);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Briefly shows capture feedback on the active Windows desktop"]
    fn live_screen_ripple_covers_monitor_and_releases_window() {
        use windows::core::w;
        unsafe {
            assert!(FindWindowW(None, w!("Mimo capture")).is_err());
            let mut cursor = POINT::default();
            GetCursorPos(&mut cursor).unwrap();
            let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            assert!(GetMonitorInfoW(monitor, &mut info).as_bool());
            let bounds = info.rcMonitor;
            for _ in 0..2 {
                let task = std::thread::spawn(move || {
                    feedback_window(
                        (cursor.x as f64, cursor.y as f64),
                        1.0,
                        RECT {
                            left: cursor.x - 20,
                            top: cursor.y - 20,
                            right: cursor.x + 20,
                            bottom: cursor.y + 20,
                        },
                    )
                });
                let deadline = std::time::Instant::now() + std::time::Duration::from_millis(700);
                let mut observed = None;
                while std::time::Instant::now() < deadline {
                    if let Ok(hwnd) = FindWindowW(None, w!("Mimo capture")) {
                        if IsWindowVisible(hwnd).as_bool() {
                            let mut rect = RECT::default();
                            GetWindowRect(hwnd, &mut rect).unwrap();
                            observed = Some(rect);
                            break;
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                task.join().unwrap().unwrap();
                let rect = observed.expect("The transparent native ripple must actually appear");
                assert_eq!(
                    (rect.left, rect.top, rect.right, rect.bottom),
                    (bounds.left, bounds.top, bounds.right, bounds.bottom)
                );
                assert!(
                    FindWindowW(None, w!("Mimo capture")).is_err(),
                    "Feedback must release its native surface after each capture"
                );
            }
        }
    }
    #[test]
    fn capture_feedback_crosses_the_display_reuses_pixels_and_finishes_clear() {
        for (width, height, left, scale) in [(1280, 720, 0, 1.0), (3840, 2160, -3840, 2.0)] {
            let bounds = RECT {
                left,
                top: -100,
                right: left + width,
                bottom: height - 100,
            };
            let point = (
                left as f64 + width as f64 / 3.0,
                height as f64 / 2.0 - 100.0,
            );
            let mut ripple = ScreenRipple::new(bounds, point, scale);
            let mut pixels = vec![0u8; width as usize * height as usize * 4];
            let pointer = pixels.as_ptr();
            let dirty_pointer = ripple.dirty.as_ptr();
            let mut crossed = false;
            let start = std::time::Instant::now();
            for frame in 0..=35 {
                ripple.frame(&mut pixels, frame as f64 / 35.0);
                assert_eq!(pixels.as_ptr(), pointer);
                assert_eq!(
                    ripple.dirty.as_ptr(),
                    dirty_pointer,
                    "ring work must reuse its allocation"
                );
                for &offset in &ripple.dirty {
                    let pixel = &pixels[offset..offset + 4];
                    assert!(pixel[..3].iter().all(|channel| *channel <= pixel[3]));
                    let x = (offset / 4) % width as usize;
                    crossed |= x > width as usize * 3 / 4 && pixel[3] > 0;
                }
            }
            assert!(
                crossed,
                "the wave must reach across the screen, beyond a cursor-sized patch"
            );
            assert!(pixels.iter().all(|channel| *channel == 0));
            println!(
                "{width}x{height} screen ripple: 36 frames, {} bytes, {:?}",
                pixels.len(),
                start.elapsed()
            );
        }
    }
    #[test]
    fn target_bounds_handle_negative_monitors_and_partial_windows() {
        let desktop = RECT {
            left: -1920,
            top: 0,
            right: 2560,
            bottom: 1440,
        };
        let r = visible_rect(
            RECT {
                left: -2000,
                top: -40,
                right: -200,
                bottom: 980,
            },
            desktop,
        )
        .unwrap();
        assert_eq!((r.left, r.top, r.right, r.bottom), (-1920, 0, -200, 980));
        assert!(visible_rect(
            RECT {
                left: 2561,
                top: 0,
                right: 3000,
                bottom: 100
            },
            desktop
        )
        .is_err());
        assert!(visible_rect(
            RECT {
                left: 2,
                top: 2,
                right: 2,
                bottom: 100
            },
            desktop
        )
        .is_err());
        let giant = RECT {
            left: 0,
            top: 0,
            right: 40000,
            bottom: 40000,
        };
        assert!(visible_rect(giant, giant).is_err());
    }
}
