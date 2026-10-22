"""Reminders and timers. Saved in data/reminders.json, so they survive restarts (missed ones fire at startup)."""
import datetime
import json
import subprocess
import threading
import time
from pathlib import Path

import config

FILE = Path(__file__).parent / "data" / "reminders.json"
_lock = threading.Lock()
on_fire = lambda text, late: print(f"[reminder] {text}")  # chat.py replaces this (speak + HUD + notification)


def _load():
    try:
        return json.loads(FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def _save(items):
    FILE.parent.mkdir(exist_ok=True)
    FILE.write_text(json.dumps(items, indent=1), encoding="utf-8")


def _parse_at(at, now):
    """'15:30', '3:30 pm', '9am', 'tomorrow 9:00', '2026-10-20 09:00' -> datetime (next occurrence for clock times)."""
    s, day = at.strip().lower(), None
    if s.startswith("tomorrow"):
        s, day = s[len("tomorrow"):].strip(), now.date() + datetime.timedelta(days=1)
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %I:%M %p", "%Y-%m-%d %I%p"):
        try:
            return datetime.datetime.strptime(s, fmt)
        except ValueError:
            pass
    for fmt in ("%H:%M", "%I:%M %p", "%I:%M%p", "%I %p", "%I%p"):
        try:
            t = datetime.datetime.strptime(s, fmt).time()
        except ValueError:
            continue
        when = datetime.datetime.combine(day or now.date(), t)
        return when if day or when > now else when + datetime.timedelta(days=1)
    raise ValueError(f"can't read the time '{at}'. Use minutes, or a time like 15:30, 3:30 pm, tomorrow 9:00.")


def _when(in_minutes, at):
    now = datetime.datetime.now()
    if str(in_minutes).strip():
        mins = float(in_minutes)
        if not 0 < mins <= 60 * 24 * 30:
            raise ValueError("minutes must be between 0 and 43200 (30 days).")
        return now + datetime.timedelta(minutes=mins)
    if str(at).strip():
        return _parse_at(str(at), now)
    raise ValueError("give in_minutes or at.")


def _fmt(ts):
    when = datetime.datetime.fromtimestamp(ts)
    day = "today" if when.date() == datetime.date.today() else when.strftime("%a %d %b")
    return f"{day} {when.strftime('%H:%M')}"


# ---------- tools ----------

def set_reminder(text, in_minutes="", at=""):
    when = _when(in_minutes, at)
    with _lock:
        items = _load()
        items.append({"text": " ".join(text.split()) or "Timer", "due": when.timestamp(), "created": time.time()})
        _save(sorted(items, key=lambda r: r["due"]))
    return f"Reminder set for {_fmt(when.timestamp())}: {text}"


def list_reminders():
    items = _load()
    return "\n".join(f"- {_fmt(r['due'])}: {r['text']}" for r in items) or "No reminders."


def cancel_reminder(text):
    with _lock:
        items = _load()
        hits = [r for r in items if text.lower().strip() in r["text"].lower()]
        if not hits:
            return f"Error: no reminder contains '{text}'."
        if len(hits) > 1:
            return f"Error: {len(hits)} reminders match; be more specific: " + " | ".join(r["text"] for r in hits[:5])
        items.remove(hits[0])
        _save(items)
    return f"Cancelled: {hits[0]['text']} ({_fmt(hits[0]['due'])})"


# ---------- firing ----------

def notify(title, message):
    """Windows toast notification via PowerShell (no packages). Fails silently if Windows blocks it."""
    esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("'", "''")
    ps = ("[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;"
          "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;"
          "$d = New-Object Windows.Data.Xml.Dom.XmlDocument;"
          f"$d.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text>{esc(title)}</text><text>{esc(message)}</text>"
          "</binding></visual></toast>');"
          "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("
          "'{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe')"
          ".Show([Windows.UI.Notifications.ToastNotification]::new($d))")
    subprocess.Popen(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x08000000)  # CREATE_NO_WINDOW


def _due():
    """Remove and return reminders that are due now."""
    with _lock:
        items, now = _load(), time.time()
        due = [r for r in items if r["due"] <= now]
        if due:
            _save([r for r in items if r["due"] > now])
    return due


def start():
    """Background checker: fires due reminders every second; ones missed while Kumo was off fire at once (late)."""
    def run():
        started = time.time()
        while True:
            for r in _due():
                on_fire(r["text"], late=r["due"] < started - 60)
            time.sleep(1)
    threading.Thread(target=run, daemon=True, name="reminders").start()


if __name__ == "__main__":  # self-check on a temporary file
    import tempfile
    FILE = Path(tempfile.mkdtemp()) / "reminders.json"
    now = datetime.datetime(2026, 10, 19, 14, 0)
    assert _parse_at("15:30", now) == datetime.datetime(2026, 10, 19, 15, 30)
    assert _parse_at("9am", now) == datetime.datetime(2026, 10, 20, 9, 0)            # already past today -> tomorrow
    assert _parse_at("3:30 pm", now) == datetime.datetime(2026, 10, 19, 15, 30)
    assert _parse_at("tomorrow 9:00", now) == datetime.datetime(2026, 10, 20, 9, 0)
    assert _parse_at("2026-12-05 08:00", now) == datetime.datetime(2026, 12, 5, 8, 0)
    for bad in ("soonish", "25:99"):
        try:
            _parse_at(bad, now)
            raise AssertionError(bad)
        except ValueError:
            pass
    assert "Reminder set" in set_reminder("drink water", in_minutes="0.02")   # ~1 s
    assert "Reminder set" in set_reminder("stand up", at="23:59")
    assert "drink water" in list_reminders() and "stand up" in list_reminders()
    fired = []
    on_fire = lambda text, late: fired.append((text, late))
    start()
    time.sleep(3)
    assert fired == [("drink water", False)], fired
    assert "Cancelled" in cancel_reminder("stand up") and list_reminders() == "No reminders."
    assert "Error" in cancel_reminder("nothing here")
    print("reminders OK")
