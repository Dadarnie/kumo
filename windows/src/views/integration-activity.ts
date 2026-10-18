// SPDX-License-Identifier: MIT
import { State, type AgentTask } from "../core/state";
import { Bridge } from "../core/bridge";
import { Sound } from "../core/sound";
import { integrationList as list, integrationText as text, integrationTimestamp as timestamp, integrationStatus, integrationMoney as money, integrationRows, type IntegrationItem as Item } from "../core/integration-workspace";
import { h, dot } from "./dom";
import { icon, ICONS } from "./icons";
import { SERVICE_ICONS } from "./integration-icons";
import type { IntegrationCardHooks } from "./integrations";
import "./integration-activity.css";
import { MIMO_PICKER_COLORS } from "../mimo/palette";

interface WorkspaceMemory { category: string; query: string; selected: string; refreshing: boolean }
const memories = new Map<string, WorkspaceMemory>();
export const integrationActivityKey = (id: string): string => memories.get(id)?.category ?? "";
const categories: Record<string, [string, string][]> = {
  integration_vercel: [["deployments", "Deployments"], ["building", "Building"], ["ready", "Ready"], ["attention", "Needs attention"]],
  integration_n8n: [["executions", "Executions"], ["workflows", "Workflows"], ["attention", "Failed runs"]],
  integration_stripe: [["payments", "Payments"], ["paid", "Paid"], ["pending", "Pending"], ["refunded", "Refunded"], ["events", "Activity"]],
  integration_resend: [["emails", "Emails"], ["delivered", "Delivered"], ["attention", "Needs attention"]],
  integration_notion: [["pages", "Recent pages"]],
  integration_calcom: [["bookings", "Upcoming"], ["today", "Today"]],
};
const dashboards: Record<string, string> = { integration_vercel: "https://vercel.com/dashboard", integration_stripe: "https://dashboard.stripe.com/payments", integration_resend: "https://resend.com/emails", integration_notion: "https://notion.so", integration_calcom: "https://app.cal.com/bookings" };
const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const agendaDate = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });
let sequence = 0;
function when(value: unknown, future = false): string {
  const at = timestamp(value);
  if (!Number.isFinite(at)) return "";
  if (future) return `${dateFormat.format(at)} · ${clock.format(at)}`;
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60000));
  return minutes < 1 ? "now" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
function rowData(id: string, key: string, item: Item, data: Item) {
  let title = text(item.title ?? item.name ?? item.subject ?? item.projectName ?? item.description ?? item.type ?? item.id) || "Untitled";
  let detail = "", url = text(item.url), state = item.state ?? item.status ?? item.lastEvent;
  const time = when(item.lastEditedAt ?? item.updatedAt ?? item.createdAt ?? item.startedAt ?? item.start, id === "integration_calcom");
  if (id === "integration_vercel") {
    detail = [text(item.branch), text(item.commitMessage)].filter(Boolean).join(" · ");
    if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
  } else if (id === "integration_n8n") {
    state = key === "workflows" ? item.active === true ? "active" : item.active === false ? "off" : "" : state;
    const elapsed = timestamp(item.stoppedAt) - timestamp(item.startedAt);
    detail = [text(item.mode), Number.isFinite(elapsed) && elapsed >= 0 ? `${Math.round(elapsed / 1000)}s` : ""].filter(Boolean).join(" · ");
  } else if (id === "integration_stripe") {
    if (key !== "events") title = money(item.amount, item.currency) + " · " + title;
    if (item.refunded) state = "refunded";
    detail = item.refunded ? "Refunded" : key !== "events" ? "Payment " + text(item.id) : "Event " + text(item.id);
    url = text(item.id) ? `https://dashboard.stripe.com/${data.testMode ? "test/" : ""}${key === "events" ? "events" : "payments"}/${encodeURIComponent(text(item.id))}` : "";
  } else if (id === "integration_resend") {
    detail = Array.isArray(item.to) ? item.to.map(String).join(", ") : text(item.to);
    url = text(item.id) ? "https://resend.com/emails/" + encodeURIComponent(text(item.id)) : "";
  } else if (id === "integration_notion") { detail = "Edited " + (when(item.lastEditedAt) || "time not shared"); state = ""; }
  else if (id === "integration_calcom") { detail = [text(item.attendeeName), text(item.attendeeEmail)].filter(Boolean).join(" · "); }
  return { title, detail, url, time, state: integrationStatus(state) };
}
function highlights(id: string, data: Item): { label: string; value: string; category: string; glyph: string; tone?: string; color: string }[] {
  const choices = categories[id], items = integrationRows(id, data, choices[0][0]), latest = items[0];
  const colors: Record<string, string> = { "Branch": "var(--accent)", "Needs attention": "var(--red-text)", "Recent emails": "var(--accent)", "Delivered": "var(--green)", "Available balance": "var(--service-color)", "Recent payments": "var(--green)", "Activity": "var(--accent)", "Recent pages": "var(--ink-2)", "Last edited": "var(--amber)", "Latest page": "var(--accent)", "Next call": "var(--amber)", "Today": "var(--accent)", "Upcoming": "var(--green)", "Active workflows": "var(--accent)", "Failed runs": "var(--red-text)" };
  colors["Recent payments"] = "var(--accent)";
  colors["Paid payments"] = "var(--green)";
  const entry = (label: string, value: string, category = choices[0][0], glyph: string = ICONS.stack, tone?: string) => ({ label, value, category, glyph, tone, color: colors[label] ?? "var(--service-color)" });
  if (id === "integration_vercel") return [entry("Latest deploy", latest ? integrationStatus(latest.state).label : "No deployments", "deployments", SERVICE_ICONS[id], latest ? integrationStatus(latest.state).tone : "neutral"), entry("Branch", text(latest?.branch) || "Not shared", "deployments", ICONS.terminal), entry("Needs attention", String(integrationRows(id, data, "attention").length), "attention", ICONS.bang)];
  if (id === "integration_resend") return [entry("Recent emails", String(data.total ?? items.length), "emails", SERVICE_ICONS[id]), entry("Delivered", String(integrationRows(id, data, "delivered").length), "delivered", ICONS.check, "success"), entry("Needs attention", String(integrationRows(id, data, "attention").length), "attention", ICONS.bang)];
  if (id === "integration_stripe") return [entry("Available balance", money(data.balance, data.currency), "payments", SERVICE_ICONS[id]), entry("Recent payments", String(items.length), "payments", ICONS.stack), entry("Paid payments", String(integrationRows(id, data, "paid").length), "paid", ICONS.check, "success")];
  if (id === "integration_notion") return [entry("Recent pages", String(items.length), "pages", SERVICE_ICONS[id]), entry("Last edited", latest ? when(latest.lastEditedAt) || "Not shared" : "No pages", "pages", ICONS.timer), entry("Latest page", text(latest?.title) || "No recent pages", "pages", ICONS.doc)];
  if (id === "integration_calcom") return [entry("Next call", latest ? `${dateFormat.format(timestamp(latest.start))} ${clock.format(timestamp(latest.start))}` : "No upcoming calls", "bookings", SERVICE_ICONS[id]), entry("Today", String(integrationRows(id, data, "today").length), "today", ICONS.timer), entry("Upcoming", String(items.length), "bookings", ICONS.bubble)];
  return [entry("Latest run", latest ? integrationStatus(latest.status).label : "No runs", "executions", SERVICE_ICONS[id], latest ? integrationStatus(latest.status).tone : "neutral"), entry("Active workflows", String(list(data, "workflows").filter(item => item.active === true).length), "workflows", ICONS.integrations), entry("Failed runs", String(integrationRows(id, data, "attention").length), "attention", ICONS.bang)];
}

function itemFacts(id: string, key: string, item: Item): [string, string][] {
  const at = timestamp(item.lastEditedAt ?? item.updatedAt ?? item.createdAt ?? item.startedAt ?? item.start);
  const date = Number.isFinite(at) ? `${agendaDate.format(at)} · ${clock.format(at)}` : "";
  const duration = timestamp(item.stoppedAt) - timestamp(item.startedAt);
  const facts: [string, string][] = id === "integration_vercel" ? [["Branch", text(item.branch)], ["Commit", text(item.commitMessage)]]
    : id === "integration_n8n" ? [[key === "workflows" ? "Updated" : "Started", date], ["Duration", Number.isFinite(duration) && duration >= 0 ? `${Math.round(duration / 1000)} seconds` : ""], ["Mode", text(item.mode)]]
    : id === "integration_stripe" ? [[key !== "events" ? "Amount" : "Event", key !== "events" ? money(item.amount, item.currency) : text(item.type)], ["Created", date]]
    : id === "integration_resend" ? [["Recipient", Array.isArray(item.to) ? item.to.map(String).join(", ") : text(item.to)], ["Sent", date]]
    : id === "integration_calcom" ? [["When", date], ["Guest", text(item.attendeeName)], ["Email", text(item.attendeeEmail)]]
    : [["Edited", date]];
  return facts.filter(([, value]) => !!value);
}

/** Service summaries keep the shared shell, with compact layouts shaped by their content. */
export function renderIntegrationActivity(task: AgentTask, hooks: IntegrationCardHooks): HTMLElement | null {
  const info = State.integrations[task.id], choices = categories[task.id];
  if (!choices || !info?.configured || !info.loaded || info.error) return null;
  const data = info.data;
  const memory = memories.get(task.id) ?? { category: choices[0][0], query: "", selected: "", refreshing: false };
  memories.set(task.id, memory);
  if (!choices.some(([key]) => key === memory.category)) memory.category = choices[0][0];
  const full = hooks.detailOpen;
  const root = h("section", { class: `int-card integration-activity${full ? " integration-full" : ""}`, "aria-label": task.name, "data-service": task.id });
  const serviceColor = MIMO_PICKER_COLORS[task.id] ?? task.color;
  root.style.setProperty("--service-color", serviceColor);
  const rowIcon = (glyph: string, color: string, size = 12) => { const mark = icon(glyph, size); mark.classList.add("integration-summary-icon"); mark.style.color = color; return mark; };
  const openService = () => { Sound.play("tick"); if (task.id === "integration_n8n") void Bridge.openN8n(); else void Bridge.openUrl(dashboards[task.id]); };
  const openCategory = (category: string, selected = "") => { memory.category = category; memory.query = ""; memory.selected = selected; hooks.openDetail(); };
  const metrics = highlights(task.id, data);
  if (!full && task.id === "integration_vercel") {
    root.classList.add("github-card", "vercel-summary");
    const summary = h("div", { class: "github-summary" },
      h("div", { class: "github-compact-heading" }, dot(serviceColor, 6), h("b", { text: task.name }),
        h("button", { class: "github-expand vercel-expand", type: "button", "aria-label": "Expand Vercel", "data-focus-key": "expand", onclick: () => openCategory(memory.category) }, icon(ICONS.arrowUpRight, 13))));
    for (const item of metrics) {
      const tone = item.label === "Needs attention" ? Number(item.value) > 0 ? "failure" : "neutral" : item.tone ?? "neutral";
      summary.append(h("button", { class: "github-summary-row", type: "button", "data-state": tone,
        "aria-label": `${item.label}: ${item.value}`, title: `${item.label}: ${item.value}`, onclick: () => openCategory(item.category) },
        rowIcon(item.glyph, tone === "success" ? "var(--green)" : tone === "pending" ? "var(--amber)" : tone === "failure" ? "var(--red-text)" : "var(--dim)", 13),
        h("span", { text: item.label }), h("b", { text: item.value })));
    }
    root.append(summary);
    return root;
  }
  if (!full) {
    root.append(h("div", { class: "integration-activity-head" }, dot(serviceColor, 6), h("b", { text: task.name }),
      h("span", { class: "integration-compact-kind", text: choices[0][1] }), h("button", { class: "integration-expand", type: "button", "aria-label": "Expand " + task.name, "data-focus-key": "expand", onclick: () => openCategory(memory.category) }, icon(ICONS.arrowUpRight, 12))));
    const layouts: Record<string, string> = { integration_vercel: "deployment", integration_resend: "mail", integration_stripe: "receipt", integration_notion: "pages", integration_calcom: "agenda", integration_n8n: "run" };
    const summary = h("div", { class: "integration-summary", "data-layout": layouts[task.id] });
    const ordered = task.id === "integration_notion" ? [metrics[2], metrics[0], metrics[1]] : metrics;
    const feature = ordered[0], latest = integrationRows(task.id, data, choices[0][0])[0];
    const named = task.id === "integration_vercel" || task.id === "integration_n8n";
    const isAgenda = task.id === "integration_calcom" && !!latest;
    const headline = isAgenda ? clock.format(timestamp(latest.start)) : named ? text(latest?.projectName ?? latest?.name) || feature.value : feature.value;
    const caption = task.id === "integration_calcom" ? text(latest?.title) : named ? feature.value : "";
    const featureCopy = [h("span", { class: "integration-feature-label", text: task.id === "integration_resend" ? "Emails" : feature.label }),
      h("div", { class: "integration-feature-value" }, h("b", { text: headline }), caption ? h("small", { text: caption }) : null)];
    const featureButton = h("button", { type: "button", class: "integration-summary-row integration-compact-feature", "data-tone": feature.tone ?? "neutral", "data-number": String(task.id === "integration_stripe" || task.id === "integration_resend"), "aria-label": `${feature.label}: ${feature.value}${caption ? " · " + caption : ""}`, title: `${feature.label}: ${feature.value}${named ? " · " + headline : ""}${caption ? " · " + caption : ""}`, onclick: () => openCategory(feature.category) });
    if (isAgenda) {
      const start = new Date(timestamp(latest.start));
      featureButton.append(h("span", { class: "integration-agenda-badge", "aria-hidden": "true" },
        h("small", { text: start.toLocaleDateString(undefined, { month: "short" }) }), h("b", { text: String(start.getDate()) })),
        h("div", { class: "integration-agenda-copy" }, ...featureCopy));
    } else featureButton.append(...featureCopy);
    summary.append(featureButton);
    const small = h("div", { class: "integration-compact-metrics" });
    for (const item of ordered.slice(1)) {
      const label = ({ "Recent payments": "Payments", "Paid payments": "Paid", "Recent pages": "Pages", "Last edited": "Edited", "Needs attention": "Attention", "Active workflows": "Active", "Failed runs": "Failed" } as Record<string, string>)[item.label] ?? item.label;
      small.append(h("button", { type: "button", class: "integration-summary-row", "data-tone": item.tone ?? "neutral", "aria-label": `${item.label}: ${item.value}`, title: `${item.label}: ${item.value}`, onclick: () => openCategory(item.category) }, rowIcon(item.glyph, item.color, 11), h("span", { text: label }), h("b", { text: item.value })));
    }
    const items = integrationRows(task.id, data, choices[0][0]);
    const recent = task.id === "integration_notion" && items.length > 1 ? items.slice(1, 3) : items.slice(0, task.id === "integration_n8n" ? 1 : 3);
    if (recent.length) {
      const history = h("div", { class: "integration-recent", role: "group", "aria-label": "Recent " + choices[0][1].toLowerCase() });
      for (const item of recent) {
        const value = rowData(task.id, choices[0][0], item, data);
        const duration = timestamp(item.stoppedAt) - timestamp(item.startedAt);
        const label = task.id === "integration_stripe" ? money(item.amount, item.currency)
          : task.id === "integration_vercel" ? text(item.branch) || value.state.label
          : task.id === "integration_n8n" ? Number.isFinite(duration) && duration >= 0 ? `${Math.round(duration / 1000)}s` : value.state.label
          : task.id === "integration_notion" ? text(item.title) || "Untitled"
          : task.id === "integration_calcom" ? clock.format(timestamp(item.start)) : value.state.label;
        const color = task.id === "integration_notion" ? "var(--accent)" : value.state.tone === "success" ? "var(--green)" : value.state.tone === "failure" ? "var(--red-text)" : value.state.tone === "pending" ? "var(--amber)" : "var(--dim)";
        history.append(h("button", { type: "button", "data-item": text(item.id), "data-tone": value.state.tone, "aria-label": `View ${value.title}${task.id === "integration_notion" ? "" : " · " + value.state.label}`, title: [value.title, value.state.label, value.detail, value.time].filter(Boolean).join(" · "), onclick: () => openCategory(choices[0][0], text(item.id)) },
          task.id === "integration_notion" ? rowIcon(ICONS.doc, color, 9) : dot(color, 4), h("span", { text: label })));
      }
      summary.append(history);
    }
    summary.append(small);
    root.append(summary); return root;
  }
  const id = "service-workspace-" + ++sequence;
  const status = h("span", { class: "integration-activity-status", role: "status", text: memory.refreshing ? "Refreshing…" : "" });
  const refresh = h("button", { class: "integration-icon-button", type: "button", "aria-label": "Refresh " + task.name, "data-focus-key": "refresh", disabled: memory.refreshing, onclick: async () => {
    if (memory.refreshing) return;
    const focusedRefresh = document.activeElement === refresh;
    Sound.play("tick"); memory.refreshing = true; refresh.disabled = true; root.setAttribute("aria-busy", "true"); status.textContent = "Refreshing…";
    let failed = false;
    try { await Bridge.refreshIntegration(task.id); } catch { failed = true; }
    finally {
      memory.refreshing = false;
      const retained = document.querySelector<HTMLElement>(`.integration-full[data-service="${task.id}"]`);
      retained?.removeAttribute("aria-busy");
      const button = retained?.querySelector<HTMLButtonElement>('[data-focus-key="refresh"]'); if (button) button.disabled = false;
      if (focusedRefresh && button && document.activeElement === document.body) button.focus({ preventScroll: true });
      const message = retained?.querySelector<HTMLElement>(".integration-activity-status"); if (message) message.textContent = failed ? "Couldn't refresh. Try again." : "";
    }
  } }, icon(ICONS.refresh, 14));
  if (memory.refreshing) root.setAttribute("aria-busy", "true");
  root.append(h("div", { class: "integration-workspace-head" }, h("button", { class: "integration-back", type: "button", "data-focus-key": "back", onclick: hooks.closeDetail }, icon(ICONS.chevronLeft, 11), "Back"),
    dot(task.color, 6), h("h1", { text: task.name }), task.id === "integration_stripe" && data.testMode ? h("span", { class: "integration-mode", text: "Test mode" }) : null,
    h("span", { class: "integration-workspace-spacer" }), refresh, h("button", { class: "integration-icon-button", type: "button", "aria-label": "Open " + task.name, onclick: openService }, icon(ICONS.arrowUpRight, 14))));
  root.append(h("div", { class: "integration-metrics" }, ...metrics.map(item => h("button", { type: "button", "data-tone": item.tone ?? "neutral", title: `${item.label}: ${item.value}`, onclick: () => choose(item.category) }, h("span", { class: "integration-metric-label" }, item.glyph === SERVICE_ICONS[task.id] ? null : rowIcon(item.glyph, item.color, 11), item.label), h("b", { text: item.value })))));
  const filter = h("input", { type: "search", class: "integration-activity-filter", "aria-label": "Filter " + task.name, "data-focus-key": "search", value: memory.query });
  const result = h("span", { class: "integration-result-count" });
  const rows = h("div", { id: id + "-panel", class: "integration-activity-rows", role: "tabpanel", tabindex: "0" });
  const detail = h("aside", { class: "integration-selection", hidden: true, "aria-label": "Selected item details" });
  const nav = h("div", { class: "integration-activity-tabs", role: "tablist", "aria-label": task.name + " content" });
  function choose(category: string, audible = true) {
    memory.category = category;
    if (audible) { memory.selected = ""; Sound.play("tick"); }
    for (const button of nav.querySelectorAll<HTMLButtonElement>("button")) { const selected = button.dataset.category === category; button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1; }
    rows.setAttribute("aria-labelledby", id + "-" + category);
    filter.placeholder = "Filter " + choices.find(([key]) => key === category)![1].toLowerCase() + "…"; draw();
  }
  for (const [key, label] of choices) nav.append(h("button", { id: id + "-" + key, type: "button", role: "tab", "data-category": key, "data-focus-key": key, "aria-controls": id + "-panel", onclick: () => choose(key) }, h("span", { text: label }), h("small", { text: String(integrationRows(task.id, data, key).length) })));
  nav.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const buttons = [...nav.querySelectorAll<HTMLButtonElement>("button")];
    const current = buttons.findIndex(button => button === document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus(); choose(buttons[next].dataset.category!);
  });
  function select(item: Item, value: ReturnType<typeof rowData>, audible = true) {
    memory.selected = text(item.id); if (audible) Sound.play("tick"); detail.hidden = false;
    const openItem = () => { Sound.play("tick"); if (task.id === "integration_n8n") void Bridge.openN8nPage(memory.category === "workflows" ? "workflow" : "executions", text(item.id)); else if (value.url) void Bridge.openUrl(value.url); };
    detail.replaceChildren(...[h("div", { class: "integration-selection-head" }, h("b", { text: value.title }),
      h("button", { class: "integration-icon-button", type: "button", "data-focus-key": "selected-close", "aria-label": "Close item details", onclick: () => { Sound.play("tick"); const selected = memory.selected; memory.selected = ""; detail.hidden = true; for (const row of rows.querySelectorAll<HTMLElement>("[data-selected]")) { row.dataset.selected = "false"; if (row.dataset.item === selected) row.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }); } } }, icon(ICONS.xmark, 11))),
      h("p", { text: [value.detail, value.time].filter(Boolean).join(" · ") }),
      task.id === "integration_calcom" && text(item.attendeeNotes) ? h("p", { class: "integration-notes", text: text(item.attendeeNotes) }) : null,
      value.url || task.id === "integration_n8n" ? h("button", { class: "integration-detail-action", type: "button", "data-focus-key": "selected-open", onclick: openItem }, "Open " + (task.id === "integration_notion" ? "page" : task.id === "integration_vercel" ? "deployment" : task.id === "integration_n8n" ? memory.category === "workflows" ? "workflow" : "execution" : task.id === "integration_resend" ? "email" : "in " + task.name), icon(ICONS.arrowUpRight, 10)) : null,
      task.id === "integration_vercel" && text(item.inspectorUrl) ? h("button", { class: "integration-log-link", type: "button", "data-focus-key": "selected-log", text: "Deployment details", onclick: () => { Sound.play("tick"); void Bridge.openUrl(text(item.inspectorUrl)); } }) : null,
      h("dl", { class: "integration-selection-facts" }, ...itemFacts(task.id, memory.category, item).map(([label, value]) => h("div", {}, h("dt", { text: label }), h("dd", { text: value, title: value }))))].filter(node => node !== null));
    for (const row of rows.querySelectorAll<HTMLElement>(".integration-activity-row")) row.dataset.selected = String(row.dataset.item === memory.selected);
  }
  function draw() {
    const query = memory.query.trim().toLowerCase();
    const source = integrationRows(task.id, data, memory.category).filter(item => JSON.stringify(item).toLowerCase().includes(query));
    result.textContent = `${source.length} ${source.length === 1 ? "result" : "results"}`; detail.hidden = true;
    const content: HTMLElement[] = [];
    let previousDate = "";
    for (const item of source.slice(0, 30)) {
      const value = rowData(task.id, memory.category, item, data);
      if (task.id === "integration_calcom") {
        const start = new Date(timestamp(item.start)), today = new Date(), tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
        const group = start.toDateString();
        if (group !== previousDate) content.push(h("h2", { class: "integration-agenda-date", text: group === today.toDateString() ? "Today" : group === tomorrow.toDateString() ? "Tomorrow" : agendaDate.format(start) }));
        previousDate = group;
      }
      content.push(h("div", { class: "integration-activity-row", "data-tone": value.state.tone, "data-item": text(item.id), "data-selected": String(!!text(item.id) && text(item.id) === memory.selected) },
        icon(task.id === "integration_notion" ? ICONS.doc : task.id === "integration_calcom" ? SERVICE_ICONS[task.id] : value.state.tone === "success" ? ICONS.check : value.state.tone === "failure" ? ICONS.bang : ICONS.timer, 13),
        h("button", { class: "integration-activity-link", type: "button", "data-focus-key": "row-" + text(item.id), title: value.title, onclick: () => select(item, value) }, h("b", { text: value.title }), value.detail ? h("span", { text: value.detail }) : null),
        task.id !== "integration_notion" ? h("span", { class: "integration-state", text: value.state.label }) : null, h("time", { text: task.id === "integration_calcom" ? clock.format(timestamp(item.start)) : value.time })));
    }
    rows.replaceChildren(...content);
    const selected = source.find(item => text(item.id) && text(item.id) === memory.selected); if (selected) select(selected, rowData(task.id, memory.category, selected, data), false);
    if (!source.length) rows.append(h("div", { class: "integration-activity-empty" }, icon(SERVICE_ICONS[task.id], 24), h("b", { text: query ? "No matching items" : memory.category === "attention" ? "Nothing needs your attention" : "Nothing here yet" }), h("p", { text: query ? "Try another search." : "New activity from " + task.name + " appears here." })));
    shareVercelLayout();
  }
  filter.addEventListener("input", () => { memory.query = filter.value; memory.selected = ""; draw(); });
  root.append(nav, h("div", { class: "integration-filter-row" }, filter, result), rows, detail,
    h("div", { class: "integration-workspace-footer" }, h("span", { text: task.id === "integration_calcom" ? "Upcoming bookings · your local time" : "Recent activity from " + task.name }), status));
  if (Array.isArray(data.warnings) && data.warnings.length) root.append(h("details", { class: "integration-warning" }, h("summary", { text: "Some data isn't available" }), h("p", { text: data.warnings.map(String).join(" · ") })));
  root.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hooks.closeDetail(); } });
  function shareVercelLayout() {
    if (task.id !== "integration_vercel") return;
    root.classList.add("github-card", "github-full");
    const shared = { "integration-workspace-head": "github-workspace-heading", "integration-back": "github-back",
      "integration-icon-button": "github-icon-button", "integration-activity-tabs": "github-tabs", "integration-filter-row": "github-filter-row",
      "integration-activity-filter": "github-search", "integration-result-count": "github-result-count", "integration-activity-rows": "github-rows",
      "integration-activity-row": "github-row", "integration-activity-link": "github-row-link" };
    for (const [source, target] of Object.entries(shared)) root.querySelectorAll('.' + source).forEach(element => element.classList.add(target));
  }
  choose(memory.category, false);
  return root;
}
