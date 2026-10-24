"""Kumo's test suite (no packages needed).

    .\\.venv\\Scripts\\python.exe tests\\run_all.py          fast checks (no LM Studio, no mic, no speakers)
    .\\.venv\\Scripts\\python.exe tests\\run_all.py --live   also the conversation loop with the real model (LM Studio on)

Never writes to your real Obsidian vault: vault tests use a temporary copy.
"""
import ast
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
PY = sys.executable
results = []


def check(name, ok, info=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{info}]" if info else ""), flush=True)


def self_check(module):
    r = subprocess.run([PY, str(ROOT / module)], capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=ROOT)
    check(f"{module} self-check", r.returncode == 0 and "OK" in r.stdout, (r.stdout + r.stderr).strip().splitlines()[-1:])


def fast():
    for f in sorted(ROOT.glob("*.py")):
        try:
            ast.parse(f.read_text(encoding="utf-8"))
            check(f"syntax {f.name}", True)
        except SyntaxError as e:
            check(f"syntax {f.name}", False, str(e))
    for module in ("tools.py", "vault.py", "reminders.py"):
        self_check(module)

    import chat
    import voice
    m = voice.match_wake
    wake = {"Hey Kumo, what time is it?": "what time is it", "Here Kumo, play x": "play x", "Kumo.": "", "Como, pause": "pause",
            "What time is it?": None, "I told Kumo about it yesterday": None, "Hey Jarvis hello": None}
    check("wake phrase matcher", all(m(t) == e for t, e in wake.items()))
    tl = {"Alas sais na ng gabi.": True, "Oo.": True, "Sige po, salamat!": True, "It is six in the evening.": False,
          "Answer. Magandang gabi! Ano ang maitutulong ko?": True, "The file was saved in your inbox.": False}
    check("Tagalog reply detection", all(voice.is_tagalog(t) == e for t, e in tl.items()))
    md = {"Done: **\"Tawagan si Nanay\"** at 8 PM.": 'Done: "Tawagan si Nanay" at 8 PM.',
          "Open `notes_app.py` in [VSCodium](https://vscodium.com).": "Open notes_app.py in VSCodium.",
          "- *one*\n2. _two_": "one\ntwo", "Keep my_file_name.txt as is.": "Keep my_file_name.txt as is."}
    check("markdown stripped before speaking", all(voice.speakable(t) == e for t, e in md.items()),
          [voice.speakable(t) for t in md])
    h = voice._is_hallucination
    check("noise filter", all(map(h, ["Mm.", "Dog barks.", "[Music]", "Thanks for watching!"]))
          and not any(map(h, ["Pause the music", "Play Nadarang by Shanti Dope", "Okay, open notepad"])))
    t = chat.text_tool_call
    path = r"C:\Users\x\proj"
    check("tool call written as text", t("I will list.\nlist_files(folder='" + path + "')") == ("list_files", {"folder": path})
          and t("`read_clipboard()`") == ("read_clipboard", {}) and t('os.system("del x")') is None and t("print(1)") is None)
    check("promise nudge words", bool(chat.PROMISE.search("Please allow me to read it.")) and not chat.PROMISE.search("Shall I?"))
    check("two-brain triggers", bool(chat.BIG_BRAIN.search("think harder")) and bool(chat.FAST_BRAIN.search("back to fast mode"))
          and not chat.BIG_BRAIN.search("I think it's hard"))

    # Kanban: a move and back must leave the board byte-identical (on a copy of the real board)
    import config
    import vault
    board = Path(config.VAULT_DIR) / config.KANBAN_NOTE
    if board.exists():
        tmp = Path(tempfile.mkdtemp())
        real_dir = config.VAULT_DIR
        try:
            (tmp / Path(config.KANBAN_NOTE).parent).mkdir(parents=True)
            shutil.copy(board, tmp / config.KANBAN_NOTE)
            config.VAULT_DIR = str(tmp)
            copy = tmp / config.KANBAN_NOTE
            before = copy.read_bytes()
            lines = copy.read_text(encoding="utf-8").split("\n")
            # the LAST card of a column comes back to the same place (a move appends; other cards never reorder)
            src, card = next((name, lines[cards[-1][0]][6:60]) for name, h, e in vault._sections(lines)
                             if name.lower() != "done" and (cards := vault._cards(lines, h, e)))
            vault.kanban_move(card, "Doing" if src != "Doing" else "To Do")
            vault.kanban_move(card, src)
            check("kanban round trip byte-identical", copy.read_bytes() == before)
        finally:
            config.VAULT_DIR = real_dir
            shutil.rmtree(tmp, ignore_errors=True)


def live():
    import numpy as np
    import chat
    import config
    import tools
    import voice
    chat.save_session = lambda: None  # never write test sessions into the real vault
    v = voice._load_piper()

    def speech(text):
        a = np.concatenate([c.audio_int16_array for c in v.synthesize(text)]).astype("float32") / 32768
        n = int(len(a) * 16000 / v.config.sample_rate)
        return np.interp(np.linspace(0, len(a), n, endpoint=False), np.arange(len(a)), a).astype("float32")

    voice.preload()
    q = "What time is it right now?"
    out = voice.transcribe(np.concatenate([np.zeros(8000, "float32"), speech(q), np.zeros(8000, "float32")]))
    check("speech-to-text", out.lower().strip(" .?!") == q.lower().strip(" .?!"), repr(out))

    asked, launched = [], []
    tools.approver = lambda name, detail, danger: (asked.append(name), name == "write_file")[1]
    tools.FUNCS["open_app"] = lambda name: (launched.append(name), f"Opened {name} (test stub)")[1]
    spoken = []
    voice.speak_async, voice.wait_speaking = spoken.append, lambda: None
    test_file = ROOT / "regress_test.txt"
    turns = iter(["What time is it?", "How much RAM is free?",
                  f"Create a file called regress_test.txt in {ROOT} with the single word hello.", "Open Chrome.", "exit"])
    voice.listen = lambda: next(turns)
    import contextlib
    import io
    buf = io.StringIO()
    t = time.time()
    with contextlib.redirect_stdout(buf):
        chat.converse(True)
    log = buf.getvalue()
    check("loop: get_time", "[tool] get_time" in log)
    check("loop: system_info", "[tool] system_info" in log)
    check("loop: write_file after Allow", test_file.exists() and "write_file" in asked)
    check("loop: Chrome refused, no prompt", "open_app" not in asked and not launched)
    check("loop: replies spoken", len(spoken) >= 4, f"{len(spoken)} sentences, {time.time() - t:.0f}s")
    test_file.unlink(missing_ok=True)


if __name__ == "__main__":
    fast()
    if "--live" in sys.argv:
        live()
    print(f"\n{sum(results)}/{len(results)} checks passed")
    sys.exit(0 if all(results) else 1)
