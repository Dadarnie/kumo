// SPDX-License-Identifier: MIT
// Capture production components with isolated demo data. No API or microphone access.
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {mimoBrowser} from './mimo-browser.mjs';

const output=new URL('../target/readme-captures/',import.meta.url);
await mkdir(output,{recursive:true});
let browser=await mimoBrowser({port:1498});
const captures=[];
async function reset(){
  await browser.reload();
  await browser.evaluate(`(async()=>{
    await document.fonts.ready;
    const {Bridge}=await import('/src/core/bridge.ts');
    const {handleHook}=await import('/src/island/hooks.ts');
    const {Activity}=await import('/src/core/activity.ts');
    window.captureBridge=Bridge;window.captureHook=handleHook;window.captureActivity=Activity;
    Bridge.approvalAck=Bridge.approvalDecline=async()=>{};
    mediaPreview.publish('none');
    mediaPreview.preferences({hooksInstalled:true,codexHooksInstalled:true,usageEnabled:false,workingModeEnabled:false,
      autoCollapseEnabled:false,clockEnabled:false,modules:{vscode:true,media:true,developerIntegrations:true},
      activeIntegrations:['integration_github','integration_vercel']});
    mediaPreview.open('overview');
  })()`);
  await browser.settle();
}
async function capture(file,description,{menu=false,selector='#island',fixturePage='windows/dev/media-preview.html'}={}){
  await browser.evaluate('new Promise(resolve=>setTimeout(resolve,450))');
  const clip=await browser.evaluate(`(()=>{
    const bounds=[document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()${menu?",...document.querySelectorAll('.audio-device-menu:popover-open')].map(el=>el.getBoundingClientRect?.()??el)":']'};
    const left=Math.min(...bounds.map(r=>r.left)),right=Math.max(...bounds.map(r=>r.right));
    const bottom=Math.max(...bounds.map(r=>r.bottom));
    return {x:Math.max(0,Math.floor(left)-24),y:0,width:Math.ceil(right-left)+48,height:Math.ceil(bottom)+24,scale:1};
  })()`);
  const png=Buffer.from((await browser.command('Page.captureScreenshot',{format:'png',clip})).data,'base64');
  await writeFile(new URL(file+'.png',output),png);
  captures.push({file:file+'.png',description,fixture:true,fixturePage,width:png.readUInt32BE(16),height:png.readUInt32BE(20),sha256:createHash('sha256').update(png).digest('hex')});
  console.log('Captured '+file);
}
try{
  await browser.command('Emulation.setDeviceMetricsOverride',{width:1100,height:900,deviceScaleFactor:3,mobile:false});
  await browser.command('Emulation.setDefaultBackgroundColorOverride',{color:{r:0,g:0,b:0,a:0}});
  await reset();
  await browser.evaluate(`captureHook(mediaPreview.island,{mimo_provider:'codex',session_id:'readme-permission',cwd:'C:/work/demo',hook_event_name:'PermissionRequest',request_id:'readme-permission',tool_name:'Bash',tool_input:{command:'npm run test:unit'}})`);
  assert.equal(await browser.evaluate('mediaPreview.state.view'),'approval');
  await capture('permission','Production permission panel with a local example command.');

  await reset();
  await browser.evaluate(`mediaPreview.preferences({workingModeEnabled:true});mediaPreview.hide();captureHook(mediaPreview.island,{
    mimo_provider:'codex',session_id:'readme-question',cwd:'C:/work/demo',hook_event_name:'QuestionRequest',request_id:'readme-question',
    tool_name:'mimo.ask_user',mimo_response_channel:'mcp',mimo_questions:[{question:'Which part should I improve next?',header:'Next step',
      options:[{label:'File drop',description:'Make attaching references easier.'},{label:'Agent workflow',description:'Refine questions and permission reviews.'}],multiSelect:false}]})`);
  assert.equal(await browser.evaluate('mediaPreview.state.visibility'),'expanded');
  assert.equal(await browser.evaluate('mediaPreview.state.view'),'question');
  await capture('follow-up','Production question and decision panel, expanded from the Working mode lip. No answer selected.');

  await reset();
  await browser.evaluate(`captureBridge.ingestFile=async()=>({name:'project-notes.txt',path:'C:/demo/project-notes.txt',size:42});mediaPreview.state.uploadDuration=.6;mediaPreview.island.receiveGrabDrop(['C:/demo/project-notes.txt'])`);
  await browser.evaluate(`new Promise((resolve,reject)=>{const deadline=performance.now()+10000;const check=()=>mediaPreview.state.view==='choose'?resolve():performance.now()>deadline?reject(new Error('File choices did not open')):setTimeout(check,40);check()})`);
  await capture('file-drop','Actual drop controller and file-choice panel using a local ingest fixture.');

  await reset();
  await browser.evaluate(`(()=>{
    const now=Date.now();
    const contributions=Array.from({length:84},(_,i)=>({date:new Date(now-(83-i)*86400000).toISOString().slice(0,10),count:i%7===0?0:i%5+1}));
    mediaPreview.state.integrations.integration_github={configured:true,loaded:true,error:null,data:{login:'demo-developer',totalRepos:6,totalStars:18,openPullRequests:2,reviewCount:1,contributions,
      pullRequests:[{title:'Improve the file-drop workflow',number:12,repo:'demo/companion',author:'demo-developer',state:'open',url:'https://github.com/example/demo/pull/12',updatedAt:now-3600000}],
      reviews:[],issues:[],repositories:[{name:'demo/companion',stars:18,issues:2,url:'https://github.com/example/demo',private:false}],activity:[],checks:[],warnings:[]}};
    mediaPreview.state.integrations.integration_vercel={configured:true,loaded:true,error:null,data:{deployments:[
      {projectName:'demo-site',state:'READY',createdAt:now-120000,branch:'main',commitMessage:'Improve the launch page'},
      {projectName:'demo-docs',state:'READY',createdAt:now-3600000,branch:'main'}]}};
    mediaPreview.state.notify();
  })()`);
  await browser.click('.integration-tile[data-integration=integration_github]');
  await browser.settle();
  assert.equal(await browser.evaluate("document.querySelector('.module-activity').dataset.integration"),'integration_github');
  await browser.click('.github-mini-calendar');await browser.settle();
  await browser.evaluate("[...document.querySelectorAll('.github-preview .calendar-cell:not(:disabled)')].at(-3).click()");
  await browser.settle();
  await capture('github','Production GitHub panel with labeled local demo contributions and repository data.');
  await browser.click('.integration-tile[data-integration=integration_vercel]');
  await capture('vercel','Production Vercel deployment panel with local demo deployments.');

  await reset();
  const providers=await browser.evaluate(`(async()=>{
    const {CODING_PROVIDERS}=await import('/src/core/coding.ts');
    mediaPreview.preferences({codingHooksInstalled:Object.fromEntries(CODING_PROVIDERS.map(provider=>[provider.id,true]))});
    for(const provider of CODING_PROVIDERS){
      const task=mediaPreview.state.upsertCodingTask(provider.id,'Demo project','C:/work/demo',provider.id+'-demo');
      task.state='working';task.lastEventAt=Date.now();task.activity={tool:'Read',action:'Read',phase:'running',target:'src/app.ts'};
    }
    mediaPreview.state.selectCodingTask('session_codex_codex-demo');mediaPreview.open('overview');
    return CODING_PROVIDERS.map(provider=>({id:provider.id,name:provider.name}));
  })()`);
  assert.equal(providers.length,9);
  await browser.settle();
  await browser.click('.coding-session-select');
  assert.equal(await browser.evaluate("document.querySelectorAll('.audio-device-menu:popover-open [role=option]').length"),10);
  await capture('agents','Production coding-session picker with all nine registered providers in local demo sessions.',{menu:true});

  await reset();
  await browser.evaluate(`captureActivity.setVoice(true,'recording');captureActivity.describeVoice('OpenAI','Mimo');mediaPreview.open('voice')`);
  await browser.settle();
  assert.equal(await browser.evaluate("document.querySelector('.desktop-voice-view').dataset.phase"),'recording');
  await capture('voice','Production desktop voice panel in a recording-state fixture. No microphone or speech service was used.');

  await reset();
  await browser.evaluate(`(()=>{
    const task=mediaPreview.state.upsertCodingTask('codex','Mimo demo','C:/work/demo','docs-terminal');
    task.state='working';task.lastEventAt=Date.now();task.activity={tool:'Bash',action:'Run',target:'npm run test:unit',phase:'running',preview:{lines:['Checking the current changes…']},files:[{target:'src/app.ts',tool:'Edit',phase:'complete',changes:{added:1,removed:1},preview:{lines:['const label = "Workspace";','const label = "Mimo Shelf";'],kinds:['removed','added'],lineNumbers:[12,12]}}]};
    mediaPreview.state.selectCodingTask(task.id);mediaPreview.state.notify();mediaPreview.open('overview');
  })()`);
  await browser.settle();
  await capture('home','Current Home view with a local coding-session fixture and configured integration tiles.');
  await browser.click('[aria-label="Open terminal"]');await browser.settle();
  await capture('terminal','Current expanded terminal and syntax-colored file diff. Example activity is a local fixture.');

  await reset();
  await browser.evaluate(`mediaPreview.state.chatHistory=[{id:1,role:'user',content:'How do I share these references?'},{id:2,role:'assistant',content:'Open **Mimo Shelf**, select the files you need, then choose **Copy paths**. Paste them into your editor or terminal.'}];mediaPreview.state.chatDraft='Keep the original images';mediaPreview.open('prompt')`);
  await browser.settle();
  await capture('chat','Current chat composer, provider picker, local sample conversation and unsent draft. No AI request was made.');

  await reset();
  await browser.evaluate(`mediaPreview.publish('playing','A Little Company','Mimo',{sourceAppId:'Local player fixture',artwork:mediaPreview.artwork,timeline:{positionMs:28000,durationMs:74000,updatedAtUnixMs:Date.now()},controls:{previous:true,play:true,pause:true,next:true,seek:true}});mediaPreview.open('media')`);
  await browser.settle();
  if(await browser.evaluate("document.querySelector('.audio-disclosure').getAttribute('aria-expanded')==='true'"))await browser.click('.audio-disclosure');
  await browser.settle();
  await capture('media','Production Now playing view with generated local cover art and explicitly simulated playback metadata.');
  await browser.click('.audio-disclosure');await browser.settle();
  assert.equal(await browser.evaluate("document.querySelector('.audio-disclosure').getAttribute('aria-expanded')"),'true');
  await capture('audio','Production Windows audio disclosure with the local output-device and volume fixture. No system audio was changed.');

  await reset();
  await browser.evaluate(`mediaPreview.preferences({activeIntegrations:['integration_github','integration_vercel','integration_stripe']});mediaPreview.state.integrations.integration_stripe={configured:true,loaded:true,error:null,data:{balance:2489,currency:'usd',testMode:true,payments:[{id:'pi_demo_01',description:'Starter plan',amount:29,currency:'usd',status:'succeeded',createdAt:Date.now()},{id:'pi_demo_02',description:'Team plan',amount:79,currency:'usd',status:'succeeded',createdAt:Date.now()-3600000}],events:[]}};mediaPreview.state.notify();mediaPreview.open('overview')`);
  await browser.settle();await browser.click('.integration-tile[data-integration=integration_stripe]');await browser.settle();
  await capture('stripe','Production Stripe payment summary in test-mode demo data. No payment or account connection was made.');

  await reset();
  await browser.evaluate(`(()=>{
    const items=[['design-reference.png','image/png',720,460],['project-brief.pdf','application/pdf',0,0],['notes.txt','text/plain',0,0]].map(([label,mime,width,height],i)=>({id:'docs-'+i,label,note:'Local documentation example',collection:'Launch notes',createdAt:Date.now(),mime,width,height,size:2048,source:'file',duplicateOf:null,annotations:[],annotated:false}));
    captureBridge.grabRead=async()=>({items,retentionDays:7,detached:false});
    const canvas=document.createElement('canvas');canvas.width=720;canvas.height=460;const ctx=canvas.getContext('2d');ctx.fillStyle='#171c25';ctx.fillRect(0,0,720,460);ctx.fillStyle='#a9d3fa';ctx.font='600 42px Inter';ctx.fillText('Design reference',48,100);ctx.fillStyle='#667e98';ctx.fillRect(48,150,624,120);ctx.fillStyle='#34465a';ctx.fillRect(48,300,290,110);ctx.fillRect(360,300,312,110);
    captureBridge.grabAction=async(action,args={})=>action==='preview'?{image:canvas.toDataURL(),annotations:[]} : true;
    mediaPreview.open('grab');
  })()`);
  await browser.settle();await capture('shelf','Production Drop Shelf with PNG, PDF and text files supplied by a local fixture.');
  await browser.click('[aria-label="Preview design-reference.png"]');await browser.settle();
  await capture('shelf-editor','Production image preview, reference fields and annotation controls with a local generated reference image.');

  assert.deepEqual(browser.errors,[]);
  await browser.close();
  browser=await mimoBrowser({page:'/settings.html',ready:"document.querySelector('.settings-sidebar button')",port:1499});
  await browser.command('Emulation.setDeviceMetricsOverride',{width:1024,height:840,deviceScaleFactor:2,mobile:false});
  await browser.evaluate('document.fonts.ready');await browser.settle();
  await capture('settings','Production Settings window and General preferences in an isolated browser. No saved preferences or credentials were read.',{selector:'#settings-root',fixturePage:'windows/settings.html'});
  assert.deepEqual(browser.errors,[]);
  const sourceFiles=['dev/media-preview.html','src/design/tokens.css','src/views/coding-card.css','src/views/github.css','src/views/activity-calendar.css','src/island/hooks.ts','src/views/agent-question.ts','src/views/coding-card.ts','src/views/coding-edits.ts','src/views/desktop-voice.ts','src/views/overview.ts','src/views/chat.ts','src/views/grab.ts','src/island/media.ts','src/views/integration-activity.ts','src/settings/main.ts'];
  const sources={};
  for(const path of sourceFiles){
    const source=(await readFile(new URL('../'+path,import.meta.url),'utf8')).replaceAll('\r\n','\n');
    sources['windows/'+path]=createHash('sha256').update(source).digest('hex');
  }
  await writeFile(new URL('captures.json',output),JSON.stringify({fixture:'windows/dev/media-preview.html and windows/settings.html',method:'Production components in isolated Chrome; 3x pixel density for feature panels and 2x for Settings; lossless PNGs; local example data only.',sourceHashNormalization:'UTF-8 with CRLF normalized to LF',providers,sources,captures},null,2)+'\n');
}finally{await browser.close();}
