# All Kumo settings live here.
import os
from pathlib import Path


# Local model server, OpenAI-compatible. Ollama (shared with Kumo, so only one copy of the model is in VRAM).
# Kumo can override these with KUMO_BASE_URL / KUMO_MODEL / KUMO_SMART_MODEL / KUMO_VISION_MODEL.
# LM Studio still works: BASE_URL = "http://localhost:1235/v1", MODEL = "google/gemma-4-e4b".
BASE_URL = os.environ.get("KUMO_BASE_URL", "http://localhost:11434/v1")
API_KEY = "local"  # placeholder, local servers ignore it

# Must match the server's model id. Run `python chat.py --models` to list ids.
MODEL = os.environ.get("KUMO_MODEL", "gemma4-e4b-kumo")
# "Think harder" / "use your big brain" switches to this one (sticky until "back to fast mode").
# Swapping costs ~20 s (load) and ~11 s back on an 8 GB card. Empty = not installed: Kumo says so.
SMART_MODEL = os.environ.get("KUMO_SMART_MODEL", "")
# Model for look_at_screen; must accept images. Empty = use MODEL.
VISION_MODEL = os.environ.get("KUMO_VISION_MODEL", "")

# Gemma "thinks" before answering, which adds 15+ s. "none" turns that off (faster, a bit less careful).
# Set to None to use the model's default.
REASONING_EFFORT = "none"
MAX_REPLY_TOKENS = 250      # hard cap so a rambling answer can't take minutes (about 180 words)

ASSISTANT_NAME = "Kumo"

SYSTEM_PROMPT = (
    f"You are {ASSISTANT_NAME}, a helpful local voice assistant with a calm, precise, analytical tone. "
    "When you report a result, begin with 'Answer.' "
    "Answer in one or two short sentences unless the user asks for detail (up to three when you give options). "
    "Be honest and wise on every topic, not only apps. When you lack something (an app that is not installed, "
    "a tool, an ability, or a fact you are not sure of), say so plainly in one sentence, then offer one or two "
    "practical options, for example install it, use an installed alternative, or the exact steps the user can do. "
    "Never pretend and never invent facts or results; when unsure, say so and say how to check. "
    "Never do a different action than the one asked: if the requested app or action is not available, do NOT "
    "substitute another one (for example do not open Zen when Chrome was asked); offer the alternative and wait. "
    "To type into an app use one type_text call with the window name (open the app first if needed). You cannot see "
    "which windows are open, so never say a window is missing without trying: call type_text and it will tell you; in a browser "
    "use before='ctrl+l' and enter='yes'. Use press_keys only for shortcuts like ctrl+t. Never put text inside keys. "
    "To message someone, call send_message with the person and the message (the user approves before it is sent); "
    "if it says the username is unknown, ask the user for it and call remember. You cannot click buttons on web pages, "
    "but most buttons have a link: Messenger = https://www.messenger.com, Facebook notifications = "
    "https://www.facebook.com/notifications, YouTube subscriptions = https://www.youtube.com/feed/subscriptions. "
    "When the user asks to click or open a button or menu that has such a link, opening the link IS doing what was "
    "asked: call open_url right away, don't offer it. "
    "To play a song or video use play_music; to pause, resume, skip or change volume of what is already playing use media_control. Before you say you cannot do something, think whether a tool gets close, "
    "use it, then say honestly what happened. "
    "You learn over time through the user's Obsidian vault. When the user tells you a lasting fact or preference "
    "about themselves, or corrects you, call remember with one short third-person sentence. For questions about the "
    "user's notes, projects or things they told you before, call vault_search and vault_read before answering. When "
    "the user says note this, save this idea or similar, call capture_note. "
    "For news (coding, AI, what's free, security, releases) call news_list with a category, then name the two or three "
    "most relevant headlines briefly. "
    "The user's capstone (LPMS) tasks are on a Kanban board: use kanban_list, kanban_add, kanban_move; never move a "
    "card to Done, the user does that. "
    "The user is a programmer. For coding chores use project_info (call it before running tests, it gives the exact "
    "command and folder), git_status, search_files, read_file, and run_command with that folder; then summarize the output in one or two sentences: "
    "passed or failed, and the first error with its file and line. To explain an error the user copied, call "
    "read_clipboard first. To give the user code or text to paste, use copy_to_clipboard. "
    "Use the PC facts below as ground truth. Match app names loosely ('Zen browser' means the app 'zen'). "
    "When the user clearly asks you to do something and you have the tool, call the tool right away; the user "
    "approves in a window, so do not ask permission in words first. For a website by name (YouTube, Gmail) call "
    "open_url with its address. If a tool result says DECLINED or Error, the action did NOT happen: say exactly that. "
    "No markdown, lists or emojis: your reply is spoken aloud. "
    "Reply in the language the user used: English, Tagalog, or Taglish. "
    "You can hear the user: they talk to you through their microphone (their speech reaches you as text) or type in "
    "Kumo's chat, and your replies are spoken aloud. Never say you cannot hear them. "
    "The user's words come from speech recognition and may contain wrong words; infer the likely meaning, "
    "and if a request is unclear, ask a short question instead of guessing. "
    "You do not know the current time or date: always call get_time for them, never guess. "
    "To act on the PC use your tools; the user approves risky ones. After a tool runs, check its result "
    "and only say something was done if the result confirms it. If a tool is declined or fails, say so and stop."
)

# --- Stage 2: tools ---
# name the model may use -> command that is run (opening an app always asks you first)
APP_WHITELIST = {
    "notepad": "notepad.exe",
    "calc": "calc.exe",
    "zen": r"C:\Program Files\Zen Browser\zen.exe",
    "chrome": "chrome.exe",   # not installed on this PC: Kumo will say so and suggest options
}

# list_files / read_file only work inside these folders (and their subfolders).
ALLOWED_DIRS = [
    str(Path(__file__).parent),  # this project folder (commands run here unless a project is named)
    r"C:\Users\darnie\own projects",  # your coding projects: read and search freely, writing asks
]
# --- Obsidian vault = long-term memory (vault.py follows the vault's SCHEMA.md / AGENTS.md) ---
VAULT_DIR = r"C:\Users\darnie\Documents\Obsidian Vault"
VAULT_BLOCKED = ("private", ".obsidian", ".git")  # never read or written (vault rule: never touch private/)
MEMORY_NOTE = "kumo/memory.md"                  # facts Kumo learns, loaded every session
DAILY_DIR = "kumo/daily"                        # one note per day with a summary of each Kumo session
KANBAN_NOTE = "projects/lpms-tasks.md"            # capstone board (moves follow the vault's AGENTS.md rules)
MEMORY_MAX_CHARS = 2000                            # how much memory goes into each session's prompt
PROJECTS_DIR = r"C:\Users\darnie\own projects"  # each subfolder is a project Kumo can name ("scamcheck", "docmind")

MAX_READ_BYTES = 20_000
MAX_WRITE_BYTES = 100_000
COMMAND_TIMEOUT = 30        # seconds before a PowerShell command is stopped
MAX_OUTPUT_CHARS = 4000     # command output sent back to the model
MAX_TOOL_ROUNDS = 15        # tool steps Kumo may chain for one request (Stop button cancels)
TYPING_DELAY = 0.035        # seconds between typed letters (0.01 = instant-looking, 0.06 = slow and visible)
APPROVAL_TIMEOUT = 120     # seconds to click Allow/Deny before it counts as Deny

# What happens when the model wants a tool:
#   "allow" = runs now, "ask" = you click Allow/Deny in the window, "deny" = turned off.
# Dangerous things (delete, move, uninstall, shutdown, downloads, registry, code files...) are never blocked,
# but they ALWAYS ask with a red warning, even if you set "allow".
PERMISSIONS = {
    "get_time": "allow", "system_info": "allow", "list_files": "allow", "read_file": "allow",
    "search_files": "allow", "open_folder": "allow", "focus_window": "allow", "media_control": "allow",
    "send_message": "allow",  # it ALWAYS asks before sending, whatever this says
    "look_at_screen": "allow",  # screenshot goes only to the local model
    "set_reminder": "allow", "list_reminders": "allow", "cancel_reminder": "allow",
    "kanban_list": "allow", "kanban_add": "ask", "kanban_move": "ask", "news_list": "allow",
    "remember": "allow", "vault_search": "allow", "vault_read": "allow", "capture_note": "allow", "forget": "ask",
    "git_status": "allow", "project_info": "allow", "read_clipboard": "allow", "copy_to_clipboard": "allow",
    "type_text": "allow", "press_keys": "allow", "open_app": "allow", "open_url": "allow", "play_music": "allow",
    "run_command": "allow",  # only commands that change/delete/install something ask (see DANGEROUS in tools.py)
    "write_file": "ask", "edit_file": "ask",  # changing files always asks
}

# --- Stage 3: voice ---
HOTKEY = "right ctrl"      # hold to talk
WHISPER_MODEL = "medium"   # "small" is faster; "medium" understands Tagalog and Taglish much better (CPU)
WHISPER_LANGUAGE = None    # None = detect, limited to WHISPER_LANGUAGES; or force one, e.g. "en"
WHISPER_LANGUAGES = ("en", "tl")  # English and Tagalog (Taglish is transcribed as either)
WHISPER_THREADS = 8        # CPU threads for Whisper (medium: ~7 s per phrase here with 8; "small" ~2.6 s)
WHISPER_BEAM = 5           # 1 = fastest, 5 = more accurate (a little slower)
WHISPER_HINTS = ""         # extra words you say often, e.g. "Darnie, Tensura, Downloads"
WHISPER_MIN_LOGPROB = -0.7 # below this average confidence Kumo asks you to repeat (lower = accept more guesses)
# Piper voice file. Swap by downloading another voice into voices/ and changing this:
#   .\.venv\Scripts\python.exe -m piper.download_voices <voice-name> --download-dir voices
PIPER_VOICE = r"voices\en_GB-jenny_dioco-medium.onnx"
# Tagalog replies are spoken with Meta's MMS Tagalog voice (facebook/mms-tts-tgl, CC-BY-NC 4.0: personal use).
# Needs torch + transformers; downloaded once (~145 MB). None = speak everything with PIPER_VOICE.
TAGALOG_VOICE = "facebook/mms-tts-tgl"
VOICE_SPEED = 1.1          # Piper length_scale: above 1 = slower, below 1 = faster
VOICE_VARIATION = 0.3      # Piper noise_scale: lower = flatter, more robotic (default 0.667)
OUTPUT_DEVICE = "Sound Mapper - Output"  # follows the live Windows default output. Or part of the speaker name, or None = Windows default. List: python voice.py --devices
MUTE_HOTKEY = "ctrl+alt+m" # toggles the mic on/off (also the mic button in the window)
BARGE_IN = True           # talk over Kumo (or press the hotkey) to make it stop speaking
BARGE_IN_RMS = 0.05        # how loud you must be to interrupt (raise if it stops by itself on speakers)
INPUT_DEVICE = None     # None = Windows default microphone

# --- Stage 4: wake word (optional) ---
WAKE_WORD_ENABLED = True  # True: say the wake phrase instead of holding the hotkey
# Wake phrase, spotted by Whisper (CPU, every utterance is transcribed locally). You can say the command
# in the same breath: "hey kumo, what time is it". Set to None to use the openWakeWord model below instead.
WAKE_PHRASE = "hey kumo"
WAKE_ALIASES = ("kumo", "como", "cumo", "kuma", "komo", "kumu", "coomo")  # how Whisper tends to spell "Kumo"
ALWAYS_LISTEN = os.environ.get("KUMO_ALWAYS_LISTEN", "1") != "0"  # Kumo sets this from its Settings.
                            # True: every phrase it hears is a request, no "hey kumo" needed.
                            # Music or video playing on SPEAKERS can then be heard as requests: use headphones,
                            # or set False to require the wake phrase again.
WAKE_FOLLOWUP_SECONDS = 20  # after a reply, keep listening this long without needing "hey kumo" (0 = always need it)
WAKE_WORD_MODEL = "hey_jarvis"  # only used when WAKE_PHRASE is None
WAKE_THRESHOLD = 0.5        # lower = more sensitive, more false triggers
SILENCE_RMS = 0.006         # mic level below this counts as silence (raise if it never stops recording)
SILENCE_SECONDS = 0.9      # stop recording after this much silence
MAX_RECORD_SECONDS = 15

# Number of past user/assistant exchanges kept for follow-up questions.
HISTORY_TURNS = 10

# --- News reader (news.py): feeds only, titles + links + short summaries ---
NEWS_INTERVAL_HOURS = 3
NEWS_DIGEST = True        # write kumo/news/YYYY-MM-DD.md in the vault (top headlines per category)
NEWS_DIR = "kumo/news"
# (name, feed URL, base category). Categories: coding, ai, free, security, release (keyword tags add more).
NEWS_SOURCES = [
    ("Hacker News", "https://hn.algolia.com/api/v1/search_by_date?tags=front_page&hitsPerPage=30", "coding"),
    ("dev.to", "https://dev.to/feed", "coding"),
    ("r/programming", "https://www.reddit.com/r/programming/.rss", "coding"),
    ("GitHub Blog", "https://github.blog/feed/", "coding"),
    ("freeCodeCamp", "https://www.freecodecamp.org/news/rss/", "coding"),
    ("Hugging Face", "https://huggingface.co/blog/feed.xml", "ai"),
    ("r/LocalLLaMA", "https://www.reddit.com/r/LocalLLaMA/.rss", "ai"),
    ("Simon Willison", "https://simonwillison.net/atom/everything/", "ai"),
    ("OpenAI", "https://openai.com/news/rss.xml", "ai"),
    ("Google AI", "https://blog.google/innovation-and-ai/technology/ai/rss/", "ai"),
    ("free-for.dev", "https://github.com/ripienaar/free-for-dev/commits/master.atom", "free"),
    ("Class Central", "https://www.classcentral.com/report/feed/", "free"),
    ("The Hacker News", "https://feeds.feedburner.com/TheHackersNews", "security"),
    ("BleepingComputer", "https://www.bleepingcomputer.com/feed/", "security"),
]
