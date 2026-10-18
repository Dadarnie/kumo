// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSource } from "./ts-test-loader.mjs";

const { miniNotification, miniNotificationTask } = await import(await loadSource("../src/mimo/notifications.ts"));
const task = (state, pillBadge = null) => ({ id: "coding_codex", source: "codexCode", state, pillBadge, isIntegration: true });

test("Mini Mimos show work throughout thinking, searching, and working, then clear at rest", () => {
  for (const state of ["thinking", "searching", "working"]) {
    assert.deepEqual(miniNotification(task(state)), { badge: "working", label: "Working" });
  }
  for (const state of ["idle", "sleeping", "dizzy", "finished"]) {
    assert.deepEqual(miniNotification(task(state)), { badge: null, label: "" });
  }
});

test("Mini Mimos explain attention even without an unread activity badge", () => {
  for (const [state, label] of [["approval", "Needs approval"], ["question", "Needs an answer"], ["ratelimit", "Usage limit reached"]]) {
    assert.deepEqual(miniNotification(task(state)), { badge: "approval", label });
  }
  assert.deepEqual(miniNotification(task("error")), { badge: "error", label: "Needs attention" });
});

test("Pending attention takes priority over concurrent work and unread completion", () => {
  assert.deepEqual(miniNotification(task("working", "approval")), { badge: "approval", label: "Needs approval" });
  assert.deepEqual(miniNotification(task("thinking", "error")), { badge: "error", label: "Needs attention" });
  assert.equal(miniNotification(task("working", "finished")).badge, "working");
  assert.equal(miniNotification(task("question", "finished")).label, "Needs an answer");
});

test("Unread finished work and fresh service events retain their existing meaning", () => {
  assert.deepEqual(miniNotification(task("idle", "finished")), { badge: "finished", label: "Finished" });
  const service = { ...task("idle", "finished"), id: "integration_resend", source: "agent" };
  assert.deepEqual(miniNotification(service), { badge: "finished", label: "New activity" });
  service.pillBadge = null;
  assert.deepEqual(miniNotification(service), { badge: null, label: "" });
});

test("The shared coding Mimo follows live sessions and keeps other sessions' attention visible", () => {
  const slot = { ...task("idle"), id: "integration_claude", source: "claudeCode" };
  const live = { ...task("working"), id: "session_codex_live", isIntegration: false, sessionId: "live" };
  const waiting = { ...task("approval"), id: "session_claude_waiting", source: "claudeCode", isIntegration: false };
  assert.equal(miniNotificationTask(slot, [slot, live], slot), live);
  assert.equal(miniNotificationTask(slot, [slot, live, waiting], live), waiting);
  live.state = "idle"; live.pillBadge = "finished";
  assert.equal(miniNotificationTask(slot, [slot, live], slot), live);
  assert.equal(miniNotificationTask(live, [slot, live, waiting], waiting), live, "A session Mimo retains its own identity");
});

test("Only reported service execution creates an ongoing badge", () => {
  const service = id => ({ ...task("idle"), id, source: "n8n" });
  const info = data => ({ configured: true, loaded: true, error: null, data });
  for (const [id, data] of [["integration_vercel", { deployments: [{ state: "BUILDING" }] }],
    ["integration_n8n", { executions: [{ status: "running" }] }],
    ["integration_github", { checks: [{ state: "pending" }] }]]) {
    assert.equal(miniNotification(service(id), info(data)).badge, "working");
    assert.equal(miniNotification(service(id), { ...info(data), error: "Offline" }).badge, null);
    assert.equal(miniNotification(service(id), { ...info(data), loaded: false }).badge, null);
    assert.equal(miniNotification(service(id), info(data), true).badge, null);
  }
  assert.equal(miniNotification(service("integration_n8n"), info({ workflows: [{ active: true }] })).badge, null);
  assert.equal(miniNotification(service("integration_calcom"), info({ upcoming: [{ start: "tomorrow" }] })).badge, null);
});
