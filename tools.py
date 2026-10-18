import ctypes
import fnmatch
import os
import platform
import re
import shutil
import subprocess
import threading
import time
import webbrowser
import winreg
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import keyboard

import config
from reminders import cancel_reminder, list_reminders, set_reminder  # reminders and timers
from vault import (capture_note, describe_forget, describe_kanban_add, describe_kanban_move, forget,  # Obsidian tools
                   kanban_add, kanban_list, kanban_move, remember, vault_read, vault_search)

cancel = threading.Event()   # set by the window's Stop button: tools stop and pending approvals are denied
approver = None              # set by ui.py: approver(name, detail, danger) -> bool. None = ask in the terminal
announce = lambda message: None  # chat.py --voice sets this to speak "I need your approval"
on_action = lambda x, y, label: None  # ui.py sets this: show Raphael's cursor at screen x, y (None = hide)
on_activity = lambda icon, text: None  # ui.py shows each tool step in the Activity panel
cursor_glide = 0.0                   # seconds the cursor animation takes (ui.py sets it; 0 = no window, no wait)

# Things that can destroy data or change the system. They are NOT blocked: they always ask, with a warning.
DANGEROUS = re.compile(
    r"\b(remove-item|rm|del|erase|rmdir|rd|format(?!-)|diskpart|uninstall|winget|choco|shutdown|restart-computer|stop-computer|"
    r"reg|regedit|set-executionpolicy|taskkill|stop-process|bcdedit|net|invoke-expression|iex|invoke-webrequest|iwr|curl|wget|"
    r"start-bitstransfer|schtasks|cipher|vssadmin|set-mppreference|move-item|mv|rename-item|clear-content|set-content|out-file|"
    r"new-item|ni|copy-item|cp|copy|mkdir|md|add-content|tee-object|install-module|install-package|msiexec|set-itemproperty|"
    r"new-itemproperty|remove-itemproperty|disable|enable|stop-service|set-service|restart-service|takeown|icacls|attrib)\b"
    # dev tools: only the sub-commands that install, delete or publish (npm test, git status, python x.py run freely)
    r"|\b(npm|pnpm|yarn|bun)\s+(install|i|add|remove|rm|uninstall|ci|publish|update|upgrade|link|prune)\b"
    r"|\b(pip|pip3|uv|poetry|conda)\s+(install|uninstall|add|remove|sync)\b|-m\s+pip\s+(install|uninstall)\b"
    r"|\bgit\s+(push|reset|clean|checkout|switch|restore|rebase|merge|pull|rm|mv|commit|stash|tag|branch\s+-[dD])\b"
    r"|\bgh\s+(pr\s+(create|merge|close)|repo\s+(create|delete)|release)\b"
    r"|\bdocker\s+(rm|rmi|prune|system|volume|compose\s+down|stop|kill)\b"
    r"|>", re.I)  # '>' = redirect output into a file
CODE_SUFFIXES = {".py", ".ps1", ".bat", ".cmd", ".exe", ".dll", ".reg", ".vbs", ".js", ".lnk", ".msi"}


# ---------- read-only tools ----------

def get_time():
    return datetime.now().strftime("%A, %d %B %Y, %H:%M:%S")


def _safe_path(path):
    """Resolve path; return it only if inside an allowed folder, else raise."""
    p = Path(path).expanduser().resolve()
    for d in config.ALLOWED_DIRS:
        if p.is_relative_to(Path(d).resolve()):
            return p
    raise PermissionError(f"'{path}' is outside the allowed folders: {config.ALLOWED_DIRS}")


def list_files(folder):
    p = _safe_path(folder)
    if not p.is_dir():
        return f"Error: '{folder}' is not a folder."
    return "\n".join(f"{x.name}{'/' if x.is_dir() else ''}" for x in sorted(p.iterdir())) or "(empty)"


def read_file(path):
    p = _safe_path(path)
    if not p.is_file():
        return f"Error: '{path}' is not a file."
    with open(p, "rb") as f:
        data = f.read(config.MAX_READ_BYTES + 1)
    text = data[: config.MAX_READ_BYTES].decode("utf-8", errors="replace")
    return text + ("\n...[truncated]" if len(data) > config.MAX_READ_BYTES else "")


def search_files(folder, pattern="*", text=""):
    """Find files by name pattern (e.g. *.py) and optionally by text inside them."""
    root = _safe_path(folder)
    if not root.is_dir():
        return f"Error: '{folder}' is not a folder."
    found = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in (".venv", "__pycache__", ".git", "node_modules")]
        for name in files:
            if not fnmatch.fnmatch(name.lower(), pattern.lower()):
                continue
            path = Path(dirpath) / name
            if not text:
                found.append(str(path))
            elif path.stat().st_size <= 1_000_000:
                try:
                    for n, line in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
                        if text.lower() in line.lower():
                            found.append(f"{path}:{n}: {line.strip()[:100]}")
                            break
                except OSError:
                    pass
            if len(found) >= 40:
                return "\n".join(found) + "\n...[first 40 shown]"
    return "\n".join(found) or "No matches."


def system_info():
    class MemStatus(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong),
                    ("avail", ctypes.c_ulonglong), ("tpage", ctypes.c_ulonglong), ("apage", ctypes.c_ulonglong),
                    ("tvirt", ctypes.c_ulonglong), ("avirt", ctypes.c_ulonglong), ("ext", ctypes.c_ulonglong)]

    class Power(ctypes.Structure):
        _fields_ = [("ac", ctypes.c_ubyte), ("flag", ctypes.c_ubyte), ("percent", ctypes.c_ubyte),
                    ("sys", ctypes.c_ubyte), ("life", ctypes.c_ulong), ("full", ctypes.c_ulong)]

    mem = MemStatus(length=ctypes.sizeof(MemStatus))
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(mem))
    power = Power()
    ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(power))
    disk = shutil.disk_usage("C:\\")
    gb = 1024 ** 3
    battery = "no battery (desktop)" if power.flag == 128 or power.percent == 255 else \
        f"{power.percent}%{', charging' if power.ac else ''}"
    uptime_h = ctypes.windll.kernel32.GetTickCount64() / 3_600_000
    return (f"{platform.platform()}; CPU: {platform.processor()}, {os.cpu_count()} threads; "
            f"RAM: {mem.avail / gb:.1f} GB free of {mem.total / gb:.1f} GB ({mem.load}% used); "
            f"disk C: {disk.free / gb:.0f} GB free of {disk.total / gb:.0f} GB; battery: {battery}; uptime: {uptime_h:.1f} h")


def open_folder(path):
    p = _safe_path(path)
    if not p.is_dir():
        return f"Error: '{path}' is not a folder."
    os.startfile(p)
    return f"Opened {p} in Explorer."


# ---------- tools that change things: each has a describer that validates first and says what will happen ----------

def _is_code(p):
    return p.suffix.lower() in CODE_SUFFIXES or ".venv" in p.parts


def app_installed(cmd):
    """True if the program exists: full path, on PATH, or registered with Windows (App Paths)."""
    if Path(cmd).is_absolute():
        return Path(cmd).exists()
    if shutil.which(cmd):
        return True
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            winreg.CloseKey(winreg.OpenKey(hive, rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{cmd}"))
            return True
        except OSError:
            pass
    return False


def environment_note():
    """Facts about this PC for the system prompt, so the model doesn't guess what is installed."""
    status = {n: app_installed(c) for n, c in config.APP_WHITELIST.items()}
    have = ", ".join(n for n, ok in status.items() if ok) or "none"
    missing = ", ".join(n for n, ok in status.items() if not ok)
    return (f"PC facts: Windows. Apps you can open that are installed: {have}. "
            + (f"Apps on your list that are NOT installed: {missing}. " if missing else "")
            + "Web pages open in the user's default browser. "
            + f"The user's coding projects (folder {config.PROJECTS_DIR}): {', '.join(_projects()) or 'none'}. "
            + f"Dev tools: {', '.join(t for t in ('git', 'node', 'npm', 'python', 'docker', 'gh') if shutil.which(t))}.")


# ---------- coding helpers ----------

def _projects():
    root = Path(config.PROJECTS_DIR)
    return sorted(p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")) if root.is_dir() else []


def _project_path(project):
    """'scamcheck', 'Scam Check', 'docmind/backend' or a full path -> the folder (must be inside ALLOWED_DIRS)."""
    if Path(project).is_absolute():
        return _safe_path(project)
    first, *rest = re.split(r"[\\/]", project.strip())
    want = re.sub(r"[^a-z0-9]", "", first.lower())
    for name in _projects():
        if want and want in re.sub(r"[^a-z0-9]", "", name.lower()):
            path = _safe_path(Path(config.PROJECTS_DIR, name, *rest))
            if not path.is_dir():
                raise ValueError(f"'{project}' is not a folder.")
            return path
    raise ValueError(f"no project matches '{project}'. Projects: {', '.join(_projects())}.")


def project_info(project):
    """What a project is built with and the exact commands to test/run it (looks in the folder and one level down)."""
    root = _project_path(project)
    base = str(root.relative_to(Path(config.PROJECTS_DIR).resolve())).replace("\\", "/") \
        if root.is_relative_to(Path(config.PROJECTS_DIR).resolve()) else str(root)
    git = any((p / ".git").exists() for p in [root, *root.parents])
    lines, parts = [f"{base}: " + ("in a git repository" if git else "not a git repository")], []
    for d in [root] + sorted(p for p in root.iterdir() if p.is_dir() and p.name not in (".git", ".venv", "node_modules")):
        rel = base if d == root else f"{base}/{d.name}"
        py = next(((d / v / "Scripts" / "python.exe") for v in (".venv", "venv") if (d / v / "Scripts" / "python.exe").exists()), None)
        if any((d / f).exists() for f in ("pytest.ini", "pyproject.toml", "requirements.txt", "setup.py")):
            python = f"{py.parent.parent.name}\\Scripts\\python.exe" if py else "python"
            test = f"{python} -m pytest -q" if (d / "pytest.ini").exists() or (d / "tests").is_dir() else "(no tests found)"
            parts.append(f"- {rel}: Python{' (own ' + py.parent.parent.name + ')' if py else ' (no virtual env found)'}. "
                         f"Test: run_command('{test}', folder='{rel}')")
        if (d / "package.json").exists():
            import json
            scripts = json.loads((d / "package.json").read_text(encoding="utf-8", errors="replace")).get("scripts", {})
            parts.append(f"- {rel}: Node. Scripts: {', '.join(scripts) or 'none'}"
                         + (f". Test: run_command('npm test', folder='{rel}')" if "test" in scripts else ""))
        if (d / "Dockerfile").exists() or (d / "docker-compose.yml").exists():
            parts.append(f"- {rel}: has Docker files")
    readme = next((root / f for f in ("README.md", "readme.md", "README.txt") if (root / f).exists()), None)
    if readme:
        first = next((l.strip("# ").strip() for l in readme.read_text(encoding="utf-8", errors="replace").splitlines() if l.strip()), "")
        lines.append(f"README: {first[:120]}")
    return "\n".join(lines + (parts or ["- no Python or Node project files found"]))


def git_status(project):
    """Branch, changed files and recent commits of a project (read-only)."""
    path = _project_path(project)
    run = lambda *args: subprocess.run(["git", "-C", str(path), *args], capture_output=True, text=True,
                                       encoding="utf-8", errors="replace", timeout=15)
    status = run("status", "--short", "--branch")
    if status.returncode:
        return f"Error: {status.stderr.strip() or 'git failed'} ({path.name} may not be a git repository)."
    lines = status.stdout.strip().splitlines()
    changed = [l for l in lines[1:] if not l.startswith("##")]
    log = run("log", "--oneline", "-5").stdout.strip()
    return (f"{path.name}: {lines[0].lstrip('# ')}\n"
            f"{len(changed)} changed file(s):\n" + "\n".join(changed[:30]) + ("\n..." if len(changed) > 30 else "")
            + f"\nRecent commits:\n{log or '(none)'}")


def read_clipboard():
    out = subprocess.run(["powershell", "-NoProfile", "-Command",
                          "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"],
                         capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10).stdout.strip()
    if not out:
        return "The clipboard is empty (or holds an image, not text)."
    return out[: config.MAX_READ_BYTES] + ("\n...[truncated]" if len(out) > config.MAX_READ_BYTES else "")


def copy_to_clipboard(text):
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    "[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"],
                   input=text, text=True, encoding="utf-8", capture_output=True, timeout=10)
    return f"Copied {len(text)} characters to the clipboard."


def describe_open_app(name):
    key = name.lower().strip()
    if key not in config.APP_WHITELIST:
        raise ValueError(f"'{name}' is not on the allowed list. Allowed apps: {', '.join(config.APP_WHITELIST)}. "
                         "Tell the user and suggest an allowed app or adding it to APP_WHITELIST in config.py.")
    if not app_installed(config.APP_WHITELIST[key]):
        have = [n for n, c in config.APP_WHITELIST.items() if app_installed(c)]
        raise ValueError(f"'{name}' is NOT installed on this PC. Installed apps you can open: {', '.join(have)}. "
                         "Tell the user it is missing and offer to install it or use an installed alternative.")
    return f"Open application: {config.APP_WHITELIST[key]}", False


def open_app(name):
    cmd = config.APP_WHITELIST[name.lower().strip()]
    try:
        os.startfile(cmd)  # only whitelisted commands ever reach here
    except OSError as e:
        return f"Error: could not start {cmd}: {e}"
    for _ in range(25):  # wait up to 5 s for its window, so a type_text right after finds it
        try:
            _find_window(Path(cmd).stem)
            return f"Opened {name}; its window is ready."
        except ValueError:
            time.sleep(0.2)
    return f"Opened {name} (its window may still be loading)."


# ---------- keyboard control of other windows ----------

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
HWND = ctypes.c_void_p
user32.GetWindowTextW.argtypes = [HWND, ctypes.c_wchar_p, ctypes.c_int]
user32.IsWindowVisible.argtypes = user32.IsIconic.argtypes = user32.SetForegroundWindow.argtypes = [HWND]
user32.BringWindowToTop.argtypes = [HWND]
user32.GetGUIThreadInfo.argtypes = [ctypes.c_ulong, ctypes.c_void_p]
user32.ClientToScreen.argtypes = [HWND, ctypes.c_void_p]
user32.GetWindowRect.argtypes = [HWND, ctypes.c_void_p]
user32.AttachThreadInput.argtypes = [ctypes.c_ulong, ctypes.c_ulong, ctypes.c_bool]
user32.ShowWindow.argtypes = [HWND, ctypes.c_int]
user32.GetWindowThreadProcessId.argtypes = [HWND, ctypes.POINTER(ctypes.c_ulong)]
user32.GetForegroundWindow.restype = HWND
kernel32.OpenProcess.restype = ctypes.c_void_p
kernel32.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
TERMINALS = {"powershell.exe", "pwsh.exe", "cmd.exe", "windowsterminal.exe", "wt.exe", "conhost.exe", "bash.exe",
             "wsl.exe", "mintty.exe", "openconsole.exe"}


def _title(hwnd):
    buf = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, buf, 512)
    return buf.value


def _exe(hwnd):
    pid = ctypes.c_ulong()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    handle = kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return "?"
    buf, size = ctypes.create_unicode_buffer(512), ctypes.c_ulong(512)
    kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size))
    kernel32.CloseHandle(handle)
    return Path(buf.value).name.lower()


def _windows():
    """Visible top-level windows with a title: [(hwnd, title, exe)], Raphael's own window excluded."""
    found = []
    proc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)(
        lambda h, _: (found.append(h) if user32.IsWindowVisible(h) and _title(h) else None) or True)
    user32.EnumWindows(proc, 0)
    return [(h, _title(h), _exe(h)) for h in found if _title(h) != config.ASSISTANT_NAME]


def _find_window(window):
    """First window whose title or program name contains `window` (case-insensitive)."""
    w = window.lower().strip()
    for h, title, exe in _windows():
        if w and (w in title.lower() or w in exe):
            return h, title, exe
    names = sorted({t[:40] for _, t, _ in _windows()})[:15]
    raise ValueError(f"no open window matches '{window}'. Open windows: {'; '.join(names)}. "
                     "Open the app first (open_app) or use one of these names.")


def _bring_to_front(hwnd):
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    front = user32.GetForegroundWindow()
    if front != hwnd:
        # Windows only lets the program that owns the front window hand over focus, so briefly share its input queue.
        theirs = user32.GetWindowThreadProcessId(front, None)
        ours = kernel32.GetCurrentThreadId()
        user32.AttachThreadInput(ours, theirs, True)
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        user32.AttachThreadInput(ours, theirs, False)
    for _ in range(20):
        if user32.GetForegroundWindow() == hwnd:
            time.sleep(0.15)  # let the window settle before keys arrive
            return
        time.sleep(0.05)
    raise RuntimeError("could not bring the window to the front, so nothing was typed.")


def focus_window(window):
    h, title, _ = _find_window(window)
    _bring_to_front(h)
    return f"'{title}' is now in front."


def _describe_keys(window, what):
    h, title, exe = _find_window(window)
    terminal = exe in TERMINALS
    warn = "\nTHIS IS A TERMINAL: typed text can run commands." if terminal else ""
    return f"Target window: {title} ({exe}){warn}\n{what}", terminal


def _yes(value):
    return str(value).strip().lower() in ("yes", "true", "1", "y")


def describe_type_text(window, text, before="", enter="no"):
    if before:
        keyboard.parse_hotkey_combinations(before)  # unknown key names fail before asking you
    what = (f"First press: {before}\n" if before else "") + f"Type: {text[:400]}" + ("\nThen press Enter" if _yes(enter) else "")
    return _describe_keys(window, what + ("\n(text contains Enter: it may submit)" if "\n" in text else ""))


class _Rect(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class _GuiInfo(ctypes.Structure):
    _fields_ = [("size", ctypes.c_ulong), ("flags", ctypes.c_ulong)] + [(n, HWND) for n in (
        "active", "focus", "capture", "menu", "movesize", "caret")] + [("caret_rect", _Rect)]


def _cursor_point(hwnd, address_bar=False):
    """Screen point where typing will land: the text caret if the app reports one, else a sensible spot."""
    r = _Rect()
    user32.GetWindowRect(HWND(hwnd), ctypes.byref(r))
    if address_bar:  # browsers: ctrl+l puts the caret in the address bar near the top
        return r.left + (r.right - r.left) // 3, r.top + 55
    info = _GuiInfo(size=ctypes.sizeof(_GuiInfo))
    if user32.GetGUIThreadInfo(user32.GetWindowThreadProcessId(hwnd, None), ctypes.byref(info)) and info.caret:
        pt = ctypes.c_long * 2
        p = pt(info.caret_rect.left, info.caret_rect.bottom)
        user32.ClientToScreen(HWND(info.caret), ctypes.byref(p))
        if r.left <= p[0] <= r.right and r.top <= p[1] <= r.bottom:
            return p[0] + 2, p[1] + 12  # below the caret, so the arrow doesn't hide the letters
    return (r.left + r.right) // 2, r.top + (r.bottom - r.top) // 3


def _point_and_wait(hwnd, label, address_bar=False):
    """Show Raphael's cursor gliding to where the keys will go (window only), then wait for the animation."""
    x, y = _cursor_point(hwnd, address_bar)
    on_action(x, y, label)
    time.sleep(cursor_glide)


def type_text(window, text, before="", enter="no"):
    h, title, _ = _find_window(window)
    _bring_to_front(h)
    try:
        steps = [s.strip() for s in before.split(",") if s.strip()]
        _point_and_wait(h, "typing…", address_bar="ctrl+l" in steps)
        for step in steps:
            keyboard.send(step)
            time.sleep(0.15)
        for chunk in re.findall(r"\S+\s*|\s+", text):  # word by word, so the cursor can follow the caret
            keyboard.write(chunk, delay=config.TYPING_DELAY)
            if cursor_glide:
                on_action(*_cursor_point(h), None)
        if _yes(enter):
            time.sleep(0.1)
            keyboard.send("enter")
    finally:
        on_action(None, None, None)
    return f"Typed {len(text)} characters into '{title}'" + (" and pressed Enter." if _yes(enter) else ".")


def describe_press_keys(window, keys):
    keyboard.parse_hotkey_combinations(keys)  # raises on unknown key names before asking you
    return _describe_keys(window, f"Press keys: {keys}")


def press_keys(window, keys):
    h, title, _ = _find_window(window)
    _bring_to_front(h)
    try:
        _point_and_wait(h, keys)
        for step in keys.split(","):  # "ctrl+l, enter" = two steps
            keyboard.send(step.strip())
            time.sleep(0.1)
    finally:
        on_action(None, None, None)
    return f"Pressed {keys} in '{title}'."


MEDIA_KEYS = {"play": "play/pause media", "pause": "play/pause media", "play_pause": "play/pause media",
              "next": "next track", "previous": "previous track", "stop": "stop media",
              "volume_up": "volume up", "volume_down": "volume down", "mute": "volume mute"}


def media_control(action, times="1"):
    """Windows media keys: control whatever is playing (YouTube in Zen, Spotify...) without focusing it."""
    key = MEDIA_KEYS.get(action.lower().strip().replace(" ", "_").replace("/", "_"))
    if not key:
        return f"Error: unknown action '{action}'. Use one of: {', '.join(MEDIA_KEYS)}."
    n = max(1, min(int(times or 1), 25))  # volume steps are 2% each
    for _ in range(n):
        keyboard.send(key)
        time.sleep(0.05)
    return f"Sent '{key}' x{n}. (play and pause are the same toggle key.)"


_found = {}  # query -> (title, url): looked up while asking for approval, reused when it runs


def describe_play_music(query):
    import yt_dlp  # needs internet; only looks up the first YouTube result, downloads nothing
    with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True, "extract_flat": True, "noplaylist": True}) as y:
        entries = y.extract_info(f"ytsearch1:{query}", download=False).get("entries") or []
    if not entries:
        raise ValueError(f"nothing found on YouTube for '{query}'. Offer to open a search page with open_url instead.")
    e = entries[0]
    _found[query] = (e["title"], e.get("url") or f"https://www.youtube.com/watch?v={e['id']}")
    return f"Play on YouTube in your browser:\n{e['title']} ({e.get('channel') or 'unknown channel'})\n{_found[query][1]}", False


def play_music(query):
    title, url = _found.pop(query)
    return f"Opened '{title}' in the browser; it starts playing there." if webbrowser.open(url) else "Error: the browser did not open."


def describe_open_url(url):
    parts = urlparse(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("only full http:// or https:// web addresses can be opened.")
    return f"Open in your default browser: {url}", False


def open_url(url):
    return f"Opened {url} in the default browser." if webbrowser.open(url) else "Error: the browser did not open."


def describe_write_file(path, content):
    p = _safe_path(path)
    if p.is_dir():
        raise ValueError(f"'{path}' is a folder.")
    size = len(content.encode("utf-8"))
    if size > config.MAX_WRITE_BYTES:
        raise ValueError(f"content is {size} bytes, limit is {config.MAX_WRITE_BYTES}.")
    action = f"OVERWRITE existing file ({p.stat().st_size} bytes)" if p.exists() else "CREATE new file"
    return f"{action}: {p}\n{size} bytes. Start of content:\n{content[:400]}", _is_code(p)


def write_file(path, content):
    p = _safe_path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return f"Wrote {len(content)} characters to {p}."


def describe_edit_file(path, old, new):
    p = _safe_path(path)
    if not p.is_file():
        raise ValueError(f"'{path}' is not a file.")
    n = p.read_text(encoding="utf-8", errors="replace").count(old)
    if n != 1:
        raise ValueError("the text to replace was not found." if n == 0 else
                         f"the text to replace appears {n} times; include more surrounding text so it is unique.")
    return f"EDIT {p}\n- {old[:300]}\n+ {new[:300]}", _is_code(p)


def edit_file(path, old, new):
    p = _safe_path(path)
    p.write_text(p.read_text(encoding="utf-8", errors="replace").replace(old, new, 1), encoding="utf-8")
    return f"Edited {p}."


def describe_run_command(command, folder=""):
    danger = bool(DANGEROUS.search(command))
    return f"PowerShell command (runs in {_cwd(folder)}):\n{command}", danger


def _cwd(folder):
    return _project_path(folder) if folder else Path(config.ALLOWED_DIRS[0])


def run_command(command, folder=""):
    """Run a PowerShell command (in a project folder if given); stops after COMMAND_TIMEOUT s or on Stop."""
    proc = subprocess.Popen(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                             "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " + command],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True,
                            encoding="utf-8", errors="replace", cwd=_cwd(folder))
    start = time.time()
    while True:
        try:
            out, _ = proc.communicate(timeout=0.3)
            break
        except subprocess.TimeoutExpired:
            if cancel.is_set() or time.time() - start > config.COMMAND_TIMEOUT:
                # kill the whole tree: 'npm test' starts node, which a plain kill would leave running
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
                proc.communicate()
                return "Error: command was stopped " + ("by the user." if cancel.is_set() else f"after {config.COMMAND_TIMEOUT}s.")
    out = out.strip()
    if len(out) > config.MAX_OUTPUT_CHARS:
        out = out[: config.MAX_OUTPUT_CHARS] + "\n...[output truncated]"
    return f"exit code {proc.returncode}\n{out}"


# ---------- registry and permission gate ----------

def _fn(name, desc, props=None, optional=()):
    props = props or {}
    return {"type": "function", "function": {
        "name": name, "description": desc,
        "parameters": {"type": "object", "properties": {k: {"type": "string", "description": v} for k, v in props.items()},
                       "required": [k for k in props if k not in optional]}}}


TOOLS = [
    _fn("get_time", "Get the current date and time."),
    _fn("system_info", "Get PC info: OS, CPU, free RAM, disk space, battery, uptime."),
    _fn("open_app", f"Open an application. Allowed: {', '.join(config.APP_WHITELIST)}.", {"name": "App name"}),
    _fn("play_music", "Play a song or video: finds the best YouTube match and plays it in the browser. Use this for any "
        "'play ...' request. Needs internet.", {"query": "Song title and artist, or video topic"}),
    _fn("media_control", "Control what is playing (YouTube in the browser, Spotify...): play or pause (one toggle), "
        "next, previous, stop, volume_up, volume_down, mute. Use for 'play it', 'pause', 'next video', 'louder'.",
        {"action": "play, pause, next, previous, stop, volume_up, volume_down or mute",
         "times": "How many times, e.g. 5 for volume (each step is 2%) (optional)"}, optional=("times",)),
    _fn("focus_window", "Bring an open window to the front.", {"window": "Part of the window title or program name, e.g. zen, notepad"}),
    _fn("type_text", "Type text into an open window (brought to the front first), optionally pressing keys before "
        "and Enter after, all in ONE call. Browser search example: window='zen', before='ctrl+l', "
        "text='cheap flights', enter='yes'. The user must approve.",
        {"window": "Part of the window title or program name, e.g. zen, notepad", "text": "Text to type",
         "before": "Keys to press first, e.g. ctrl+l (optional)", "enter": "'yes' to press Enter after typing (optional)"},
        optional=("before", "enter")),
    _fn("press_keys", "Press keys or shortcuts in an open window. Steps separated by commas, e.g. 'ctrl+l', 'enter', "
        "'ctrl+t', 'ctrl+s', 'ctrl+l, enter'. The user must approve.",
        {"window": "Part of the window title or program name", "keys": "Keys to press"}),
    _fn("open_url", "Open a web page or a web search in the user's browser. Web search: https://duckduckgo.com/?q=your+words",
        {"url": "Full http(s) address"}),
    _fn("list_files", "List files in an allowed folder.", {"folder": "Absolute folder path"}),
    _fn("read_file", "Read a text file from an allowed folder.", {"path": "Absolute file path"}),
    _fn("search_files", "Find files by name pattern and optionally by text inside them.",
        {"folder": "Absolute folder path", "pattern": "File name pattern like *.py (default *)", "text": "Text to look for inside files"},
        optional=("pattern", "text")),
    _fn("open_folder", "Show an allowed folder in Windows Explorer.", {"path": "Absolute folder path"}),
    _fn("write_file", "Create or overwrite a text file in an allowed folder. The user must approve.",
        {"path": "Absolute file path", "content": "Full file content"}),
    _fn("edit_file", "Replace one exact piece of text in a file. The user must approve.",
        {"path": "Absolute file path", "old": "Exact text to replace (must appear once)", "new": "Replacement text"}),
    _fn("run_command", "Run a PowerShell command and get its output, e.g. tests or scripts (npm test, python -m pytest). "
        "Commands that install, delete or push ask the user first. Prefer the other tools when they fit.",
        {"command": "PowerShell command", "folder": "Project name to run it in, e.g. scamcheck (optional)"},
        optional=("folder",)),
    _fn("remember", "Save a lasting fact, preference or correction about the user to long-term memory (Obsidian).",
        {"fact": "One short third-person sentence, e.g. 'Darnie prefers dark mode'"}),
    _fn("forget", "Remove a remembered fact. The user must approve.", {"fact": "Words from the fact to remove"}),
    _fn("vault_search", "Search the user's Obsidian notes (their second brain) for words.", {"query": "Words to find"}),
    _fn("vault_read", "Read one Obsidian note by name, e.g. second-brain or lpms-capstone.", {"note": "Note name or path"}),
    _fn("capture_note", "Save an idea or note into the user's Obsidian inbox.", {"title": "Short title", "text": "The note"}),
    _fn("set_reminder", "Set a reminder or timer. Give in_minutes (e.g. 20) OR at (e.g. 15:30, 3:30 pm, tomorrow 9:00).",
        {"text": "What to remind about (for a timer: 'Timer')", "in_minutes": "Minutes from now",
         "at": "Clock time or date and time"}, optional=("in_minutes", "at")),
    _fn("list_reminders", "List upcoming reminders and timers."),
    _fn("cancel_reminder", "Cancel a reminder.", {"text": "Words from the reminder"}),
    _fn("kanban_list", "Show the user's capstone task board (Obsidian Kanban): cards in To Do, Doing, Review, Blocked, Done. "
        "'What's next' = the first card under To Do."),
    _fn("kanban_add", "Add a card to the capstone board. The user must approve.",
        {"text": "Card text", "column": "To Do (default), Doing, Review or Blocked"}, optional=("column",)),
    _fn("kanban_move", "Move a card to To Do, Doing, Review or Blocked (never Done). The user must approve.",
        {"card": "A few words from the card", "column": "To Do, Doing, Review or Blocked",
         "note": "Short note added under the card, e.g. why it is blocked (optional)"}, optional=("note",)),
    _fn("project_info", "What a coding project uses (Python/Node/Docker, git) and the exact command to run its tests. "
        "Call this before running tests.", {"project": "Project name, e.g. docmind"}),
    _fn("git_status", "Show a coding project's git branch, changed files and recent commits.",
        {"project": "Project name, e.g. scamcheck"}),
    _fn("read_clipboard", "Read the text the user copied (e.g. an error message to explain)."),
    _fn("copy_to_clipboard", "Put text on the user's clipboard so they can paste it.", {"text": "Text to copy"}),
]
FUNCS = {f["function"]["name"]: globals()[f["function"]["name"]] for f in TOOLS}
DESCRIBE = {"forget": describe_forget, "kanban_add": describe_kanban_add, "kanban_move": describe_kanban_move, "type_text": describe_type_text, "press_keys": describe_press_keys, "focus_window": lambda window: (
                f"Bring to front: {_find_window(window)[1]}", False), "open_app": describe_open_app, "open_url": describe_open_url, "play_music": describe_play_music, "write_file": describe_write_file, "edit_file": describe_edit_file,
            "run_command": describe_run_command}


def confirm(name, detail, danger):
    announce(f"I need your approval to use {name.replace('_', ' ')}.")
    if approver:
        return approver(name, detail, danger)
    print(f"\n[confirm] {config.ASSISTANT_NAME} wants to use {name}:\n{detail}")
    if danger:
        print("[confirm] !!! WARNING: this can change or delete things, or is risky !!!")
    return input("[confirm] Allow? (y/n) ").strip().lower() == "y"


def run_tool(name, args):
    """Run one tool call and report it to the window's Activity panel."""
    short = ", ".join(str(v) for v in args.values())[:60]
    on_activity("▶", name + (f": {short}" if short else ""))
    result = _run_tool(name, args)
    ok = not result.startswith(("Error", "DECLINED", "Denied", "Cancelled"))
    on_activity("✓" if ok else "✗", (result.strip().splitlines() or ["done"])[0][:90])
    return result


def _run_tool(name, args):
    if cancel.is_set():
        return "Cancelled by the user."
    if name not in FUNCS:
        return f"Error: unknown tool '{name}'."
    mode = config.PERMISSIONS.get(name, "ask")
    if mode == "deny":
        return "Denied: this tool is turned off in config.py (PERMISSIONS)."
    try:
        detail, danger = DESCRIBE[name](**args) if name in DESCRIBE else ("", False)  # validates before asking
        if (mode == "ask" or danger) and not confirm(name, detail, danger):  # danger always asks, even if mode is "allow"
            return "DECLINED: the user clicked Deny. The action was NOT done. Tell the user plainly that it was not done."
        return str(FUNCS[name](**args))
    except Exception as e:  # report to the model so it can explain/recover
        return f"Error: {e}"


if __name__ == "__main__":
    # self-check: allowlist, gate and the new tools
    root = config.ALLOWED_DIRS[0]
    config.PERMISSIONS.update(run_command="ask", write_file="ask", edit_file="ask")  # test the gate itself
    asked = []
    approver = lambda name, detail, danger: (asked.append((name, danger)), answer)[1]
    answer = False
    test = Path(root) / "_selftest.txt"
    try:
        assert "outside" in run_tool("read_file", {"path": r"C:\Windows\win.ini"})
        assert "outside" in run_tool("list_files", {"folder": config.PROJECTS_DIR + r"\.."})
        assert "chat.py" in run_tool("list_files", {"folder": root})
        assert "import" in run_tool("read_file", {"path": root + r"\chat.py"})
        assert run_tool("get_time", {}) and "RAM" in run_tool("system_info", {})
        assert "chat.py" in run_tool("search_files", {"folder": root, "pattern": "*.py"})
        assert "def run_tool" in run_tool("search_files", {"folder": root, "pattern": "*.py", "text": "def run_tool"})
        # dev commands: everyday ones run freely, installs/deletes/pushes ask
        for cmd in ("npm test", "npm run build", "git status", "git log --oneline", "git diff", "python -m pytest",
                    "py app.py", "docker ps", "gh pr list", "node -v", "Get-ChildItem"):
            assert not DANGEROUS.search(cmd), cmd
        for cmd in ("npm install", "npm i lodash", "pip install x", "python -m pip install x", "git push", "git reset --hard",
                    "git clean -fd", "git commit -m x", "docker rm x", "gh pr merge 3", "Remove-Item x", "winget uninstall x"):
            assert DANGEROUS.search(cmd), cmd
        assert _project_path("raphael").name == "raphael" and _project_path("Scam Check").name == "scamcheck"
        assert "Projects:" in run_tool("git_status", {"project": "nosuchproject"})
        config.PERMISSIONS["run_command"] = "allow"
        where = run_tool("run_command", {"command": "Get-Location", "folder": "docmind"})
        assert "exit code 0" in where and "docmind" in where, where
        config.PERMISSIONS["run_command"] = "ask"

        assert "outside" in run_tool("write_file", {"path": r"C:\Windows\x.txt", "content": "x"}) and not asked  # no prompt for impossible ops
        assert "DECLINED" in run_tool("write_file", {"path": str(test), "content": "hello"}) and not test.exists()
        answer = True
        assert "Wrote" in run_tool("write_file", {"path": str(test), "content": "hello world"}) and test.read_text() == "hello world"
        assert "Edited" in run_tool("edit_file", {"path": str(test), "old": "world", "new": "there"}) and test.read_text() == "hello there"
        assert "not found" in run_tool("edit_file", {"path": str(test), "old": "zzz", "new": "y"})
        test.write_text("aa aa")
        assert "2 times" in run_tool("edit_file", {"path": str(test), "old": "aa", "new": "b"})
        assert "hi" in run_tool("run_command", {"command": "echo hi"})
        asked.clear()
        answer = False
        run_tool("run_command", {"command": "Remove-Item x"})
        assert asked == [("run_command", True)]  # dangerous command: asked, flagged, and declined means not run
        asked.clear()
        run_tool("run_command", {"command": "Get-Date"})
        assert asked == [("run_command", False)]
        run_tool("write_file", {"path": root + r"\_x.py", "content": "1"})
        assert asked[-1] == ("write_file", True)  # code file: flagged
        config.COMMAND_TIMEOUT = 1
        answer = True
        assert "stopped" in run_tool("run_command", {"command": "Start-Sleep 10"})
        config.PERMISSIONS["run_command"] = "allow"  # everyday commands run without asking...
        asked.clear()
        assert "exit code 0" in run_tool("run_command", {"command": "Get-Date"}) and not asked
        answer = False
        for risky in ("Remove-Item x", "New-Item x.txt", "echo hi > x.txt", "winget uninstall x", "Copy-Item a b"):
            assert "DECLINED" in run_tool("run_command", {"command": risky}), risky  # ...changes still ask
        assert not (Path(root) / "x.txt").exists()
        config.PERMISSIONS["read_file"] = "deny"
        assert "turned off" in run_tool("read_file", {"path": root + r"\chat.py"})
        config.PERMISSIONS["get_time"] = "allow"
    finally:
        test.unlink(missing_ok=True)
    print("tools OK")
