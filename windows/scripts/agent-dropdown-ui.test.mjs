// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mimoBrowser} from './mimo-browser.mjs';

test('agent dropdowns accept selections while live sessions update', {timeout:90000}, async()=>{
  const browser=await mimoBrowser({port:1497});
  try {
    await browser.evaluate(`(async()=>{
      const {Bridge}=await import('/src/core/bridge.ts');
      const {Activity}=await import('/src/core/activity.ts');
      const usage={primary:{usedPercent:25,windowMinutes:300,resetsAt:Date.now()/1000+3600},secondary:null,checkedAt:Date.now()/1000};
      Bridge.codexUsage=Bridge.claudeUsage=async()=>usage;
      Activity.observeUsage('codex',usage);Activity.observeUsage('claude',usage);
      mediaPreview.preferences({hooksInstalled:true,codexHooksInstalled:true,codingHooksInstalled:{cursor:true},usageEnabled:true,workingModeEnabled:false,autoCollapseEnabled:false,
        modules:{vscode:true,developerIntegrations:false,media:true}});
      mediaPreview.state.tasks=mediaPreview.state.tasks.filter(task=>!task.sessionId);
      for(const [provider,session] of [['codex','dropdown-code'],['claude','dropdown-docs']]){
        const task=mediaPreview.state.upsertCodingTask(provider,provider,'C:/work/'+session,session);
        task.state='working';task.lastEventAt=Date.now();
        task.activity={tool:'Edit',action:'Edit',target:'src/'+provider+'.ts',phase:'running'};
      }
      mediaPreview.state.selectCodingTask('session_codex_dropdown-code');
      mediaPreview.state.usageProvider='codex';mediaPreview.publish('playing');mediaPreview.open('overview');
    })()`);
    await browser.settle();
    assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('.header-account [role=option]')].map(option=>option.dataset.device)"),['claude','codex'],
      'An installed relay alone does not add an undetected agent to Limits');

    async function chooseDuringUpdate(trigger, option, update) {
      await browser.click(trigger);await browser.settle();
      assert.equal(await browser.evaluate(`(()=>{const menu=document.querySelector('.audio-device-menu:popover-open');
        return [...menu.querySelectorAll('[role=option]')].every(row=>row.getBoundingClientRect().width>=menu.clientWidth-12&&getComputedStyle(row).display==='flex');})()`),true,
        'Every menu row keeps its full-width listbox layout');
      const point=await browser.evaluate(`(()=>{const button=document.querySelector('.audio-device-menu:popover-open [data-device="${option}"]');
        const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await browser.command('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
      await browser.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
      await browser.evaluate(`(()=>{${update}})()`);
      await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await browser.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
      await browser.settle();
    }

    await chooseDuringUpdate('.header-agent-select','claude',
      "mediaPreview.state.upsertCodingTask('cursor','Cursor','C:/work/cursor','dropdown-cursor');mediaPreview.state.notify()");
    assert.equal(await browser.evaluate('mediaPreview.state.usageProvider'),'claude','Limits selection survives a newly connected agent');
    assert.equal(await browser.evaluate('mediaPreview.state.view'),'overview');
    await browser.evaluate("mediaPreview.state.removeTask('session_cursor_dropdown-cursor');mediaPreview.state.notify()");

    for(const terminal of [false,true]){
      await browser.evaluate("mediaPreview.state.selectCodingTask('session_codex_dropdown-code')");
      if(terminal)await browser.click('.coding-preview-trigger');
      await browser.settle();
      await chooseDuringUpdate('.coding-session-select','session_claude_dropdown-docs',
        "const task=mediaPreview.state.tasks.find(task=>task.sessionId==='dropdown-docs');task.state=task.state==='thinking'?'working':'thinking';mediaPreview.state.notify()");
      assert.equal(await browser.evaluate('mediaPreview.state.selectedCodingId'),'session_claude_dropdown-docs',
        (terminal?'Terminal':'Home')+' selection survives activity arriving between press and release');
      await browser.capture(terminal?'agent-dropdown-terminal':'agent-dropdown-home');
    }
    await browser.evaluate("mediaPreview.state.lastCodingId='session_codex_dropdown-code';mediaPreview.state.notify()");
    assert.equal(await browser.evaluate('mediaPreview.state.codingTask.id'),'session_claude_dropdown-docs','Manual selection stays stable while another agent works');
    async function key(key,code,keyCode,text){
      await browser.command('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:keyCode,...(text?{text}:{})});
      await browser.command('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:keyCode});
    }
    await browser.click('.coding-session-select');await browser.settle();
    await key('Home','Home',36);await key('Enter','Enter',13,'\r');await browser.settle();
    assert.equal(await browser.evaluate('mediaPreview.state.selectedCodingId'),null,'Keyboard selection can return to Auto');
    assert.equal(await browser.evaluate('mediaPreview.state.codingTask.id'),'session_codex_dropdown-code');

    await browser.evaluate("mediaPreview.open('usage')");await browser.settle();
    await browser.click('.usage-agent-select');await browser.settle();
    await browser.click('.audio-device-menu:popover-open [data-device="codex"]');await browser.settle();
    assert.equal(await browser.evaluate('mediaPreview.state.usageProvider'),'codex');
    assert.equal(await browser.evaluate("document.querySelector('.agent-usage').dataset.usageProvider"),'codex');
    assert.equal(await browser.evaluate("document.querySelector('.header-agent-select').title"),'Codex');
    for(const scale of [1,2]){
      await browser.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:scale,mobile:false});
      await browser.click('.header-agent-select');await browser.settle();
      const bounds=await browser.evaluate(`(()=>{const menu=document.querySelector('.audio-device-menu:popover-open');const r=menu.getBoundingClientRect();
        return {inside:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,
          namesFit:[...menu.querySelectorAll('.audio-device-option-title')].every(title=>{
            const range=document.createRange();range.selectNodeContents(title);const text=range.getBoundingClientRect(),copy=title.parentElement.getBoundingClientRect();
            return copy.width>20&&text.width<=copy.width&&text.height<=parseFloat(getComputedStyle(title).lineHeight)*1.5;})};})()`);
      assert.deepEqual(bounds,{inside:true,namesFit:true});
      await browser.capture('agent-dropdown-limits-'+scale+'x');
      await key('Escape','Escape',27);await browser.settle();
      assert.equal(await browser.evaluate("document.querySelector('.header-agent-select').getAttribute('aria-expanded')"),'false');
      assert.equal(await browser.evaluate('mediaPreview.state.visibility'),'expanded','Escape dismisses only the picker');
    }
    assert.equal(await browser.evaluate('mediaPreview.store.snapshot().state.playbackState'),'playing');
    await browser.evaluate("mediaPreview.state.removeTask('session_claude_dropdown-docs');mediaPreview.state.notify()");
    await browser.settle();
    assert.deepEqual(await browser.evaluate(`({header:document.querySelector('.header-account').hidden,
      limits:document.querySelector('.usage-agent-select').closest('.audio-device-picker').hidden,
      name:document.querySelector('.usage-agent-name').textContent,
      provider:document.querySelector('.agent-usage').dataset.usageProvider})`),
      {header:true,limits:true,name:'Codex',provider:'codex'},'Both Limits switchers hide when only one agent remains');
    await browser.evaluate("mediaPreview.state.upsertCodingTask('codex','Codex','C:/work/second-codex','dropdown-second-codex');mediaPreview.state.notify()");
    assert.equal(await browser.evaluate("document.querySelector('.header-account').hidden"),true,'Two sessions of one agent do not expose the provider switcher');
    await browser.evaluate("mediaPreview.state.upsertCodingTask('claude','Claude','C:/work/docs','dropdown-docs-returned');mediaPreview.state.notify()");
    await browser.settle();
    assert.equal(await browser.evaluate("document.querySelector('.header-account').hidden"),false,'Detecting a different agent restores the switcher');
    assert.equal(await browser.evaluate("document.querySelector('.usage-agent-select').closest('.audio-device-picker').hidden"),false);
    assert.deepEqual(browser.errors,[]);
  }finally{await browser.close();}
});
