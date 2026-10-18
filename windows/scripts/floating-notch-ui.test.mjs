// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mimoBrowser } from "./mimo-browser.mjs";

let browser;
before(async () => { browser = await mimoBrowser(); });
after(async () => { await browser?.close(); });

async function reset(working = true) {
  await browser.command("Input.dispatchMouseEvent", {type:"mouseMoved",x:0,y:400});
  await browser.evaluate(`(()=>{
    const p=mediaPreview,s=p.state;
    s.tasks=[];p.publish('none'); s.pendingApproval=null; s.pendingApprovals=[]; s.isPinned=false; s.paused=false;
    s.stateOverride=null; s.tasks=[]; s.view='overview';
    p.preferences({workingModeEnabled:true,modules:{media:false,vscode:true,developerIntegrations:false}});
    s.tasks=${working ? "[{id:'working-lip-test',name:'Reference workspace',source:'claudeCode',color:'#eee',state:'working',stepIndex:0,steps:[],isIntegration:false,sessionId:'working-lip-session',sessionCwd:'C:/workspace',activity:{phase:'running',tool:'Read',action:'Read',target:'src/main.ts',summary:'Reading workspace',startedAt:Date.now()}}]" : "[]"};
    p.island.visibility.setProtected(false);p.island.visibility.setPinned(false);p.island.visibility.pointerLeft();
    p.island.visibility.expand();s.notify();
  })()`);
  await browser.evaluate("new Promise(resolve=>setTimeout(resolve,1250))");
  await browser.settle();
}

async function state() {
  return browser.evaluate(`(()=>{const i=mediaPreview.island,e=document.querySelector('#island'),r=e.getBoundingClientRect();
    return {visibility:mediaPreview.state.visibility,rect:r.toJSON(),mascot:getComputedStyle(document.querySelector('#bot-canvas')).opacity,
      botState:i.engine.state,desktop:mediaPreview.state.settings.desktopCompanion,sleepGlyphs:document.querySelectorAll('.mimo-sleep-glyphs').length};})()`);
}

test("working mode is the reference 156 by 12 top lip and has no sleeping mascot",async()=>{
  await reset();const s=await state();
  assert.equal(s.visibility,'peek',JSON.stringify(s));
  assert.ok(Math.abs(s.rect.width-156)<.1,JSON.stringify(s));
  assert.ok(Math.abs(s.rect.height-12)<.1,JSON.stringify(s));
  assert.equal(s.rect.top,0);assert.equal(s.rect.x+s.rect.width/2,360);
  assert.equal(s.mascot,'0');assert.notEqual(s.botState,'sleeping');assert.equal(s.desktop,null);assert.equal(s.sleepGlyphs,0);
  await browser.capture('mimo-working-mode-lip');
});

test("tabs under and beside the minimized notch remain clickable and hover never opens Mimo",async()=>{
  await reset();
  await browser.evaluate(`(()=>{
    document.querySelector('#reference-tabs')?.remove();const tabs=document.createElement('div');tabs.id='reference-tabs';
    Object.assign(tabs.style,{position:'absolute',left:'180px',top:'24px',width:'360px',height:'32px',display:'flex',zIndex:'0'});
    for(const label of ['Tab one','Tab two','Tab three']) {const button=document.createElement('button');button.textContent=label;button.dataset.tab=label;
      Object.assign(button.style,{width:'120px',height:'32px',padding:'0'});button.onclick=()=>tabs.dataset.active=label;tabs.append(button);}
    document.body.prepend(tabs);
  })()`);
  for(const label of ['Tab one','Tab two','Tab three','Tab two']) {
    await browser.click('[data-tab="'+label+'"]');
    assert.equal(await browser.evaluate("document.querySelector('#reference-tabs').dataset.active"),label);
    assert.equal((await state()).visibility,'peek','clicking the simulated Chrome tab row cannot reveal Mimo');
  }
  await browser.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:360,y:6});await browser.settle();
  assert.equal((await state()).visibility,'peek','hover over the real lip remains explicit');
  await browser.capture('mimo-browser-tabs-working-mode');
  await browser.click('#restore-island');await browser.settle();
  assert.equal((await state()).visibility,'expanded','click the lip opens the panel');
  await browser.evaluate("document.querySelector('#reference-tabs').remove()");
});

test("sleeping and detached companion cannot reappear after legacy settings or dragging",async()=>{
  await reset();
  await browser.evaluate("mediaPreview.preferences({peekEnabled:true,desktopCompanion:{monitor:'old',x:.25,y:.6}})");
  await browser.settle();
  await browser.command('Input.dispatchMouseEvent',{type:'mousePressed',x:360,y:6,button:'left',clickCount:1});
  await browser.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:220,y:300,buttons:1});
  await browser.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:220,y:300,button:'left',clickCount:1});
  await browser.settle();const s=await state();assert.equal(s.desktop,null);assert.equal(s.rect.top,0);
  assert.notEqual(s.botState,'sleeping');assert.equal(s.sleepGlyphs,0);
  assert.equal(await browser.evaluate("mediaPreview.state.settings.peekEnabled"),false);
});

test("disabling working mode restores the awake island and completion keeps enabled working mode compact",async()=>{
  await reset();
  await browser.evaluate("mediaPreview.preferences({workingModeEnabled:false})");await browser.settle();
  assert.equal((await state()).visibility,'island');
  await browser.evaluate("mediaPreview.preferences({workingModeEnabled:true});mediaPreview.state.notify()");
  await browser.evaluate("new Promise(resolve=>setTimeout(resolve,1250))");await browser.settle();
  assert.equal((await state()).visibility,'peek');
  await browser.evaluate("(()=>{const task=mediaPreview.state.tasks.find(t=>t.id==='working-lip-test');task.state='finished';task.activity.phase='complete';mediaPreview.state.notify()})()");
  await browser.settle();assert.equal((await state()).visibility,'peek');
});

test("working mode remains a compact lip even with no active coding agent",async()=>{
  await reset(false);
  await browser.evaluate("new Promise(resolve=>setTimeout(resolve,4500))");
  const s=await state();assert.equal(s.visibility,'peek');assert.notEqual(s.botState,'sleeping');assert.equal(s.sleepGlyphs,0);
  assert.deepEqual(browser.errors,[]);
});

test("working mode keeps an open chat and its draft protected",async()=>{
  await reset();
  await browser.evaluate("mediaPreview.open('prompt')"); await browser.settle();
  await browser.evaluate(`(()=>{const input=document.querySelector('.chat-input');input.focus();input.value='Draft stays here';
    input.dispatchEvent(new Event('input',{bubbles:true}));mediaPreview.island.visibility.pointerLeft();})()`);
  await browser.evaluate("new Promise(resolve=>setTimeout(resolve,1250))");
  assert.equal((await state()).visibility,'expanded');
  assert.equal(await browser.evaluate("document.querySelector('.chat-input').value"),'Draft stays here');
  assert.deepEqual(browser.errors,[]);
});
