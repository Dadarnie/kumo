// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSource } from "./ts-test-loader.mjs";
const { remainingPercent, windowLabel, resetLabel, resetAvailability } = await import(
  await loadSource("../src/core/codex-usage.ts"),
);

test("available resets distinguish future capacity from a reset needing confirmation", () => {
  assert.equal(resetAvailability(200, 0), "In 3m");
  assert.equal(resetAvailability(7500, 0), "In 2h 5m");
  assert.equal(resetAvailability(90000, 0), "In 1d 1h");
  assert.equal(resetAvailability(100, 200000), "Refresh to confirm");
  assert.equal(resetAvailability(null), "Not shared");
  assert.equal(resetAvailability(NaN), "Not shared");
});
const { sectionEnabled, safeSectionView, ownsContent } = await import(
  await loadSource("../src/core/sections.ts"),
);

test("Codex usage shows remaining limits and labels real windows", () => {
  assert.equal(remainingPercent({ usedPercent: 26.5 }), 73.5);
  assert.equal(remainingPercent({ usedPercent: 100 }), 0);
  assert.equal(windowLabel(300, "Session limit"), "5-hour limit");
  assert.equal(windowLabel(10080, "Weekly limit"), "1-week limit");
  assert.equal(windowLabel(null, "Session limit"), "Session limit");
  assert.equal(windowLabel(90, "Session limit"), "90-minute limit");
});
test("Usage reset labels stay truthful without a running countdown", () => {
  assert.equal(resetLabel(null), "Reset time unavailable");
  assert.equal(resetLabel(100, 200000), "Reset pending · refresh");
  assert.match(resetLabel(1900000000, 200000), /^Resets /);
});
test("Usage needs an enabled module, a connection, and the shared preference", () => {
  const modules = { media: true, vscode: true, developerIntegrations: true };
  assert.equal(sectionEnabled("usage", modules, 2, false, true), false);
  assert.equal(sectionEnabled("usage", modules, 2, true, false), false);
  assert.equal(sectionEnabled("usage", { ...modules, vscode: false }, 2, true, true), false);
  assert.equal(sectionEnabled("usage", modules, 2, true, true), true);
  assert.equal(safeSectionView("usage", modules, 2, false, true), "overview");
  assert.equal(safeSectionView("usage", modules, 2, true, true), "usage");
  assert.equal(ownsContent("usage"), true);
});
