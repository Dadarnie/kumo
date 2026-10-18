// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mimoBrowser} from './mimo-browser.mjs';

test('three Chat pokes keep the expanded shell fitted through recovery',{timeout:60000},async()=>{
 const browser=await mimoBrowser({port:1498});
 try{
  await browser.evaluate("mediaPreview.preferences({workingModeEnabled:true,autoCollapseEnabled:true,grabEnabled:false});mediaPreview.publish('playing');mediaPreview.state.chatDraft='Preserve this draft';mediaPreview.state.chatHistory=[{role:'user',content:'Check the sizing'},{role:'assistant',content:'The reply stays here.'}];mediaPreview.open('prompt')");
  const settled=()=>browser.evaluate('new Promise(resolve=>setTimeout(resolve,1000))');
  await settled();await browser.evaluate("document.querySelector('.chat-input').focus()");
  const metrics=()=>browser.evaluate(`(()=>{const shell=document.querySelector('#island').getBoundingClientRect(),content=document.querySelector('#content').getBoundingClientRect(),view=document.querySelector('.view.on').getBoundingClientRect();return {view:mediaPreview.state.view,width:shell.width,height:shell.height,contentHeight:content.height,viewTop:view.top,viewBottom:view.bottom,shellBottom:shell.bottom,headerTop:document.querySelector('#header').getBoundingClientRect().top,scroll:document.querySelector('#content').parentElement.scrollTop};})()`);
  const before=await metrics();await browser.capture('chat-before-three-pokes');console.log('before',before);
  for(let i=0;i<3;i++)await browser.click('#pat-mimo');
  await settled();
  const reaction=await metrics();await browser.capture('chat-three-pokes-reaction');console.log('reaction',reaction);
  assert.equal(reaction.view,'confused');
  assert.equal(await browser.evaluate('mediaPreview.state.visibility'),'expanded','The reaction stays expanded when shrinking moves it away from the cursor');
  assert.ok(Math.abs(reaction.height-reaction.contentHeight)<1,'Reaction content and native shell target agree');
  assert.ok(reaction.viewBottom<=reaction.shellBottom+1,'Reaction card stays inside the shell');
  await browser.evaluate("new Promise(resolve=>setTimeout(resolve,3100))");await settled();
  const after=await metrics();await browser.capture('chat-after-three-pokes');console.log('after',after);
  assert.equal(after.view,'prompt');assert.ok(Math.abs(after.height-before.height)<1,'Chat recovers its original height');
  assert.ok(Math.abs(after.height-after.contentHeight)<1,'Restored Chat content and shell agree');
  assert.ok(Math.abs(after.viewTop-before.viewTop)<1,'Chat returns without scrolling the shell under its clip');
  assert.ok(after.headerTop>=0,'The header stays attached to the top edge');
  assert.equal(await browser.evaluate('mediaPreview.state.chatDraft'),'Preserve this draft');
  assert.equal(await browser.evaluate('mediaPreview.state.chatHistory.length'),2);
  assert.deepEqual(browser.errors,[]);
 }finally{await browser.close();}
});
