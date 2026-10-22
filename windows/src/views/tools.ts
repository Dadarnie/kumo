// SPDX-License-Identifier: MIT
// Tools tab: pinned app launcher, Raphael's news, Docker containers, Ollama models
// and an Obsidian quick note. Docker and Ollama are polled only while the tab shows.
import { h } from "./dom";
import { ICONS, icon } from "./icons";
import { Bridge, onEvent, type DockerState, type NewsItem, type ObsidianVault, type OllamaState, type StartApp } from "../core/bridge";
import { State } from "../core/state";

const PINS_KEY = "mimo.tools.pins";
const NEWS_KEY = "kumo.tools.news";
const NEWS_ROWS = 6;
const NEWS_CATEGORIES = [["", "All"], ["coding", "Coding"], ["ai", "AI"], ["free", "Free"], ["security", "Security"]] as const;
const POLL_MS = 5000;
/** Your dev and notes apps, matched by Start-menu name on first run. */
const DEFAULT_PINS = ["VSCodium", "OpenCode", "Docker Desktop", "Ollama", "Terminal", "Git Bash",
  "Obsidian", "ChatGPT", "Claude", "Granola", "Hermes"];

function readPins(): string[] | null {
  try {
    const value = JSON.parse(localStorage.getItem(PINS_KEY) ?? "null");
    return Array.isArray(value) ? value.filter(id => typeof id === "string") : null;
  } catch { return null; }
}
function writePins(pins: string[]): void {
  try { localStorage.setItem(PINS_KEY, JSON.stringify(pins)); } catch { /* storage may be unavailable */ }
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1) + " GB";

function age(seconds: number): string {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - seconds) / 60));
  return mins < 60 ? `${mins} min` : mins < 1440 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} d`;
}

export class ToolsPanel {
  private apps: StartApp[] = [];
  private pins: string[] = [];
  private editing = false;
  private filter = "";
  private grid = h("div", { class: "tools-grid" });
  private editButton = h("button", { class: "tools-link", type: "button", text: "Edit" });
  private picker = h("div", { class: "tools-picker", hidden: true });
  private search = h("input", { class: "tools-search", type: "search", placeholder: "Find an app to pin" }) as HTMLInputElement;
  private pickerList = h("div", { class: "tools-picker-list" });
  private docker = h("div", { class: "tools-card-body" });
  private ollama = h("div", { class: "tools-card-body" });
  private note = h("input", { class: "tools-note", type: "text", placeholder: "Quick note to Obsidian…", maxlength: "2000" }) as HTMLInputElement;
  private vault: ObsidianVault | null = null;
  private obsidian = h("div", { class: "tools-card-body" });
  private news: NewsItem[] = [];
  private newsCategory = (() => { try { return localStorage.getItem(NEWS_KEY) ?? ""; } catch { return ""; } })();
  private newsChips = h("div", { class: "tools-news-chips", role: "group", "aria-label": "News category" });
  private newsList = h("div", { class: "tools-card-body tools-news" });
  private newsRefresh = h("button", { class: "tools-link", type: "button", text: "Refresh" });
  private newsCard = h("section", { class: "tools-card" },
    h("div", { class: "tools-head" }, h("span", { class: "tools-title", text: "News" }), this.newsRefresh),
    this.newsChips, this.newsList);
  private refreshing: ReturnType<typeof setTimeout> | undefined;
  private stopNews: (() => void) | undefined;
  private poll: ReturnType<typeof setTimeout> | undefined;
  private visible = false;
  private appsLoaded = false;
  readonly el = h("div", { class: "tools-panel" },
    h("div", { class: "tools-head" }, h("span", { class: "tools-title", text: "Apps" }), this.editButton),
    this.grid,
    this.picker,
    this.newsCard,
    h("section", { class: "tools-card" }, h("span", { class: "tools-title", text: "Docker" }), this.docker),
    h("section", { class: "tools-card" }, h("span", { class: "tools-title", text: "Ollama" }), this.ollama),
    h("section", { class: "tools-card" }, h("span", { class: "tools-title", text: "Obsidian" }), this.obsidian),
  );

  constructor(private resized: () => void) {
    this.picker.append(this.search, this.pickerList);
    this.editButton.addEventListener("click", () => {
      this.editing = !this.editing;
      this.editButton.textContent = this.editing ? "Done" : "Edit";
      this.picker.hidden = !this.editing;
      if (this.editing) { this.renderPicker(); this.search.focus(); }
      this.resized();
    });
    this.search.addEventListener("input", () => { this.filter = this.search.value.toLowerCase(); this.renderPicker(); });
    this.note.addEventListener("keydown", event => {
      if (event.key !== "Enter" || !this.vault || !this.note.value.trim()) return;
      const text = this.note.value;
      this.note.disabled = true;
      void Bridge.toolsQuickNote(this.vault.id, text).then(() => {
        this.note.value = "";
        this.note.placeholder = "Saved to Kumo Inbox ✓";
      }).catch(() => { this.note.placeholder = "Could not save the note"; })
        .finally(() => { this.note.disabled = false; });
    });
    for (const [id, label] of NEWS_CATEGORIES)
      this.newsChips.append(h("button", { class: "tools-pick", type: "button", text: label, "data-category": id,
        onclick: () => {
          this.newsCategory = id;
          try { localStorage.setItem(NEWS_KEY, id); } catch { /* storage may be unavailable */ }
          this.renderNews();
        } }));
    this.newsRefresh.addEventListener("click", () => {
      void Bridge.raphaelSend({ t: "news_refresh" });
      this.newsRefresh.textContent = "Refreshing…";
      clearTimeout(this.refreshing);
      this.refreshing = setTimeout(() => { this.newsRefresh.textContent = "Refresh"; }, 180_000);
    });
    void onEvent<{ t: string }>("raphael", event => {
      if (event.t !== "news_updated") return;
      clearTimeout(this.refreshing);
      this.newsRefresh.textContent = "Refresh";
      if (this.visible) void this.loadNews();
    }).then(stop => { this.stopNews = stop; });
    void Bridge.toolsVaults().then(vaults => { this.vault = vaults?.[0] ?? null; this.renderObsidian(); }).catch(() => this.renderObsidian());
  }

  private async loadApps(refresh: boolean): Promise<void> {
    this.apps = (await Bridge.toolsApps(refresh).catch(() => null)) ?? [];
    const saved = readPins();
    this.pins = saved ?? DEFAULT_PINS
      .map(name => this.apps.find(app => app.name.toLowerCase() === name.toLowerCase())?.id)
      .filter((id): id is string => !!id);
    if (!saved && this.pins.length) writePins(this.pins);
    this.renderGrid();
    if (this.editing) this.renderPicker();
    this.resized();
  }

  private renderGrid(): void {
    const pinned = this.pins.map(id => this.apps.find(app => app.id === id)).filter((app): app is StartApp => !!app);
    this.grid.replaceChildren(...pinned.map(app =>
      h("button", { class: "tools-app", type: "button", title: app.name,
        onclick: () => { void Bridge.toolsLaunch(app.id).catch(() => {}); } },
        h("span", { class: "tools-app-mark", text: app.name.slice(0, 1).toUpperCase() }),
        h("span", { class: "tools-app-name", text: app.name }))));
    if (!pinned.length) this.grid.append(h("span", { class: "tools-empty", text: "Pin apps with Edit." }));
  }

  private renderPicker(): void {
    const matches = this.apps.filter(app => !this.filter || app.name.toLowerCase().includes(this.filter)).slice(0, 60);
    this.pickerList.replaceChildren(...matches.map(app => {
      const pinned = this.pins.includes(app.id);
      return h("button", { class: "tools-pick", type: "button", "aria-pressed": String(pinned),
        onclick: () => {
          this.pins = pinned ? this.pins.filter(id => id !== app.id) : [...this.pins, app.id];
          writePins(this.pins);
          this.renderGrid();
          this.renderPicker();
          this.resized();
        } }, icon(pinned ? ICONS.check : ICONS.plus, 12), h("span", { text: app.name }));
    }));
  }

  private renderDocker(state: DockerState | null): void {
    if (!state?.installed) { this.docker.replaceChildren(h("span", { class: "tools-dim", text: "Docker is not installed." })); return; }
    if (!state.running) {
      const desktop = this.apps.find(app => app.name === "Docker Desktop");
      this.docker.replaceChildren(h("span", { class: "tools-dim", text: "Docker is not running." }),
        ...(desktop ? [h("button", { class: "tools-action", type: "button", text: "Start Docker",
          onclick: () => { void Bridge.toolsLaunch(desktop.id).catch(() => {}); } })] : []));
      return;
    }
    if (!state.containers.length) { this.docker.replaceChildren(h("span", { class: "tools-dim", text: "No containers." })); return; }
    this.docker.replaceChildren(...state.containers.map(container => {
      const up = container.state === "running";
      const act = (action: "start" | "stop" | "restart") => () => {
        void Bridge.toolsDockerAction(container.id, action).catch(() => {}).finally(() => void this.refresh());
      };
      return h("div", { class: "tools-row", "data-up": String(up) },
        h("span", { class: "tools-dot", "aria-hidden": "true" }),
        h("span", { class: "tools-row-name", text: container.name, title: `${container.image} · ${container.status}` }),
        h("span", { class: "tools-dim", text: container.status }),
        up ? h("button", { class: "tools-action", type: "button", text: "Restart", onclick: act("restart") }) : "",
        h("button", { class: "tools-action", type: "button", text: up ? "Stop" : "Start", onclick: act(up ? "stop" : "start") }));
    }));
  }

  private renderOllama(state: OllamaState): void {
    if (!state.running) { this.ollama.replaceChildren(h("span", { class: "tools-dim", text: "Ollama is not running." })); return; }
    if (!state.models.length) { this.ollama.replaceChildren(h("span", { class: "tools-dim", text: "No models loaded." })); return; }
    this.ollama.replaceChildren(...state.models.map(model => h("div", { class: "tools-row", "data-up": "true" },
      h("span", { class: "tools-dot", "aria-hidden": "true" }),
      h("span", { class: "tools-row-name", text: model.name }),
      h("span", { class: "tools-dim", text: gb(model.sizeVram || model.size) }),
      h("button", { class: "tools-action", type: "button", text: "Unload",
        onclick: () => { void Bridge.toolsOllamaUnload(model.name).catch(() => {}).finally(() => void this.refresh()); } }))));
  }

  private renderObsidian(): void {
    if (!this.vault) { this.obsidian.replaceChildren(h("span", { class: "tools-dim", text: "No Obsidian vault found." })); return; }
    const vault = this.vault;
    this.obsidian.replaceChildren(this.note,
      h("button", { class: "tools-action", type: "button", text: "Open inbox", title: `${vault.name} › Kumo Inbox`,
        onclick: () => { void Bridge.toolsOpenInbox(vault.id).catch(() => {}); } }));
  }

  private async loadNews(): Promise<void> {
    this.news = (await Bridge.raphaelNews().catch(() => null)) ?? [];
    this.renderNews();
  }

  private renderNews(): void {
    const on = State.settings.raphaelEnabled;
    this.newsCard.hidden = !on && this.news.length === 0;
    this.newsRefresh.hidden = !on;
    for (const chip of this.newsChips.children)
      chip.setAttribute("aria-pressed", String((chip as HTMLElement).dataset.category === this.newsCategory));
    const items = this.news.filter(item => !this.newsCategory || item.categories.includes(this.newsCategory)).slice(0, NEWS_ROWS);
    this.newsList.replaceChildren(...(items.length ? items.map(item =>
      h("button", { class: "tools-news-row", type: "button", title: `${item.title}\n${item.link}`,
        onclick: () => void Bridge.openUrl(item.link) },
        h("span", { class: "tools-row-name", text: item.title }),
        h("span", { class: "tools-dim", text: `${item.source} · ${age(item.published)}` })))
      : [h("span", { class: "tools-dim", text: this.news.length ? "Nothing in this category yet." : "No headlines yet. Raphael fetches them a minute after it starts." })]));
    this.resized();
  }

  private async refresh(): Promise<void> {
    clearTimeout(this.poll);
    const [docker, ollama] = await Promise.all([
      Bridge.toolsDocker().catch(() => null),
      Bridge.toolsOllama().catch(() => null),
    ]);
    if (!this.visible) return;
    this.renderDocker(docker);
    this.renderOllama(ollama ?? { running: false, models: [] });
    this.resized();
    this.poll = setTimeout(() => void this.refresh(), POLL_MS);
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    clearTimeout(this.poll);
    // The Start-menu list costs a PowerShell run: load it the first time the tab opens.
    if (visible && !this.appsLoaded) { this.appsLoaded = true; void this.loadApps(false); }
    if (visible) { void this.refresh(); void this.loadNews(); }
  }

  destroy(): void { this.visible = false; clearTimeout(this.poll); clearTimeout(this.refreshing); this.stopNews?.(); }
}
