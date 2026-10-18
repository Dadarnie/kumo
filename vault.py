"""Obsidian vault as Raphael's long-term memory. Follows the vault's SCHEMA.md / AGENTS.md:
never touches private/, logs every write in log.md, new captures go to inbox/ with frontmatter."""
import datetime
import re
from pathlib import Path

import config

MEMORY_HEADER = """---
title: Raphael Memory
created: {today}
updated: {today}
type: summary
area: projects
tags: [reference]
---

# Raphael Memory

Facts and lessons Raphael has learned from talking with you. Loaded into every Raphael session.
Edit or delete lines freely. Raphael's own file: not listed in index.md (like the Kanban board).

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
        raise PermissionError(f"'{rel}' is in a blocked folder ({', '.join(config.VAULT_BLOCKED)}); Raphael never opens it.")
    return p


def _notes():
    root = _root()
    for p in sorted(root.rglob("*.md")):
        if p.relative_to(root).parts[0].lower() not in config.VAULT_BLOCKED:
            yield p


def _log(action, subject, detail):
    """Append one entry to log.md in the vault's format: ## [YYYY-MM-DD] action | subject."""
    with open(_vault_path("log.md"), "a", encoding="utf-8") as f:
        f.write(f"\n## [{_today()}] {action} | {subject}\n- {detail}\n")


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
        f.write_text(MEMORY_HEADER.format(today=_today()), encoding="utf-8")
        _log("create", config.MEMORY_NOTE, "Raphael memory file created.")
    text = f.read_text(encoding="utf-8")
    if any(fact.lower() in l.lower() for l in _facts(text)):
        return f"Already remembered: {fact}"
    text = re.sub(r"^updated: .*$", f"updated: {_today()}", text, count=1, flags=re.M)
    text = text.rstrip("\n") + f"\n- {fact} ({_today()})\n"
    f.write_text(text, encoding="utf-8")
    _log("update", "Raphael memory", f"remembered: {fact}")
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
    f.write_text(re.sub(r"^updated: .*$", f"updated: {_today()}", text, count=1, flags=re.M), encoding="utf-8")
    _log("update", "Raphael memory", f"forgot: {line[2:]}")
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
    p.write_text(f"---\ntitle: {title.strip()}\ncreated: {_today()}\nupdated: {_today()}\nsource: raphael (voice capture)\n---\n\n"
                 f"# {title.strip()}\n\n{text.strip()}\n", encoding="utf-8")
    rel = p.relative_to(_root()).as_posix()
    _log("create", rel, "Captured by Raphael from voice; unfiled (inbox).")
    return f"Saved to {rel}."


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
        raise ValueError("Raphael never moves cards to Done (vault rule); the user moves them in Obsidian.")
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
    p.write_text("\n".join(lines), encoding="utf-8")
    return f"Moved to {dst}: {block[0][6:90]}"


def describe_kanban_add(text, column="To Do"):
    _, lines = _board()
    return f"Add card to {_column(lines, _target(column))[0]}:\n- [ ] {text.strip()}", False


def kanban_add(text, column="To Do"):
    p, lines = _board()
    dst = _column(lines, _target(column))[0]
    _insert(lines, dst, [f"- [ ] {' '.join(text.split())}"])
    p.write_text("\n".join(lines), encoding="utf-8")
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
    return ((f" What you remember about the user (from their Obsidian vault). These preferences override the style "
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
        (tmp / "private" / "secret.md").write_text("bank pin 1234 raphael", encoding="utf-8")
        (tmp / "concepts").mkdir()
        (tmp / "concepts" / "second-brain.md").write_text("---\ntitle: Second Brain\n---\nA file based knowledge base.\n", encoding="utf-8")
        (tmp / "index.md").write_text("# Wiki Index\n- [[second-brain]] — file based\n", encoding="utf-8")
        (tmp / "log.md").write_text("# Wiki Log\n", encoding="utf-8")

        assert "Remembered" in remember("Darnie's capstone is LPMS")
        assert "Already" in remember("darnie's capstone is lpms")
        assert "Remembered" in remember("Darnie prefers lo-fi music")
        mem = (tmp / "raphael" / "memory.md").read_text(encoding="utf-8")
        assert mem.startswith("---\ntitle: Raphael Memory") and mem.count("\n- ") == 2
        assert "capstone is LPMS" in memory_prompt() and "second-brain" in memory_prompt()
        assert "2 facts match" not in describe_forget("lo-fi")[0]
        try:
            describe_forget("Darnie")
            raise AssertionError("should be ambiguous")
        except ValueError as e:
            assert "2 facts match" in str(e)
        assert "Forgot" in forget("lo-fi") and "lo-fi" not in (tmp / "raphael" / "memory.md").read_text(encoding="utf-8")

        assert "second-brain.md" in vault_search("knowledge base")
        assert "secret" not in vault_search("raphael") and "1234" not in vault_search("bank pin")  # private/ never searched
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
        assert log.count("## [") == 6 and "| Raphael memory" in log and "| inbox/startup-idea.md" in log
        print("vault OK")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
