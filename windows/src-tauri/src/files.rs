// SPDX-License-Identifier: MIT
// Dropped files are copied into %LOCALAPPDATA%\Mimo\inbox so the original is
// never touched and the copy survives the drag source going away.
// The inbox is swept of anything older than a week, as on macOS.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::settings;

/// IPC attachment paths are references to Mimo's own inbox, never arbitrary files.
pub fn validate_context(context: &Option<crate::claude::ChatContext>) -> Result<(), String> {
    let Some(context) = context else {
        return Ok(());
    };
    if let crate::claude::ChatContext::Files { files } = context {
        if files.is_empty() || files.len() > MAX_CHAT_FILES {
            return Err(format!(
                "Attach between 1 and {MAX_CHAT_FILES} files at a time."
            ));
        }
    }
    for (name, path) in context.file_refs() {
        let inbox = inbox_dir()
            .canonicalize()
            .map_err(|_| "Attach this file again.")?;
        let file = Path::new(path)
            .canonicalize()
            .map_err(|_| "Attach this file again.")?;
        if file.parent() != Some(inbox.as_path()) || !file.is_file() || name.len() > 512 {
            return Err("Attach the file to Kumo before sending it.".into());
        }
    }
    Ok(())
}

pub const MAX_CHAT_FILES: usize = 5;

const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

pub fn inbox_dir() -> PathBuf {
    settings::local_dir().join("inbox")
}

pub fn ingest(source: &str) -> Result<DroppedFile, String> {
    let src = Path::new(source);
    let meta = std::fs::metadata(src).map_err(|e| format!("cannot read {source}: {e}"))?;
    if meta.is_dir() {
        return Err("Folders can't be dropped yet.".into());
    }

    let dir = inbox_dir();
    crate::windows::ensure_private_dir(&settings::local_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());

    let mut dest = dir.join(&name);
    if dest.exists() {
        let stem = src
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = src
            .extension()
            .map(|s| format!(".{}", s.to_string_lossy()))
            .unwrap_or_default();
        for i in 2..1000 {
            let candidate = dir.join(format!("{stem} ({i}){ext}"));
            if !candidate.exists() {
                dest = candidate;
                break;
            }
        }
    }

    std::fs::copy(src, &dest).map_err(|e| format!("cannot copy: {e}"))?;
    // CopyFileEx carries the source's timestamps across, so a file last edited
    // three years ago would arrive already older than the sweep window and be
    // deleted on the spot. The inbox ages from when *we* copied it.
    if let Ok(file) = std::fs::File::options().write(true).open(&dest) {
        let _ = file.set_modified(SystemTime::now());
    }
    sweep(&dir);

    Ok(DroppedFile {
        name,
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
    })
}

/// Drops anything copied here more than a week ago. `ingest` stamps every copy
/// with the time it landed, so this really is the age of the copy and not the
/// age of whatever the user happened to drag in.
fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(copied) = meta.modified() else {
            continue;
        };
        if now
            .duration_since(copied)
            .map(|age| age > KEEP_FOR)
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
pub(crate) struct TestBatch {
    pub context: crate::claude::ChatContext,
    paths: Vec<PathBuf>,
}
#[cfg(test)]
impl TestBatch {
    pub fn new(count: usize) -> Self {
        let inbox = inbox_dir();
        std::fs::create_dir_all(&inbox).unwrap();
        let key = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let mut paths = Vec::new();
        let files = (0..count)
            .map(|index| {
                let name = format!("mimo-batch-test-{key}-{index}.txt");
                let path = inbox.join(&name);
                std::fs::write(&path, format!("batch-content-{index}")).unwrap();
                paths.push(path.clone());
                crate::claude::ChatFile {
                    name,
                    path: path.to_string_lossy().into(),
                }
            })
            .collect();
        Self {
            context: crate::claude::ChatContext::Files { files },
            paths,
        }
    }
}
#[cfg(test)]
impl Drop for TestBatch {
    fn drop(&mut self) {
        for path in &self.paths {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batches_validate_every_file_and_reject_empty_or_over_five() {
        let batch = TestBatch::new(MAX_CHAT_FILES);
        assert!(validate_context(&Some(batch.context.clone())).is_ok());
        assert!(validate_context(&Some(TestBatch::new(0).context.clone())).is_err());
        assert!(
            validate_context(&Some(TestBatch::new(MAX_CHAT_FILES + 1).context.clone())).is_err()
        );
        let mut invalid = batch.context.clone();
        if let crate::claude::ChatContext::Files { files } = &mut invalid {
            files[4].path = std::env::temp_dir().to_string_lossy().into();
        }
        assert!(
            validate_context(&Some(invalid)).is_err(),
            "Every reference must belong to the inbox"
        );
    }

    #[test]
    fn chat_cannot_read_an_arbitrary_file_path_from_ipc() {
        let path =
            std::env::temp_dir().join(format!("mimo-outside-inbox-{}.txt", std::process::id()));
        std::fs::write(&path, "synthetic-private").unwrap();
        let context = Some(crate::claude::ChatContext::File {
            name: "note.txt".into(),
            path: path.to_string_lossy().into(),
        });
        let error = validate_context(&context).unwrap_err();
        assert!(!error.contains("synthetic-private"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn ingest_copies_and_never_overwrites() {
        let tmp = std::env::temp_dir().join(format!("mimo-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let source = tmp.join("note.txt");
        std::fs::write(&source, b"hello").unwrap();

        let first = ingest(source.to_str().unwrap()).unwrap();
        assert_eq!(first.name, "note.txt");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");

        // A second drop of the same name must not clobber the first copy.
        std::fs::write(&source, b"second").unwrap();
        let second = ingest(source.to_str().unwrap()).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"second");

        // Folders are refused rather than silently ignored.
        assert!(ingest(tmp.to_str().unwrap()).is_err());

        // An ancient source must not arrive already older than the sweep window.
        let old_source = tmp.join("ancient.txt");
        std::fs::write(&old_source, b"old").unwrap();
        let long_ago = SystemTime::now() - KEEP_FOR - Duration::from_secs(60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old_source)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        let aged = ingest(old_source.to_str().unwrap()).unwrap();
        assert!(
            Path::new(&aged.path).exists(),
            "a file copied just now was swept as if it were a week old"
        );
        let _ = std::fs::remove_file(&aged.path);

        let _ = std::fs::remove_file(&first.path);
        let _ = std::fs::remove_file(&second.path);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
