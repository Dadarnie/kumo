// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {mimoBrowser} from './mimo-browser.mjs';

let browser;
before(async()=>{browser=await mimoBrowser({port:1475});});
after(async()=>{await browser?.close();});

async function home(scale=1) {
 await browser.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:scale,mobile:false});
 await browser.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:431});
 await browser.evaluate(`(async()=>{
  const p=mediaPreview,s=p.state;
  p.preferences({workingModeEnabled:false,autoCollapseEnabled:false,clockEnabled:true,hooksInstalled:true,codexHooksInstalled:true,
   modules:{media:true,vscode:true,developerIntegrations:true},
   activeIntegrations:['integration_github','integration_vercel','integration_resend','integration_n8n']});
  s.pendingApproval=null;s.pendingApprovals=[];s.stateOverride=null;s.isPinned=false;s.paused=false;
  s.tasks=s.tasks.filter(t=>t.isIntegration);
  window.referenceActivity=(await import('/src/core/coding-activity.ts')).codingActivity;
  const event=(hook,tool,id,input,extra={})=>({hook_event_name:hook,tool_name:tool,tool_use_id:id,tool_input:input,...extra});
  let activity=referenceActivity(event('PreToolUse','Read','read-1',{file_path:'src/invoice.ts'}));
  activity=referenceActivity(event('PostToolUse','Read','read-1',{file_path:'src/invoice.ts'},
    {mimo_preview:{text:'export function total(items) {\\n  return items.length;\\n}',start_line:10}}),activity);
  activity=referenceActivity(event('PreToolUse','Edit','edit-1',{file_path:'src/invoice.ts',old_string:'return 0;',new_string:'return 42;'}),activity);
  activity=referenceActivity(event('PostToolUse','Edit','edit-1',{file_path:'src/invoice.ts'}),activity);
  const task={id:'session_codex_reference',name:'Codex',source:'codexCode',color:'#eee',state:'working',
   stepIndex:0,steps:['Read','Edit'],isIntegration:false,sessionId:'reference-ui',sessionCwd:'C:/reference-ui',lastEventAt:Date.now(),activity};
  s.tasks.push(task);s.lastCodingId=task.id;s.selectCodingTask(task.id);window.referenceTask=task;
  p.publish('none');p.open('overview');s.notify();
 })()`);
 await browser.settle();
}

test('Home keeps only the circular media icon after usage, without footer shortcuts',async()=>{
 for(const scale of [1,2]) {
  await home(scale);
  const result=await browser.evaluate(`(()=>{const b=document.querySelector('.header-media');return {
   previous:b.previousElementSibling.className,icons:b.querySelectorAll('svg[data-mimo-icon="music-mode"]').length,
   text:b.textContent,footer:document.querySelector('.home-footer')!==null,
   drop:[...document.querySelectorAll('.home-view button')].some(b=>b.textContent==='Drop a file')};})()`);
  assert.equal(result.previous,'header-limits');assert.equal(result.icons,1);assert.equal(result.text,'');
  assert.equal(result.footer,false);assert.equal(result.drop,false);
  await browser.capture('reference-home-'+scale+'x');
  await browser.click('.header-media');
  await browser.evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
  assert.equal(await browser.evaluate(`document.querySelector('[data-section=overview]').getAttribute('aria-current')`),null);
  assert.equal(await browser.evaluate(`document.querySelector('.header-media').getAttribute('aria-current')`),'page');
  assert.equal(await browser.evaluate(`document.querySelector('.media-empty h1').textContent`),'Nothing playing');
 }
});

test('Terminal prioritizes edits, reveals actual command output and exposes reported results',async()=>{
 for(const scale of [1,2]) {
  await home(scale);await browser.click('.coding-preview-trigger');await browser.settle();
  assert.equal(await browser.evaluate(`document.querySelector('.coding-run-region').hidden`),true);
  assert.equal(await browser.evaluate(`document.querySelectorAll('.coding-view-switch,.coding-open').length`),0);
  const alignment=await browser.evaluate(`(()=>{const label=document.querySelector('.coding-sidebar .coding-project').getBoundingClientRect(),shell=document.querySelector('#island').getBoundingClientRect();
   return Math.abs(label.left+label.width/2-shell.left-mediaPreview.island.botCx.target);})()`);
  assert.ok(alignment<1,'The provider label centers under Mimo');
  const icons=await browser.evaluate(`([...document.querySelectorAll('.coding-stage')].map(stage=>{
   const glyph=stage.querySelector('.ui-icon'),label=stage.querySelector('span:not(.coding-indicator)');
   return {size:glyph.getBoundingClientRect().width,text:parseFloat(getComputedStyle(stage).fontSize)};}))`);
  assert.ok(icons.every(icon=>icon.size>=16&&icon.size>icon.text));
  await browser.evaluate(`(()=>{referenceTask.activity=referenceActivity({hook_event_name:'PreToolUse',tool_name:'Bash',tool_use_id:'run-1',tool_input:{command:'npm test'}},referenceTask.activity);mediaPreview.state.notify()})()`);
  await browser.settle();
  const bounds=await browser.evaluate(`(()=>{const edits=document.querySelector('.coding-edits'),run=document.querySelector('.coding-run-region');return {edits:edits.getBoundingClientRect().toJSON(),run:run.getBoundingClientRect().toJSON(),runHidden:run.hidden};})()`);
  assert.equal(bounds.runHidden,false);assert.ok(bounds.edits.height>0);assert.ok(bounds.edits.bottom<=bounds.run.top+1);
  await browser.evaluate(`(()=>{referenceTask.activity=referenceActivity({hook_event_name:'PostToolUse',tool_name:'Bash',tool_use_id:'run-1',tool_input:{command:'npm test'},
   mimo_preview:{text:'PASS tests/invoice.test.ts\\nTests: 48 passed, 48 total'},
   mimo_tests:{passed:48,failed:0,total:48,cases:[{name:'tests/invoice.test.ts',status:'passed',kind:'suite'}]}},referenceTask.activity);mediaPreview.state.notify()})()`);
  await browser.settle();
  assert.match(await browser.evaluate(`document.querySelector('.coding-result-button:not([hidden])').parentElement.textContent`),/48 passed/);
  await browser.click('.coding-result-button[aria-expanded]');await browser.settle();
  assert.equal(await browser.evaluate(`document.querySelector('.coding-test-cases').hidden`),false);
  assert.match(await browser.evaluate(`document.querySelector('.coding-test-cases').textContent`),/Suite · tests\/invoice/);
  const colors=await browser.evaluate(`(()=>{const text=document.querySelector('.coding-run-output');return {base:getComputedStyle(text).color,
    number:[...text.querySelectorAll('[data-token=number]')].map(e=>getComputedStyle(e).color),command:getComputedStyle(text.querySelector('[data-command=true]')).color};})()`);
  assert.ok(colors.number.every(color=>color===colors.base));
  assert.equal(colors.command,colors.base);
  await browser.capture('reference-terminal-results-'+scale+'x');
  await browser.click('.coding-result-button[aria-expanded]');
  await browser.evaluate(`(()=>{referenceTask.activity=referenceActivity({hook_event_name:'PreToolUse',tool_name:'Edit',tool_use_id:'edit-2',tool_input:{file_path:'src/invoice.ts',old_string:'42',new_string:'43'}},referenceTask.activity);mediaPreview.state.notify()})()`);
  await browser.settle();assert.equal(await browser.evaluate(`document.querySelector('.coding-run-region').hidden`),true);
  await browser.click('.coding-result-button[aria-expanded]');await browser.settle();
  assert.equal(await browser.evaluate(`document.querySelector('.coding-run-region').hidden`),false);
  await browser.click('.coding-expand');await browser.settle();
  assert.equal(await browser.evaluate(`document.querySelector('.coding-card').dataset.expanded`),'false');
 }
});

test('Confusion uses the same overlapping mini-Mimo stack as eating and returns to Chat',async()=>{
 for(const scale of [1,2]) {
  await home(scale);await browser.evaluate(`mediaPreview.state.chatDraft='Keep this draft';mediaPreview.open('prompt')`);await browser.settle();
  for(let poke=0;poke<3;poke++)await browser.click('#pat-mimo');
  await browser.settle();
  const result=await browser.evaluate(`(()=>{const rail=document.querySelector('.confused-integrations'),upload=document.querySelector('.upload-integrations');
   const read=el=>[...el.querySelectorAll('.mimo-stack-item')].map(item=>({id:item.dataset.integration,margin:getComputedStyle(item).marginTop,
    size:item.getBoundingClientRect().width,mini:item.querySelector('.mini').style.width}));
   return {view:mediaPreview.state.view,rail:read(rail),upload:read(upload),main:document.querySelector('.confused-main').getBoundingClientRect().toJSON(),
    right:rail.getBoundingClientRect().toJSON()};})()`);
  assert.equal(result.view,'confused');assert.equal(result.rail.length,4);
  assert.deepEqual(result.rail,result.upload);assert.ok(result.rail.slice(1).every(item=>parseFloat(item.margin)<0));
  assert.equal(await browser.evaluate(`document.querySelector('.confused-integrations').querySelectorAll('button,a,[tabindex]').length`),0);
  assert.ok(result.main.right<result.right.left);await browser.capture('reference-confusion-'+scale+'x');
  await browser.evaluate('new Promise(resolve=>setTimeout(resolve,3100))');await browser.settle();
  assert.equal(await browser.evaluate('mediaPreview.state.view'),'prompt');
  assert.equal(await browser.evaluate('mediaPreview.state.chatDraft'),'Keep this draft');
 }
});

test('Spotify controls respond immediately, coalesce rapid input, and recover from failed changes',async()=>{
 await home();
 await browser.evaluate(`mediaPreview.publish('playing','Reference track','Local fixture',{
  sourceAppId:'Spotify.exe',volume:60,shuffle:false,repeatMode:'off',
  controls:{previous:true,play:true,pause:true,next:true,volume:true,shuffle:true,repeat:true}});
  mediaPreview.open('media');mediaPreview.actions.length=0;mediaPreview.controlDelay=350;`);
 await browser.settle();
 const immediate=await browser.evaluate(`(()=>{document.querySelector('.media-shuffle').click();
  document.querySelector('.media-repeat').click();document.querySelector('.media-repeat').click();
  const slider=document.querySelector('.media-session-volume-slider');
  for(const value of [76,77,78]){slider.value=value;slider.dispatchEvent(new Event('input',{bubbles:true}));}
  return {shuffle:document.querySelector('.media-shuffle').getAttribute('aria-pressed'),
   repeat:document.querySelector('.media-repeat').dataset.mode,volume:document.querySelector('.media-session-volume-value').textContent,
   confirmed:mediaPreview.store.snapshot().player.shuffle,busy:document.querySelector('.media-controls').getAttribute('aria-busy'),
   fill:document.querySelector('.media-session-volume').style.getPropertyValue('--volume-fill')};})()`);
 assert.deepEqual(immediate,{shuffle:'true',repeat:'track',volume:'78%',confirmed:false,busy:'false',fill:'78%'});
 await browser.capture('reference-media-control-response');
 await browser.evaluate('new Promise(resolve=>setTimeout(resolve,1600))');
 const settled=await browser.evaluate(`(()=>{const p=mediaPreview.store.snapshot().player;return {shuffle:p.shuffle,repeat:p.repeatMode,volume:p.volume,actions:mediaPreview.actions};})()`);
 assert.deepEqual({shuffle:settled.shuffle,repeat:settled.repeat,volume:settled.volume},{shuffle:true,repeat:'track',volume:78});
 assert.equal(settled.actions.filter(action=>'volume' in action).length,1);
 await browser.evaluate(`mediaPreview.controlDelay=60;mediaPreview.controlError=true;document.querySelector('.media-shuffle').click();
  const slider=document.querySelector('.media-session-volume-slider');slider.value=31;slider.dispatchEvent(new Event('input',{bubbles:true}));`);
 await browser.settle();
 assert.equal(await browser.evaluate(`document.querySelector('.media-shuffle').getAttribute('aria-pressed')`),'true');
 assert.equal(await browser.evaluate(`document.querySelector('.media-session-volume-slider').value`),'78');
 assert.equal(await browser.evaluate(`document.querySelector('.media-session-volume-value').textContent`),'78%');
 await browser.evaluate(`mediaPreview.controlError=false;mediaPreview.controlDelay=0;
  mediaPreview.publish('playing','Other player','Local fixture',{sourceAppId:'Player.exe',shuffle:false,repeatMode:'off',controls:{play:true,shuffle:true,repeat:true}})`);
 assert.equal(await browser.evaluate(`document.querySelector('.media-shuffle').hidden&&document.querySelector('.media-repeat').hidden`),true);
 assert.deepEqual(browser.errors,[]);
});

test('Right-click tab controls include Refresh and no obsolete position reset',async()=>{
 await home();
 await browser.evaluate(`document.querySelector('[data-section=overview]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:80,clientY:40}))`);
 const actions=await browser.evaluate(`[...document.querySelectorAll('.mimo-quick-action')].map(button=>button.textContent)`);
 assert.ok(actions.includes('Refresh'));
 assert.ok(!actions.some(label=>/position|Return to top/i.test(label)));
 await browser.evaluate(`document.querySelector('.mimo-quick-menu').hidePopover()`);
});

test('Shelf fills the expanded content and scrolls inside its card at the native cap',async()=>{
 for(const scale of [1,2]) {
  await home(scale);
  await browser.evaluate(`(async()=>{const {Bridge}=await import('/src/core/bridge.ts');Bridge.grabRead=async()=>({items:Array.from({length:18},(_,index)=>({
   id:'reference-'+index,label:'Reference '+index+'.png',note:'',collection:'',createdAt:Date.now(),mime:'image/png',size:1000,source:'desktop',annotations:[]})),retentionDays:7,detached:false});mediaPreview.open('grab')})()`);
  await browser.settle();await browser.settle();
  const result=await browser.evaluate(`(()=>{const card=document.querySelector('.grab-surface').getBoundingClientRect(),content=document.querySelector('#views').getBoundingClientRect(),
   shell=document.querySelector('#island').getBoundingClientRect(),grid=document.querySelector('.grab-files');
   return {card:card.toJSON(),content:content.toJSON(),shell:shell.toJSON(),scroll:grid.scrollHeight>grid.clientHeight};})()`);
  assert.ok(Math.abs(result.card.width-result.content.width)<1);assert.ok(result.card.bottom<=result.content.bottom+1);
  assert.equal(Math.round(result.shell.height),432);assert.equal(result.scroll,true);
  await browser.capture('reference-shelf-'+scale+'x');
 }
});

test('Media uses a left audio pill and moves Mimo between empty and playing states',async()=>{
 for(const scale of [1,2]) {
  await home(scale);await browser.evaluate(`mediaPreview.publish('none');mediaPreview.open('media')`);await browser.settle();
  assert.equal(await browser.evaluate(`document.querySelector('.media-empty > svg')`),null);
  assert.ok(Math.abs(await browser.evaluate(`mediaPreview.island.botCx.target`)-320)<1);
  await browser.capture('reference-media-empty-'+scale+'x');
  await browser.evaluate(`mediaPreview.publish('playing','Reference track','Local fixture');mediaPreview.open('media')`);await browser.settle();
  assert.ok(await browser.evaluate(`mediaPreview.island.botCx.target`)>500);
  const geometry=await browser.evaluate(`(()=>{const pill=document.querySelector('.audio-disclosure'),panel=document.querySelector('.audio-panel'),
   card=document.querySelector('.media-row.is-dedicated').getBoundingClientRect(),r=pill.getBoundingClientRect();return {
    open:pill.getAttribute('aria-expanded'),width:r.width,left:r.left-card.left,border:getComputedStyle(panel).borderTopWidth,
    radius:getComputedStyle(pill).borderRadius,height:card.height};})()`);
  assert.equal(geometry.open,'false');assert.ok(geometry.width<160);assert.ok(geometry.left<25);
  assert.equal(geometry.border,'0px');assert.equal(geometry.radius,'999px');assert.ok(geometry.height<250);
  await browser.capture('reference-media-playing-'+scale+'x');
  await browser.click('.audio-disclosure');await browser.settle();
  assert.equal(await browser.evaluate(`document.querySelector('.audio-body').hidden`),false);
  assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('.audio-body')).borderTopWidth`),'0px');
  await browser.click('.audio-disclosure');
 }
 assert.deepEqual(browser.errors,[]);
});
