// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { mimoBrowser } from "./mimo-browser.mjs";

let browser;
before(async () => { browser = await mimoBrowser({ port: 1451 }); });
after(async () => { await browser?.close(); });
beforeEach(async () => {
  await browser.reload(); await browser.settle();
  await browser.evaluate(`(async()=>{
    const {Bridge}=await import('/src/core/bridge.ts');
    window.voiceFixture={calls:[],sounds:[],tracks:0,transcript:'Tell me a short story',
      connection:{provider:'xai',name:'Grok',readReplies:true}};
    const f=voiceFixture;
    const {Sound}=await import('/src/core/sound.ts');Sound.play=name=>f.sounds.push(name);
    f.stream=()=>({getTracks:()=>[{stop:()=>f.tracks++}]});
    f.acquire=async()=>f.stream();
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>f.acquire()}});
    window.MediaRecorder=class extends EventTarget {
      static isTypeSupported(type){return type==='audio/webm;codecs=opus'}
      state='inactive';start(){this.state='recording'}
      stop(){this.state='inactive';const event=new Event('dataavailable');event.data=new Blob([new Uint8Array([26,69,223,163,1])],{type:'audio/webm'});this.dispatchEvent(event);this.dispatchEvent(new Event('stop'))}
    };
    window.Audio=class extends EventTarget {
      constructor(url){super();this.url=url;f.playback=this}
      async play(){f.calls.push(['play'])} pause(){f.calls.push(['pause'])} removeAttribute(){} load(){}
    };
    Bridge.voiceReady=async()=>f.connection;
    Bridge.voiceTranscribe=async(audio,mime,provider)=>{f.calls.push(['transcribe',provider,mime]);return f.transcript};
    Bridge.voiceSpeak=async(text,provider)=>{f.calls.push(['speak',provider,text]);return {audio:btoa('audio'),mime:'audio/mpeg'}};
    Bridge.voiceCancel=async()=>{f.calls.push(['voiceCancel'])};
    Bridge.chatCancel=async()=>{f.calls.push(['chatCancel']);f.finishChat?.({text:'Cancelled reply'})};
    Bridge.chatSend=async query=>{f.calls.push(['chat',mediaPreview.state.settings.chatProvider,query]);return f.waitReply?new Promise(resolve=>f.finishChat=resolve):{text:'A short reply.'}};
    Bridge.openSettingsWindow=async page=>{f.calls.push(['settings',page])};
    mediaPreview.preferences({chatProvider:'gemini',workingModeEnabled:false,voiceProvider:'xai'});
    mediaPreview.state.clearChat();mediaPreview.state.chatDraft='Keep my typed draft';mediaPreview.open('prompt');
  })()`); await browser.settle();
});

const phase = () => browser.evaluate("document.querySelector('.chat-voice-button').dataset.phase||'idle'");
async function sendVoice() {
  await browser.click('.chat-voice-button');await browser.settle();
  assert.equal(await phase(),'recording');
  await browser.click('.chat-voice-button');await browser.settle();
}

test('Voice messages use the selected chat AI, retain drafts, play replies, and release the microphone',async()=>{
  await sendVoice();
  assert.equal(await phase(),'speaking');
  const result=await browser.evaluate(`({calls:voiceFixture.calls,tracks:voiceFixture.tracks,
    draft:mediaPreview.state.chatDraft,history:mediaPreview.state.chatHistory.map(m=>m.content)})`);
  assert.equal(result.tracks,1);
  assert.equal(result.draft,'Keep my typed draft');
  assert.deepEqual(result.history,['Tell me a short story','A short reply.']);
  assert.ok(result.calls.some(c=>c[0]==='transcribe'&&c[1]==='xai'));
  assert.ok(result.calls.some(c=>c[0]==='chat'&&c[1]==='gemini'&&c[2]==='Tell me a short story'));
  assert.ok(result.calls.some(c=>c[0]==='speak'&&c[1]==='xai'));
  await browser.capture('mimo-voice-chat');
  await browser.evaluate("voiceFixture.playback.dispatchEvent(new Event('ended'))");await browser.settle();
  assert.equal(await phase(),'idle');
  assert.equal(await browser.evaluate("document.querySelector('.chat-voice-status').hidden"),true);
});

test('Voice cancellation stops pending chat and discards a late reply without clearing history',async()=>{
  await browser.evaluate('voiceFixture.waitReply=true');await sendVoice();
  assert.equal(await phase(),'waiting');
  await browser.click('.chat-voice-cancel');await browser.settle();
  assert.equal(await phase(),'idle');
  assert.deepEqual(await browser.evaluate("mediaPreview.state.chatHistory.map(m=>m.role)"),['user']);
  assert.equal(await browser.evaluate("mediaPreview.state.chatError"),'');
  assert.equal(await browser.evaluate("voiceFixture.calls.some(c=>c[0]==='chatCancel')"),true);
  assert.equal(await browser.evaluate("voiceFixture.calls.some(c=>c[0]==='speak')"),false);
  assert.equal(await browser.evaluate("voiceFixture.tracks"),1);
});

test('Voice handles denied and cancelled microphone permission, then supports text-only replies',async()=>{
  await browser.evaluate("voiceFixture.acquire=async()=>{throw new DOMException('Denied','NotAllowedError')}");
  await browser.click('.chat-voice-button');await browser.settle();
  assert.equal(await phase(),'idle');
  assert.match(await browser.evaluate("mediaPreview.state.chatError"),/Allow microphone access/);
  assert.equal(await browser.evaluate("mediaPreview.state.chatDraft"),'Keep my typed draft');
  await browser.evaluate("voiceFixture.acquire=()=>new Promise(resolve=>voiceFixture.allowMic=resolve)");
  await browser.click('.chat-voice-button');await browser.settle();
  assert.equal(await phase(),'connecting');
  await browser.click('.chat-voice-cancel');
  await browser.evaluate("voiceFixture.allowMic(voiceFixture.stream())");await browser.settle();
  assert.equal(await browser.evaluate("voiceFixture.tracks"),1,'A microphone returned after cancellation is immediately released');
  await browser.evaluate("voiceFixture.acquire=async()=>voiceFixture.stream();voiceFixture.connection.readReplies=false");
  await sendVoice();
  assert.equal(await phase(),'idle');
  assert.equal(await browser.evaluate("voiceFixture.calls.some(c=>c[0]==='speak')"),false);
  assert.equal(await browser.evaluate("mediaPreview.state.chatHistory.at(-1).content"),'A short reply.');
});

test('Addressed voice commands navigate safely while preserving typed drafts and chat',async()=>{
  await browser.evaluate("voiceFixture.transcript='Mimo, open settings.'");await sendVoice();
  assert.equal(await browser.evaluate("voiceFixture.calls.some(c=>c[0]==='settings'&&c[1]==='chat')"),true);
  assert.equal(await browser.evaluate("voiceFixture.calls.some(c=>c[0]==='chat')"),false);
  assert.equal(await browser.evaluate("mediaPreview.state.chatDraft"),'Keep my typed draft');
  assert.equal(await browser.evaluate("mediaPreview.state.chatHistory.length"),0);
  await browser.evaluate(`(async()=>{const {voiceCommand}=await import('/src/core/voice-commands.ts');
    window.commandChecks=[voiceCommand('Mimo, go home.'),voiceCommand('Hey Mimo, show limits!'),
      voiceCommand('Open settings'),voiceCommand('Mimo, approve everything'),voiceCommand('Mimo, run a shell command')];})()`);
  assert.deepEqual(await browser.evaluate('commandChecks'),['home','limits',null,null,null]);
  assert.deepEqual(browser.errors,[]);
});

test('Round Mimo uses larger capsule eyes, a single-eye wink, and eyes that roll behind the head',async()=>{
  const readings=await browser.evaluate(`(async()=>{
    const {drawMimoFace}=await import('/src/mimo/face.ts');
    const canvas=document.createElement('canvas');canvas.width=canvas.height=180;const ctx=canvas.getContext('2d');
    const inspect=(wink,eyeRoll)=>{ctx.clearRect(0,0,180,180);ctx.save();ctx.translate(90,90);drawMimoFace(ctx,{radius:60,eye:'pill',wink,eyeRoll});ctx.restore();
      const pixels=ctx.getImageData(0,0,180,180).data;let left=0,right=0,sumY=0;
      for(let y=0;y<180;y++)for(let x=0;x<180;x++){const i=(y*180+x)*4;if(pixels[i]<60&&pixels[i+1]<60&&pixels[i+2]<60&&pixels[i+3]>240){if(x<90)left++;else right++;sumY+=y}}
      return {left,right,y:sumY/(left+right)};};
    return {normal:inspect(0,0),wink:inspect(1,0),above:inspect(0,Math.PI/4),behind:inspect(0,Math.PI),below:inspect(0,Math.PI*7/4)};
  })()`);
  assert.ok(readings.normal.left>300&&readings.normal.right>300);
  assert.ok(readings.wink.left<readings.normal.left*.4,JSON.stringify(readings));
  assert.equal(readings.wink.right,readings.normal.right);
  assert.ok(readings.above.y<readings.normal.y-30);
  assert.equal(readings.behind.left+readings.behind.right,0);
  assert.ok(readings.below.y>readings.normal.y+30);
});

test('Taller chat offers named model presets and an accessible custom model field',async()=>{
  await browser.evaluate(`(async()=>{const {Bridge}=await import('/src/core/bridge.ts');const {normalizeSettings}=await import('/src/core/state.ts');
    voiceFixture.selections=[];
    Bridge.chatConnections=async()=>({anthropic:true,openai:true,gemini:true,openrouter:true,xai:true,groq:true,ollama:true});
    Bridge.chatSelect=async(provider,model)=>{voiceFixture.selections.push([provider,model]);return normalizeSettings({...mediaPreview.state.settings,chatProvider:provider,chatModels:{...mediaPreview.state.settings.chatModels,[provider]:model}})};
    mediaPreview.state.chatConnectionsVersion++;mediaPreview.state.notify();})()`);await browser.settle();
  assert.ok(Math.abs(await browser.evaluate("document.querySelector('#island').getBoundingClientRect().height")-288)<.1,'Chat settles to its 288px height within browser subpixel precision');
  for(const [provider,model,name] of [['openai','gpt-6-astra','GPT-6 Astra'],['anthropic','claude-sonnet-5-5','Claude Sonnet 5.5'],
    ['gemini','gemini-3.8-flash','Gemini 3.8 Flash'],['openrouter','nvidia/nemotron-3.5-lightning:free','Nemotron 3.5 Lightning · Free'],
    ['ollama','llama3.2:3b','Llama 3.2 · 3B']]) {
    await browser.click('.chat-model-toggle');await browser.click('[data-chat-provider="'+provider+'"]');await browser.settle();
    await browser.click('.chat-model-select');
    await browser.click('[role="option"][data-device="'+model+'"]');await browser.settle();
    assert.equal(await browser.evaluate('mediaPreview.state.settings.chatProvider'),provider);
    assert.equal(await browser.evaluate('document.querySelector(".chat-model-name").textContent'),name);
    assert.equal(await browser.evaluate('mediaPreview.state.chatDraft'),'Keep my typed draft');
  }
  await browser.click('.chat-model-toggle');await browser.click('.chat-model-select');
  await browser.click('[data-device="custom"]');
  await browser.evaluate("document.querySelector('.chat-custom-model input').value='bad model!';document.querySelector('.chat-use-model').click()");
  assert.equal(await browser.evaluate("document.querySelector('.chat-custom-model input').getAttribute('aria-invalid')"),'true');
  await browser.evaluate("document.querySelector('.chat-custom-model input').value='qwen3:4b';document.querySelector('.chat-custom-model input').dispatchEvent(new Event('input'))");
  await browser.capture('mimo-chat-custom-model-1x');
  await browser.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:2,mobile:false});
  await browser.capture('mimo-chat-custom-model-2x');
  await browser.click('.chat-use-model');await browser.settle();
  assert.deepEqual(await browser.evaluate('voiceFixture.selections.at(-1)'),['ollama','qwen3:4b']);
  await browser.evaluate("mediaPreview.state.chatHistory=[{id:1,role:'user',content:'A question'},{id:2,role:'assistant',content:'A longer reply with room to read.'}];mediaPreview.state.notify();mediaPreview.open('prompt')");await browser.settle();
  assert.ok(Math.abs(await browser.evaluate("document.querySelector('#island').getBoundingClientRect().height")-360)<.5);
  await browser.capture('mimo-taller-chat-2x');
  assert.deepEqual(browser.errors,[]);
  await browser.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:1,mobile:false});
});

test('Desktop voice retains silver Mimo, measures speech, and owns activity until closed',async()=>{
  await browser.evaluate(`(async()=>{
    const {Activity}=await import('/src/core/activity.ts');window.voiceActivity=Activity;
    voiceFixture.level=0;voiceFixture.metersClosed=0;
    window.AudioContext=class {
      destination={};createAnalyser(){return {fftSize:256,getByteTimeDomainData(data){data.fill(128+voiceFixture.level)},connect(){},disconnect(){}}}
      createMediaStreamSource(){return {connect(){},disconnect(){}}}createMediaElementSource(){return {connect(){},disconnect(){}}}
      async resume(){}async close(){voiceFixture.metersClosed++}
    };
    mediaPreview.open('overview');mediaPreview.compact();
    Object.assign(mediaPreview.state.codingTask,{state:'working',steps:['Read actual.ts']});
    await mediaPreview.island.toggleDesktopVoice();
  })()`);await browser.settle();
  assert.equal(await browser.evaluate('mediaPreview.state.view'),'voice');
  assert.equal(await phase(),'recording');
  assert.equal(await browser.evaluate('mediaPreview.island.engine.bodyColor'),null);
  assert.equal(await browser.evaluate('mediaPreview.island.engine.badge.kind'),'microphone');
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.desktop-voice-label')).display"),'none');
  assert.equal(await browser.evaluate("document.querySelector('.desktop-voice-equalizer').dataset.measured"),'true');
  const quiet=await browser.evaluate("[...document.querySelector('.desktop-voice-equalizer').children].map(e=>getComputedStyle(e).height)");
  await browser.evaluate(`mediaPreview.publishAudio(48,false,'preview-output');
    mediaPreview.publish('playing','Music must not move the voice meter','Artist',{sourceAppId:'chrome.exe'});
    mediaPreview.levels.apply({revision:mediaPreview.levels.snapshot().revision+1,available:true,peak:1000,sources:{'chrome.exe':1000}})`);
  await browser.settle();
  assert.deepEqual(await browser.evaluate("[...document.querySelector('.desktop-voice-equalizer').children].map(e=>getComputedStyle(e).height)"),quiet,
    'Desktop playback cannot drive the microphone equalizer');
  await browser.evaluate('voiceFixture.level=42');await browser.settle();
  assert.notDeepEqual(await browser.evaluate("[...document.querySelector('.desktop-voice-equalizer').children].map(e=>getComputedStyle(e).height)"),quiet);
  assert.equal(await browser.evaluate("[...document.querySelector('.desktop-voice-equalizer').children].every(e=>{const s=getComputedStyle(e);return s.transform==='none'&&s.borderRadius==='999px'&&e.getBoundingClientRect().height>3})"),true,
    'Voice bars keep circular ends without inheriting the music scale transform');
  await browser.capture('mimo-desktop-voice-speaking-input');
  await browser.evaluate("mediaPreview.island.alert('finished');mediaPreview.state.notify()");await browser.settle();
  assert.equal(await browser.evaluate('mediaPreview.state.view'),'voice');
  assert.deepEqual(await browser.evaluate('mediaPreview.state.codingTask.steps'),['Read actual.ts']);
  await browser.evaluate('mediaPreview.island.toggleDesktopVoice()');await browser.settle();
  assert.equal(await phase(),'speaking');
  assert.equal(await browser.evaluate('mediaPreview.island.engine.badge.kind'),'speaker');
  assert.equal(await browser.evaluate("document.querySelector('.desktop-voice-equalizer').hidden"),true,'Spoken replies do not drive the input equalizer');
  assert.equal(await browser.evaluate('mediaPreview.state.chatDraft'),'Keep my typed draft');
  await browser.evaluate("voiceFixture.playback.dispatchEvent(new Event('ended'))");await browser.settle();
  assert.equal(await browser.evaluate('voiceActivity.voice.phase'),'idle');
  await browser.click('.desktop-voice-close');await browser.settle();
  assert.equal(await browser.evaluate('voiceActivity.voice.active'),false);
  assert.equal(await browser.evaluate('mediaPreview.state.view'),'overview');
  assert.equal(await browser.evaluate('mediaPreview.state.visibility'),'island');
  assert.ok(await browser.evaluate('voiceFixture.metersClosed')>=1);
  assert.deepEqual(browser.errors,[]);
});

test('A permission request pauses desktop voice, releases its microphone, and restores the voice surface',async()=>{
  await browser.evaluate('mediaPreview.island.toggleDesktopVoice()');await browser.settle();
  await browser.evaluate(`mediaPreview.state.pendingApproval={requestId:'voice-approval',taskId:'integration_claude',toolName:'Bash',detail:'echo ready',deadline:Date.now()+60000};mediaPreview.island.alert('approval')`);await browser.settle();
  assert.equal(await browser.evaluate('mediaPreview.state.view'),'approval');
  assert.equal(await phase(),'idle');
  assert.ok(await browser.evaluate('voiceFixture.tracks')>0);
  await browser.evaluate(`mediaPreview.state.finishApproval('voice-approval');mediaPreview.state.isPinned=false;mediaPreview.island.visibility.setPinned(false);mediaPreview.island.setView('overview')`);await browser.settle();
  assert.equal(await browser.evaluate('mediaPreview.state.view'),'voice');
  assert.equal(await browser.evaluate("document.querySelector('.desktop-voice-view').dataset.phase"),'paused');
  await browser.click('.desktop-voice-action');await browser.settle();
  assert.equal(await phase(),'recording');
  await browser.click('.desktop-voice-close');
  assert.deepEqual(browser.errors,[]);
});

test('Desktop voice errors use Mimo attention, allow retry, and cancel late microphone acquisition',async()=>{
  await browser.evaluate('voiceFixture.sounds=[]');
  await browser.evaluate(`voiceFixture.acquire=async()=>{throw new DOMException('Blocked','NotAllowedError')};mediaPreview.island.toggleDesktopVoice()`);await browser.settle();
  assert.equal(await browser.evaluate("document.querySelector('.desktop-voice-view').dataset.phase"),'error');
  assert.match(await browser.evaluate("document.querySelector('.desktop-voice-detail').textContent"),/Allow microphone/);
  assert.equal(await browser.evaluate('mediaPreview.island.engine.status'),'error');
  assert.equal(await browser.evaluate("voiceFixture.sounds.filter(name=>name==='error').length"),1,'A denied microphone produces one error cue');
  await browser.capture('mimo-desktop-voice-error');
  await browser.evaluate('voiceFixture.acquire=()=>new Promise(resolve=>voiceFixture.acquireLate=resolve)');
  await browser.click('.desktop-voice-action');await browser.settle();
  await browser.click('.desktop-voice-close');
  await browser.evaluate('voiceFixture.acquireLate(voiceFixture.stream())');await browser.settle();
  assert.equal(await phase(),'idle');
  assert.ok(await browser.evaluate('voiceFixture.tracks')>0);
  assert.equal(await browser.evaluate('mediaPreview.state.chatDraft'),'Keep my typed draft');
  assert.deepEqual(browser.errors,[]);
});

test('Desktop voice opens and closes once and Send uses the normal UI click',async()=>{
  await browser.evaluate("voiceFixture.sounds=[];mediaPreview.island.toggleDesktopVoice()");await browser.settle();
  assert.equal(await phase(),'recording');
  assert.equal(await browser.evaluate("voiceFixture.sounds.filter(name=>name==='open').length"),1,'Opening voice from an expanded chat still plays the open cue');
  await browser.click('.desktop-voice-action');await browser.settle();
  assert.equal(await phase(),'speaking');
  assert.equal(await browser.evaluate("voiceFixture.sounds.filter(name=>name==='blip').length"),1,'Send responds immediately with the normal click');
  assert.equal(await browser.evaluate("voiceFixture.sounds.filter(name=>name==='send').length"),0,'Transcription does not add a second, different send cue');
  await browser.click('.desktop-voice-action');await browser.settle();
  assert.equal(await phase(),'idle');
  assert.equal(await browser.evaluate("voiceFixture.sounds.filter(name=>name==='blip').length"),2,'Stop uses the same click');
  await browser.click('.desktop-voice-action');await browser.settle();
  assert.equal(await phase(),'recording');
  assert.equal(await browser.evaluate("voiceFixture.sounds.filter(name=>name==='blip').length"),3,'Talk uses the same click');
  await browser.click('.desktop-voice-close');await browser.settle();
  assert.equal(await browser.evaluate("voiceFixture.sounds.filter(name=>name==='close').length"),1,'Returning to an expanded chat plays one close cue');
  assert.equal(await browser.evaluate("voiceFixture.sounds.filter(name=>name==='error').length"),0);
  await browser.evaluate("mediaPreview.compact();voiceFixture.sounds=[];mediaPreview.island.toggleDesktopVoice()");await browser.settle();
  await browser.click('.desktop-voice-close');await browser.settle();
  const compact=await browser.evaluate("({open:voiceFixture.sounds.filter(name=>name==='open').length,close:voiceFixture.sounds.filter(name=>name==='close').length})");
  assert.deepEqual(compact,{open:1,close:1},'The visibility transition does not duplicate voice cues');
  assert.deepEqual(browser.errors,[]);
});

test('Confusion recovers with a bot reset, balanced red lighting, and new copy',async()=>{
  await browser.evaluate("mediaPreview.publish('none');mediaPreview.preferences({modules:{vscode:true,media:false,developerIntegrations:true}});mediaPreview.open('overview');mediaPreview.state.isPinned=true;mediaPreview.island.visibility.setPinned(true)");await browser.settle();
  for(let i=0;i<3;i++)await browser.click('#pat-mimo');
  await browser.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  assert.equal(await browser.evaluate('mediaPreview.state.view'),'confused');
  assert.equal(await browser.evaluate("document.querySelector('.confused-view .title').textContent"),'Recalibrating…');
  await browser.capture('mimo-confused-roll-1x');
  await browser.evaluate('new Promise(r=>setTimeout(r,900))');await browser.capture('mimo-confused-shake-1x');
  await browser.evaluate('new Promise(r=>setTimeout(r,400))');await browser.capture('mimo-confused-reset-1x');
  await browser.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:2,mobile:false});
  await browser.capture('mimo-confused-2x');
  await browser.evaluate('new Promise(r=>setTimeout(r,1900))');
  assert.equal(await browser.evaluate('mediaPreview.state.view'),'overview');
  assert.equal(await browser.evaluate('mediaPreview.island.engine.orbit'),0);
  assert.notEqual(await browser.evaluate('mediaPreview.island.engine.currentExpression'),'dizzy');
  assert.deepEqual(browser.errors,[]);
  await browser.command('Emulation.setDeviceMetricsOverride',{width:720,height:432,deviceScaleFactor:1,mobile:false});
});
