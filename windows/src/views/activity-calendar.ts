// SPDX-License-Identifier: MIT
import { calendarCells, calendarDate, localDateKey, weeklyTotal, type CalendarPoint, type CalendarPeriod } from "../core/activity-calendar";
import { compactNumber } from "../core/activity";
import { Sound } from "../core/sound";
import { h } from "./dom";
import "./activity-calendar.css";

const cellDateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const monthFormat = new Intl.DateTimeFormat(undefined, { month: "short" });
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const selectionFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

interface CalendarOptions {
  unit?: "tokens" | "contributions";
  tone?: "neutral" | "green";
  compact?: boolean;
  weeks?: number;
  weeklyHeading?: boolean;
  initialDate?: string;
  onSelect?: (date: string) => void;
}

/** Retained day cells: live readings never replace the focused chart control. */
export class ActivityCalendar {
  readonly el: HTMLElement;
  private heading = h("b", { text: "Tokens" });
  private caption = h("span", { class: "calendar-caption" });
  private selectedLabel = h("span", { class: "calendar-selection", "aria-live": "polite" });
  private grid = h("div", { class: "calendar-grid", role: "group", "aria-label": "Daily token activity" });
  private months = h("div", { class: "calendar-months", "aria-hidden": "true" });
  private total = h("span", { class: "calendar-total" });
  private weekValue = h("b", { class: "calendar-week-value" });
  private selected = localDateKey(new Date());
  private key = "";
  private points: readonly CalendarPoint[] = [];
  private period: CalendarPeriod = "year";
  private selectedButton: HTMLButtonElement | null = null;

  constructor(private options: CalendarOptions = {}) {
    this.selected = options.initialDate ?? this.selected;
    const legend = h("span", { class: "calendar-legend", "aria-label": "Activity from less to more" },
      h("span", { text: "Less" }), ...Array.from({ length: 5 }, (_, level) => h("i", { "data-level": String(level) })), h("span", { text: "More" }));
    this.el = h("section", { class: "activity-calendar", "data-tone": options.tone ?? "neutral", "data-compact": String(!!options.compact) },
      h("div", { class: "calendar-heading" }, this.heading, this.caption, options.weeklyHeading ? this.weekValue : null, options.unit === "contributions" ? this.selectedLabel : legend),
      this.grid, this.months,
      h("div", { class: "calendar-footer" }, this.total, options.unit === "contributions" ? legend : this.selectedLabel));
    this.grid.addEventListener("click", event => {
      const cell = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-date]");
      if (cell && !cell.disabled) this.select(cell.dataset.date!, true);
    });
    this.grid.addEventListener("keydown", event => {
      const shifts: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: this.period === "week" ? -1 : -7, ArrowRight: this.period === "week" ? 1 : 7 };
      if (!(event.key in shifts) && !["Home", "End"].includes(event.key)) return;
      const cells = [...this.grid.querySelectorAll<HTMLButtonElement>("button")];
      const index = cells.indexOf(document.activeElement as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault(); event.stopPropagation();
      const target = event.key === "Home" ? cells.findIndex(cell => !cell.disabled) : event.key === "End" ? cells.length - 1 - [...cells].reverse().findIndex(cell => !cell.disabled) : Math.max(0, Math.min(cells.length - 1, index + shifts[event.key]));
      if (!cells[target]?.disabled) { this.select(cells[target].dataset.date!, true); cells[target].focus({ preventScroll: true }); }
    });
  }

  update(points: readonly CalendarPoint[], period: CalendarPeriod = "year"): void {
    const previousPeriod = this.period;
    this.points = points; this.period = period;
    const key = JSON.stringify([points, period, localDateKey(new Date())]);
    if (key === this.key) return;
    this.key = key;
    const unit = this.options.unit ?? "tokens";
    this.heading.textContent = unit === "contributions" ? "Activity" : "Tokens";
    this.caption.textContent = this.options.weeklyHeading ? "this week" : period === "week" ? "last 7 days" : period === "month" ? "last 30 days" : this.options.compact ? "recent weeks" : "past year";
    const weekly = compactNumber(weeklyTotal(points));
    this.weekValue.textContent = points.length ? weekly : "—";
    this.total.textContent = points.length ? `${weekly} ${unit === "tokens" ? "tokens " : "contributions "}this week` : "No readings yet";
    this.grid.setAttribute("aria-label", `Daily ${unit}; use arrow keys to select a day`);
    const focusedDate = this.grid.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.date : null;
    const cells = calendarCells(points, period, new Date(), this.options.weeks ?? 53);
    this.el.dataset.period = period;
    this.el.dataset.empty = String(!points.length);
    this.el.style.setProperty("--calendar-columns", String(period === "week" ? 7 : cells.length / 7));
    const existing = new Map((previousPeriod === period ? [...this.grid.querySelectorAll<HTMLButtonElement>("button")] : []).map(button => [button.dataset.date!, button]));
    const buttons = cells.map(cell => {
      const date = calendarDate(cell.date), label = `${cellDateFormat.format(date)}: ${cell.reported ? compactNumber(cell.value) + " " + unit : "No recorded activity"}`;
      const button = existing.get(cell.date) ?? h("button", { type: "button", class: "calendar-cell", "data-date": cell.date, tabindex: "-1", "aria-pressed": "false" },
        period === "week" ? h("span", { text: cell.reported ? compactNumber(cell.value) : "—" }) : null,
        period === "week" ? h("small", { text: weekdayFormat.format(date) }) : null);
      for (const [name, value] of [["data-level", String(cell.level)], ["data-reported", String(cell.reported)], ["aria-label", label], ["title", label]])
        if (button.getAttribute(name) !== value) button.setAttribute(name, value);
      if (button.disabled === cell.available) button.disabled = !cell.available;
      if (period === "week") {
        const amount = cell.reported ? compactNumber(cell.value) : "—";
        const span = button.querySelector("span");
        if (span && span.textContent !== amount) span.textContent = amount;
      }
      return button;
    });
    if (buttons.length !== this.grid.children.length || buttons.some((button, index) => button !== this.grid.children[index])) this.grid.replaceChildren(...buttons);
    const labels: HTMLElement[] = [];
    let last = "";
    if (period !== "week") cells.forEach((cell, index) => {
      if (index % 7) return;
      const month = cell.date.slice(0, 7);
      if (month !== last && index / 7 <= cells.length / 7 - 3) {
        labels.push(h("span", { style: `grid-column:${index / 7 + 1} / span 3`, text: monthFormat.format(calendarDate(cell.date)) })); last = month;
      }
    });
    this.months.replaceChildren(...labels);
    if (!cells.some(cell => cell.date === this.selected && cell.available)) this.selected = localDateKey(new Date());
    this.select(this.selected);
    if (focusedDate) this.grid.querySelector<HTMLButtonElement>(`[data-date="${focusedDate}"]`)?.focus({ preventScroll: true });
  }

  private select(date: string, audible = false): void {
    const changed = this.selected !== date;
    this.selected = date;
    const button = this.grid.querySelector<HTMLButtonElement>(`[data-date="${date}"]`);
    if (button !== this.selectedButton) {
      if (this.selectedButton) { this.selectedButton.setAttribute("aria-pressed", "false"); this.selectedButton.tabIndex = -1; }
      if (button) { button.setAttribute("aria-pressed", "true"); button.tabIndex = 0; }
      this.selectedButton = button;
    }
    const value = this.points.find(point => point.date === date)?.value;
    const label = selectionFormat.format(calendarDate(date));
    this.selectedLabel.textContent = `${label} · ${value == null ? "No reading" : compactNumber(value) + " " + (this.options.unit ?? "tokens")}`;
    if (audible && changed) Sound.play("tick");
    this.options.onSelect?.(date);
  }
}
