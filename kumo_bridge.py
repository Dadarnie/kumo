"""Kumo mode: Raphael runs headless as a child of Kumo, which is the only window.

Same interface as ui.App, but every event is one JSON line on stdout and Kumo's
commands arrive as JSON lines on stdin. print() output goes to stderr (Kumo logs it),
so nothing else can corrupt the protocol.

Raphael -> Kumo (stdout):
  {"t":"ready"}                                    loaded, listening
  {"t":"state","v":"idle|listening|thinking|speaking"}
  {"t":"you","v":text}  {"t":"reply","v":text}  {"t":"note","v":text}
  {"t":"activity","icon":"▶|✓|✗|⏰","text":text}  one tool step
  {"t":"muted","v":bool}  {"t":"level","v":rms}
  {"t":"approve","id":n,"name":tool,"detail":text,"danger":bool,"timeout":s}
  {"t":"approve_close","id":n}                     timed out or stopped
  {"t":"notify","title":t,"v":text}                reminders
Kumo -> Raphael (stdin):
  {"t":"answer","id":n,"allow":bool}  {"t":"text","v":text}  {"t":"mute","v":bool}
  {"t":"stop"}  {"t":"quit"}   (stdin closing = Kumo is gone: quit)
"""
import itertools
import json
import queue
import sys
import threading
import time

import config
import tools


class KumoApp:
    owns_hotkeys = True  # Kumo handles mute and stop; Raphael registers no global keys

    def __init__(self, out=None, inp=None):
        self.out = out or sys.stdout
        self.inp = inp or sys.stdin
        if out is None:
            sys.stdout = sys.stderr  # stray prints must never land in the protocol
        self.lock = threading.Lock()
        self.ids = itertools.count(1)
        self.pending = {}
        self.closed = threading.Event()
        self.on_text = lambda text: None
        self.on_toggle_mute = lambda: None
        self.is_muted = lambda: False
        self._last_level = 0.0

    def _send(self, **event):
        line = json.dumps(event, ensure_ascii=True)
        with self.lock:
            try:
                self.out.write(line + "\n")
                self.out.flush()
            except (OSError, ValueError):  # Kumo closed the pipe
                self.closed.set()

    # ---------- same API as ui.App ----------
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
        now = time.monotonic()  # ~4 updates a second is plenty for the island
        if now - self._last_level >= 0.25:
            self._last_level = now
            self._send(t="level", v=round(float(rms), 4))

    def speak_envelope(self, envelope, step):
        pass  # Kumo animates speaking from the state alone

    def tray_notify(self, title, message):
        self._send(t="notify", title=title, v=message)
        return True  # Kumo shows it; no Windows toast

    def ask_approval(self, name, detail, danger):
        """Blocks the assistant thread until Kumo answers (timeout or Stop = Deny)."""
        rid, answer = next(self.ids), queue.Queue()
        self.pending[rid] = answer
        self._send(t="approve", id=rid, name=name, detail=detail[:800], danger=bool(danger),
                   timeout=config.APPROVAL_TIMEOUT)
        deadline, result = time.monotonic() + config.APPROVAL_TIMEOUT, None
        while result is None and time.monotonic() < deadline and not tools.cancel.is_set() and not self.closed.is_set():
            try:
                result = answer.get(timeout=0.3)
            except queue.Empty:
                pass
        self.pending.pop(rid, None)
        if result is None:
            self._send(t="approve_close", id=rid)
        return result is True

    def close(self):
        self.closed.set()

    def mainloop(self):
        """Reads Kumo's commands until stdin closes or Kumo says quit."""
        threading.Thread(target=self._read, daemon=True, name="kumo-stdin").start()
        self.closed.wait()

    # ---------- commands from Kumo ----------
    def _read(self):
        try:
            for line in self.inp:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if isinstance(msg, dict) and self.handle(msg) == "quit":
                    break
        finally:
            self.closed.set()

    def handle(self, msg):
        t = msg.get("t")
        if t == "answer":
            q = self.pending.get(msg.get("id"))
            if q:
                q.put(msg.get("allow") is True)
        elif t == "text" and isinstance(msg.get("v"), str) and msg["v"].strip():
            self.on_text(msg["v"].strip())
        elif t == "mute":
            if bool(msg.get("v")) != self.is_muted():
                self.on_toggle_mute()
        elif t == "stop":
            tools.cancel.set()
            for q in list(self.pending.values()):
                q.put(False)
        elif t == "quit":
            return "quit"
        return None


if __name__ == "__main__":  # self-check: no model, mic or Kumo needed
    import io

    out = io.StringIO()
    texts, toggles = [], []
    app = KumoApp(out=out, inp=io.StringIO(
        '{"t":"text","v":" hi "}\nnot json\n{"t":"mute","v":true}\n{"t":"mute","v":false}\n{"t":"quit"}\n'))
    app.on_text, app.on_toggle_mute = texts.append, lambda: toggles.append(1)
    app.set_state("thinking")
    app.show(you="hello", reply="Answer. Hi.")
    app._read()
    assert texts == ["hi"], texts
    assert toggles == [1], toggles  # mute true toggles once; false already matches (is_muted stays False here)
    assert app.closed.is_set()
    lines = [json.loads(x) for x in out.getvalue().splitlines()]
    assert lines == [{"t": "state", "v": "thinking"}, {"t": "you", "v": "hello"}, {"t": "reply", "v": "Answer. Hi."}], lines

    app2 = KumoApp(out=io.StringIO(), inp=io.StringIO())
    threading.Timer(0.1, lambda: app2.handle({"t": "answer", "id": 1, "allow": True})).start()
    assert app2.ask_approval("write_file", "x", False) is True
    threading.Timer(0.1, lambda: app2.handle({"t": "answer", "id": 2, "allow": False})).start()
    assert app2.ask_approval("write_file", "x", True) is False
    print("kumo_bridge OK", file=sys.stderr)
