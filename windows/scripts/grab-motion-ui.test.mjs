// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import {test,after,afterEach,beforeEach} from "node:test";
import {mimoBrowser} from "./mimo-browser.mjs";
let b;
after(async()=>{await b?.close();});
afterEach(async()=>{await b?.close();b=null;});
beforeEach(async()=>{
  b=await mimoBrowser({port:1462});
  await b.evaluate(`(async()=>{
    const {Bridge}=await import('/src/core/bridge.ts');
    window.grabMotionCalls=[];
    Bridge.grabAction=async(action,args={})=>{grabMotionCalls.push([action,structuredClone(args)]);return true;};
    mediaPreview.preferences({workingModeEnabled:false,modules:{vscode:false,media:false,developerIntegrations:false},activeIntegrations:[]});
    mediaPreview.open('overview');mediaPreview.compact();mediaPreview.island.setGrabModifier(true);
  })()`);await b.settle();
});

test("Grab pickup sends the visible body size and preserves the selected pointer point",async()=>{
  const point=await b.evaluate(`(()=>{
    const island=mediaPreview.island,hit=document.querySelector('#pat-mimo').getBoundingClientRect(),rect=document.querySelector('#island').getBoundingClientRect();
    return {x:hit.x+hit.width/2+5,y:hit.y+hit.height/2-3,bodySize:island.botSize.value,bodyX:rect.x+island.botCx.value,bodyY:rect.y+island.botCy.value+island.botSize.value*.018};
  })()`);
  await b.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,modifiers:2});
  await b.command('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1,modifiers:2});
  await b.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+30,y:point.y+80,buttons:1,modifiers:2});
  const args=await b.evaluate("grabMotionCalls.find(([action])=>action==='detach')?.[1]");
  assert.ok(args);assert.ok(Math.abs(args.renderSize-point.bodySize)<.2);
  assert.ok(Math.abs(args.returnX-point.bodyX)<.2);assert.ok(Math.abs(args.returnY-point.bodyY)<.2);
  assert.ok(Math.abs(args.anchorX-(point.x-point.bodyX))<.2);assert.ok(Math.abs(args.anchorY-(point.y-point.bodyY))<.2);
  assert.equal(await b.evaluate('mediaPreview.state.visibility'),'island');
  await b.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+30,y:point.y+80,button:'left',clickCount:1,modifiers:2});
});

test("Returning Mimo enlarges the receiving lip and reports its real destination",async()=>{
  const normal=await b.evaluate("mediaPreview.island.targetSize().w");
  await b.evaluate("mediaPreview.island.setGrabDetached(true);mediaPreview.island.setGrabReturnHover(true)");await b.settle();
  assert.ok(await b.evaluate("document.querySelector('#island').getBoundingClientRect().width")>normal+14);
  await b.capture('mimo-grab-receiving-lip');
  await b.evaluate("mediaPreview.island.prepareGrabReturn(false)");await b.settle();
  const geometry=await b.evaluate("grabMotionCalls.filter(([action])=>action==='return_geometry').at(-1)?.[1]");
  const expected=await b.evaluate("(()=>{const i=mediaPreview.island,rect=i.islandRect();return {x:rect.x+i.botCx.value,y:rect.y+i.botCy.value+i.botSize.value*.018,renderSize:i.botSize.value}})()");
  for(const key of ['x','y','renderSize'])assert.ok(Math.abs(geometry[key]-expected[key])<.5,`${key} must use the visible slot`);
  await b.evaluate("mediaPreview.island.setGrabDetached(false)");await b.settle();
  assert.equal(await b.evaluate("document.querySelector('#island').dataset.grabReturnHover"),'false');
  const returnedWidth=await b.evaluate("document.querySelector('#island').getBoundingClientRect().width");
  assert.ok(Math.abs(returnedWidth-normal)<.2,JSON.stringify({returnedWidth,normal,state:await b.evaluate('mediaPreview.state.visibility')}));
  assert.equal(await b.evaluate('mediaPreview.state.visibility'),'island');
});

test("A cancelled return preparation releases pending geometry and repeated pickup still works",async()=>{
  await b.evaluate("mediaPreview.island.setGrabDetached(true);mediaPreview.island.prepareGrabReturn(false);mediaPreview.island.setGrabDetached(false)");await b.settle();
  assert.equal(await b.evaluate("grabMotionCalls.some(([action])=>action==='return_geometry')"),false);
  await b.evaluate("mediaPreview.island.setGrabDetached(true);mediaPreview.island.prepareGrabReturn(false)");await b.settle();
  assert.ok(await b.evaluate("grabMotionCalls.filter(([action])=>action==='return_geometry').length")>=1);
  assert.equal(await b.evaluate("mediaPreview.island.grabReturning"),true);
  assert.deepEqual(b.errors,[]);
});

test("Capture return opens Shelf and transfers into its visible header slot",async()=>{
  await b.evaluate("mediaPreview.island.setGrabDetached(true);mediaPreview.island.prepareGrabReturn(true)");await b.settle();
  assert.equal(await b.evaluate('mediaPreview.state.visibility'),'expanded');
  assert.equal(await b.evaluate('mediaPreview.state.view'),'grab');
  const geometry=await b.evaluate("grabMotionCalls.filter(([action])=>action==='return_geometry').at(-1)[1]");
  assert.ok(Math.abs(geometry.renderSize-30)<1);assert.ok(geometry.y>=24&&geometry.y<25);
  await b.evaluate("mediaPreview.island.setGrabDetached(false)");await b.settle();
  assert.equal(await b.evaluate("document.querySelector('#bot-canvas').getAttribute('aria-hidden')"),'false');
  assert.deepEqual(b.errors,[]);
});

test("Grab Mimo setting blocks Ctrl readiness and new drags while allowing an existing return",async()=>{
  await b.evaluate("mediaPreview.preferences({grabEnabled:false});mediaPreview.island.setGrabModifier(true)");await b.settle();
  assert.equal(await b.evaluate('mediaPreview.island.grabModifier'),false);
  await b.evaluate("mediaPreview.open('overview')");await b.settle();
  const point=await b.evaluate("(()=>{const r=document.querySelector('#pat-mimo').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await b.command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1,modifiers:2});
  await b.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+32,y:point.y+48,buttons:1,modifiers:2});
  await b.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+32,y:point.y+48,button:'left',clickCount:1,modifiers:2});
  assert.equal(await b.evaluate("grabMotionCalls.some(([action])=>action==='detach')"),false);
  await b.evaluate("mediaPreview.preferences({grabEnabled:true});mediaPreview.island.setGrabModifier(true)");
  assert.equal(await b.evaluate('mediaPreview.island.grabModifier'),true);
  await b.evaluate("mediaPreview.island.setGrabDetached(true);mediaPreview.preferences({grabEnabled:false});mediaPreview.island.prepareGrabReturn(false)");await b.settle();
  assert.ok(await b.evaluate("grabMotionCalls.some(([action])=>action==='return_geometry')"));
  await b.evaluate("mediaPreview.island.setGrabDetached(false)");
  assert.equal(await b.evaluate('mediaPreview.island.grabDetached'),false);
  assert.deepEqual(b.errors,[]);
});
