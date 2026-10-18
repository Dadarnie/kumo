// SPDX-License-Identifier: MIT
//! Shared safe file boundary for both providers' hook installers.
use crate::hooks;
use serde_json::Value;
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub fn read(path: &Path) -> Result<Vec<u8>, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Could not read the hooks file. Check file permissions.".into()),
    };
    let mut bytes = Vec::new();
    file.take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read the hooks file.")?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("Hooks file is too large. Nothing was changed.".into());
    }
    Ok(bytes)
}

pub fn validate(root: &Value) -> Result<(), String> {
    if let Some(value) = root.get("hooks") {
        let events = value
            .as_object()
            .ok_or("Invalid hooks table. Nothing was changed.")?;
        for value in events.values() {
            let groups = value
                .as_array()
                .ok_or("Invalid hook event list. Nothing was changed.")?;
            for group in groups {
                if !group.is_object()
                    || group
                        .get("hooks")
                        .is_some_and(|handlers| !handlers.is_array())
                {
                    return Err("Invalid hook handlers. Nothing was changed.".into());
                }
            }
        }
    }
    Ok(())
}

pub fn backup_path(path: &Path) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    path.with_file_name(format!(
        "{}.bak-{}-{nonce:x}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        hooks::stamp()
    ))
}

pub fn save(path: &Path, bytes: &[u8], next: &Value) -> Result<String, String> {
    save_bytes(path, bytes, format!("{}\n", hooks::pretty(next)).as_bytes())
}

/// The same compare/backup/atomic-write boundary for local observer plugins.
pub fn save_bytes(path: &Path, bytes: &[u8], next: &[u8]) -> Result<String, String> {
    if read(path)?.as_slice() != bytes {
        return Err("Hooks changed since the preview. Review a fresh preview.".into());
    }
    let dir = path.parent().ok_or("Invalid hooks path.")?;
    std::fs::create_dir_all(dir).map_err(|_| "Could not create the hooks folder.")?;
    let backup = backup_path(path);
    if path.exists() {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&backup)
            .map_err(|_| "Could not create a unique hooks backup. Try again.")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not save the hooks backup.")?;
    }
    let temp = path.with_extension(format!("mimo-{}.tmp", std::process::id()));
    let mut created = false;
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        created = true;
        file.write_all(next)?;
        file.sync_all()?;
        drop(file);
        if read(path).ok().as_deref() != Some(bytes) {
            return Err(std::io::Error::other("Hooks changed during write"));
        }
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        if created {
            let _ = std::fs::remove_file(&temp);
        }
        return Err("Could not save hooks. The original file was kept. Review a fresh preview and try again.".into());
    }
    Ok(backup.to_string_lossy().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_event_tables_are_refused_before_writing() {
        for root in [
            serde_json::json!({"hooks":[]}),
            serde_json::json!({"hooks":{"Stop":{}}}),
            serde_json::json!({"hooks":{"Stop":[{"hooks":{}}]}}),
        ] {
            assert!(validate(&root).is_err());
        }
        assert!(validate(
            &serde_json::json!({"hooks":{"Stop":[{"hooks":[]}]},"foreign":"unchanged"})
        )
        .is_ok());
    }
}
