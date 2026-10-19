// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mimoBrowser} from './mimo-browser.mjs';
test('compact permission panel has three real choices and Always stays within the exact live session', {timeout:60000},async()=>{
  const b=await mimoBrowser({port:1499});
  try{
    await b.evaluate(`(async()=>{
      const {Bridge}=await import('/src/core/bridge.ts');const {handleHook}=await import('/src/island/hooks.ts');
      window.permissionCalls=[];Bridge.approvalAck=async()=>{};Bridge.approvalDecline=async()=>{};
      Bridge.approvalDecision=async(id,decision)=>permissionCalls.push({id,decision});
      mediaPreview.preferences({hooksInstalled:true,codexHooksInstalled:true,workingModeEnabled:false,autoCollapseEnabled:false,clockEnabled:false});
      window.permissionEvent=(id,session='alpha',command='npm test')=>handleHook(mediaPreview.island,{hook_event_name:'PermissionRequest',mimo_provider:'codex',session_id:session,cwd:'C:/work/'+session,request_id:id,tool_name:'Bash',tool_input:{command,description:"Run Mimo's local workflow checks"}});
      window.permissionEnd=()=>{handleHook(mediaPreview.island,{hook_event_name:'SessionEnd',mimo_provider:'codex',session_id:'alpha',cwd:'C:/work/alpha'});handleHook(mediaPreview.island,{hook_event_name:'SessionStart',mimo_provider:'codex',session_id:'alpha',cwd:'C:/work/alpha'});};
      permissionEvent('first');
    })()`);
    await b.settle();
    for(const scale of [1,2]){
      await b.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:scale,mobile:false});
      const ui=await b.evaluate(`(()=>{const panel=document.querySelector('.approval-view'),card=panel.querySelector('.card'),r=card.getBoundingClientRect(),dot=panel.querySelector('.coding-approval-dot'),provider=panel.querySelector('.coding-approval-provider');return {status:panel.querySelector('.coding-approval-status').textContent,weight:getComputedStyle(provider).fontWeight,color:getComputedStyle(provider).color,dim:getComputedStyle(provider).getPropertyValue('--dim').trim(),dot:getComputedStyle(dot).backgroundColor,glow:getComputedStyle(card,'::after').backgroundImage,labels:[...panel.querySelectorAll('.actions button')].map(el=>el.textContent.replace(/[NYA]$/,'')),allFit:[...panel.querySelectorAll('.code,.coding-approval-status,.coding-approval-reason,.actions button')].every(el=>{const b=el.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom}),height:document.querySelector('#island').getBoundingClientRect().height,extra:panel.querySelector('.coding-project,.ui-icon')!==null}})()`);
      assert(ui.status.startsWith('Codexneeds permission'));assert.equal(ui.weight,'700');assert.equal(ui.dot,'rgb(255, 255, 255)');
      assert.deepEqual(ui.labels,['Deny','Allow','Always']);assert(ui.glow.startsWith('radial-gradient(')&&!ui.glow.includes('at 0%'),ui.glow);assert(ui.allFit,JSON.stringify(ui));assert(ui.height<=224,JSON.stringify(ui));
      assert.equal(await b.evaluate("document.querySelector('.coding-approval-reason').textContent"),"Run Mimo's local workflow checks");
      assert.equal(ui.color,'rgb(170, 169, 174)');assert(!ui.extra);
      await b.capture('permission-compact-'+scale+'x');
    }
    await b.click('.approval-view .actions button:nth-child(3)');await b.settle();
    assert.deepEqual(await b.evaluate('permissionCalls'),[{id:'first',decision:'allow'}]);
    await b.evaluate("permissionEvent('same')");await b.settle();
    assert.deepEqual(await b.evaluate('permissionCalls.at(-1)'),{id:'same',decision:'allow'});
    assert.equal(await b.evaluate('mediaPreview.state.pendingApproval'),null);
    await b.evaluate("permissionEvent('other-session','beta')");await b.settle();
    assert.equal(await b.evaluate('mediaPreview.state.pendingApproval.requestId'),'other-session');
    await b.click('.approval-view .actions button:first-child');await b.settle();
    await b.evaluate("permissionEvent('other-command','alpha','npm publish')");await b.settle();
    assert.equal(await b.evaluate('mediaPreview.state.pendingApproval.requestId'),'other-command');
    await b.click('.approval-view .actions button:first-child');await b.settle();
    await b.evaluate("permissionEnd();permissionEvent('new-session','alpha')");await b.settle();
    assert.equal(await b.evaluate('mediaPreview.state.pendingApproval.requestId'),'new-session');
    await b.evaluate("mediaPreview.island.expand('approval');window.dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true}))");await b.settle();
    assert.deepEqual(await b.evaluate('permissionCalls.at(-1)'),{id:'new-session',decision:'allow'});
    assert.deepEqual(b.errors,[]);
  }finally{await b.close();}
});
