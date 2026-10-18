// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mimoBrowser } from "./mimo-browser.mjs";

let browser;
before(async()=>{browser=await mimoBrowser();});
after(async()=>{await browser?.close();});
const frame = () => browser.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
async function home() {
  await browser.evaluate(`mediaPreview.preferences({hooksInstalled:true,codingAssistant:'claude',usageEnabled:true,peekEnabled:false,autoCollapseEnabled:false,modules:{media:false,vscode:true,developerIntegrations:false}});mediaPreview.state.pinned=true;mediaPreview.state.setFocus('integration_claude');mediaPreview.open('overview')`);
  await browser.settle();
}

test("Mimo builds optional panels on first use and retains chat draft and controls across tabs", async()=>{
  await home();
  assert.equal(await browser.evaluate("document.querySelector('.chat-card,.drop-card,.approval-inbox')"),null,"Unvisited panels should not allocate their controls or observers");
  await browser.evaluate("mediaPreview.island.setView('prompt')");
  await browser.settle();
  await browser.evaluate("const input=document.querySelector('.chat-input');input.value='Keep this draft';input.dispatchEvent(new Event('input'));window.retainedChatInput=input");
  await browser.click('[data-section=usage]');
  await browser.settle();
  await browser.evaluate("mediaPreview.island.setView('prompt')");
  await browser.settle();
  assert.equal(await browser.evaluate("retainedChatInput===document.querySelector('.chat-input')&&retainedChatInput.value==='Keep this draft'&&mediaPreview.state.chatDraft==='Keep this draft'"),true);
  assert.equal(await browser.evaluate("document.querySelectorAll('.chat-card').length"),1);
  assert.equal(await browser.evaluate("document.querySelector('.drop-card')"),null);
});

test("Mimo Usage geometry is cached between content changes and hidden views do not resync", async()=>{
  await home();
  await browser.click('[data-section=usage]');
  await browser.settle();
  const reads = await browser.evaluate(`(()=>{const descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'scrollHeight');let reads=0;Object.defineProperty(Element.prototype,'scrollHeight',{configurable:true,get(){if(this.classList.contains('agent-usage'))reads++;return descriptor.get.call(this)}});try{const view=mediaPreview.island.views.get('usage');for(let i=0;i<120;i++)view.layout();return reads;}finally{Object.defineProperty(Element.prototype,'scrollHeight',descriptor)}})()`);
  assert.equal(reads,0,"Animation frames must not force a new Usage content-height layout");
  await browser.evaluate("mediaPreview.compact()");
  await browser.settle();
  const syncs = await browser.evaluate(`(async()=>{const view=mediaPreview.island.views.get('usage'),original=view.sync;let calls=0;view.sync=()=>{calls++;original.call(view)};try{for(let i=0;i<5;i++){mediaPreview.state.notify();await new Promise(resolve=>requestAnimationFrame(resolve));}return calls;}finally{view.sync=original}})()`);
  assert.equal(syncs,0,"Incoming state updates must not render a collapsed panel");
  assert.equal(await browser.evaluate("document.querySelectorAll('#views>.view.on').length"),0);
});

test("Animated shell shapes stay local instead of invalidating every child style", async()=>{
  await home();
  await browser.evaluate("mediaPreview.compact()");
  await browser.settle();
  await browser.evaluate("mediaPreview.open('usage')");
  const frames = await browser.evaluate(`(async()=>{const samples=[];for(let i=0;i<24;i++){await new Promise(resolve=>requestAnimationFrame(resolve));const island=document.querySelector('#island');samples.push({shell:getComputedStyle(island,'::before').clipPath,child:getComputedStyle(document.querySelector('#content')).getPropertyValue('--notch-shape')});}return samples})()`);
  assert.ok(frames.every(frame=>frame.shell.startsWith('path(')), "The background keeps the shoulder contour throughout the transition");
  assert.ok(frames.every(frame=>frame.child.trim()===''), "Animated path values must not be inherited by each control and code line");
  await browser.settle();
  assert.deepEqual(browser.errors,[]);
});

test("Mimo tab switches to Usage fade continuously, cancel cleanly, and park inactive panels", async()=>{
  await home();
  await browser.click('[data-section=usage]');
  const transition=await browser.evaluate(`(async()=>{const active=document.querySelector('.agent-usage-view'),outgoing=document.querySelector('.home-view'),opacities=[];for(let i=0;i<7;i++){await new Promise(resolve=>requestAnimationFrame(resolve));opacities.push(+getComputedStyle(active).opacity);}return {opacities,duration:getComputedStyle(active).transitionDuration,outgoingInert:outgoing.inert,outgoingPointer:getComputedStyle(outgoing).pointerEvents}})()`);
  assert.ok(transition.opacities.some(opacity=>opacity>0&&opacity<1),"Usage needs visible intermediate frames: "+JSON.stringify(transition));
  assert.match(transition.duration,/0\.18s/);
  assert.equal(transition.outgoingInert,true);
  assert.equal(transition.outgoingPointer,'none');
  await browser.settle();
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.home-view')).visibility"),'hidden');
  await browser.evaluate("for(let i=0;i<15;i++)mediaPreview.island.setView(i%2?'overview':'usage')");
  await browser.settle();
  assert.equal(await browser.evaluate("mediaPreview.state.view"),'usage');
  assert.equal(await browser.evaluate("document.querySelectorAll('#views>.view.on').length"),1);
  assert.equal(await browser.evaluate("document.querySelector('.agent-usage-view').getAnimations().length"),0);
  await browser.capture('mimo-usage-transition-settled');
  await browser.command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await browser.click('.usage-back');await browser.settle();
  await browser.click('[data-section=usage]');await frame();
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.agent-usage-view')).transform"),'none');
  await browser.settle();
  await browser.command('Emulation.setEmulatedMedia',{features:[]});
  assert.deepEqual(browser.errors,[]);
});

test("Limits opening keeps its content at a stable height without a transient scrollbar", async()=>{
  await browser.evaluate("mediaPreview.preferences({usageEnabled:false})");
  await browser.settle();
  await home();
  await browser.evaluate(`(async()=>{const {Activity}=await import('/src/core/activity.ts');Activity.observeUsage('claude',{plan:'pro',primary:{usedPercent:20,windowMinutes:300,resetsAt:Date.now()/1000+12000},secondary:{usedPercent:45,windowMinutes:10080,resetsAt:Date.now()/1000+240000},resetCredits:{availableCount:1,nextExpiresAt:Date.now()/1000+86400},checkedAt:Date.now()/1000});})()`);
  for (const from of ['home','compact']) {
    if (from==='home') await browser.click('[data-section=usage]');
    else {
      await browser.evaluate("mediaPreview.compact()");await browser.settle();
      await browser.evaluate("mediaPreview.open('usage')");
    }
    const frames=await browser.evaluate(`(async()=>{const frames=[];for(let i=0;i<24;i++){await new Promise(resolve=>requestAnimationFrame(resolve));const view=document.querySelector('.agent-usage-view');if(view.classList.contains('on'))frames.push({height:view.clientHeight,scroll:view.scrollHeight,width:view.clientWidth,scrollWidth:view.scrollWidth,scrollbar:view.offsetWidth-view.clientWidth,shell:document.querySelector('#island').getBoundingClientRect().height});}return frames})()`);
    assert.ok(frames.length>0);
    assert.ok(frames.every(frame=>frame.scroll<=frame.height+1&&frame.scrollWidth<=frame.width+1&&frame.scrollbar===0),from+" must not briefly squeeze Limits into a scroll box: "+JSON.stringify(frames));
    await browser.settle();
    assert.ok(await browser.evaluate("document.querySelector('.agent-usage').getBoundingClientRect().bottom<=document.querySelector('#island').getBoundingClientRect().bottom"));
  }
  await browser.capture('limits-no-scrollbar');
});

test("VS Code Preview retains its earlier controls and readable source and edits at both DPI scales", async()=>{
  await home();
  await browser.evaluate(`Object.assign(mediaPreview.state.codingTask,{state:'working',sessionCwd:'C:/work/mimo',steps:['Read invoice'],stepIndex:0,activity:{action:'Read',tool:'Read',phase:'running',target:'C:/work/mimo/src/invoice.ts',preview:{startLine:80,lines:['export const total = 42;']},files:[{action:'Edit',tool:'Edit',phase:'complete',target:'C:/work/mimo/src/invoice.ts',changes:{added:1,removed:1},preview:{startLine:80,lines:['const total = 41;','const total = 42;'],kinds:['removed','added']}}]}});mediaPreview.state.notify()`);
  await browser.settle();
  await browser.click('.coding-preview-trigger');await browser.settle();
  assert.equal(await browser.evaluate("document.querySelector('.coding-preview-tools')"),null);
  assert.ok(await browser.evaluate("[...document.querySelectorAll('.coding-stage[data-state=active] .coding-indicator .ui-icon')].some(icon=>Number(getComputedStyle(icon).opacity)===1)"),'the active tool glyph remains visible inside its moving badge');
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.coding-card')).gridTemplateRows.split(' ')[0]"),'40px');
  for(const scale of [1,2]){
    await browser.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:scale,mobile:false});
    for(const [index,name] of [[1,'source'],[2,'edits']]){
      await browser.click('.coding-view-button:nth-child('+index+')');await browser.settle();
      assert.ok(await browser.evaluate("document.querySelector('.coding-file-path').getBoundingClientRect().bottom<=document.querySelector('.coding-current').getBoundingClientRect().top"),name+' caption must remain visible');
      assert.equal(await browser.evaluate("document.querySelector('#island').getBoundingClientRect().height"),332);
      await browser.capture('vscode-restored-'+name+'-'+scale+'x');
    }
  }
  await browser.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:1,mobile:false});
  assert.deepEqual(browser.errors,[]);
});
