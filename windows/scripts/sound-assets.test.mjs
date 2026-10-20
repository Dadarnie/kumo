// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadSource} from './ts-test-loader.mjs';
import {waveSamples,peakLoudness} from './sound-levels.mjs';

const {SOUND_NAMES}=await import(await loadSource('../src/core/sound.ts'));
const directory=new URL('../assets/sounds/',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('manifest.json',directory),'utf8'));
// Kumo lantern pack: every cue is synthesized by scripts/kumo-sounds.mjs (44.1 kHz mono).
const retained=new Set();
function wave(name){
  const data=readFileSync(new URL(`console-${name}.wav`,directory));
  assert.equal(data.toString('ascii',0,4),'RIFF',name);assert.equal(data.toString('ascii',8,12),'WAVE',name);
  let format,body;
  for(let offset=12;offset+8<=data.length;){
    const size=data.readUInt32LE(offset+4),end=offset+8+size;
    assert(end<=data.length,name+' has a complete WAV chunk');
    const tag=data.toString('ascii',offset,offset+4);
    if(tag==='fmt ')format=data.subarray(offset+8,end);
    if(tag==='data')body=data.subarray(offset+8,end);
    offset=end+(size%2);
  }
  assert(format&&format.length>=16&&body,name+' has format and audio data');
  assert.equal(format.readUInt16LE(0),1,name+' is PCM');assert.equal(format.readUInt16LE(14),16,name+' is PCM16');
  const channels=format.readUInt16LE(2),rate=format.readUInt32LE(4),block=channels*2;
  assert.equal(format.readUInt16LE(12),block,name);assert.equal(body.length%block,0,name);
  const frames=body.length/block;let peak=0,energy=0;
  for(let c=0;c<channels;c++){assert.equal(body.readInt16LE(c*2),0,name+' starts at silence');assert.equal(body.readInt16LE(body.length-block+c*2),0,name+' ends at silence');}
  for(let i=0;i<body.length;i+=2){const value=body.readInt16LE(i)/32768;peak=Math.max(peak,Math.abs(value));energy+=value*value;}
  return {channels,rate,seconds:frames/rate,peak,energy,body};
}

test('the selected pack has exactly 28 complete PCM cues with headroom and clean boundaries',()=>{
  assert.deepEqual(readdirSync(directory).filter(name=>name.endsWith('.wav')).sort(),SOUND_NAMES.map(name=>`console-${name}.wav`).sort());
  assert.equal(SOUND_NAMES.length,28);assert.equal(new Set(SOUND_NAMES).size,28);
  for(const name of SOUND_NAMES){
    const audio=wave(name),original=retained.has(name);
    assert.equal(audio.channels,original?2:1,name+' retains its source channel count');
    assert.equal(audio.rate,original?48000:44100,name+' retains its source sample rate');
    assert.ok(audio.seconds>=.05&&audio.seconds<=3,name+' has a bounded duration');
    assert.ok(audio.peak>.005&&audio.peak<=(original?.721:.9),name+' has signal without clipping');
    assert.ok(Number.isFinite(audio.energy)&&audio.energy>0,name+' has measurable energy');
  }
});

test('the manifest identifies every synthesized cue and its format',()=>{
  assert.equal(manifest.events,28);assert.equal(manifest.new_cues,28);
  assert.deepEqual([...manifest.retained_cues].sort(),[...retained].sort());
  assert.deepEqual(manifest.files.map(file=>file.name).sort(),[...SOUND_NAMES].sort());
  for(const file of manifest.files){
    assert.equal(file.file,`console-${file.name}.wav`);
    const bytes=readFileSync(new URL(file.file,directory)),audio=wave(file.name);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,file.name+' matches the balanced pack');
    assert.equal(audio.channels,file.channels,file.name);assert.equal(audio.rate,file.sample_rate,file.name);
    assert.equal(audio.seconds,file.duration_seconds,file.name);
  }
});

test('each cue meets its measured role level without clipping or flattening quiet UI feedback',()=>{
  assert.equal(manifest.leveling.profile,'kumo-lantern-v1');
  for(const file of manifest.files){
    const measured=peakLoudness(waveSamples(new URL(file.file,directory)));
    assert(Math.abs(measured-file.leveling.target_db)<.15,file.name+' matches its loudness target');
    assert(file.leveling.peak_db<=-6,file.name+' retains peak headroom');
    assert.match(file.source_sha256,/^[a-f0-9]{64}$/);
  }
  const target=name=>manifest.files.find(file=>file.name===name).leveling.target_db;
  assert(target('hover')<target('blip'));assert(target('blip')<target('approval'));
});
