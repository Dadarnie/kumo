// SPDX-License-Identifier: MIT
//! Own the native file target, including WebView2 children created after startup.
use ::windows::core::{implement, BOOL};
use ::windows::Win32::Foundation::{HWND, LPARAM, POINTL};
use ::windows::Win32::System::Com::{
    IDataObject, DVASPECT_CONTENT, FORMATETC, STGMEDIUM, TYMED_HGLOBAL,
};
use ::windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_HDROP,
    DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use ::windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use ::windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use ::windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use ::windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetClassNameW, EVENT_OBJECT_HIDE, EVENT_OBJECT_SHOW, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, Manager};

static ACTIVE: AtomicBool = AtomicBool::new(false);
static OBSERVER: Mutex<Option<(AppHandle, isize)>> = Mutex::new(None);

#[derive(serde::Serialize, Clone)]
struct FileEvent {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    paths: Option<Vec<String>>,
}

fn emit(app: &AppHandle, kind: &'static str, paths: Option<Vec<String>>) {
    let _ = app.emit_to(
        crate::island::WINDOW_LABEL,
        "mimo-file-drop",
        FileEvent { kind, paths },
    );
}

fn format() -> FORMATETC {
    FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

struct Medium(STGMEDIUM);
impl Drop for Medium {
    fn drop(&mut self) {
        unsafe { ReleaseStgMedium(&mut self.0) };
    }
}

fn paths(data: &IDataObject) -> ::windows::core::Result<Vec<String>> {
    let medium = Medium(unsafe { data.GetData(&format())? });
    if medium.0.tymed != TYMED_HGLOBAL.0 as u32 {
        return Ok(Vec::new());
    }
    let hdrop = HDROP(unsafe { medium.0.u.hGlobal.0 });
    if hdrop.0.is_null() {
        return Ok(Vec::new());
    }
    let count = unsafe { DragQueryFileW(hdrop, u32::MAX, None) };
    let mut result = Vec::new();
    // Keep one excess reference so an oversized batch is rejected, never silently truncated.
    for index in 0..count.min(crate::files::MAX_CHAT_FILES as u32 + 1) {
        let length = unsafe { DragQueryFileW(hdrop, index, None) } as usize;
        if length == 0 || length > 32_767 {
            return Ok(Vec::new());
        }
        let mut buffer = vec![0; length + 1];
        let read = unsafe { DragQueryFileW(hdrop, index, Some(&mut buffer)) } as usize;
        if read == 0 || read > length {
            return Ok(Vec::new());
        }
        result.push(String::from_utf16_lossy(&buffer[..read]));
    }
    Ok(result)
}

// The source keeps its original. Never return an effect it did not allow.
fn copy_effect(effect: *mut DROPEFFECT, valid: bool) -> bool {
    let Some(effect) = (unsafe { effect.as_mut() }) else {
        return false;
    };
    let accepted = valid && effect.contains(DROPEFFECT_COPY);
    *effect = if accepted {
        DROPEFFECT_COPY
    } else {
        DROPEFFECT_NONE
    };
    accepted
}

#[implement(IDropTarget)]
struct FileTarget {
    app: AppHandle,
    valid: AtomicBool,
}

#[allow(non_snake_case)]
impl IDropTarget_Impl for FileTarget_Impl {
    fn DragEnter(
        &self,
        data: windows_core::Ref<'_, IDataObject>,
        _: MODIFIERKEYS_FLAGS,
        _: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> ::windows::core::Result<()> {
        let valid = copy_effect(
            effect,
            data.as_ref()
                .is_some_and(|data| unsafe { data.QueryGetData(&format()).is_ok() }),
        );
        self.valid.store(valid, Ordering::Relaxed);
        if valid {
            set_active(&self.app, true);
            emit(&self.app, "enter", None);
        }
        Ok(())
    }
    fn DragOver(
        &self,
        _: MODIFIERKEYS_FLAGS,
        _: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> ::windows::core::Result<()> {
        let valid = copy_effect(effect, self.valid.load(Ordering::Relaxed));
        if valid {
            emit(&self.app, "over", None);
        }
        Ok(())
    }
    fn DragLeave(&self) -> ::windows::core::Result<()> {
        if self.valid.swap(false, Ordering::Relaxed) {
            emit(&self.app, "leave", None);
        }
        if !super::left_button_down() {
            set_active(&self.app, false);
        }
        Ok(())
    }
    fn Drop(
        &self,
        data: windows_core::Ref<'_, IDataObject>,
        _: MODIFIERKEYS_FLAGS,
        _: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> ::windows::core::Result<()> {
        let valid = copy_effect(effect, self.valid.swap(false, Ordering::Relaxed));
        let result = data
            .as_ref()
            .filter(|_| valid)
            .and_then(|data| paths(data).ok())
            .unwrap_or_default();
        copy_effect(
            effect,
            (1..=crate::files::MAX_CHAT_FILES).contains(&result.len()),
        );
        emit(&self.app, "drop", Some(result));
        set_active(&self.app, false);
        Ok(())
    }
}

unsafe extern "system" fn register_child(hwnd: HWND, parameter: LPARAM) -> BOOL {
    let target = unsafe { &*(parameter.0 as *const IDropTarget) };
    unsafe {
        let _ = RevokeDragDrop(hwnd);
        let _ = RegisterDragDrop(hwnd, target);
    }
    true.into()
}

pub fn refresh(app: &AppHandle) {
    let Some(window) = app.get_webview_window(crate::island::WINDOW_LABEL) else {
        return;
    };
    let Some(hwnd) = super::hwnd_of(&window) else {
        return;
    };
    let target: IDropTarget = FileTarget {
        app: app.clone(),
        valid: AtomicBool::new(false),
    }
    .into();
    unsafe {
        let _ = RevokeDragDrop(hwnd);
        if let Err(error) = RegisterDragDrop(hwnd, &target) {
            crate::log::line(format!("native file target: {}", error.code()));
        }
        let _ = EnumChildWindows(
            Some(hwnd),
            Some(register_child),
            LPARAM(&target as *const _ as isize),
        );
    }
}

pub fn set_active(app: &AppHandle, active: bool) {
    if ACTIVE.swap(active, Ordering::Relaxed) != active {
        let _ = app.emit_to(crate::island::WINDOW_LABEL, "file-drag-active", active);
    }
}

unsafe extern "system" fn drag_image_event(
    _: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    _: i32,
    _: i32,
    _: u32,
    _: u32,
) {
    let mut name = [0u16; 64];
    let length = unsafe { GetClassNameW(hwnd, &mut name) };
    if length <= 0 || String::from_utf16_lossy(&name[..length as usize]) != "SysDragImage" {
        return;
    }
    let app = OBSERVER
        .lock()
        .unwrap()
        .as_ref()
        .map(|(app, _)| app.clone());
    if let Some(app) = app {
        if event == EVENT_OBJECT_SHOW && super::left_button_down() {
            refresh(&app);
            set_active(&app, true);
        } else if event == EVENT_OBJECT_HIDE {
            set_active(&app, false);
        }
    }
}

/// Shell drag images let the companion reveal its target before the pointer arrives.
pub fn watch(app: &AppHandle) {
    refresh(app);
    let hook = unsafe {
        SetWinEventHook(
            EVENT_OBJECT_SHOW,
            EVENT_OBJECT_HIDE,
            None,
            Some(drag_image_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        )
    };
    *OBSERVER.lock().unwrap() = Some((app.clone(), hook.0 as isize));
}

unsafe extern "system" fn unregister_child(hwnd: HWND, _: LPARAM) -> BOOL {
    unsafe {
        let _ = RevokeDragDrop(hwnd);
    }
    true.into()
}

pub fn stop(app: &AppHandle) {
    if let Some((_, hook)) = OBSERVER.lock().unwrap().take() {
        if hook != 0 {
            unsafe {
                let _ = UnhookWinEvent(HWINEVENTHOOK(hook as *mut _));
            }
        }
    }
    if let Some(window) = app.get_webview_window(crate::island::WINDOW_LABEL) {
        if let Some(hwnd) = super::hwnd_of(&window) {
            unsafe {
                let _ = EnumChildWindows(Some(hwnd), Some(unregister_child), LPARAM(0));
                let _ = RevokeDragDrop(hwnd);
            }
        }
    }
}
