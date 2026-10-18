// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import {test} from "node:test";
import {loadSource} from "./ts-test-loader.mjs";

let saves=0;
const date=new Date();
const currentDay=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const values=new Map([['mimo.activity.v1',JSON.stringify({
  days:[{date:'2001-01-01',tokens:900,agents:{codex:900}},
    {date:currentDay,tokens:27,agents:{codex:27},codingSeconds:100,replies:5,sessions:2,longestFocus:80}],
  feed:[{id:'old-dashboard',label:'Old counter',at:1}],
  readings:{codex:[{checkedAt:123,primary:null,secondary:null}]},
})]]);
globalThis.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>{saves++;values.set(key,value);}};
const {Activity}=await import(await loadSource("../src/core/activity.ts"));

test("animation owners share one live reduced-motion query", async()=>{
  let allocations=0;
  const preference={matches:false};
  globalThis.window={matchMedia:()=>{allocations++;return preference;}};
  try {
    const {prefersReducedMotion,reducedMotionQuery}=await import(await loadSource("../src/core/motion.ts"));
    for(let frame=0;frame<10000;frame++)assert.equal(prefersReducedMotion(),false);
    assert.equal(allocations,1,"frame reads must not allocate browser query objects");
    preference.matches=true;
    assert.equal(prefersReducedMotion(),true,"changes remain live without rebuilding the query");
    assert.equal(reducedMotionQuery(),preference);
  } finally {delete globalThis.window;}
});

test("hook bursts keep totals live and batch persistence off the event path", async()=>{
  let notifications=0;
  const beforeSaves=saves;
  const stop=Activity.subscribe(()=>notifications++);
  const before=Activity.today.tokens;
  for(let i=1;i<=250;i++) Activity.observeHook("codex",{session_id:"runtime-burst",hook_event_name:"PreToolUse",usage:{total_tokens:i}});
  assert.equal(Activity.today.tokens-before,250);
  assert.equal(notifications,250,"each hook publishes one coherent state");
  assert.equal(saves,beforeSaves,"hook input must not synchronously serialize history");
  await new Promise(resolve=>setTimeout(resolve,350));
  assert.equal(saves,beforeSaves+1);
  assert.equal(JSON.parse(values.get("mimo.activity.v1")).days.at(-1).tokens,Activity.today.tokens);
  stop();
});

test("retired dashboard history and counters are discarded while today's Limits data survives",()=>{
  Activity.observedTokens('codex',1);Activity.flush();
  const saved=JSON.parse(values.get('mimo.activity.v1'));
  assert.equal('feed' in saved,false);
  assert.equal(saved.days.length,1,'Old daily dashboard history is no longer retained in RAM or saved');
  assert.deepEqual(Object.keys(saved.days[0]).sort(),['agents','date','tokens']);
  assert.ok(Activity.today.agents.codex>=28);
  assert.equal(Activity.latest('codex').checkedAt,123);
});

test("flush saves the latest activity before teardown",()=>{
  Activity.observedTokens("codex",12);
  const before=saves;
  Activity.flush();
  assert.equal(saves,before+1);
  assert.equal(JSON.parse(values.get("mimo.activity.v1")).days.at(-1).tokens,Activity.today.tokens);
  Activity.flush();
  assert.equal(saves,before+1,"a clean store does not write again");
});

test("hooks without usage and temporary chat state do not write removed statistics",()=>{
  const before=saves;
  for(let i=0;i<250;i++)Activity.observeHook('codex',{session_id:'no-usage',hook_event_name:'PreToolUse'});
  Activity.chatStarted();Activity.chatFinished();Activity.flush();
  assert.equal(saves,before);
});
