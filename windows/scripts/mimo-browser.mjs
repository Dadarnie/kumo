// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export const artifacts = join(root, "target", "coding-preview-review");

/** Isolated browser and port so another UI session can keep its own preview. */
export async function mimoBrowser({ page = "/dev/media-preview.html", ready = "window.mediaPreview?.island", port = 1441 } = {}) {
  let server, chrome, profile, socket, session;
  let sequence = 0;
  const requests = new Map();
  const errors = [];
  function command(method, params = {}, sessionId = session) {
    return new Promise((resolveCommand, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { requests.delete(id); reject(new Error(method + " timed out")); }, 15000);
      requests.set(id, { resolve: resolveCommand, reject, timeout });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async function evaluate(expression) {
    const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async function close() {
    if (socket?.readyState === WebSocket.OPEN) {
      await command("Browser.close", {}, null).catch(() => {});
      socket.close();
    }
    for (const request of requests.values()) { clearTimeout(request.timeout); request.reject(new Error("Browser closed")); }
    requests.clear();
    chrome?.kill(); server?.kill();
    if (profile) {
      assert.equal(dirname(resolve(profile)), resolve(tmpdir()));
      assert.ok(basename(profile).startsWith("mimo-coding-preview-"));
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    }
  }
  try {
    await mkdir(artifacts, { recursive: true });
    server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort", "--mode", "test"], { cwd: root, windowsHide: true });
    await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error("Preview server did not start")), 15000);
      server.on("error", reject);
      server.on("exit", code => reject(new Error("Preview server exited: " + code)));
      server.stdout.on("data", data => { if (String(data).includes(String(port))) { clearTimeout(timeout); resolveReady(); } });
    });
    profile = await mkdtemp(join(tmpdir(), "mimo-coding-preview-"));
    chrome = spawn(process.env.MIMO_TEST_BROWSER ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      ["--headless=new", "--disable-gpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true });
    const endpoint = await new Promise((resolveEndpoint, reject) => {
      const timeout = setTimeout(() => reject(new Error("Chrome did not start")), 15000);
      chrome.on("error", reject);
      chrome.on("exit", code => reject(new Error("Chrome exited: " + code)));
      chrome.stderr.on("data", data => { const match = String(data).match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timeout); resolveEndpoint(match[1]); } });
    });
    socket = new WebSocket(endpoint);
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const request = requests.get(message.id);
        if (!request) return;
        requests.delete(message.id); clearTimeout(request.timeout);
        if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    });
    await new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const target = await command("Target.createTarget", { url: "about:blank" }, null);
    session = (await command("Target.attachToTarget", { targetId: target.targetId, flatten: true }, null)).sessionId;
    await command("Page.enable"); await command("Runtime.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 720, height: 432, deviceScaleFactor: 1, mobile: false });
    await command("Page.navigate", { url: `http://127.0.0.1:${port}` + page });
    await evaluate(`new Promise((resolveReady,reject)=>{const deadline=performance.now()+8000;const poll=()=>(${ready})?resolveReady():performance.now()>deadline?reject(new Error('Preview did not initialize')):setTimeout(poll,30);poll()})`);
    async function click(selector) {
      const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing '+${JSON.stringify(selector)});const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:el.contains(document.elementFromPoint(x,y))}})()`);
      assert.ok(point.hit, selector + " must receive pointer input");
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await command("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }) });
    }
    async function reload() {
      let timeout, receive;
      const loaded = new Promise((resolveLoaded, reject) => {
        receive = event => {
          const message = JSON.parse(String(event.data));
          if (message.sessionId === session && message.method === "Page.loadEventFired") resolveLoaded();
        };
        socket.addEventListener("message", receive);
        timeout = setTimeout(() => reject(new Error("Preview did not reload")), 15000);
      });
      try { await command("Page.reload"); await loaded; }
      finally { clearTimeout(timeout); socket.removeEventListener("message", receive); }
      await evaluate(`new Promise((resolveReady,reject)=>{const deadline=performance.now()+8000;const poll=()=>(${ready})?resolveReady():performance.now()>deadline?reject(new Error('Preview did not initialize')):setTimeout(poll,30);poll()})`);
    }
    const settle = () => evaluate("new Promise(resolveReady=>setTimeout(resolveReady,400))");
    async function capture(name) { const result = await command("Page.captureScreenshot", { format: "png" }); await writeFile(join(artifacts, name + ".png"), Buffer.from(result.data, "base64")); }
    return { command, evaluate, click, reload, settle, capture, close, errors };
  } catch (error) {
    if (errors.length) error.message += "\nBrowser errors: " + errors.join("\n");
    await close(); throw error;
  }
}
