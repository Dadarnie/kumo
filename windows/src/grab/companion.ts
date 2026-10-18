// SPDX-License-Identifier: MIT
import "../design/tokens.css";
import "./windows.css";
import {Bridge,onEvent} from "../core/bridge";
import {BotEngine,type RGB} from "../mimo/engine";
import {h} from "../views/dom";
import {resizeCanvas} from "../core/canvas";
import {Ease} from "../core/anim";
import type {BotStateName} from "../core/layout";

const root=document.getElementById("root")!,canvas=h("canvas",{width:104,height:96,"aria-hidden":"true"});
root.append(canvas);
const engine=new BotEngine();engine.backdrop=true;engine.showBadge=true;
let renderSize=64,motion:{from:number;to:number;start:number;duration:number}|null=null;
let alive=true,raf=0,timer:ReturnType<typeof setTimeout>|null=null,last=performance.now(),configured=false,ready=false;
let unlisten:(()=>void)|undefined;
function wake(){if(!alive||raf)return;if(timer!==null){clearTimeout(timer);timer=null;}raf=requestAnimationFrame(frame);}
function frame(now:number){raf=0;const dt=Math.min(.05,(now-last)/1000);last=now;engine.update(dt);
  if(motion){const t=Math.min(1,Math.max(0,(Date.now()-motion.start)/motion.duration));renderSize=motion.from+(motion.to-motion.from)*Ease.out(t);if(t>=1)motion=null;}
  const dpr=resizeCanvas(canvas,104,96),ctx=canvas.getContext("2d");if(ctx){
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,104,96);
    // The sphere's visible center is exactly the native window anchor (52,48).
    ctx.translate((104-renderSize)/2,48-renderSize/2-renderSize*.018);
    engine.draw(ctx,renderSize,renderSize);
  }
  if(configured&&!ready){ready=true;void Bridge.grabAction("companion_ready").catch(()=>{});}
  if(engine.busy||motion)wake();else if(Number.isFinite(engine.nextWakeDelayMs))timer=setTimeout(wake,engine.nextWakeDelayMs);
}
engine.onWake=wake;
void (async()=>{
  const stop=await onEvent<{renderSize:number;durationMs:number;startedAt:number;immediate?:boolean}>("grab-companion-pose",pose=>{
    if(!alive||!Number.isFinite(pose.renderSize))return;
    const to=Math.max(20,Math.min(100,pose.renderSize));
    if(pose.immediate){renderSize=to;motion=null;}
    else motion={from:renderSize,to,start:pose.startedAt||Date.now(),duration:Math.max(80,Math.min(500,pose.durationMs))};
    wake();
  });
  if(!alive){stop();return;}unlisten=stop;
  const value=await Bridge.grabAction<{color:string;state:BotStateName;renderSize:number;pose?:Partial<Pick<BotEngine,"yaw"|"pitch"|"tilt"|"sx"|"sy">>;badge:BotEngine["badge"]}>("companion_state");
  if(!alive||!value)return;if(/^#[0-9a-f]{6}$/i.test(value.color)){engine.bodyColor=[1,3,5].map(index=>parseInt(value.color.slice(index,index+2),16)/255) as unknown as RGB;}
  if(["idle","working","thinking","searching","approval","question","error","finished","ratelimit"].includes(value.state))engine.setState(value.state);
  engine.settlePose();renderSize=Math.max(20,Math.min(100,value.renderSize||64));
  if(value.pose)for(const key of ["yaw","pitch","tilt","sx","sy"] as const){const v=value.pose[key];if(typeof v==="number"&&Number.isFinite(v))engine[key]=v;}
  if(value.badge)engine.badge=value.badge;
  configured=true;wake();
})().catch(()=>{});
const stop=()=>{alive=false;cancelAnimationFrame(raf);if(timer)clearTimeout(timer);unlisten?.();engine.destroy();};
window.addEventListener("pagehide",stop,{once:true});import.meta.hot?.dispose(stop);wake();
