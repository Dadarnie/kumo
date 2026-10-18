// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSource } from "./ts-test-loader.mjs";
const { integrationStatus, integrationRows, integrationMoney, integrationTimestamp } = await import(await loadSource("../src/core/integration-workspace.ts"));

test("deployment and delivery states distinguish waiting from failures", () => {
  for (const state of ["BUILDING", "queued", "sent"]) assert.equal(integrationStatus(state).tone, "pending");
  assert.equal(integrationStatus("CANCELED").tone, "neutral");
  assert.equal(integrationStatus("new-server-state").tone, "neutral");
  assert.equal(integrationStatus(null).label, "Not shared");
  const data = { deployments: [{ id: "running", state: "BUILDING" }, { id: "bad", state: "ERROR" }, { id: "ok", state: "READY" }] };
  assert.deepEqual(integrationRows("integration_vercel", data, "attention").map(item => item.id), ["bad"]);
  assert.deepEqual(integrationRows("integration_vercel", data, "ready").map(item => item.id), ["ok"]);
  assert.deepEqual(integrationRows("integration_vercel", data, "building").map(item => item.id), ["running"]);
  assert.deepEqual(integrationRows("integration_resend", { emails: [{ id: "sent", lastEvent: "sent" }, { id: "bad", lastEvent: "bounced" }] }, "attention").map(item => item.id), ["bad"]);
});

test("schedule shows future uncancelled calls in order and uses real start fields", () => {
  const now = new Date(2026, 9, 10, 10).getTime();
  const data = { bookings: [{ id: "tomorrow", start: now + 86400000 }, { id: "past", start: now - 1 }, { id: "later", start: now + 7200000 }, { id: "next", start: now + 3600000 }, { id: "cancelled", start: now + 1000, status: "cancelled" }, { id: "unknown", start: null }] };
  assert.deepEqual(integrationRows("integration_calcom", data, "bookings", now).map(item => item.id), ["next", "later", "tomorrow"]);
  assert.deepEqual(integrationRows("integration_calcom", data, "today", now).map(item => item.id), ["next", "later"]);
  assert.ok(Number.isNaN(integrationTimestamp(null)));
});

test("money respects currency minor units and never invents a missing balance", () => {
  assert.match(integrationMoney(12345, "usd"), /123\.45/);
  assert.match(integrationMoney(12345, "jpy"), /12,345/);
  assert.match(integrationMoney(12345, "kwd"), /12\.345/);
  assert.equal(integrationMoney(null, "usd"), "Not shared");
  assert.equal(integrationMoney(100, null), "Not shared");
  assert.equal(integrationMoney("oops", "usd"), "Not shared");
});

test("Stripe separates paid, pending, and refunded payments without double counting", () => {
  const data = { payments: [{ id: "paid", status: "succeeded", refunded: false }, { id: "refund", status: "succeeded", refunded: true }, { id: "pending", status: "pending" }, { id: "failed", status: "failed" }] };
  assert.deepEqual(integrationRows("integration_stripe", data, "paid").map(item => item.id), ["paid"]);
  assert.deepEqual(integrationRows("integration_stripe", data, "pending").map(item => item.id), ["pending"]);
  assert.deepEqual(integrationRows("integration_stripe", data, "refunded").map(item => item.id), ["refund"]);
  assert.equal(integrationStatus("refunded").label, "Refunded");
});
