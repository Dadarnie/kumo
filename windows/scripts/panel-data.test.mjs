// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSource } from "./ts-test-loader.mjs";

const { calendarCells, weeklyTotal } = await import(await loadSource("../src/core/activity-calendar.ts"));
const { githubChecksSummary, githubContributions } = await import(await loadSource("../src/core/github.ts"));

test("calendar preserves local dates, missing readings, and leap days", () => {
  const cells = calendarCells([{ date: "2024-02-29", value: 90 }, { date: "2024-03-01", value: 0 }], "month", new Date("2024-03-10T12:00:00"));
  assert.equal(cells.length % 7, 0);
  assert.deepEqual(cells.find(cell => cell.date === "2024-02-29"), { date: "2024-02-29", value: 90, level: 4, reported: true, available: true });
  assert.equal(cells.find(cell => cell.date === "2024-03-01").reported, true);
  assert.equal(cells.find(cell => cell.date === "2024-03-02").reported, false);
  assert.ok(cells.filter(cell => cell.date > "2024-03-10").every(cell => !cell.available));
  assert.equal(calendarCells([], "year", new Date("2026-10-10T12:00:00")).length, 371);
  const week = calendarCells([], "week", new Date("2024-03-10T12:00:00"));
  assert.equal(week.length, 7);
  assert.equal(week[0].date, "2024-03-04");
  assert.equal(week.at(-1).date, "2024-03-10");
});

test("weekly totals include this Monday through today without future or invalid readings", () => {
  assert.equal(weeklyTotal([{ date: "2026-10-04", value: 100 }, { date: "2026-10-05", value: 12 }, { date: "2026-10-10", value: 8 }, { date: "2026-10-11", value: 500 }, { date: "2026-10-06", value: NaN }, { date: "2026-10-07", value: -10 }], new Date("2026-10-10T23:30:00")), 20);
});

test("GitHub reports unreadable and absent CI separately from a successful build", () => {
  assert.deepEqual(githubChecksSummary({}), { label: "Not shared", state: "unknown" });
  assert.equal(githubChecksSummary({ checks: [{ state: "success" }, { state: "none" }] }).state, "unknown");
  assert.equal(githubChecksSummary({ checks: [{ state: "success" }, { state: "unknown" }] }).state, "unknown");
  assert.equal(githubChecksSummary({ checks: [{ state: "success" }, { state: "pending" }] }).state, "pending");
  assert.equal(githubChecksSummary({ checks: [{ state: "pending" }, { state: "failure" }] }).state, "failure");
  assert.deepEqual(githubChecksSummary({ checks: [{ state: "success" }] }), { label: "All green", state: "success" });
  assert.deepEqual(githubContributions({ contributions: [null, { date: "2026-10-10", count: 3 }, { date: "2026-10-09", count: 0 }, { date: "bad", count: 8 }, { date: "2026-10-08", count: -1 }] }), [{ date: "2026-10-10", value: 3 }, { date: "2026-10-09", value: 0 }]);
});
