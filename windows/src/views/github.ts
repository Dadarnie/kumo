// SPDX-License-Identifier: MIT
import { State, type AgentTask } from "../core/state";
import { Bridge } from "../core/bridge";
import { Sound } from "../core/sound";
import { compactNumber, dayKey } from "../core/activity";
import { calendarDate } from "../core/activity-calendar";
import { githubChecksSummary, githubContributions, githubList, githubText as text, type GitHubItem } from "../core/github";
import { h, dot } from "./dom";
import { icon, ICONS } from "./icons";
import { ActivityCalendar } from "./activity-calendar";
import type { IntegrationCardHooks } from "./integrations";
import "./github.css";

const memory = { preview: false, category: "pullRequests", query: "", selected: dayKey(), refreshing: false };
let sequence = 0;
const categories = [["pullRequests", "My PRs"], ["reviews", "To review"], ["issues", "Issues"], ["repositories", "Repositories"], ["activity", "Activity"], ["checks", "Checks"]] as const;
const branch = "M5 2.5a2.5 2.5 0 1 0 1 4.9v9.2a2.5 2.5 0 1 0-2 0V7.4A2.5 2.5 0 0 0 5 2.5ZM17 2.5a2.5 2.5 0 1 0-1 4.9V10a3 3 0 0 1-3 3H9v2h4a5 5 0 0 0 5-5V7.4A2.5 2.5 0 0 0 17 2.5Z";
const eye = "M12 5C6.5 5 2 12 2 12s4.5 7 10 7 10-7 10-7S17.5 5 12 5Zm0 2c3.5 0 6.7 3.8 7.6 5-.9 1.2-4.1 5-7.6 5s-6.7-3.8-7.6-5C5.3 10.8 8.5 7 12 7Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z";
const check = "M12 2.5 14 5l3-.2.7 3 2.8 1.4L19 12l1.5 2.8-2.8 1.4-.7 3-3-.2-2 2.5L10 19l-3 .2-.7-3-2.8-1.4L5 12 3.5 9.2l2.8-1.4.7-3 3 .2ZM10.5 14.7l6-6-1.4-1.4-4.6 4.6-2-2L7.1 11.3Z";

export function renderGitHub(task: AgentTask, hooks: IntegrationCardHooks): HTMLElement | null {
  const info = State.integrations[task.id];
  if (!info?.configured || !info.loaded || info.error) return null;
  const data = info.data, ci = githubChecksSummary(data);
  const login = text(data.login), profile = login ? `https://github.com/${encodeURIComponent(login)}` : "https://github.com";
  const full = hooks.detailOpen;
  const root = h("section", { class: `int-card github-card${full ? " github-full" : ""}`, "aria-label": "GitHub", "data-github-view": memory.preview ? "activity" : "summary" });
  if (full && memory.refreshing) root.setAttribute("aria-busy", "true");
  const prCount = data.openPullRequests == null ? githubList(data, "pullRequests").length : Number(data.openPullRequests);
  const reviewCount = data.reviewCount == null ? githubList(data, "reviews").length : Number(data.reviewCount);
  const open = (category: string) => { memory.category = category; hooks.openDetail(); };
  const expand = h("button", { class: "github-expand", type: "button", title: "Expand GitHub", "aria-label": "Expand GitHub", "data-focus-key": "expand", onclick: hooks.openDetail }, icon(ICONS.arrowUpRight, 13));

  if (!full) {
    const points = githubContributions(data);
    const mini = h("button", { class: "github-mini-calendar", type: "button", "aria-label": "Show contribution activity", title: "Contribution activity", onclick: () => showPreview(true) });
    const latest = points.slice(-7), maximum = Math.max(1, ...latest.map(point => point.value));
    for (let index = 0; index < 7; index++) mini.append(h("i", { "data-level": String(latest[index]?.value ? Math.max(1, Math.ceil(latest[index].value / maximum * 4)) : 0) }));
    const heading = h("div", { class: "github-compact-heading" }, dot(task.color, 6), h("b", { text: "GitHub" }),
      mini, expand);
    const summary = h("div", { class: "github-summary" }, heading);
    for (const [label, glyph, value, category, state] of [["My PRs", branch, String(prCount), "pullRequests", "open"], ["To review", eye, String(reviewCount), "reviews", "review"], ["Default branch CI", check, ci.label, "checks", ci.state]])
      summary.append(h("button", { class: "github-summary-row", type: "button", "data-state": state, onclick: () => open(category), title: category === "checks" ? "Default branch checks for up to three recently pushed repositories" : label }, icon(glyph, 13), h("span", { text: label }), h("b", { text: value })));
    const selected = h("span", { class: "github-preview-selection" });
    const back = h("button", { class: "github-preview-back", type: "button", "aria-label": "Back to GitHub overview", onclick: () => showPreview(false) }, icon(ICONS.chevronLeft, 11), "Activity");
    const preview = h("div", { class: "github-preview" }, h("div", { class: "github-preview-heading" }, back, selected, h("button", { class: "github-expand", type: "button", "aria-label": "Expand GitHub activity", onclick: hooks.openDetail }, icon(ICONS.arrowUpRight, 12))));
    let calendar: ActivityCalendar | null = null;
    function showCalendar() {
      if (calendar) return;
      calendar = new ActivityCalendar({ unit: "contributions", tone: "green", compact: true, weeks: 22, initialDate: memory.selected, onSelect: date => {
        memory.selected = date;
        const count = points.find(point => point.date === date)?.value;
        selected.textContent = `${calendarDate(date).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${count == null ? "No reading" : count + " contributions"}`;
      } });
      calendar.update(points);
      preview.append(calendar.el);
      if (!points.length) preview.append(h("span", { class: "github-calendar-empty", text: "Calendar not shared by this token." }));
    }
    if (memory.preview) showCalendar();
    root.append(summary, preview);
    function showPreview(value: boolean) { if (value) showCalendar(); memory.preview = value; root.dataset.githubView = value ? "activity" : "summary"; Sound.play(value ? "open" : "close"); (value ? back : mini).focus({ preventScroll: true }); }
    return root;
  }

  const id = `github-workspace-${++sequence}`;
  const status = h("span", { class: "github-update-status", role: "status" });
  const refresh = h("button", { class: "github-icon-button", type: "button", "aria-label": "Refresh GitHub", "data-focus-key": "refresh", disabled: memory.refreshing, onclick: async () => {
    if (memory.refreshing) return;
    const focusedRefresh = document.activeElement === refresh;
    Sound.play("tick"); memory.refreshing = true; refresh.disabled = true; root.setAttribute("aria-busy", "true"); status.textContent = "Refreshing…";
    try { await Bridge.refreshIntegration(task.id); } finally {
      memory.refreshing = false; refresh.disabled = false; root.removeAttribute("aria-busy"); status.textContent = "";
      const retained = document.querySelector<HTMLElement>(".github-full");
      retained?.removeAttribute("aria-busy");
      const retainedRefresh = retained?.querySelector<HTMLButtonElement>('[aria-label="Refresh GitHub"]');
      if (retainedRefresh) retainedRefresh.disabled = false;
      if (focusedRefresh && retainedRefresh && document.activeElement === document.body) retainedRefresh.focus({ preventScroll: true });
      const retainedStatus = retained?.querySelector(".github-update-status");
      if (retainedStatus) retainedStatus.textContent = "";
    }
  } }, icon(ICONS.refresh, 14));
  const back = h("button", { class: "github-back", type: "button", "data-focus-key": "back", onclick: hooks.closeDetail }, icon(ICONS.chevronLeft, 11), "Back");
  root.append(h("div", { class: "github-workspace-heading" }, back, dot(task.color, 6), h("h1", { text: "GitHub" }), h("span", { class: "github-login", text: login ? "@" + login : "Your workspace" }),
    h("span", { class: "github-workspace-counts", text: `${prCount} PRs · ${reviewCount} to review` }), refresh,
    h("button", { class: "github-icon-button", type: "button", "aria-label": "Open GitHub", onclick: () => void Bridge.openUrl(profile) }, icon(ICONS.arrowUpRight, 14))));
  const filter = h("input", { class: "github-search", type: "search", placeholder: "Filter your workspace…", "aria-label": "Filter GitHub", "data-focus-key": "search", value: memory.query });
  const results = h("span", { class: "github-result-count" });
  const rows = h("div", { id: id + "-panel", class: "github-rows", role: "tabpanel", tabindex: "0" });
  const nav = h("div", { class: "github-tabs", role: "tablist", "aria-label": "GitHub content" });
  function choose(category: string, audible = true) {
    memory.category = category;
    if (audible) Sound.play("tick");
    for (const button of nav.querySelectorAll<HTMLButtonElement>("button")) { const selected = button.dataset.category === category; button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1; }
    rows.setAttribute("aria-labelledby", `${id}-${category}`);
    filter.placeholder = "Filter " + categories.find(([key]) => key === category)?.[1].toLowerCase() + "…";
    draw();
  }
  for (const [key, label] of categories) nav.append(h("button", { id: `${id}-${key}`, role: "tab", type: "button", "data-category": key, "data-focus-key": key, "aria-controls": id + "-panel", "aria-selected": String(key === memory.category), tabindex: key === memory.category ? "0" : "-1", onclick: () => choose(key) }, h("span", { text: label }), h("small", { text: String(githubList(data, key).length) })));
  nav.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = [...nav.querySelectorAll<HTMLButtonElement>("button")], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const target = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    choose(buttons[target].dataset.category!); buttons[target].focus();
  });
  function draw() {
    const query = memory.query.trim().toLowerCase();
    const source = githubList(data, memory.category).filter(item => [item.title, item.name, item.repo, item.author, item.actor, item.branch, item.state].some(value => text(value).toLowerCase().includes(query)));
    results.textContent = `${source.length} ${source.length === 1 ? "item" : "items"}`;
    rows.replaceChildren(...source.map(item => githubRow(item, memory.category)));
    if (!source.length) rows.append(h("div", { class: "github-empty", role: "status" }, icon(query ? ICONS.doc : ICONS.check, 22),
      h("b", { text: query ? "No matches here." : memory.category === "reviews" ? "You're all caught up." : "A quiet moment." }),
      h("p", { text: query ? "Try a repository, title, or author." : memory.category === "checks" ? "Default branch checks aren't shared yet." : "New activity will appear here." })));
  }
  filter.addEventListener("input", () => { memory.query = filter.value; draw(); });
  root.append(nav, h("div", { class: "github-filter-row" }, filter, results), rows,
    h("div", { class: "github-workspace-footer" }, h("span", { text: `${compactNumber(Number(data.totalStars ?? 0))} stars · ${data.totalRepos ?? githubList(data, "repositories").length} repositories` }), status,
      h("span", { class: "github-ci-summary", "data-state": ci.state, text: "Default branches · " + ci.label })));
  if (Array.isArray(data.warnings) && data.warnings.length) root.append(h("details", { class: "github-warnings" }, h("summary", { text: "Some data isn't available" }), h("p", { text: data.warnings.map(String).join(" · ") })));
  root.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hooks.closeDetail(); } });
  choose(memory.category, false);
  return root;
}

function githubRow(item: GitHubItem, category: string): HTMLElement {
  const repo = text(item.repo) || text(item.name), state = text(item.state) || (item.draft ? "draft" : "open");
  const title = category === "activity" ? text(item.type).replace(/Event$/, "").replace(/([a-z])([A-Z])/g, "$1 $2") + " · " + repo : text(item.title ?? item.name ?? item.repo) || "GitHub activity";
  const detail = category === "repositories" ? `${item.stars ?? 0} stars · ${item.issues ?? 0} issues${item.private ? " · Private" : ""}` : category === "activity" ? text(item.actor) : category === "checks" ? `${text(item.branch)} · ${item.checkCount ?? 0} checks` : [repo, item.number ? "#" + item.number : "", text(item.author)].filter(Boolean).join(" · ");
  const value = item.updatedAt ?? item.createdAt;
  const date = value ? new Date(typeof value === "number" ? value : String(value)) : null;
  const age = date && Number.isFinite(date.getTime()) ? Math.max(0, (Date.now() - date.getTime()) / 3600000) : null;
  const when = age == null ? "" : age < 1 ? "now" : age < 24 ? Math.floor(age) + "h" : Math.floor(age / 24) + "d";
  const url = text(item.url);
  return h("div", { class: "github-row", "data-state": state }, h("span", { class: "github-row-icon", "aria-hidden": "true" }, icon(category === "checks" ? check : category === "repositories" ? ICONS.stack : category === "reviews" ? eye : branch, 15)),
    h("button", { class: "github-row-link", type: "button", title, disabled: !url, onclick: () => void Bridge.openUrl(url) }, h("b", { text: title }), h("span", { text: detail })),
    h("span", { class: "github-row-state", text: item.draft ? "Draft" : category === "checks" ? state === "success" ? "Passed" : state === "unknown" ? "Not shared" : state === "none" ? "No checks" : state === "pending" ? "Running" : "Failed" : category === "repositories" ? item.private ? "Private" : "Public" : category === "activity" ? "Event" : "Open" }),
    h("time", { text: when, ...(date && Number.isFinite(date.getTime()) ? { datetime: date.toISOString() } : {}) }));
}
