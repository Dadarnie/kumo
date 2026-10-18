// SPDX-License-Identifier: MIT
// API keys live in Windows Credential Manager, never in the front end.
// The island can only ask whether a key is present.

use keyring::Entry;

const SERVICE: &str = crate::migration::IDENTIFIER;

/// Every key Mimo may store. Anything outside this list is refused.
pub const KNOWN_KEYS: &[&str] = &[
    "anthropic-api-key",
    "openai-api-key",
    "gemini-api-key",
    "openrouter-api-key",
    "xai-api-key",
    "groq-api-key",
    "n8n-url",
    "n8n-api-key",
    "vercel-token",
    "github-token",
    "stripe-api-key",
    "resend-api-key",
    "notion-api-key",
    "calcom-api-key",
];

fn entry_for(service: &str, key: &str) -> Option<Entry> {
    if !KNOWN_KEYS.contains(&key) {
        return None;
    }
    Entry::new(service, key).ok()
}

fn entry(key: &str) -> Option<Entry> {
    entry_for(SERVICE, key)
}

fn read_migrated(
    key: &str,
    read: impl Fn(&str, &str) -> Option<String>,
    write: impl Fn(&str, &str, &str),
) -> Option<String> {
    if !KNOWN_KEYS.contains(&key) {
        return None;
    }
    if let Some(value) = read(SERVICE, key).filter(|value| !value.is_empty()) {
        return Some(value);
    }
    let value =
        read(&crate::migration::legacy_identifier(), key).filter(|value| !value.is_empty())?;
    // Keep the original credential even if the new store is unavailable.
    write(SERVICE, key, &value);
    Some(value)
}

pub fn get(key: &str) -> Option<String> {
    read_migrated(
        key,
        |service, key| entry_for(service, key)?.get_password().ok(),
        |service, key, value| {
            if let Some(entry) = entry_for(service, key) {
                let _ = entry.set_password(value);
            }
        },
    )
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    validate(key, value)?;
    let entry = entry(key).ok_or("Windows credential storage is unavailable.")?;
    if value.is_empty() {
        return Err("Enter a value, or use Remove to delete a stored credential.".into());
    }
    entry
        .set_password(value)
        .map_err(|_| "Could not save the credential in Windows Credential Manager.".into())
}

pub fn clear(key: &str) -> Result<(), String> {
    if !KNOWN_KEYS.contains(&key) {
        return Err("Unknown credential type.".into());
    }
    // Removing both entries prevents a deleted key from returning on migration.
    for service in [crate::migration::legacy_identifier(), SERVICE.to_string()] {
        let entry = entry_for(&service, key).ok_or("Windows credential storage is unavailable.")?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => {
                return Err(
                    "Could not remove the credential from Windows Credential Manager.".into(),
                )
            }
        }
    }
    Ok(())
}

pub fn present(key: &str) -> bool {
    get(key).is_some()
}

pub(crate) fn validate(key: &str, value: &str) -> Result<(), String> {
    if !KNOWN_KEYS.contains(&key) {
        return Err("Unknown credential type.".into());
    }
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return Err("Credential contains unsupported characters or is too long.".into());
    }
    if key == "n8n-url" && !value.is_empty() {
        let url = reqwest::Url::parse(value).map_err(|_| "Enter a valid n8n URL.")?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Use an n8n base URL without credentials, a query, or a fragment.".into());
        }
        if url.scheme() != "https"
            && !(url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
        {
            return Err("Use HTTPS for n8n, or HTTP on localhost.".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_prefers_current_credentials_and_keeps_previous_values_on_copy_failure() {
        let copied = std::cell::RefCell::new(Vec::new());
        let read = |service: &str, _: &str| {
            if service == SERVICE {
                None
            } else {
                Some("previous-value".into())
            }
        };
        assert_eq!(
            read_migrated("openai-api-key", read, |service, key, value| copied
                .borrow_mut()
                .push((service.to_string(), key.to_string(), value.to_string()))),
            Some("previous-value".into())
        );
        assert_eq!(
            copied.borrow()[0],
            (
                SERVICE.into(),
                "openai-api-key".into(),
                "previous-value".into()
            )
        );
        assert_eq!(
            read_migrated(
                "openai-api-key",
                |service, _| Some(
                    if service == SERVICE {
                        "current-value"
                    } else {
                        "previous-value"
                    }
                    .into()
                ),
                |_, _, _| panic!("current credential must not be overwritten")
            ),
            Some("current-value".into())
        );
        assert_eq!(
            read_migrated("openai-api-key", read, |_, _, _| {}),
            Some("previous-value".into())
        );
        assert!(read_migrated(
            "unknown",
            |_, _| panic!("unknown key must not touch storage"),
            |_, _, _| {}
        )
        .is_none());
    }
    #[test]
    fn invalid_inputs_fail_before_credential_storage_and_never_echo_values() {
        for (key, value) in [
            ("unknown-private", "private"),
            ("openai-api-key", "private\ninjection"),
            ("n8n-url", "https://user:private@example.com"),
        ] {
            let error = validate(key, value).unwrap_err();
            assert!(!error.contains("private"));
        }
        assert!(validate("openai-api-key", &"a".repeat(4097)).is_err());
        assert!(validate("openai-api-key", "synthetic-test-value").is_ok());
        assert!(validate("n8n-url", "https://example.com/n8n").is_ok());
        assert!(validate("n8n-url", "http://localhost:5678").is_ok());
        assert!(validate("n8n-url", "http://example.com").is_err());
    }
}
