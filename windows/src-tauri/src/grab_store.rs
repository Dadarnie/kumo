// SPDX-License-Identifier: MIT
//! Grab owns its copies under Mimo app data. User labels never become paths.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::Cursor,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 64_000_000;
pub fn stamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn root() -> PathBuf {
    crate::settings::local_dir().join("grab")
}
fn id() -> String {
    format!(
        "r{}-{}",
        stamp(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos()
    )
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub id: String,
    pub label: String,
    pub note: String,
    pub collection: String,
    pub created_at: u64,
    pub file: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub size: u64,
    pub source: String,
    pub duplicate_of: Option<String>,
    #[serde(default)]
    pub annotations: Value,
    #[serde(default)]
    pub annotated: bool,
    #[serde(default)]
    pub transform: Option<ImageTransform>,
    #[serde(default)]
    pub fingerprint: Vec<u8>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImageTransform {
    pub width: u32,
    pub height: u32,
    pub crop: ImageCrop,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImageCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl ImageTransform {
    pub fn valid(&self) -> bool {
        self.width > 0
            && self.height > 0
            && self.width as u64 * self.height as u64 <= MAX_PIXELS
            && [self.crop.x, self.crop.y, self.crop.width, self.crop.height]
                .iter()
                .all(|v| v.is_finite() && *v >= 0.0 && *v <= 1.0)
            && self.crop.width > 0.0
            && self.crop.height > 0.0
            && self.crop.x + self.crop.width <= 1.000001
            && self.crop.y + self.crop.height <= 1.000001
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Library {
    pub version: u32,
    pub items: Vec<Reference>,
    pub retention_days: u32,
}
impl Default for Library {
    fn default() -> Self {
        Self {
            version: 1,
            items: vec![],
            retention_days: 7,
        }
    }
}
pub fn load(dir: &Path) -> Result<Library, String> {
    std::fs::create_dir_all(dir).map_err(|_| "Could not open the Drop Shelf.")?;
    let file = dir.join("shelf.json");
    if !file.exists() {
        return Ok(Library::default());
    }
    let bytes = std::fs::read(&file).map_err(|_| "Could not read the Drop Shelf.")?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("The Drop Shelf metadata is too large.".into());
    }
    let mut library: Library = serde_json::from_slice(&bytes)
        .map_err(|_| "Drop Shelf metadata needs recovery. Your original files are preserved.")?;
    if library.version != 1 {
        return Err("This shelf was made by a newer Kumo version.".into());
    }
    library.items.retain(|item| {
        safe_id(&item.id)
            && safe_file(&item.file)
            && item.file.starts_with(&format!("{}.", item.id))
            && dir.join(&item.file).is_file()
    });
    Ok(library)
}
pub fn save(dir: &Path, library: &Library) -> Result<(), String> {
    let bytes = serde_json::to_vec(library).map_err(|_| "Could not save the Drop Shelf.")?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("The shelf metadata is full. Remove old references first.".into());
    }
    let temporary = dir.join("shelf.new.json");
    std::fs::write(&temporary, bytes).map_err(|_| "Could not save the Drop Shelf.")?;
    std::fs::rename(temporary, dir.join("shelf.json"))
        .map_err(|_| "Could not finish saving the Drop Shelf.".into())
}
fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}
fn safe_file(file: &str) -> bool {
    !file.is_empty() && !file.contains(['/', '\\', ':']) && !file.contains("..")
}
pub fn item<'a>(library: &'a Library, id: &str) -> Result<&'a Reference, String> {
    library
        .items
        .iter()
        .find(|r| r.id == id)
        .ok_or_else(|| "This reference is no longer on the shelf.".into())
}
pub fn path(dir: &Path, reference: &Reference, annotated: bool) -> Result<PathBuf, String> {
    if !safe_file(&reference.file) || !safe_id(&reference.id) {
        return Err("Invalid reference.".into());
    }
    let p = dir.join(if annotated && reference.annotated {
        format!("{}.annotated.png", reference.id)
    } else {
        reference.file.clone()
    });
    let base = dir
        .canonicalize()
        .map_err(|_| "The shelf is unavailable.")?;
    let canonical = p
        .canonicalize()
        .map_err(|_| "This reference file is missing.")?;
    if canonical.parent() != Some(base.as_path()) {
        return Err("Reference paths must stay inside Kumo.".into());
    }
    Ok(canonical)
}
pub struct Pixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}
pub fn decode(bytes: &[u8]) -> Result<Pixels, String> {
    if bytes.len() > MAX_BYTES {
        return Err("Use an image smaller than 32 MB.".into());
    }
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    decoder.set_limits(png::Limits {
        bytes: MAX_PIXELS as usize * 4,
    });
    let mut reader = decoder
        .read_info()
        .map_err(|_| "This is not a supported PNG.")?;
    let info = reader.info();
    if info.width == 0 || info.height == 0 || info.width as u64 * info.height as u64 > MAX_PIXELS {
        return Err("This image exceeds the capture size limit.".into());
    }
    let mut raw = vec![0; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut raw)
        .map_err(|_| "Could not decode this image.")?;
    let channels = info.color_type.samples();
    let mut rgba = Vec::with_capacity(info.width as usize * info.height as usize * 4);
    for p in raw[..info.buffer_size()].chunks_exact(channels) {
        match info.color_type {
            png::ColorType::Rgba => rgba.extend_from_slice(p),
            png::ColorType::Rgb => rgba.extend_from_slice(&[p[0], p[1], p[2], 255]),
            png::ColorType::Grayscale => rgba.extend_from_slice(&[p[0], p[0], p[0], 255]),
            png::ColorType::GrayscaleAlpha => rgba.extend_from_slice(&[p[0], p[0], p[0], p[1]]),
            _ => return Err("Unsupported image colors.".into()),
        }
    }
    Ok(Pixels {
        width: info.width,
        height: info.height,
        rgba,
    })
}
pub fn encode(p: &Pixels) -> Result<Vec<u8>, String> {
    if p.width == 0
        || p.height == 0
        || p.width as u64 * p.height as u64 > MAX_PIXELS
        || p.rgba.len() != p.width as usize * p.height as usize * 4
    {
        return Err("Invalid image size.".into());
    }
    let mut bytes = vec![];
    {
        let mut encoder = png::Encoder::new(&mut bytes, p.width, p.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|_| "Could not encode the capture.")?;
        writer
            .write_image_data(&p.rgba)
            .map_err(|_| "Could not encode the capture.")?;
    }
    if bytes.len() > MAX_BYTES {
        return Err("This capture is too large. Choose a smaller region.".into());
    }
    Ok(bytes)
}
fn resize(p: &Pixels, w: u32, h: u32) -> Pixels {
    let mut rgba = vec![0; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let src = ((y as u64 * p.height as u64 / h as u64) * p.width as u64
                + x as u64 * p.width as u64 / w as u64) as usize
                * 4;
            let dst = (y * w + x) as usize * 4;
            rgba[dst..dst + 4].copy_from_slice(&p.rgba[src..src + 4]);
        }
    }
    Pixels {
        width: w,
        height: h,
        rgba,
    }
}
fn display_pixels(p: &Pixels) -> Pixels {
    let ratio = (1280.0 / p.width as f64)
        .min(900.0 / p.height as f64)
        .min(1.0);
    let w = (p.width as f64 * ratio).round().max(1.0) as u32;
    let h = (p.height as f64 * ratio).round().max(1.0) as u32;
    if w == p.width && h == p.height {
        return Pixels {
            width: w,
            height: h,
            rgba: p.rgba.clone(),
        };
    }
    let mut rgba = vec![0; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let sx = ((x as f64 + 0.5) * p.width as f64 / w as f64 - 0.5).max(0.0);
            let sy = ((y as f64 + 0.5) * p.height as f64 / h as f64 - 0.5).max(0.0);
            let x0 = (sx as u32).min(p.width - 1);
            let x1 = (x0 + 1).min(p.width - 1);
            let y0 = (sy as u32).min(p.height - 1);
            let y1 = (y0 + 1).min(p.height - 1);
            let fx = sx - x0 as f64;
            let fy = sy - y0 as f64;
            for c in 0..4 {
                let sample =
                    |px: u32, py: u32| p.rgba[((py * p.width + px) * 4) as usize + c] as f64;
                rgba[((y * w + x) * 4) as usize + c] =
                    ((sample(x0, y0) * (1.0 - fx) + sample(x1, y0) * fx) * (1.0 - fy)
                        + (sample(x0, y1) * (1.0 - fx) + sample(x1, y1) * fx) * fy)
                        .round() as u8;
            }
        }
    }
    Pixels {
        width: w,
        height: h,
        rgba,
    }
}
fn signature(p: &Pixels) -> Vec<u8> {
    resize(p, 16, 16)
        .rgba
        .chunks_exact(4)
        .map(|p| ((p[0] as u16 * 3 + p[1] as u16 * 6 + p[2] as u16) / 10) as u8)
        .collect()
}
pub fn similar(a: &Reference, p: &Pixels, signature: &[u8]) -> bool {
    a.width == p.width
        && a.height == p.height
        && a.fingerprint.len() == signature.len()
        && !signature.is_empty()
        && a.fingerprint
            .iter()
            .zip(signature)
            .map(|(x, y)| x.abs_diff(*y) as u32)
            .sum::<u32>()
            < signature.len() as u32 * 2
}
pub fn add(
    dir: &Path,
    library: &mut Library,
    bytes: &[u8],
    name: &str,
    mime: &str,
    source: &str,
    collection: &str,
) -> Result<Reference, String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES || library.items.len() >= 200 {
        return Err(
            "The shelf is full. Remove a few references first (200 items, 32 MB per file).".into(),
        );
    }
    if library.items.iter().map(|r| r.size).sum::<u64>() + bytes.len() as u64 > 1024 * 1024 * 1024 {
        return Err("The shelf reached 1 GB. Remove old references first.".into());
    }
    let pixels = if mime == "image/png" {
        Some(decode(bytes)?)
    } else {
        None
    };
    let (width, height) = pixels
        .as_ref()
        .map(|p| (p.width, p.height))
        .unwrap_or((0, 0));
    let fingerprint = pixels.as_ref().map(signature).unwrap_or_default();
    let duplicate_of = pixels.as_ref().and_then(|p| {
        library
            .items
            .iter()
            .rev()
            .find(|r| similar(r, p, &fingerprint))
            .map(|r| r.id.clone())
    });
    let id = id();
    let extension = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "application/pdf" => "pdf",
        _ => name
            .rsplit_once('.')
            .map(|(_, ext)| ext)
            .filter(|ext| {
                !ext.is_empty() && ext.len() <= 12 && ext.chars().all(|c| c.is_ascii_alphanumeric())
            })
            .unwrap_or("file"),
    };
    let file = format!("{id}.{extension}");
    std::fs::write(dir.join(&file), bytes).map_err(|_| "Could not save this reference.")?;
    if let Some(p) = pixels {
        let ratio = (320.0 / p.width as f64)
            .min(180.0 / p.height as f64)
            .min(1.0);
        let thumb = resize(
            &p,
            (p.width as f64 * ratio).round().max(1.0) as u32,
            (p.height as f64 * ratio).round().max(1.0) as u32,
        );
        std::fs::write(dir.join(format!("{id}.thumb.png")), encode(&thumb)?)
            .map_err(|_| "Could not save the thumbnail.")?;
    }
    let reference = Reference {
        id,
        label: name.chars().take(160).collect(),
        note: String::new(),
        collection: collection.chars().take(80).collect(),
        created_at: stamp(),
        file,
        mime: mime.into(),
        width,
        height,
        size: bytes.len() as u64,
        source: source.chars().take(2048).collect(),
        duplicate_of,
        annotations: Value::Null,
        annotated: false,
        transform: None,
        fingerprint,
    };
    library.items.push(reference.clone());
    if let Err(error) = save(dir, library) {
        library.items.pop();
        let _ = std::fs::remove_file(dir.join(&reference.file));
        let _ = std::fs::remove_file(dir.join(format!("{}.thumb.png", reference.id)));
        return Err(error);
    }
    Ok(reference)
}
pub fn preview(
    dir: &Path,
    reference: &Reference,
    thumbnail: bool,
    display: bool,
) -> Result<String, String> {
    path(dir, reference, false)?;
    let thumb = dir.join(format!("{}.thumb.png", reference.id));
    let displayed = dir.join(format!("{}.display.png", reference.id));
    if display && reference.mime == "image/png" && !displayed.is_file() {
        let source = std::fs::read(path(dir, reference, true)?)
            .map_err(|_| "Could not load the reference.")?;
        std::fs::write(&displayed, encode(&display_pixels(&decode(&source)?))?)
            .map_err(|_| "Could not prepare the image preview.")?;
    }
    let (file, mime) = if display && displayed.is_file() {
        (displayed, "image/png")
    } else if thumbnail && thumb.is_file() {
        (thumb, "image/png")
    } else {
        (path(dir, reference, display)?, reference.mime.as_str())
    };
    if !mime.starts_with("image/") {
        return Err("Preview is available for image references.".into());
    }
    if file
        .canonicalize()
        .map_err(|_| "This preview is unavailable.")?
        .parent()
        != Some(
            dir.canonicalize()
                .map_err(|_| "The shelf is unavailable.")?
                .as_path(),
        )
    {
        return Err("Preview paths must stay inside Kumo.".into());
    }
    let bytes = std::fs::read(file).map_err(|_| "Could not load the reference.")?;
    if bytes.len() > MAX_BYTES {
        return Err("This image is too large to preview.".into());
    }
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}
pub fn remove(dir: &Path, library: &mut Library, ids: &[String]) -> Result<(), String> {
    let removed: Vec<_> = library
        .items
        .iter()
        .filter(|r| ids.contains(&r.id))
        .cloned()
        .collect();
    let previous = library.items.clone();
    library.items.retain(|r| !ids.contains(&r.id));
    if let Err(error) = save(dir, library) {
        library.items = previous;
        return Err(error);
    }
    for r in removed {
        if let Ok(p) = path(dir, &r, false) {
            let _ = std::fs::remove_file(p);
        }
        for suffix in ["thumb.png", "display.png", "annotated.png"] {
            let _ = std::fs::remove_file(dir.join(format!("{}.{suffix}", r.id)));
        }
    }
    Ok(())
}
pub fn expire(dir: &Path, library: &mut Library) -> Result<(), String> {
    if library.retention_days == 0 {
        return Ok(());
    }
    let age = library.retention_days as u64 * 86_400_000;
    let ids = library
        .items
        .iter()
        .filter(|r| stamp().saturating_sub(r.created_at) > age)
        .map(|r| r.id.clone())
        .collect::<Vec<_>>();
    remove(dir, library, &ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn png_roundtrip_duplicate_detection_and_paths_stay_owned() {
        let p = Pixels {
            width: 4,
            height: 4,
            rgba: vec![255; 64],
        };
        assert_eq!(decode(&encode(&p).unwrap()).unwrap().rgba, p.rgba);
        let dir = std::env::temp_dir().join(format!("mimo-grab-store-{}", id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut l = Library::default();
        let a = add(
            &dir,
            &mut l,
            &encode(&p).unwrap(),
            "../user-label",
            "image/png",
            "screen",
            "Site",
        )
        .unwrap();
        let b = add(
            &dir,
            &mut l,
            &encode(&p).unwrap(),
            "Second",
            "image/png",
            "screen",
            "Site",
        )
        .unwrap();
        assert_eq!(b.duplicate_of, Some(a.id.clone()));
        assert!(path(&dir, &a, false)
            .unwrap()
            .starts_with(dir.canonicalize().unwrap()));
        let mut bad = a.clone();
        bad.file = "../outside.png".into();
        assert!(path(&dir, &bad, false).is_err());
        assert_eq!(load(&dir).unwrap().items.len(), 2);
        remove(&dir, &mut l, &[a.id.clone()]).unwrap();
        assert!(path(&dir, &a, false).is_err());
        assert!(path(&dir, &b, false).is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
