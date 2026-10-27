# Linux port plan (Zorin OS)

Goal: Kumo runs on Zorin OS (Ubuntu 24.04 base, GNOME) with the same island, coding-agent
hooks, media, phone and assistant features, from the same repository and the same frontend.
The frontend already adapts its look (`data-os="linux"`, see the README). The work is the
Rust backend (about 20k lines, about 30% of it Windows-specific), the hook relay and the
Python assistant.

## Constraints found up front

- **X11 session, not Wayland, for the island.** GNOME on Wayland lets no app place its own
  window at the top of the screen, keep it above others without focus, or pass clicks
  through its transparent parts (no layer-shell in GNOME). Zorin offers an X11 ("Zorin
  Desktop on Xorg") session at login. Wayland support is a later, separate question.
- **WebKitGTK instead of WebView2.** Transparency works on X11 with a compositor (Mutter
  has one). `webview_memory.rs` and the WebView2 browser arguments are Windows-only.
- **Test machines:** WSL Ubuntu-24.04 on this PC builds and runs the tests (WSLg can show
  windows). Real behavior (island, media, audio) is checked on the Zorin PC.

## How the code splits

Each Windows module gets a Linux twin with the **same function names**, picked at compile
time (`#[cfg(windows)]` / `#[cfg(target_os = "linux")]`). No traits or runtime switching.
Shared logic (settings, hooks parsing, LocalSend, grab store, chat) stays as is.

| Area | Windows today | Linux replacement |
|---|---|---|
| Hook relay transport | named pipe `\\.\pipe\kumo-<sid>` (`pipe.rs`, `hook/`) | Unix socket `$XDG_RUNTIME_DIR/kumo.sock` (tokio `UnixListener`) |
| Island window | `windows/surface.rs`, `topmost.rs`, non-activating window | GTK window via Tauri: keep-above, skip taskbar, no focus, input shape for click-through |
| Media (now playing, controls, artwork) | SMTC `windows/media*.rs` (2,000+ lines) | MPRIS over D-Bus (`zbus`, new dependency) |
| Per-app volume, call pill (mic in use) | WASAPI `audio_*`, `master_audio`, `call.rs` | PipeWire/PulseAudio (`pactl` subscribe, or `libpulse-binding`) |
| Clipboard (send to phone, grab) | Win32 clipboard | `arboard` (new dependency) |
| File drop on the island | `windows/file_drop.rs` (OLE) | Tauri's built-in drag-drop events |
| Power / sleep | `windows/power.rs` | logind `PrepareForSleep` over D-Bus |
| Global shortcuts | `workflow_native.rs` (RegisterHotKey, LL hook) | X11 key grab (tauri global-shortcut plugin) |
| Autostart | autostart plugin (registry) | same plugin (writes a `.desktop` file) |
| LocalSend app | `%LOCALAPPDATA%\Programs\LocalSend`, `%APPDATA%\LocalSend\settings.json` | flatpak/deb app; find its settings path on Zorin first |
| Packaging and updates | NSIS + updater | `.deb` and AppImage; the updater supports AppImage |

Python assistant (`assistant/`): `winreg`, `ctypes` window calls, `keyboard` and the
PowerShell clipboard are Windows-only. Linux uses `xdotool`/`wmctrl` (X11), `xclip`, and
`pynput` for push-to-talk. Whisper, Piper, MMS and Ollama all run on Linux unchanged.

## Steps (one commit each, checked before the next)

1. **Builds on Linux.** Add a `ubuntu-latest` CI job and WSL build; Linux stubs return
   "not available on Linux yet" so everything else compiles. Done when CI is green on both.
2. **Island on X11.** Top-center, transparent, above other windows, click-through outside
   the pill. Done when it behaves like Windows on Zorin.
3. **Coding agents.** Relay over a Unix socket; Claude Code/OpenCode hooks install on Linux.
   Done when a Claude Code session on Zorin shows in the island with Allow/Deny.
4. **Media.** MPRIS now playing, controls and artwork (Spotify, browsers, VLC).
5. **Audio and calls.** Per-app volume and the call pill from PipeWire.
6. **Phone, clipboard, power, shortcuts, autostart.**
7. **Assistant on Linux.** The tools that touch windows, keys and the clipboard.
8. **Packaging.** `.deb` and AppImage from CI; in-app updates through the AppImage.

New dependencies to approve when their step comes: `zbus`, `arboard`, and possibly
`libpulse-binding` and `pynput`.
