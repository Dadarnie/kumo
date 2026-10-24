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
  as a favorite there to skip that.
- Kumo talks LocalSend's protocol itself (port 53317): it finds phones by asking each
  address on your /24 and remembers them in `%LOCALAPPDATA%\Kumo\localsend.json`.
  With no phone chosen, it uses the one seen last. Its own client certificate lives in
  the same folder (`localsend-cert.pem`, `localsend-key.pem`).
- A phone that drops off Wi-Fi to save power can't be reached; set LocalSend's battery
  use to "No restrictions" on the phone.

## Build

You need Windows 10/11, WebView2, Node.js 20+, Rust and the MSVC C++ build tools.

```powershell
cd windows
npm ci
npm run tauri dev          # live development
npm run tauri build -- --no-bundle   # release build → target\release\kumo.exe
```

See [windows/README.md](windows/README.md) for tests and packaging, and
[docs/](docs/README.md) for architecture and agent integration details.

## Credits and license

Kumo is a fork of [**Mimo**](https://github.com/Jiocode1/mimo) by John Paul, used
under the MIT license. Kumo's name, cloud mascot, icon, theme and sounds are its
own; Mimo's branding, artwork and recordings are not included.

Code: [MIT](LICENSE). Artwork and sounds: see [LICENSE-ASSETS.md](LICENSE-ASSETS.md).
Third-party components: [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
