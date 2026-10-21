"""News reader: RSS/Atom feeds and a few JSON APIs -> categorized headlines in data/news.json.

Only titles, links and a short summary are kept (no article scraping). Categories come from the
source plus keyword tags (coding, ai, free, security, release). Sources live in config.NEWS_SOURCES.
"""
import hashlib
import html
import json
import re
import threading
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from datetime import datetime
from pathlib import Path

import config

FILE = Path(__file__).parent / "data" / "news.json"
USER_AGENT = "Raphael-news/1.0 (personal feed reader)"
MAX_BYTES = 2_000_000
KEEP_DAYS = 14
MAX_ITEMS = 600
CATEGORIES = ("coding", "ai", "free", "security", "release")
_lock = threading.Lock()
on_new = lambda items: None  # chat.py (Kumo mode) replaces this to push new headlines to Kumo

TAGS = {
    "free": re.compile(r"\bfree[- ](tier|plan|credits?|courses?|books?|certifications?|api|hosting|trial|for students)\b"
                       r"|\bfor free\b|\bnow free\b|\bfull course\b|\bfree and open\b|\bopen[- ]source\b|\bstudent (pack|developer)", re.I),
    "ai": re.compile(r"\b(ai|llms?|gpt[\w.-]*|claude|gemini|llama|mistral|qwen|gemma|openai|anthropic|hugging ?face"
                     r"|diffusion|agents?|agentic|transformers?|fine-?tun\w*|inference|rag)\b", re.I),
    "security": re.compile(r"\b(cve-\d+|vulnerabilit\w*|exploit\w*|breach\w*|malware|ransomware|zero-day|0-day"
                           r"|phishing|backdoor|patch tuesday|supply[- ]chain attack)\b", re.I),
    "release": re.compile(r"\b(released?|launch(es|ed)?|now available|announc\w+|v\d+\.\d+(\.\d+)?|general availability)\b", re.I),
}


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, "
                                                                                    "application/xml, application/json, */*"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read(MAX_BYTES + 1)[:MAX_BYTES]


def _text(s, limit=220):
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= limit else s[: limit - 1].rsplit(" ", 1)[0] + "…"


def _when(s):
    if not s:
        return None
    try:
        return parsedate_to_datetime(s).timestamp()  # RSS: 'Wed, 21 Oct 2026 10:00:00 GMT'
    except (TypeError, ValueError):
        pass
    try:
        return datetime.fromisoformat(s.strip().replace("Z", "+00:00")).timestamp()  # Atom: ISO 8601
    except ValueError:
        return None


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _child(el, name):
    return next((c for c in el if _local(c.tag) == name), None)


def parse(data):
    """Feed bytes -> [{title, link, summary, published}]: RSS 2.0, Atom, or Hacker News (Algolia) JSON."""
    head = data.lstrip()[:1]
    if head in (b"{", b"["):
        hits = json.loads(data).get("hits", [])
        return [{"title": h.get("title") or "", "summary": "",
                 "link": h.get("url") or f"https://news.ycombinator.com/item?id={h.get('objectID')}",
                 "published": h.get("created_at_i")} for h in hits]
    root = ET.fromstring(data)
    out = []
    for el in root.iter():
        kind = _local(el.tag)
        if kind == "item":  # RSS
            get = lambda n: (_child(el, n).text if _child(el, n) is not None else "") or ""
            out.append({"title": get("title"), "link": get("link").strip(), "summary": get("description"),
                        "published": _when(get("pubDate") or get("date"))})
        elif kind == "entry":  # Atom
            links = [c for c in el if _local(c.tag) == "link"]
            link = next((c.get("href") for c in links if c.get("rel") in (None, "alternate")), None) or \
                (links[0].get("href") if links else "")
            get = lambda n: (_child(el, n).text if _child(el, n) is not None else "") or ""
            out.append({"title": get("title"), "link": link or "", "summary": get("summary") or get("content"),
                        "published": _when(get("published") or get("updated"))})
    return out


def categorize(title, base):
    """Base category from the source, plus keyword tags from the title (summaries are too noisy)."""
    return [base] + [c for c, rx in TAGS.items() if c != base and rx.search(title)]


MERGE = re.compile(r"^Merge pull request #\d+ from \S+\s*", re.I)
CHORE = re.compile(r"^(update|edit|fix|patch)\b.{0,12}\breadme(\.md)?$|^update [\w.-]+\.md$", re.I)


def _headline(title, summary):
    """GitHub commit feeds title merges 'Merge pull request #N from x/y'; the PR title is in the body.
    Returns (title, summary), or None for chores that say nothing ('Update README.md')."""
    if MERGE.match(title):
        title, summary = MERGE.sub("", summary).strip(), ""
    title = re.sub(r"^(feat|fix|docs|chore)(\([^)]*\))?!?:\s*", "", title, flags=re.I)  # 'feat: add X' -> 'add X'
    title = title[:1].upper() + title[1:]
    if not title or CHORE.match(title):
        return None
    return title, summary


def _load():
    try:
        return json.loads(FILE.read_text(encoding="utf-8")).get("items", [])
    except (OSError, ValueError):
        return []


def _save(items):
    FILE.parent.mkdir(exist_ok=True)
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"items": items}, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(FILE)


def refresh(sources=None, fetch=_get, pause=2.0):
    """Fetch every source once. Returns only the new items (also saved). A failing source is skipped."""
    sources = config.NEWS_SOURCES if sources is None else sources
    now, fresh, errors = time.time(), [], []
    for i, (name, url, base) in enumerate(sources):
        if i and pause:
            time.sleep(pause)  # be polite; Reddit answers 429 to quick bursts
        try:
            entries = parse(fetch(url))
        except (urllib.error.URLError, OSError, ValueError, ET.ParseError) as e:
            errors.append(f"{name}: {e}")
            continue
        for e in entries[:40]:
            link = (e["link"] or "").strip()
            headline = _headline(_text(e["title"], 200), _text(e["summary"]))
            if not headline or not link.startswith(("http://", "https://")):
                continue
            title, summary = headline
            fresh.append({"id": hashlib.sha1(link.encode()).hexdigest()[:16], "title": title, "link": link,
                          "summary": summary, "source": name, "categories": categorize(title, base),
                          "published": e["published"] or now, "seen": now})
    with _lock:
        items = _load()
        known = {i["id"] for i in items}
        seen_titles = {(i["source"], i["title"].lower()) for i in items}
        new = []
        for f in {f["id"]: f for f in fresh}.values():  # one per link, and one per title within a source
            key = (f["source"], f["title"].lower())
            if f["id"] not in known and key not in seen_titles:
                seen_titles.add(key)
                new.append(f)
        cutoff = now - KEEP_DAYS * 86400
        items = sorted([i for i in items + new if i["seen"] >= cutoff], key=lambda i: i["published"], reverse=True)
        _save(items[:MAX_ITEMS])
    for err in errors:
        print(f"(news: skipped {err})")
    return new


def latest(category="", limit=20):
    with _lock:
        items = _load()
    if category:
        items = [i for i in items if category in i["categories"]]
    return items[:limit]


def _age(ts):
    mins = max(0, int((time.time() - ts) / 60))
    return f"{mins} min ago" if mins < 60 else f"{mins // 60} h ago" if mins < 1440 else f"{mins // 1440} d ago"


def news_list(category="", limit="6"):
    """Tool: newest headlines, optionally one category (coding, ai, free, security, release)."""
    category = (category or "").strip().lower()
    if category and category not in CATEGORIES:
        return f"Error: unknown category '{category}'. Use one of: {', '.join(CATEGORIES)}."
    try:
        n = max(1, min(15, int(limit or 6)))
    except ValueError:
        n = 6
    items = latest(category, n)
    if not items:
        return "No headlines saved yet." if not category else f"No {category} headlines saved yet."
    return "\n".join(f"- {i['title']} ({i['source']}, {_age(i['published'])})" for i in items)


DIGEST = (("Free", "free"), ("AI", "ai"), ("Coding", "coding"), ("Security", "security"))


def digest(per_section=6):
    """Today's note: the newest headlines of the last day per section; each headline appears once."""
    import vault
    since, used, sections = time.time() - 86400, set(), []
    with _lock:
        items = [i for i in _load() if i["seen"] >= since or i["published"] >= since]
    for heading, cat in DIGEST:
        picked = [i for i in items if cat in i["categories"] and i["id"] not in used][:per_section]
        used.update(i["id"] for i in picked)
        sections.append((heading, [(i["title"], i["link"], i["source"]) for i in picked]))
    return vault.save_news_digest(sections)


_wake = threading.Event()


def refresh_now():
    """Ask the background refresher to run now (Kumo's Refresh button)."""
    _wake.set()


def start():
    """Background refresher: first run a minute after start (sooner if asked), then every NEWS_INTERVAL_HOURS.
    on_new(new_items) is called after every run, also with [], so Kumo knows a refresh finished."""
    def run():
        _wake.wait(60)
        while True:
            _wake.clear()
            new = []
            try:
                new = refresh()
                if config.NEWS_DIGEST:
                    digest()
            except Exception as e:  # never let the reader kill Raphael
                print(f"(news refresh failed: {e})")
            on_new(new)
            _wake.wait(max(0.5, config.NEWS_INTERVAL_HOURS) * 3600)
    threading.Thread(target=run, daemon=True, name="news").start()


if __name__ == "__main__":  # self-check with sample feeds, never touches data/news.json
    import tempfile
    FILE = Path(tempfile.mkdtemp()) / "news.json"
    rss = b"""<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Free tier for Postgres hosting launches</title><link>https://ex.com/a</link>
        <description>&lt;p&gt;A &lt;b&gt;free tier&lt;/b&gt; now.&lt;/p&gt;</description><pubDate>Wed, 21 Oct 2026 10:00:00 GMT</pubDate></item>
      <item><title>Critical CVE-2026-1234 in libfoo</title><link>https://ex.com/b</link></item>
      <item><title>No link</title></item></channel></rss>"""
    atom = b"""<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>Fine-tuning Gemma on a laptop</title><link rel="alternate" href="https://ex.com/c"/>
        <updated>2026-10-21T09:00:00Z</updated><summary>LLM notes</summary></entry></feed>"""
    hn = b'{"hits":[{"title":"Show HN: a tiny editor","url":null,"objectID":"42","created_at_i":1793000000}]}'
    feeds = {"r": rss, "a": atom, "h": hn}
    src = [("RSS", "r", "coding"), ("Atom", "a", "ai"), ("HN", "h", "coding"), ("Broken", "x", "coding")]
    fetch = lambda u: feeds[u] if u in feeds else (_ for _ in ()).throw(urllib.error.URLError("down"))
    new = refresh(src, fetch, pause=0)
    titles = {i["title"]: i for i in new}
    assert len(new) == 4, new  # the item without a link is dropped, the broken source is skipped
    assert titles["Free tier for Postgres hosting launches"]["categories"] == ["coding", "free", "release"]
    assert titles["Free tier for Postgres hosting launches"]["summary"] == "A free tier now."
    assert titles["Critical CVE-2026-1234 in libfoo"]["categories"] == ["coding", "security"]
    assert titles["Fine-tuning Gemma on a laptop"]["categories"] == ["ai"]
    assert titles["Show HN: a tiny editor"]["link"] == "https://news.ycombinator.com/item?id=42"
    assert refresh(src, fetch, pause=0) == []  # nothing new the second time
    assert "Free tier" in news_list("free") and news_list("weather").startswith("Error")
    assert len(latest()) == 4 and latest("security")[0]["link"] == "https://ex.com/b"
    assert _headline("Merge pull request #7 from a/b", "Merge pull request #7 from a/b feat: add X free tier") == \
        ("Add X free tier", "")
    assert _headline("Merge pull request #8 from a/patch-1", "Merge pull request #8 from a/patch-1 Update README.md") is None
    assert categorize("Hey DEV Community", "coding") == ["coding"]  # the summary no longer adds tags
    print("news OK")
