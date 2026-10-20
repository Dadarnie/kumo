// SPDX-License-Identifier: MIT
// Kumo "lantern" sound pack: 28 soft bell chimes in a warm D-major pentatonic.
// Fully synthesized here (no recordings or samples) and balanced to the same
// per-cue loudness targets the app's mixer expects.
// Run: node scripts/kumo-sounds.mjs   → writes assets/sounds/console-*.wav + manifest.json
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { peakLoudness, waveSamples } from "./sound-levels.mjs";

const RATE = 44100;
const OUT = fileURLToPath(new URL("../assets/sounds/", import.meta.url));

// Loudest-400 ms K-weighted targets per cue (soft hovers/clicks, clear attention cues).
const TARGET = {
  annoyed: -27.1, approval: -17.0, approve: -23.6, attach: -16.9, blip: -42.6, close: -34.1, dizzy: -18.7,
  error: -17.4, finish: -11.9, greet: -18.5, gulp: -21.0, hover: -50.3, love: -20.3, open: -31.3, peek: -29.6,
  pop: -36.2, proud: -16.9, question: -20.2, rate: -23.4, search: -27.8, send: -31.7, slap: -28.3, sleep: -30.7,
  think: -28.2, tick: -53.9, wink: -41.0, work: -32.6, yawn: -24.1,
};

const N = { A3: 220, D4: 293.66, E4: 329.63, F4: 349.23, Fs4: 369.99, A4: 440, B4: 493.88, D5: 587.33,
  E5: 659.26, Fs5: 739.99, A5: 880, B5: 987.77, D6: 1174.66, E6: 1318.51, Fs6: 1479.98 };
// [start s, frequency, length s, options]
const n = (at, f, len, o = {}) => ({ at, f, len, ...o });
const CUES = {
  peek: [n(0, N.A4, .3, { gain: .7 })],
  open: [n(0, N.D5, .22), n(.07, N.A5, .3)],
  close: [n(0, N.A5, .2), n(.07, N.D5, .3)],
  hover: [n(0, N.A5, .08, { gain: .6 })],
  blip: [n(0, N.B5, .1)],
  tick: [n(0, N.Fs6, .05, { decay: 60 })],
  send: [n(0, N.E5, .14), n(.06, N.A5, .22)],
  work: [n(0, N.D4, .4, { gain: .7 }), n(.02, N.A4, .35, { gain: .4 })],
  think: [n(0, N.Fs4, .35, { vibrato: 5 }), n(.22, N.A4, .45, { vibrato: 5 })],
  search: [n(0, N.E5, .12), n(.08, N.Fs5, .12), n(.16, N.A5, .2)],
  greet: [n(0, N.D5, .3), n(.09, N.Fs5, .3), n(.18, N.A5, .3), n(.27, N.D6, .5)],
  gulp: [n(0, 300, .28, { to: 170, bell: false })],
  finish: [n(0, N.D5, .6), n(.05, N.Fs5, .6), n(.1, N.A5, .7), n(.16, N.D6, .9)],
  approve: [n(0, N.A5, .2), n(.08, N.D6, .4)],
  approval: [n(0, N.E5, .22), n(.14, N.A5, .3), n(.42, N.E5, .22), n(.56, N.A5, .4)],
  question: [n(0, N.D5, .2), n(.16, N.E5, .4, { to: N.A5 })],
  error: [n(0, N.A4, .25), n(.16, N.F4, .3), n(.34, N.D4, .5)],
  rate: [n(0, N.B4, .18), n(.2, N.B4, .3)],
  attach: [n(0, N.B5, .1), n(.06, N.Fs5, .25)],
  pop: [n(0, N.B5, .12, { decay: 30 })],
  love: [n(0, N.Fs5, .3), n(.1, N.A5, .3), n(.2, N.D6, .5)],
  proud: [n(0, N.D5, .2), n(.08, N.A5, .25), n(.16, N.D6, .5)],
  wink: [n(0, N.E6, .08), n(.07, N.A5, .15)],
  yawn: [n(0, N.A4, .9, { to: N.D4, vibrato: 3 })],
  sleep: [n(0, N.D4, .7, { to: N.A3 }), n(.5, N.A3, .8, { gain: .6 })],
  slap: [n(0, 160, .12, { bell: false, decay: 30 }), n(.06, 120, .14, { bell: false, decay: 25 })],
  annoyed: [n(0, 200, .2, { bell: false, vibrato: 18 })],
  dizzy: [n(0, 520, .9, { to: 380, vibrato: 9 }), n(.3, 640, .6, { to: 460, vibrato: 9, gain: .5 })],
};

function synth(notes) {
  const length = Math.max(...notes.map(x => x.at + x.len)) + .04;
  const out = new Float64Array(Math.ceil(length * RATE));
  for (const x of notes) {
    let phase = 0;
    const start = Math.round(x.at * RATE), count = Math.round(x.len * RATE);
    for (let i = 0; i < count && start + i < out.length; i++) {
      const t = i / RATE, u = i / count;
      const f = x.f + ((x.to ?? x.f) - x.f) * (1 - Math.exp(-u * 3))
        + (x.vibrato ?? 0) * Math.sin(2 * Math.PI * 5.5 * t);
      phase += 2 * Math.PI * f / RATE;
      // Lantern bell: fundamental, soft octave and a slightly stretched third partial.
      const tone = x.bell === false ? Math.sin(phase) + .2 * Math.sin(2 * phase)
        : Math.sin(phase) + .35 * Math.sin(2 * phase) + .12 * Math.sin(3.01 * phase);
      const env = (1 - Math.exp(-t / .004)) * Math.exp(-t * (x.decay ?? 7)) * Math.min(1, (count - i) / (RATE * .015));
      out[start + i] += tone * env * (x.gain ?? 1);
    }
  }
  return out;
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24); head.writeUInt32LE(RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const files = [];
for (const [name, notes] of Object.entries(CUES)) {
  let s = synth(notes);
  const sourceSha = createHash("sha256").update(wav(s)).digest("hex");
  const path = `${OUT}console-${name}.wav`;
  const headroom = 10 ** (-6.05 / 20) / Math.max(...s.map(Math.abs));
  // Measure the written file exactly as playback analysis does (48 kHz, stereo).
  let gain = Math.min(1, headroom), bytes;
  for (let pass = 0; pass < 4; pass++) {
    const scaled = s.map(v => v * gain); scaled[0] = 0; scaled[scaled.length - 1] = 0;
    bytes = wav(scaled); writeFileSync(path, bytes);
    const measured = peakLoudness(waveSamples(path));
    gain = Math.min(gain * 10 ** ((TARGET[name] - measured) / 20), headroom);
  }
  const final = s.map(v => v * gain); final[0] = 0; final[final.length - 1] = 0;
  bytes = wav(final); writeFileSync(path, bytes);
  s = final;
  files.push({
    name, file: `console-${name}.wav`, source: "Kumo lantern synth (scripts/kumo-sounds.mjs)",
    channels: 1, sample_rate: RATE, bits_per_sample: 16, duration_seconds: s.length / RATE,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source_sha256: sourceSha,
    // Where headroom limits the gain, the achieved level becomes the cue's target.
    leveling: { target_db: Math.round(peakLoudness(waveSamples(path)) * 100) / 100,
      peak_db: Math.round(20 * Math.log10(Math.max(...s.map(Math.abs))) * 100) / 100 },
  });
}
writeFileSync(`${OUT}manifest.json`, JSON.stringify({
  name: "Kumo lantern sound pack", events: files.length, retained_cues: [], new_cues: files.length,
  format: "Synthesized 44.1 kHz mono PCM16; no recordings or samples.",
  leveling: { profile: "kumo-lantern-v1" }, files,
}, null, 2) + "\n");
console.log(`wrote ${files.length} cues`);
