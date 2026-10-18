# Raphael (local voice assistant)

Free and local. No paid APIs, no cloud.

## Setup (once)

```powershell
cd "C:\Users\darnie\own projects\raphael"
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install openai
```

## Stage 1: text chat with LM Studio

1. Open LM Studio, load the Gemma model.
2. Go to the **Developer** tab (`<_` icon) and turn **Start Server** on. Note the port it shows (this PC: `1235`) and set `BASE_URL` in `config.py` to match.
3. List the exact model id:
   ```powershell
   .\.venv\Scripts\python.exe chat.py --models
   ```
4. Put that id in `MODEL` in `config.py`.
5. Chat:
   ```powershell
   .\.venv\Scripts\python.exe chat.py
   ```
   Type `exit` to quit. Last `HISTORY_TURNS` exchanges are remembered, so follow-ups work.

All settings live in `config.py`.

## Stage 2: tools

`python chat.py` now lets the model call tools (`tools.py`):

| Tool | What it does | Asks you first? |
|---|---|---|
| `get_time` | current date/time | no |
| `open_app` | opens an app from `APP_WHITELIST` | **yes** (y/n) |
| `list_files` | lists a folder inside `ALLOWED_DIRS` | no |
| `read_file` | reads a text file inside `ALLOWED_DIRS` (max `MAX_READ_BYTES`) | no |

Edit `APP_WHITELIST`, `ALLOWED_DIRS` and `MAX_READ_BYTES` in `config.py`.
There are no delete, shell or file-write tools.

Self-check (no model needed): `.\.venv\Scripts\python.exe tools.py` prints `tools OK`.

## Stage 3: voice (push-to-talk)

Extra packages (already installed in `.venv`):
```powershell
.\.venv\Scripts\python.exe -m pip install faster-whisper piper-tts pyttsx3 sounddevice keyboard
```

Piper voice (already in `voices/`). To get another one:
```powershell
.\.venv\Scripts\python.exe -m piper.download_voices en_GB-alan-medium --download-dir voices
```
then set `PIPER_VOICE` in `config.py`. If the file is missing, Raphael falls back to the Windows voice (pyttsx3).

Settings in `config.py`: `HOTKEY`, `WHISPER_MODEL`, `PIPER_VOICE`, `INPUT_DEVICE`.

Windows: Settings -> Privacy & security -> Microphone -> allow **desktop apps** to use the mic.

Test pieces:
```powershell
.\.venv\Scripts\python.exe voice.py --speak     # you should hear Raphael
.\.venv\Scripts\python.exe voice.py --listen    # hold the hotkey, talk, release: prints text
```
Full assistant by voice:
```powershell
.\.venv\Scripts\python.exe chat.py --voice
```
Hold the hotkey, speak, release. Say "exit" to quit. First run is slow while Whisper loads.

## Stage 4: wake word (optional)

```powershell
.\.venv\Scripts\python.exe -m pip install openwakeword
.\.venv\Scripts\python.exe -c "from openwakeword import utils; utils.download_models(['hey_jarvis'])"
```
(Both already done on this PC.)

Turn on: set `WAKE_WORD_ENABLED = True` in `config.py`, then run `chat.py --voice`.
Say "hey jarvis", then your question. Recording stops after a short silence.
The hotkey is not used while wake word is on; set it back to `False` to return to push-to-talk.

Tuning in `config.py`:
- Triggers too often: raise `WAKE_THRESHOLD` (e.g. 0.7).
- Doesn't trigger: lower it (e.g. 0.3).
- Recording never stops: raise `SILENCE_RMS`. Cuts you off: raise `SILENCE_SECONDS`.

## Raphael look and voice

- Window: `.\.venv\Scripts\python.exe chat.py --ui` (voice mode plus a magic-circle window; colours/speed change while idle, listening, thinking, speaking). Preview without the assistant: `python ui.py`. y/n confirmations are still asked in the terminal.
- Name and personality: `ASSISTANT_NAME` and `SYSTEM_PROMPT` in `config.py`.
- Voice: hear all downloaded voices with `python voice.py --samples`, then set `PIPER_VOICE`. Tune `VOICE_SPEED` (higher = slower) and `VOICE_VARIATION` (lower = flatter).

## Speed

- Replies stream and each sentence is spoken as soon as it is ready (no waiting for the full answer).
- `REASONING_EFFORT = "none"` in `config.py` turns off Gemma's hidden "thinking" (was 15-60 s of delay). Set to `None` for the model default.
- Still too slow? Load a smaller model in LM Studio (e.g. Gemma 4 E4B) and change `MODEL`; check GPU Offload is at max.

## Wake phrase: "hey raphael"

`WAKE_PHRASE = "hey raphael"` in `config.py` (used when `WAKE_WORD_ENABLED = True`). Whisper transcribes each thing you say on the CPU and checks that it starts with the phrase, so there is no training and no extra package.
- Say it all at once: "hey raphael, what time is it", or say "hey raphael", wait, then ask.
- The name must come first or right after "hey"; a casual mention mid-sentence is ignored.
- Everything you say while it waits is transcribed locally (nothing leaves the PC) and thrown away unless it starts with the phrase.
- Whisper sometimes misspells names; "Rafael" is accepted, odd spellings may be missed.
- Set `WAKE_PHRASE = None` to go back to the openWakeWord "hey jarvis" model.

## Better recognition

- Quiet speech is volume-boosted before Whisper (max x8).
- Whisper gets hints: assistant name, whitelisted app names, plus `WHISPER_HINTS` in `config.py` (add words you say often, e.g. names of folders).
- `WHISPER_BEAM = 5` (accuracy) and `WHISPER_MIN_LOGPROB = -0.7`: if Whisper isn't confident, Raphael says "I didn't catch that" instead of acting. Too many repeat requests? Lower to -0.9. It acts on wrong words? Raise to -0.5.
- The model is told input may contain speech errors and to ask when unclear.
- Still wrong a lot? Set `WHISPER_MODEL = "small"` (more accurate, slower, ~460 MB download on first use).

## Follow-up window

After Raphael finishes talking, the next `WAKE_FOLLOWUP_SECONDS` (20) accept a request without "hey raphael". After that it waits for the wake phrase again. Set it to `0` to always require the phrase. Anything said in the window counts as a request (TV, other people), so keep it short if that bothers you.

## Agent mode: tools and permissions

Raphael works in a loop: the model asks for a tool, `tools.py` runs it on your PC, the result goes back to the model, and it decides the next step (up to `MAX_TOOL_ROUNDS` = 15 per request). The model can only *ask*; `tools.py` decides what runs.

| Tool | Default |
|---|---|
| `get_time`, `system_info`, `list_files`, `read_file`, `search_files`, `open_folder` | allow |
| `open_app`, `write_file`, `edit_file`, `run_command` (PowerShell) | **ask** |

- Set each tool to `"allow"`, `"ask"` or `"deny"` in `PERMISSIONS` (`config.py`).
- **Ask** = an Allow / Deny panel appears in the window (a y/n question in the terminal if you run without `--ui`). No answer in `APPROVAL_TIMEOUT` seconds counts as Deny.
- **Dangerous things are never blocked, but they always ask**, with a red warning and "Allow anyway", even if you set `"allow"`: delete, move, rename, format, uninstall/winget, shutdown, registry, downloads (`curl`, `iwr`), scheduled tasks, writing to code files (`.py`, `.ps1`, `.exe`...) and more (`DANGEROUS` in `tools.py`).
- Files can only be read or written inside `ALLOWED_DIRS`. Commands run in the first allowed folder, stop after `COMMAND_TIMEOUT` seconds, and output is capped at `MAX_OUTPUT_CHARS`.
- **Stop** button (top right of the window) cancels the current job, stops a running command and denies a pending approval.
- Always read the command in the panel before clicking Allow. A command can touch anything your Windows user can, not only the allowed folders.
- Self-check: `.\.venv\Scripts\python.exe tools.py` prints `tools OK`.

## Honest and helpful ("wise") behavior

- At startup Raphael checks which apps in `APP_WHITELIST` are really installed (`tools.environment_note()`) and tells the model. Asking for a missing app (e.g. Chrome here) gives "it isn't installed" plus options (install it, use an installed alternative, or steps to follow), with no approval prompt for something impossible.
- The system prompt (`SYSTEM_PROMPT` in `config.py`) makes this a rule for every topic: say plainly what it lacks (app, tool, ability, or a fact it isn't sure of), offer one or two options, never invent results, and say so when a tool was declined or failed.
- `open_url` opens a web page or search in your default browser (Zen on this PC). It asks Allow/Deny and only accepts http/https.
- To add an app: put it in `APP_WHITELIST` with its full path (e.g. `"zen": r"C:\Program Files\Zen Browser\zen.exe"`).
- The model is small (E4B), so it can still be inconsistent, for example asking in words before calling a tool. The Allow/Deny panel is the real safety check, so only click Allow for things you asked for.

## Playing music

"Hey Raphael, play Nadarang by Shanti Dope" uses `play_music`: it looks up the best YouTube match (`yt-dlp`, search only, nothing is downloaded), shows the title and link in the Allow/Deny panel, and on Allow opens it in your default browser, which starts playing. Needs internet. Turn it off with `"play_music": "deny"` in `PERMISSIONS`.

## Keyboard control (typing into apps)

| Tool | What it does | Default |
|---|---|---|
| `focus_window` | brings an open window to the front (by title or program name, e.g. `zen`, `notepad`) | allow |
| `type_text` | types into a window; optional `before` keys (e.g. `ctrl+l`) and `enter='yes'`, in one step | ask |
| `press_keys` | presses shortcuts in a window, e.g. `ctrl+t`, `ctrl+s`, `ctrl+l, enter` | ask |

- Examples: "hey raphael, search cheap flights to Cebu in Zen", "type buy milk in notepad", "open a new tab in Zen".
- The Allow/Deny panel always names the **target window and program**. If it is a terminal (PowerShell, cmd, Windows Terminal...) the panel is red, because typed text there can run commands.
- Uses the `keyboard` package (already installed). No mouse clicks and no reading the screen.
- `open_app` now waits up to 5 s for the app's window, so typing right after opening works.
- The small model sometimes says it did something without calling a tool. If nothing happened, ask again.

## Current permission setup (fewer prompts)

Everyday actions run without asking: opening apps, websites and music, typing and shortcuts, and read-only PowerShell commands (e.g. `Get-Process`, `ipconfig`).
Allow/Deny is only shown when something would be **changed, deleted or installed**:
- `write_file` and `edit_file` (always),
- PowerShell commands matching `DANGEROUS` in `tools.py`: delete, move, copy, create, rename, uninstall/install (`winget`, `pip`, `npm`), services, registry, permissions, downloads, shutdown, and `>` redirects,
- typing into a terminal window.

The `DANGEROUS` list is a word match, not a guarantee: a command it doesn't recognise runs without asking. To get prompts back for something, set it to `"ask"` in `PERMISSIONS`.

## Media control

`media_control` sends Windows media keys, so it controls whatever is playing (YouTube in Zen, Spotify...) even when that window isn't in front: play/pause (one toggle), next, previous, stop, volume up/down (2% per step, `times` for more), mute. Say "pause", "play it", "next video", "louder".
Raphael can't click "Skip Ad" (no key for it; it can't see the screen). Use an ad blocker extension in Zen instead.

## Always listening (no wake phrase)

`ALWAYS_LISTEN = True` (default now): every phrase Raphael hears is a request. Set `False` to require "hey raphael" again (with the 20 s follow-up window).
Sound from your speakers (YouTube, music, calls) can be heard as requests and, with the relaxed permissions, acted on. Use headphones, or turn it off while media plays.

## Raphael's cursor

While `type_text` or `press_keys` runs (with `--ui`), a gold cursor glides from your mouse to where the keys will land (the text caret if the app reports one, the address bar after `ctrl+l`, otherwise the upper middle of the window), pulses with a "Raphael · typing…" label, then disappears. It is click-through and never takes focus. Typing speed: `TYPING_DELAY` in `config.py`. It only shows where typing goes; Raphael still can't move or click your real mouse.

## HUD window

`chat.py --ui` opens Raphael's HUD: `hud.html` shown in a native window by `pywebview` (Microsoft Edge WebView2, built into Windows 11). It is drawn by the GPU, so it runs at about 75-110 fps with smooth edges, glow and blur. Everything is local; the page loads nothing from the internet.
- **Conversation** (left): your words and Raphael's answers, typing dots while it thinks, ignored phrases in grey.
- **Activity** (left): every tool step with time. Allow/Deny slides up here with a countdown bar.
- **Raphael core** (center): rune circle with glowing rings, colour fades by state (orange standby, cyan listening, purple thinking, pink speaking) and reacts to your voice and Raphael's.
- **System** (right): live CPU, RAM, disk rings, CPU history line, GPU name, clock.
- **Voice** (right): bar visualizer of your mic (cyan/purple) and Raphael's speech (orange/pink).
- Footer: model, tools run, state, Stop.
Install (already done here): `.\.venv\Scripts\python.exe -m pip install pywebview`. Preview with fake data: `.\.venv\Scripts\python.exe ui.py`. Look and colours: CSS at the top of `hud.html`.

## Coding helper

Your projects folder (`PROJECTS_DIR`, `C:\Users\darnie\own projects`) is in `ALLOWED_DIRS`: Raphael can read and search all code there (including `.env` files; it all stays on your PC). Writing files still asks.

| Say | Tool |
|---|---|
| "run the tests in docmind" | `project_info` finds the stack and exact command (e.g. `backend\.venv` + pytest), then `run_command` in that folder; Raphael summarizes pass/fail and the first error |
| "what's changed in docmind?" | `git_status`: branch, changed files, last 5 commits |
| "where is X defined in scamcheck?" | `search_files` / `read_file` |
| "explain the error I copied" | `read_clipboard` |
| "copy a one-liner that ..." | `copy_to_clipboard` |

Commands run freely unless they install, delete, publish or change history: `npm install`, `pip install`, `git push/commit/reset/clean/checkout/pull`, `docker rm`, `gh pr merge`... ask first. A command that hits the time limit or Stop is killed with its child processes.
The model is small: good for these chores, not for writing real features (use Claude Code for that). If it says "I will..." without acting, Raphael nudges it once to actually call the tool.

## Obsidian memory (learning over time)

Raphael uses your vault (`VAULT_DIR`, `C:\Users\darnie\Documents\Obsidian Vault`) as long-term memory, following the vault's `SCHEMA.md`/`AGENTS.md`:
- `raphael/memory.md`: short facts and preferences Raphael learns ("remember that...", or when you correct it). Loaded into every session (first `MEMORY_MAX_CHARS`). Your preferences there override Raphael's default style. Edit it in Obsidian anytime.
- Each session Raphael also reads the page list in `index.md`, so it knows your vault's topics; `vault_search` / `vault_read` look things up ("what do my notes say about LPMS?").
- "Note this idea: ..." -> `capture_note` saves to `inbox/` with frontmatter, for you or Hermes to file.
- `forget` removes a fact (asks first). Every memory change and capture adds one entry to `log.md`.
- `private/`, `.obsidian/` and `.git/` are blocked in code (`VAULT_BLOCKED`); Raphael never reads or writes them.
- "Learning" = notes Raphael reads back, not changes to the model itself. Self-check (fake vault, never your real one): `.\.venv\Scripts\python.exe vault.py`.

## More features

| Feature | How to use | Settings |
|---|---|---|
| Capstone Kanban | "what's next on my capstone?", "add a card ...", "move the X card to Review" (follows the vault's `AGENTS.md`: whole cards only, never to Done; add/move ask) | `KANBAN_NOTE` |
| Barge-in | talk over Raphael (or press the hotkey) and it stops speaking and listens | `BARGE_IN`, `BARGE_IN_RMS` |
| Reminders & timers | "remind me in 20 minutes to stretch", "set a 5 minute timer", "remind me tomorrow at 9 am...", "what reminders do I have?" -> spoken + HUD + Windows notification; saved in `data/`, missed ones fire at startup | |
| Daily notes | on exit / closing the window, a short session summary goes to `raphael/daily/YYYY-MM-DD.md` in the vault; the last one is recalled next session | `DAILY_DIR` |
| Type instead of talk | "Type to Raphael..." box under the core | |
| Mute | mic button in the footer or **Ctrl+Alt+M** | `MUTE_HOTKEY` |
| See the screen | "what does this error say?", "what's open in Zen?" -> screenshot of your working window (or a named one / "screen") read by the local vision model | |
| Big brain | "think harder ..." switches to the 12B model (up to a minute to load), "back to fast mode" switches back | `SMART_MODEL` |
| Themes | `neon`, `tensura` (gold/teal), `cyberpunk` | `HUD_THEME` |
| Start with Windows | `.\.venv\Scripts\python.exe autostart.py on` / `off`; Raphael waits up to 5 min for LM Studio's server | |
| Tests | `.\.venv\Scripts\python.exe tests\run_all.py` (fast) or `... --live` (LM Studio on) | |

The project is a git repository (`git log` shows each step); the Piper voices and `.venv` are not in git.

## Tray icon

While the window is open, Raphael's icon sits in the system tray (bottom right; it may be under the `^` arrow). Right-click: Show / Hide window / Mute or unmute mic / Stop current task / Quit. Double-click shows the window. Reminder pop-ups come from the tray icon. Needs `pystray` and `Pillow` (installed: `.\.venv\Scripts\python.exe -m pip install pystray Pillow`).

## Messaging (Facebook Messenger)

"Message Christine-san: running late" -> `send_message` finds her Messenger username in memory, then **always asks Allow/Deny** (red: THIS WILL SEND A MESSAGE), then opens `messenger.com/t/<username>` in Zen, waits for the page, types and sends.
- Teach a contact once: "remember that Christine-san's Messenger username is christine.santos" (the part after `facebook.com/` or `messenger.com/t/` in their profile link). Zen must be logged in to Facebook.
- Any Enter typed into a chat or mail window (Messenger, Facebook, WhatsApp, Gmail, Discord, ...) also asks first, even when `type_text` is "allow".
- Raphael can't click buttons on web pages; links like `messenger.com/t/...` avoid the need.
- Memory is reloaded on every request, so facts you just told Raphael work right away.
