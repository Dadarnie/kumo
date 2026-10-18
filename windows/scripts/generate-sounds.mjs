// SPDX-License-Identifier: MIT
// Mimo's original console UI palette. No recordings, samples, or instruments.
// Historical synthesizer for comparison. Prototypes go into ignored target/;
// the selected 28-file production pack is not overwritten.
import {mkdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {peakLoudness} from './sound-levels.mjs';

const sampleRate = 48000;
const outputGainDb = 1.5;
const outputDirectory = fileURLToPath(new URL('../target/sound-prototypes/legacy-console/', import.meta.url));
const note = (at, frequency, length, options = {}) => ({at, frequency, length, ...options});
const navigation = new Set(['peek','open','close','hover','blip','work','tick','send','search']);
const character = new Set(['slap','annoyed','dizzy','greet','gulp','love','pop','proud','wink','yawn','think','sleep']);
// Loudest 400 ms K-weighted levels measured from the historical set. Only the
// level targets are retained: generation never reads or transforms those WAVs.
const referenceLoudness = {
  annoyed:-27.09,approval:-17.01,approve:-23.64,attach:-16.88,blip:-42.62,
  close:-34.09,dizzy:-18.74,error:-17.44,finish:-11.94,greet:-18.47,gulp:-21.03,
  hover:-50.27,love:-20.26,open:-31.34,peek:-29.62,pop:-36.21,proud:-16.94,
  question:-20.22,rate:-23.41,search:-27.77,send:-31.65,slap:-28.28,
  sleep:-30.73,think:-28.24,tick:-53.90,wink:-40.98,work:-32.56,yawn:-24.11,
};
// Rounded digital plucks, tactile button transients and small, expressive bot
// chirps. The short gestures stay quiet; questions have a clear two-part lift.
// Frequencies and timing are composed here rather than derived from audio.
const sounds = {
  peek: {duration:.40, rms:.020, notes:[note(0,370,.28,{from:255,voice:'bot'}),note(.038,740,.20,{gain:.13})]},
  open: {duration:.43, rms:.022, click:.025, notes:[note(0,440,.26,{from:400,voice:'pulse'}),note(.065,660,.27,{gain:.38,voice:'glass'})]},
  close: {duration:.35, rms:.017, click:.02, notes:[note(0,440,.24,{from:520,to:370,voice:'pulse'})]},
  hover: {duration:.11, rms:.0045, click:.035, notes:[note(0,1175,.08,{voice:'pulse'})]},
  blip: {duration:.15, rms:.010, click:.025, notes:[note(0,990,.105,{from:1030,voice:'pulse'})]},
  // Slap: a small, higher "tu" followed by the round body's lower "dug".
  // Annoyed keeps one short "dug" with the same hollow material.
  slap: {duration:.58, rms:.029, gainDb:3, notes:[note(0,235,.085,{from:265,voice:'sphere',attack:.001,bass:.12,gain:.48}),note(.112,145,.225,{from:195,to:130,voice:'sphere',attack:.0007,bass:.52})]},
  annoyed: {duration:.42, rms:.033, notes:[note(0,145,.21,{from:190,to:130,voice:'sphere',attack:.0007,bass:.48})]},
  // Original 8-bit machinery: clocked lens scans, direction-change contacts,
  // and a reset catch, following BotEngine.shakeOffConfusion exactly.
  dizzy: {duration:1.64, rms:.052, gesture:'8bit-machinery', notes:[]},
  greet: {duration:.75, rms:.063, notes:[note(0,554.37,.20,{voice:'glass'}),note(.12,698.46,.23,{voice:'glass',gain:.9}),note(.27,830.61,.36,{voice:'glass',gain:.7})]},
  work: {duration:.32, rms:.021, click:.12, notes:[note(0,510,.17,{voice:'pulse'}),note(.075,680,.19,{gain:.7,voice:'pulse'})]},
  finish: {duration:1.12, rms:.090, notes:[note(0,660,.34,{voice:'glass'}),note(.115,880,.42,{voice:'glass',gain:.8}),note(.27,1100,.60,{voice:'glass',gain:.7}),note(.29,550,.61,{gain:.18,voice:'bot'})]},
  error: {duration:.72, rms:.060, notes:[note(0,390,.25,{voice:'pulse',to:350}),note(.20,295,.36,{voice:'pulse',to:260,gain:.9}),note(.20,148,.31,{voice:'thud',gain:.25})]},
  approval: {duration:.78, rms:.060, notes:[note(0,740,.26,{voice:'glass'}),note(.23,990,.38,{from:890,voice:'glass',gain:.8})]},
  question: {duration:.64, rms:.052, notes:[note(0,390,.23,{from:360,to:405,voice:'bot'}),note(.20,525,.31,{from:460,to:590,voice:'bot',gain:.85})]},
  approve: {duration:.56, rms:.042, click:.12, notes:[note(0,740,.23,{voice:'pulse'}),note(.095,990,.33,{voice:'glass',gain:.8})]},
  gulp: {duration:.70, rms:.052, notes:[note(0,392,.12,{voice:'bot'}),note(.16,196,.15,{voice:'bot'}),note(.35,261.63,.22,{voice:'bot',gain:.6})]},
  tick: {duration:.09, rms:.0035, click:.07, notes:[note(0,1175,.065,{voice:'pulse'})]},
  send: {duration:.39, rms:.022, click:.12, notes:[note(0,590,.23,{from:330,to:1050,voice:'pulse'}),note(.045,990,.23,{from:590,to:1320,gain:.2,voice:'glass'})]},
  love: {duration:.79, rms:.048, notes:[note(0,987.77,.22,{voice:'glass'}),note(.18,1244.51,.42,{voice:'glass',gain:.75})]},
  pop: {duration:.28, rms:.018, notes:[note(0,523.25,.17,{voice:'bot'})]},
  proud: {duration:.86, rms:.060, notes:[note(0,932.33,.23,{voice:'glass'}),note(.18,1396.91,.49,{voice:'glass',gain:.8})]},
  wink: {duration:.21, rms:.010, notes:[note(0,1396.91,.15,{voice:'glass'})]},
  yawn: {duration:.72, rms:.035, notes:[note(0,329.63,.52,{voice:'bot',attack:.025})]},
  attach: {duration:.73, rms:.050, click:.14, notes:[note(0,440,.23,{from:285,voice:'bot'}),note(.13,660,.30,{voice:'pulse'}),note(.26,880,.30,{gain:.43,voice:'glass'})]},
  think: {duration:.40, rms:.027, notes:[note(0,523.25,.13,{voice:'glass'}),note(.17,554.37,.16,{voice:'glass',gain:.6})]},
  search: {duration:.43, rms:.029, notes:[note(0,590,.17,{voice:'pulse'}),note(.10,790,.18,{voice:'pulse',gain:.75}),note(.21,990,.18,{voice:'pulse',gain:.6})]},
  rate: {duration:.61, rms:.040, notes:[note(0,440,.23,{voice:'bot'}),note(.18,330,.29,{voice:'bot',to:295,gain:.8})]},
  sleep: {duration:.45, rms:.022, notes:[note(0,293.66,.34,{voice:'bot'})]},
};

function motionMachinery(count) {
  const mono = new Float64Array(count);
  const ease = u => u<.5 ? 4*u*u*u : 1-(-2*u+2)**3/2;
  const targets = [-.14,.14,-.14,.14,-.13,.13,-.12,.12,-.1,.1,-.07,.05];
  const contacts = targets.map((tilt,i) => ({at:.69+i*.05,tilt}));
  let phase = 0, seed = 0x4d494d4f, held = 0, filtered = 0;
  for (let i=0; i<count; i++) {
    const t = i/sampleRate;
    let frequency = 224, amplitude = 0;
    if (t<.65) {
      // Eight discrete clock steps per eye revolution, driven by the same
      // easing as the motion. A small gated pulse gives each step its texture.
      const clock = ease(t/.65)*16, step = Math.min(15,Math.floor(clock));
      frequency = 240+(step%8)*32;
      amplitude = (1-Math.exp(-t/.012))*Math.min(1,(.65-t)/.035)
        * (.42+.28*Math.exp(-(clock-step)*7));
    }
    for (const contact of contacts) {
      const dt = t-contact.at;
      if (dt<0 || dt>.04) continue;
      frequency = contact.tilt<0 ? 224 : 280;
      amplitude += .8*Math.abs(contact.tilt)/.14
        * (1-Math.exp(-dt/.001))*Math.exp(-dt/.010);
    }
    // Lens closure and reopening get tactile catches rather than a melody.
    for (const [at,strength] of [[1.24,.38],[1.38,.48]]) {
      const dt = t-at;
      if (dt<0 || dt>.15) continue;
      frequency = 168+28*Math.max(0,3-Math.floor(dt/.025));
      amplitude += strength*(1-Math.exp(-dt/.0015))*Math.exp(-dt/.024);
    }
    phase += 2*Math.PI*frequency/sampleRate;
    // A 12 kHz sample clock and 8-bit quantization supply the console texture.
    // A gentle low-pass keeps the tiny machinery warm rather than piercing.
    if (i%4===0) {
      seed = (Math.imul(seed,1664525)+1013904223)>>>0;
      const noise = seed/2147483648-1;
      const pulse = (phase/(2*Math.PI)%1)<.3 ? 1.4 : -.6;
      const triangle = 2/Math.PI*Math.asin(Math.sin(phase));
      const value = amplitude*(.42*pulse+.22*triangle+.18*noise);
      held = Math.round(Math.max(-1,Math.min(1,value))*127)/127;
    }
    filtered += .18*(held-filtered);
    mono[i] = filtered;
  }
  return mono;
}

function synthesize(name, specification) {
  const isNavigation = navigation.has(name);
  const isCharacter = character.has(name);
  const pitch = isNavigation ? .78 : isCharacter ? 1 : .79;
  const count = Math.ceil(specification.duration * sampleRate);
  const mono = specification.gesture === '8bit-machinery' ? motionMachinery(count) : new Float64Array(count);
  for (const n of specification.notes) {
    let phase = 0;
    for (let i = Math.round(n.at * sampleRate); i < count; i++) {
      const t = i / sampleRate - n.at;
      if (t < 0) continue;
      if (t >= n.length) break;
      const u = t / n.length;
      // Quick rounded scoop, followed by a deliberate pitch gesture. The
      // expressive layer uses gentle FM, not a sampled or copied waveform.
      const scoop = ((n.from ?? n.frequency) - n.frequency) * Math.exp(-t / .018);
      const glide = ((n.to ?? n.frequency) - n.frequency) * (1 - Math.exp(-u * 3));
      const wobble = (n.wobble ?? (isNavigation || isCharacter ? 0 : n.frequency * .007))
        * Math.sin(2 * Math.PI * (isNavigation ? 9 : 5.2) * t) * Math.sin(Math.PI * u);
      const frequency = n.frequency + scoop + glide + wobble;
      phase += 2 * Math.PI * frequency * pitch / sampleRate;
      const attack = 1 - Math.exp(-t / (n.attack ?? (isNavigation ? .0035 : isCharacter ? .005 : .006)));
      const release = Math.min(1, (n.length - t) / .018);
      const decay = n.voice === 'sphere' ? Math.exp(-t/.052)
        : isCharacter ? Math.exp(-Math.max(0,u-.20)*4.5)
        : Math.exp(-u * (n.voice === 'glass' ? 4.2 : 5.8));
      const envelope = attack * decay * release * (n.gain ?? 1);
      const edge = Math.exp(-t / .045);
      let wave;
      switch (n.voice) {
        case 'bot':
          wave = Math.sin(phase + (.12 + (isNavigation ? .48 : .65) * edge) * Math.sin(phase * 2))
            + .07 * edge * Math.sin(phase * 3) + (isNavigation ? .06 : .18) * Math.sin(phase / 2);
          if (!isNavigation) wave += .065 * Math.sin(phase * 1.003 + .15);
          break;
        case 'pulse':
          wave = Math.sin(phase) + .12 * edge * Math.sin(phase * 3) + .025 * edge * Math.sin(phase * 5);
          break;
        case 'thud':
          wave = Math.sin(phase + .3 * edge * Math.sin(phase * 2));
          break;
        default:
          wave = Math.sin(phase + .25 * edge * Math.sin(phase * 2))
            + .10 * edge * Math.sin(phase * 3) + .025 * Math.sin(phase * 4);
      }
      if (isNavigation) {
        // Keep the console menu's low digital pluck and rising/falling
        // gestures. Rounded attacks and fading partials soften the edge.
        // Original synthesis only; no console recordings or samples.
        wave = Math.sin(phase + .16 * edge * Math.sin(phase * 2))
          + .058 * edge * Math.sin(phase * 2.98)
          + .018 * Math.exp(-t/.028) * Math.sin(phase * 5.01);
      } else if (n.voice !== 'thud') {
        // Character gestures have a voiced, almost humming body instead of an
        // FM servo buzz. Soft odd harmonics, a little breath and gentle drift
        // suggest a small expressive game character without spoken words.
        const vowel = .5 + .5 * Math.sin(Math.PI * u);
        wave = Math.sin(phase) + .18 * vowel * Math.sin(phase * 2 - .12)
          - .075 * Math.sin(phase * 3) + .022 * edge * Math.sin(phase * 4)
          + .11 * Math.sin(phase / 2) + .045 * Math.sin(phase * 1.002);
        if (isCharacter) wave = Math.sin(phase) - .045 * Math.sin(phase * 3)
          + .012 * Math.sin(phase * 5) + (n.voice==='glass' ? .025*edge*Math.sin(phase*4) : 0);
        // Hollow cavity and quickly fading rubber modes, with no sustained
        // buzz, vibrato or sub oscillator.
        if (n.voice === 'sphere') wave = Math.sin(phase)
          + .35*Math.sin(phase*2.14)*Math.exp(-t/.021)
          + .13*Math.sin(phase*3.85)*Math.exp(-t/.010)
          + (n.bass??0)*Math.sin(phase*.57)*Math.exp(-t/.085);
      }
      mono[i] += envelope * wave;
    }
  }
  // A tiny filtered digital contact makes button gestures feel tactile without
  // a harsh square-wave click. Seeded noise makes rendering reproducible.
  let seed = [...name].reduce((value, c) => (Math.imul(value, 31) + c.charCodeAt(0)) >>> 0, 17);
  let low = 0;
  for (let i = 0; i < count && specification.click; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 2147483648 - 1;
    low += .27 * (noise - low);
    const t = i / sampleRate;
    mono[i] += (noise - low) * specification.click * (1 - Math.exp(-t / .0006)) * Math.exp(-t / .0028);
  }

  const channels = [new Float64Array(count), new Float64Array(count)];
  // A large room answers the impact with a few soft, spreading reflections.
  // The dry punch stays centered; the short tail adds space rather than notes.
  const slapRoom = (name === 'slap' || name === 'annoyed') ? [
    [[.038,.11],[.076,.055],[.151,.024],[.238,.01]],
    [[.046,.11],[.091,.055],[.169,.024],[.257,.01]],
  ].map(taps => taps.map(([delay,gain]) => [Math.round(delay*sampleRate),gain])) : null;
  let energy = 0, peak = 0;
  for (let i = 0; i < count; i++) {
    const fade = Math.min(1, i / 24, (count - 1 - i) / (sampleRate * .018));
    // Restrained early reflections keep a centered, close console sound. Quiet
    // tails are baked into each asset; the runtime needs no extra effects.
    for (let channel = 0; channel < 2; channel++) {
      const delay = channel === 0 ? 997 : 1151;
      let value = mono[i];
      if (slapRoom) {
        for (const [roomDelay,gain] of slapRoom[channel]) value += gain * (mono[i-roomDelay] ?? 0);
      } else {
        value += (isNavigation ? .13 : .10) * (mono[i-delay] ?? 0)
          + (isNavigation ? .045 : .035) * (mono[i-delay*2] ?? 0);
      }
      value *= fade;
      channels[channel][i] = value;
      energy += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
  }
  const level = referenceLoudness[name];
  const targetGain = level === undefined ? specification.rms / Math.sqrt(energy / (count * 2))
    : 10 ** ((level + outputGainDb + (specification.gainDb??0) - peakLoudness(channels)) / 20);
  const gain = Math.min(targetGain, .72 / peak);
  const dataSize = count * 4;
  const output = Buffer.alloc(44 + dataSize);
  output.write('RIFF'); output.writeUInt32LE(36 + dataSize, 4); output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(2, 22);
  output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(sampleRate * 4, 28);
  output.writeUInt16LE(4, 32); output.writeUInt16LE(16, 34);
  output.write('data', 36); output.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < count; i++) for (let channel = 0; channel < 2; channel++) {
    output.writeInt16LE(Math.round(channels[channel][i] * gain * 32767), 44 + i * 4 + channel * 2);
  }
  return output;
}

mkdirSync(outputDirectory, {recursive:true});
for (const [name, specification] of Object.entries(sounds)) {
  writeFileSync(join(outputDirectory, `console-${name}.wav`), synthesize(name, specification));
}
console.log(`Rendered ${Object.keys(sounds).length} separate console WAVs (48 kHz, stereo PCM). Legacy files preserved.`);
