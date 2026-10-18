// SPDX-License-Identifier: MIT
// Mimo's expanded island views and shared navigation.

import { h, clear, dot } from "./dom";
import { SECTIONS, sectionEnabled, sectionForView } from "../core/sections";
import { ICONS, icon } from "./icons";
import { integrationsFilled, usageFilled,
  soundFilled, soundOffFilled } from "../icons/filled";
import { notchHome, notchSettings } from "../icons/notch";
import { mimoIcon } from "../icons/render";
import { State, type AgentTask } from "../core/state";
import { chatAssistantName, codingDefinition, codingConnections, detectedCodingProviders, codingLabel, codingProvider, codingAccountColor, preferredUsageProvider, type CodingProvider } from "../core/coding";
import { Activity } from "../core/activity";
import { readAssistantUsage } from "../core/usage-reader";
import { remainingPercent } from "../core/codex-usage";
import { CompactDropdown } from "./device-picker";
import { Sound } from "../core/sound";
import { PANEL_H, VIEW_LAYOUTS, washRGBA, type IslandViewName, type Wash } from "../core/layout";
import type { ViewLayout } from "../core/layout";
import { createMiniBot, miniNotificationLabel } from "../mimo/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { naturalHeight } from "./content-size";
import { buildApprovalInbox } from "./approval-inbox";
import { approvalRisk } from "../core/approval-risk";
import type { ReturnTarget } from "../core/coding-session";
import { lazyView } from "./lazy-view";
import type { VoiceChat } from "./voice-chat";
import { buildDesktopVoice } from "./desktop-voice";
import { buildAgentQuestion } from "./agent-question";

export interface ViewActions {
  setView(v: IslandViewName): void;
  returnHome(): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(cwd?: string | null): void;
  returnToWork(cwd: string | null, target?: ReturnTarget, provider?: CodingProvider | null): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  answerQuestion(requestId:string,answers:Record<string,string>): Promise<void>;
  returnQuestion(): void;
  toggleSound(): void;
  setVolume(v: number): void;
  openSettingsWindow(page?: string): void;
  openTool(id: string): void;
  blip(): void;
  toggleVoice(): void;
  closeVoice(): void;
  voicePeak(): number | undefined;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
  layout?(): ViewLayout;
  setVisible?(visible: boolean): void;
  destroy?(): void;
  readonly voice?: VoiceChat;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(
  padLeft: number,
  padRight: number,
  ...children: Node[]
): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const glyphs = {
    overview: mimoIcon(notchHome, 18),
    prompt: icon(ICONS.bubble, 18),
    grab: icon(ICONS.shelf, 18),
    integrations: mimoIcon(integrationsFilled, 18),
    utilities: icon(ICONS.bubble, 18),
    usage: mimoIcon(usageFilled, 18),
  };
  const navigation = SECTIONS.map((section) => ({
    ...section,
    button: h(
      "button",
      {
        class: "tab section-tab",
        type: "button",
        title: section.label,
        "aria-label": section.label,
        "data-section": section.id,
        onclick: () => go(section.id),
      },
      glyphs[section.id],
    ),
  }));
  const gearBtn = h(
    "button",
    { title: "Settings", onclick: () => actions.openSettingsWindow() },
    mimoIcon(notchSettings, 18),
  );
  const capacity = h("span", { class: "header-capacity", hidden: true });
  const limitsLabel = h("span", { text: "Limits" });
  const limitsProviderName = h("span");
  const limitsProviderDot = h("span", { class: "audio-device-dot", "aria-hidden": "true" });
  const limitsProvider = h("span", { class: "header-limits-provider" }, limitsProviderDot, limitsProviderName);
  const limitsBtn = h("button", { class: "header-limits", type: "button", hidden: true,
    "aria-label": "Limits", "data-section": "usage", title: "Limits", onclick: () => go("usage") },
    limitsProvider, limitsLabel, capacity);
  const account = new CompactDropdown("Limits account", "header-agent-select", id => {
    Sound.play("tick"); State.usageProvider = id as CodingProvider; State.notify();
  });
  account.el.classList.add("header-account");
  const checked: Partial<Record<CodingProvider, number>> = {};
  let reading = false, active = true, capacityKey = "";

  function syncCapacity(read = true): void {
    const connections = codingConnections(State.settings, State.tasks);
    const preferred = preferredUsageProvider(State.settings, State.tasks, State.codingTask, State.usageProvider);
    const available = detectedCodingProviders(State.tasks).map(codingDefinition);
    const provider = connections[preferred] ? preferred : undefined;
    limitsProviderName.textContent = provider === "claude" ? "Claude" : provider ? codingDefinition(provider).name : "";
    if (provider) limitsProviderDot.style.background = codingAccountColor(provider);
    limitsBtn.hidden = !sectionEnabled("usage", State.settings.modules, 0, State.settings.usageEnabled, !!provider);
    const selected = State.view === "usage";
    limitsBtn.classList.toggle("on", selected);
    if (selected) limitsBtn.setAttribute("aria-current", "page");
    else limitsBtn.removeAttribute("aria-current");
    const expanded = !limitsBtn.hidden && State.visibility === "expanded";
    account.el.hidden = !expanded || available.length < 2;
    limitsProvider.hidden = !account.el.hidden;
    account.update(available.map(p => ({ id: p.id, name: p.name, shortName: p.id === "claude" ? "Claude" : p.name, color: codingAccountColor(p.id) })), provider, !account.el.hidden);
    if (!expanded) account.close();
    const snapshot = provider ? Activity.latest(provider) : null;
    const windows = snapshot?.primary?.windowMinutes === 300 ? [snapshot.primary] : [];
    const show = expanded && windows.length > 0;
    capacity.hidden = !show; limitsLabel.hidden = show;
    const key = show ? JSON.stringify([provider, windows]) : "";
    if (key !== capacityKey) {
      capacityKey = key;
      capacity.replaceChildren(...windows.map(window => {
        const remaining = remainingPercent(window);
        return h("span", { class: "header-capacity-window", title: Math.round(remaining) + "% left",
          "data-capacity": remaining <= 20 ? "low" : "available" },
          h("b", { text: Math.round(remaining) + "%" }));
      }));
    }
    const detail = provider && windows.length ? codingDefinition(provider).name + " · " + windows.map(window =>
      Math.round(remainingPercent(window)) + "% left").join("; ") : "";
    limitsBtn.title = detail || "Limits";
    limitsBtn.setAttribute("aria-label", detail ? "Limits · " + detail : "Limits");
    if (!read || !expanded || document.hidden || !provider || reading || !["codex", "claude"].includes(provider)
      || Date.now() - Math.max(checked[provider] ?? 0, (snapshot?.checkedAt ?? 0) * 1000) < 60000) return;
    reading = true; checked[provider] = Date.now();
    void readAssistantUsage(provider).then(value => {
      if (active && State.settings.usageEnabled && State.settings.modules.vscode && value
          && value.checkedAt >= (Activity.latest(provider)?.checkedAt ?? 0)) Activity.observeUsage(provider, value);
    }).catch(() => { /* Unavailable quotas stay absent; Limits owns refresh guidance. */ })
      .finally(() => { reading = false; if (active) syncCapacity(false); });
  }
  const stopCapacity = Activity.subscribe(() => { if (active) syncCapacity(false); });
  const soundBtn = h(
    "button",
    { title: "Mute", onclick: () => actions.toggleSound() },
    mimoIcon(soundFilled, 18),
  );
  const approvalCount = h("span", { class: "approval-count", "aria-hidden": "true" });
  const approvalLabel = h("span", { text: "Approval" });
  const approvalBtn = h("button", { class: "approvals-entry", type: "button", hidden: true,
    onclick: () => go("approvals") }, icon(ICONS.bang, 13),
    approvalLabel, approvalCount);
  let renderedSound: boolean | undefined;
  for (const button of [gearBtn, soundBtn])
    button.setAttribute("aria-label", button.title);

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h(
      "nav",
      { class: "tabs", "aria-label": "Island sections" },
      ...navigation.map((item) => item.button),
    ),
    h("div", { class: "header-actions" }, account.el, limitsBtn, gearBtn, soundBtn, approvalBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      syncCapacity();
      approvalBtn.hidden = State.approvalInboxCount === 0;
      approvalBtn.classList.toggle("has-pending", State.approvalCount > 0);
      approvalBtn.classList.toggle("on", v === "approvals");
      approvalCount.textContent = String(State.approvalCount);
      approvalCount.hidden = State.approvalCount === 0;
      approvalLabel.textContent = State.pendingApprovals.some(request=>request.questions) ? "Review" : "Approval";
      approvalBtn.title = `${State.pendingApprovals.length} waiting requests, ${State.approvalCount} items need attention`;
      approvalBtn.setAttribute("aria-label", "Approval: " + approvalBtn.title);
      for (const item of navigation) {
        item.button.hidden = !sectionEnabled(
          item.id,
          State.settings.modules,
          State.settings.activeIntegrations.length,
          State.settings.usageEnabled,
          Object.values(codingConnections(State.settings, State.tasks)).some(Boolean),
        );
        const selected = sectionForView(v) === item.id;
        item.button.classList.toggle("on", selected);
        if (selected) item.button.setAttribute("aria-current", "page");
        else item.button.removeAttribute("aria-current");
      }
      gearBtn.classList.toggle("on", v === "settings");
      if (renderedSound !== State.settings.soundEnabled) {
        renderedSound = State.settings.soundEnabled;
        clear(soundBtn);
        soundBtn.append(mimoIcon(renderedSound ? soundFilled : soundOffFilled, 18));
        soundBtn.title = renderedSound ? "Mute" : "Unmute";
        soundBtn.setAttribute("aria-label", soundBtn.title);
      }
    },
    destroy() { active = false; stopCapacity(); account.close(); },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

export function buildPill(
  task: AgentTask,
  actions: ViewActions,
  compact = false,
): HTMLElement {
  const label = task.id === "integration_claude" ? "VS Code" : codingProvider(task) ? codingLabel(task) : task.name;
  const canvas = createMiniBot(task, 24);
  const pill = h(
    "button",
    {
      class: compact ? "pill integration-tile" : "pill",
      type: "button",
      "aria-label": `Show ${label}${miniNotificationLabel(task) ? ", " + miniNotificationLabel(task) : ""}`,
      title: label,
      onclick: () => actions.setFocus(task.id),
    },
    canvas,
    compact ? null : h("span", { class: "lbl", text: label }),
  );
  pill.dataset.integration = task.id;
  if (!compact) {
    pill.style.borderColor = `${task.color}24`;
    pill.addEventListener("mouseenter", () => {
      pill.style.background = `${task.color}2e`;
      pill.style.borderColor = `${task.color}8c`;
      pill.style.boxShadow = `0 2px 10px ${task.color}59`;
      (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(
        task.color,
        0.3,
      );
    });
    pill.addEventListener("mouseleave", () => {
      pill.style.background = "";
      pill.style.borderColor = `${task.color}24`;
      pill.style.boxShadow = "";
      (pill.querySelector(".lbl") as HTMLElement).style.color = "";
    });
  }

  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const ask = btn("Ask Claude", "primary", () => actions.setView("prompt"));
  const body = h(
    "div",
    {
      class: "stack",
      style:
        "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px",
    },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", {
        class: "sub",
        text: "Drop a file or window, or ask me anything.",
      }),
    ),
    h("div", { class: "grow" }),
    ask,
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {
    const label = ask.querySelector("span")!;
    const text = "Ask " + chatAssistantName(State.settings);
    if (label.textContent !== text) label.textContent = text;
  } };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const project = h("span", { class: "coding-project" });
  const status = h("span");
  const providerName = h("span", { class: "coding-approval-provider" });
  const dangerTitle = h("b", { class: "danger-title", text: "Danger zone", hidden: true });
  const dangerDetail = h("div", { class: "danger-detail", hidden: true });
  const code = h("div", { class: "code", tabindex: "0", "aria-label": "Requested action" });
  const reason = h("div", { class: "coding-approval-reason", hidden: true,
    tabindex: "0", "aria-label": "Permission details" });
  // Keep the decision controls mounted across notifications and pointer events.
  const row = h("div", { class: "actions" },
    btn("Deny", "secondary", () => actions.decide("deny"), "N"),
    btn("Allow", "primary", () => actions.decide("allow"), "Y"));
  const body = h("div", { class: "coding-approval" },
      h("div", { class: "coding-approval-heading" }, project, dangerTitle),
      h("div", { class: "coding-approval-status" }, icon(ICONS.permission, 13), providerName, status),
      code, reason, dangerDetail, row);
  const surface = card("amber", body);
  const el = h("div", { class: "view approval-view" }, surface);
  let height = VIEW_LAYOUTS.approval.height;
  let measured = "";
  let width = -1;
  const resize = new ResizeObserver(() => {
    if (body.offsetWidth === width) return;
    width = body.offsetWidth;
    if (State.view === "approval") State.notify();
  });
  resize.observe(body);
  return {
    el,
    layout: () => ({ ...VIEW_LAYOUTS.approval, height }),
    destroy: () => resize.disconnect(),
    sync() {
      const request = State.pendingApproval;
      const assessment = approvalRisk(request);
      const risk = assessment.level;
      el.dataset.risk = risk;
      surface.classList.toggle("danger-zone", risk === "danger");
      dangerTitle.hidden = dangerDetail.hidden = risk !== "danger";
      dangerDetail.textContent = risk === "danger" ? assessment.detail : "";
      surface.style.setProperty("--wash", washRGBA(risk === "danger" ? "red" : "amber"));
      const task = State.tasks.find(task => task.id === request?.taskId) ?? State.focusTask;
      project.textContent = task?.name || "Coding session";
      project.title = task?.sessionCwd || "";
      status.textContent = "Permission needed";
      const provider = request?.provider === "claude" || !request?.provider ? "Claude" : codingDefinition(request.provider).name;
      providerName.textContent = provider;
      el.setAttribute("aria-label", `${provider}: permission needed`);
      code.textContent = request?.command || request?.tool || "…";
      reason.textContent = request?.reason || "";
      reason.title = request?.reason || "";
      reason.hidden = !request?.reason;
      const key = JSON.stringify([body.offsetWidth, code.textContent, reason.textContent, risk]);
      if (key !== measured) {
        measured = key;
        const next = Math.min(PANEL_H, Math.max(VIEW_LAYOUTS.approval.height, 54 + naturalHeight(body)));
        if (next !== height) {
          height = next;
          queueMicrotask(() => { if (State.view === "approval") State.notify(); });
        }
      }
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const row = h(
    "div",
    { class: "actions" },
    h("button", { class: "btn secondary return-to-work", type: "button", title: "Back to work",
      "aria-label": "Back to work", onclick: () => {
        const task = State.focusTask;
        actions.returnToWork(task?.sessionCwd ?? null, task?.returnTarget, codingProvider(task));
      } }, icon(ICONS.arrowUpRight, 16), h("span", { text: "Back to work" })),
    btn("Open details", "secondary", () => actions.openTarget()),
  );
  const el = h(
    "div",
    { class: "view error-view" },
    card("red", stack(116, 16, who, title, detail, row)),
  );
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(
        agentWho(task, task?.source === "n8n" ? "n8n" : codingLabel(task)),
      );
      title.textContent =
        task?.source === "n8n"
          ? "Workflow stopped."
          : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h(
    "div",
    { class: "actions" },
    btn("Back to work", "primary", () => {
      const task = State.focusTask;
      actions.returnToWork(task?.sessionCwd ?? null, task?.returnTarget, codingProvider(task));
    }),
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h(
    "div",
    { class: "view finished-view" },
    card("green", stack(116, 16, who, title, row)),
  );
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, codingLabel(State.focusTask) + " finished"));
      title.textContent = State.focusTask?.steps.at(-1) ?? "Session finished";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Recalibrating…" }),
    h("div", {
      class: "sub",
      text: "Give me a moment to find my bearings.",
    }),
  );
  return { el: h("div", { class: "view confused-view" }, card("indigo", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h(
    "div",
    { class: "view" },
    card(
      null,
      h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title),
    ),
  );
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
  overview: ViewHost,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", overview);
  map.set("empty", lazyView(() => buildEmpty(actions)));
  map.set("approval", lazyView(() => buildApproval(actions), VIEW_LAYOUTS.approval));
  map.set("approvals", lazyView(() => buildApprovalInbox(actions), VIEW_LAYOUTS.approvals));
  map.set("question", lazyView(() => buildAgentQuestion(actions), VIEW_LAYOUTS.question));
  map.set("error", lazyView(() => buildError(actions)));
  map.set("finished", lazyView(() => buildFinished(actions)));
  map.set("confused", lazyView(buildConfused));
  map.set("voice", lazyView(() => buildDesktopVoice(actions), VIEW_LAYOUTS.voice));
  map.set("note", lazyView(buildNote));
  map.set("prompt", lazyView(() => buildPrompt(onChatHeightChange, actions)));
  map.set("upload", lazyView(buildUpload));
  map.set("uploading", lazyView(buildUploading));
  map.set("choose", lazyView(() => buildChoose(actions)));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set(
    "mail",
    lazyView(() => buildPlaceholder("Sending by email isn't in this version.", "")),
  );
  map.set("searching", lazyView(() => buildPlaceholder("Claude is searching…", "")));
  map.set("result", lazyView(() => buildPlaceholder("Result", "")));
  return map;
}
