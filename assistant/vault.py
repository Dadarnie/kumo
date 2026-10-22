"""Obsidian vault as Kumo's long-term memory. Follows the vault's SCHEMA.md / AGENTS.md:
never touches private/, logs every write in log.md, new captures go to inbox/ with frontmatter."""
import datetime
import re
from pathlib import Path

import config

MEMORY_HEADER = """---
title: Kumo Memory
created: {today}
updated: {today}
type: summary
area: projects
tags: [reference]
---

# Kumo Memory

Facts and lessons Kumo has learned from talking with you. Loaded into every Kumo session.
Edit or delete lines freely. Kumo's own file: not listed in index.md (like the Kanban board).

## Facts
"""


def _root():
    return Path(config.VAULT_DIR).resolve()


def _today():
    return datetime.date.today().isoformat()


def _vault_path(rel):
    """A path inside the vault, refusing private/, .obsidian/ and .git/ (vault rule: never touch private/)."""
    root = _root()
    p = (root / rel).resolve()
    if not p.is_relative_to(root):
        raise PermissionError(f"'{rel}' is outside the Obsidian vault.")
    if p != root and p.relative_to(root).parts[0].lower() in config.VAULT_BLOCKED:
        raise PermissionError(f"'{rel}' is in a blocked folder ({', '.join(config.VAULT_BLOCKED)}); Kumo never opens it.")
    return p


def _notes():
    root = _root()
    for p in sorted(root.rglob("*.md")):
        if p.relative_to(root).parts[0].lower() not in config.VAULT_BLOCKED:
            yield p


def _write(p, text):
    """Write text keeping the file's existing line endings (Windows Python would otherwise turn LF into CRLF and
    make git see every line of the note as changed)."""
    crlf = p.exists() and b"\r\n" in p.read_bytes()
    p.write_bytes((text.replace("\r\n", "\n").replace("\n", "\r\n") if crlf else text.replace("\r\n", "\n")).encode("utf-8"))


def _append(p, text):
    """Append text after a line break (even if the file doesn't end with one), keeping line endings."""
    old = p.read_text(encoding="utf-8") if p.exists() else ""
    _write(p, old + ("" if not old or old.endswith("\n") else "\n") + text)


def _log(action, subject, detail):
    """Append one entry to log.md in the vault's format: ## [YYYY-MM-DD] action | subject."""
    _append(_vault_path("log.md"), f"\n## [{_today()}] {action} | {subject}\n- {detail}\n")


def _slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "note"


def _memory_file():
    return _vault_path(config.MEMORY_NOTE)


def _facts(text):
    return [l for l in text.splitlines() if l.startswith("- ")]


# ---------- tools ----------

def remember(fact):
    fact = " ".join(fact.split()).strip(" -")
    if not fact:
        return "Error: nothing to remember."
    f = _memory_file()
    if not f.exists():
        f.parent.mkdir(parents=True, exist_ok=True)
        _write(f, MEMORY_HEADER.format(today=_today()))
        _log("create", config.MEMORY_NOTE, "Kumo memory file created.")
    text = f.read_text(encoding="utf-8")
    if any(fact.lower() in l.lower() for l in _facts(text)):
        return f"Already remembered: {fact}"
    text = re.sub(r"^updated: .*$", f"updated: {_today()}", text, count=1, flags=re.M)
    text = text.rstrip("\n") + f"\n- {fact} ({_today()})\n"
    _write(f, text)
    _log("update", "Kumo memory", f"remembered: {fact}")
    size = sum(len(l) for l in _facts(text))
    warn = f" Memory is {size} characters (only the first {config.MEMORY_MAX_CHARS} load each session)." \
        if size > config.MEMORY_MAX_CHARS else ""
    return f"Remembered: {fact}.{warn}"


def _matching_facts(fact):
    f = _memory_file()
    if not f.exists():
        raise ValueError("there is no memory yet.")
    hits = [l for l in _facts(f.read_text(encoding="utf-8")) if fact.lower().strip() in l.lower()]
    if not hits:
        raise ValueError(f"no remembered fact contains '{fact}'.")
    if len(hits) > 1:
        raise ValueError(f"{len(hits)} facts match; be more specific: " + " | ".join(h[2:80] for h in hits[:5]))
    return f, hits[0]


def describe_forget(fact):
    f, line = _matching_facts(fact)
    return f"Remove from {config.MEMORY_NOTE}:\n{line}", False


def forget(fact):
    f, line = _matching_facts(fact)
    text = f.read_text(encoding="utf-8").replace(line + "\n", "", 1)
    _write(f, re.sub(r"^updated: .*$", f"updated: {_today()}", text, count=1, flags=re.M))
    _log("update", "Kumo memory", f"forgot: {line[2:]}")
    return f"Forgot: {line[2:]}"


def vault_search(query):
    """Lines in the vault containing all the query words (titles count too). Never private/."""
    words = [w for w in re.findall(r"\w+", query.lower()) if len(w) > 2] or [query.lower()]
    root, found = _root(), []
    for p in _notes():
        rel = p.relative_to(root).as_posix()
        for n, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            hay = (rel + " " + line).lower()
            if all(w in hay for w in words) and line.strip():
                found.append(f"{rel}:{n}: {line.strip()[:140]}")
                break  # first match per note keeps results short
        if len(found) >= 20:
            break
    return "\n".join(found) or f"Nothing in the vault matches '{query}'."


def vault_read(note):
    """A note by path ('concepts/second-brain.md'), slug ('second-brain') or title words."""
    root = _root()
    direct = _vault_path(note if note.endswith(".md") else note + ".md")
    p = direct if direct.exists() else next((n for n in _notes() if n.stem == _slug(note)), None) \
        or next((n for n in _notes() if _slug(note) in n.stem), None)
    if not p:
        return f"Error: no note matches '{note}'. Try vault_search first."
    text = p.read_text(encoding="utf-8", errors="replace")
    cut = text[: config.MAX_READ_BYTES]
    return f"{p.relative_to(root).as_posix()}:\n{cut}" + ("\n...[truncated]" if len(text) > len(cut) else "")


def capture_note(title, text):
    """Save an idea to inbox/ (the vault's staging folder) for the user or Hermes to file later."""
    inbox = _vault_path("inbox")
    inbox.mkdir(exist_ok=True)
    slug, n = _slug(title), 1
    while (inbox / f"{slug}{'' if n == 1 else f'-{n}'}.md").exists():
        n += 1
    p = inbox / f"{slug}{'' if n == 1 else f'-{n}'}.md"
    _write(p, f"---\ntitle: {title.strip()}\ncreated: {_today()}\nupdated: {_today()}\nsource: kumo (voice capture)\n---\n\n"
                 f"# {title.strip()}\n\n{text.strip()}\n")
    rel = p.relative_to(_root()).as_posix()
    _log("create", rel, "Captured by Kumo from voice; unfiled (inbox).")
    return f"Saved to {rel}."


def save_daily_note(bullets):
    """Append one session summary to kumo/daily/YYYY-MM-DD.md (Kumo's own folder, outside the wiki index)."""
    lines = [l.strip() for l in bullets.strip().splitlines() if l.strip()]
    if not lines:
        return None
    rel = f"{config.DAILY_DIR}/{_today()}.md"
    p = _vault_path(rel)
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        _write(p, f"---\ntitle: Kumo daily {_today()}\ncreated: {_today()}\nupdated: {_today()}\ntype: summary\n"
                     f"area: projects\ntags: [reference]\n---\n\n# Kumo sessions {_today()}\n")
    body = "\n".join(l if l.startswith("- ") else f"- {l.lstrip('-* ')}" for l in lines)
    _append(p, f"\n## {datetime.datetime.now():%H:%M} session\n{body}\n")
    _log("update", rel, "Kumo session summary added.")
    return rel


def save_news_digest(sections):
    """Write today's headlines to kumo/news/YYYY-MM-DD.md (Kumo's own folder, rebuilt on each refresh).
    sections: [(heading, [(title, link, source)])]. Logged in log.md once, when the day's note is created."""
    sections = [(h, items) for h, items in sections if items]
    if not sections:
        return None
    rel = f"{config.NEWS_DIR}/{_today()}.md"
    p = _vault_path(rel)
    created = not p.exists()
    p.parent.mkdir(parents=True, exist_ok=True)
    clean = lambda s: s.replace("[", "(").replace("]", ")").replace("\n", " ")
    body = "\n\n".join(f"## {h}\n" + "\n".join(f"- [{clean(t)}]({link}) · {src}" for t, link, src in items)
                       for h, items in sections)
    _write(p, f"---\ntitle: News {_today()}\ncreated: {_today()}\nupdated: {_today()}\ntype: summary\n"
              f"area: projects\ntags: [reference]\n---\n\n# News {_today()}\n\n"
              f"Headlines Kumo collected today (updated {datetime.datetime.now():%H:%M}).\n\n{body}\n")
    if created:
        _log("create", rel, "Kumo's daily news digest.")
    return rel


def last_session_summary():
    """The most recent session summary (for continuity next time), or ''."""
    try:
        files = sorted(_vault_path(config.DAILY_DIR).glob("*.md"))
    except (OSError, PermissionError):
        return ""
    if not files:
        return ""
    text = files[-1].read_text(encoding="utf-8")
    last = text.rsplit("\n## ", 1)[-1] if "\n## " in text else ""
    return f"{files[-1].stem} {last}".strip()[:600]


# ---------- capstone Kanban board (Obsidian Kanban plugin format; rules from the vault's AGENTS.md) ----------
# Only whole card blocks move; other cards, their order and the %% kanban:settings %% block are never touched;
# nothing moves to Done (the user does that); card moves are not logged in log.md.

def _board():
    p = _vault_path(config.KANBAN_NOTE)
    if not p.exists():
        raise ValueError(f"no Kanban board at {config.KANBAN_NOTE}.")
    return p, p.read_text(encoding="utf-8").split("\n")


def _sections(lines):
    """[(name, header_index, end_index)]; the settings block ends the last section."""
    heads = [i for i, l in enumerate(lines) if l.startswith("## ")]
    stop = next((i for i, l in enumerate(lines) if l.startswith("%% kanban:settings")), len(lines))
    return [(lines[h][3:].strip(), h, nxt) for h, nxt in zip(heads, heads[1:] + [stop])]


def _cards(lines, start, end):
    """Card blocks in a section: (first_line, end_exclusive) = the '- [ ]' line plus its indented note lines."""
    blocks, i = [], start + 1
    while i < end:
        if lines[i].startswith("- ["):
            j = i + 1
            while j < end and lines[j][:1] in ("\t", " ") and lines[j].strip():
                j += 1
            blocks.append((i, j))
            i = j
        else:
            i += 1
    return blocks


def _column(lines, name):
    want = re.sub(r"[^a-z]", "", name.lower())
    for sec in _sections(lines):
        if re.sub(r"[^a-z]", "", sec[0].lower()) == want:
            return sec
    raise ValueError(f"no column '{name}'. Columns: {', '.join(s[0] for s in _sections(lines))}.")


def _insert(lines, column, block):
    """Put a card block at the end of a column, in the board's spacing (blank line between cards)."""
    _, head, end = _column(lines, column)
    cards = _cards(lines, head, end)
    at = cards[-1][1] if cards else head + 1
    lines[at:at] = ["", *block]


def _find_card(lines, card):
    words = [w for w in re.findall(r"\w+", card.lower()) if len(w) > 2] or [card.lower()]
    every = [(sec[0], b) for sec in _sections(lines) for b in _cards(lines, sec[1], sec[2])]
    norm = lambda s: " ".join(re.findall(r"\w+", s.lower()))
    hits = [h for h in every if norm(card) in norm(lines[h[1][0]])] \
        or [h for h in every if all(w in lines[h[1][0]].lower() for w in words)]  # exact phrase first, then all words
    if not hits:
        raise ValueError(f"no card matches '{card}'.")
    if len(hits) > 1:
        raise ValueError(f"{len(hits)} cards match; use more words: " + " | ".join(lines[b[0]][6:70] for _, b in hits[:4]))
    return hits[0]


def kanban_list():
    _, lines = _board()
    out = []
    for name, head, end in _sections(lines):
        cards = _cards(lines, head, end)
        out.append(f"{name} ({len(cards)}):" + "".join(f"\n  - {lines[a][6:110]}" for a, _ in cards[:5])
                   + ("\n  ..." if len(cards) > 5 else ""))
    return "\n".join(out)


def _target(column):
    if re.sub(r"[^a-z]", "", column.lower()) == "done":
        raise ValueError("Kumo never moves cards to Done (vault rule); the user moves them in Obsidian.")
    return column


def describe_kanban_move(card, column, note=""):
    _, lines = _board()
    src, (a, _) = _find_card(lines, card)
    dst = _column(lines, _target(column))[0]
    return f"Move card {src} -> {dst}:\n{lines[a][6:300]}" + (f"\nNote: {note}" if note else ""), False


def kanban_move(card, column, note=""):
    p, lines = _board()
    src, (a, b) = _find_card(lines, card)
    dst = _column(lines, _target(column))[0]
    block = lines[a:b] + ([f"\t- {'Blocked: ' if dst.lower() == 'blocked' else ''}{note.strip()}"] if note.strip() else [])
    gap = 1 if a > 0 and lines[a - 1] == "" else 0  # take the blank line before the card with it
    del lines[a - gap:b]
    _insert(lines, dst, block)
    _write(p, "\n".join(lines))
    return f"Moved to {dst}: {block[0][6:90]}"


def describe_kanban_add(text, column="To Do"):
    _, lines = _board()
    return f"Add card to {_column(lines, _target(column))[0]}:\n- [ ] {text.strip()}", False


def kanban_add(text, column="To Do"):
    p, lines = _board()
    dst = _column(lines, _target(column))[0]
    _insert(lines, dst, [f"- [ ] {' '.join(text.split())}"])
    _write(p, "\n".join(lines))
    return f"Added to {dst}: {text.strip()[:90]}"


def memory_prompt():
    """Injected into the system prompt each session: remembered facts + what topics the vault covers."""
    try:
        f = _memory_file()
        facts = "\n".join(_facts(f.read_text(encoding="utf-8")))[: config.MEMORY_MAX_CHARS] if f.exists() else ""
        index = _vault_path("index.md")
        topics = [m.group(1) for m in re.finditer(r"^- \[\[([^\]]+)\]\]", index.read_text(encoding="utf-8"), re.M)] \
            if index.exists() else []
    except OSError:
        return ""
    last = last_session_summary()
    recap = (f" Last session ({last.splitlines()[0]}):\n" + "\n".join(last.splitlines()[1:]) + "\n") if last else ""
    return (recap + " Older session summaries are in kumo/daily/YYYY-MM-DD.md (use vault_read)."
            + (f" What you remember about the user (from their Obsidian vault). These preferences override the style "
             f"rules above:\n{facts}\n" if facts else
             " You have no remembered facts yet. ")
            + (f" Topics in the user's Obsidian vault (use vault_search/vault_read): {', '.join(topics)}." if topics else ""))


if __name__ == "__main__":  # self-check on a throwaway fake vault, never the real one
    import shutil
    import tempfile
    tmp = Path(tempfile.mkdtemp())
    try:
        config.VAULT_DIR = str(tmp)
        (tmp / "private").mkdir()
        (tmp / "private" / "secret.md").write_text("bank pin 1234 kumo", encoding="utf-8")
        (tmp / "concepts").mkdir()
        (tmp / "concepts" / "second-brain.md").write_text("---\ntitle: Second Brain\n---\nA file based knowledge base.\n", encoding="utf-8")
        (tmp / "index.md").write_text("# Wiki Index\n- [[second-brain]] — file based\n", encoding="utf-8")
        (tmp / "log.md").write_text("# Wiki Log\n", encoding="utf-8")

        assert "Remembered" in remember("Darnie's capstone is LPMS")
        assert "Already" in remember("darnie's capstone is lpms")
        assert "Remembered" in remember("Darnie prefers lo-fi music")
        mem = (tmp / "kumo" / "memory.md").read_text(encoding="utf-8")
        assert mem.startswith("---\ntitle: Kumo Memory") and mem.count("\n- ") == 2
        assert "capstone is LPMS" in memory_prompt() and "second-brain" in memory_prompt()
        assert "2 facts match" not in describe_forget("lo-fi")[0]
        try:
            describe_forget("Darnie")
            raise AssertionError("should be ambiguous")
        except ValueError as e:
            assert "2 facts match" in str(e)
        assert "Forgot" in forget("lo-fi") and "lo-fi" not in (tmp / "kumo" / "memory.md").read_text(encoding="utf-8")

        assert "second-brain.md" in vault_search("knowledge base")
        assert "secret" not in vault_search("kumo") and "1234" not in vault_search("bank pin")  # private/ never searched
        assert "file based knowledge" in vault_read("second-brain") and "file based" in vault_read("Second Brain")
        for bad in ("private/secret", "private/secret.md", "../outside", ".git/config"):
            try:
                vault_read(bad)
                raise AssertionError(f"read {bad}")
            except PermissionError:
                pass

        assert "inbox/startup-idea.md" in capture_note("Startup idea!", "An app that ...")
        assert "inbox/startup-idea-2.md" in capture_note("Startup idea", "Another")
        assert "title: Startup idea!" in (tmp / "inbox" / "startup-idea.md").read_text(encoding="utf-8")
        log = (tmp / "log.md").read_text(encoding="utf-8")
        assert log.count("## [") == 6 and "| Kumo memory" in log and "| inbox/startup-idea.md" in log
        # line endings: LF files stay LF, CRLF files stay CRLF; a log without a final newline still gets a clean entry
        (tmp / "log.md").write_bytes(b"# Wiki Log\n\nlast line without newline")
        _log("update", "x", "y")
        assert (tmp / "log.md").read_bytes() == b"# Wiki Log\n\nlast line without newline\n\n## [" + _today().encode() + b"] update | x\n- y\n"
        crlf = tmp / "crlf.md"
        crlf.write_bytes(b"a\r\nb\r\n")
        _append(crlf, "c\n")
        assert crlf.read_bytes() == b"a\r\nb\r\nc\r\n"
        assert save_daily_note("") is None
        rel = save_daily_note("- Asked about LPMS\n* set a reminder")
        rel2 = save_daily_note("- Second session")
        daily = (tmp / rel).read_text(encoding="utf-8")
        assert rel == rel2 and daily.startswith("---\ntitle: Kumo daily") and daily.count("\n## ") == 2, daily
        assert "- set a reminder" in daily and "Second session" in last_session_summary()
        assert "Last session" in memory_prompt() and "capstone is LPMS" in memory_prompt()

        assert save_news_digest([("AI", []), ("Free", [])]) is None  # nothing to write
        rel = save_news_digest([("Free", [("Add X [beta] free tier", "https://x.dev", "free-for.dev")]), ("AI", [])])
        note = (tmp / rel).read_text(encoding="utf-8")
        assert "## Free\n- [Add X (beta) free tier](https://x.dev) · free-for.dev" in note and "## AI" not in note
        save_news_digest([("Coding", [("Y", "https://y.dev", "HN")])])  # rebuilt, not appended; logged once
        assert "## Coding" in (tmp / rel).read_text(encoding="utf-8") and "## Free" not in (tmp / rel).read_text(encoding="utf-8")
        assert (tmp / "log.md").read_text(encoding="utf-8").count("news digest") == 1
        print("vault OK")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
