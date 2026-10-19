// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadSource} from './ts-test-loader.mjs';
const {reportedTestResults,testResultsFromLines}=await import(await loadSource('../src/core/test-results.ts'));
const {codingActivity}=await import(await loadSource('../src/core/coding-activity.ts'));
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
