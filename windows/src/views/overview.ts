// SPDX-License-Identifier: MIT
import { State, type AgentTask } from "../core/state";
import { CODING_IDS, CODING_PROVIDERS, codingAccountColor, codingConnections, codingInstalled, codingLabel, codingProvider } from "../core/coding";
import { CompactDropdown } from "./device-picker";
import { moduleLayout, type ModuleLayout } from "../core/modules";
import { PANEL_H, type ViewLayout } from "../core/layout";
import { ACTIVITY_CARD_HEIGHT, HOME_WORKSPACE_HEIGHT } from "../core/design";
import { h, clear } from "./dom";
import { CodingCard } from "./coding-card";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import type { ViewActions, ViewHost } from "./views";
import { createMiniBot, pruneMiniBots, miniNotificationLabel, miniBotTask } from "../mimo/minibots";
import { MIMO_PICKER_COLORS } from "../mimo/palette";
import { integrationActivityKey } from "./integration-activity";
import { Sound } from "../core/sound";
import { icon, ICONS } from "./icons";
import { codingQuiet } from "../core/coding-progress";

/** One rounded Home surface keeps the active work and mini Mimos together. */
export class ModuleOverview implements ViewHost {
  readonly el = h("div", { class: "view overview module-layout" });
  private surface = h("div", { class: "home-workspace" });
  private sessionFooter = h("div", { class: "coding-session-footer", hidden: true });
  private activityBody = h("div", { class: "left-body" });
  private activity = h("div", {
    class: "module-activity", "data-module": "vscode",
  }, this.activityBody);
  private choices = h("div", {
    class: "integration-picker", role: "group",
    "aria-label": "Switch integration", "data-labelled": "true",
  });
  private more: CompactDropdown;
  private sessions: CompactDropdown;
  private developerBody = h("div", { class: "module-developer-body integration-switcher" });
  private developer = h("div", {
    class: "module-developer", "data-module": "developerIntegrations",
  }, this.developerBody);
  private empty = h("div", { class: "module-empty" },
    h("div", { class: "title", text: "Ready when you are." }),
    h("div", { class: "sub", text: "Drop a file, grab a picture, or connect a tool." }),
    h("button", {
      class: "btn secondary", text: "Open Settings",
      onclick: () => this.actions.openSettingsWindow(),
    }));
  private codingCard: CodingCard;
  private selected = CODING_IDS.claude as string;
  private detailOpen = false;
  private cardKey = "";
  private pickerKey = "";
  private visible = false;
  private contentHeight = HOME_WORKSPACE_HEIGHT;

  constructor(private actions: ViewActions) {
    this.el.append(this.surface, this.sessionFooter);
    this.sessions = new CompactDropdown("Live coding session", "coding-session-select", id => {
      State.selectCodingTask(id === "auto" ? null : id);
    });
    this.sessions.el.classList.add("coding-session-picker");
    this.sessions.el.classList.add("home-session-selector");this.sessions.el.hidden=true;
    this.more = new CompactDropdown("More integrations", "integration-more",
      id => this.choose(id));
    this.more.el.classList.add("integration-more-picker");
    this.developerBody.append(this.choices, this.more.el);
    this.sessionFooter.append(this.sessions.el);
    this.codingCard = new CodingCard(() => {
      const task = this.companionTask;
      if (task) this.actions.setFocus(task.id);
      this.actions.returnToWork(task?.sessionCwd ?? null, task?.returnTarget, codingProvider(task));
    }, () => { if (this.visible) State.notify(); }, () => this.actions.returnHome());
    this.activity.prepend(this.codingCard.context);
  }

  private integrationTasks(): AgentTask[] {
    return State.tasks.filter(task => task.isIntegration &&
      (codingProvider(task) ? State.settings.modules.vscode
        : State.settings.modules.developerIntegrations && State.settings.activeIntegrations.includes(task.id)));
  }

  /** Disabled or removed tools fall back to VS Code, then the first enabled tool. */
  private activeTask(): AgentTask | null {
    const tasks = this.integrationTasks();
    const active = tasks.find(task => task.id === this.selected)
      ?? tasks.find(task => task.id === CODING_IDS.claude) ?? tasks[0] ?? null;
    if (active && this.selected !== active.id) {
      this.selected = active.id;
      this.detailOpen = false;
    }
    return active;
  }

  plan(): ModuleLayout {
    const base = moduleLayout({
      media: false,
      vscode: true,
      developerIntegrations: !this.fullPreview(),
    }, false, 4);
    const activityHeight = Math.max(this.compactHeight(), this.contentHeight);
    return { ...base, activityHeight, height: 52 + activityHeight + (this.sessionFooter.hidden ? 0 : 26) };
  }

  private compactHeight(): number {
    const active = this.activeTask();
    return this.integrationTasks().length > 5 || active && !codingProvider(active)
      ? ACTIVITY_CARD_HEIGHT : HOME_WORKSPACE_HEIGHT;
  }

  layout(): ViewLayout {
    const plan = this.plan();
    const codingPreview = !!codingProvider(this.companionTask) && this.codingCard.previewExpanded;
    return {
      height: plan.height,
      botX: this.detailOpen ? 27 : codingPreview ? 62 : 68,
      botY: this.detailOpen ? 24 : 96,
      botDiameter: this.detailOpen ? 18 : codingPreview ? 64 : codingProvider(this.companionTask) ? 60 : 52,
      agentMode: "pills",
    };
  }

  get companionTask(): AgentTask | null {
    const active = this.activeTask();
    return active && codingProvider(active) ? State.codingTask : active;
  }

  choose(id: string, followNotification = true): void {
    if (!this.integrationTasks().some(task => task.id === id)) return;
    this.selected = id;
    this.detailOpen = false;
    const slot = State.tasks.find(task => task.id === id);
    const live = slot && codingProvider(slot) ? followNotification ? miniBotTask(slot) : State.codingTask : null;
    if (live && (live.sessionId || live.activity)) State.selectCodingTask(live.id);
    this.actions.setFocus(live?.id ?? id);
  }

  private fullPreview(): boolean {
    return this.detailOpen || !!codingProvider(this.activeTask()) && this.codingCard.previewExpanded;
  }

  private choiceName(task: AgentTask): string {
    if (!codingProvider(task)) return task.name;
    const live = miniBotTask(task);
    return live && (live.activity || live.state !== "idle") ? codingLabel(live) : "VSCodium";
  }

  private hooks(): IntegrationCardHooks {
    return {
      detailOpen: this.detailOpen,
      openDetail: () => { Sound.play("open"); this.detailOpen = true; State.notify(); },
      closeDetail: () => { Sound.play("close"); this.detailOpen = false; State.notify(); },
      openSettings: () => this.actions.openSettingsWindow(),
    };
  }

  sync(): void {
    const active = this.activeTask();
    if (active) this.syncActivity();
    const plan = this.plan();
    this.el.style.setProperty("--activity-height", plan.activityHeight + "px");
    this.el.dataset.mascot = active ? "activity" : "none";
    this.activity.dataset.integration = active?.id ?? "";
    const companion = this.companionTask;
    this.activity.dataset.state = companion?.activity?.stopped ? "stopped"
      : companion?.activity?.completed ? "finished" : companion?.state ?? "idle";
    const desired = active
      ? plan.modules.length > 1 ? [this.activity, this.developer] : [this.activity]
      : [this.empty, this.developer];
    for (const cell of [this.activity, this.developer, this.empty])
      if (!desired.includes(cell)) cell.remove();
    this.activity.style.gridColumn = plan.modules.length > 1 ? "span 1" : "span 2";
    this.empty.style.gridColumn = "span 1";
    this.developer.style.gridColumn = "span 1";
    desired.forEach((cell, index) => {
      if (this.surface.children[index] !== cell)
        this.surface.insertBefore(cell, this.surface.children[index] ?? null);
    });
    if (!active) {
      this.sessionFooter.hidden = true;
      clear(this.activityBody);
      this.cardKey = "";
      this.codingCard.setVisible(false);
    }
    this.el.dataset.preview = String(this.fullPreview());
    if (this.fullPreview()) {
      this.more.close();
      clear(this.choices);
      this.pickerKey = "";
      pruneMiniBots();
    } else this.syncChoices(active);
    this.developer.style.height = plan.activityHeight + "px";
    const height = this.activityBody.contains(this.codingCard.el)
      ? Math.max(this.compactHeight(), Math.min(PANEL_H - 52, this.codingCard.requiredHeight()))
      : this.detailOpen ? PANEL_H - 52 : this.compactHeight();
    if (height !== this.contentHeight) {
      this.contentHeight = height;
      this.el.style.setProperty("--activity-height", height + "px");
      queueMicrotask(() => { if (this.visible) State.notify(); });
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.codingCard.setVisible(visible && this.activityBody.contains(this.codingCard.el));
    if (!visible) {
      this.more.close();
      this.sessions.close();
    }
  }
  setDocumentHidden(hidden: boolean): void { this.codingCard.setDocumentHidden(hidden); }

  review(): void {
    this.setVisible(true);
    this.sync();
    this.codingCard.showPreview();
    this.sync();
  }

  destroy(): void {
    this.setVisible(false);
    this.more.el.remove();
    this.sessions.el.remove();
    this.codingCard.destroy();
    clear(this.choices);
    pruneMiniBots();
  }

  private syncActivity(): void {
    const task = this.companionTask;
    if (!task) return;
    const coding = !!codingProvider(task) || task.source === "agent";
    const codingActive = coding && (task.state !== "idle" || task.steps.length > 0
      || !!task.activity?.completed || !!task.activity?.stopped);
    const connections = codingConnections(State.settings, State.tasks);
    const providers = CODING_PROVIDERS.map(p => p.id).filter(provider => connections[provider]);
    const sessions = State.tasks.filter(session => {
      const provider = codingProvider(session);
      return !State.paused && session.sessionId && provider && codingInstalled(State.settings, provider)
        && ["working", "thinking", "searching"].includes(session.state)
        && !session.activity?.completed && !session.activity?.stopped && session.activity?.phase !== "failed"
        && !codingQuiet(session);
    });
    const canSwitch = sessions.some(session => session.id !== task.id);
    const sessionOptions = sessions.map(session => ({ id: session.id,
      name: codingLabel(session),
      detail: (session.sessionCwd?.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || session.name)
        + " · " + (session.state === "thinking" ? "Thinking" : session.state === "searching" ? "Searching" : "Working"),
      shortName: codingLabel(session), color: codingAccountColor(codingProvider(session)!) }));
    this.sessions.update([{ id: "auto", name: "Auto", detail: "Follow latest activity", shortName: codingLabel(task),
      color: codingAccountColor(codingProvider(task) ?? "claude") }, ...sessionOptions],
      State.selectedCodingId ?? "auto", canSwitch, codingLabel(task));
    if (!canSwitch) this.sessions.close();
    this.sessions.el.hidden = !codingActive || !canSwitch;
    this.sessionFooter.hidden = this.sessions.el.hidden;
    const key = JSON.stringify([
      this.selected, this.detailOpen, task.id, task.name, task.state, task.steps,
      task.stepIndex, task.activity, task.usage, State.integrations[task.id], State.paused, codingQuiet(task, State.paused), providers, sessionOptions, State.selectedCodingId, integrationActivityKey(task.id),
    ]);
    if (this.cardKey === key) return;
    this.cardKey = key;
    this.codingCard.setVisible(this.visible && codingActive);
    if (codingActive) {
      this.codingCard.sync(task,undefined, !State.paused);
      if (this.activityBody.firstElementChild !== this.codingCard.el)
        this.activityBody.replaceChildren(this.codingCard.el);
    } else {
      const card = renderIntegrationCard(task, this.hooks());
      const previousFull = this.activityBody.querySelector(".github-full, .integration-full");
      const focused = this.activityBody.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focusKey : null;
      this.activityBody.replaceChildren(card);
      if (task.id === "integration_github" || card.classList.contains("integration-activity")) queueMicrotask(() => {
        if (!this.visible || !card.isConnected) return;
        const target = focused ? card.querySelector<HTMLElement>(`[data-focus-key="${focused}"]`) : null;
        (target ?? (this.detailOpen && !previousFull ? card.querySelector<HTMLElement>(".github-back, .integration-back") : previousFull && !this.detailOpen ? card.querySelector<HTMLElement>(".github-expand, .integration-expand") : null))?.focus({ preventScroll: true });
      });
    }
  }

  private syncChoices(active: AgentTask | null): void {
    const available = this.integrationTasks().filter(task => task.id !== active?.id);
    const quick = available.slice(0, 4);
    const overflow = available.slice(4);
    this.more.update(overflow.map(task => ({
      id: task.id, name: this.choiceName(task) + (miniNotificationLabel(task) ? " · " + miniNotificationLabel(task) : ""),
    })), null, overflow.length > 0, "More tools");
    const moreUnread = overflow.some(task => miniNotificationLabel(task));
    this.more.el.dataset.unread = String(moreUnread);
    const moreAttention = overflow.some(task => ["Needs attention", "Needs approval", "Needs an answer", "Usage limit reached"].includes(miniNotificationLabel(task)));
    this.more.button.setAttribute("aria-label", "More integrations" + (moreAttention ? ", needs attention" : moreUnread ? ", activity" : ""));
    this.more.el.hidden = overflow.length === 0;
    this.developerBody.classList.toggle("has-more", overflow.length > 0);
    const connectedProviders = new Set(State.tasks.map(codingProvider).filter(Boolean));
    const connections = CODING_PROVIDERS.filter(provider => !connectedProviders.has(provider.id));
    const key = JSON.stringify([active?.id, quick.map(task => [task.id, this.choiceName(task), miniNotificationLabel(task)]), connections]);
    if (this.pickerKey === key) return;
    this.pickerKey = key;
    const focused = document.activeElement;
    const buttons = [...this.choices.querySelectorAll<HTMLButtonElement>("button")];
    const focusIndex = buttons.indexOf(focused as HTMLButtonElement);
    const focusedId = (focused as HTMLElement | null)?.dataset.integration;
    this.choices.replaceChildren(...quick.map(task => {
      const name = this.choiceName(task);
      const label = miniNotificationLabel(task);
      const retained = buttons.find(button => button.dataset.integration === task.id);
      if (retained) {
        retained.title = name;
        retained.dataset.badge = label;
        retained.setAttribute("aria-label", "Show " + name + (label ? ", " + label : ""));
        retained.querySelector(".integration-label")!.textContent = name;
        return retained;
      }
      const avatar = h("span", { class: "integration-avatar", "aria-hidden": "true" },
        createMiniBot(task, 20, false, MIMO_PICKER_COLORS[task.id]));
      const button = h("button", {
        class: "pill integration-tile", type: "button",
        title: name, "aria-label": "Show " + name + (miniNotificationLabel(task) ? ", " + miniNotificationLabel(task) : ""),
        "data-badge": miniNotificationLabel(task),
        "data-integration": task.id, onclick: () => this.choose(task.id),
      }, avatar, h("span", { class: "integration-label", text: name }));
      button.style.setProperty("--integration-color", codingProvider(task)
        ? "var(--mini-work-blue)" : MIMO_PICKER_COLORS[task.id] ?? "var(--ink-2)");
      return button;
    }));
    for (let index=quick.length;index<4;index++) {
      const provider=connections[index-quick.length];
      const label=provider ? "Connect "+provider.name : "Add connection";
      this.choices.append(h("button", {class:"pill integration-tile connection-slot",type:"button",
        "aria-label":label, title:label,
        onclick:()=>this.actions.openSettingsWindow("connections")},
        h("span",{class:"integration-avatar","aria-hidden":"true"},icon(ICONS.plus,16)),
        h("span",{class:"integration-label",text:label})));
    }
    pruneMiniBots();
    if (focusIndex >= 0) {
      const next = [...this.choices.querySelectorAll<HTMLButtonElement>("button")];
      (next.find(button => button.dataset.integration === focusedId)
        ?? next[Math.min(focusIndex, next.length - 1)])?.focus({ preventScroll: true });
    }
  }
}
