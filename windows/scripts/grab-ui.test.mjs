// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test,before,after,beforeEach} from 'node:test';
import {mimoBrowser} from './mimo-browser.mjs';
let b;
before(async()=>{b=await mimoBrowser({port:1455});});
after(async()=>{await b?.close();});
beforeEach(async()=>{
 await b.command('Page.reload');await new Promise(resolve=>setTimeout(resolve,600));
 await b.evaluate("new Promise((resolve,reject)=>{const until=performance.now()+8000;const wait=()=>window.mediaPreview?.island?resolve():performance.now()>until?reject(new Error('Preview did not initialize')):setTimeout(wait,30);wait()})");
 await b.evaluate(`(async()=>{
  const {Bridge}=await import('/src/core/bridge.ts');const c=document.createElement('canvas');c.width=720;c.height=460;const x=c.getContext('2d');
  x.fillStyle='#182226';x.fillRect(0,0,720,460);x.fillStyle='#243d44';x.fillRect(26,26,668,240);x.fillStyle='#afddce';x.font='600 32px Segoe UI';x.fillText('A little inspiration.',48,120);x.fillStyle='#e8edf0';x.font='20px Segoe UI';x.fillText('Soft panels. Clear controls.',48,162);
  x.fillStyle='#385258';for(let i=0;i<3;i++)x.fillRect(26+i*230,284,208,140);
  const image=c.toDataURL('image/png');window.grabFixture={calls:[],image,snapshot:{items:[1,2,3].map(i=>({id:'r'+i,label:['Hero layout','Navigation','Card styling'][i-1],note:'',collection:'Website',createdAt:Date.now(),mime:'image/png',width:720,height:460,size:1000,source:'desktop',duplicateOf:null,annotations:[],annotated:false})),retentionDays:7,shortcut:'Ctrl+Alt+G',shortcutStatus:{registered:true,error:null},detached:false}};
  const f=grabFixture;Bridge.grabRead=async()=>structuredClone(f.snapshot);
  Bridge.grabAction=async(action,args={})=>{f.calls.push([action,structuredClone(args)]);
   if(action==='preview')return {image:f.image,annotations:f.snapshot.items.find(r=>r.id===args.id).annotations};
   if(action==='edit')Object.assign(f.snapshot.items.find(r=>r.id===args.id),args);
   if(action==='annotate'){Object.assign(f.snapshot.items.find(r=>r.id===args.id),{annotations:args.annotations,transform:args.transform,annotated:true});}
   if(action==='reorder')f.snapshot.items.sort((a,b)=>args.ids.indexOf(a.id)-args.ids.indexOf(b.id));
   if(action==='delete')f.snapshot.items=f.snapshot.items.filter(r=>!args.ids.includes(r.id));
   if(action==='detach'){f.snapshot.detached=true;mediaPreview.island.setGrabDetached(true);}
   if(action==='dock'||action==='capture_target'){f.snapshot.detached=false;mediaPreview.island.setGrabDetached(false);}
   if(action==='copy')return {message:'Copied references.',count:args.ids.length};
   if(action==='preferences')Object.assign(f.snapshot,args);
   if(action==='import'){f.snapshot.items.push({...f.snapshot.items[0],id:'dropped',label:'notes.txt',mime:'application/octet-stream'});}
   return true;
  };
  mediaPreview.preferences({workingModeEnabled:false,modules:{vscode:false,media:true,developerIntegrations:false},activeIntegrations:[]});mediaPreview.open('grab');
 })()`);await b.settle();
});
function clickText(label){return b.evaluate(`(()=>{const button=[...document.querySelectorAll('.grab-view.on button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!button)throw new Error('Missing '+${JSON.stringify(label)});button.click();})()`);}

test('Mimo Shelf has one shared card, a quiet file grid and outlined selection beside settings',async()=>{
 assert.deepEqual(await b.evaluate("[...document.querySelectorAll('.section-tab')].map(b=>b.getAttribute('aria-label'))"),['Home','Chat','Mimo Shelf']);
 assert.equal(await b.evaluate("document.querySelectorAll('.grab-card,.grab-stage,.grab-peek,.grab-selected-preview').length"),0);
 assert.equal(await b.evaluate("document.querySelectorAll('.grab-file-preview').length"),3);
 assert.equal(await b.evaluate("document.querySelector('.grab-count').textContent"),'3 items');
 assert.equal(await b.evaluate("document.querySelectorAll('.grab-companion-panel').length"),0);
 assert.equal(await b.evaluate("document.querySelector('[data-section=grab] svg').getAttribute('fill')"),'currentColor');
 assert.equal(await b.evaluate("[...document.querySelectorAll('.grab-view button')].some(b=>/^(Capture|Detach|Return Mimo)$/.test(b.textContent))"),false);
 assert.equal(await b.evaluate("document.querySelector('.grab-view.on').textContent.includes('Codex')"),false);
 assert.equal(await b.evaluate("document.querySelector('.grab-view.on input[placeholder=\"https://…\"]')"),null);
 const geometry=await b.evaluate("(()=>{const s=document.querySelector('.grab-surface');return {height:s.getBoundingClientRect().height,overflow:s.scrollHeight>s.clientHeight};})()");
 assert.ok(geometry.height>240&&geometry.height<270);assert.equal(geometry.overflow,false);
 assert.equal(await b.evaluate("(()=>{const grid=document.querySelector('.grab-files');return grid.scrollHeight>grid.clientHeight})()"),false);
 const card=await b.evaluate("(()=>{const surface=getComputedStyle(document.querySelector('.grab-surface')),select=document.querySelector('.grab-select-all'),button=getComputedStyle(select);return {fill:surface.backgroundColor,radius:surface.borderRadius,edge:surface.boxShadow,adjacent:select.nextElementSibling.getAttribute('aria-label'),outline:button.borderTopStyle,border:button.borderTopWidth}})()");
 assert.notEqual(card.fill,'rgba(0, 0, 0, 0)');assert.equal(card.radius,'16px');assert.notEqual(card.edge,'none');assert.equal(card.adjacent,'Shelf options');assert.equal(card.outline,'solid');assert.equal(card.border,'1px');
 assert.equal(await b.evaluate("grabFixture.calls.some(c=>c[0]==='preview')"),false);
 assert.equal(await b.evaluate("getComputedStyle(document.querySelector('.grab-file-preview')).backgroundColor"),'rgba(0, 0, 0, 0)');
 await b.capture('mimo-grab-shelf-1x');await b.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:2,mobile:false});await b.capture('mimo-grab-shelf-2x');
 await b.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:1,mobile:false});assert.deepEqual(b.errors,[]);
});

test('Shelf grows with actual file rows at both display scales and scrolls only at the native cap',async()=>{
 const metrics=()=>b.evaluate("(()=>{const grid=document.querySelector('.grab-files'),items=[...grid.querySelectorAll('.grab-file')],rects=items.map(el=>el.getBoundingClientRect()),style=getComputedStyle(grid);return {height:document.querySelector('.grab-view').getBoundingClientRect().height+42,columns:new Set(rects.map(r=>Math.round(r.left))).size,rows:new Set(rects.map(r=>Math.round(r.top))).size,scroll:grid.scrollHeight>grid.clientHeight,rowHeight:rects[0].height,gap:parseFloat(style.rowGap)};})()");
 const one=await metrics();assert.equal(one.height,304);assert.equal(one.rows,1);assert.equal(one.scroll,false);assert.ok(one.columns>=3);
 async function populate(count){await b.evaluate(`(()=>{const original=grabFixture.snapshot.items[0];grabFixture.snapshot.items=Array.from({length:${count}},(_,i)=>({...original,id:'many-'+i,label:'Reference '+(i+1)+'.png'}));mediaPreview.open('overview')})()`);await b.settle();await b.evaluate("mediaPreview.open('grab')");await b.settle();}
 const count=await b.evaluate("getComputedStyle(document.querySelector('.grab-files')).gridTemplateColumns.trim().split(/\\s+/).length");
 await populate(count+1);const two=await metrics();assert.equal(two.rows,2);assert.ok(two.height>one.height&&two.height<432);assert.equal(two.scroll,false);
 await b.capture('mimo-grab-two-rows-1x');
 await b.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:2,mobile:false});await b.settle();await b.capture('mimo-grab-two-rows-2x');assert.deepEqual(await metrics(),two);
 await b.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:1,mobile:false});
 await b.evaluate("document.querySelector('.grab-surface').style.width='270px'");await b.settle();const narrow=await metrics();assert.ok(narrow.columns<two.columns);assert.ok(narrow.height>two.height);assert.equal(narrow.height,432);assert.equal(narrow.scroll,true);
 await b.evaluate("document.querySelector('.grab-surface').style.width=''");await b.settle();assert.equal((await metrics()).height,two.height);
 await populate(count*2+1);const three=await metrics();assert.equal(three.rows,3);assert.ok(three.height>two.height);assert.equal(three.height,432);assert.equal(three.scroll,true);
 await b.capture('mimo-grab-three-rows-1x');
 await b.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:2,mobile:false});await b.settle();await b.capture('mimo-grab-three-rows-2x');assert.deepEqual(await metrics(),three);
 await b.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:1,mobile:false});assert.deepEqual(b.errors,[]);
});

test('Shelf copies selected files in shelf order and keeps clearing explicit',async()=>{
 await clickText('Copy paths');await b.settle();
 assert.deepEqual(await b.evaluate("grabFixture.calls.find(c=>c[0]==='copy')[1].ids"),['r1','r2','r3']);
 assert.equal(await b.evaluate("grabFixture.calls.some(c=>['prepare','confirm','send'].includes(c[0]))"),false);
 await b.evaluate("document.querySelector('[aria-label=\"Include Hero layout\"]').click();document.querySelector('[aria-label=\"Include Card styling\"]').click();grabFixture.calls=[]");
 await clickText('Copy paths');await b.settle();assert.deepEqual(await b.evaluate("grabFixture.calls.find(c=>c[0]==='copy')[1].ids"),['r1','r3']);
 await clickText('Clear');assert.equal(await b.evaluate('grabFixture.snapshot.items.length'),3);
 await clickText('Keep');assert.equal(await b.evaluate('grabFixture.snapshot.items.length'),3);
 await clickText('Clear');await clickText('Remove');await b.settle();assert.equal(await b.evaluate('grabFixture.snapshot.items.length'),0);
 assert.equal(await b.evaluate("document.querySelector('.grab-copy').disabled"),true);
 assert.equal(await b.evaluate("(()=>{const grid=document.querySelector('.grab-files');return grid.scrollHeight>grid.clientHeight})()"),false);
});

test('PDF and other dropped files use the same shelf without an image preview error',async()=>{
 await b.evaluate("grabFixture.snapshot.items.push({...grabFixture.snapshot.items[0],id:'pdf',label:'brief.pdf',mime:'application/pdf',width:0,height:0});mediaPreview.open('overview')");await b.settle();await b.evaluate("mediaPreview.open('grab')");await b.settle();
 assert.equal(await b.evaluate("document.querySelector('[data-reference=pdf] .grab-thumb').dataset.kind"),'pdf');
 assert.equal(await b.evaluate("document.querySelector('[data-reference=pdf] img')"),null);
 await b.capture('mimo-grab-pdf-card-1x');
 await b.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:2,mobile:false});await b.capture('mimo-grab-pdf-card-2x');
 await b.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:1,mobile:false});
 await b.click('[aria-label="Preview brief.pdf"]');await b.settle();
 assert.notEqual(await b.evaluate("document.querySelector('.grab-status').dataset.error"),'true');
 assert.equal(await b.evaluate("document.querySelector('[aria-label=\"Reference name\"]').value"),'brief.pdf');
 await clickText('Save');await b.settle();await b.evaluate("document.querySelector('[aria-label=\"Include brief.pdf\"]').click()");await clickText('Copy paths');await b.settle();
 assert.deepEqual(await b.evaluate("grabFixture.calls.find(c=>c[0]==='copy')[1].ids"),['pdf']);
});

test('References keep original resolution and separate annotations with editable labels and notes',async()=>{
 await b.click('[aria-label="Preview Hero layout"]');await b.settle();
 await clickText('Edit');await b.settle();
 assert.deepEqual(await b.evaluate("(()=>{const c=document.querySelector('.grab-preview-scroll canvas');return [c.width,c.height]})()"),[720,460]);
 await b.evaluate("document.querySelector('[aria-label=\"Reference name\"]').value='Hero';document.querySelector('[aria-label=\"Reference name\"]').dispatchEvent(new Event('input'));document.querySelector('[aria-label=\"Reference note\"]').value='Use this spacing';document.querySelector('[aria-label=\"Reference note\"]').dispatchEvent(new Event('input'))");
 const point=await b.evaluate("(()=>{const r=document.querySelector('.grab-preview-scroll canvas').getBoundingClientRect();return {x:r.x+30,y:r.y+30}})()");
 await b.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await b.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+90,y:point.y+30,buttons:1});await b.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:point.x+90,y:point.y+30});
 await b.capture('mimo-grab-reference');await clickText('Save');await b.settle();
 const result=await b.evaluate("grabFixture.calls.find(c=>c[0]==='annotate')[1]");assert.equal(result.annotations.length,1);assert.equal(result.annotations[0].tool,'arrow');assert.ok(result.image.startsWith('data:image/png;base64,'));
 assert.equal(await b.evaluate("grabFixture.snapshot.items[0].note"),'Use this spacing');
 assert.equal(await b.evaluate("grabFixture.image===grabFixture.calls.find(c=>c[0]==='annotate')[1].image"),false);
});

test('Ctrl reveals Mimo from the working lip, prevents hover expansion and captures on release',async()=>{
 await b.evaluate("mediaPreview.publish('none');mediaPreview.open('overview');mediaPreview.preferences({workingModeEnabled:true});mediaPreview.island.visibility.peek()");await b.settle();
 assert.equal(await b.evaluate('mediaPreview.state.visibility'),'peek');
 await b.evaluate("mediaPreview.island.setGrabModifier(true)");await b.settle();
 assert.equal(await b.evaluate('mediaPreview.state.visibility'),'island');
 const point=await b.evaluate("(()=>{const r=document.querySelector('#pat-mimo').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2).id}})()");
 assert.equal(point.hit,'pat-mimo');delete point.hit;
 await b.evaluate("grabFixture.events=[];for(const name of ['pointerdown','pointermove','pointercancel','pointerup'])document.addEventListener(name,e=>grabFixture.events.push([name,e.target.id,e.button,e.ctrlKey,!!mediaPreview.island.grabDrag]),true)");
 await b.command('Input.dispatchMouseEvent',{type:'mouseMoved',...point,modifiers:2});await b.command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1,modifiers:2});
 await b.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+40,y:point.y+130,buttons:1,modifiers:2});
 await b.settle();assert.equal(await b.evaluate('mediaPreview.state.visibility'),'island');
 assert.equal(await b.evaluate("grabFixture.calls.filter(c=>c[0]==='detach').length"),1,JSON.stringify(await b.evaluate("({events:grabFixture.events,drag:mediaPreview.island.grabDrag,disabled:document.querySelector('#pat-mimo').disabled,errors:grabFixture.calls,view:mediaPreview.state.view})")));
 await b.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+40,y:point.y+130,button:'left',clickCount:1,modifiers:2});await b.settle();
 assert.equal(await b.evaluate("grabFixture.calls.filter(c=>c[0]==='capture_target').length"),1);
 assert.equal(await b.evaluate('grabFixture.snapshot.detached'),false);assert.equal(await b.evaluate('mediaPreview.state.view'),'grab');
});

test('A completed capture opens the expanded editor with Edit and Save, preserving the shelf',async()=>{
 await b.evaluate("document.dispatchEvent(new CustomEvent('grab-captured-preview',{detail:'r3'}))");await b.settle();
 assert.equal(await b.evaluate("document.querySelector('.grab-view').dataset.scene"),'detail');
 assert.equal(await b.evaluate("[...document.querySelectorAll('.grab-footer button')].some(b=>b.textContent==='Edit')"),true);
 assert.equal(await b.evaluate("document.querySelector('.grab-tools').hidden"),true);
 const bounds=await b.evaluate("(()=>{const c=document.querySelector('.grab-preview-scroll canvas').getBoundingClientRect(),s=document.querySelector('.grab-preview-scroll').getBoundingClientRect(),p=document.querySelector('.grab-surface');return {fits:c.height<=s.height+.1&&c.width<=s.width+.1,overflow:p.scrollHeight>p.clientHeight,height:p.getBoundingClientRect().height}})()");
 assert.equal(bounds.fits,true);assert.equal(bounds.overflow,false);assert.ok(bounds.height>300);
 await b.capture('mimo-grab-capture-ready');await clickText('Save');await b.settle();assert.equal(await b.evaluate("document.querySelector('[data-reference=r3] .grab-file-name').textContent"),'Card styling');
});

test('Shelf keyboard navigation stays quiet and image previews load only on opening',async()=>{
 await b.evaluate("(async()=>{const {Sound}=await import('/src/core/sound.ts');grabFixture.sounds=[];Sound.play=name=>grabFixture.sounds.push(name);document.querySelector('.grab-file-preview').focus();})()");
 await b.command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await b.settle();
 await b.command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
 assert.equal(await b.evaluate("document.activeElement.getAttribute('aria-label')"),'Preview Navigation');
 assert.deepEqual(await b.evaluate('grabFixture.sounds'),['tick']);
 assert.equal(await b.evaluate("grabFixture.calls.some(c=>c[0]==='preview')"),false);
 await b.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,text:'\r'});await b.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await b.settle();
 assert.equal(await b.evaluate("document.querySelector('.grab-view').dataset.scene"),'detail',JSON.stringify(await b.evaluate("({scene:document.querySelector('.grab-view').dataset.scene,focus:document.activeElement.outerHTML,visibility:mediaPreview.state.visibility,view:mediaPreview.state.view,calls:grabFixture.calls,errors:document.querySelector('.grab-status').textContent})")));
 assert.equal(await b.evaluate("document.querySelector('.grab-preview-scroll canvas').width"),720);
 assert.equal(await b.evaluate("grabFixture.calls.filter(c=>c[0]==='preview').length"),1);
});

test('Shelf grouping and drag ordering preserve metadata and clipboard order',async()=>{
 await b.evaluate("document.querySelector('[aria-label=\"Include Hero layout\"]').click();document.querySelector('[aria-label=\"Include Card styling\"]').click()");
 await clickText('Group');await b.evaluate("const field=document.querySelector('[aria-label=\"Collection name\"]');field.value='Design references';field.dispatchEvent(new Event('input'))");await clickText('Save');await b.settle();
 assert.deepEqual(await b.evaluate("grabFixture.snapshot.items.map(r=>r.collection)"),['Design references','Website','Design references']);
 await b.evaluate("const transfer=new DataTransfer();transfer.setData('application/x-mimo-reference','r3');document.querySelector('[data-reference=r1]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));");await b.settle();
 assert.deepEqual(await b.evaluate("grabFixture.snapshot.items.map(r=>r.id)"),['r3','r1','r2']);
 await clickText('Copy paths');await b.settle();assert.deepEqual(await b.evaluate("grabFixture.calls.find(c=>c[0]==='copy')[1].ids"),['r3','r1']);
 assert.equal(await b.evaluate("grabFixture.snapshot.items[0].label"),'Card styling');
});

test('Shelf options retain instructions and the real retention preference',async()=>{
 await b.click('[aria-label="Shelf options"]');await b.evaluate("const keep=document.querySelector('[aria-label=\"Keep files\"]');keep.value='30';const note=document.querySelector('[aria-label=\"Note to copy (optional)\"]');note.value='Follow these references';note.dispatchEvent(new Event('input'))");
 assert.equal(await b.evaluate("(()=>{const s=document.querySelector('.grab-surface');return s.scrollHeight>s.clientHeight})()"),false);
 await clickText('Save');await b.settle();assert.equal(await b.evaluate('grabFixture.snapshot.retentionDays'),30);
 await clickText('Copy paths');await b.settle();assert.equal(await b.evaluate("grabFixture.calls.find(c=>c[0]==='copy')[1].instruction"),'Follow these references');
});

test('Crop, resize and zoom preserve the full-resolution original and can undo edits',async(t)=>{
 await b.command('Emulation.setDeviceMetricsOverride',{width:720,height:560,deviceScaleFactor:1,mobile:false});
 t.after(()=>b.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:1,mobile:false}));
 await b.click('[aria-label="Preview Card styling"]');await b.settle();await b.click('[aria-label="Zoom in"]');
 assert.equal(await b.evaluate("document.querySelector('.grab-preview-scroll').dataset.actual"),'true');
 await b.evaluate("document.querySelector('.grab-zoom button:nth-child(2)').click()");await clickText('Edit');await clickText('Resize');await b.settle();
 await b.evaluate("const width=document.querySelector('[aria-label=\"Image width\"]');width.value='360';width.dispatchEvent(new Event('input'))");
 assert.equal(await b.evaluate("document.querySelector('[aria-label=\"Image height\"]').value"),'230');
 await clickText('Apply');assert.deepEqual(await b.evaluate("(()=>{const c=document.querySelector('.grab-preview-scroll canvas');return [c.width,c.height]})()"),[360,230]);
 await clickText('Crop');
 const points=await b.evaluate("(()=>{const r=document.querySelector('.grab-preview-scroll canvas').getBoundingClientRect();return {x:r.x+r.width*.1,y:r.y+r.height*.1,endX:r.x+r.width*.8,endY:r.y+r.height*.8};})()");
 await b.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:points.x,y:points.y});
 await b.command('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:1,x:points.endX,y:points.endY});
 await b.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:points.endX,y:points.endY});
 assert.deepEqual(await b.evaluate("(()=>{const c=document.querySelector('.grab-preview-scroll canvas');return [c.width,c.height]})()"),[252,161]);
 await clickText('Undo');assert.equal(await b.evaluate("document.querySelector('.grab-preview-scroll canvas').width"),360);
 await clickText('Save');await b.settle();
 const saved=await b.evaluate("grabFixture.calls.find(c=>c[0]==='annotate')[1]");assert.equal(saved.transform.width,360);assert.equal(saved.transform.height,230);
 assert.deepEqual(await b.evaluate("[grabFixture.snapshot.items[2].width,grabFixture.snapshot.items[2].height]"),[720,460]);
 assert.deepEqual(await b.evaluate("(async()=>{const i=new Image();i.src=grabFixture.calls.find(c=>c[0]==='annotate')[1].image;await i.decode();return [i.naturalWidth,i.naturalHeight]})()"),[360,230]);
});

test('Multiple active agents use the right-aligned footer below Home without a duplicate heading',async()=>{
 await b.evaluate("mediaPreview.preferences({modules:{vscode:true,developerIntegrations:true,media:false},codexHooksInstalled:true,hooksInstalled:true});const a=mediaPreview.state.upsertCodingTask('codex','App','C:/work/app','a');const b=mediaPreview.state.upsertCodingTask('claude','Docs','C:/work/docs','b');for(const t of [a,b]){t.state='working';t.lastEventAt=Date.now();}mediaPreview.state.selectCodingTask(a.id);mediaPreview.open('overview')");await b.settle();
 const selector=await b.evaluate("(()=>{const el=document.querySelector('.home-session-selector'),footer=el.closest('.coding-session-footer'),surface=document.querySelector('.home-workspace'),p=el.getBoundingClientRect(),f=footer.getBoundingClientRect(),card=surface.getBoundingClientRect();return {visible:!el.hidden,right:p.right>f.left+f.width/2&&f.right-p.right<=13,below:f.top>=card.bottom-1,leftHeading:document.querySelector('.coding-home-context').hidden};})()");
 assert.deepEqual(selector,{visible:true,right:true,below:true,leftHeading:true});
 await b.click('.home-session-selector button');await b.settle();
 assert.equal(await b.evaluate("document.querySelector('.home-session-selector [role=listbox]').matches(':popover-open')"),true);
 await b.evaluate("const t=mediaPreview.state.tasks.find(t=>t.sessionId==='b');t.state='finished';t.activity={completed:true};mediaPreview.state.notify()");await b.settle();
 assert.equal(await b.evaluate("document.querySelector('.home-session-selector').hidden"),true);
});

test('Disconnected Mimo can be poked and keeps badge-first aura colors',async()=>{
 await b.evaluate("mediaPreview.preferences({modules:{media:false,vscode:false,developerIntegrations:false},activeIntegrations:[]});mediaPreview.open('overview');mediaPreview.state.isPinned=true;mediaPreview.island.visibility.setPinned(true)");await b.settle();
 assert.equal(await b.evaluate("document.querySelector('#pat-mimo').disabled"),false);
 for(let i=0;i<3;i++)await b.click('#pat-mimo');await b.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');assert.equal(await b.evaluate('mediaPreview.state.view'),'confused');
 const colors=await b.evaluate(`(async()=>{const {BotEngine}=await import('/src/mimo/engine.ts');const e=new BotEngine();e.bodyColor=[.2,.4,.6];e.settlePose();e.badge={kind:'check',color:[.8,.3,.1]};e.showBadge=true;const badge=e.auraColor;e.showBadge=false;const body=e.auraColor;e.destroy();return {badge,body}})()`);
 assert.deepEqual(colors,{badge:[.8,.3,.1],body:[.2,.4,.6]});assert.deepEqual(b.errors,[]);
});

test('Every panel limit readout have no five-hour text, tooltip or accessible label',async()=>{
 await b.evaluate(`(async()=>{const {Activity}=await import('/src/core/activity.ts');const {Bridge}=await import('/src/core/bridge.ts');const value={plan:'Pro',primary:{usedPercent:20,windowMinutes:300,resetsAt:Date.now()/1000+3000},secondary:null,lifetimeTokens:null,checkedAt:Date.now()/1000};Activity.observeUsage('codex',value);Bridge.codexUsage=async()=>value;mediaPreview.preferences({usageEnabled:true,modules:{vscode:true,media:true,developerIntegrations:false},codexHooksInstalled:true});})()`);
 for(const view of ['overview','media','grab','prompt','usage']){await b.evaluate(`mediaPreview.open('${view}')`);await b.settle();const result=await b.evaluate("(()=>{const b=document.querySelector('.header-limits');return [b.textContent,b.title,b.getAttribute('aria-label')]})()");for(const text of result){assert.doesNotMatch(text,/5\s*(hr|hour)|five.hour/i);}assert.ok(result[0].includes('80%'));}
});
