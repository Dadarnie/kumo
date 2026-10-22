# Kumo for Windows

Kumo is a Tauri app with a TypeScript interface and Rust Windows runtime.
Maintained by John Paul.

## Run and build

You need Windows 10 or 11, WebView2, Node.js 20+, Rust and MSVC C++ build tools.

~~~powershell
npm ci
npm run tauri dev
~~~

Run these commands from `windows/`. To create the installer, run
`npm run pack`. Files are copied to `release/`. The installer is unsigned;
see [downloads and verification](../docs/distribution.md).

## Use Kumo

| Feature | Where to start |
| --- | --- |
| Coding agents | Open Settings → Coding connection. Install hooks through the preview and Apply flow. |
| Chat | Open Chat and choose a provider and model. API keys are separate from coding connections. |
| Voice assistant | Set up `assistant/` once (see its README), then Settings → Assistant. Say "hey kumo" or type in Chat. Ctrl+Alt+V turns its microphone on and off. |
| Shelf | Drop files or drag Kumo out to capture a region. Ctrl+Alt+G also starts capture. |
| Media | Open Now playing from Home. Windows reports supported playback controls and audio devices. |
| Working mode | The island becomes a thin lip. Review and explicit opening remain available. |

The Shelf supports previews, notes, annotations, collections and native clipboard
copies. Up to five dropped files can be attached to a chat. Files and drafts stay
local until you choose an action that sends them.

Agent questions and permissions expand and pin the island, including in Working
mode or over an open panel. They keep session ownership and terminal fallback.
Use the [coding-agent guide](../docs/agents.md) for hooks and MCP questions, and
the [integration guide](../docs/integrations.md) for connected services.

## Settings and local data

Open Settings from the island or tray.

| Data | Location |
| --- | --- |
| Preferences | `%APPDATA%/Kumo/settings.json` |
| Shelf and clipboard copies | `%LOCALAPPDATA%/Kumo/grab` |
| Relay, inbox and logs | `%LOCALAPPDATA%/Kumo` |
| Credentials | Windows Credential Manager, under `com.johnpaul.mimo` |
| Claude hook configuration | `%USERPROFILE%/.claude/settings.json` |

Hook installation previews changes, creates a backup and rejects concurrent edits.
Never commit keys, personal logs or exported credentials.

## Source layout

| Folder | Owns |
| --- | --- |
| `src/core/` | State, preferences and bridge contracts |
| `src/island/` | Island and feature controllers |
| `src/views/`, `src/settings/` | Panels and settings UI |
| `src/mimo/`, `src/upload/` | Companion and file-intake rendering |
| `src-tauri/src/` | Native runtime and commands |
| `src-tauri/src/windows/` | Windows window, media and audio integration |
| `hook/` | Coding-agent relay and MCP server |
| `assets/sounds/` | Original Kumo sound cues |

See the [architecture map](../docs/architecture.md)
and [companion guide](../docs/companion.md).

## Checks

Run from `windows/`:

~~~powershell
npm run test:unit
npm run test:media-ui
npm run test:reference-ui
npm run test:agents
npm run build
cargo check --workspace --locked
cargo test --workspace --locked
cargo fmt --all -- --check
git diff --check
~~~

Run `npm run pack` when packaging or bundled assets change. Browser fixtures
verify DOM and controller behavior; native desktop behavior needs a built app.
Live media tests need an active supported player.
Spotify volume targets its own accessible slider, including the step size it
reports (10% in the current desktop player), independently of Windows mixer volume.

`dev/media-preview.html`, `dev/icon-preview.html` and `dev/upload-preview.html`
are local test fixtures. `npm run test:performance` records a browser switching
benchmark under `target/mimo-performance/`.

For native memory measurements, use a release build with DevTools closed and
the same DPI and player as the baseline. Include the full Kumo and WebView2
process tree; browser heap alone does not establish native RAM usage.
