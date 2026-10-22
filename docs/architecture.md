# Architecture

Kumo is a Windows Tauri application. Paths below are relative to `windows/`.

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
| Chat | Chat and provider controls | Provider requests, streaming and credentials |
| Raphael (voice assistant) | `island/raphael`, Chat in Raphael mode, Settings → Raphael | `raphael.rs`: supervised `chat.py --kumo` child, JSON lines over stdin/stdout |
| Shelf | Grab controller, previews and annotations | Local files, capture and clipboard formats |

## Boundaries

Preferences live in `%APPDATA%/Kumo`; relay data, logs and Shelf files live in
`%LOCALAPPDATA%/Kumo`. Credentials use Windows Credential Manager under
`com.johnpaul.mimo`. Preserve storage keys, event contracts and relay authentication.

Questions and permissions share a session-owned Review queue. Each incoming
request expands and pins the island, including in Working mode or over an open
Chat or Shelf panel. Queued requests preserve the active selection and drafts.
Unavailable or paused Kumo returns control to the agent.

Raphael is a separate Python project (its folder is a setting). Kumo starts it,
turns each stdout JSON line into a `raphael` event and writes validated commands
(`answer`, `text`, `mute`, `stop`) to its stdin; closing stdin makes it save its
session and quit, and crashes restart with backoff. Raphael is the `agent_raphael`
task; its approvals use `raphael:<id>` request ids that the bridge answers through
`raphael_send`, never the coding-agent pipe. Its interpreter is excluded from the
call pill. Both Raphael and Ollama chat use the local Ollama server.

News is Raphael's (`news.py`). Kumo reads `data/news.json` from the configured
Raphael folder (`raphael_news`), never a path from the page, and writes
`data/news_settings.json` only from the Settings window after rebuilding every
field from a checked list (`raphael_news_settings_save`). `news_refresh` asks
Raphael to fetch now; `news_updated` reports the end of each refresh with the
titles of new free finds.

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
supplied master; [asset terms](../LICENSE-ASSETS.md) cover Kumo artwork
and sound files separately from MIT code.

`predev` and `prebuild` build `kumo-hook.exe`. Tauri bundles the relay,
license notices and NSIS installer hooks. `scripts/pack.mjs` copies versioned
and stable installer filenames into ignored `release/`.

Tests and local browser fixtures live in `scripts/` and `dev/`.
See [Windows checks](../windows/README.md#checks), [agent integration](agents.md)
and [distribution](distribution.md).
