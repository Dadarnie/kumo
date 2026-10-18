// SPDX-License-Identifier: MIT
// Short-effect comparison: K-weighted stereo energy in the loudest 400 ms.
// Analysis runs at 48 kHz; mono is duplicated to match Web Audio speaker playback.
// 44.1 kHz sources are interpolated for analysis only. Source WAVs are unchanged.
import {readFileSync} from 'node:fs';

export function waveSamples(path) {
  const data=readFileSync(path);
  if(data.toString('ascii',0,4)!=='RIFF'||data.toString('ascii',8,12)!=='WAVE')throw new Error('Invalid WAV: '+path);
  let format,body;
  for(let offset=12;offset+8<=data.length;){
    const tag=data.toString('ascii',offset,offset+4),length=data.readUInt32LE(offset+4);
    if(tag==='fmt ')format=data.subarray(offset+8,offset+8+length);
    if(tag==='data')body=data.subarray(offset+8,offset+8+length);
    offset+=8+length+(length%2);
  }
  if(!format||!body||format.readUInt16LE(0)!==1||![1,2].includes(format.readUInt16LE(2))||![44100,48000].includes(format.readUInt32LE(4))||format.readUInt16LE(14)!==16)throw new Error('Expected 44.1/48 kHz mono/stereo PCM16: '+path);
  const count=format.readUInt16LE(2),rate=format.readUInt32LE(4),frames=body.length/(count*2);
  const channels=[new Float64Array(Math.round(frames*48000/rate)),new Float64Array(Math.round(frames*48000/rate))];
  for(let i=0;i<channels[0].length;i++){
    const position=i*rate/48000,left=Math.min(frames-1,Math.floor(position)),right=Math.min(frames-1,left+1),fraction=position-left;
    for(let c=0;c<2;c++){const channel=Math.min(c,count-1),a=body.readInt16LE((left*count+channel)*2),b=body.readInt16LE((right*count+channel)*2);channels[c][i]=(a+(b-a)*fraction)/32768;}
  }
  return channels;
}
function filter(input,b,a) {
  const output=new Float64Array(input.length);let x1=0,x2=0,y1=0,y2=0;
  for(let i=0;i<input.length;i++){
    const x=input[i],y=b[0]*x+b[1]*x1+b[2]*x2-a[0]*y1-a[1]*y2;
    output[i]=y;x2=x1;x1=x;y2=y1;y1=y;
  }
  return output;
}
export function peakLoudness(channels) {
  const weighted=channels.map(input=>filter(filter(input,
    [1.53512485958697,-2.69169618940638,1.19839281085285],[-1.69065929318241,.73248077421585]),
    [1,-2,1],[-1.99004745483398,.99007225036621]));
  const window=19200,count=Math.max(window,channels[0].length);
  let sum=0,maximum=0;
  for(let i=0;i<count;i++){
    for(const channel of weighted){sum+=(channel[i]??0)**2;if(i>=window)sum-=(channel[i-window]??0)**2;}
    if(i>=window-1)maximum=Math.max(maximum,sum/window);
  }
  return -.691+10*Math.log10(maximum);
}
