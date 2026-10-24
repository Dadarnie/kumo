// SPDX-License-Identifier: MIT
//! Send files and text to your phone with LocalSend (protocol v2).
//!
//! Kumo is a sender only: receiving stays with the LocalSend app on this PC, which has its own
//! encrypted server and accept dialog. Phones are found with the protocol's HTTP discovery
//! (POST `/api/localsend/v2/register` to each address on the local /24), so Kumo never competes
//! with the LocalSend app for its UDP port. Found phones are remembered in `localsend.json`.
//! LocalSend uses self-signed certificates, so certificate checks are off for these LAN calls;
//! the phone still asks you to accept every transfer.

use std::collections::BTreeMap;
use std::hash::{BuildHasher, Hasher};
use std::net::{Ipv4Addr, UdpSocket};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const PORT: u16 = 53317;
const API: &str = "/api/localsend/v2";
/// Whole files are read into memory (no streaming body feature); keep it to sensible sizes.
// ponytail: in-memory upload, cap 2 GB; stream with reqwest's `stream` feature if bigger files matter.
const MAX_FILE: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub fingerprint: String,
    pub alias: String,
    #[serde(default)]
    pub device_model: Option<String>,
    #[serde(default)]
    pub device_type: Option<String>,
    pub ip: String,
    pub port: u16,
    pub protocol: String,
    #[serde(default)]
    pub last_seen: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    fingerprint: String,
    #[serde(default)]
    devices: Vec<Device>,
}

fn store_path() -> PathBuf {
    crate::settings::local_dir().join("localsend.json")
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Kumo's stable LocalSend identity (phones remember devices by fingerprint) and the phones it found.
fn load() -> Store {
    let mut store: Store = std::fs::read(store_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    if store.fingerprint.is_empty() {
        let random = || std::collections::hash_map::RandomState::new().build_hasher().finish();
        store.fingerprint = format!("{:016x}{:016x}", random(), random());
        save(&store);
    }
    store
}

fn save(store: &Store) {
    if let Ok(bytes) = serde_json::to_vec_pretty(store) {
        let _ = std::fs::write(store_path(), bytes);
    }
}

fn identity(fingerprint: &str) -> Value {
    json!({
        "alias": "Kumo",
        "version": "2.1",
        "deviceModel": "Kumo",
        "deviceType": "desktop",
        "fingerprint": fingerprint,
        "port": PORT,
        "protocol": "https",
        "download": false,
    })
}

/// Kumo's own certificate and key (PEM). LocalSend's encrypted mode only talks to senders that
/// present a client certificate. Made once with rcgen; kept in Kumo's private local folder.
fn client_identity() -> Option<&'static reqwest::Identity> {
    static IDENTITY: std::sync::OnceLock<Option<reqwest::Identity>> = std::sync::OnceLock::new();
    IDENTITY
        .get_or_init(|| {
            let dir = crate::settings::local_dir();
            let (cert_path, key_path) = (dir.join("localsend-cert.pem"), dir.join("localsend-key.pem"));
            let pem = match (std::fs::read(&cert_path), std::fs::read(&key_path)) {
                (Ok(cert), Ok(key)) => [cert, key].concat(),
                _ => {
                    let made = rcgen::generate_simple_self_signed(vec!["Kumo".to_string()]).ok()?;
                    let (cert, key) = (made.cert.pem(), made.signing_key.serialize_pem());
                    std::fs::write(&cert_path, &cert).ok()?;
                    std::fs::write(&key_path, &key).ok()?;
                    [cert.into_bytes(), key.into_bytes()].concat()
                }
            };
            reqwest::Identity::from_pem(&pem).ok()
        })
        .as_ref()
}

/// `connect` is short for the network scan and longer for sends: a phone's Wi-Fi may be dozing.
fn client(timeout: Duration, connect: Duration) -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .danger_accept_invalid_certs(true) // LocalSend devices use self-signed certificates
        .timeout(timeout)
        .connect_timeout(connect);
    if let Some(identity) = client_identity() {
        builder = builder.identity(identity.clone());
    }
    builder.build().unwrap_or_default()
}

/// This PC's LAN address: the source address the OS would use to reach the internet.
/// UDP `connect` only picks a route; no packet is sent.
fn local_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_loopback() => Some(ip),
        _ => None,
    }
}

/// The other 253 addresses of this PC's /24.
fn subnet(own: Ipv4Addr) -> Vec<Ipv4Addr> {
    let [a, b, c, d] = own.octets();
    (1..=254u8).filter(|&h| h != d).map(|h| Ipv4Addr::new(a, b, c, h)).collect()
}

async fn register(client: &reqwest::Client, ip: Ipv4Addr, me: &Value) -> Option<Device> {
    for protocol in ["https", "http"] {
        let url = format!("{protocol}://{ip}:{PORT}{API}/register");
        let Ok(response) = client.post(&url).json(me).send().await else { continue };
        let info: Value = response.json().await.ok()?;
        return Some(Device {
            fingerprint: info["fingerprint"].as_str()?.to_string(),
            alias: info["alias"].as_str().unwrap_or("LocalSend device").to_string(),
            device_model: info["deviceModel"].as_str().map(str::to_string),
            device_type: info["deviceType"].as_str().map(str::to_string),
            ip: ip.to_string(),
            port: PORT,
            protocol: protocol.into(),
            last_seen: now(),
        });
    }
    None
}

/// Remembered phones, most recently seen first.
pub fn devices() -> Vec<Device> {
    let mut devices = load().devices;
    devices.sort_by_key(|d| std::cmp::Reverse(d.last_seen));
    devices
}

/// Looks for LocalSend devices on this PC's network (a couple of seconds) and remembers them.
pub async fn discover() -> Result<Vec<Device>, String> {
    let own = local_ipv4().ok_or("This PC isn't on a network")?;
    let mut store = load();
    let me = identity(&store.fingerprint);
    // Phones in Wi-Fi power saving take a moment to answer the first packet.
    let client = client(Duration::from_secs(4), Duration::from_secs(2));
    let tasks: Vec<_> = subnet(own)
        .into_iter()
        .map(|ip| {
            let (client, me) = (client.clone(), me.clone());
            tokio::spawn(async move { register(&client, ip, &me).await })
        })
        .collect();
    let mut found = Vec::new();
    for task in tasks {
        if let Ok(Some(device)) = task.await {
            if device.fingerprint != store.fingerprint {
                found.push(device);
            }
        }
    }
    for device in &found {
        store.devices.retain(|d| d.fingerprint != device.fingerprint);
        store.devices.push(device.clone());
    }
    save(&store);
    found.sort_by(|a, b| a.alias.cmp(&b.alias));
    Ok(found)
}

/// What to send: files from disk, and/or a text message (shown as a message on the phone).
pub struct Outgoing {
    pub paths: Vec<PathBuf>,
    pub text: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sent {
    pub device: String,
    pub files: usize,
    pub bytes: u64,
}

/// reqwest's own message is generic ("error sending request"); the causes say what happened.
fn error_chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    text
}

fn file_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("heic") => "image/heic",
        Some("mp4") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("mp3") => "audio/mpeg",
        Some("pdf") => "application/pdf",
        Some("txt" | "md" | "log") => "text/plain",
        Some("zip") => "application/zip",
        Some("apk") => "application/vnd.android.package-archive",
        _ => "application/octet-stream",
    }
}

/// The prepare-upload body: one entry per file (text goes as a text/plain file with a preview).
fn prepare_body(me: &Value, files: &[(String, String, u64, &'static str, Option<String>)]) -> Value {
    let map: serde_json::Map<String, Value> = files
        .iter()
        .map(|(id, name, size, kind, preview)| {
            (id.clone(), json!({"id": id, "fileName": name, "size": size, "fileType": kind, "sha256": null, "preview": preview}))
        })
        .collect();
    json!({"info": me, "files": map})
}

/// Sends to a remembered device. The phone asks its user to accept; this waits up to two minutes.
pub async fn send(fingerprint: &str, outgoing: Outgoing) -> Result<Sent, String> {
    let store = load();
    let device = store
        .devices
        .iter()
        .find(|d| d.fingerprint == fingerprint)
        .cloned()
        .ok_or("That device isn't known yet. Search for devices first.")?;
    // (id, file name, size, type, preview), plus where the bytes come from.
    let mut entries = Vec::new();
    let mut sources: BTreeMap<String, Result<PathBuf, Vec<u8>>> = BTreeMap::new();
    for (i, path) in outgoing.paths.iter().enumerate() {
        let meta = std::fs::metadata(path).map_err(|_| format!("{} is missing", path.display()))?;
        if !meta.is_file() || meta.len() > MAX_FILE {
            return Err(format!("{} can't be sent (not a file, or over 2 GB)", path.display()));
        }
        let id = format!("file{i}");
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| id.clone());
        entries.push((id.clone(), name, meta.len(), file_type(path), None));
        sources.insert(id, Ok(path.clone()));
    }
    if let Some(text) = outgoing.text.filter(|t| !t.trim().is_empty()) {
        let bytes = text.clone().into_bytes();
        entries.push(("text".into(), "Kumo message.txt".into(), bytes.len() as u64, "text/plain", Some(text)));
        sources.insert("text".into(), Err(bytes));
    }
    if entries.is_empty() {
        return Err("Nothing to send".into());
    }
    let me = identity(&store.fingerprint);
    let base = format!("{}://{}:{}{API}", device.protocol, device.ip, device.port);
    // A phone in Wi-Fi power saving can miss the first connection: try a few times before giving up.
    let prepare_client = client(Duration::from_secs(120), Duration::from_secs(5));
    let body = prepare_body(&me, &entries);
    let mut attempt = 0;
    let prepare = loop {
        attempt += 1;
        match prepare_client.post(format!("{base}/prepare-upload")).json(&body).send().await {
            Ok(response) => break response,
            Err(e) if e.is_connect() && attempt < 3 => tokio::time::sleep(Duration::from_secs(2)).await,
            Err(e) if e.is_connect() || e.is_timeout() => {
                return Err(format!("{} didn't answer. Open LocalSend on it, on the same Wi-Fi.", device.alias))
            }
            Err(e) => return Err(format!("Could not reach {}: {}", device.alias, error_chain(&e))),
        }
    };
    let total = entries.iter().map(|e| e.2).sum();
    match prepare.status().as_u16() {
        200 => {}
        204 => return Ok(Sent { device: device.alias, files: entries.len(), bytes: total }), // e.g. a text shown as a message
        401 => return Err(format!("{} asks for a PIN. Turn the PIN off in its LocalSend settings.", device.alias)),
        403 => return Err(format!("{} declined.", device.alias)),
        409 => return Err(format!("{} is busy with another transfer.", device.alias)),
        code => return Err(format!("{} answered {code}.", device.alias)),
    }
    let session: Value = prepare.json().await.map_err(|e| e.to_string())?;
    let session_id = session["sessionId"].as_str().ok_or("The phone sent no session")?.to_string();
    let tokens = session["files"].as_object().cloned().unwrap_or_default();
    let upload = client(Duration::from_secs(3600), Duration::from_secs(5));
    let mut sent = 0usize;
    for (id, token) in &tokens {
        let Some(token) = token.as_str() else { continue };
        let body = match sources.get(id) {
            Some(Ok(path)) => tokio::fs::read(path).await.map_err(|e| e.to_string())?,
            Some(Err(bytes)) => bytes.clone(),
            None => continue,
        };
        let response = upload
            .post(format!("{base}/upload"))
            .query(&[("sessionId", session_id.as_str()), ("fileId", id.as_str()), ("token", token)])
            .body(body)
            .send()
            .await
            .map_err(|e| format!("Sending stopped: {e}"))?;
        if !response.status().is_success() {
            let _ = upload.post(format!("{base}/cancel")).query(&[("sessionId", session_id.as_str())]).send().await;
            return Err(format!("{} stopped the transfer ({}).", device.alias, response.status().as_u16()));
        }
        sent += 1;
    }
    Ok(Sent { device: device.alias, files: sent, bytes: total })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_subnet_scan_skips_this_pc() {
        let ips = subnet(Ipv4Addr::new(192, 168, 1, 23));
        assert_eq!(ips.len(), 253);
        assert!(!ips.contains(&Ipv4Addr::new(192, 168, 1, 23)));
        assert!(ips.contains(&Ipv4Addr::new(192, 168, 1, 1)) && ips.contains(&Ipv4Addr::new(192, 168, 1, 254)));
    }

    #[test]
    fn prepare_upload_matches_the_protocol() {
        let me = identity("abc");
        let body = prepare_body(&me, &[
            ("file0".into(), "photo.jpg".into(), 10, "image/jpeg", None),
            ("text".into(), "Kumo message.txt".into(), 5, "text/plain", Some("hello".into())),
        ]);
        assert_eq!(body["info"]["fingerprint"], "abc");
        assert_eq!(body["info"]["deviceType"], "desktop");
        assert_eq!(body["files"]["file0"]["fileName"], "photo.jpg");
        assert_eq!(body["files"]["file0"]["size"], 10);
        assert_eq!(body["files"]["text"]["fileType"], "text/plain");
        assert_eq!(body["files"]["text"]["preview"], "hello");
        assert!(body["files"]["file0"]["sha256"].is_null());
    }

    #[test]
    fn file_types_cover_phone_media() {
        assert_eq!(file_type(Path::new("a.JPG")), "image/jpeg");
        assert_eq!(file_type(Path::new("clip.mp4")), "video/mp4");
        assert_eq!(file_type(Path::new("thing.xyz")), "application/octet-stream");
    }

    /// Run with --ignored while LocalSend is open on a phone on this network.
    #[test]
    #[ignore]
    fn live_find_and_send_text() {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let mut found = Vec::new();
            for _ in 0..6 {
                found = discover().await.unwrap();
                if !found.is_empty() { break; }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
            println!("found: {:?}", found.iter().map(|d| (&d.alias, &d.ip, &d.device_type)).collect::<Vec<_>>());
            if found.is_empty() {
                found = devices(); // remembered from an earlier search
            }
            let phone = found.iter().find(|d| d.device_type.as_deref() == Some("mobile")).or(found.first()).expect("a device");
            let sent = send(&phone.fingerprint, Outgoing { paths: vec![], text: Some("Hello from Kumo 👋".into()) }).await;
            println!("text: {sent:?}");
            sent.unwrap();
        });
    }
}
