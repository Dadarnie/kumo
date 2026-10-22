// SPDX-License-Identifier: MIT
// Tools tab: pinned app launcher, Docker containers and Ollama models (Notes and News
// have their own tabs). Docker and Ollama are polled only while the tab shows.
import { h } from "./dom";
import { ICONS, icon } from "./icons";
import { Bridge, type DockerState, type OllamaState, type StartApp } from "../core/bridge";

const PINS_KEY = "mimo.tools.pins";
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
  private poll: ReturnType<typeof setTimeout> | undefined;
  private visible = false;
  private appsLoaded = false;
  readonly el = h("div", { class: "tools-panel" },
    h("div", { class: "tools-head" }, h("span", { class: "tools-title", text: "Apps" }), this.editButton),
    this.grid,
    this.picker,
    h("section", { class: "tools-card" }, h("span", { class: "tools-title", text: "Docker" }), this.docker),
    h("section", { class: "tools-card" }, h("span", { class: "tools-title", text: "Ollama" }), this.ollama),
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
    if (visible) void this.refresh();
  }

  destroy(): void { this.visible = false; clearTimeout(this.poll); }
}
