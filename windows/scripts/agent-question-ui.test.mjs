// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mimoBrowser} from './mimo-browser.mjs';

test('questions and permissions interrupt open content and hold the working lip open', {timeout:60000}, async()=>{
  const browser=await mimoBrowser({port:1496});
  try {
    await browser.evaluate(`(async()=>{
      const {Bridge}=await import('/src/core/bridge.ts');
      const {handleHook,cancelApprovalTimeout}=await import('/src/island/hooks.ts');
      window.attentionCalls=[];
      Bridge.approvalAck=async id=>attentionCalls.push(['ack',id]);
      Bridge.approvalDecline=async id=>attentionCalls.push(['decline',id]);
      Bridge.approvalDecision=async(id,answer)=>attentionCalls.push(['permission',id,answer]);
      Bridge.questionAnswer=async(id,answer)=>attentionCalls.push(['answer',id,answer]);
      window.clearAttention=()=>{
        cancelApprovalTimeout();
        for(const request of [...mediaPreview.state.pendingApprovals])mediaPreview.state.finishApproval(request.requestId);
        mediaPreview.state.isPinned=false;mediaPreview.island.dropPin();
      };
      window.sendAttention=(kind,id)=>handleHook(mediaPreview.island,{
        mimo_provider:'codex',session_id:id,cwd:'C:/work/'+id,
        hook_event_name:kind==='question'?'QuestionRequest':'PermissionRequest',request_id:id,tool_use_id:id,
        tool_name:kind==='question'?'mimo.ask_user':'Bash',
        ...(kind==='question'?{mimo_response_channel:'mcp',mimo_questions:[
          {question:'Which change should I review?',options:[{label:'UI'},{label:'Audio'}],multiSelect:false}
        ]}:{tool_input:{command:'npm test'}})
      });
      mediaPreview.publish('none');
      mediaPreview.preferences({hooksInstalled:true,clockEnabled:false});
      mediaPreview.state.chatDraft='Keep this unfinished chat';
    })()`);
    for(const [index,mode] of [
      {working:false,auto:false,from:'compact'},
      {working:true,auto:false,from:'lip'},
      {working:true,auto:true,from:'chat'},
    ].entries())for(const kind of ['question','approval']){
      const id=`priority-${index}-${kind}`;
      await browser.evaluate(`clearAttention();mediaPreview.preferences({workingModeEnabled:${mode.working},autoCollapseEnabled:${mode.auto}});${mode.from==='chat'?"mediaPreview.open('prompt')":"mediaPreview.compact()"}`);
      assert.equal(await browser.evaluate('mediaPreview.state.visibility'),mode.from==='chat'?'expanded':mode.working?'peek':'island');
      await browser.evaluate(`sendAttention('${kind}','${id}')`);
      await browser.settle();
      assert.equal(await browser.evaluate('mediaPreview.state.view'),kind,`${kind} takes priority over ${mode.from}`);
      assert.equal(await browser.evaluate('mediaPreview.state.visibility'),'expanded');
      assert.equal(await browser.evaluate('mediaPreview.state.isPinned'),true);
      const owner=await browser.evaluate('mediaPreview.state.pendingApproval.taskId');
      if(kind==='question')await browser.evaluate(`(()=>{const input=document.querySelector('.question-input');input.value='My unfinished answer';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await browser.evaluate(`sendAttention('question','${id}-queued')`);
      assert.equal(await browser.evaluate('mediaPreview.state.pendingApproval.requestId'),id,'New questions retain the active request owner');
      assert.equal(await browser.evaluate('mediaPreview.state.focusId'),owner);
      if(kind==='question')assert.equal(await browser.evaluate("document.querySelector('.question-input').value"),'My unfinished answer');
      await browser.evaluate(`mediaPreview.open('prompt');sendAttention('question','${id}-follow-up')`);
      assert.equal(await browser.evaluate('mediaPreview.state.view'),kind,'A follow-up restores the current unanswered request');
      await browser.evaluate('mediaPreview.island.visibility.pointerLeft();mediaPreview.island.collapse();new Promise(resolve=>setTimeout(resolve,1150))');
      assert.equal(await browser.evaluate('mediaPreview.state.visibility'),'expanded','Unanswered requests survive pointer leave and collapse');
      assert.equal(await browser.evaluate('mediaPreview.state.chatDraft'),'Keep this unfinished chat');
    }
    assert.deepEqual(await browser.evaluate("attentionCalls.filter(call=>['answer','permission'].includes(call[0]))"),[],'Visibility never chooses an answer or permission');
    await browser.capture('attention-priority-working-mode');
    await browser.evaluate('clearAttention()');
    assert.deepEqual(browser.errors,[]);
  } finally {await browser.close();}
});

test('agent questions collect choices and custom replies through the owning relay', {timeout:90000}, async()=>{
  const browser=await mimoBrowser({port:1495});
  try {
    await browser.evaluate(`(async()=>{
      const {Bridge}=await import('/src/core/bridge.ts');window.questionBridge=Bridge;
      const {handleHook}=await import('/src/island/hooks.ts');window.questionHook=handleHook;
      window.questionCalls=[];window.questionReturns=[];window.questionFail=false;
      Bridge.approvalAck=async id=>questionCalls.push(['ack',id]);
      Bridge.approvalDecline=async id=>questionCalls.push(['decline',id]);
      Bridge.approvalDecision=async(id,answer)=>questionCalls.push(['permission',id,answer]);
      Bridge.questionAnswer=async(id,answers)=>{if(questionFail)throw new Error('Relay unavailable. Try again.');questionCalls.push(['answer',id,answers]);};
      Bridge.returnToWork=async(target,path)=>{questionReturns.push(path);return 'project'};
      mediaPreview.preferences({hooksInstalled:true,workingModeEnabled:true,clockEnabled:false,autoCollapseEnabled:false});
      mediaPreview.publish('none');mediaPreview.state.pendingApprovals=[];mediaPreview.state.missedApprovals=[];
      mediaPreview.state.chatDraft='Keep my chat draft';mediaPreview.compact();
      window.askQuestion=(id='question-a',session='question-session')=>questionHook(mediaPreview.island,{
        mimo_provider:'claude',session_id:session,cwd:'C:/work/'+session,hook_event_name:'QuestionRequest',request_id:id,
        tool_name:'AskUserQuestion',tool_use_id:id,mimo_questions:[
          {question:'Which framework should I use?',header:'Framework',options:[{label:'React',description:'Use the existing components.'},{label:'Vue',description:'Build a new interface.'}],multiSelect:false},
          {question:'Which checks should I run?',header:'Checks',options:[{label:'Types',description:'Check TypeScript.'},{label:'Build',description:'Verify the production build.'}],multiSelect:true}
        ]});askQuestion();
    })()`);
    await browser.settle();
    assert.equal(await browser.evaluate('mediaPreview.state.view'),'question');
    assert.equal(await browser.evaluate('mediaPreview.state.isPinned'),true);
    assert.equal(await browser.evaluate("document.querySelector('.question-send').disabled"),true,'An answer is never chosen by default');
    assert.match(await browser.evaluate("document.querySelector('.question-view').textContent"),/Which framework should I use/);
    await browser.capture('agent-question-options');
    await browser.evaluate("document.querySelector('.question-options input').click()");
    await browser.click('.question-send');
    assert.equal(await browser.evaluate("document.querySelector('.question-progress').textContent"),'2 of 2');
    await browser.evaluate("document.querySelectorAll('.question-options input').forEach(input=>input.click());const input=document.querySelector('.question-input');input.value='And the focused browser check';input.dispatchEvent(new Event('input',{bubbles:true}))");
    await browser.click('.question-previous');
    assert.equal(await browser.evaluate("document.querySelector('.question-options input').checked"),true,'Back preserves the earlier choice');
    await browser.click('.question-send');
    assert.equal(await browser.evaluate("document.querySelector('.question-input').value"),'And the focused browser check');
    await browser.evaluate("questionFail=true");
    await browser.click('.question-send');
    await browser.settle();
    assert.match(await browser.evaluate("document.querySelector('.question-error').textContent"),/Relay unavailable/);
    assert.equal(await browser.evaluate('mediaPreview.state.pendingApprovals.length'),1,'A failed answer stays owned and retryable');
    await browser.capture('agent-question-retry');
    await browser.evaluate("questionFail=false");
    await browser.click('.question-send');
    await browser.settle();
    assert.deepEqual(await browser.evaluate("questionCalls.filter(call=>call[0]==='answer')"),[['answer','question-a',{
      'Which framework should I use?':'React',
      'Which checks should I run?':'Types, Build, And the focused browser check'
    }]]);
    assert.equal(await browser.evaluate('mediaPreview.state.pendingApprovals.length'),0);
    assert.equal(await browser.evaluate('mediaPreview.state.chatDraft'),'Keep my chat draft');

    await browser.evaluate(`mediaPreview.compact();askQuestion('question-b','second');questionHook(mediaPreview.island,{mimo_provider:'codex',session_id:'permission-session',cwd:'C:/permission',hook_event_name:'PermissionRequest',request_id:'permission-next',tool_name:'Bash',tool_input:{command:'npm test'}})`);
    await browser.settle();
    assert.equal(await browser.evaluate('mediaPreview.state.pendingReviewView'),'question');
    await browser.command('Input.dispatchKeyEvent',{type:'keyDown',key:'y',code:'KeyY'});
    assert.equal(await browser.evaluate("questionCalls.filter(call=>call[0]==='permission').length"),0,'Permission shortcuts do not answer a question');
    await browser.click('.question-return');
    await browser.settle();
    assert.equal(await browser.evaluate('mediaPreview.state.view'),'approval','The next queued permission remains actionable');
    assert.deepEqual(await browser.evaluate('questionReturns'),['C:/work/second']);
    assert.ok(await browser.evaluate("questionCalls.some(call=>call[0]==='decline'&&call[1]==='question-b')"));

    await browser.evaluate(`mediaPreview.state.finishApproval('permission-next');mediaPreview.state.isPinned=false;mediaPreview.island.dropPin();mediaPreview.compact();askQuestion('question-expired','expired');mediaPreview.state.pendingApproval.deadline=Date.now()-1;`);
    await browser.evaluate(`(async()=>{const {expireApprovals}=await import('/src/island/hooks.ts');expireApprovals(mediaPreview.island)})()`);
    assert.equal(await browser.evaluate('mediaPreview.state.pendingApprovals.length'),0);
    assert.ok(await browser.evaluate("questionCalls.some(call=>call[0]==='decline'&&call[1]==='question-expired')"));
    assert.equal(await browser.evaluate('mediaPreview.state.settings.workingModeEnabled'),true);
    await browser.evaluate(`(async()=>{
      const {CODING_PROVIDERS}=await import('/src/core/coding.ts');
      window.mcpProviders=CODING_PROVIDERS.map(provider=>provider.id);
      for(const provider of mcpProviders)questionHook(mediaPreview.island,{
        mimo_provider:provider,session_id:'mcp-'+provider,cwd:'C:/work/'+provider,
        hook_event_name:'QuestionRequest',request_id:'mcp-'+provider,tool_use_id:'mcp-'+provider,
        tool_name:'mimo.ask_user',mimo_response_channel:'mcp',
        mimo_questions:[{question:'What should '+provider+' check?',options:[],multiSelect:false}]
      });
    })()`);
    await browser.settle();
    const providers=await browser.evaluate('mcpProviders');
    assert.equal(await browser.evaluate('mediaPreview.state.pendingApprovals.length'),providers.length,
      'Every registered agent joins the same question queue');
    for(const [index,provider] of providers.entries()){
      assert.equal(await browser.evaluate('mediaPreview.state.pendingApproval.provider'),provider);
      assert.equal(await browser.evaluate("document.querySelector('.question-title').textContent"),'What should '+provider+' check?');
      assert.equal(await browser.evaluate("document.querySelector('.question-input').value"),'','One agent never inherits another agent\'s answer');
      if(provider==='cursor'){
        await browser.evaluate("questionHook(mediaPreview.island,{mimo_provider:'cursor',session_id:'mcp-cursor',cwd:'C:/work/cursor',hook_event_name:'SessionEnd'})");
        assert.ok(await browser.evaluate("questionCalls.some(call=>call[0]==='decline'&&call[1]==='mcp-cursor')"),'Cancelling one session releases only its own question');
      } else {
        await browser.evaluate(`(()=>{const input=document.querySelector('.question-input');input.value='Run check ${index}';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await browser.click('.question-send');
        assert.deepEqual(await browser.evaluate("questionCalls.filter(call=>call[0]==='answer').at(-1)"),
          ['answer','mcp-'+provider,{['What should '+provider+' check?']:'Run check '+index}]);
      }
      await browser.settle();
    }
    assert.equal(await browser.evaluate('mediaPreview.state.pendingApprovals.length'),0);
    await browser.evaluate(`questionHook(mediaPreview.island,{mimo_provider:'codex',session_id:'invalid-channel',
      hook_event_name:'QuestionRequest',request_id:'invalid-channel',tool_name:'AskUserQuestion',
      mimo_questions:[{question:'No answer channel',options:[]}]})`);
    assert.equal(await browser.evaluate('mediaPreview.state.pendingApprovals.length'),0,'Observer hooks cannot pretend to return native question answers');
    assert.ok(await browser.evaluate("questionCalls.some(call=>call[0]==='decline'&&call[1]==='invalid-channel')"));
    assert.equal(await browser.evaluate('mediaPreview.state.chatDraft'),'Keep my chat draft');
    assert.deepEqual(browser.errors,[]);
  } finally { await browser.close(); }
});
