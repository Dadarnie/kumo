// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadSource} from './ts-test-loader.mjs';
const {reportedTestResults,testResultsFromLines}=await import(await loadSource('../src/core/test-results.ts'));
const {codingActivity}=await import(await loadSource('../src/core/coding-activity.ts'));
const {codingUsage}=await import(await loadSource('../src/core/coding-usage.ts'));
const run=(id,event,extra={})=>({hook_event_name:event,tool_name:'Bash',tool_use_id:id,tool_input:{command:'npm test'},...extra});

test('reported totals stay distinct from suites and unsupported values stay unknown',()=>{
 assert.equal(reportedTestResults({passed:-1,total:'48'}),undefined);
 assert.equal(testResultsFromLines(['PASS invoice.test.ts']).passed,undefined);
 assert.equal(testResultsFromLines(['Tests: 48 passed, 48 total']).passed,48);
 assert.equal(testResultsFromLines(['build succeeded','Exit code: 0']),undefined);
 assert.deepEqual(testResultsFromLines(['ℹ tests 8','ℹ pass 6','ℹ fail 1','ℹ skipped 1']),{cases:[],total:8,passed:6,failed:1,skipped:1});
});

test('a reported run survives edits and a rerun clears the previous outcome',()=>{
 let activity=codingActivity(run('run-1','PreToolUse'));
 activity=codingActivity(run('run-1','PostToolUse',{mimo_tests:{passed:48,total:48},mimo_preview:{text:'PASS invoice.test.ts'}}),activity);
 assert.equal(activity.lastRun.tests.passed,48);
 activity=codingActivity({hook_event_name:'PreToolUse',tool_name:'Edit',tool_use_id:'edit-1',tool_input:{file_path:'invoice.ts',old_string:'a',new_string:'b'}},activity);
 assert.equal(activity.lastRun.tests.passed,48);
 activity=codingActivity(run('run-2','PreToolUse'),activity);
 assert.equal(activity.lastRun.phase,'running');assert.equal(activity.lastRun.tests,undefined);
 assert.equal(activity.lastRun.toolUseId,'run-2');
});

test('test duration stays reported, bounded and attached to actual test results',()=>{
 assert.deepEqual(testResultsFromLines(['ℹ tests 10','ℹ pass 10','ℹ fail 0','ℹ duration_ms 644.226']),{cases:[],durationMs:644.226,total:10,passed:10,failed:0});
 for(const [line,durationMs] of [['Time: 1.234 s, estimated 2 s',1234],['Duration 250ms',250],['test result: ok. 2 passed; 0 failed; finished in 0.02s',20],['=== 2 passed in 1.25s ===',1250]]){
  assert.equal(testResultsFromLines(['Tests: 2 passed, 2 total',line]).durationMs,durationMs);
 }
 assert.equal(testResultsFromLines(['Time: 1.25 s']),undefined);
 for(const durationMs of [-1,Infinity,NaN,86_400_001,'12'])assert.equal(reportedTestResults({passed:2,total:2,durationMs}).durationMs,undefined);
 assert.equal(reportedTestResults({durationMs:12}),undefined);
});

test('token readings distinguish the prompt from the session and never estimate missing usage',()=>{
 const usage=(totalTokens,cumulative=true)=>({hook_event_name:'AfterModel',mimo_usage:{totalTokens,cumulative}});
 assert.equal(codingUsage({hook_event_name:'UserPromptSubmit'}),undefined);
 let one=codingUsage(usage(12000));
 assert.deepEqual(one,{sessionTokens:12000});
 one=codingUsage({hook_event_name:'UserPromptSubmit'},one);
 assert.equal(one.promptTokens,undefined);
 one=codingUsage(usage(14500),one);
 assert.equal(one.promptTokens,2500);
 assert.equal(codingUsage(usage(14500),one).promptTokens,2500);
 assert.equal(codingUsage(usage(14000),one).promptTokens,2500);
 assert.deepEqual(codingUsage(usage(500,false)),{responseTokens:500});
 assert.equal(codingUsage({hook_event_name:'UserPromptSubmit'},{responseTokens:500}),undefined);
 assert.equal(codingUsage({hook_event_name:'SessionStart'},one),undefined);
 const two=codingUsage(usage(800));
 assert.equal(two.sessionTokens,800);assert.equal(two.promptTokens,undefined);
 for(const totalTokens of [-1,NaN,Infinity,1.5,'100',1_000_000_001])assert.equal(codingUsage(usage(totalTokens)),undefined);
 assert.equal(codingUsage({mimo_usage:{totalTokens:100,cumulative:'true'}}),undefined);
});

test('repeated pre and post events do not double-count confirmed edits',()=>{
 const pre={hook_event_name:'PreToolUse',tool_name:'Edit',tool_use_id:'edit-1',tool_input:{file_path:'invoice.ts',old_string:'a',new_string:'b'}};
 let activity=codingActivity(pre);
 activity=codingActivity({...pre,hook_event_name:'PostToolUse'},activity);
 activity=codingActivity(pre,activity);
 activity=codingActivity({...pre,hook_event_name:'PostToolUse'},activity);
 assert.equal(activity.stageCounts.Edit,1);assert.equal(activity.completedCount,1);
 const failure={...pre,tool_use_id:'failed-edit'};
 activity=codingActivity(failure,activity);
 activity=codingActivity({...failure,hook_event_name:'PostToolUseFailure'},activity);
 assert.equal(activity.stageCounts.Edit,1);
});

test('test results remain session-owned and a fresh prompt clears the prior turn',()=>{
 const one=codingActivity(run('one','PostToolUse',{mimo_tests:{passed:4,total:4}}));
 const two=codingActivity(run('two','PostToolUse',{mimo_tests:{passed:2,failed:1,total:3}}));
 assert.equal(one.lastRun.tests.passed,4);assert.equal(two.lastRun.tests.failed,1);
 const fresh=codingActivity({hook_event_name:'UserPromptSubmit',prompt:'Another task'},one);
 assert.equal(fresh.lastRun,undefined);assert.equal(fresh.completedCount,undefined);
});
