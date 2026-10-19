# Architecture

Mimo is a Windows Tauri application. Paths below are relative to `windows/`.

| Entry | Owns |
| --- | --- |
| `index.html` → `src/main.ts` | Island, panels and companion |
| `settings.html` → `src/settings/main.ts` | Settings window |
| `src-tauri/src/lib.rs` | Native setup, commands and shutdown |
| `hook/src/` | Coding hooks and local MCP relay |

| Concern | Frontend | Native runtime |
| --- | --- | --- |
| Island and Working mode | `core/visibility`, `island/window-bounds`, `island/island` | Window bounds, monitor/DPI and click-through |
| Companion and file intake | `mimo/`, `upload/`, shared animation clock | Cursor, display and file events |
| Media and audio | Revisioned stores, `island/media`, `audio-controller` | Windows GSMTC and CoreAudio workers |
| Preferences and modules | `core/state`, settings, lifecycle | Settings persistence and events |
| Agent activity and requests | `island/hooks`, review/question panels | Authenticated per-user named pipe and relay |
| Connected services | Integration controllers and panels | Seven service pollers |
| Chat and voice | Chat, voice and provider controls | Provider requests, streaming and credentials |
| Shelf | Grab controller, previews and annotations | Local files, capture and clipboard formats |

## Boundaries

Preferences live in `%APPDATA%/Mimo`; relay data, logs and Shelf files live in
`%LOCALAPPDATA%/Mimo`. Credentials use Windows Credential Manager under
`com.johnpaul.mimo`. Preserve storage keys, event contracts and relay authentication.

Questions and permissions share a session-owned Review queue. Each incoming
request expands and pins the island, including in Working mode or over an open
Chat or Shelf panel. Queued requests preserve the active selection and drafts.
Unavailable or paused Mimo returns control to the agent.

Chat providers are separate from coding connections. Windows media sessions and
master/app audio have separate native owners. Unknown capability and activity
readings remain explicit.

The hook extracts bounded `mimo_tests` summaries before truncating command
previews. `core/test-results` validates reported counts and case/suite names;
the coding workspace retains the last command result while edits take priority.
Spotify player volume uses its own UI Automation slider on the media worker.
Other app volume and Windows master audio retain their CoreAudio owners.
Lazy panels populate before their first paint; the island owns their transition.

## Build

Vite builds both HTML entries and their imported code, CSS, fonts and icons.
It serves and copies the 28 original sound files. The icon generator uses the
supplied master; [asset terms](../LICENSE-ASSETS.md) cover Mimo artwork
and sound files separately from MIT code.

`predev` and `prebuild` build `mimo-hook.exe`. Tauri bundles the relay,
license notices and NSIS installer hooks. `scripts/pack.mjs` copies versioned
and stable installer filenames into ignored `release/`.

Tests and local browser fixtures live in `scripts/` and `dev/`.
See [Windows checks](../windows/README.md#checks), [agent integration](agents.md)
and [distribution](distribution.md).
