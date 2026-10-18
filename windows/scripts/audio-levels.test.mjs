// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSource } from "./ts-test-loader.mjs";
const { AudioLevels, isSpotifySource, measuredPeak } = await import(
  await loadSource("../src/core/audio-levels.ts")
);

test("native peak sampling is needed only while at least one waveform listens", () => {
  const levels = new AudioLevels(), demand = [];
  const detach = levels.onDemand(active => demand.push(active));
  const first = levels.subscribe(() => {});
  const second = levels.subscribe(() => {});
  assert.deepEqual(demand, [false, true]);
  first(); first();
  assert.deepEqual(demand, [false, true]);
  second();
  assert.deepEqual(demand, [false, true, false]);
  const third = levels.subscribe(() => {});
  detach(); detach();
  third();
  assert.deepEqual(demand, [false, true, false, true, false]);
});
test("Spotify peak source excludes browsers and communication apps", () => {
  for (const source of [
    "Spotify.exe",
    "Spotify",
    "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify",
  ])
    assert.equal(isSpotifySource(source), true);
  for (const source of [
    "chrome.exe",
    "Discord.exe",
    "Zoom.exe",
    "Teams.exe",
    "not-spotify.exe",
    null,
  ])
    assert.equal(isSpotifySource(source), false);
});
test("measured levels are immutable, revisioned and reject malformed or stale input", () => {
  const levels = new AudioLevels();
  let calls = 0;
  levels.subscribe(() => calls++);
  assert.equal(levels.apply({ revision: 0, available: true, peak: 460 }), true);
  assert.equal(Object.isFrozen(levels.snapshot()), true);
  for (const data of [
    { revision: 0, available: true, peak: 0 },
    { revision: 1, available: true, peak: 1001 },
    { revision: 1, available: true, peak: NaN },
    { revision: 1, available: 1, peak: 0 },
  ])
    assert.equal(levels.apply(data), false);
  assert.equal(calls, 1);
  assert.equal(levels.snapshot().peak, 460);
  assert.equal(levels.apply({ revision: 1, available: false, peak: 0 }), true);
});

test("per-app metering selects the playing source and falls back to measured desktop audio", () => {
  const levels = new AudioLevels();
  const sources = { "spotify.exe": 650, "chrome.exe": 90, "vlc.exe": 480, "discord.exe": 1000 };
  assert.equal(levels.apply({revision:0,available:true,peak:650,sources}), true);
  assert.equal(measuredPeak(levels.snapshot(), "Chrome.exe"), 90);
  assert.equal(measuredPeak(levels.snapshot(), "vlc.exe"), 480);
  assert.equal(measuredPeak(levels.snapshot(), "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), 650);
  assert.equal(measuredPeak(levels.snapshot(), "unknown.exe"), 650);
  assert.equal(measuredPeak(levels.snapshot(), "C:\\Apps\\VLC\\vlc.exe"), 480);
  sources["chrome.exe"] = 999;
  assert.equal(measuredPeak(levels.snapshot(), "chrome.exe"), 90);
  assert.equal(Object.isFrozen(levels.snapshot().sources), true);
  for (const sources of [[], null, {"chrome.exe":1001}, {"chrome.exe":NaN}, {"":10}])
    assert.equal(levels.apply({revision:1,available:true,peak:0,sources}), false);
  assert.equal(levels.apply({revision:1,available:false,peak:0,sources:{}}), true);
  assert.equal(measuredPeak(levels.snapshot(), "chrome.exe"), undefined);
});

test("packaged players and source names resolve to audio processes; legacy peaks support any player", () => {
  const level = { revision: 0, available: true, peak: 900,
    sources: { "microsoft.media.player.exe": 240, "vlc.exe": 420, "chrome.exe": 90 } };
  assert.equal(measuredPeak(level, "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), 240);
  assert.equal(measuredPeak(level, "VideoLAN.VLC_paz6r1rewnh0a!App"), 420);
  assert.equal(measuredPeak(level, "Chrome"), 90);
  assert.equal(measuredPeak({ ...level, sources: { "chrome.exe": 0 } }, "Chrome"), 0);
  for (const source of ["Spotify.exe", "chrome.exe", "OtherPlayer.exe", null])
    assert.equal(measuredPeak({ revision: 1, available: true, peak: 480 }, source), 480);
});

test("measured waveform moves peaks left to right and keeps contrast during loud audio", async () => {
  const { MeasuredWaveform } = await import(await loadSource("../src/core/audio-waveform.ts"));
  const waveform = new MeasuredWaveform();
  const quiet = [...waveform.sample(30)];
  assert.ok(quiet[0] > 0.17, "Quiet audio remains visible");
  const attack = [...waveform.sample(700)];
  assert.ok(attack[0] > Math.max(...quiet) + 0.4);
  const release = [...waveform.sample(0)];
  assert.ok(release[0] < attack[0], "The leading edge responds to silence while recent peaks travel");
  waveform.reset();
  for (let index = 0; index < 6; index++) {
    const values = [...waveform.sample(index === 0 ? 1000 : 0)];
    assert.equal(values.indexOf(Math.max(...values)), index, "A real pulse can lead on every bar");
  }
  for (let index = 0; index < 30; index++) waveform.sample(950);
  for (const peak of [820, 1000, 880, 970, 840, 1000]) waveform.sample(peak);
  assert.ok(Math.max(...waveform.values) - Math.min(...waveform.values) > 0.15,
    "Strong audio retains lower pulses instead of clipping into a solid block");
  for (let index = 0; index < 30; index++) waveform.sample(0);
  assert.ok(waveform.values.every(value => value < 0.001), "Silence drains measured history");
  waveform.reset();
  assert.deepEqual(waveform.values, [0, 0, 0, 0, 0, 0]);
});
