// SPDX-License-Identifier: MIT
use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
};
use webview_windows_core::Interface;

/// Only hidden Settings uses LOW. The visible companion keeps NORMAL to avoid
/// paging during its animation or sound playback. This hint never suspends scripts.
pub fn settings_visibility(window: &WebviewWindow, visible: bool) {
    let _ = window.with_webview(move |view| unsafe {
        let Ok(core) = view.controller().CoreWebView2() else {
            return;
        };
        // Older WebView2 runtimes lack this optional interface.
        let Ok(memory) = core.cast::<ICoreWebView2_19>() else {
            return;
        };
        let level = if visible {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
        } else {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
        };
        let _ = memory.SetMemoryUsageTargetLevel(level);
    });
}
