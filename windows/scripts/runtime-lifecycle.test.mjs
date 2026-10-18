// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSource } from "./ts-test-loader.mjs";
const { Lifetime } = await import(await loadSource("../src/core/lifetime.ts"));
const { Sound } = await import(await loadSource("../src/core/sound.ts"));

test("teardown cancels reactions and releases registrations that finish after disposal", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lifetime = new Lifetime();
  let reactions = 0, stops = 0;
  lifetime.after(() => reactions++, 100);
  lifetime.own(() => stops++);
  lifetime.destroy(); lifetime.destroy();
  lifetime.own(() => stops++);
  lifetime.after(() => reactions++, 100);
  t.mock.timers.tick(1000);
  assert.equal(reactions, 0);
  assert.equal(stops, 2);
  assert.equal(lifetime.signal.aborted, true);
});

test("completed one-shot reactions are not retained by their owner", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lifetime = new Lifetime();
  let reactions = 0;
  lifetime.after(() => {
    reactions++;
    lifetime.after(() => reactions++, 100);
  }, 100);
  t.mock.timers.tick(100);
  assert.equal(reactions, 1);
  lifetime.destroy();
  t.mock.timers.tick(100);
  assert.equal(reactions, 1);
});

test("notification sources disconnect after ending and audio sleeps only after the last tail", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let context;
  class Context {
    state = "running";
    destination = {};
    sources = [];
    constructor() { context = this; }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    async decodeAudioData(bytes) { return { duration: 2, url: new TextDecoder().decode(bytes) }; }
    resume() { this.state = "running"; return Promise.resolve(); }
    suspend() { this.state = "suspended"; return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
    createBufferSource() {
      const source = { buffer: null, disconnected: false, onended: null,
        connect() {}, start() {}, stop() {}, disconnect() { this.disconnected = true; } };
      this.sources.push(source);
      return source;
    }
  }
  globalThis.window = { AudioContext: Context, setTimeout, clearTimeout };
  t.mock.method(globalThis, "fetch", async url => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(url).buffer }));
  try {
    await Sound.preload();
    Sound.play("open"); Sound.play("close");
    assert.equal(context.sources[0].buffer.url, "/sounds/console-open.wav", "Island expansion uses the selected standard recording");
    assert.equal(context.sources[1].buffer.url, "/sounds/console-close.wav", "Navigation uses the same 28-file pack");
    Sound.idle();
    t.mock.timers.tick(2000);
    assert.equal(context.state, "running", "sounds must not be clipped");
    context.sources[0].onended();
    t.mock.timers.tick(2000);
    assert.equal(context.state, "running");
    context.sources[1].onended();
    assert.ok(context.sources.every(source => source.disconnected && source.buffer === null && source.onended === null));
    t.mock.timers.tick(1500);
    assert.equal(context.state, "suspended");
    Sound.play("tick"); Sound.play("blip");
    assert.equal(context.sources[2].buffer.url, "/sounds/console-tick.wav", "File loading uses the selected progress tick");
    assert.equal(context.sources[3].buffer.url, "/sounds/console-blip.wav", "Panel clicks use the selected original recording");
    assert.equal(context.state, "running");
    Sound.setEnabled(false); Sound.play("gulp"); Sound.play("approve");
    assert.equal(context.sources.length, 4, "Mute covers the complete pack"); Sound.setEnabled(true);
    Sound.destroy(); Sound.destroy();
    assert.equal(context.state, "closed");
    assert.ok(context.sources.every(source => source.disconnected && source.buffer === null));
    await Sound.preload();
    assert.equal(context.state, "running", "a development remount can preload again");
  } finally {
    Sound.destroy();
    delete globalThis.window;
  }
});
