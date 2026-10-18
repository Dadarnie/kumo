// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadSource} from './ts-test-loader.mjs';
const {State,normalizeSettings} = await import(await loadSource('../src/core/state.ts'));

test('removed work-history links recover to Home without claiming the content region',async()=>{
  const {safeSectionView,ownsContent}=await import(await loadSource('../src/core/sections.ts'));
  const settings=normalizeSettings({});
  assert.equal(safeSectionView('history',settings.modules,0,false,false),'overview');
  assert.equal(ownsContent('history'),false);
});

test('the coding card automatically follows the latest active real session without merging projects',()=>{
  const previous={tasks:State.tasks,focusId:State.focusId,lastCodingId:State.lastCodingId};
  try {
    State.tasks=[];
    const first=State.upsertCodingTask('codex','Shop','C:/work/shop','shop');State.updateTask(first.id,'working');State.focusId=first.id;
    const second=State.upsertCodingTask('claude','Docs','C:/work/docs','docs');State.updateTask(second.id,'working');
    assert.equal(State.codingTask.id,second.id);assert.equal(first.sessionCwd,'C:/work/shop');
    State.updateTask(second.id,'finished');assert.equal(State.codingTask.id,first.id,'A stopped session does not hide another active session');
  } finally {Object.assign(State,previous)}
});

test('retired Downloads and Watch project preferences are discarded while existing settings survive',()=>{
  const settings=normalizeSettings({downloadsEnabled:true,watchedProject:{cwd:'C:/work/shop',repository:'team/shop',branch:'main',vercelProject:'shop'},codingAssistant:'codex',soundEnabled:false});
  assert.equal('downloadsEnabled' in settings,false);
  assert.equal('watchedProject' in settings,false);
  assert.equal(settings.codingAssistant,'codex');
  assert.equal(settings.soundEnabled,false);
});

test('a chosen live coding session stays selected across other agents editing until Auto is restored',()=>{
  const saved={tasks:State.tasks,focusId:State.focusId,lastCodingId:State.lastCodingId,selectedCodingId:State.selectedCodingId};
  try {
    State.tasks=[];
    const first=State.upsertCodingTask('codex','Shop','C:/work/shop','shop');State.updateTask(first.id,'working');
    const second=State.upsertCodingTask('claude','Docs','C:/work/docs','docs');State.updateTask(second.id,'working');
    State.selectCodingTask(first.id);
    State.upsertCodingTask('claude','Docs','C:/work/docs','docs');
    assert.equal(State.codingTask.id, first.id);
    assert.equal(State.focusId, first.id);
    State.selectCodingTask(null);
    assert.equal(State.codingTask.id, second.id);
    State.selectCodingTask('missing'); assert.equal(State.selectedCodingId, null);
  } finally {Object.assign(State,saved)}
});

test('notification preferences validate values and discard retired project sources',()=>{
  const settings=normalizeSettings({notices:{coding:false,github:false,vercel:false,other:'yes'},snoozeUntil:-5});
  assert.deepEqual(settings.notices,{coding:false,other:true});
  assert.equal(settings.snoozeUntil,0);
});

test('notification controls mute live notices until snooze expires',async()=>{
  const {shouldNotify}=await import(await loadSource('../src/core/notices.ts'));
  const preferences={coding:true,other:false};
  assert.equal(shouldNotify('coding',preferences,1200,1000),false);
  assert.equal(shouldNotify('coding',preferences,1200,1200),true);
  assert.equal(shouldNotify('other',preferences,0,1200),false);
});

test('two sessions of the same provider preserve independent task and approval ownership', () => {
  State.settings=normalizeSettings({hooksInstalled:true}); State.tasks=[];State.loadIntegrationTasks();
  const a=State.upsertCodingTask('claude','Alpha','C:/alpha','session-a');
  const b=State.upsertCodingTask('claude','Beta','C:/beta','session-b');
  assert.notEqual(a.id,b.id);
  assert.equal(State.upsertCodingTask('claude','Alpha','C:/alpha','session-a'),a);
  State.pendingApprovals=[];
  State.enqueueApproval({requestId:'a',provider:'claude',sessionId:'session-a',taskId:a.id,tool:'Bash',command:'a'});
  State.enqueueApproval({requestId:'b',provider:'claude',sessionId:'session-b',taskId:b.id,tool:'Bash',command:'b'});
  State.selectApproval('b');State.finishApproval('b');
  assert.equal(State.pendingApproval.requestId,'a');
  assert.equal(a.sessionCwd,'C:/alpha');assert.equal(b.sessionCwd,'C:/beta');
  State.finishApproval('a');
});

test('interleaved hook events, queued deadlines, and session closure remain isolated',async()=>{
  globalThis.window={setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:clearTimeout};
  const {Bridge}=await import(await loadSource('../src/core/bridge.ts'));
  const {Sound}=await import(await loadSource('../src/core/sound.ts'));
  const {handleHook,expireApprovals,cancelApprovalTimeout,resetHookSession}=await import(await loadSource('../src/island/hooks.ts'));
  const acknowledgements=[],returned=[];Bridge.approvalAck=async id=>acknowledgements.push(id);
  Bridge.approvalDecline=async id=>returned.push(id);Sound.play=()=>{};
  const island={expand:()=>{},alert:()=>{},reveal:()=>{},dropPin:()=>{},setView:v=>{State.view=v}};
  State.settings=normalizeSettings({hooksInstalled:true,codexHooksInstalled:true});State.tasks=[];State.loadIntegrationTasks();
  State.pendingApprovals=[];State.missedApprovals=[];State.paused=false;
  const event=(session,name,extra={})=>handleHook(island,{session_id:session,mimo_provider:'claude',cwd:'C:/'+session,hook_event_name:name,...extra});
  try {
    event('alpha','UserPromptSubmit',{prompt:'Fix Alpha'});event('beta','UserPromptSubmit',{prompt:'Fix Beta'});
    const a=State.tasks.find(t=>t.sessionId==='alpha'),b=State.tasks.find(t=>t.sessionId==='beta');
    event('alpha','PermissionRequest',{request_id:'ra',tool_name:'Bash',tool_use_id:'ua',tool_input:{command:'npm test'}});
    event('beta','PermissionRequest',{request_id:'rb',tool_name:'Bash',tool_use_id:'ub',tool_input:{command:'npm build'}});
    assert.deepEqual(acknowledgements,['ra','rb']);assert.equal(State.pendingApprovals.length,2);
    event('alpha','PostToolUse',{tool_name:'Bash',tool_use_id:'ua',tool_input:{command:'npm test'}});
    assert.equal(State.pendingApproval.requestId,'rb');assert.equal(b.state,'approval');
    State.pendingApproval.deadline=Date.now()-1;expireApprovals(island);
    assert.equal(State.pendingApprovals.length,0);assert.ok(returned.includes('rb'));
    event('alpha','SessionEnd');event('alpha','PostToolUse',{tool_name:'Edit',tool_use_id:'late'});
    assert.equal(State.tasks.some(t=>t.id===a.id),false);assert.equal(State.tasks.includes(b),true);
  } finally {cancelApprovalTimeout();resetHookSession(island);}
});

test('input notifications record an actionable session without inventing approval controls, and work clears it',async()=>{
  globalThis.window={setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:clearTimeout};
  const {Sound}=await import(await loadSource('../src/core/sound.ts'));
  const {handleHook,resetHookSession}=await import(await loadSource('../src/island/hooks.ts'));
  const sounds=[];Sound.play=name=>sounds.push(name);
  const island={expand:()=>{},alert:()=>{},reveal:()=>{},dropPin:()=>{},setView:v=>{State.view=v}};
  State.settings=normalizeSettings({hooksInstalled:true,snoozeUntil:Date.now()+60000});
  State.tasks=[];State.loadIntegrationTasks();State.pendingApprovals=[];State.missedApprovals=[];State.paused=false;
  const event=(name,extra={})=>handleHook(island,{session_id:'attention',mimo_provider:'claude',cwd:'C:/shop',hook_event_name:name,...extra});
  try {
    event('UserPromptSubmit',{prompt:'Fix checkout'});
    event('Notification',{notification_type:'auth_success',message:'Signed in'});
    assert.notEqual(State.tasks.find(t=>t.sessionId==='attention').state,'question');
    event('Notification',{notification_type:'idle_prompt',message:'Waiting for your input'});
    assert.equal(State.tasks.find(t=>t.sessionId==='attention').state,'question');
    assert.equal(State.tasks.find(t=>t.sessionId==='attention').steps.at(-1),'Waiting for your input');
    assert.equal(State.pendingApprovals.length,0);assert.deepEqual(sounds,[]);
    event('PreToolUse',{tool_name:'Read',tool_input:{file_path:'src/checkout.ts'}});
    assert.equal(State.tasks.find(t=>t.sessionId==='attention').state,'working');
  } finally {resetHookSession(island);}
});

test('question requests share the review queue without granting permissions or crossing sessions',async()=>{
  globalThis.window={setTimeout,clearTimeout};
  const {Bridge}=await import(await loadSource('../src/core/bridge.ts'));
  const {handleHook,resetHookSession}=await import(await loadSource('../src/island/hooks.ts'));
  const returned=[];Bridge.approvalAck=async()=>{};Bridge.approvalDecline=async id=>returned.push(id);
  const island={expand:v=>{State.view=v},alert:()=>{},reveal:()=>{},dropPin:()=>{},setView:v=>{State.view=v}};
  State.settings=normalizeSettings({hooksInstalled:true});State.tasks=[];State.loadIntegrationTasks();
  State.pendingApprovals=[];State.paused=false;State.view='overview';
  const {Visibility}=await import(await loadSource('../src/core/visibility.ts'));Visibility.island();
  const questions=[{question:'Which option?',header:'Choice',options:[{label:'A'},{label:'B'}],multiSelect:false}];
  const event=(id,provider='claude')=>handleHook(island,{mimo_provider:provider,hook_event_name:'QuestionRequest',session_id:id,request_id:id,tool_name:'AskUserQuestion',mimo_questions:questions});
  try {
    event('ask-a');event('ask-b');
    assert.equal(State.pendingApprovals.length,2);assert.equal(State.pendingReviewView,'question');
    assert.deepEqual(State.pendingApproval.questions[0].options,[{label:'A',description:''},{label:'B',description:''}]);
    event('observer','gemini');assert.ok(returned.includes('observer'));assert.equal(State.pendingApprovals.length,2);
    handleHook(island,{mimo_provider:'claude',hook_event_name:'SessionEnd',session_id:'ask-a'});
    assert.equal(State.pendingApproval.requestId,'ask-b');assert.ok(returned.includes('ask-a'));
  } finally { resetHookSession(island); }
});
