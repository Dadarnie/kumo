<p align="center"><img src="docs/media/kumo-icon.png" alt="Kumo" width="104" height="104"></p>

<h1 align="center">Kumo</h1>

<p align="center">A little cloud spirit that lives at the top of your Windows screen<br>and keeps an eye on your coding agents, music and tools.</p>

---

Kumo is a notch-style desktop companion for Windows 10 and 11. It sits as a small
island at the top of your screen, shows what your AI coding agents are doing, and
only asks for your attention when something actually needs you.

## What it does

- **Follows your coding agents.** Claude Code, OpenCode, Codex, Cursor, Gemini CLI
  and more report into the island: a one-line status ("Editing `island.ts`",
  `$ npm test`, Thinking…) with a progress ring.
- **Approvals in the pill.** Permission requests show **Deny / Allow** right in the
  small island; questions open the full view. Typing in your app is never interrupted.
- **Live session view.** Hover to open the full panel: steps, files, edits and
  command output, typed out line by line.
- **Music.** Artwork and waveform while something plays; play, skip and per-app
  volume when expanded. Pick which app the island follows when several play.
- **Calls.** When an app is using your microphone (Meet, Discord, Zoom, Teams), a
  call pill shows a timer and a mute button.
- **Tools tab.** Pinned app launcher, news, Docker containers (start/stop/restart),
  loaded Ollama models, and quick notes to your Obsidian vault.
- **News.** Kumo reads coding, AI, security and "what's free" feeds (free tiers,
  credits, courses) every few hours. Tools › News sorts them by category, the island
  mentions new free finds, and a daily digest lands in your vault.
- **Voice assistant.** Talk to Kumo (or type in Chat): it uses tools on your PC,
  remembers through your Obsidian vault and sets reminders. Its approvals appear in
  the island, and risky ones are red. Everything runs locally on Ollama.
- **Phone.** Send Shelf items, notes, headlines or the clipboard to your phone with
  LocalSend; files the phone sends land on the Shelf. See [Phone](#phone-localsend).
- **Chat.** With the assistant off, chat with Ollama or a cloud provider.
- **Limits.** Claude usage at a glance.

Kumo's look is "Ember dusk": black surfaces with a plum, coral and peach gradient. The
cloud mascot drifts while thinking, glows when work is done and rains when
something fails. Its sounds are synthesized bell chimes.

## Voice assistant

The assistant lives in [`assistant/`](assistant/README.md): Python with local Whisper,
Piper and an Ollama model. Set it up once (its README lists the commands), then turn
on Settings → Assistant → **Voice assistant**. Kumo starts it, restarts it if it
crashes, and stops it when Kumo quits. **Always listening** off means each request
starts with "hey kumo". Ctrl+Alt+V (Settings → Hotkeys) turns its microphone on and off.

Its model is `gemma4-e4b-kumo`, Gemma with a 16k context (its prompt and tools don't
fit Ollama's 4k default).

News uses feeds only (RSS, Atom, the Hacker News API): titles, links and short
summaries, never whole pages. Edit the sources, refresh interval, digest and free
notices in Settings → Assistant → News; they apply without restarting it. Ask
"what's new in AI?" or "any free dev tools today?" as well.

## Phone (LocalSend)

Install [LocalSend](https://localsend.org) on the PC and the phone, on the same Wi-Fi.

- **Send:** the Shelf's **Phone** button (selected items), the phone icon beside each
  note and headline, ⋯ → **Send clipboard to phone** (copied files or text), or ask
  the assistant: "send this link to my phone". The phone asks you to accept, and the
  island shows Phone · Sending… / Sent / why it failed.
- **Receive:** Kumo starts the LocalSend app hidden in the tray and watches the folder
  it saves to (its Destination setting, else Downloads). Each new file up to 32 MB
  lands on the Shelf under **From phone**, and the island says "Got <name>". Bigger
  files stay in that folder. Accept transfers in LocalSend's window, or mark the phone
  as a favorite there to skip that. Give LocalSend its own Destination folder (e.g.
  `Downloads\LocalSend`): in plain Downloads, Kumo can only guess which new files came
  from the phone (no browser download mark, saved while LocalSend runs).
- Kumo talks LocalSend's protocol itself (port 53317): it finds phones by asking each
  address on your /24 and remembers them in `%LOCALAPPDATA%\Kumo\localsend.json`.
  With no phone chosen, it uses the one seen last. Its own client certificate lives in
  the same folder (`localsend-cert.pem`, `localsend-key.pem`).
- A phone that drops off Wi-Fi to save power can't be reached; set LocalSend's battery
  use to "No restrictions" on the phone.

**Live check** (phone on the same Wi-Fi, LocalSend open), after changing phone code:

1. Shelf: select an item → **Phone**; the phone asks, the island says Sent.
2. Notes and News: the phone icon on a note (a file) and on a headline (a text message).
3. ⋯ → **Send clipboard to phone**, once with copied text and once with a copied file
   (a big one, over 1 GB, checks streaming).
4. "Send https://example.com to my phone" to the assistant: approval, then it arrives.
5. Send a photo from the phone: it lands in the LocalSend folder and on the Shelf.

## Looks right on every OS

Kumo sets `<html data-os>` to the system it runs on (`windows`, `macos`, `linux`), and
[`design/tokens.css`](windows/src/design/tokens.css) gives each its own type, corners and
focus style while keeping Ember dusk:

- **Windows:** Segoe UI Variable, Cascadia Mono, corners as designed (`--radius-scale: 1`).
- **macOS:** the system font (SF), SF Mono, slightly tighter corners (`0.8`), a soft focus
  glow, and a pure black island that blends into the camera notch.
- **Linux:** Inter, JetBrains Mono, flatter corners (`0.6`) closer to GNOME.

Every CSS corner is written as `calc(<px> * var(--radius-scale))`, and the island's own
corners follow the same scale. To preview another look, run
`document.documentElement.dataset.os = "macos"` in the dev tools.

## Build

You need Windows 10/11, WebView2, Node.js 20+, Rust and the MSVC C++ build tools.

```powershell
cd windows
npm ci
npm run tauri dev          # live development
npm run tauri build -- --no-bundle   # release build → target\release\kumo.exe
npm run install:local      # build, then install into %LOCALAPPDATA%\Programs\Kumo and restart
```

**Updates.** Settings › About › **Check for updates** asks GitHub for the newest signed
release (the `latest.json` on the `windows-latest` release), only when you click it.
`.github/workflows/windows.yml` builds a release from a `windows-v<version>` tag, signs it
with the `TAURI_SIGNING_PRIVATE_KEY` Actions secret, and publishes it when `PUBLISH` is
`"true"` in that workflow.

See [windows/README.md](windows/README.md) for tests and packaging, and
[docs/](docs/README.md) for architecture and agent integration details.

## Credits and license

Kumo is a fork of [**Mimo**](https://github.com/Jiocode1/mimo) by John Paul, used
under the MIT license. Kumo's name, cloud mascot, icon, theme and sounds are its
own; Mimo's branding, artwork and recordings are not included.

Code: [MIT](LICENSE). Artwork and sounds: see [LICENSE-ASSETS.md](LICENSE-ASSETS.md).
Third-party components: [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
