// SPDX-License-Identifier: MIT
//! Mimo Shelf orchestrates its existing window, intake, storage and clipboard paths.
use crate::{grab_capture, grab_clipboard, grab_store as store};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Condvar, Mutex,
    },
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder,
};

#[derive(Default)]
pub struct Grab {
    library: Mutex<Option<store::Library>>,
    companion: Mutex<Value>,
    pub detached: AtomicBool,
    capturing: AtomicBool,
    companion_ready: AtomicBool,
    return_hover: AtomicBool,
    return_geometry: Mutex<Option<Value>>,
    return_wake: Condvar,
}
impl Grab {
    fn library(&self) -> Result<std::sync::MutexGuard<'_, Option<store::Library>>, String> {
        let mut guard = self.library.lock().map_err(|_| "The shelf is busy.")?;
        if guard.is_none() {
            crate::windows::ensure_private_dir(&crate::settings::local_dir())
                .map_err(|_| "Could not open private Mimo storage.")?;
            let mut library = store::load(&store::root())?;
            store::expire(&store::root(), &mut library)?;
            grab_clipboard::cleanup(library.retention_days)?;
            *guard = Some(library);
        }
        Ok(guard)
    }
}
#[tauri::command]
pub fn grab_read(grab: State<Grab>) -> Result<Value, String> {
    let library = grab.library()?;
    let l = library.as_ref().unwrap();
    // Originals/fingerprints stay native. Each thumbnail is loaded on demand.
    let mut items = serde_json::to_value(&l.items).map_err(|_| "Could not read the shelf.")?;
    if let Some(items) = items.as_array_mut() {
        for item in items {
            if let Some(map) = item.as_object_mut() {
                let extension = map["file"]
                    .as_str()
                    .and_then(|f| Path::new(f).extension())
                    .map(|e| e.to_string_lossy().to_ascii_uppercase())
                    .unwrap_or_default();
                map.insert("extension".into(), json!(extension));
                map.remove("fingerprint");
                map.remove("file");
            }
        }
    }
    Ok(json!({"items":items,"retentionDays":l.retention_days,
"detached":grab.detached.load(Ordering::SeqCst)}))
}
#[tauri::command]
pub async fn grab_action(
    app: AppHandle,
    action: String,
    args: Option<Value>,
) -> Result<Value, String> {
    let changed = [
        "import",
        "edit",
        "reorder",
        "delete",
        "annotate",
        "preferences",
        "clean_expired",
    ]
    .contains(&action.as_str());
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        dispatch(&handle, &action, &args.unwrap_or(json!({})))
    })
    .await
    .map_err(|_| "Grab was interrupted.")?;
    if result.is_ok() && changed {
        let _ = app.emit("grab-changed", ());
    }
    result
}
fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args[key].as_str().ok_or_else(|| format!("Missing {key}."))
}
fn ids(args: &Value) -> Result<Vec<String>, String> {
    let values = args["ids"].as_array().ok_or("Choose references first.")?;
    if values.len() > 200 {
        return Err("Too many references.".into());
    }
    values
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or("Invalid selection.".into())
        })
        .collect()
}
fn dispatch(app: &AppHandle, action: &str, args: &Value) -> Result<Value, String> {
    let grab = app.state::<Grab>();
    match action {
        "companion_state" => return Ok(grab.companion.lock().unwrap().clone()),
        "companion_ready" => {
            present_companion(app);
            return Ok(json!(true));
        }
        "return_geometry" => {
            if grab.detached.load(Ordering::SeqCst)
                && grab.capturing.load(Ordering::SeqCst)
                && ["x", "y", "renderSize"]
                    .iter()
                    .all(|key| args[*key].as_f64().is_some_and(f64::is_finite))
            {
                *grab.return_geometry.lock().unwrap() = Some(args.clone());
                grab.return_wake.notify_one();
            }
            return Ok(json!(true));
        }
        "detach" => {
            detach(app, args)?;
            return Ok(json!(true));
        }
        "dock" => {
            return_to_panel(app);
            return Ok(json!(true));
        }
        "capture_target" => {
            let (x, y) = crate::windows::cursor_physical()
                .ok_or("Windows could not find the drop point.")?;
            return capture_target(app, x, y);
        }
        _ => {}
    }
    let mut library = grab.library()?;
    let l = library.as_mut().unwrap();
    let root = store::root();
    match action {
        "copy" => grab_clipboard::copy(
            app,
            l,
            &ids(args)?,
            args["instruction"].as_str().unwrap_or(""),
        ),
        "preview" => {
            let r = store::item(l, text(args, "id")?)?;
            Ok(
                json!({"image":store::preview(&root,r,args["thumbnail"].as_bool().unwrap_or(false),args["display"].as_bool().unwrap_or(false))?,"annotations":r.annotations}),
            )
        }
        "import" => {
            let path = Path::new(text(args, "path")?)
                .canonicalize()
                .map_err(|_| "Drop this file on Mimo again.")?;
            if path.parent()
                != Some(
                    crate::files::inbox_dir()
                        .canonicalize()
                        .map_err(|_| "Drop the file on Mimo first.")?
                        .as_path(),
                )
            {
                return Err("Drop the file on Mimo before adding it to the shelf.".into());
            }
            if std::fs::metadata(&path)
                .map_err(|_| "This file is unavailable.")?
                .len()
                > store::MAX_BYTES as u64
            {
                return Err("Use a file smaller than 32 MB.".into());
            }
            let bytes = std::fs::read(&path).map_err(|_| "Could not read this file.")?;
            let mime = match path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_ascii_lowercase()
                .as_str()
            {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "webp" => "image/webp",
                "pdf" => "application/pdf",
                _ => "application/octet-stream",
            };
            Ok(json!(store::add(
                &root,
                l,
                &bytes,
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .as_ref(),
                mime,
                "file drop",
                args["collection"].as_str().unwrap_or("Dropped files")
            )?))
        }
        "edit" => {
            let id = text(args, "id")?;
            let r = l
                .items
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or("This reference is no longer on the shelf.")?;
            for (key, max) in [("label", 160), ("note", 2000), ("collection", 80)] {
                if let Some(value) = args[key].as_str() {
                    if value.len() > max * 4 {
                        return Err("Keep this reference's text shorter.".into());
                    }
                    let value = value.chars().take(max).collect();
                    match key {
                        "label" => r.label = value,
                        "note" => r.note = value,
                        _ => r.collection = value,
                    }
                }
            }
            store::save(&root, l)?;
            Ok(json!(true))
        }
        "reorder" => {
            let order = ids(args)?;
            if order.len() != l.items.len()
                || order.iter().collect::<std::collections::HashSet<_>>().len() != order.len()
                || order.iter().any(|id| !l.items.iter().any(|r| &r.id == id))
            {
                return Err("The shelf changed. Try moving that reference again.".into());
            }
            l.items
                .sort_by_key(|r| order.iter().position(|id| id == &r.id).unwrap());
            store::save(&root, l)?;
            Ok(json!(true))
        }
        "delete" => {
            store::remove(&root, l, &ids(args)?)?;
            Ok(json!(true))
        }
        "annotate" => {
            let id = text(args, "id")?;
            let r = store::item(l, id)?.clone();
            let marks = args["annotations"].clone();
            if !marks.is_array()
                || marks.as_array().unwrap().len() > 100
                || marks.to_string().len() > 64000
            {
                return Err("Use up to 100 short annotations.".into());
            }
            let encoded = text(args, "image")?
                .strip_prefix("data:image/png;base64,")
                .ok_or("Save annotations as PNG.")?;
            if encoded.len() > store::MAX_BYTES * 4 / 3 + 4 {
                return Err("This annotation image is too large.".into());
            }
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| "Invalid annotation image.")?;
            let p = store::decode(&bytes)?;
            let transform = if args["transform"].is_null() {
                None
            } else {
                Some(
                    serde_json::from_value::<store::ImageTransform>(args["transform"].clone())
                        .map_err(|_| "Choose valid image dimensions.")?,
                )
            };
            if let Some(t) = &transform {
                if !t.valid() || t.width != p.width || t.height != p.height {
                    return Err(
                        "Choose valid crop and image dimensions (up to 64 million pixels).".into(),
                    );
                }
            } else if r.width > 0 && (r.width != p.width || r.height != p.height) {
                return Err("Annotations must keep the original image size.".into());
            }
            store::path(&root, &r, false)?;
            std::fs::write(root.join(format!("{id}.annotated.png")), bytes)
                .map_err(|_| "Could not save annotations.")?;
            let r = l.items.iter_mut().find(|r| r.id == id).unwrap();
            r.annotations = marks;
            r.annotated = true;
            r.transform = transform;
            store::save(&root, l)?;
            let _ = std::fs::remove_file(root.join(format!("{id}.display.png")));
            Ok(json!(true))
        }
        "preferences" => {
            if let Some(days) = args["retentionDays"].as_u64() {
                if ![0, 1, 7, 30].contains(&days) {
                    return Err("Choose a supported retention period.".into());
                }
                let previous = l.retention_days;
                l.retention_days = days as u32;
                if let Err(error) = store::save(&root, l) {
                    l.retention_days = previous;
                    return Err(error);
                }
            }
            Ok(json!(true))
        }
        "clean_expired" => {
            store::expire(&root, l)?;
            grab_clipboard::cleanup(l.retention_days)?;
            Ok(json!(true))
        }
        _ => Err("Unknown Grab action.".into()),
    }
}
fn detach(app: &AppHandle, args: &Value) -> Result<(), String> {
    let grab = app.state::<Grab>();
    if grab.detached.load(Ordering::SeqCst) {
        return Ok(());
    }
    if !app
        .state::<crate::Shared>()
        .settings
        .lock()
        .unwrap()
        .grab_enabled
    {
        return Err("Mimo grabbing is off in Settings.".into());
    }
    if grab.capturing.load(Ordering::SeqCst) {
        return Err("Mimo is finishing your capture.".into());
    }
    let render_size = args["renderSize"]
        .as_f64()
        .filter(|v| v.is_finite())
        .unwrap_or(64.0)
        .clamp(20.0, 100.0);
    let mut source = args.clone();
    source["renderSize"] = json!(render_size);
    source["sourceSize"] = json!(render_size);
    source["carrySize"] = json!(render_size.max(64.0));
    let win = WebviewWindowBuilder::new(
        app,
        "grab-companion",
        WebviewUrl::App("grab-companion.html".into()),
    )
    .title("Mimo Shelf")
    .inner_size(104.0, 96.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .focused(false)
    .focusable(false)
    .visible(false)
    .build()
    .map_err(|_| "Could not pick up Mimo. Try dragging him again.")?;
    let island = app.get_webview_window("island");
    let scale = island
        .as_ref()
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    let origin = island
        .and_then(|w| w.outer_position().ok())
        .unwrap_or(PhysicalPosition::new(0, 0));
    let x = origin.x as f64 + args["returnX"].as_f64().unwrap_or(300.0) * scale;
    let y = origin.y as f64 + args["returnY"].as_f64().unwrap_or(200.0) * scale;
    source["sourceScreenX"] = json!(x);
    source["sourceScreenY"] = json!(y);
    *grab.companion.lock().unwrap() = source;
    *grab.return_geometry.lock().unwrap() = None;
    grab.companion_ready.store(false, Ordering::SeqCst);
    grab.return_hover.store(false, Ordering::SeqCst);
    crate::windows::set_activating(&win, false);
    let _ = win.set_ignore_cursor_events(true);
    // The transparent canvas may cross the screen edge; only Mimo's body is clamped.
    // Clamping the 104 x 96 canvas would jump a compact Mimo down by 28 pixels.
    let _ = win.set_position(PhysicalPosition::new(
        (x - 52.0 * scale).round() as i32,
        (y - 48.0 * scale).round() as i32,
    ));
    grab.detached.store(true, Ordering::SeqCst);
    crate::workflow_native::capture_active(true);
    Ok(())
}
fn ease_out(t: f64) -> f64 {
    1.0 - (1.0 - t.clamp(0.0, 1.0)).powi(3)
}
fn motion_start_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_millis() as u64)
        .unwrap_or(0)
}
fn pointer_center(source: &Value, x: f64, y: f64, scale: f64) -> (f64, f64) {
    let ratio = source["renderSize"].as_f64().unwrap_or(64.0)
        / source["sourceSize"].as_f64().unwrap_or(64.0).max(1.0);
    (
        x - source["anchorX"].as_f64().unwrap_or(0.0) * scale * ratio,
        y - source["anchorY"].as_f64().unwrap_or(0.0) * scale * ratio,
    )
}
fn position_center(win: &tauri::WebviewWindow, x: f64, y: f64, render_size: f64) {
    let scale = win.scale_factor().unwrap_or(1.0);
    let body = render_size * 0.6 * scale;
    let (left, top) = grab_capture::clamp(x - body / 2.0, y - body / 2.0, body, body);
    let _ = win.set_position(PhysicalPosition::new(
        (left + body / 2.0 - 52.0 * scale).round() as i32,
        (top + body / 2.0 - 48.0 * scale).round() as i32,
    ));
}
fn position_companion(app: &AppHandle, win: &tauri::WebviewWindow, x: f64, y: f64) {
    let grab = app.state::<Grab>();
    let source = grab.companion.lock().unwrap();
    let center = pointer_center(&source, x, y, win.scale_factor().unwrap_or(1.0));
    position_center(
        win,
        center.0,
        center.1,
        source["renderSize"].as_f64().unwrap_or(64.0),
    );
}
fn present_companion(app: &AppHandle) {
    let grab = app.state::<Grab>();
    if !grab.detached.load(Ordering::SeqCst) || grab.capturing.load(Ordering::SeqCst) {
        return;
    }
    let Some(win) = app.get_webview_window("grab-companion") else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        return;
    }
    let source = grab.companion.lock().unwrap().clone();
    let from = source["sourceSize"].as_f64().unwrap_or(64.0);
    let to = source["carrySize"].as_f64().unwrap_or(from);
    let _ = win.show();
    let _ = app.emit_to("island", "grab-detached", true);
    let started = motion_start_ms();
    let _ = win.emit(
        "grab-companion-pose",
        json!({"renderSize":to,"durationMs":160,"startedAt":started}),
    );
    let start = (
        source["sourceScreenX"].as_f64().unwrap_or(0.0),
        source["sourceScreenY"].as_f64().unwrap_or(0.0),
    );
    // A bounded shared-element pickup starts at the visible source, then catches
    // the actual cursor. The ordinary 60 Hz cursor owner takes over afterwards.
    loop {
        if !grab.detached.load(Ordering::SeqCst) || grab.capturing.load(Ordering::SeqCst) {
            return;
        }
        let t = motion_start_ms().saturating_sub(started) as f64 / 160.0;
        let ease = ease_out(t);
        let size = from + (to - from) * ease;
        let current = {
            let mut state = grab.companion.lock().unwrap();
            state["renderSize"] = json!(size);
            state.clone()
        };
        let pointer = crate::windows::cursor_physical().unwrap_or(start);
        let target = pointer_center(
            &current,
            pointer.0,
            pointer.1,
            win.scale_factor().unwrap_or(1.0),
        );
        position_center(
            &win,
            start.0 + (target.0 - start.0) * ease,
            start.1 + (target.1 - start.1) * ease,
            size,
        );
        if t >= 1.0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(16));
    }
    grab.companion_ready.store(true, Ordering::SeqCst);
}
/// Runs from the existing island cursor path, only while the user's drag is held.
/// It also catches release outside the WebView or after DOM pointer capture is lost.
pub fn track_drag(app: &AppHandle, x: f64, y: f64, down: bool, moved: bool) {
    let grab = app.state::<Grab>();
    if !grab.detached.load(Ordering::SeqCst) || grab.capturing.load(Ordering::SeqCst) {
        return;
    }
    if down {
        if moved && grab.companion_ready.load(Ordering::SeqCst) {
            if let Some(win) = app.get_webview_window("grab-companion") {
                position_companion(app, &win, x, y);
            }
        }
        let hover = return_point(app, x, y).is_some();
        if grab.return_hover.swap(hover, Ordering::SeqCst) != hover {
            let _ = app.emit_to("island", "grab-hover", hover);
        }
    } else {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = capture_target(&app, x, y);
        });
    }
}
fn dock(app: &AppHandle) {
    let grab = app.state::<Grab>();
    grab.detached.store(false, Ordering::SeqCst);
    grab.companion_ready.store(false, Ordering::SeqCst);
    grab.return_hover.store(false, Ordering::SeqCst);
    *grab.return_geometry.lock().unwrap() = None;
    grab.return_wake.notify_all();
    crate::workflow_native::capture_active(false);
    if let Some(win) = app.get_webview_window("grab-companion") {
        let _ = win.destroy();
    }
    let _ = app.emit_to("island", "grab-detached", false);
    let _ = app.emit_to("island", "grab-hover", false);
}
fn within_return_slot(rect: crate::island::IslandRect, x: f64, y: f64) -> bool {
    rect.w > 0.0
        && rect.h > 0.0
        && x >= rect.x - 8.0
        && x <= rect.x + rect.w + 8.0
        && y >= rect.y - 8.0
        && y <= rect.y + rect.h + 8.0
}
fn return_point(app: &AppHandle, x: f64, y: f64) -> Option<(f64, f64)> {
    let win = app.get_webview_window("island")?;
    if !win.is_visible().ok()? {
        return None;
    }
    let origin = win.outer_position().ok()?;
    let scale = win.scale_factor().unwrap_or(1.0);
    let rect = *app.state::<crate::Shared>().gate.rect.lock().unwrap();
    if !within_return_slot(
        rect,
        (x - origin.x as f64) / scale,
        (y - origin.y as f64) / scale,
    ) {
        return None;
    }
    Some((
        origin.x as f64 + (rect.x + rect.w / 2.0) * scale,
        origin.y as f64 + (rect.y + rect.h / 2.0) * scale,
    ))
}
fn return_frame(start: (f64, f64, f64), end: (f64, f64, f64), t: f64) -> (f64, f64, f64) {
    let ease = ease_out(t);
    (
        start.0 + (end.0 - start.0) * ease,
        start.1 + (end.1 - start.1) * ease,
        start.2 + (end.2 - start.2) * ease,
    )
}
fn animate_return(app: &AppHandle, captured: bool) {
    let grab = app.state::<Grab>();
    *grab.return_geometry.lock().unwrap() = None;
    let _ = app.emit_to("island", "grab-returning", json!({"captured":captured}));
    let target = grab
        .return_wake
        .wait_timeout_while(
            grab.return_geometry.lock().unwrap(),
            std::time::Duration::from_millis(500),
            |target| target.is_none() && grab.detached.load(Ordering::SeqCst),
        )
        .ok()
        .and_then(|(guard, _)| guard.clone());
    let (Some(win), Some(island)) = (
        app.get_webview_window("grab-companion"),
        app.get_webview_window("island"),
    ) else {
        return;
    };
    if let (Ok(start), Ok(origin)) = (win.outer_position(), island.outer_position()) {
        let source = grab.companion.lock().unwrap().clone();
        let scale = win.scale_factor().unwrap_or(1.0);
        let island_scale = island.scale_factor().unwrap_or(1.0);
        let target = target.unwrap_or(
            json!({"x":source["returnX"],"y":source["returnY"],"renderSize":source["sourceSize"]}),
        );
        let from = (
            start.x as f64 + 52.0 * scale,
            start.y as f64 + 48.0 * scale,
            source["renderSize"].as_f64().unwrap_or(64.0),
        );
        let to = (
            origin.x as f64 + target["x"].as_f64().unwrap_or(300.0) * island_scale,
            origin.y as f64 + target["y"].as_f64().unwrap_or(28.0) * island_scale,
            target["renderSize"]
                .as_f64()
                .unwrap_or(from.2)
                .clamp(20.0, 100.0),
        );
        let distance = (to.0 - from.0).hypot(to.1 - from.1) / scale;
        let duration = (220.0 + distance * 0.15).clamp(220.0, 420.0) as u64;
        let started = motion_start_ms();
        let _ = win.emit(
            "grab-companion-pose",
            json!({"renderSize":to.2,"durationMs":duration,"startedAt":started}),
        );
        loop {
            if !grab.detached.load(Ordering::SeqCst) {
                break;
            }
            let current = grab
                .return_geometry
                .lock()
                .unwrap()
                .clone()
                .unwrap_or(target.clone());
            let destination = (
                origin.x as f64 + current["x"].as_f64().unwrap_or(300.0) * island_scale,
                origin.y as f64 + current["y"].as_f64().unwrap_or(28.0) * island_scale,
                current["renderSize"]
                    .as_f64()
                    .unwrap_or(to.2)
                    .clamp(20.0, 100.0),
            );
            let t = motion_start_ms().saturating_sub(started) as f64 / duration as f64;
            let (x, y, size) = return_frame(from, destination, t);
            let _=win.emit("grab-companion-pose",json!({"renderSize":size,"durationMs":16,"startedAt":motion_start_ms(),"immediate":true}));
            position_center(&win, x, y, size);
            if t >= 1.0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
    }
}
pub fn return_to_panel(app: &AppHandle) {
    let grab = app.state::<Grab>();
    if !grab.detached.load(Ordering::SeqCst) || grab.capturing.swap(true, Ordering::SeqCst) {
        return;
    }
    // A short gesture can finish before the child WebView paints. The source is
    // still visible then, so cancellation releases it immediately without a wait.
    if app
        .get_webview_window("grab-companion")
        .is_none_or(|win| !win.is_visible().unwrap_or(false))
    {
        dock(app);
        grab.capturing.store(false, Ordering::SeqCst);
        let _ = app.emit_to("island", "grab-return", ());
        return;
    }
    let _ = app.emit_to("island", "grab-detached", true);
    animate_return(app, false);
    dock(app);
    grab.capturing.store(false, Ordering::SeqCst);
    let _ = app.emit_to("island", "grab-return", ());
}
fn capture_target(app: &AppHandle, x: f64, y: f64) -> Result<Value, String> {
    let grab = app.state::<Grab>();
    if return_point(app, x, y).is_some() {
        return_to_panel(app);
        return Ok(json!(true));
    }
    // DOM release and native release can arrive together. Only one capture owns this drag.
    if !grab.detached.load(Ordering::SeqCst) || grab.capturing.swap(true, Ordering::SeqCst) {
        return Ok(json!(true));
    }
    let mut hidden = vec![];
    for label in ["island", "settings", "grab-companion"] {
        if let Some(win) = app.get_webview_window(label) {
            if win.is_visible().unwrap_or(false) {
                let _ = win.hide();
                hidden.push(label);
            }
        }
    }
    std::thread::sleep(std::time::Duration::from_millis(40));
    let result = (|| {
        let (pixels, title, rect) = grab_capture::target(windows::Win32::Foundation::POINT {
            x: x as i32,
            y: y as i32,
        })?;
        // Only the actual frozen screen read hides Mimo. Keep him visible while saving.
        if let Some(win) = app.get_webview_window("grab-companion") {
            let _ = win.show();
        }
        let mut library = grab.library()?;
        let reference = store::add(
            &store::root(),
            library.as_mut().unwrap(),
            &store::encode(&pixels)?,
            &title,
            "image/png",
            "visible app window",
            "Captures",
        )?;
        let _ = app.emit_to("island", "grab-shutter", ());
        let scale = app
            .get_webview_window("grab-companion")
            .and_then(|win| win.scale_factor().ok())
            .unwrap_or(1.0);
        grab_capture::feedback((x, y), scale, rect);
        Ok(json!(reference))
    })();
    // Restore on every success/error path, including blocked or unsupported windows.
    for label in hidden {
        if label != "grab-companion" {
            if let Some(win) = app.get_webview_window(label) {
                let _ = win.show();
            }
        }
    }
    // Bring the receiving surface back first, then transfer Mimo into its actual
    // visible slot. Capture completion never destroys a companion at the cursor.
    if let Some(win) = app.get_webview_window("grab-companion") {
        let _ = win.show();
    }
    let _ = app.emit_to("island", "grab-detached", true);
    animate_return(app, result.is_ok());
    dock(app);
    grab.capturing.store(false, Ordering::SeqCst);
    let _ = app.emit_to("island", "grab-open", ());
    if let Err(error) = &result {
        let _ = app.emit("grab-error", error);
    } else {
        let _ = app.emit("grab-changed", ());
        if let Ok(reference) = &result {
            let _ = app.emit_to("island", "grab-captured", json!({"id":reference["id"]}));
        }
    }
    result
}

#[cfg(test)]
mod motion_tests {
    use super::*;
    #[test]
    fn pickup_preserves_the_selected_point_at_both_display_scales() {
        let source = json!({"sourceSize":40.0,"renderSize":64.0,"anchorX":8.0,"anchorY":-4.0});
        assert_eq!(pointer_center(&source, 400.0, 200.0, 1.0), (387.2, 206.4));
        assert_eq!(pointer_center(&source, -600.0, 300.0, 2.0), (-625.6, 312.8));
    }
    #[test]
    fn cancel_uses_the_visible_lip_instead_of_the_transparent_window() {
        let rect = crate::island::IslandRect {
            x: 228.0,
            y: 0.0,
            w: 264.0,
            h: 40.0,
            radius: 20.0,
        };
        assert!(within_return_slot(rect, 230.0, 20.0));
        assert!(!within_return_slot(rect, 40.0, 200.0));
        assert!(!within_return_slot(rect, 360.0, 100.0));
        assert!(!within_return_slot(
            crate::island::IslandRect::default(),
            0.0,
            0.0
        ));
    }
    #[test]
    fn returning_converges_to_the_real_source_geometry_and_size() {
        let from = (-1000.0, 600.0, 64.0);
        let to = (-580.0, 20.0, 40.0);
        assert_eq!(return_frame(from, to, 0.0), from);
        assert_eq!(return_frame(from, to, 1.0), to);
        let half = return_frame(from, to, 0.5);
        assert!(half.0 > from.0 && half.0 < to.0);
        assert!(half.1 < from.1 && half.1 > to.1);
        assert!(half.2 < from.2 && half.2 > to.2);
        assert_eq!(return_frame(from, to, 2.0), to);
    }
}
