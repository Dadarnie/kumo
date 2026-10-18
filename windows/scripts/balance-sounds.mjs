// SPDX-License-Identifier: MIT
// Match short-effect loudness by role without changing pitches, timing or format.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {waveSamples,peakLoudness} from './sound-levels.mjs';

export const SOUND_LEVEL_TARGETS = {
  hover:-36,tick:-34,blip:-31,peek:-28,open:-28,close:-29,
  work:-29,think:-29,search:-29,send:-28,attach:-27,pop:-28,
  gulp:-24,slap:-24,annoyed:-24,dizzy:-23,greet:-22,finish:-21,
  proud:-23,love:-25,wink:-26,yawn:-26,sleep:-28,
  approval:-21,approve:-23,question:-22,error:-21,rate:-23,
};
const dir=new URL('../assets/sounds/',import.meta.url),file=new URL('manifest.json',dir);
const manifest=JSON.parse(readFileSync(file,'utf8')),write=process.argv.includes('--write');
const rows=[];
for(const cue of manifest.files){
  const path=new URL(cue.file,dir),bytes=readFileSync(path),before=peakLoudness(waveSamples(path));
  if(createHash('sha256').update(bytes).digest('hex')!==cue.sha256)throw new Error('Unrecorded asset change: '+cue.file);
  const target=SOUND_LEVEL_TARGETS[cue.name];if(!Number.isFinite(target))throw new Error('Missing target: '+cue.name);
  let bodyStart,bodyLength;
  for(let at=12;at+8<=bytes.length;){const size=bytes.readUInt32LE(at+4);if(bytes.toString('ascii',at,at+4)==='data'){bodyStart=at+8;bodyLength=size;break;}at+=8+size+(size%2);}
  if(bodyStart==null)throw new Error('Missing PCM: '+cue.file);
  let sourcePeak=0;for(let i=bodyStart;i<bodyStart+bodyLength;i+=2)sourcePeak=Math.max(sourcePeak,Math.abs(bytes.readInt16LE(i)/32768));
  const gainDb=Math.min(target-before,-6-20*Math.log10(sourcePeak)),gain=10**(gainDb/20);
  if(write&&Math.abs(gainDb)>.025){for(let i=bodyStart;i<bodyStart+bodyLength;i+=2){const sample=Math.round(bytes.readInt16LE(i)*gain);if(Math.abs(sample)>32767)throw new Error('Clipped cue: '+cue.name);bytes.writeInt16LE(sample,i);}writeFileSync(path,bytes);}
  const after=write?peakLoudness(waveSamples(path)):before;
  let peak=0;for(let i=bodyStart;i<bodyStart+bodyLength;i+=2)peak=Math.max(peak,Math.abs(bytes.readInt16LE(i)/32768));
  const row={name:cue.name,target_db:target,before_db:+before.toFixed(3),after_db:+after.toFixed(3),gain_db:+gainDb.toFixed(3),peak_db:+(20*Math.log10(peak)).toFixed(3)};
  rows.push(row);
  if(write){cue.source_sha256??=cue.sha256;cue.sha256=createHash('sha256').update(bytes).digest('hex');cue.leveling={target_db:target,source_db:cue.leveling?.source_db??row.before_db,measured_db:row.after_db,gain_db:+((cue.leveling?.gain_db??0)+gainDb).toFixed(3),peak_db:row.peak_db};}
}
if(write){manifest.format='PCM16 source formats preserved; per-cue gain balancing only. Retained cues: 48 kHz stereo. New cues: 44.1 kHz mono.';manifest.leveling={metric:'K-weighted loudest 400 ms; 48 kHz stereo analysis; mono duplicated to match Web Audio playback',profile:'mimo-ui-v1',peak_ceiling_db:-6,note:'Quiet hover/clicks remain below actions and attention cues. Constant gain per file; no compression, pitch change or time change.'};writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');}
console.log(JSON.stringify({written:write,cues:rows.length,rows},null,2));
