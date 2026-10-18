// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {mimoBrowser} from '../windows/scripts/mimo-browser.mjs';
const root=new URL('../',import.meta.url),out=new URL('docs/media/agents/',root);
const record=JSON.parse(await readFile(new URL('sources.json',out),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const cards=[];
for(const item of record.icons){
 const bytes=await readFile(new URL(item.mark,out));assert.equal(sha(bytes),item.sha256);
 const mime=item.mark.endsWith('.svg')?'image/svg+xml':item.mark.endsWith('.ico')?'image/x-icon':'image/png';
 cards.push(`<div class="badge" data-agent="${item.id}"><img src="data:${mime};base64,${bytes.toString('base64')}" alt=""><span>${item.name}</span></div>`);
}
const preview=new URL('windows/target/agent-badges/',root);await mkdir(preview,{recursive:true});
await writeFile(new URL('index.html',preview),`<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Inter;src:url('/src/assets/fonts/InterVariable.woff2')}*{box-sizing:border-box}body{margin:0;padding:12px;background:transparent;display:grid;grid-template-columns:repeat(3,180px);gap:12px;font-family:Inter,Arial,sans-serif}.badge{width:180px;height:48px;border:1px solid #d8dee4;border-radius:9px;background:#f6f8fa;display:flex;align-items:center;gap:12px;padding:0 14px;color:#24292f;font-size:14px;font-weight:570;white-space:nowrap}.badge img{width:26px;height:26px;object-fit:contain;flex:none}
</style></head><body>${cards.join('')}</body></html>`);
const browser=await mimoBrowser({page:'/target/agent-badges/index.html',ready:'document.querySelectorAll(".badge").length===9',port:1504});
try{
 await browser.command('Emulation.setDeviceMetricsOverride',{width:588,height:192,deviceScaleFactor:3,mobile:false});
 await browser.command('Emulation.setDefaultBackgroundColorOverride',{color:{r:0,g:0,b:0,a:0}});
 await browser.evaluate('(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode()));})()');
 for(const item of record.icons){
  const clip=await browser.evaluate(`(()=>{const r=document.querySelector('[data-agent="${item.id}"]').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);
  const bytes=Buffer.from((await browser.command('Page.captureScreenshot',{format:'png',clip})).data,'base64');
  item.badge={file:`${item.id}.png`,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),sha256:sha(bytes)};
  await writeFile(new URL(item.badge.file,out),bytes);
 }
 const previewBytes=Buffer.from((await browser.command('Page.captureScreenshot',{format:'png'})).data,'base64');
 await writeFile(new URL('preview.png',preview),previewBytes);assert.deepEqual(browser.errors,[]);
}finally{await browser.close();}
await writeFile(new URL('sources.json',out),JSON.stringify(record,null,2)+'\n');
console.log('Rendered nine local agent badges from verified vendor artwork.');
