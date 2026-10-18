// SPDX-License-Identifier: MIT
import { BotEngine } from "../src/mimo/engine";
import { drawMimoFace, drawMimoBackdrop, drawMimoBadge } from "../src/mimo/face";
import { MIMO_EXPRESSIONS, type MimoExpressionName } from "../src/mimo/expressions";
import { MIMO_VARIANTS, type MimoStatus } from "../src/mimo/status";
import { MIMO_APPS } from "../src/mimo/brands";
import { MIMO_PALETTE, MIMO_PICKER_COLORS } from "../src/mimo/palette";
import { Greeting } from "../src/mimo/greeting";
import { hexToRGB } from "../src/mimo/engine";
import { mimoCursorGaze } from "../src/mimo/cursor";
import { resizeCanvas } from "../src/core/canvas";
import { Sound } from "../src/core/sound";
import type { EyeShape } from "../src/mimo/engine";

Sound.setEnabled(false);
const live = document.querySelector<HTMLCanvasElement>("#live")!;
const engine = new BotEngine();
engine.tile = true;
engine.setStatus("idle");
const intro = document.querySelector<HTMLCanvasElement>("#intro")!;
const greeting = new Greeting(); greeting.start();
const studies: { name: MimoExpressionName; canvas: HTMLCanvasElement; size: number }[] = [];
let replayEngines: { engine: BotEngine; canvas: HTMLCanvasElement; size: number }[] = [];
let replayUntil = 0;
Object.assign(window, { mimoPreview: { engine, greeting, expressions: MIMO_EXPRESSIONS, selectExpression } });
engine.onDizzy = () => { engine.setState("dizzy"); setTimeout(() => engine.setState("idle"), 3300); };

function sample(parent: string, label: string, size: number, status: MimoStatus = "idle", lookX = 0, lookY = 0, eye?: EyeShape, appId?: string) {
  const figure = document.createElement("figure");
  const canvas = document.createElement("canvas");
  const caption = document.createElement("figcaption");
  caption.textContent = label;
  canvas.setAttribute("aria-label", label);
  const dpr = resizeCanvas(canvas, size, size);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(size / 2, size / 2);
  const radius = size * 0.3;
  const variant = MIMO_VARIANTS[status];
  const app = appId ? MIMO_APPS[appId] : undefined;
  const appColor = app?.icon === "vscode" ? MIMO_PALETTE.body
    : appId ? MIMO_PICKER_COLORS[appId] ?? app?.color : undefined;
  drawMimoBackdrop(ctx, radius, true);
  drawMimoFace(ctx, { radius, eye: eye ?? variant.eye, lookX, lookY, color: appColor ? hexToRGB(appColor) : undefined });
  if (status !== "idle" || app) drawMimoBadge(ctx, { radius, kind: app?.icon ?? variant.icon,
    color: appColor ?? variant.color, appColor });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  figure.append(canvas, caption);
  document.querySelector(parent)!.append(figure);
}
for (const status of ["loading", "connected", "error"] as const) {
  sample("#states", status, 96, status, status === "loading" ? -0.4 : 0);
  sample("#sizes", `${status} · 32 px`, 32, status);
}
for (const [label, x, y] of [["Left", -1, 0], ["Front", 0, 0], ["Right", 1, 0], ["Up", 0, -1], ["Down", 0, 1]] as const) sample("#directions", label, 80, "idle", x, y);
function expressionSample(name: MimoExpressionName, size: number, parent: string) {
  const figure = document.createElement("figure");
  figure.dataset.expression = name;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", `${MIMO_EXPRESSIONS[name].label}, ${size} pixels`);
  const caption = document.createElement("figcaption");
  caption.textContent = MIMO_EXPRESSIONS[name].label;
  const sampleEngine = new BotEngine();
  sampleEngine.tile = true;
  sampleEngine.setExpressionContext(name);
  sampleEngine.settlePose();
  const dpr = resizeCanvas(canvas, size, size);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sampleEngine.draw(ctx, size, size);
  sampleEngine.destroy();
  figure.append(canvas, caption);
  document.querySelector(parent)!.append(figure);
  studies.push({ name, canvas, size });
}
for (const name of Object.keys(MIMO_EXPRESSIONS) as MimoExpressionName[]) {
  expressionSample(name, 96, "#expressions");
  expressionSample(name, 32, "#compact-expressions");
}
for (const [id, app] of Object.entries(MIMO_APPS)) sample("#integrations", app.label, 80, "idle", 0, 0, undefined, id);
document.querySelector("#replay-intro")!.addEventListener("click", () => greeting.start());
document.querySelector("#replay-expressions")!.addEventListener("click", () => {
  for (const sample of replayEngines) sample.engine.destroy();
  replayEngines = studies.map(({name,canvas,size}) => {
    const engine = new BotEngine(); engine.tile = true;
    if (name === "dizzy") engine.setState("dizzy");
    else engine.setExpressionContext(name);
    return {engine,canvas,size};
  });
  replayUntil = performance.now() + 1800;
});
const controls = document.querySelector(".controls")!;
function selectExpression(name: MimoExpressionName) {
  engine.eyeOverride = null;
  engine.setExpressionContext(null);
  engine.setState("idle"); engine.setStatus("idle");
  if (name === "dizzy") engine.setState("dizzy");
  else engine.setExpressionContext(name === "dancing" ? "music" : name);
  if (name === "dancing") engine.triggerExpression("dancing", 1.6);
  for (const button of document.querySelectorAll<HTMLButtonElement>(".controls button")) {
    button.setAttribute("aria-pressed", String(button.dataset.expression === name));
  }
}
for (const name of Object.keys(MIMO_EXPRESSIONS) as MimoExpressionName[]) {
  const button = document.createElement("button");
  button.textContent = MIMO_EXPRESSIONS[name].label;
  button.dataset.expression = name;
  button.setAttribute("aria-pressed", String(name === "idle"));
  button.addEventListener("click", () => selectExpression(name));
  controls.append(button);
}
window.addEventListener("pointermove", (event) => {
  const rect = live.getBoundingClientRect();
  const gaze = mimoCursorGaze(event.clientX, event.clientY, rect.x + rect.width / 2, rect.y + rect.height / 2);
  engine.lookX = gaze.x; engine.lookY = gaze.y;
});
window.addEventListener("mouseout", (event) => { if (!event.relatedTarget) engine.lookX = engine.lookY = 0; });
live.setAttribute("role", "button"); live.tabIndex = 0;
live.setAttribute("aria-label", "Mimo companion");
live.addEventListener("click", () => engine.slap());
live.addEventListener("keydown", event => {
  if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
    event.preventDefault(); if (event.shiftKey) engine.pat(); else engine.slap();
  }
});
let patPoint = { x: 0, y: 0 }, patDirection: { x: number; y: number } | null = null;
let patAt = 0, loveAt = -Infinity;
function brush(event: PointerEvent) {
  patPoint = { x: event.clientX, y: event.clientY }; patAt = performance.now();
  if (patAt - loveAt >= 4000 && engine.pat()) loveAt = patAt;
}
live.addEventListener("pointerenter", event => { patDirection = null; brush(event); });
live.addEventListener("pointermove", event => {
  const dx = event.clientX - patPoint.x, dy = event.clientY - patPoint.y, distance = Math.hypot(dx, dy);
  if (distance >= 16 && performance.now() - patAt >= 180
    && (!patDirection || (dx * patDirection.x + dy * patDirection.y) / distance < -.15)) {
    patDirection = { x: dx / distance, y: dy / distance }; brush(event);
  }
});
live.addEventListener("pointerleave", () => { patDirection = null; });
let last = performance.now();
let raf = 0;
function frame(t: number) {
  const dt = Math.min(0.05, (t - last) / 1000); last = t;
  engine.update(dt);
  const dpr = resizeCanvas(live, 144, 144);
  const ctx = live.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, 144, 144);
  engine.draw(ctx, 144, 144);
  for (const sample of replayEngines) {
    if (t >= replayUntil) sample.engine.settlePose();
    sample.engine.update(dt);
    const sampleDpr = resizeCanvas(sample.canvas, sample.size, sample.size);
    const sampleCtx = sample.canvas.getContext("2d")!;
    sampleCtx.setTransform(sampleDpr, 0, 0, sampleDpr, 0, 0); sampleCtx.clearRect(0, 0, sample.size, sample.size);
    sample.engine.draw(sampleCtx, sample.size, sample.size);
  }
  if (t >= replayUntil && replayEngines.length) {
    for (const sample of replayEngines) sample.engine.destroy();
    replayEngines = [];
  }
  const introDpr = resizeCanvas(intro, 640, 150);
  const introCtx = intro.getContext("2d")!;
  introCtx.setTransform(introDpr, 0, 0, introDpr, 0, 0);
  greeting.draw(introCtx);
  raf = requestAnimationFrame(frame);
}
raf = requestAnimationFrame(frame);
document.addEventListener("visibilitychange", () => {
  cancelAnimationFrame(raf);
  if (!document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); }
});
window.addEventListener("pagehide", () => {
  cancelAnimationFrame(raf); engine.destroy(); greeting.interrupt();
  for (const sample of replayEngines) sample.engine.destroy();
}, { once: true });
