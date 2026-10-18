// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { loadSource } from "./ts-test-loader.mjs";

let clock = 10000;
mock.method(performance, "now", () => clock);
const { BotEngine, BOT_STATES, STATE_SOUND } = await import(await loadSource("../src/mimo/engine.ts"));
const { MIMO_PALETTE } = await import(await loadSource("../src/mimo/palette.ts"));
const { Sound } = await import(await loadSource("../src/core/sound.ts"));
const { mimoCursorGaze } = await import(await loadSource("../src/mimo/cursor.ts"));
const { mimoAppStatus, MIMO_VARIANTS } = await import(await loadSource("../src/mimo/status.ts"));
Sound.setEnabled(false);
let delays;
function mockDelays(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] }); delays = t.mock.timers;
  t.after(() => { delays = undefined; });
}
function advance(engine, ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 10) {
    clock += 10;
    delays?.tick(10);
    engine.update(0.01);
  }
}

test("VS Code pokes briefly annoy Mimo and repeated pokes trigger confusion while work stays intact", (t) => {
  mockDelays(t);
  const engine = new BotEngine(); engine.allowWorkPokes = true;
  let confused = 0; engine.onDizzy = () => { confused++; };
  for (const state of ["working", "thinking", "searching"]) {
    engine.setState(state);
    assert.equal(engine.canPoke, true);
    engine.slap(-1); advance(engine, 80);
    assert.ok(engine.ox < -.07);
    assert.equal(engine.currentExpression, 'annoyed');
    assert.equal(engine.state,state,'A playful reaction does not change the task');
    advance(engine,820);assert.equal(engine.currentExpression,state);
    engine.slap(); engine.slap();
    assert.equal(confused,['working','thinking','searching'].indexOf(state)+1);
    advance(engine,1800);assert.equal(engine.ox,0);
  }
  for (const state of ["approval", "question", "error", "ratelimit"]) {
    engine.setState(state); engine.slap(); advance(engine, 80);
    assert.equal(engine.canPoke, false); assert.equal(engine.ox, 0);
  }
  engine.allowWorkPokes = false; engine.setState("working");
  assert.equal(engine.canPoke, false, "Other work surfaces keep their existing interaction policy");
  engine.destroy();
});

test("confusion rolls capsule eyes rapidly around the body and shakes itself clear", (t) => {
  mockDelays(t);
  const engine = new BotEngine();
  engine.setState("dizzy");
  assert.equal(engine.currentEye, "pill");
  const tilts = []; let furthest = 0;
  for (let ms = 0; ms < 640; ms += 10) {
    advance(engine, 10); tilts.push(engine.tilt); furthest = Math.max(furthest, engine.orbit);
    assert.equal(engine.roll, 0, "The eyes orbit without overturning the head");
  }
  assert.ok(furthest > Math.PI * 3.9, "Two rapid revolutions complete within 650 ms");
  assert.equal(Math.max(...tilts), 0, "The head shake follows the eye roll");
  tilts.length = 0;
  for (let ms = 0; ms < 740; ms += 10) { advance(engine, 10); tilts.push(engine.tilt); }
  assert.ok(Math.min(...tilts) < -.08 && Math.max(...tilts) > .08, "The wet-dog shake alternates directions");
  assert.ok(engine.open < .1 && engine.oy > 0, "A brief lens reset and servo nod finish the shake");
  advance(engine, 250);
  assert.equal(engine.orbit, 0); assert.equal(engine.tilt, 0); assert.equal(engine.ox, 0);
  assert.equal(engine.open, 1); assert.ok(Math.abs(engine.oy) < .001, "The servo settles below a visible pixel");
  engine.setState("dizzy", true); advance(engine, 1350);
  assert.ok(engine.open < .1);
  engine.setState("approval");
  assert.equal(engine.open, 1, "Attention immediately reopens the lenses");
  advance(engine, 750);
  assert.equal(engine.orbit, 0); assert.ok(Math.abs(engine.tilt) < .001);
  assert.equal(engine.open, 1, "An approval cancels the lens reset immediately");
  engine.destroy();
});

test("mini Mimo occasionally winks one eye without replacing its task expression", (t) => {
  mockDelays(t);
  const engine = new BotEngine(); engine.isMini = true; engine.setState("working");
  advance(engine, 500); engine.nextMiniWink = clock / 1000 + .05;
  advance(engine, 200);
  assert.ok(engine.winkAmount > .8);
  assert.equal(engine.currentEye, "pill");
  assert.equal(engine.currentExpression, "working");
  advance(engine, 500); assert.equal(engine.winkAmount, 0);
  engine.setState("approval"); engine.wink(); advance(engine, 150);
  assert.equal(engine.winkAmount, 0, "Winks preserve attention states");
  engine.destroy();
});

test("destroyed companions cancel delayed reactions and release wake callbacks", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const engine = new BotEngine();
  engine.greet();
  engine.gulp();
  let wakes = 0;
  engine.onWake = () => wakes++;
  engine.destroy();
  engine.destroy();
  t.mock.timers.tick(3000);
  assert.equal(wakes, 0);
  assert.equal(engine.onWake, null);
});

test("cursor follows the entire desktop in either direction and resets on preview exit", () => {
  assert.deepEqual(mimoCursorGaze(388, 80, 388, 80), { x: 0, y: 0 });
  assert.ok(mimoCursorGaze(388, 160, 388, 80).y > 0);
  assert.deepEqual(mimoCursorGaze(-10000, -10000, 388, 80), { x: 0, y: 0 });
  assert.ok(mimoCursorGaze(1920, 1080, 32, 17).x > 0.99);
  assert.ok(mimoCursorGaze(-1920, 1080, 32, 17).x < -0.99);
});

test("gaze stays bounded even with invalid or distant cursor input", () => {
  const engine = new BotEngine();
  engine.lookX = 1000;
  engine.lookY = -1000;
  advance(engine, 500);
  assert.ok(Math.abs(engine.yaw) <= 1);
  assert.ok(Math.abs(engine.pitch) <= 1);
  engine.lookX = NaN;
  engine.lookY = Infinity;
  advance(engine, 200);
  assert.ok(Number.isFinite(engine.yaw) && Number.isFinite(engine.pitch));
});

test("desktop gaze uses Mochi's smooth response and settles without keeping frames awake", () => {
  const engine = new BotEngine();
  engine.lookX = 1;
  advance(engine, 160);
  assert.ok(Math.abs(engine.yaw - .62 * (1 - Math.pow(.0025, .16))) < .001);
  assert.ok(engine.yaw > .3 && engine.yaw < .45, "The eyes ease into a turn instead of snapping");
  advance(engine, 1000);
  assert.ok(Math.abs(engine.yaw - .62) < .002);
  assert.equal(engine.busy, false, "A settled cursor does not require continuous rendering");
  engine.lookX = 0;
  advance(engine, 1000);
  assert.ok(Math.abs(engine.yaw) < .002);
  engine.destroy();
});

test("gaze follows the same path at 30, 60 and 120 Hz", () => {
  for (const fps of [30, 60, 120]) {
    const engine = new BotEngine();
    engine.lookX = -1; engine.lookY = 1;
    for (let frame = 0; frame < fps / 2; frame++) {
      clock += 1000 / fps; engine.update(1 / fps);
    }
    const response = 1 - Math.pow(.0025, .5);
    assert.ok(Math.abs(engine.yaw + .62 * response) < .001);
    assert.ok(Math.abs(engine.pitch - .5 * response) < .001);
    engine.destroy();
  }
});

test("small Mimos retain Mochi's independent 0.5–2 second glances", (t) => {
  t.mock.method(Math, "random", () => .75);
  const engine = new BotEngine(); engine.isMini = true;
  engine.lookX = -1; engine.lookY = -1;
  engine.update(.01);
  assert.ok(engine.tgYaw > 0 && engine.tgPitch > 0, "Miniatures look independently of the desktop cursor");
  assert.ok(engine.nextWakeDelayMs >= 500 && engine.nextWakeDelayMs <= 2000);
  advance(engine, 1200);
  assert.equal(engine.busy, false, "The canvas parks between glances");
  engine.destroy();
});

test("gaze frames reuse the owned color buffer without mutating another Mimo", () => {
  const engine = new BotEngine(), other = new BotEngine();
  const color = engine.faceColor;
  engine.bodyColor = [.48, .36, 1];
  advance(engine, 400);
  assert.equal(engine.faceColor, color, "Per-frame color easing does not allocate another RGB array");
  assert.deepEqual(other.faceColor, [237/255,241/255,244/255]);
  engine.destroy(); other.destroy();
});

test("sleeping mode, its sound, badge and ear material are absent from the companion catalog", () => {
  assert.equal("sleeping" in BOT_STATES, false);
  assert.equal("sleeping" in STATE_SOUND, false);
  assert.equal("sleepy" in MIMO_VARIANTS, false);
  assert.equal("innerEar" in MIMO_PALETTE, false);
});

test("the compact companion opens its eyes once within 120 ms without another blink or body bounce", () => {
  const engine = new BotEngine();
  engine.wake();
  assert.equal(engine.state, "idle");
  let last = engine.open;
  for (let index = 0; index < 12; index++) {
    advance(engine, 10);
    assert.ok(engine.open >= last, "Eyes open continuously");
    assert.equal(engine.oy, 0);
    assert.equal(engine.roll, 0);
    last = engine.open;
  }
  assert.equal(engine.open, 1);
  advance(engine, 350);
  assert.equal(engine.open, 1, "The handoff does not replay a blink");
  engine.wake();
  assert.equal(engine.open, .2);
  advance(engine, 120);
  assert.equal(engine.open, 1);
});

test("idle parks between actions and delayed reactions can wake its frame loop", () => {
  const engine = new BotEngine();
  assert.ok(engine.nextWakeDelayMs >= 3000);
  let wakes = 0;
  engine.onWake = () => { wakes++; };
  engine.triggerEmote("love");
  assert.ok(wakes > 0);
});

test("slow idle blink has a deliberate closed interval and settles naturally", () => {
  const engine = new BotEngine();
  engine.blink(true);
  advance(engine, 180);
  assert.ok(engine.open < 0.1);
  advance(engine, 100);
  assert.ok(engine.open > 0.1 && engine.open < 0.85);
  advance(engine, 180);
  assert.equal(engine.open,1);
});

test("confusion keeps the head upright and preserves the three-click trigger", () => {
  const engine = new BotEngine();
  let confused = 0;
  engine.onDizzy = () => { confused++; engine.setState("dizzy"); };
  engine.slap();
  clock += 100;
  engine.slap();
  clock += 100;
  engine.slap();
  assert.equal(confused, 1);
  advance(engine, 650);
  assert.equal(engine.roll, 0);
  assert.ok(Math.abs(engine.tilt) <= 0.1);
});

test("a poke nudges the head a few pixels, springs back, and respects attention", () => {
  const engine = new BotEngine();
  engine.slap(-1);
  advance(engine, 80);
  assert.ok(engine.ox < -.07 && engine.ox >= -.1, "A tap from the right moves the head left by less than a tenth of its radius");
  advance(engine, 450);
  assert.equal(engine.ox, 0);
  assert.ok(Math.abs(engine.oy) < .002);
  engine.slap(1);
  advance(engine, 80);
  assert.ok(engine.ox > .07 && engine.ox <= .1);
  engine.setState("approval");
  advance(engine, 100);
  assert.equal(engine.ox, 0, "An attention state cancels the displacement");
  engine.slap(); advance(engine, 100);
  assert.equal(engine.ox, 0);
  engine.setState("idle");
  engine.slap(); advance(engine, 500);
  assert.equal(engine.ox, 0);
  assert.ok(Math.abs(engine.oy) < .002);
  engine.destroy();
});

test("playful expressions keep smooth gaze and park after their entrance settles", () => {
  const engine = new BotEngine();
  engine.lookX = 1;
  engine.triggerEmote("love");
  advance(engine, 500);
  assert.equal(engine.eyeOverride, "heart");
  assert.ok(engine.yaw > .5);
  assert.equal(engine.oy, 0);
  assert.equal(engine.sx, 1);
  assert.equal(engine.sy, 1);
  assert.equal(engine.busy, true);
  advance(engine, 900);
  assert.equal(engine.busy, false);
  engine.destroy();
});

test("confirmed integration readiness, loading and errors resolve to the sheet states", () => {
  const pending = {configured:true,loaded:false,error:null,data:{}};
  assert.equal(mimoAppStatus("idle"),"idle");
  assert.equal(mimoAppStatus("idle",{...pending,configured:false}),"idle");
  assert.equal(mimoAppStatus("idle",pending),"loading");
  assert.equal(mimoAppStatus("idle",{...pending,loaded:true}),"connected");
  assert.equal(mimoAppStatus("idle",pending,"integration_claude"),"connected");
  assert.equal(mimoAppStatus("thinking",{...pending,loaded:true}),"loading");
  assert.equal(mimoAppStatus("idle",{...pending,loaded:true,error:"Offline"}),"error");
});

test("status changes badge color, icon and eyes together after their handoff", (t) => {
  mockDelays(t);
  const engine = new BotEngine();
  for (const status of ["loading","connected","error"]) {
    engine.setStatus(status);
    advance(engine,350);
    assert.equal(engine.status,status);
    assert.equal(engine.badge.kind,MIMO_VARIANTS[status].icon);
    assert.equal(engine.currentEye,MIMO_VARIANTS[status].eye);
  }
});

test("main Mimo keeps contextual reactions, app icons and readiness badges", (t) => {
  mockDelays(t);
  const engine = new BotEngine();
  engine.setStatus("idle");
  assert.equal(engine.badge,null);
  engine.badgeMode = "menu";
  for (const [id, icon] of [["integration_stripe","stripe"],["integration_n8n","n8n"],["integration_github","github"],["integration_claude","vscode"],["integration_vercel","vercel"]]) {
    engine.setIntegration(id);
    advance(engine,120);
    assert.equal(engine.badge.kind,icon);
  }
  engine.setStatus("loading"); advance(engine,120); assert.equal(engine.badge.kind,"dots");
  engine.setStatus("connected"); advance(engine,120); assert.equal(engine.badge.kind,"check");
  advance(engine,1910); assert.equal(engine.badge.kind,"vercel");
  engine.setStatus("error"); advance(engine,120); assert.equal(engine.badge.kind,"cross");
  engine.setIntegration(null); engine.badgeMode="contextual";
  engine.setState("idle"); engine.setStatus("idle"); advance(engine,120); assert.equal(engine.badge,null);
});

test("service tint eases smoothly and Home returns to the reference silver", () => {
  const engine = new BotEngine();
  engine.bodyColor=[.48,.36,1]; advance(engine,400);
  assert.ok(engine.faceColor.every((value,i)=>Math.abs(value-engine.bodyColor[i])<.005));
  engine.bodyColor=null; advance(engine,400);
  assert.ok(engine.faceColor.every((value,i)=>Math.abs(value-[237/255,241/255,244/255][i])<.005));
});

test("a delayed transient gesture cannot overwrite a new owned state or another reaction", (t) => {
  t.mock.timers.enable({apis:["setTimeout"]});
  const engine = new BotEngine();
  engine.triggerEmote("yawn"); engine.setState("approval"); engine.setState("idle");
  t.mock.timers.tick(710);
  assert.equal(engine.eyeOverride,null);
  engine.triggerEmote("yawn"); engine.triggerEmote("love");
  t.mock.timers.tick(710);
  assert.equal(engine.eyeOverride,"heart");
});

test("completion stays composed and the retained confusion roll cancels on approval", () => {
  const engine = new BotEngine();
  engine.setState("finished");
  advance(engine, 400);
  assert.equal(engine.orbit,0,'Completion uses its check and small happy acknowledgment');
  assert.equal(engine.roll,0);
  advance(engine, 560);
  assert.equal(engine.orbit,0);
  engine.setState("dizzy");
  advance(engine, 300);
  assert.ok(engine.orbit>0,'The user retained the old confusion choreography with improved spirals');
  engine.setState("approval");
  assert.equal(engine.orbit,0);
  advance(engine, 610);
  assert.equal(engine.roll,0);
});

test("Completion keeps its readable state without a hop, tilt, or celebration loop", (t) => {
  mockDelays(t);
  const engine = new BotEngine();
  engine.setState("finished");
  advance(engine, 400);
  assert.equal(engine.currentExpression, "finished");
  assert.equal(engine.expressionPose.eye, "happy");
  assert.equal(engine.badge.kind, "check");
  assert.deepEqual(engine.badge.color.map(value => Math.round(value * 255)), [79, 178, 158],
    "Completion uses the same native mint green as Terminal");
  assert.equal(engine.oy, 0);
  assert.equal(engine.tilt, 0);
  assert.equal(engine.particles.length, 0);
  assert.equal(engine.orbit, 0);
  advance(engine, 2100);
  assert.equal(engine.particles.length, 0);
  assert.equal(engine.tweens.size, 0);
  assert.equal(engine.busy, false);
  for (const state of ["working", "approval", "question", "error", "ratelimit"]) {
    engine.setState(state);
    assert.equal(engine.currentExpression, state);
    assert.equal(engine.particles.length, 0);
  }
  engine.setState("working");
  assert.equal(engine.oy, 0);
  assert.equal(engine.tilt, 0);
  engine.destroy();
});
