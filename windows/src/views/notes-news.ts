// SPDX-License-Identifier: MIT
// Notes and News tabs. Notes are saved one per file in the vault's inbox/ (the same place
// as the assistant's "note this"); News lists the assistant's headlines (assistant/news.py).
import { h } from "./dom";
import { ICONS, icon } from "./icons";
import { Bridge, onEvent, type NewsItem, type ObsidianVault, type VaultNote } from "../core/bridge";
import { State } from "../core/state";
import { PANEL_H } from "../core/layout";
import type { ViewHost } from "./views";

const NEWS_KEY = "kumo.tools.news";
const NEWS_ROWS = 15;
const NEWS_CATEGORIES = [["", "All"], ["coding", "Coding"], ["ai", "AI"], ["free", "Free"], ["security", "Security"]] as const;

function age(seconds: number): string {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - seconds) / 60));
  return mins < 60 ? `${mins} min` : mins < 1440 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} d`;
}

const errorText = (error: unknown) => String(error).replace(/^Error:\s*/, "");

/** A small phone button beside a row; the island shows how the send goes. */
function sendButton(label: string, send: () => Promise<unknown>): HTMLElement {
  return h("button", { class: "row-send", type: "button", title: label, "aria-label": label,
    onclick: () => void send().catch(() => {}) }, icon(ICONS.phone, 14));
}

/** A page that grows with its content, like the Tools tab. */
function page(className: string, base: number, body: HTMLElement[], onVisible: (visible: boolean) => void,
  destroy: () => void): ViewHost & { measure(): void } {
  let height = base;
  let shown = false;
  const el = h("div", { class: `view overview module-layout ${className}` }, ...body);
  const measure = () => {
    const next = Math.min(PANEL_H, Math.max(base, 52 + el.scrollHeight));
    if (next !== height) { height = next; State.notify(); }
  };
  return {
    el, measure,
    sync: measure,
    layout: () => ({ height, botX: 27, botY: 24, botDiameter: 18, agentMode: "none" }),
    // The island reports visibility on every sync; only a change may reload the list, or its
    // rows are rebuilt between mouse down and up and a click never lands.
    setVisible: visible => { if (visible !== shown) { shown = visible; onVisible(visible); } },
    destroy,
  };
}

export function buildNotesPage(): ViewHost {
  let vault: ObsidianVault | null = null;
  let notes: VaultNote[] = [];
  const input = h("textarea", { class: "notes-input", rows: "3", maxlength: "4000",
    placeholder: "Write a note… Enter saves, Shift+Enter adds a line", "aria-label": "New note" }) as HTMLTextAreaElement;
  const status = h("span", { class: "tools-dim", role: "status" });
  const save = h("button", { class: "tools-action", type: "button", text: "Save to inbox" });
  const list = h("div", { class: "tools-card-body notes-list" });
  const render = () => {
    list.replaceChildren(...(notes.length ? notes.map(note => h("div", { class: "row-with-send" },
      h("button", { class: "tools-news-row", type: "button", title: `Open ${note.path} in Obsidian`,
        onclick: () => { if (vault) void Bridge.toolsOpenNote(vault.id, note.path).catch(e => { status.textContent = errorText(e); }); } },
        h("span", { class: "tools-row-name", text: note.title }),
        h("span", { class: "tools-dim", text: age(note.modified) })),
      sendButton(`Send ${note.title} to phone`, () => vault ? Bridge.localsendSendNote(vault.id, note.path) : Promise.resolve())))
      : [h("span", { class: "tools-dim", text: vault ? "No notes in inbox/ yet." : "Obsidian isn't set up on this PC." })]));
    view.measure();
  };
  const load = async () => {
    if (!vault) vault = (await Bridge.toolsVaults().catch(() => null))?.[0] ?? null;
    notes = vault ? (await Bridge.toolsRecentNotes(vault.id).catch(() => null)) ?? [] : [];
    render();
  };
  const submit = async () => {
    const text = input.value.trim();
    if (!text || !vault) return;
    save.disabled = input.disabled = true;
    try {
      const path = await Bridge.toolsQuickNote(vault.id, text);
      input.value = "";
      status.textContent = `Saved to ${path}`;
      await load();
    } catch (e) { status.textContent = errorText(e); }
    finally { save.disabled = input.disabled = false; input.focus(); }
  };
  save.addEventListener("click", () => void submit());
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
    event.stopPropagation(); // typing never drives the island's shortcuts
  });
  const view = page("notes-view", 300, [
    h("section", { class: "tools-card" },
      h("div", { class: "tools-head" }, h("span", { class: "tools-title", text: "New note" }), status),
      input, h("div", { class: "notes-actions" }, save)),
    h("section", { class: "tools-card" }, h("span", { class: "tools-title", text: "Inbox" }), list),
  ], visible => { if (visible) void load(); }, () => {});
  return view;
}

export function buildNewsPage(): ViewHost {
  let news: NewsItem[] = [];
  let vault: ObsidianVault | null = null;
  let category = (() => { try { return localStorage.getItem(NEWS_KEY) ?? ""; } catch { return ""; } })();
  let visible = false;
  let refreshing: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  const chips = h("div", { class: "tools-news-chips", role: "group", "aria-label": "News category" });
  const list = h("div", { class: "tools-card-body tools-news" });
  const updated = h("span", { class: "tools-dim" });
  const refresh = h("button", { class: "tools-link", type: "button", text: "Refresh" });
  const digest = h("button", { class: "tools-action", type: "button", text: "Today's digest" });
  const render = () => {
    const on = State.settings.assistantEnabled;
    refresh.hidden = !on;
    digest.hidden = !vault; // the digest is a vault note
    for (const chip of chips.children)
      chip.setAttribute("aria-pressed", String((chip as HTMLElement).dataset.category === category));
    const items = news.filter(item => !category || item.categories.includes(category)).slice(0, NEWS_ROWS);
    const newest = news.reduce((max, item) => Math.max(max, item.seen), 0);
    updated.textContent = newest ? `Updated ${age(newest)} ago` : "";
    list.replaceChildren(...(items.length ? items.map(item => h("div", { class: "row-with-send" },
      h("button", { class: "tools-news-row news-row", type: "button", title: item.link, onclick: () => void Bridge.openUrl(item.link) },
        h("span", { class: "news-row-copy" },
          h("span", { class: "tools-row-name", text: item.title }),
          item.summary ? h("span", { class: "news-row-summary", text: item.summary }) : null),
        h("span", { class: "tools-dim", text: `${item.source} · ${age(item.published)}` })),
      sendButton("Send this link to phone", () => Bridge.localsendSendText(`${item.title}\n${item.link}`))))
      : [h("span", { class: "tools-dim", text: news.length ? "Nothing in this category yet."
        : on ? "No headlines yet. The assistant fetches them a minute after it starts." : "Turn on the voice assistant in Settings to collect news." })]));
    view.measure();
  };
  const load = async () => {
    news = (await Bridge.assistantNews().catch(() => null)) ?? [];
    if (!vault) vault = (await Bridge.toolsVaults().catch(() => null))?.[0] ?? null;
    render();
  };
  for (const [id, label] of NEWS_CATEGORIES)
    chips.append(h("button", { class: "tools-pick", type: "button", text: label, "data-category": id, onclick: () => {
      category = id;
      try { localStorage.setItem(NEWS_KEY, id); } catch { /* storage may be unavailable */ }
      render();
    } }));
  refresh.addEventListener("click", () => {
    void Bridge.assistantSend({ t: "news_refresh" });
    refresh.textContent = "Refreshing…";
    clearTimeout(refreshing);
    refreshing = setTimeout(() => { refresh.textContent = "Refresh"; }, 180_000);
  });
  digest.addEventListener("click", () => {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (vault) void Bridge.toolsOpenNote(vault.id, `kumo/news/${today}.md`).catch(e => { updated.textContent = errorText(e); });
  });
  void onEvent<{ t: string }>("assistant", event => {
    if (event.t !== "news_updated") return;
    clearTimeout(refreshing);
    refresh.textContent = "Refresh";
    if (visible) void load();
  }).then(off => { stop = off; });
  const view = page("news-view", 360, [
    h("section", { class: "tools-card" },
      h("div", { class: "tools-head" }, h("span", { class: "tools-title", text: "News" }), updated, refresh),
      chips, list, h("div", { class: "notes-actions" }, digest)),
  ], on => { visible = on; if (on) void load(); }, () => { clearTimeout(refreshing); stop?.(); });
  return view;
}
