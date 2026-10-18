// SPDX-License-Identifier: MIT
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mimoBrowser } from "./mimo-browser.mjs";

const label = process.argv[2] ?? "current";
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error("Use a simple measurement label");
const output = new URL("../target/mimo-performance/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await mimoBrowser();
try {
  await browser.command("Performance.enable");
  async function sample() {
    await browser.command("HeapProfiler.collectGarbage");
    const { metrics } = await browser.command("Performance.getMetrics");
    return { ...Object.fromEntries(metrics.filter(({ name }) => ["JSHeapUsedSize", "JSHeapTotalSize", "Nodes", "JSEventListeners", "LayoutCount", "LayoutDuration", "RecalcStyleCount", "RecalcStyleDuration", "TaskDuration", "ScriptDuration"].includes(name)).map(({ name, value }) => [name, value])),
      ...await browser.evaluate(`(()=>{const views=[...document.querySelectorAll('#views>.view')];return {elements:document.querySelectorAll('*').length,hiddenElements:views.filter(view=>!view.classList.contains('on')).reduce((n,view)=>n+view.querySelectorAll('*').length,0),canvases:document.querySelectorAll('canvas').length}})()`) };
  }
  await browser.settle();
  const startup = await sample();
  await browser.evaluate(`mediaPreview.preferences({hooksInstalled:true,codingAssistant:'claude',usageEnabled:true,peekEnabled:false,autoCollapseEnabled:false,modules:{media:false,vscode:true,developerIntegrations:false}});mediaPreview.state.pinned=true;mediaPreview.state.setFocus('integration_claude');mediaPreview.state.codingTask.state='idle';mediaPreview.state.notify();mediaPreview.open('overview');`);
  await browser.settle();
  const before = await sample();
  await browser.command("Profiler.enable");
  await browser.command("Profiler.start");
  const frames = await browser.evaluate(`(async()=>{const frames=[],longTasks=[];let last=performance.now(),running=true;const tick=now=>{frames.push(now-last);last=now;if(running)requestAnimationFrame(tick)};requestAnimationFrame(tick);const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(entry=>entry.duration)));observer.observe({type:'longtask'});for(let i=0;i<40;i++){mediaPreview.island.setView(i%2?'overview':'usage');await new Promise(resolve=>setTimeout(resolve,90));}await new Promise(resolve=>setTimeout(resolve,600));running=false;observer.disconnect();return {frames,longTasks};})()`);
  const { profile } = await browser.command("Profiler.stop");
  const after = await sample();
  const hits = new Map();
  for (const node of profile.nodes) {
    const key = node.callFrame.functionName + " " + node.callFrame.url.split("/").slice(-2).join("/");
    if (node.hitCount) hits.set(key, (hits.get(key) ?? 0) + node.hitCount);
  }
  await browser.evaluate("mediaPreview.compact()");
  await browser.settle();
  const compact = await sample();
  const sorted = frames.frames.filter(ms => ms>0).sort((a,b)=>a-b);
  const result = { label, environment: "Isolated headless Chrome, 720x432, 1x DPI, GPU disabled; forced GC only at measurement boundaries", startup, before, after, compact,
    switches: { count:40, elapsedMs:Math.round(frames.frames.reduce((a,b)=>a+b,0)), medianFrameMs:sorted[Math.floor(sorted.length*.5)], p95FrameMs:sorted[Math.floor(sorted.length*.95)], longTasks:frames.longTasks, layoutCount:after.LayoutCount-before.LayoutCount, layoutMs:(after.LayoutDuration-before.LayoutDuration)*1000, styleMs:(after.RecalcStyleDuration-before.RecalcStyleDuration)*1000, scriptMs:(after.ScriptDuration-before.ScriptDuration)*1000, taskMs:(after.TaskDuration-before.TaskDuration)*1000, retainedHeapGrowth:after.JSHeapUsedSize-before.JSHeapUsedSize },
    hotFunctions:[...hits].sort((a,b)=>b[1]-a[1]).slice(0,18), errors:browser.errors };
  await writeFile(new URL(label+".json",output),JSON.stringify(result,null,2)+"\n");
  await writeFile(new URL(label+".cpuprofile",output),JSON.stringify(profile));
  console.log(JSON.stringify(result,null,2));
} finally { await browser.close(); }
