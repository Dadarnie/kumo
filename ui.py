"""Raphael's window: hud.html shown in a native window by pywebview (Edge WebView2, GPU-drawn).
Thread-safe: any thread can call set_state/show/note/activity/level/speak_envelope/ask_approval."""
import ctypes
import itertools
import json
import math
import queue
import random
import shutil
import threading
import time
import tkinter as tk
from pathlib import Path

import webview

import config
import tools

HTML = Path(__file__).parent / "hud.html"
ICON = Path(__file__).parent / "raphael.ico"
# own taskbar identity, so Windows shows Raphael's icon instead of grouping it under Python
ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Raphael.Assistant")


# ---------- live PC numbers (Windows API, no packages) ----------

class _Mem(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [(n, ctypes.c_ulonglong) for n in (
        "total", "avail", "tpage", "apage", "tvirt", "avirt", "ext")]


class _Display(ctypes.Structure):
    _fields_ = [("cb", ctypes.c_ulong), ("name", ctypes.c_wchar * 32), ("string", ctypes.c_wchar * 128),
                ("flags", ctypes.c_ulong), ("id", ctypes.c_wchar * 128), ("key", ctypes.c_wchar * 128)]


def _gpu_name():
    d = _Display(cb=ctypes.sizeof(_Display))
    return d.string if ctypes.windll.user32.EnumDisplayDevicesW(None, 0, ctypes.byref(d), 0) else "GPU"


def _cpu_times():
    idle, kernel, user = ctypes.c_ulonglong(), ctypes.c_ulonglong(), ctypes.c_ulonglong()
    ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user))
    return idle.value, kernel.value + user.value  # kernel time includes idle time


def _ram_percent():
    m = _Mem(length=ctypes.sizeof(_Mem))
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m.load


def _rounded(x0, y0, x1, y1, r):
    """Points for a rounded rectangle drawn with smooth=True (Tk has no rounded rectangles)."""
    return [x0 + r, y0, x0 + r, y0, x1 - r, y0, x1 - r, y0, x1, y0, x1, y0 + r, x1, y0 + r, x1, y1 - r,
            x1, y1 - r, x1, y1, x1 - r, y1, x1 - r, y1, x0 + r, y1, x0 + r, y1, x0, y1, x0, y1 - r,
            x0, y1 - r, x0, y0 + r, x0, y0 + r, x0, y0]


class CursorOverlay:
    """Raphael's cursor: glides to where keys will be typed and follows the caret while typing.
    Click-through and never takes focus, so it can't steal the keystrokes."""
    KEY = "#010203"  # this colour is see-through
    GLIDE = 0.6

    def __init__(self, root):
        self.root = root
        self.win = tk.Toplevel(root)
        self.win.title(config.ASSISTANT_NAME)  # tools._find_window skips windows with this title
        self.win.overrideredirect(True)
        self.win.attributes("-topmost", True)
        self.win.attributes("-transparentcolor", self.KEY)
        self.cv = tk.Canvas(self.win, width=230, height=56, bg=self.KEY, highlightthickness=0)
        self.cv.pack()
        tip = 4
        arrow = [(0, 0), (0, 26), (7.5, 19.5), (19, 19)]  # macOS-style arrowhead, no tail
        pts = lambda dx, dy: [(tip + x + dx, tip + y + dy) for x, y in arrow]
        self.cv.create_polygon(pts(3, 3), fill="#a6a6a6", outline="#a6a6a6", width=2, joinstyle="round")  # shadow
        self.cv.create_polygon(pts(0, 0), fill="white", outline="black", width=2, joinstyle="round")
        self.cv.create_polygon(_rounded(32, 24, 226, 48, 12), smooth=True, fill="#1c1c1e", outline="#3a3a3c")
        self.text = self.cv.create_text(44, 36, text="", anchor="w", fill="#f2f2f7", font=("Segoe UI", 10, "bold"))
        self.tip, self.start, self.target, self.t0, self.running, self.glide = tip, None, None, 0.0, False, self.GLIDE
        self.win.geometry("+-3000+-3000")
        self.win.update_idletasks()
        hwnd = int(self.win.wm_frame(), 16)
        GWL_EXSTYLE, NOACTIVATE, TRANSPARENT, TOOLWINDOW, LAYERED = -20, 0x08000000, 0x20, 0x80, 0x80000
        u = ctypes.windll.user32
        u.SetWindowLongW(hwnd, GWL_EXSTYLE, u.GetWindowLongW(hwnd, GWL_EXSTYLE) | NOACTIVATE | TRANSPARENT | TOOLWINDOW | LAYERED)

    def go(self, x, y, label):
        """Glide to x, y. label=None means 'follow the caret': keep the label and move quickly."""
        here = self._pos() if self.target else self.root.winfo_pointerxy()  # start from the mouse, or where it is now
        self.start, self.target, self.t0 = here, (x, y), time.time()
        self.glide = 0.15 if label is None else self.GLIDE
        if label is not None:
            self.cv.itemconfig(self.text, text=f"{config.ASSISTANT_NAME} · {label}")
        if not self.running:
            self.running = True
            self._animate()

    def hide(self):
        self.target, self.running = None, False
        self.win.geometry("+-3000+-3000")

    def _pos(self):
        p = min(1.0, (time.time() - self.t0) / self.glide)
        ease = 4 * p ** 3 if p < 0.5 else 1 - (-2 * p + 2) ** 3 / 2  # ease-in-out: soft start and soft landing
        return tuple(round(s + (e - s) * ease) for s, e in zip(self.start, self.target))

    def _animate(self):
        """Own fast loop (~120 fps) so the glide is smooth; stops when it arrives."""
        if not self.running or not self.target:
            return
        x, y = self._pos()
        self.win.geometry(f"+{x - self.tip}+{y - self.tip}")
        if time.time() - self.t0 < self.glide:
            self.root.after(8, self._animate)
        else:
            self.running = False  # arrived: stay put until the next go() or hide()


def _start_cursor_thread():
    """The typing cursor is a tiny Tk window living in its own thread (the main thread runs the web window)."""
    q = queue.Queue()

    def run():
        root = tk.Tk()
        root.withdraw()
        overlay = CursorOverlay(root)

        def poll():
            while not q.empty():
                x, y, label = q.get()
                overlay.hide() if x is None else overlay.go(x, y, label)
            root.after(16, poll)
        poll()
        root.mainloop()

    threading.Thread(target=run, daemon=True, name="cursor").start()
    tools.on_action = lambda x, y, label: q.put((x, y, label))
    tools.cursor_glide = CursorOverlay.GLIDE + 0.1


class _Api:
    """Functions the page can call: pywebview.api.approve(id, ok), stop(), send_text(text), toggle_mute()."""
    def __init__(self, app):
        self.approve = app._answer
        self.stop = app._stop
        self.send_text = lambda text: app.on_text(str(text)[:2000])
        self.toggle_mute = lambda: app.on_toggle_mute()


class App:
    def __init__(self):
        self.events, self.pending, self.ids = queue.Queue(), {}, itertools.count(1)
        self.closed, self.ready = threading.Event(), threading.Event()
        self.on_text = lambda text: None      # chat.py connects these to voice.typed / voice.toggle_mute
        self.on_toggle_mute = lambda: None
        self.window = webview.create_window(
            config.ASSISTANT_NAME, url=str(HTML), js_api=_Api(self),
            width=1320, height=820, min_size=(1100, 700), background_color="#07070d")
        self.window.events.loaded += self.ready.set
        self.window.events.shown += self._set_icon
        self.window.events.closed += self.closed.set
        _start_cursor_thread()
        mode = ("ALWAYS LISTENING" if config.ALWAYS_LISTEN else f"SAY '{config.WAKE_PHRASE.upper()}'") \
            if config.WAKE_WORD_ENABLED else f"HOLD {config.HOTKEY.upper()}"
        self._send(t="config", theme=config.HUD_THEME, name=config.ASSISTANT_NAME, model=config.MODEL.split("/")[-1], mode=mode,
                   voice=Path(config.PIPER_VOICE).stem.split("-")[1].upper())

    def _set_icon(self):
        """Raphael's icon on the window and taskbar (instead of Python's)."""
        try:
            hwnd = int(str(self.window.native.Handle))
            u = ctypes.windll.user32
            u.LoadImageW.restype = ctypes.c_void_p
            u.SendMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
            for size, which in ((256, 1), (32, 0)):  # ICON_BIG, ICON_SMALL
                icon = u.LoadImageW(None, str(ICON), 1, size, size, 0x10)  # IMAGE_ICON, LR_LOADFROMFILE
                if icon:
                    u.SendMessageW(hwnd, 0x80, which, icon)  # WM_SETICON
        except Exception as e:
            print(f"(icon not set: {e})")

    # ---------- thread-safe API (same as the old Tk window) ----------
    def _send(self, **event):
        self.events.put(event)

    def set_state(self, state):
        self._send(t="state", v=state)

    def show(self, you=None, reply=None):
        if you:
            self._send(t="you", v=you)
        if reply:
            self._send(t="reply", v=reply)

    def note(self, text):
        self._send(t="note", v=text)

    def activity(self, icon, text):
        self._send(t="activity", icon=icon, text=text)

    def set_muted(self, is_muted):
        self._send(t="muted", v=bool(is_muted))

    def level(self, rms):
        self._send(t="level", v=rms)

    def speak_envelope(self, envelope, step):
        self._send(t="speech", env=[round(x, 4) for x in envelope], step=step)

    def close(self):
        self.closed.set()
        try:
            self.window.destroy()
        except Exception:
            pass

    def ask_approval(self, name, detail, danger):
        """Called from the assistant thread: shows Allow/Deny and blocks until you click (timeout or Stop = Deny)."""
        rid, answer = next(self.ids), queue.Queue()
        self.pending[rid] = answer
        self._send(t="approve", id=rid, name=name, detail=detail[:800], danger=danger, timeout=config.APPROVAL_TIMEOUT)
        waited, result = 0.0, None
        while waited < config.APPROVAL_TIMEOUT and not tools.cancel.is_set() and result is None:
            try:
                result = answer.get(timeout=0.3)
            except queue.Empty:
                waited += 0.3
        self.pending.pop(rid, None)
        if result is None:
            self._send(t="approve_close", id=rid)
        return result is True

    # ---------- called by the page ----------
    def _answer(self, rid, allowed):
        q = self.pending.get(int(rid))
        if q:
            q.put(bool(allowed))

    def _stop(self):
        tools.cancel.set()
        for q in list(self.pending.values()):
            q.put(False)
        self.activity("■", "Stopped by you.")

    # ---------- pump: Python -> page ----------
    def _pump(self):
        self.ready.wait()
        cpu_prev, gpu, next_sys = _cpu_times(), _gpu_name(), 0.0
        while not self.closed.is_set():
            batch, level = [], None
            while not self.events.empty():
                e = self.events.get()
                if e["t"] == "level":  # many mic readings per batch: keep the loudest
                    level = max(level or 0, e["v"])
                else:
                    batch.append(e)
            if level is not None:
                batch.append({"t": "level", "v": level})
            if time.time() >= next_sys:
                idle, total = _cpu_times()
                cpu = 100 * (1 - (idle - cpu_prev[0]) / max(1, total - cpu_prev[1]))
                cpu_prev, disk = (idle, total), shutil.disk_usage("C:\\")
                batch.append({"t": "sys", "cpu": cpu, "ram": _ram_percent(), "disk": 100 * disk.used / disk.total,
                              "gpu": gpu, "time": time.strftime("%H:%M"), "date": time.strftime("%a %d %b %Y")})
                next_sys = time.time() + 1
            if batch:
                try:
                    self.window.evaluate_js(f"hud.dispatch({json.dumps(batch)})")
                except Exception:  # window closing
                    break
            time.sleep(0.033)

    def mainloop(self):
        """Blocks until the window is closed (must run on the main thread)."""
        webview.start(self._pump)
        self.closed.set()


if __name__ == "__main__":  # demo with fake data so every panel shows something
    app = App()

    def demo():
        app.ready.wait()
        app.note("I'm listening. Just talk.")
        app.show("What time is it?", "Answer. It is 11:20 PM.")
        app.activity("▶", "get_time")
        app.activity("✓", "Sunday, 18 October 2026, 23:20")
        app.show("Play Nadarang by Shanti Dope", "Answer. Now playing Nadarang by Shanti Dope.")
        app.activity("▶", "play_music: Nadarang by Shanti Dope")
        app.activity("✓", "Opened 'Shanti Dope - Nadarang' in the browser")
        app.note("ignored: Thanks for watching!")
        app.activity("✗", "open_app chrome: not installed")
        for s in ["listening", "thinking", "speaking", "idle"] * 3:
            app.set_state(s)
            for k in range(25):
                if s == "listening":
                    app.level(abs(math.sin(k / 3)) * 0.12 * random.random())
                time.sleep(0.1)
            if s == "speaking":
                app.speak_envelope([abs(math.sin(i / 4)) * 0.15 for i in range(40)], 0.05)
        app.close()
    threading.Thread(target=demo, daemon=True).start()
    app.mainloop()
