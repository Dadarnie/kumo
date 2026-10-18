// SPDX-License-Identifier: MIT
export type CalendarPeriod = "week" | "month" | "year";
export interface CalendarPoint { date: string; value: number }
export interface CalendarCell extends CalendarPoint { available: boolean; reported: boolean; level: number }

export const localDateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export const calendarDate = (key: string) => new Date(`${key}T12:00:00`);

/** Local noon keeps calendar columns stable across daylight-saving changes. */
export function calendarCells(points: readonly CalendarPoint[], period: CalendarPeriod, now = new Date(), weeks = 53): CalendarCell[] {
  const today = new Date(now); today.setHours(12, 0, 0, 0);
  const first = new Date(today);
  first.setDate(first.getDate() - (period === "week" ? 6 : period === "month" ? 29 : (weeks - 1) * 7));
  const start = new Date(first);
  if (period !== "week") start.setDate(start.getDate() - start.getDay());
  const end = new Date(today);
  if (period !== "week") end.setDate(end.getDate() + 6 - end.getDay());
  const readings = new Map(points.filter(point => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.value) && point.value >= 0).map(point => [point.date, point.value]));
  const maximum = Math.max(1, ...points.filter(point => point.date >= localDateKey(first) && point.date <= localDateKey(today)).map(point => Number.isFinite(point.value) ? point.value : 0));
  const cells: CalendarCell[] = [];
  for (const date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
    const key = localDateKey(date), value = readings.get(key) ?? 0;
    cells.push({ date: key, value, available: date >= first && date <= today, reported: readings.has(key), level: value > 0 ? Math.min(4, Math.max(1, Math.ceil(Math.sqrt(value / maximum) * 4))) : 0 });
  }
  return cells;
}

export function weeklyTotal(points: readonly CalendarPoint[], now = new Date()): number {
  const monday = new Date(now); monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  const start = localDateKey(monday), end = localDateKey(now);
  return points.reduce((total, point) => total + (point.date >= start && point.date <= end && Number.isFinite(point.value) && point.value > 0 ? point.value : 0), 0);
}
