// SPDX-License-Identifier: MIT
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const port = Number(process.env.MIMO_PROFILE_PORT || 1493);
const mode = process.argv[2] || "snapshot";
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(target => target.type === "page" && /tauri\.localhost\/$/.test(target.url));
if (!target) throw new Error("Mimo's island WebView is not connected to the local profiler.");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let id = 0;
const pending = new Map();
const trace = [];
let traceComplete;
const traced = new Promise(resolve => { traceComplete = resolve; });
socket.addEventListener("message", ({ data }) => {
  const result = JSON.parse(data);
  if (result.method === "Tracing.dataCollected") trace.push(...result.params.value);
  if (result.method === "Tracing.tracingComplete") traceComplete();
  const entry = pending.get(result.id);
  if (!entry) return;
  pending.delete(result.id); clearTimeout(entry.timeout);
  if (result.error) entry.reject(new Error(result.error.message)); else entry.resolve(result.result);
});
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(method + " timed out")); }, 20000);
    pending.set(requestId, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
try {
  await command("Performance.enable");
  if (mode === "memory-dump") {
    await command("Tracing.start", { traceConfig: { includedCategories: ["disabled-by-default-memory-infra"], memoryDumpConfig: { triggers: [] } } });
    await command("Tracing.requestMemoryDump", { levelOfDetail: "detailed" });
    await command("Tracing.end");
    let traceTimeout;
    try { await Promise.race([traced, new Promise((_, reject) => { traceTimeout = setTimeout(() => reject(new Error("Memory trace timed out")), 15000); })]); }
    finally { clearTimeout(traceTimeout); }
    await mkdir("verification", { recursive: true });
    await writeFile("verification/native-memory-dump.json", JSON.stringify(trace));
    console.log(JSON.stringify(trace.filter(event => event.args?.dumps).map(({pid,args}) => ({pid,totals:args.dumps.process_totals,
      allocators:Object.entries(args.dumps.allocators || {}).map(([name,value])=>({name,mb:parseInt((value.attrs?.effective_size || value.attrs?.size || {}).value || '0',16)/1048576})).filter(({mb})=>mb>4).sort((a,b)=>b.mb-a.mb).slice(0,8)})),null,2));
  }
  if (mode === "software-canvases") {
    await command("Page.addScriptToEvaluateOnNewDocument", { source: `const getContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,options){return getContext.call(this,kind,kind==='2d'?{...options,willReadFrequently:true}:options)};` });
    await command("Page.reload", { ignoreCache: true });
  }
  if (mode === "reload") await command("Page.reload", { ignoreCache: true });
  if (mode === "hide-canvases") await evaluate("document.querySelectorAll('canvas').forEach(canvas=>canvas.style.display='none')");
  if (mode === "show-canvases") await evaluate("document.querySelectorAll('canvas').forEach(canvas=>canvas.style.removeProperty('display'))");
  if (mode === "capture") {
    await mkdir("verification", { recursive: true });
    const screenshot = await command("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve("verification/native-current.png"), Buffer.from(screenshot.data, "base64"));
  }
  const dom = await evaluate(`({viewport:[innerWidth,innerHeight,devicePixelRatio],
    title:document.title, visibility:document.hidden,activeView:document.querySelector('.view.on')?.className,
    elements:document.querySelectorAll('*').length, animations:document.getAnimations().map(a=>({target:a.effect?.target?.className,name:a.animationName,playState:a.playState})),
    canvas:[...document.querySelectorAll('canvas')].map(c=>({class:c.className,width:c.width,height:c.height,hidden:!!c.closest('[inert],[hidden]'),display:getComputedStyle(c).display})),
    text:document.querySelector('#island')?.innerText.slice(0,240)})`);
  const counters = await command("Memory.getDOMCounters");
  const metrics = Object.fromEntries((await command("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
  console.log(JSON.stringify({ mode, dom, counters, metrics }, null, 2));
} finally { socket.close(); }
