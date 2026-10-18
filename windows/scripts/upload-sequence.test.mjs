// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { loadSource } from "./ts-test-loader.mjs";

const sequence = await import(await loadSource("../src/upload/sequence.ts"));
const { mimoIntake } = await import(await loadSource("../src/mimo/face.ts"));
const { UploadSeq, USC } = sequence;
let clock = 100000;
mock.method(performance, "now", () => clock);

function frameAt(seconds) {
  clock += seconds * 1000;
  return UploadSeq.frame();
}

test("file intake opens as a wide top slot and leaves the neutral face mouth free", () => {
  const closed = mimoIntake(28, 0);
  const open = mimoIntake(28, .5);
  assert.equal(closed.h, 0);
  assert.ok(open.y < -16 && open.y + open.h < -12, "The intake sits above both eyes");
  assert.ok(open.w > 30 && open.h > 5 && open.w > open.h * 4, "The top slot stays wide and readable");
});

test("files released on either side lift above Mimo before descending into the mouth", () => {
  assert.equal(typeof sequence.fileIntakePose, "function");
  for (const [x, y] of [[72, 142], [310, 104], [572, 148]]) {
    UploadSeq.enterZone(x, y);
    frameAt(.45);
    UploadSeq.performDrop(1);
    const released = UploadSeq.frame();
    const initial = sequence.fileIntakePose(released);
    assert.equal(initial.x, x);
    assert.equal(initial.top, y + 14 - 21, "Releasing a file does not teleport it");
    const staged = frameAt(USC.T_SUCK_START - USC.T_DROP);
    const above = sequence.fileIntakePose(staged);
    assert.ok(Math.abs(above.x - (staged.mouthRect.x + staged.mouthRect.w / 2)) < .1);
    assert.ok(above.top + 42 * above.sy < above.clipY, "The whole file arrives above the mouth before swallowing");
    assert.ok(above.top >= USC.CARD_Y, "The staged file clears the header");
    assert.ok(above.top + 42 * above.sy <= staged.y - staged.d * .4, "The file arrives above Mimo's head");
    const middle = frameAt((USC.T_SUCK_END - USC.T_SUCK_START) * .7);
    const falling = sequence.fileIntakePose(middle);
    assert.ok(falling.top > above.top, "The final approach moves down from above");
    assert.ok(falling.top < falling.clipY && falling.top + 42 * falling.sy > falling.clipY,
      "The file disappears progressively through the mouth instead of fading beside it");
    const swallowed = frameAt((USC.T_SUCK_END - USC.T_SUCK_START) * .3 + .001);
    assert.equal(swallowed.fileVisible, false);
    UploadSeq.deactivate();
  }
});

test("post-drop cursor movement cannot pull the file away and completion still releases the scene", () => {
  UploadSeq.enterZone(270, 108);
  frameAt(.45);
  UploadSeq.performDrop(1);
  UploadSeq.updateCursor(620, 160);
  const eating = frameAt(.1);
  assert.equal(eating.cursorX, 270);
  assert.equal(eating.cursorY, 108);
  const finished = frameAt(USC.T_PROG_START - USC.T_DROP + 2);
  assert.equal(finished.progress, 1);
  assert.equal(finished.fileVisible, false);
  assert.equal(finished.mouth, 0);
  assert.equal(finished.chooseAlpha, 1);
  UploadSeq.deactivate();
  assert.equal(UploadSeq.isActive, false);
});

test("a long drag waits for an actual drop and restarting clears the previous intake", () => {
  UploadSeq.enterZone(260, 108);
  const hovering = frameAt(12);
  assert.equal(hovering.suck, 0);
  assert.equal(hovering.progress, 0);
  assert.equal(hovering.fileVisible, true);
  assert.equal(UploadSeq.dropped, false);
  UploadSeq.performDrop(1);
  frameAt(.3);
  UploadSeq.deactivate();
  UploadSeq.enterZone(120, 98);
  const restarted = UploadSeq.frame();
  assert.equal(UploadSeq.dropped, false);
  assert.equal(restarted.suck, 0);
  assert.equal(restarted.mouth, 0);
  assert.equal(restarted.progress, 0);
  UploadSeq.deactivate();
});

test("the completed choice stays available without keeping the upload animation awake", () => {
  UploadSeq.enterZone(170, 104);
  frameAt(.45);
  UploadSeq.performDrop(.2);
  assert.equal(UploadSeq.animating, true);
  const ready = frameAt(USC.T_PROG_START - USC.T_DROP + 1.6);
  assert.equal(ready.chooseAlpha, 1);
  assert.equal(UploadSeq.isActive, true, "The choice remains mounted until the user acts");
  assert.equal(UploadSeq.animating, false, "A completed choice needs no continuous frames");
  frameAt(30);
  assert.equal(UploadSeq.frame().chooseAlpha, 1);
  assert.equal(UploadSeq.animating, false);
  UploadSeq.deactivate();
});
