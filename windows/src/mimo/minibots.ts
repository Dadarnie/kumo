// SPDX-License-Identifier: MIT
// Mini Mimos (pills + compact grid) — port of MiniBotCanvasView.
// Each canvas owns a BotEngine; the island's frame loop ticks every live one.

import { BotEngine, hexToRGB } from "./engine";
import { State, type AgentTask } from "../core/state";
import { miniNotification, miniNotificationTask, type MiniNotificationBadge } from "./notifications";
import { codingProvider } from "../core/coding";
import { codingQuiet } from "../core/coding-progress";
import { mimoAppStatus } from "./status";
import { MIMO_APPS } from "./brands";
import { resizeCanvas } from "../core/canvas";
import { icon, ICONS } from "../views/icons";

interface MiniBot {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  engine: BotEngine;
  cssSize: number;
  taskId: string;
  dpr: number;
  painted: boolean;
  badge: MiniNotificationBadge | null;
}

const live = new Map<HTMLCanvasElement, MiniBot>();

export function miniNotificationLabel(task: AgentTask): string {
  const current = miniNotificationTask(task, State.tasks, State.codingTask);
  return miniNotification(current, State.integrations[current.id], State.paused).label;
}

export function miniBotTask(task: AgentTask): AgentTask {
  return miniNotificationTask(task, State.tasks, State.codingTask);
}

function syncBadge(slot: HTMLElement, badge: MiniNotificationBadge | null) {
  slot.querySelector(".mini-notification")?.remove();
  if (!badge) return;
  const mark = document.createElement("i");
  mark.className = "mini-notification";
  mark.dataset.status = badge;
  mark.setAttribute("aria-hidden", "true");
  if (badge === "approval" || badge === "error") mark.append(icon(ICONS.bang, 7));
  slot.append(mark);
}

/**
 * Creates a mini Mimo whose **body** is `bodySize` CSS pixels across.
 *
 * The engine draws the body at 60 % of its canvas, so the canvas is
 * `bodySize / 0.6` and is centred in a `bodySize` slot, overflowing it — the
 * same thing SwiftUI does with a `.frame(width: 22/0.6)` inside a
 * `.frame(width: 22)`. Sizing the canvas itself to `bodySize` would shrink the
 * whole drawing to 60 %, which is what used to happen.
 */
export function createMiniBot(task: AgentTask, bodySize: number, contextual = false, color?: string): HTMLElement {
  const taskId = task.id;
  task = miniBotTask(task);
  const slot = document.createElement("span");
  slot.className = "mini";
  slot.classList.toggle("mini-small", bodySize <= 14);
  slot.style.width = `${bodySize}px`;
  slot.style.height = `${bodySize}px`;

  const canvas = document.createElement("canvas");
  const engineSize = bodySize / 0.6;
  const dpr = resizeCanvas(canvas, engineSize, engineSize);
  slot.append(canvas);
  const badge = miniNotification(task, State.integrations[task.id], State.paused).badge;
  syncBadge(slot, badge);

  const engine = new BotEngine();
  engine.isMini = true;
  const integration = task.isIntegration || !!codingProvider(task);
  engine.badgeMode = integration && !contextual ? "menu" : "contextual";
  engine.showBadge = !integration || contextual;
  engine.setIntegration(task.isIntegration || codingProvider(task) ? task.id : null);
  engine.bodyColor = color ? hexToRGB(color) : task.isIntegration && !codingProvider(task)
    ? hexToRGB(MIMO_APPS[task.id]?.color ?? task.color) : null;
  engine.setState(task.state, true);
  engine.setStatus(mimoAppStatus(task.state, State.integrations[task.id], task.id));
  if (task.emote) engine.setPermanentEmote(task.emote);
  if (task.miniEye) {
    engine.permanentEye = task.miniEye;
    engine.eyeOverride = task.miniEye;
    engine.eyeOverrideUntil = Number.POSITIVE_INFINITY;
  }

  live.set(canvas, { canvas, ctx: canvas.getContext("2d"), engine, cssSize: engineSize, taskId, dpr, painted: false, badge });
  return slot;
}

export function releaseMiniBot(canvas: HTMLCanvasElement) {
  live.get(canvas)?.engine.destroy();
  live.delete(canvas);
}

/** Drops every canvas no longer in the document (views are rebuilt wholesale). */
export function pruneMiniBots() {
  for (const [canvas] of live) {
    if (!canvas.isConnected) releaseMiniBot(canvas);
  }
}

export function syncMiniBotStates(tasks: AgentTask[]) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const preferred = State.codingTask;
  const slot = byId.get("integration_claude");
  const coding = slot ? miniNotificationTask(slot, tasks, preferred) : preferred;
  for (const mb of live.values()) {
    const task = mb.taskId === "integration_claude" ? coding : byId.get(mb.taskId);
    if (!task) continue;
    mb.engine.setState(task.state);
    mb.engine.setStatus(mimoAppStatus(task.state, State.integrations[task.id], task.id));
    const status = miniNotification(task, State.integrations[task.id], State.paused);
    const badge = status.badge;
    if (mb.badge !== badge) {
      mb.badge = badge;
      if (mb.canvas.parentElement) syncBadge(mb.canvas.parentElement, mb.badge);
    }
    const slot = mb.canvas.parentElement;
    if (slot) slot.dataset.paused = String(document.hidden || State.paused || codingQuiet(task));
    if (slot?.getAttribute("role") === "img") {
      const label = task.name + (status.label ? ", " + status.label : "");
      if (slot.getAttribute("aria-label") !== label) { slot.setAttribute("aria-label", label); slot.title = label; }
    }
  }
}

const visible = (canvas: HTMLCanvasElement) => canvas.isConnected && !canvas.closest("[inert], [hidden]");

/** Uses the island's existing visibility event; CSS owns the tiny highlight. */
export function pauseMiniBotAnimations(paused: boolean) {
  for (const mb of live.values()) if (mb.canvas.parentElement)
    mb.canvas.parentElement.dataset.paused = String(paused || State.paused);
}

export function tickMiniBots(dt: number) {
  for (const mb of live.values()) {
    // Inactive views remain mounted to preserve their state and transitions.
    // Their companion engines must not keep the island's shared RAF awake.
    if (!visible(mb.canvas)) continue;
    if (mb.dpr !== (window.devicePixelRatio || 1)) {
      mb.dpr = resizeCanvas(mb.canvas, mb.cssSize, mb.cssSize); mb.painted = false;
    }
    if (mb.painted && !mb.engine.busy && mb.engine.nextWakeDelayMs > 20) continue;
    const ctx = mb.ctx;
    if (!ctx) continue;
    mb.engine.update(dt);
    ctx.setTransform(mb.dpr, 0, 0, mb.dpr, 0, 0);
    ctx.clearRect(0, 0, mb.cssSize, mb.cssSize);
    mb.engine.draw(ctx, mb.cssSize, mb.cssSize);
    mb.painted = true;
  }
}

export const miniBotCount = () => live.size;

export function miniBotsBusy() {
  for (const {canvas,engine} of live.values()) if (visible(canvas) && engine.busy) return true;
  return false;
}
export function nextMiniBotWakeDelayMs() {
  let delay = Infinity;
  for (const {canvas,engine} of live.values()) if (visible(canvas)) delay = Math.min(delay,engine.nextWakeDelayMs);
  return delay;
}
