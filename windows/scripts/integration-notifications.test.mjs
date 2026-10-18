// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSource } from "./ts-test-loader.mjs";

const { State, INTEGRATION_AGENTS } = await import(await loadSource("../src/core/state.ts"));
const { Sound } = await import(await loadSource("../src/core/sound.ts"));
const { handle } = await import(await loadSource("../src/island/integrations.ts"));
const { Visibility } = await import(await loadSource("../src/core/visibility.ts"));
Sound.play = () => {};
let next = 0;
const timers = new Map();
globalThis.window = { setTimeout: callback => { timers.set(++next, callback); return next; }, clearTimeout: id => timers.delete(id) };
const island = { reveal() {} };
const update = event => ({ id: "integration_resend", data: { total: 1 }, error: null, event });

function reset() {
  timers.clear();
  State.tasks = INTEGRATION_AGENTS.map(task => ({ ...task }));
  State.settings.modules.developerIntegrations = true;
  State.settings.activeIntegrations = ["integration_resend"];
  State.integrations = {};
  State.paused = false;
  State.view = "overview";
  Visibility.configure({ autoCollapseEnabled: false, autoCloseInterval: 1, rememberCompactState: false, lastVisibility: "expanded" });
  Visibility.expand();
  State.focusId = "integration_claude";
}

test("real integration events badge the mini Mimo until opened, even after its reaction settles", () => {
  reset();
  handle(island, update(null));
  const task = State.tasks.find(task => task.id === "integration_resend");
  assert.equal(task.pillBadge, undefined, "A reading alone is not new activity");
  handle(island, update({ success: true, label: "Email delivered", detail: null }));
  assert.equal(task.pillBadge, "finished");
  for (const callback of timers.values()) callback();
  assert.equal(task.state, "idle");
  assert.equal(task.pillBadge, "finished", "Unread activity outlives the temporary reaction");
  State.setFocus(task.id);
  assert.equal(task.pillBadge, null);
});

test("a focused service is unread when hidden, while its visible workspace acknowledges updates", () => {
  reset();
  State.focusId = "integration_resend";
  State.view = "media";
  handle(island, update({ success: false, label: "Email bounced", detail: null }));
  const task = State.tasks.find(task => task.id === "integration_resend");
  assert.equal(task.pillBadge, "error");
  State.setFocus(task.id);
  State.view = "overview";
  handle(island, update({ success: true, label: "Email delivered", detail: null }));
  assert.equal(task.pillBadge, null, "Visible activity should not appear unread");
});

test("paused or disabled integrations cannot create new badges", () => {
  reset();
  State.paused = true;
  handle(island, update({ success: true, label: "Email delivered", detail: null }));
  assert.equal(State.tasks.find(task => task.id === "integration_resend").pillBadge, undefined);
  State.paused = false;
  State.settings.activeIntegrations = [];
  handle(island, update({ success: false, label: "Email bounced", detail: null }));
  assert.equal(State.tasks.find(task => task.id === "integration_resend").pillBadge, undefined);
});
