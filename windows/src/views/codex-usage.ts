// SPDX-License-Identifier: MIT
import { onEvent } from "../core/bridge";
import { remainingPercent, resetLabel, resetAvailability, windowLabel, type ClaudeUsage, type UsageWindow } from "../core/codex-usage";
import { readAssistantUsage } from "../core/usage-reader";
import { codingDefinition, codingConnections, detectedCodingProviders, codingAccountColor, preferredUsageProvider, type CodingProvider } from "../core/coding";
import { State } from "../core/state";
import { Lifetime } from "../core/lifetime";
import { h } from "./dom";
import { Activity, limitForecast } from "../core/activity";
import { CompactDropdown } from "./device-picker";
import { Sound } from "../core/sound";
import { backAction } from "../core/navigation-sound";
import { VIEW_LAYOUTS } from "../core/layout";
import { ICONS, icon } from "./icons";
import "./codex-usage.css";
import type { ViewActions, ViewHost } from "./views";

/** One retained account view; additional connected agents share its dropdown. */
export class UsagePanel {
  readonly el: HTMLElement;
  private lifetime = new Lifetime();
  private visible = false;
  private pending: CodingProvider | null = null;
  private provider: CodingProvider = State.settings.codingAssistant;
  private revision = 0;
  private checked: Partial<Record<CodingProvider, number>> = {};
  private errors: Partial<Record<CodingProvider, string>> = {};
  private limits = h("div", { class: "usage-limits" });
  private forecast = h("p", { class: "usage-forecast", role: "status" });
  private plan = h("span", { class: "usage-plan", hidden: true });
  private status = h("p", { class: "agent-usage-status", role: "status" });
  private stats = h("div", { class: "agent-usage-stats", hidden: true });
  private resetCount = h("span", { text: "Not shared" });
  private resetExpiry = h("time", { hidden: true });
  private resets = h("div", { class: "usage-reset-credits" }, h("span", { text: "Resets" }), this.resetCount, this.resetExpiry);
  private refresh = h("button", {
    class: "agent-usage-refresh", type: "button", "aria-label": "Refresh usage",
    title: "Refresh usage",
  }, icon(ICONS.refresh, 16));
  private providerDot = h("span", {class:"audio-device-dot", "aria-hidden":"true"});
  private providerLabel = h("span");
  private providerName = h("span", { class: "usage-agent-name" }, this.providerDot, this.providerLabel);
  private windows = [this.meter("Session limit"), this.meter("Weekly limit")];
  private picker = new CompactDropdown("Agent", "usage-agent-select", value => {
    Sound.play("tick"); State.usageProvider = value as CodingProvider; this.select(value as CodingProvider); State.notify();
  });

  constructor(actions?: ViewActions) {
    this.el = h("section", { class: "agent-usage usage-single", "aria-label": "Assistant usage" },
      h("div", { class: "agent-usage-heading" },
        h("div", { class: "agent-usage-intro" },
          h("div", { class: "agent-usage-title" }, h("h1", { text: "Limits" }), this.plan, this.status),
          h("div", { class: "usage-summary" }, this.forecast)),
        h("div", { class: "agent-usage-actions" },
          actions ? h("button", { class: "usage-back", type: "button", "aria-label": "Back to Home", title: "Back to Home",
            onclick: backAction(() => actions.setView("overview")) }, icon(ICONS.chevronLeft, 16)) : null,
          this.providerName, this.picker.el,
          this.refresh)),
      this.limits,
      this.stats,
    );
    this.limits.append(h("div", { class: "agent-usage-windows" }, ...this.windows.map(meter => meter.el)), this.resets);
    this.refresh.addEventListener("click", () => { Sound.play("tick"); void this.read(true); }, { signal: this.lifetime.signal });
    void onEvent<ClaudeUsage>("agent-usage", snapshot => {
      if (!this.lifetime.active || !State.settings.usageEnabled) return;
      this.revision++;
      delete this.errors.claude;
      Activity.observeUsage("claude", snapshot);
      this.checked.claude = Date.now();
      if (this.visible && this.provider === "claude") this.render();
    }).then(stop => this.lifetime.own(stop));
    this.lifetime.own(Activity.subscribe(() => { if (this.visible) this.render(); }));
    this.sync();
    this.render();
  }

  private meter(label: string) {
    const title = h("span", { text: label });
    const value = h("b", { text: "—" });
    const unit = h("span", { text: "% left" });
    const amount = h("span", { class: "agent-usage-amount" }, value, unit);
    const fill = h("span", { class: "agent-usage-fill" });
    const track = h("div", { class: "agent-usage-track", role: "progressbar", "aria-label": label + " remaining" },
      fill);
    const resetTime = h("time", { text: "Not shared yet" });
    const availability = h("span", { class: "usage-reset-availability", hidden: true });
    const reset = h("div", { class: "agent-usage-reset" },
      h("div", { class: "usage-reset-heading" }, icon(ICONS.refresh, 11), availability), resetTime);
    const el = h("div", { class: "agent-usage-window is-unavailable" },
      h("div", { class: "agent-usage-window-heading" }, title), track, amount, reset);
    return { el, title, amount, value, unit, fill, track, reset, resetTime, availability, fallback: label };
  }

  sync(): void {
    const available = detectedCodingProviders(State.tasks);
    const next = preferredUsageProvider(State.settings, State.tasks, State.codingTask, State.usageProvider);
    this.el.dataset.usageProvider = next;
    if (next !== this.provider) this.select(next);
    this.picker.update(available.map(id => ({ id, name: codingDefinition(id).name, color: codingAccountColor(id) })), this.provider, available.length > 1);
    this.picker.el.hidden = available.length < 2;
    this.providerName.hidden = available.length > 1;
    this.providerLabel.textContent = codingDefinition(this.provider).name;
    this.providerDot.style.background = codingAccountColor(this.provider);
    this.render();
  }

  private select(provider: CodingProvider): void {
    const changed = provider !== this.provider;
    this.provider = provider;
    this.el.dataset.usageProvider = provider;
    if (changed) {
      this.render();
      if (this.visible && Date.now() - (this.checked[provider] ?? 0) >= 60000) void this.read(false);
    }
  }

  setVisible(visible: boolean): void {
    const opened = visible && !this.visible;
    this.visible = visible;
    if (!visible) this.picker.close();
    if (opened) {
      this.sync();
      if (!document.hidden && Date.now() - (this.checked[this.provider] ?? 0) >= 60000)
        void this.read(false);
    }
  }

  private async read(force: boolean): Promise<void> {
    const provider = this.provider;
    if (!this.lifetime.active || !this.visible || document.hidden || this.pending
        || !State.settings.usageEnabled || !codingConnections(State.settings, State.tasks)[provider]) return;
    if (!["claude", "codex"].includes(provider)) { this.render(); return; }
    this.pending = provider;
    delete this.errors[provider];
    const revision = this.revision;
    this.refresh.disabled = true;
    this.el.setAttribute("aria-busy", "true");
    this.status.textContent = "Checking your usage…";
    try {
      const snapshot = await readAssistantUsage(provider, force);
      if (!this.lifetime.active || !State.settings.usageEnabled) return;
      this.checked[provider] = Date.now();
      delete this.errors[provider];
      if ((provider !== "claude" || revision === this.revision) && snapshot
        && snapshot.checkedAt >= (Activity.latest(provider)?.checkedAt ?? 0)) Activity.observeUsage(provider, snapshot);
      if (this.provider === provider) this.render();
    } catch {
      if (!this.lifetime.active || this.provider !== provider) return;
      this.checked[provider] = Date.now();
      this.errors[provider] = Activity.latest(provider)
        ? "Couldn’t refresh. Here’s the last reading."
        : provider === "codex" ? "Sign in to Codex with ChatGPT, then refresh."
          : "Start a Claude session. Usage follows your next reply.";
      this.status.textContent = this.errors[provider]!;
    } finally {
      this.pending = null;
      if (this.lifetime.active) {
        this.refresh.disabled = false;
        this.el.removeAttribute("aria-busy");
        this.render();
        if (this.visible && this.provider !== provider && Date.now() - (this.checked[this.provider] ?? 0) >= 60000)
          void this.read(false);
      }
    }
  }

  private render(): void {
    const snapshot = Activity.latest(this.provider);
    this.plan.hidden = !snapshot?.plan;
    this.plan.textContent = snapshot?.plan ?? "";
    [snapshot?.primary, snapshot?.secondary].forEach((window, index) => this.renderMeter(index, window ?? null));
    const parts: string[] = [];
    const format = (tokens: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(tokens);
    if (this.provider === "claude" && snapshot) {
      const claude = snapshot as ClaudeUsage;
      if (claude.contextUsedPercent != null) parts.push(Math.round(claude.contextUsedPercent) + "% context");
      if (claude.inputTokens != null) parts.push(format(claude.inputTokens + (claude.outputTokens ?? 0)) + " context tokens");
      if (claude.sessionCostUsd != null) parts.push("Est. $" + claude.sessionCostUsd.toFixed(2));
    }
    this.stats.hidden = parts.length === 0;
    this.stats.textContent = parts.join(" · ");
    const credits = snapshot?.resetCredits;
    const count = credits?.availableCount;
    const reported = count != null && Number.isSafeInteger(count) && count >= 0;
    this.resetCount.textContent = reported ? count > 0 ? count + " available" : "None available" : "Not shared";
    this.resets.dataset.state = reported && count > 0 ? "available" : "unavailable";
    const expiresAt = credits?.nextExpiresAt;
    const hasExpiry = reported && count > 0 && expiresAt != null && Number.isFinite(expiresAt)
      && expiresAt > 0 && expiresAt <= 4102444800;
    this.resetExpiry.hidden = !hasExpiry;
    if (hasExpiry) {
      const date = new Date(expiresAt * 1000);
      const passed = date.getTime() <= Date.now();
      this.resetExpiry.textContent = passed ? " · refresh to confirm" : (count === 1 ? " · until " : " · next expiry ")
        + date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      this.resetExpiry.dateTime = date.toISOString();
      this.resetExpiry.title = "Reported expiry: " + date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" });
    } else {
      this.resetExpiry.textContent = "";
      this.resetExpiry.removeAttribute("datetime"); this.resetExpiry.removeAttribute("title");
    }
    const forecasts = (["primary", "secondary"] as const).filter(name => snapshot?.[name]).map(name => limitForecast(Activity.readings(this.provider), name));
    this.forecast.textContent = forecasts.find(text => text.includes("run out by")) ?? forecasts[0] ??
      "This agent does not share account limits.";
    this.status.textContent = this.errors[this.provider] ?? (this.pending === this.provider ? "Checking your usage…" : snapshot
      ? "Updated " + new Date(snapshot.checkedAt * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : this.provider === "codex" ? "Your Codex sign-in. No key needed."
        : this.provider === "claude" ? "Usage arrives after your next Claude reply." : "Activity follows this agent’s connected hook.");
  }

  private renderMeter(index: number, window: UsageWindow | null): void {
    const meter = this.windows[index];
    meter.el.classList.toggle("is-unavailable", !window);
    const label = windowLabel(window?.windowMinutes ?? null, meter.fallback);
    meter.title.textContent = label;
    meter.track.setAttribute("aria-label", label + " remaining");
    meter.track.setAttribute("aria-valuemin", "0");
    meter.track.setAttribute("aria-valuemax", "100");
    if (window) {
      const remaining = remainingPercent(window);
      meter.el.dataset.capacity = remaining <= 20 ? "low" : "available";
      meter.value.textContent = String(Math.round(remaining));
      meter.unit.textContent = "% left";
      meter.fill.style.width = remaining + "%";
      meter.track.setAttribute("aria-valuenow", String(remaining));
      meter.track.setAttribute("aria-valuetext", Math.round(remaining) + " percent remaining");
      meter.resetTime.textContent = resetLabel(window.resetsAt);
      const hasReset = window.resetsAt != null && Number.isFinite(window.resetsAt) && Math.abs(window.resetsAt) <= 8.64e12;
      if (hasReset) {
        const date = new Date(window.resetsAt! * 1000);
        meter.resetTime.dateTime = date.toISOString();
        meter.resetTime.title = date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" });
      } else { meter.resetTime.removeAttribute("datetime"); meter.resetTime.removeAttribute("title"); }
      meter.availability.hidden = !hasReset;
      meter.availability.textContent = resetAvailability(window.resetsAt);
    } else {
      delete meter.el.dataset.capacity;
      meter.value.textContent = "—";
      meter.unit.textContent = "";
      meter.fill.style.width = "0%";
      meter.track.removeAttribute("aria-valuenow");
      meter.track.setAttribute("aria-valuetext", "Unavailable");
      meter.resetTime.textContent = Activity.latest(this.provider) ? "Not shared by this account" : "Not shared yet";
      meter.resetTime.removeAttribute("datetime"); meter.resetTime.removeAttribute("title");
      meter.availability.hidden = true;
    }
  }

  destroy(): void {
    this.lifetime.destroy();
    this.visible = false;
    this.picker.close();
    this.el.remove();
  }
}

/** Mount the small usage tree only after a visit; release it when switched off. */
export function buildUsage(actions: ViewActions): ViewHost {
  const el = h("div", { class: "view agent-usage-view" });
  let panel: UsagePanel | null = null;
  let visible = false;
  let resize: ResizeObserver | null = null;
  const layout = { ...VIEW_LAYOUTS.usage };
  const measure = () => {
    if (!visible || !panel?.el.isConnected) return;
    const height = Math.min(432, Math.max(VIEW_LAYOUTS.usage.height, panel.el.scrollHeight + 62));
    if (height !== layout.height) {
      layout.height = height;
      // Keep the content box steady while the surrounding shell changes size.
      el.style.setProperty("--usage-view-height", (height - 52) + "px");
      State.notify();
    }
  };
  return {
    el,
    layout: () => layout,
    sync() { if (visible && State.settings.usageEnabled) { panel?.sync(); measure(); } },
    setVisible(next) {
      const opened = next && !visible;
      visible = next;
      if (!State.settings.usageEnabled) {
        resize?.disconnect();
        panel?.destroy();
        panel = null;
        visible = false;
        layout.height = VIEW_LAYOUTS.usage.height;
        el.style.removeProperty("--usage-view-height");
        return;
      }
      if (visible && !panel) {
        panel = new UsagePanel(actions);
        el.append(panel.el);
        resize ??= new ResizeObserver(measure);
      }
      panel?.setVisible(visible);
      if (!visible) resize?.disconnect();
      else if (opened && panel) { resize?.observe(panel.el); measure(); }
    },
    destroy() { visible = false; resize?.disconnect(); resize = null; panel?.destroy(); panel = null; },
  };
}
