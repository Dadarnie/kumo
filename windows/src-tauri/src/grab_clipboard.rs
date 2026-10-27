// SPDX-License-Identifier: MIT
//! Windows clipboard offers image, files, and text formats for the same selection.
//! Immutable copies live in Mimo app data so later shelf edits cannot change a paste.
use crate::grab_store::{self as store, Library};
use windows::{
    core::w,
    Win32::{
        Foundation::{GlobalFree, HANDLE},
        Graphics::Gdi::*,
        System::{DataExchange::*, Memory::*},
        UI::Shell::DROPFILES,
    },
};

unsafe fn put(format: u32, bytes: &[u8]) -> Result<(), String> {
    let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) }
        .map_err(|_| "Windows could not allocate the clipboard.")?;
    let pointer = unsafe { GlobalLock(memory) };
    if pointer.is_null() {
        let _ = unsafe { GlobalFree(Some(memory)) };
        return Err("Windows could not open clipboard memory.".into());
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer.cast(), bytes.len());
        let _ = GlobalUnlock(memory);
    }
    if unsafe { SetClipboardData(format, Some(HANDLE(memory.0))) }.is_err() {
        let _ = unsafe { GlobalFree(Some(memory)) };
        return Err("Windows could not copy this reference.".into());
    }
    Ok(())
}
fn unicode(text: &str) -> Vec<u8> {
    text.encode_utf16()
        .chain([0])
        .flat_map(u16::to_le_bytes)
        .collect()
}
fn file_list(paths: &[String]) -> Vec<u8> {
    let header = DROPFILES {
        pFiles: std::mem::size_of::<DROPFILES>() as u32,
        fWide: windows::core::BOOL(1),
        ..Default::default()
    };
    let mut bytes = unsafe {
        std::slice::from_raw_parts(
            (&header as *const DROPFILES).cast::<u8>(),
            std::mem::size_of::<DROPFILES>(),
        )
    }
    .to_vec();
    for path in paths {
        bytes.extend(unicode(path));
    }
    bytes.extend([0, 0]);
    bytes
}
fn dib(p: &store::Pixels) -> Vec<u8> {
    let mut header = BITMAPV5HEADER::default();
    header.bV5Size = std::mem::size_of::<BITMAPV5HEADER>() as u32;
    header.bV5Width = p.width as i32;
    header.bV5Height = -(p.height as i32);
    header.bV5Planes = 1;
    header.bV5BitCount = 32;
    header.bV5Compression = BI_BITFIELDS;
    header.bV5SizeImage = p.rgba.len() as u32;
    header.bV5RedMask = 0x00ff0000;
    header.bV5GreenMask = 0x0000ff00;
    header.bV5BlueMask = 0x000000ff;
    header.bV5AlphaMask = 0xff000000;
    header.bV5CSType = 0x73524742;
    let mut bytes = unsafe {
        std::slice::from_raw_parts(
            (&header as *const BITMAPV5HEADER).cast::<u8>(),
            std::mem::size_of::<BITMAPV5HEADER>(),
        )
    }
    .to_vec();
    bytes.reserve(p.rgba.len());
    for pixel in p.rgba.chunks_exact(4) {
        bytes.extend([pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    bytes
}
pub fn copy(
    app: &tauri::AppHandle,
    library: &Library,
    ids: &[String],
    instruction: &str,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let win = app
        .get_webview_window("island")
        .ok_or("Kumo's clipboard window is unavailable.")?;
    let hwnd = win
        .hwnd()
        .map_err(|_| "Kumo's clipboard window is unavailable.")?;
    if ids.is_empty() || ids.len() > 40 || instruction.len() > 12000 {
        return Err(
            "Choose 1 to 40 references and keep the instruction under 12,000 characters.".into(),
        );
    }
    let token = unsafe { windows::Win32::System::Com::CoCreateGuid() }
        .map_err(|_| "Could not prepare clipboard references.")?;
    let dir = store::root().join("clipboard").join(format!(
        "c{}-{:08x}-{:04x}",
        store::stamp(),
        token.data1,
        token.data2
    ));
    std::fs::create_dir_all(&dir).map_err(|_| "Could not prepare reference copies.")?;
    let mut paths = vec![];
    let mut prompt = instruction.trim().to_owned();
    if !prompt.is_empty() {
        prompt.push_str("\n\n");
    }
    prompt.push_str("References (local files):\n");
    let mut first_png = None;
    for (index, id) in ids.iter().enumerate() {
        let r = store::item(library, id)?;
        let original = store::path(&store::root(), r, true)?;
        let path = dir.join(format!(
            "reference-{}.{}",
            index + 1,
            original.extension().unwrap_or_default().to_string_lossy()
        ));
        std::fs::copy(original, &path).map_err(|_| "Could not copy this reference.")?;
        let clean = path
            .to_string_lossy()
            .trim_start_matches("\\\\?\\")
            .to_owned();
        prompt.push_str(&format!(
            "{}. {}\n\"{}\"{}\n",
            index + 1,
            r.label,
            clean,
            if r.note.is_empty() {
                String::new()
            } else {
                format!("\nNote: {}", r.note)
            }
        ));
        paths.push(clean);
        if ids.len() == 1 && (r.mime == "image/png" || r.annotated) {
            let bytes = std::fs::read(&path).map_err(|_| "Could not read this image.")?;
            first_png = Some((dib(&store::decode(&bytes)?), bytes));
        }
    }
    let text = unicode(&prompt);
    let files = file_list(&paths);
    unsafe {
        OpenClipboard(Some(windows::Win32::Foundation::HWND(hwnd.0)))
            .map_err(|_| "The clipboard is busy. Try copying again.")?;
        let result: Result<(), String> = (|| {
            EmptyClipboard().map_err(|_| "Could not clear the clipboard.")?;
            put(13, &text)?;
            put(15, &files)?;
            if let Some((dib, png)) = first_png {
                put(17, &dib)?;
                let format = RegisterClipboardFormatW(w!("PNG"));
                if format != 0 {
                    put(format, &png)?;
                }
            }
            Ok(())
        })();
        let _ = CloseClipboard();
        result?;
    }
    Ok(
        serde_json::json!({"count":ids.len(),"message":if ids.len()==1&&first_is_image(library,ids){"Copied. Paste the image in an app that accepts images, or paste reference paths and notes in your terminal."}else{"Copied. Paste the reference paths and notes in your terminal; file-aware apps can paste the selected files."}}),
    )
}
fn first_is_image(l: &Library, ids: &[String]) -> bool {
    store::item(l, &ids[0]).is_ok_and(|r| r.mime == "image/png" || r.annotated)
}
pub fn cleanup(keep_days: u32) -> Result<(), String> {
    let root = store::root().join("clipboard");
    if keep_days == 0 || !root.is_dir() {
        return Ok(());
    }
    let base = root
        .canonicalize()
        .map_err(|_| "Could not clean clipboard copies.")?;
    for entry in std::fs::read_dir(&root)
        .map_err(|_| "Could not clean clipboard copies.")?
        .flatten()
    {
        let p = entry.path();
        if p.is_dir()
            && p.canonicalize()
                .ok()
                .is_some_and(|p| p.parent() == Some(base.as_path()))
            && entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_secs() > keep_days as u64 * 86400)
        {
            let _ = std::fs::remove_dir_all(p);
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clipboard_formats_preserve_unicode_and_pixels() {
        assert_eq!(unicode("α"), vec![0xb1, 3, 0, 0]);
        let list = file_list(&["C:\\Mimo\\one.png".into(), "C:\\Mimo\\two.png".into()]);
        assert_eq!(&list[list.len() - 4..], &[0, 0, 0, 0]);
        let p = store::Pixels {
            width: 1,
            height: 1,
            rgba: vec![10, 20, 30, 255],
        };
        let bytes = dib(&p);
        assert_eq!(&bytes[124..], &[30, 20, 10, 255]);
        assert_eq!(i32::from_le_bytes(bytes[8..12].try_into().unwrap()), -1);
    }
}

/// What the clipboard holds now: copied files (Explorer's file list) or text. For "send to phone".
pub fn contents() -> Result<(Vec<std::path::PathBuf>, Option<String>), String> {
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
    unsafe {
        OpenClipboard(None).map_err(|_| "The clipboard is busy. Try again.")?;
        let read = (|| {
            if IsClipboardFormatAvailable(15).is_ok() {
                if let Ok(handle) = GetClipboardData(15) {
                    let drop = HDROP(handle.0);
                    let mut files = Vec::new();
                    for index in 0..DragQueryFileW(drop, u32::MAX, None) {
                        let mut name = vec![0u16; DragQueryFileW(drop, index, None) as usize + 1];
                        let length = DragQueryFileW(drop, index, Some(&mut name)) as usize;
                        files.push(std::path::PathBuf::from(String::from_utf16_lossy(
                            &name[..length],
                        )));
                    }
                    if !files.is_empty() {
                        return Ok((files, None));
                    }
                }
            }
            if IsClipboardFormatAvailable(13).is_ok() {
                if let Ok(handle) = GetClipboardData(13) {
                    let memory = windows::Win32::Foundation::HGLOBAL(handle.0);
                    let pointer = GlobalLock(memory) as *const u16;
                    if !pointer.is_null() {
                        let mut length = 0;
                        while *pointer.add(length) != 0 && length < 1_000_000 {
                            length += 1;
                        }
                        let text =
                            String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length));
                        let _ = GlobalUnlock(memory);
                        if !text.trim().is_empty() {
                            return Ok((Vec::new(), Some(text)));
                        }
                    }
                }
            }
            Err("The clipboard has no text or files to send.".to_string())
        })();
        let _ = CloseClipboard();
        read
    }
}

#[cfg(test)]
mod clipboard_tests {
    /// Run with --ignored after putting text or files on the clipboard.
    #[test]
    #[ignore]
    fn live_clipboard_contents() {
        println!("clipboard: {:?}", super::contents());
    }
}
