// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { loadSource } from "./ts-test-loader.mjs";

let clock = 10000;
mock.method(performance, "now", () => clock);
const { BotEngine } = await import(await loadSource("../src/mimo/engine.ts"));
const { Sound } = await import(await loadSource("../src/core/sound.ts"));
const { companionStateForView, expressionForContext, musicPerformanceActive, mimoDanceMotion, MIMO_EXPRESSIONS } = await import(await loadSource("../src/mimo/expressions.ts"));
const { normalizePower } = await import(await loadSource("../src/core/power.ts"));
Sound.setEnabled(false);
let delays;
function mockDelays(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] }); delays = t.mock.timers;
  t.after(() => { delays = undefined; });
}
function advance(engine, ms) {
  for (let i = 0; i < ms; i += 10) { clock += 10; delays?.tick(10); engine.update(.01); }
}

test("work and concentration are distinct expressions from the supplied sheet", () => {
  const engine = new BotEngine();
  engine.setState("working");
  assert.equal(engine.currentEye, "pill", "General work keeps fully rounded capsule eyes");
  engine.setExpressionContext("focus");
  assert.equal(engine.currentEye, "focus");
  engine.setExpressionContext(null);
  assert.equal(engine.currentEye, "pill");
  engine.setState("thinking");
  assert.equal(engine.currentExpression, "thinking");
});

test("expression changes close before switching eyes and reopen without a jump", () => {
  const engine = new BotEngine();
  engine.triggerEmote("love");
  advance(engine, 40);
  assert.equal(engine.expressionPose.eye, "pill");
  assert.ok(engine.expressionPose.open > 0 && engine.expressionPose.open < 1);
  advance(engine, 60);
  assert.equal(engine.expressionPose.eye, "heart");
  assert.ok(engine.expressionPose.open < .2);
  const opening = engine.expressionPose.open;
  engine.triggerEmote("wink");
  advance(engine, 10);
  assert.ok(Math.abs(engine.expressionPose.open - opening) < .1, "Interruption starts from the visible eyelid position");
  advance(engine, 320);
  assert.equal(engine.expressionPose.eye, "wink");
  assert.equal(engine.expressionPose.open, 1);
});

test("ambient expressions and hover cannot override an owned approval or error", () => {
  const engine = new BotEngine();
  engine.setExpressionContext("music");
  assert.equal(engine.currentExpression, "music");
  engine.setState("approval");
  engine.triggerEmote("love");
  assert.equal(engine.currentExpression, "approval");
  engine.setState("error");
  assert.equal(engine.currentExpression, "error");
  engine.setState("idle");
  assert.equal(engine.currentExpression, "music");
});

test("expressions ease into their pose and real playback keeps its local performance", () => {
  const engine = new BotEngine();
  engine.triggerEmote("surprised");
  advance(engine, 300);
  assert.equal(engine.expressionPose.eye, "wide");
  assert.equal(engine.expressionPose.open, 1);
  assert.equal(engine.busy, true);
  engine.setExpressionContext("music");
  engine.triggerExpression("dancing", 1.6);
  advance(engine, 2800);
  assert.equal(engine.currentExpression, "music");
  assert.equal(engine.busy, true, "Confirmed playback animates the whistle and notes");
  assert.equal(engine.oy, 0); assert.equal(engine.tilt, 0);
  advance(engine, 19000);
  assert.equal(engine.currentExpression, "music");
  assert.equal(engine.busy, true, "The performance keeps animating while playback owns its context");
  engine.destroy();
});

test("playback alternates a long whistle with short dances and stops when its context leaves", () => {
  const engine = new BotEngine();
  engine.setExpressionContext("music");
  advance(engine, 1000);
  assert.equal(engine.currentExpression, "music");
  advance(engine, 13200);
  assert.equal(engine.currentExpression, "dancing");
  advance(engine, 900);
  assert.equal(engine.expressionPose.expression, "dancing");
  advance(engine, 3300);
  assert.equal(engine.currentExpression, "music");
  advance(engine, 900);
  assert.equal(engine.expressionPose.expression, "music");
  engine.setState("approval");
  advance(engine, 19500);
  assert.equal(engine.currentExpression, "approval");
  assert.equal(engine.busy, false, "An attention pose suspends the playback performance");
  engine.setState("idle");
  advance(engine, 900);
  assert.equal(engine.currentExpression, "music", "Returning starts with the composed whistle");
  engine.setExpressionContext(null);
  advance(engine, 1000);
  assert.equal(engine.currentExpression, "idle");
  assert.equal(engine.busy, false);
  engine.destroy();
});

test("the short dance travels both ways, stays inside its allocation, and settles at both ends", () => {
  const frames=Array.from({length:241},(_,index)=>mimoDanceMotion(index/60));
  assert.ok(Math.min(...frames.map(frame=>frame.x))<-.36);
  assert.ok(Math.max(...frames.map(frame=>frame.x))>.36);
  assert.ok(frames.every(frame=>Math.abs(frame.x)<=.38&&frame.y>=-.09&&frame.y<=0&&Math.abs(frame.tilt)<=.11));
  assert.ok(Math.min(...frames.map(frame=>frame.y))<-.085,'Two gentle steps accompany each sideways sway');
  for(const frame of [frames[0],frames.at(-1)]) assert.ok(Math.abs(frame.x)+Math.abs(frame.y)+Math.abs(frame.tilt)<.0001);
});

test("settled context poses park without repeated overdue idle wakeups", () => {
  const engine = new BotEngine();
  engine.setExpressionContext("focus");
  advance(engine, 16000);
  assert.equal(engine.busy, false);
  assert.equal(engine.nextWakeDelayMs, Infinity);
  engine.setExpressionContext("music"); advance(engine, 1000);
  assert.equal(engine.nextWakeDelayMs, Infinity);
  engine.destroy();
});

test("leaving a tab clears a temporary emotion without interrupting an owned confusion roll", () => {
  const engine = new BotEngine();
  engine.triggerEmote("love"); advance(engine, 400);
  engine.clearExpressionReaction(); advance(engine, 400);
  assert.equal(engine.currentExpression, "idle");
  engine.setState("dizzy"); advance(engine, 400);
  const orbit = engine.orbit;
  engine.clearExpressionReaction();
  assert.equal(engine.orbit, orbit);
  assert.equal(engine.currentExpression, "dizzy");
  engine.destroy();
});

test("three gentle pats show love, isolated pats expire, and requests keep priority", () => {
  const engine = new BotEngine();
  engine.setExpressionContext("music");
  engine.pat(); advance(engine, 250);
  assert.equal(engine.currentExpression, "music");
  engine.pat(); advance(engine, 250);
  assert.equal(engine.currentExpression, "music");
  engine.pat(); advance(engine, 400);
  assert.equal(engine.currentExpression, "love");
  assert.equal(engine.expressionPose.eye, "heart");
  advance(engine, 2700);
  assert.equal(engine.currentExpression, "music");
  engine.pat(); advance(engine, 3100); engine.pat();
  assert.equal(engine.currentExpression, "music", "Old pats cannot build up indefinitely");
  advance(engine, 80);
  assert.ok(engine.tilt < 0, "A gentle pat is acknowledged with a small local tilt");
  engine.setState("approval");
  advance(engine, 350);
  assert.ok(Math.abs(engine.tilt) < .005, "Attention cancels the old pat's tilt as well as its emotion");
  engine.pat(); engine.pat(); engine.pat(); advance(engine, 900);
  assert.equal(engine.currentExpression, "approval");
  assert.equal(engine.eyeOverride, null);
  engine.destroy();
});

test("playback performances belong only to the visible media player", () => {
  const context = { view: "media", expanded: true, enabled: true, playing: true };
  assert.equal(musicPerformanceActive(context), true);
  for (const view of ["overview", "integrations", "utilities", "usage", "approval", "prompt", "grab"]) {
    assert.equal(musicPerformanceActive({ ...context, view }), false);
  }
  for (const flag of ["expanded", "enabled", "playing"]) {
    assert.equal(musicPerformanceActive({ ...context, [flag]: false }), false);
  }
});

test("ambient cues use real context and reject unknown or invalid battery readings", () => {
  const context = { editing: false, focusedFile: false, emptyResult: false, missedApproval: false, playing: false };
  assert.equal(expressionForContext(context), null);
  assert.equal(expressionForContext({ ...context, playing: true }), "music");
  assert.equal(expressionForContext({ ...context, playing: true, focusedFile: true }), "focus");
  assert.equal(expressionForContext({ ...context, emptyResult: true }), "confused");
  assert.equal(expressionForContext({ ...context, missedApproval: true }), "worried");
  for (const invalid of [null, {}, { onBattery: null, percent: 0 }, { onBattery: false, percent: 10 },
    { onBattery: true, percent: null }, { onBattery: true, percent: 255 }, { onBattery: true, percent: -1 },
    { onBattery: true, percent: 19.5 }, { onBattery: true, percent: "10" }, { onBattery: true, percent: 21 }]) {
    assert.equal(expressionForContext({ ...context, power: normalizePower(invalid) }), null);
  }
  for (const percent of [0, 10, 20]) {
    assert.equal(expressionForContext({ ...context, power: normalizePower({ onBattery: true, percent }) }), "lowbattery");
  }
});

test("attention expressions retain their own eyes and badges above every ambient cue", (t) => {
  mockDelays(t);
  const engine = new BotEngine();
  for (const state of ["approval", "question", "error", "ratelimit", "finished", "dizzy"]) {
    engine.setState(state);
    for (const cue of ["focus", "music", "worried", "lowbattery"]) {
      engine.setExpressionContext(cue);
      engine.triggerEmote("love");
      advance(engine, 350);
      assert.equal(engine.currentExpression, state);
      assert.equal(engine.expressionPose.eye, MIMO_EXPRESSIONS[state].eye);
      assert.equal(engine.badge?.kind ?? null, MIMO_EXPRESSIONS[state].badge);
    }
  }
  engine.destroy();
});

test("pausing music cancels the bounded dance and preserves module identity colors", () => {
  const engine = new BotEngine();
  engine.setExpressionContext("music"); engine.triggerExpression("dancing");
  advance(engine, 130);
  engine.setExpressionContext(null);
  assert.equal(engine.currentExpression, "idle");
  advance(engine, 2200);
  assert.equal(engine.busy, false);
  engine.setIntegration("integration_claude"); engine.setExpressionContext("focus"); advance(engine, 400);
  assert.ok(engine.faceColor.every((v,i)=>Math.abs(v-[255 / 255, 244 / 255, 226 / 255][i])<.005));
  engine.bodyColor = [.5, .3, .8]; engine.setExpressionContext("error"); advance(engine, 400);
  assert.ok(engine.faceColor.every((v,i)=>Math.abs(v-[.5, .3, .8][i])<.005));
  engine.destroy();
});

test("approval cancels dance motion and ignores playful hover and triple clicks", () => {
  const engine = new BotEngine();
  engine.setExpressionContext("music"); engine.triggerExpression("dancing");
  advance(engine, 190);
  engine.setState("approval");
  let dizzy = false; engine.onDizzy = () => { dizzy = true; };
  engine.triggerEmote("proud"); engine.triggerExpression("dancing");
  engine.slap(); engine.slap(); engine.slap();
  advance(engine, 1200);
  assert.equal(engine.currentExpression, "approval");
  assert.equal(dizzy, false);
  assert.ok(Math.abs(engine.tilt) < .002, "Approval has its own motion, without the old dance tilt");
  assert.equal(engine.eyeOverride, null);
  engine.destroy();
});

test("tab ownership prevents background expressions from migrating into another tab", () => {
  const base = { view: "integrations", override: null, integrationState: "working", pendingApproval: false, mediaError: false };
  assert.equal(companionStateForView(base), "working");
  assert.equal(companionStateForView({ ...base, view: "overview" }), "working");
  const completed = { ...base, integrationState: "idle", integrationCompleted: true };
  assert.equal(companionStateForView(completed), "finished", "Retained Done results keep the completion expression and badge");
  assert.equal(companionStateForView({ ...completed, integrationState: "thinking" }), "thinking");
  assert.equal(companionStateForView({ ...completed, view: "media" }), "idle", "Completion stays with its own workspace");
  for (const view of ["media", "utilities", "usage"]) {
    assert.equal(companionStateForView({ ...base, view, override: "thinking" }), "idle");
  }
  assert.equal(companionStateForView({ ...base, view: "prompt", override: "thinking" }), "thinking");
  assert.equal(companionStateForView({ ...base, view: "media", mediaError: true }), "error");
  assert.equal(companionStateForView({ ...base, view: "confused", override: "dizzy" }), "dizzy");
  assert.equal(companionStateForView({ ...base, view: "media", pendingApproval: true }), "approval");
});

test("expressions hand off as one whole pose and avoid repeated head bobs or squash", () => {
  const engine = new BotEngine();
  engine.triggerEmote("love"); advance(engine, 400);
  assert.equal(engine.expressionPose.expression, "love");
  engine.triggerEmote("proud"); advance(engine, 40);
  assert.equal(engine.expressionPose.expression, "love");
  assert.equal(engine.expressionPose.eye, "heart");
  advance(engine, 60);
  assert.equal(engine.expressionPose.expression, "proud");
  assert.equal(engine.expressionPose.eye, "pill");
  for (const emote of ["love", "surprised", "proud", "wink", "yawn", "happy", "annoyed"]) {
    engine.triggerEmote(emote);
    advance(engine, 450);
    assert.equal(engine.oy, 0, `${emote} uses its own eyes/symbols without a generic bob`);
    assert.equal(engine.sx, 1); assert.equal(engine.sy, 1); assert.equal(engine.tilt, 0);
  }
  engine.destroy();
});

test("miniatures never shake or squash behind a higher-priority work expression", () => {
  const engine = new BotEngine(); engine.isMini = true;
  engine.setState("working"); engine.setPermanentEmote("annoyed");
  advance(engine, 1000);
  for (let i = 0; i < 80; i++) {
    advance(engine, 50);
    assert.equal(engine.currentExpression, "working");
    assert.equal(engine.currentEye, "pill");
    assert.equal(engine.oy, 0); assert.equal(engine.tilt, 0);
    assert.ok(Math.abs(engine.yaw + .2) < .005, "Work owns gaze as well as eyes throughout a background reaction interval");
  }
  engine.destroy();
});
