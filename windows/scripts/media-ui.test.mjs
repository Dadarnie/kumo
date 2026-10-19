// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { loadSource } from "./ts-test-loader.mjs";

const { PANEL_H } = await import(await loadSource("../src/core/layout.ts"));
const { MEDIA_VIEW_CARD_HEIGHT, MEDIA_VIEW_COLLAPSED_HEIGHT, MEDIA_EMPTY_CARD_HEIGHT, MEDIA_EMPTY_COLLAPSED_HEIGHT } = await import(
  await loadSource("../src/core/design.ts"),
);

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(projectRoot, "target", "media-ui");
let server;
let chrome;
let profile;
let socket;
let sessionId;
let sequence = 0;
const pending = new Map();
const browserErrors = [];

function command(method, params = {}, session = sessionId) {
  return new Promise((resolveCommand, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Chrome command timed out: ${method}`));
    }, 10000);
    pending.set(id, { resolveCommand, reject, timeout });
    socket.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(session ? { sessionId: session } : {}),
      }),
    );
  });
}

async function evaluate(expression) {
  const response = await command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        "Browser evaluation failed",
    );
  }
  return response.result.value;
}

// Wait for existing spring/CSS transitions, without introducing timers into the app.
const settled = `new Promise(resolve => setTimeout(resolve, 900))`;
const ateFile = `new Promise((resolve,reject)=>{
  const deadline=performance.now()+8000;
  const ready=()=>mediaPreview.state.view==='choose'?resolve():performance.now()>deadline?reject(new Error('Mimo did not offer the file choices after eating the file')):setTimeout(ready,30);
  ready();
})`;
async function scene(
  playback,
  title = "Night Drive",
  artist = "The Midnight",
  mode = "expanded",
) {
  await command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 0,
    y: 383,
  });
  await evaluate(
    `${mode === "compact" ? "mediaPreview.preferences({workingModeEnabled:false});" : ""}mediaPreview.publish(${JSON.stringify(playback)}, ${JSON.stringify(title)}, ${JSON.stringify(artist)}); mediaPreview.${mode === "compact" ? "compact()" : "open('media')"};`,
  );
  await evaluate(settled);
}

async function inspect() {
  return evaluate(`(() => {
    const row = document.querySelector('.media-row');
    const ambient = document.querySelector('.media-ambient');
    const title = document.querySelector('.media-title');
    const artist = document.querySelector('.media-artist');
    const island = document.querySelector('#island');
    const status = document.querySelector('.media-status');
    return {
      rowVisible: row?.getAttribute('aria-hidden') === 'false',
      ambientVisible: ambient?.getAttribute('aria-hidden') === 'false',
      title: title?.textContent ?? '', artist: artist?.textContent ?? '',
      artistHidden: artist?.hidden, status: status?.textContent,
      quiet: row?.classList.contains('is-quiet'),
      artVisible: document.querySelector('.media-artwork')?.classList.contains('has-art') ?? false,
      controls: [...document.querySelectorAll('.media-controls button:not(.media-mode)')].map(button => ({ label: button.getAttribute('aria-label'), disabled: button.disabled })),
      height: island.getBoundingClientRect().height,
      titleStyle: title && { overflow: getComputedStyle(title).overflow, ellipsis: getComputedStyle(title).textOverflow, wrap: getComputedStyle(title).whiteSpace },
      bounds: row && [row, title, artist, ambient].filter(Boolean).map(el => {
        const r = el.getBoundingClientRect(); const outer = island.getBoundingClientRect();
        return { className: el.className, inside: r.left >= outer.left && r.right <= outer.right, width: r.width, scrollWidth: el.scrollWidth };
      }),
    };
  })()`);
}

async function capture(name) {
  const { data } = await command("Page.captureScreenshot", { format: "png" });
  await writeFile(join(artifacts, `${name}.png`), Buffer.from(data, "base64"));
}

async function pointerClick(selector) {
  await evaluate(
    `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`,
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,220))");
  const point = await evaluate(
    `(() => {const el=document.querySelector(${JSON.stringify(selector)});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hit:el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`,
  );
  assert.equal(point.hit, true, `${selector} must receive pointer input`);
  await command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

async function aimFileAtIsland() {
  await evaluate("(()=>{const r=mediaPreview.island.islandRect();mediaPreview.island.onCursor(r.x+r.w/2,r.y+r.h/2)})()");
}

async function selectIntegration(id) {
  if (await evaluate(`document.querySelector('.module-activity')?.dataset.integration === ${JSON.stringify(id)}`)) return;
  const tile = `.integration-tile[data-integration=${id}]`;
  if (await evaluate(`document.querySelector(${JSON.stringify(tile)}) !== null`))
    await pointerClick(tile);
  else {
    await pointerClick('.integration-more');
    await evaluate("new Promise(resolve=>setTimeout(resolve,220))");
    await pointerClick(`.integration-more-picker [data-device=${id}]`);
  }
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.module-activity')?.dataset.integration"), id, "Selected integration owns the workspace");
}

// Navigation replaces the JavaScript context. Register the load listener before
// sending the command, then evaluate only in the newly loaded document.
async function loadPage(method, params = {}) {
  const loaded = new Promise((resolveLoaded, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", receive);
    };
    const receive = (event) => {
      const message = JSON.parse(String(event.data));
      if (
        message.sessionId === sessionId &&
        message.method === "Page.loadEventFired"
      ) {
        cleanup();
        resolveLoaded();
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Page did not finish loading"));
    }, 15000);
    socket.addEventListener("message", receive);
  });
  await command(method, params);
  await loaded;
  // Tauri mocks can finish the load event before the preview's module graph.
  await evaluate(`new Promise((resolve, reject) => {
    if (location.pathname !== '/dev/media-preview.html') return resolve();
    const deadline = performance.now() + 8000;
    const ready = () => {
      if (window.mediaPreview?.island) resolve();
      else if (performance.now() > deadline) reject(new Error('Media preview did not initialize'));
      else setTimeout(ready, 20);
    };
    ready();
  })`);
}

before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      "1431",
      "--strictPort",
      "--mode",
      "test",
    ],
    { cwd: projectRoot, windowsHide: true },
  );
  await new Promise((resolveServer, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Vite did not start")),
      15000,
    );
    server.on("error", reject);
    server.on("exit", (code) => reject(new Error(`Vite exited: ${code}`)));
    server.stdout.on("data", (data) => {
      if (String(data).includes("1431")) {
        clearTimeout(timeout);
        resolveServer();
      }
    });
  });
  profile = await mkdtemp(join(tmpdir(), "mimo-media-ui-"));
  const chromePath =
    process.env.MIMO_TEST_BROWSER ??
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { windowsHide: true },
  );
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Chrome DevTools did not start")),
      15000,
    );
    chrome.on("error", reject);
    chrome.on("exit", (code) => reject(new Error(`Chrome exited: ${code}`)));
    chrome.stderr.on("data", (data) => {
      const match = String(data).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolveEndpoint(match[1]);
      }
    });
  });
  socket = new WebSocket(endpoint);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (!request) return;
      clearTimeout(request.timeout);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolveCommand(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      browserErrors.push(
        message.params.exceptionDetails.exception?.description ??
          message.params.exceptionDetails.text,
      );
    }
  });
  await new Promise((resolveSocket, reject) => {
    socket.addEventListener("open", resolveSocket, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const target = await command(
    "Target.createTarget",
    { url: "about:blank" },
    null,
  );
  sessionId = (
    await command(
      "Target.attachToTarget",
      { targetId: target.targetId, flatten: true },
      null,
    )
  ).sessionId;
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Emulation.setDeviceMetricsOverride", {
    width: 720,
    height: PANEL_H,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await loadPage("Page.navigate", {
    url: "http://127.0.0.1:1431/dev/media-preview.html",
  });
  assert.equal(await evaluate("Boolean(window.mediaPreview)"), true);
});

after(async () => {
  if (socket?.readyState === WebSocket.OPEN) {
    await command("Browser.close", {}, null).catch(() => {});
    socket.close();
  }
  chrome?.kill();
  server?.kill();
  // Only remove the profile this test created, under the resolved temp directory.
  if (profile) {
    assert.equal(dirname(resolve(profile)), resolve(tmpdir()));
    assert.ok(basename(profile).startsWith("mimo-media-ui-"));
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 150,
    });
  }
});

async function panelFixture() {
  await evaluate(`(async()=>{
    const {Activity,dayKey}=await import('/src/core/activity.ts');
    const {Bridge}=await import('/src/core/bridge.ts');
    const {Sound}=await import('/src/core/sound.ts');
    const dates=Array.from({length:220},(_,i)=>{const date=new Date();date.setHours(12,0,0,0);date.setDate(date.getDate()-i);
      const tokens=i===0?89900000:i===1?17100000:i%6===0?0:(i*347791)%8000000;
      return {date:dayKey(date),tokens,codingSeconds:i%6===0?0:2400,replies:i%8,sessions:i%4,longestFocus:1800,agents:{codex:Math.round(tokens*.8),claude:tokens-Math.round(tokens*.8)}};
    });
    window.panelReads=0;window.panelLinks=[];window.panelSounds=[];
    mediaPreview.state.usageProvider=null;mediaPreview.state.selectedCodingId=null;
    Bridge.openUrl=async url=>{panelLinks.push(url)};
    Bridge.codexUsage=async()=>{panelReads++;return {plan:'plus',primary:{usedPercent:0,windowMinutes:300,resetsAt:Date.now()/1000+12000},secondary:{usedPercent:56,windowMinutes:10080,resetsAt:Date.now()/1000+240000},lifetimeTokens:634700000,checkedAt:Date.now()/1000}};
    Bridge.claudeUsage=async()=>({plan:'pro',primary:{usedPercent:20,windowMinutes:300,resetsAt:Date.now()/1000+12000},secondary:{usedPercent:45,windowMinutes:10080,resetsAt:Date.now()/1000+240000},lifetimeTokens:null,contextUsedPercent:28,inputTokens:12000,outputTokens:1400,sessionCostUsd:.14,checkedAt:Date.now()/1000});
    const play=Sound.play.bind(Sound);Sound.play=name=>{panelSounds.push(name);play(name)};
    mediaPreview.preferences({peekEnabled:false,usageEnabled:true,codingAssistant:'codex',codexHooksInstalled:true,hooksInstalled:true,appearance:'dark',modules:{media:true,vscode:true,developerIntegrations:true},activeIntegrations:['integration_github','integration_vercel']});
    Activity.observeUsage('codex',await Bridge.codexUsage());
    Activity.observeUsage('claude',await Bridge.claudeUsage());
    const contributions=dates.map((day,i)=>({date:day.date,count:i%5===0?0:i%13+1})).reverse();
    mediaPreview.state.integrations.integration_github={configured:true,loaded:true,error:null,data:{login:'mimo-dev',totalRepos:12,totalStars:3840,openPullRequests:3,reviewCount:2,contributions,
      pullRequests:[{title:'Make room for the new Home panel',number:42,repo:'mimo/core',author:'mimo-dev',state:'open',url:'https://github.com/mimo/core/pull/42',updatedAt:Date.now()-3600000},{title:'Polish the contribution calendar',number:41,repo:'mimo/core',author:'mimo-dev',state:'open',url:'https://github.com/mimo/core/pull/41',updatedAt:Date.now()-7200000},{title:'A very long pull request title that should truncate gracefully without moving the compact controls outside the workspace',number:40,repo:'mimo/core',author:'mimo-dev',draft:true,url:'https://github.com/mimo/core/pull/40',updatedAt:Date.now()-86400000}],
      reviews:[{title:'Keep the island quiet',number:39,repo:'mimo/core',author:'alex',state:'open',url:'https://github.com/mimo/core/pull/39'},{title:'Refine Glass mode',number:38,repo:'mimo/core',author:'sam',state:'open',url:'https://github.com/mimo/core/pull/38'}],
      issues:[{title:'Add keyboard day selection',number:35,repo:'mimo/core',author:'alex',state:'open',url:'https://github.com/mimo/core/issues/35'}],
      repositories:[{name:'mimo/core',stars:3800,issues:4,url:'https://github.com/mimo/core',private:false},{name:'mimo/tools',stars:40,issues:1,url:'https://github.com/mimo/tools',private:true}],
      activity:[{type:'PushEvent',repo:'mimo/core',actor:'mimo-dev',url:'https://github.com/mimo/core',createdAt:Date.now()-60000}],
      checks:[{repo:'mimo/core',branch:'main',state:'success',checkCount:4,url:'https://github.com/mimo/core/actions'},{repo:'mimo/tools',branch:'main',state:'success',checkCount:2,url:'https://github.com/mimo/tools/actions'}],warnings:[]}};
    mediaPreview.state.notify();mediaPreview.publish('playing');mediaPreview.open('overview');
  })()`);
  await evaluate(settled);
}

async function clearPanelFixture() {
  await evaluate("localStorage.removeItem('mimo.activity.v1')");
  await loadPage("Page.reload");
}

async function connectedToolFixtures() {
  await evaluate(`for(const id of ['integration_resend','integration_n8n','integration_vercel','integration_github','integration_notion','integration_calcom','integration_stripe']) {
    mediaPreview.state.integrations[id]={configured:true,loaded:true,error:null,data:{}};
  }mediaPreview.state.notify()`);
}

test("Home keeps enabled unconnected mini Mimos visible and follows Settings toggles", async (t) => {
  t.after(clearPanelFixture); await panelFixture();
  const ids = ['integration_resend','integration_n8n','integration_vercel','integration_github'];
  await evaluate(`mediaPreview.publish('none');mediaPreview.preferences({usageEnabled:false,activeIntegrations:${JSON.stringify(ids)}});
    for(const id of ${JSON.stringify(ids)}) mediaPreview.state.integrations[id]={configured:false,loaded:false,error:null,data:{}};
    mediaPreview.state.notify();mediaPreview.open('overview')`); await evaluate(settled);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.integration-tile[data-integration]')].map(el=>el.dataset.integration)"),ids);
  assert.equal(await evaluate("document.querySelectorAll('.integration-picker canvas').length"),4);
  assert.equal(await evaluate("document.querySelectorAll('.integration-picker .mini-notification').length"),0);
  assert.equal(await evaluate("document.querySelector('.home-workspace').getBoundingClientRect().height"),120);
  for(const id of ids) {
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.integration-tile[data-integration=${id}] .integration-label')).textAlign`),'center');
  }
  await capture('home-enabled-unconnected-mini-mimos');
  await pointerClick('.integration-tile[data-integration=integration_resend]'); await evaluate(settled);
  assert.match(await evaluate("document.querySelector('.module-activity').textContent"),/Connect Resend/);
  assert.equal(await evaluate("document.querySelector('.int-configure')!==null"),true);
  await evaluate("mediaPreview.state.toggleIntegration('integration_n8n')"); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.integration-tile[data-integration=integration_n8n]')"),null);
  await evaluate("mediaPreview.state.toggleIntegration('integration_n8n')"); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.integration-tile[data-integration=integration_n8n] canvas')!==null"),true);
  await evaluate(`mediaPreview.preferences({activeIntegrations:[...${JSON.stringify(ids)},'integration_notion','integration_calcom','integration_stripe']})`); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.integration-more-picker').hidden"),false);
  await selectIntegration('integration_stripe');
  assert.match(await evaluate("document.querySelector('.module-activity').textContent"),/Connect Stripe/);
  assert.deepEqual(browserErrors,[]);
});

test("Home work queue keeps three quiet rows and opens the integrated terminal", async (t) => {
  t.after(async()=>{await command('Emulation.setEmulatedMedia',{features:[]});
    await command('Emulation.setDeviceMetricsOverride',{width:720,height:PANEL_H,deviceScaleFactor:1,mobile:false});
    await evaluate("delete document.hidden");await clearPanelFixture();}); await panelFixture();
  await evaluate(`(async()=>{const {codingActivity}=await import('/src/core/coding-activity.ts');
    window.queueActivity=codingActivity;mediaPreview.publish('none');
    mediaPreview.preferences({usageEnabled:false,activeIntegrations:['integration_resend','integration_n8n','integration_vercel','integration_github']});
    window.queueTask=mediaPreview.state.upsertCodingTask('codex','Mimo','C:/work/mimo','home-queue');
    queueTask.state='working';queueTask.lastEventAt=Date.now();queueTask.activity=queueActivity({hook_event_name:'PreToolUse',tool_name:'Read',tool_use_id:'read',tool_input:{file_path:'src/billing.ts'}});
    mediaPreview.state.selectCodingTask(queueTask.id);mediaPreview.open('overview')})()`); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-start-label').textContent"),'Start working…');
  assert.equal(await evaluate("document.querySelector('.coding-summary').textContent"),'Waiting for next action');
  const material=await evaluate(`(()=>{const surface=document.querySelector('.home-workspace'),card=document.querySelector('.module-activity'),context=document.querySelector('.coding-home-context').getBoundingClientRect(),trigger=document.querySelector('.coding-preview-trigger').getBoundingClientRect(),r=surface.getBoundingClientRect(),s=getComputedStyle(surface);return {
    height:r.height,islandHeight:document.querySelector('#island').getBoundingClientRect().height,corners:s.borderRadius,border:s.borderWidth,
    transparent:getComputedStyle(card).backgroundColor,previewButton:document.querySelector('.coding-expand')===null,
    contextAboveMimo:context.bottom<=document.querySelector('#island').getBoundingClientRect().top+mediaPreview.island.botCy.value-28,
    contextSeparate:context.right<=trigger.left,icons:document.querySelectorAll('.coding-preview-trigger > div > .ui-icon').length};})()`);
  assert.deepEqual(material,{height:120,islandHeight:210,corners:'16px',border:'0px',transparent:'rgb(27, 27, 27)',previewButton:true,contextAboveMimo:true,contextSeparate:true,icons:2});
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-action-copy')).animationName"),'coding-text-highlight');
  assert.deepEqual(await evaluate("(()=>{const style=getComputedStyle(document.querySelector('.coding-action-copy'));return [style.animationDuration,style.animationTimingFunction,style.animationIterationCount,style.color]})()"),
    ['2.6s','ease-in-out','infinite','rgb(170, 169, 174)'],'Compact work restores the previous continuous highlight over grey text');
  assert.match(await evaluate("getComputedStyle(document.querySelector('.coding-action-copy')).backgroundImage"),/linear-gradient/);
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.coding-action-copy')).color"),'rgba(0, 0, 0, 0)');
  const glimmerPosition=await evaluate("getComputedStyle(document.querySelector('.coding-action-copy')).backgroundPosition");
  await evaluate("new Promise(resolve=>setTimeout(resolve,160))");
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.coding-action-copy')).backgroundPosition"),glimmerPosition);
  await capture('home-work-queue-glimmer-1x');
  await evaluate("mediaPreview.state.paused=true;mediaPreview.state.notify()"); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-action-copy').getAnimations().length"),0,'Paused work parks the glimmer');
  await evaluate("mediaPreview.state.paused=false;mediaPreview.state.notify()"); await evaluate(settled);
  const motion=await evaluate(`queueTask.activity=queueActivity({hook_event_name:'PreToolUse',tool_name:'Edit',tool_use_id:'edit',tool_input:{file_path:'src/billing.ts',old_string:'return 1',new_string:'return 2'}},queueTask.activity);
    queueTask.activity.nextActions=['Run billing tests'];mediaPreview.state.notify();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
      const row=document.querySelector('.coding-action-row');resolve({previous:document.querySelector('.coding-start-label').textContent,next:document.querySelector('.coding-summary').textContent,
        frames:row.getAnimations().map(a=>a.effect.getKeyframes().map(f=>f.transform))});})))`);
  assert.equal(motion.previous,'Read src/billing.ts'); assert.equal(motion.next,'Run billing tests');
  assert.ok(motion.frames.some(frames=>frames[0]==='translateY(2px)'));
  await evaluate(settled);
  await command('Emulation.setDeviceMetricsOverride',{width:720,height:PANEL_H,deviceScaleFactor:2,mobile:false});await evaluate(settled); await capture('home-work-queue-2x');
  await evaluate("document.querySelector('#island').dataset.appearance='glass'"); await capture('home-work-queue-glass-2x');
  await evaluate("document.querySelector('#island').dataset.appearance='dark'");
  await evaluate(`queueTask.activity=queueActivity({hook_event_name:'PreToolUse',tool_name:'Bash',tool_use_id:'run',tool_input:{command:'npm test'}},queueTask.activity);mediaPreview.state.notify()`);await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-start-label').textContent"),'Edit src/billing.ts');
  await evaluate("document.querySelector('.coding-preview-trigger').focus()");
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-card').dataset.expanded"),'true');
  assert.equal(await evaluate("document.activeElement.classList.contains('coding-preview')"),true);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-current')).borderBottomWidth"),'0px');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}); await evaluate(settled);
  assert.equal(await evaluate("document.activeElement.classList.contains('coding-preview-trigger')"),true);
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await evaluate("document.querySelector('.coding-action-copy').getAnimations().length"),0);
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.coding-action-copy')).color"),'rgba(0, 0, 0, 0)');
  await command('Emulation.setEmulatedMedia',{features:[]});
  await evaluate("queueTask.lastEventAt=Date.now()-91000;mediaPreview.state.notify()");await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-action-copy').getAnimations().length"),0,'Quiet gaps keep the reported action without decorative animation');
  assert.equal(await evaluate("document.querySelector('.coding-action').textContent"),'Run');
  assert.match(await evaluate("document.querySelector('.coding-summary').textContent"),/No recent activity/);
  assert.deepEqual(browserErrors,[]);
});


test("New workflow entry names Approval and Home omits the repeated task prompt", async (t) => {
  t.after(clearPanelFixture);
  await panelFixture();
  await evaluate(`mediaPreview.preferences({workflowSetupDone:false});
    mediaPreview.state.pendingApprovals=[];
    mediaPreview.state.missedApprovals=[{requestId:'past-request',provider:'codex',project:'Shop',tool:'Bash',command:'npm test',status:'Returned to editor',missedAt:Date.now()}];
    mediaPreview.state.tasks=mediaPreview.state.tasks.filter(t=>!t.sessionId);
    const first=mediaPreview.state.upsertCodingTask('codex','Shop','C:/work/shop','session-first');
    const second=mediaPreview.state.upsertCodingTask('codex','Shop','C:/work/shop','session-second');
    mediaPreview.state.updateTask(first.id,'working');mediaPreview.state.updateTask(second.id,'working');
    mediaPreview.state.focusId=first.id;mediaPreview.state.notify();mediaPreview.open('overview');`);
  await evaluate(settled);
  await capture('home-buttons-before-or-after');
  assert.equal(await evaluate("document.querySelector('.approvals-entry span').textContent"),'Approval');
  assert.equal(await evaluate("document.querySelector('.home-view').textContent.includes('Start a real task')"),false);
});

test("VS Code switches live agents compactly and preserves a manual editing selection",async(t)=>{
  t.after(clearPanelFixture);await panelFixture();
  await evaluate(`mediaPreview.state.tasks=mediaPreview.state.tasks.filter(t=>!t.sessionId);
    const first=mediaPreview.state.upsertCodingTask('codex','Shop','C:/work/shop','auto-shop');
    first.activity={tool:'Edit',action:'Edit',target:'src/shop.ts',phase:'running'};
    mediaPreview.state.updateTask(first.id,'working');mediaPreview.state.focusId=first.id;
    const second=mediaPreview.state.upsertCodingTask('claude','Docs','C:/work/docs','auto-docs');
    second.activity={tool:'Edit',action:'Edit',target:'src/docs.ts',phase:'running'};
    mediaPreview.state.updateTask(second.id,'working');mediaPreview.state.notify();mediaPreview.open('overview');`);
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.home-view .coding-project').textContent"),'Claude');
  assert.equal(await evaluate("document.querySelector('.home-view .coding-session-select').textContent"),'Claude');
  assert.equal(await evaluate("document.querySelector('.home-view .coding-target').textContent"),'src/docs.ts');
  await pointerClick('.coding-session-select');
  await pointerClick('.coding-session-picker [data-device=session_codex_auto-shop]');await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.home-view .coding-target').textContent"),'src/shop.ts');
  await evaluate(`const other=mediaPreview.state.tasks.find(t=>t.sessionId==='auto-docs');
    other.activity={tool:'Edit',action:'Edit',target:'src/another-doc.ts',phase:'running'};
    mediaPreview.state.lastCodingId=other.id;mediaPreview.state.notify();`);await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.home-view .coding-target').textContent"),'src/shop.ts');
  const fits=await evaluate("document.querySelector('.coding-session-select').getBoundingClientRect().right<=document.querySelector('.home-workspace').getBoundingClientRect().right");
  assert.equal(fits,true);
  await capture('mimo-live-agent-picker-dark');
  await pointerClick('.coding-session-select');await pointerClick('.coding-session-picker [data-device=auto]');await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.home-view .coding-target').textContent"),'src/another-doc.ts');
  await evaluate("mediaPreview.preferences({appearance:'glass'})");await evaluate(settled);await capture('mimo-live-agent-picker-glass');
});

test("Removed History routes return Home and coding completion preserves the draft without saving work",async(t)=>{
  t.after(async()=>{
    await evaluate("(async()=>{const {resetHookSession}=await import('/src/island/hooks.ts');resetHookSession(mediaPreview.island)})()");
    await clearPanelFixture();
  });
  await panelFixture();
  await evaluate(`(async()=>{
    const {handleHook}=await import('/src/island/hooks.ts');
    localStorage.removeItem('mimo.work.v1');
    mediaPreview.preferences({workflowSetupDone:true,autoCollapseEnabled:false});
    mediaPreview.state.chatDraft='Keep my existing chat draft';
    mediaPreview.state.pendingApprovals=[];mediaPreview.state.missedApprovals=[];
    for(const event of ['UserPromptSubmit','Stop'])handleHook(mediaPreview.island,{mimo_provider:'codex',session_id:'no-history',
      cwd:'C:/work/shop',hook_event_name:event,prompt:'Fix checkout'});
    mediaPreview.state.notify();mediaPreview.open('history');
  })()`);
  await evaluate(settled);
  assert.equal(await evaluate('mediaPreview.state.view'),'overview');
  assert.equal(await evaluate("document.querySelector('.work-history-view,.handoff-editor')"),null);
  assert.equal(await evaluate("document.querySelector('.home-view').textContent.includes('Resume last work')"),false);
  assert.equal(await evaluate("document.querySelector('.home-view').textContent.includes('Start a real task')"),false);
  assert.equal(await evaluate("localStorage.getItem('mimo.work.v1')"),null);
  assert.equal(await evaluate('mediaPreview.state.chatDraft'),'Keep my existing chat draft');
  await capture('checkpoint-home-without-history');
  await evaluate(`mediaPreview.state.missedApprovals=[{requestId:'keep-request',provider:'codex',project:'Shop',tool:'Bash',
    command:'npm test',status:'Returned to editor',missedAt:Date.now()}];mediaPreview.state.notify();mediaPreview.open('approvals')`);
  await evaluate(settled);
  assert.match(await evaluate("document.querySelector('.approval-inbox-view.on').textContent"),/Approval.*Shop.*npm test/);
  assert.equal(await evaluate("document.querySelector('.approval-inbox-view.on .approval-inbox-review').textContent"),'Open tool');
  await capture('checkpoint-approvals-without-history');
  assert.deepEqual(browserErrors,[]);
});

test("Mimo workflow Home removes Activity and owns retained actions", async (t) => {
  t.after(clearPanelFixture); await panelFixture();
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.section-tab:not([hidden])')].map(b=>b.dataset.section)"), ['overview','media','grab']);
  assert.equal(await evaluate("document.querySelector('.home-activity-widget,.activity-view,.utilities-view')"), null);
  await evaluate("mediaPreview.state.returnStatus='Opened project.';mediaPreview.state.notify()");
  assert.equal(await evaluate("document.querySelector('.workflow-context')"),null);
  assert.equal(await evaluate("document.querySelector('.home-view').textContent.includes('Opened project.')"),false);
  assert.match(await evaluate("document.querySelector('.home-view').textContent"), /VS Code.*GitHub/);
  assert.equal(await evaluate("document.querySelector('[data-section=usage]').hidden"),false);
  assert.equal(await evaluate("document.querySelector('.home-view').scrollWidth<=document.querySelector('.home-view').clientWidth"), true);
  await capture('mimo-workflow-home-dark');
  await evaluate("mediaPreview.open('activity')"); await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"), 'overview');
  await pointerClick('[data-section=usage]'); await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"), 'usage');
  assert.equal(await evaluate("document.querySelector('[data-section=usage]').getAttribute('aria-current')"), 'page');
  await pointerClick('.usage-back'); await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"), 'overview');
  await pointerClick('[data-section=prompt]'); await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"), 'prompt');
  await evaluate("mediaPreview.state.chatDraft='Keep this draft';mediaPreview.open('overview');mediaPreview.open('prompt')"); await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.chatDraft"), 'Keep this draft');
  for (const scale of [1,2]) {
    await command('Emulation.setDeviceMetricsOverride', {width:1000,height:750,deviceScaleFactor:scale,mobile:false});
    await evaluate("mediaPreview.open('overview')"); await evaluate(settled);
    await capture('mimo-workflow-home-dpi-'+scale);
    assert.equal(await evaluate("document.querySelector('.home-view').scrollWidth<=document.querySelector('.home-view').clientWidth"), true);
  }
  await command('Emulation.clearDeviceMetricsOverride');
  assert.deepEqual(browserErrors, []);
});

test("Mimo panels Usage keeps compact limits, switches accounts, and recovers from refresh failure", async (t) => {
  t.after(clearPanelFixture); await panelFixture();
  await evaluate("mediaPreview.open('usage')"); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.agent-usage').firstElementChild.className"), "agent-usage-heading");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.agent-usage-track')].map(el=>el.getAttribute('aria-valuenow'))"), ["100", "44"]);
  assert.doesNotMatch(await evaluate("document.querySelector('.usage-summary').textContent"), /Observed today|Account total/);
  assert.equal(await evaluate("document.querySelector('.agent-usage .usage-guide')"), null);
  await capture("mimo-usage-dark");
  assert.equal(await evaluate("document.querySelectorAll('.agent-usage .calendar-cell').length"), 0);
  assert.ok(await evaluate("document.querySelector('#island').getBoundingClientRect().height<360"));
  await evaluate("window.panelRetainedLimits=document.querySelector('.agent-usage-track');mediaPreview.state.notify()");
  assert.equal(await evaluate("panelRetainedLimits===document.querySelector('.agent-usage-track')"), true);
  await pointerClick(".usage-agent-select"); await pointerClick('.agent-usage-actions [data-device="claude"]'); await evaluate(settled);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.agent-usage-track')].map(el=>el.getAttribute('aria-valuenow'))"), ["80", "55"]);
  assert.match(await evaluate("document.querySelector('.agent-usage-stats').textContent"), /28% context/);
  await pointerClick(".usage-agent-select"); await pointerClick('.agent-usage-actions [data-device="codex"]'); await evaluate(settled);
  await evaluate("mediaPreview.preferences({appearance:'glass'})"); await evaluate(settled); await capture("mimo-usage-glass");
  await evaluate("(async()=>{const {Bridge}=await import('/src/core/bridge.ts');Bridge.codexUsage=async()=>{throw new Error('offline')}})()");
  await pointerClick(".agent-usage-refresh"); await evaluate(settled);
  assert.match(await evaluate("document.querySelector('.agent-usage-status').textContent"), /last reading/);
  assert.equal(await evaluate("document.querySelector('.agent-usage-refresh').disabled"), false);
  assert.deepEqual(browserErrors, []);
});

test("Limits reference shows reported reset credits and shares colored capacity across accounts", async (t) => {
  t.after(clearPanelFixture); await panelFixture();
  await evaluate(`(async()=>{const {Activity}=await import('/src/core/activity.ts');
    const latest=Activity.latest('codex');Activity.observeUsage('codex',{...latest,checkedAt:latest.checkedAt+1,
      primary:{...latest.primary,usedPercent:85},resetCredits:{availableCount:1,nextExpiresAt:1900000000}});
    mediaPreview.state.notify();})()`);
  await evaluate(settled);
  const home=await evaluate("[...document.querySelectorAll('.header-capacity-window')].map(el=>({state:el.dataset.capacity,text:el.textContent,color:getComputedStyle(el.querySelector('b')).color}))");
  assert.deepEqual(home.map(window=>window.state),['low']);
  assert.match(home[0].text,/15%/);
  await pointerClick('[data-section=usage]');await evaluate(settled);
  assert.match(await evaluate("document.querySelector('.usage-reset-credits').textContent"),/Resets1 available.*until/);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.agent-usage-window')].map(el=>el.dataset.capacity)"),['low','available']);
  await capture('mimo-limits-reference-credits-dark');
  await evaluate(`(async()=>{const {Activity}=await import('/src/core/activity.ts');const latest=Activity.latest('codex');
    Activity.observeUsage('codex',{...latest,checkedAt:latest.checkedAt+1,resetCredits:{availableCount:0,nextExpiresAt:null}});})()`);
  assert.match(await evaluate("document.querySelector('.usage-reset-credits').textContent"),/None available/);
  await pointerClick('.usage-agent-select');await pointerClick('.audio-device-menu:popover-open [data-device=claude]');await evaluate(settled);
  assert.match(await evaluate("document.querySelector('.usage-reset-credits').textContent"),/Not shared/);
  await pointerClick('.usage-back');await evaluate(settled);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.header-capacity-window b')].map(el=>el.textContent)"),['80%']);
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.header-capacity-window b')).color"),home[0].color);
  await pointerClick('.header-agent-select');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End'});
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.usageProvider"),'codex');
  assert.equal(await evaluate("mediaPreview.state.view"),'overview');
  await capture('mimo-home-capacity-colors-dark');
  await evaluate("mediaPreview.preferences({appearance:'glass'});mediaPreview.open('usage')");await evaluate(settled);
  await capture('mimo-limits-reference-credits-glass');
});

test("Home capacity sits beside Settings, opens Limits and shares its off switch", async (t) => {
  t.after(clearPanelFixture); await panelFixture();
  const header = await evaluate(`(()=>{const button=document.querySelector('[data-section=usage]');
    const settings=document.querySelector('#header [aria-label=Settings]');
    return {exists:!!button,beside:button?.nextElementSibling===settings,text:button?.textContent,
      duplicate:[...document.querySelectorAll('.home-footer button')].some(b=>b.textContent==='Limits'),
      agentIcon:!!button?.querySelector('svg'),
      meters:button.querySelectorAll('[role=progressbar]').length,
      agentDot:!!document.querySelector('.header-account .audio-device-dot')};})()`);
  assert.equal(header.exists, true); assert.equal(header.beside, true);
  assert.match(header.text, /100%/); assert.doesNotMatch(header.text, /44%/); assert.equal(header.duplicate, false);
  assert.doesNotMatch(header.text, /5 hr/,'Home omits the visible five-hour label');
  assert.match(await evaluate("document.querySelector('[data-section=usage]').getAttribute('aria-label')"),/5[- ]hour|5 hr|5h/i);
  assert.equal(header.agentIcon,false);
  assert.equal(header.meters,0);assert.equal(header.agentDot,true);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.header-capacity-window'),'::after').content"),'none');
  await pointerClick('[data-section=usage]'); await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"), "usage");
  assert.equal(await evaluate("document.querySelector('[data-section=usage]').getAttribute('aria-current')"), "page");
  assert.equal(await evaluate("document.querySelector('[data-section=overview]').hasAttribute('aria-current')"), false);
  assert.equal(await evaluate("document.querySelector('.header-capacity').hidden"),false,'Capacity stays visible beside Settings in detail views');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.header-capacity-window b')].map(el=>el.textContent)"),['100%']);
  assert.equal(await evaluate("document.querySelector('.usage-window-pace')"),null);
  assert.equal(await evaluate("!!document.querySelector('.agent-usage-heading .agent-usage-status')"),true);
  assert.equal(await evaluate("document.querySelector('.usage-footer')"),null);
  assert.equal(await evaluate("!!document.querySelector('.agent-usage-heading .usage-summary')"),true);
  const resets=await evaluate("[...document.querySelectorAll('.agent-usage-reset time')].map(el=>({text:el.textContent,datetime:el.dateTime}))");
  assert.equal(resets.length, 2);
  assert.ok(resets.every(reset=>reset.text.startsWith('Resets ') && !Number.isNaN(Date.parse(reset.datetime))));
  assert.ok(await evaluate("[...document.querySelectorAll('.usage-reset-availability')].every(el=>el.textContent.startsWith('In '))"));
  await evaluate("mediaPreview.preferences({usageEnabled:false})"); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('[data-section=usage]').hidden"), true);
  assert.equal(await evaluate("document.querySelector('.agent-usage')"), null);
});

test("VS Code Mimo gets annoyed, gives a friendly three-second confused pause, and protects approvals", async (t) => {
  t.after(clearPanelFixture); await panelFixture();
  await selectIntegration('integration_claude');
  await evaluate("mediaPreview.state.updateTask('integration_claude','working');mediaPreview.state.notify()");
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('#pat-mimo').disabled"), false);
  await evaluate("window.workTap=[];window.confusedStarted=0;document.querySelector('#pat-mimo').addEventListener('click',()=>{if(mediaPreview.state.view==='confused')confusedStarted=performance.now();setTimeout(()=>workTap.push(mediaPreview.island.engine.ox),70)})");
  await pointerClick('#pat-mimo'); await evaluate("new Promise(resolve=>setTimeout(resolve,100))");
  assert.ok(await evaluate("workTap.some(x=>Math.abs(x)>.07)"));
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"), "annoyed");
  await pointerClick('#pat-mimo');await pointerClick('#pat-mimo');
  assert.equal(await evaluate("mediaPreview.state.view"),'confused');
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  assert.match(await evaluate("document.querySelector('.view.on').textContent"),/Wait, where were we\?/);
  assert.match(await evaluate("document.querySelector('.view.on').textContent"),/One tiny breather/);
  assert.equal(await evaluate("document.querySelector('[data-section=usage]').hidden"),false);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#header')).opacity"),'1');
  await evaluate("new Promise(resolve=>setTimeout(resolve,Math.max(0,confusedStarted+2700-performance.now())))");
  assert.equal(await evaluate("mediaPreview.state.view"),'confused');
  await evaluate("new Promise(resolve=>setTimeout(resolve,Math.max(0,confusedStarted+3150-performance.now())))");
  assert.equal(await evaluate("mediaPreview.state.view"),'overview');
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"),'working');
  await evaluate("mediaPreview.state.updateTask('integration_claude','approval');mediaPreview.state.notify()");
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('#pat-mimo').disabled"), true);
});

test("Mimo panels GitHub expands to the entire shell and preserves filtering, focus, and CI truth", async (t) => {
  t.after(clearPanelFixture); await panelFixture();
  await evaluate("mediaPreview.open('integrations')"); await evaluate(settled); await selectIntegration("integration_github");
  assert.match(await evaluate("document.querySelector('.github-summary').textContent"), /My PRs3To review2Default branch CIAll green/);
  assert.equal(await evaluate("document.querySelectorAll('.github-card .calendar-cell').length"), 0);
  await capture("mimo-github-compact-dark");
  await pointerClick(".github-mini-calendar");
  assert.equal(await evaluate("document.querySelector('.github-card').dataset.githubView"), "activity");
  await capture("mimo-github-activity-dark");
  await pointerClick('.github-preview [aria-label="Expand GitHub activity"]'); await evaluate(settled);
  const full = await evaluate("(()=>{const root=document.querySelector('.github-full'),r=root.getBoundingClientRect(),outer=document.querySelector('#island').getBoundingClientRect();return {height:outer.height,width:r.width,rows:root.querySelectorAll('.github-row').length,picker:!!document.querySelector('.module-layout.on .module-developer'),scroll:root.scrollWidth>root.clientWidth}})()");
  assert.equal(Math.round(full.height), 432); assert.ok(full.width > 580); assert.equal(full.rows, 3); assert.equal(full.picker, false); assert.equal(full.scroll, false);
  assert.equal(await evaluate("document.querySelectorAll('.github-full .calendar-cell').length"), 0);
  assert.equal(await evaluate("document.activeElement.className"), "github-back");
  await capture("mimo-github-full-dark");
  await pointerClick('.github-tabs [data-category="reviews"]');
  assert.equal(await evaluate("document.querySelectorAll('.github-full .github-row').length"), 2);
  await pointerClick('.github-tabs [data-category="pullRequests"]');
  await evaluate("document.querySelector('.github-search').value='calendar';document.querySelector('.github-search').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.github-search').focus()");
  assert.equal(await evaluate("document.querySelectorAll('.github-full .github-row').length"), 1);
  await evaluate("mediaPreview.state.integrations.integration_github.data.totalStars++;mediaPreview.state.notify()"); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.github-search').value"), "calendar");
  assert.equal(await evaluate("document.activeElement.className"), "github-search");
  await pointerClick(".github-row-link");
  assert.ok(await evaluate("panelLinks.includes('https://github.com/mimo/core/pull/41')"));
  await evaluate("document.querySelector('.github-search').value='';document.querySelector('.github-search').dispatchEvent(new Event('input',{bubbles:true}));mediaPreview.preferences({appearance:'glass'})"); await evaluate(settled); await capture("mimo-github-full-glass");
  await evaluate("(async()=>{const {Bridge}=await import('/src/core/bridge.ts');Bridge.refreshIntegration=async()=>{mediaPreview.state.integrations.integration_github.data.checks[1].state='unknown';mediaPreview.state.notify()}})()");
  await pointerClick('[aria-label="Refresh GitHub"]'); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Refresh GitHub\"]').disabled"), false);
  assert.match(await evaluate("document.querySelector('.github-ci-summary').textContent"), /Not shared/);
  await pointerClick('.github-tabs [data-category="checks"]');
  assert.match(await evaluate("document.querySelector('.github-rows').textContent"), /Not shared/);
  await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  assert.equal(await evaluate("document.querySelector('.github-full').getAnimations({subtree:true}).length"), 0);
  await command("Emulation.setEmulatedMedia", { features: [] });
  await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" }); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.github-full')===null"), true);
  assert.ok(await evaluate("panelSounds.includes('close')"));
  assert.deepEqual(browserErrors, []);
});

test("Mimo panels unavailable data stays honest and disabled destinations stay quiet", async (t) => {
  t.after(clearPanelFixture); await panelFixture();
  await evaluate(`(async()=>{const {Activity}=await import('/src/core/activity.ts');Activity.observeUsage('codex',{plan:null,primary:null,secondary:null,lifetimeTokens:null,checkedAt:Date.now()/1000});const {Bridge}=await import('/src/core/bridge.ts');Bridge.codexUsage=async()=>Activity.latest('codex');mediaPreview.open('usage')})()`);
  await evaluate(settled);
  assert.ok(await evaluate("[...document.querySelectorAll('.agent-usage-track')].every(el=>!el.hasAttribute('aria-valuenow'))"));
  assert.match(await evaluate("document.querySelector('.agent-usage-windows').textContent"), /Not shared by this account/);
  await capture("mimo-usage-unavailable-dark");
  await evaluate("mediaPreview.open('integrations')"); await evaluate(settled); await selectIntegration("integration_github");
  await evaluate("mediaPreview.state.integrations.integration_github.data={login:'mimo-dev',totalRepos:0,totalStars:0,openPullRequests:0,reviewCount:0,contributions:[],checks:[],pullRequests:[],reviews:[],issues:[],repositories:[],activity:[],warnings:['Contribution calendar: check token permissions']};mediaPreview.state.notify()"); await evaluate(settled);
  assert.match(await evaluate("document.querySelector('.github-summary').textContent"), /Not shared/);
  await pointerClick('.github-summary .github-expand'); await evaluate(settled);
  assert.match(await evaluate("document.querySelector('.github-full').textContent"), /Some data isn't available/);
  assert.equal(await evaluate("document.querySelectorAll('.github-full .calendar-cell').length"), 0);
  await capture("mimo-github-unavailable-dark");
  await evaluate("mediaPreview.preferences({usageEnabled:false,modules:{vscode:false}});mediaPreview.open('overview')"); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.home-activity-widget')"), null);
  assert.equal(await evaluate("document.querySelector('.agent-usage-view.on')"), null);
  assert.equal(await evaluate("document.querySelector('[data-section=usage]').hidden"), true);
  assert.deepEqual(browserErrors, []);
});

test("none removes the player and shows a useful Media empty state", async () => {
  await scene("none");
  const state = await inspect();
  assert.equal(state.rowVisible, false);
  assert.equal(state.ambientVisible, false);
  assert.equal(Math.round(state.height), 52 + MEDIA_EMPTY_CARD_HEIGHT);
  await capture("none");
});

test("playing shows a stable media row with title, artist, and accurate status", async () => {
  await scene("playing");
  const state = await inspect();
  assert.equal(state.rowVisible, true);
  assert.equal(state.title, "Night Drive");
  assert.equal(state.artist, "The Midnight");
  assert.equal(state.status, "Playing");
  assert.equal(state.quiet, false);
  await evaluate(
    "window.savedMediaRow = document.querySelector('.media-row'); window.savedIsland = document.querySelector('#island')",
  );
  await capture("playing");
});

test("pause and resume retain metadata without remounting the island or media row", async () => {
  await scene("paused");
  const state = await inspect();
  assert.equal(state.rowVisible, true);
  assert.equal(state.title, "Night Drive");
  assert.equal(state.artist, "The Midnight");
  assert.equal(state.status, "Paused");
  assert.equal(state.quiet, true);
  assert.equal(
    await evaluate(
      "savedMediaRow === document.querySelector('.media-row') && savedIsland === document.querySelector('#island')",
    ),
    true,
  );
  await capture("paused");
  await scene("playing");
  assert.equal((await inspect()).status, "Playing");
});

test("compact music keeps the clock and artwork, and paused playback exposes controls", async () => {
  await scene("playing", "Night Drive", "The Midnight", "compact");
  const state = await inspect();
  assert.equal(state.ambientVisible, false);
  assert.equal(state.rowVisible, false);
  assert.equal(Math.round(state.height), 40);
  assert.equal(await evaluate("document.querySelector('.activity-strip').dataset.kind"), "music");
  await capture("compact");
  await scene("paused", "Night Drive", "The Midnight", "compact");
  assert.equal((await inspect()).ambientVisible, true);
  assert.equal(
    await evaluate(
      "document.querySelector('.media-ambient-primary').getAttribute('aria-label')",
    ),
    "Play",
  );
  assert.equal(Math.round((await inspect()).height), 40);
});

test("long titles and artists truncate inside the island at normal and high DPI", async () => {
  const title = "A very long track title — ".repeat(25);
  const artist = "A very long artist name & collaborators ".repeat(25);
  for (const scale of [1, 1.25, 1.5, 2]) {
    await command("Emulation.setDeviceMetricsOverride", {
      width: 720,
      height: PANEL_H,
      deviceScaleFactor: scale,
      mobile: false,
    });
    // Mascot canvases allocate at construction. Test startup at each Windows
    // scale, rather than changing DPR underneath the immutable mascot engine.
    await loadPage("Page.reload");
    await evaluate("new Promise(resolve => setTimeout(resolve, 1200))");
    for (const mode of ["expanded", "compact"]) {
      await scene("playing", title, artist, mode);
      if (mode === "compact") {
        await command("Input.dispatchMouseEvent", {type:"mouseMoved",x:360,y:20});
        await evaluate(settled);
      }
      await evaluate("document.fonts.ready.then(() => true)");
      const state = await inspect();
      assert.ok(state.bounds.every((bound) => bound.inside));
      assert.deepEqual(state.titleStyle, {
        overflow: "hidden",
        ellipsis: "ellipsis",
        wrap: "nowrap",
      });
      assert.equal(
        await evaluate(
          "getComputedStyle(document.querySelector('.media-artist')).textOverflow",
        ),
        "ellipsis",
      );
      await capture(`long-${mode}-${scale}x`);
      if (mode === "compact") {
        assert.equal(
          await evaluate("document.fonts.check('450 12px \"Inter Variable\"')"),
          true,
        );
        assert.equal(
          await evaluate(
            "getComputedStyle(document.querySelector('.media-ambient-title')).fontWeight",
          ),
          "650",
        );
        assert.equal(
          await evaluate(
            "getComputedStyle(document.querySelector('.media-ambient-artist')).fontSize",
          ),
          "11px",
        );
        await command("DOM.enable");
        await command("CSS.enable");
        const { root } = await command("DOM.getDocument");
        const { nodeId } = await command("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: ".media-ambient-title",
        });
        const { fonts } = await command("CSS.getPlatformFontsForNode", {
          nodeId,
        });
        assert.ok(
          fonts.some(
            (font) =>
              font.isCustomFont &&
              /Inter/.test(font.familyName) &&
              font.glyphCount > 0,
          ),
        );
        await scene("playing", "Balisong", "Rivermaya", "compact");
        await capture(`compact-type-${scale}x`);
      }
    }
  }
  await command("Emulation.setDeviceMetricsOverride", {
    width: 720,
    height: PANEL_H,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await loadPage("Page.reload");
  await evaluate("new Promise(resolve => setTimeout(resolve, 1200))");
});

test("missing metadata has an honest title fallback and no empty artist line", async () => {
  await scene("playing", null, "Artist only");
  assert.equal((await inspect()).title, "Title unavailable");
  assert.equal((await inspect()).artist, "Artist only");
  await scene("playing", "Track only", null);
  assert.equal((await inspect()).title, "Track only");
  assert.equal((await inspect()).artistHidden, true);
  await scene("playing", null, null);
  assert.equal((await inspect()).title, "Title unavailable");
  await capture("missing");
});

test("unknown and other Windows states never imply playing or paused", async () => {
  for (const playback of [
    "unknown",
    "opened",
    "changing",
    "stopped",
    "closed",
  ]) {
    await scene(playback);
    assert.equal((await inspect()).rowVisible, true);
    assert.equal((await inspect()).status, "");
    await scene(playback, "Night Drive", "The Midnight", "compact");
    assert.equal((await inspect()).ambientVisible, false);
  }
  await scene("unknown", null, null);
  assert.equal((await inspect()).rowVisible, false);
});

test("duplicate revisions and unused album changes produce no media DOM mutations", async () => {
  await scene("playing");
  await evaluate(
    `window.mediaMutations = []; window.mediaObserver = new MutationObserver(records => mediaMutations.push(...records)); mediaObserver.observe(document.querySelector('.media-row'), { attributes: true, childList: true, subtree: true, characterData: true }); var snapshot = mediaPreview.store.snapshot(); mediaPreview.store.apply({ ...snapshot, state: { ...snapshot.state, title: 'Stale' } });`,
  );
  await evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
  assert.equal(await evaluate("mediaMutations.length"), 0);
  await evaluate(
    "var snapshot = mediaPreview.store.snapshot(); mediaPreview.store.apply({ revision: snapshot.revision + 1, player: snapshot.player, state: { ...snapshot.state, albumTitle: 'Album-only change' } })",
  );
  await evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
  assert.equal(await evaluate("mediaMutations.length"), 0);
  await evaluate("mediaObserver.disconnect()");
});

test("media appearance does not resize the separate integration cards", async () => {
  await scene("none");
  const heights = await evaluate(`(async () => {
    const views = document.querySelector('[data-module="vscode"]');
    const before = views.getBoundingClientRect().height;
    mediaPreview.publish('playing');
    const heights = [before];
    for (let i = 0; i < 40; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      heights.push(views.getBoundingClientRect().height);
    }
    return heights;
  })()`);
  assert.ok(heights.every((height) => Math.abs(height - heights[0]) < 0.2));
});

test("media updates while hidden do not wake the island frame loop", async () => {
  await evaluate("mediaPreview.hide()");
  await evaluate(settled);
  const wakeups = await evaluate(`(async () => {
    const ensure = mediaPreview.island.ensureRunning;
    let wakeups = 0;
    mediaPreview.island.ensureRunning = function () { wakeups++; return ensure.call(this); };
    mediaPreview.publish('playing', 'Hidden update', 'Artist');
    await new Promise(resolve => setTimeout(resolve, 30));
    mediaPreview.island.ensureRunning = ensure;
    return wakeups;
  })()`);
  assert.equal(wakeups, 0);
});

test("session disappearance clears metadata and animates back to the baseline size", async () => {
  await scene("playing");
  await scene("none");
  const state = await inspect();
  assert.equal(state.rowVisible, false);
  assert.equal(state.ambientVisible, false);
  assert.equal(state.title, "");
  assert.equal(state.artist, "");
  assert.equal(Math.round(state.height), 52 + MEDIA_EMPTY_CARD_HEIGHT);
});

test("tall chat stays inside the native panel and media respects reduced motion", async () => {
  await scene("playing");
  await evaluate(
    "mediaPreview.state.chatHistory = Array.from({ length: 4 }, (_, id) => ({ id, role: 'user', content: 'Hello' })); mediaPreview.open('prompt')",
  );
  await evaluate(settled);
  assert.ok((await inspect()).height <= 384.1);
  assert.equal(
    await evaluate("document.querySelectorAll('.media-row.is-visible').length"),
    0,
  );
  await evaluate("mediaPreview.open('media')");
  await evaluate(settled);
  assert.ok((await inspect()).bounds.every((bound) => bound.inside));
  await command("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.media-row')).transitionDuration",
    ),
    "0s",
  );
  await capture("chat");
});

test("artwork appears when available and missing or broken images use the fallback", async () => {
  await scene("playing");
  assert.equal((await inspect()).artVisible, false);
  await evaluate(
    "mediaPreview.publish('playing', 'Night Drive', 'The Midnight', { artwork: { dataUrl: mediaPreview.artwork } })",
  );
  await evaluate(settled);
  assert.equal((await inspect()).artVisible, true);
  assert.equal(
    await evaluate("document.querySelector('.media-image').naturalWidth"),
    128,
  );
  await capture("artwork");
  await evaluate(
    "mediaPreview.publish('playing', 'Night Drive', 'The Midnight', { artwork: { dataUrl: 'data:image/png;base64,invalid' } })",
  );
  await evaluate(settled);
  assert.equal((await inspect()).artVisible, false);
});

test("50 browser track changes retire artwork without replacing the media containers", async () => {
  await scene("playing");
  const result = await evaluate(`(async () => {
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    const live = new Set(); let created = 0, max = 0;
    const row = document.querySelector('.media-row');
    const image = document.querySelector('.media-image');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    URL.createObjectURL = blob => { const url = create(blob); live.add(url); created++; max = Math.max(max, live.size); return url; };
    URL.revokeObjectURL = url => { live.delete(url); revoke(url); };
    try {
      let sameBytes = false;
      for (let i = 0; i < 50; i++) {
        ctx.fillStyle = 'hsl(' + (i * 7) + ' 65% 45%)'; ctx.fillRect(0, 0, 128, 128);
        const dataUrl = canvas.toDataURL('image/png');
        mediaPreview.publish('playing', 'Track ' + i, 'Artist', { artwork: { dataUrl } });
        await image.decode();
        const url = image.getAttribute('src');
        if (i === 49) sameBytes = dataUrl === await new Promise(resolve => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result);
          fetch(url).then(response => response.blob()).then(blob => reader.readAsDataURL(blob));
        });
        mediaPreview.publish('playing', 'Track ' + i, 'Artist', { artwork: { dataUrl } });
        if (image.getAttribute('src') !== url) throw new Error('Identical artwork reloaded');
      }
      const allShared = [...document.querySelectorAll('.media-image, .media-ambient-image')]
        .every(element => element.getAttribute('src') === mediaPreview.store.snapshot().player.artwork.dataUrl);
      mediaPreview.publish('none');
      return { created, max, live: live.size, sameBytes, allShared,
        rowReused: row === mediaPreview.island.media.rowEl, imageReused: image === mediaPreview.island.media.image,
        cleared: !image.hasAttribute('src') };
    } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
  })()`);
  assert.deepEqual(result, { created: 50, max: 2, live: 0, sameBytes: true, allShared: true, rowReused: true, imageReused: true, cleared: true });
});

test("input and confirmations keep one media clock; hiding or destroying cancels it", async (t) => {
  t.after(() => loadPage("Page.reload"));
  await loadPage("Page.reload");
  await scene("paused");
  const result = await evaluate(`(async () => {
    const after = window.setTimeout.bind(window), cancel = window.clearTimeout.bind(window);
    const clocks = new Set();
    window.setTimeout = (callback, delay, ...args) => {
      if (delay !== 1000) return after(callback, delay, ...args);
      const id = after(() => { clocks.delete(id); callback(...args); }, delay); clocks.add(id); return id;
    };
    window.clearTimeout = id => { clocks.delete(id); cancel(id); };
    try {
      mediaPreview.publish('playing', 'Track', 'Artist', { controls: { play:true, pause:true, next:true, previous:true, seek:true },
        timeline: { positionMs: 1000, durationMs:300000, updatedAtUnixMs:Date.now(), playbackRateMilli:1000 } });
      for (let i = 0; i < 8; i++) document.querySelector('.media-seek').dispatchEvent(new Event('blur'));
      const visible = clocks.size;
      mediaPreview.hide();
      await new Promise(resolve => after(resolve, 900));
      const hidden = clocks.size;
      mediaPreview.open('media');
      await new Promise(resolve => after(resolve, 900));
      const resumed = clocks.size;
      mediaPreview.island.destroy();
      return { visible, hidden, resumed, destroyed: clocks.size };
    } finally { window.setTimeout = after; window.clearTimeout = cancel; }
  })()`);
  assert.deepEqual(result, { visible: 1, hidden: 0, resumed: 1, destroyed: 0 });
});

test("hidden and paused waveforms release peak subscribers and resume on visibility", async (t) => {
  t.after(() => loadPage("Page.reload"));
  await loadPage("Page.reload");
  await scene("playing", "Track", "Artist", "compact");
  const result = await evaluate(`(() => {
    const demand = []; const stop = mediaPreview.levels.onDemand(active => demand.push(active));
    const initial = mediaPreview.levels.listeners.size;
    for (let i = 0; i < 20; i++) {
      mediaPreview.island.media.sync('expanded', 'media', true, 'hover');
      mediaPreview.island.media.sync('peek', 'media');
    }
    // Restore the active presentation before exercising the document lifecycle.
    mediaPreview.island.media.sync('expanded', 'media', true, 'hover');
    mediaPreview.island.activity.sync();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const hidden = mediaPreview.levels.listeners.size;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    const restored = mediaPreview.levels.listeners.size;
    mediaPreview.publish('paused');
    const paused = mediaPreview.levels.listeners.size;
    delete document.hidden; stop();
    return { initial, hidden, restored, paused, activated: demand.includes(true), deactivated: demand.includes(false) };
  })()`);
  assert.equal(result.initial, 1);
  assert.equal(result.hidden, 0);
  assert.ok(result.restored >= 1 && result.restored <= 2);
  assert.equal(result.paused, 0);
  assert.ok(result.activated && result.deactivated);
});

test("paused compact Play stays circular at every supported Windows scale", async (t) => {
  t.after(async () => { await command("Emulation.clearDeviceMetricsOverride"); await loadPage("Page.reload"); });
  await scene("paused", "Track", "Artist", "compact");
  for (const scale of [1, 1.25, 1.5, 2, 3, 4]) {
    await command("Emulation.setDeviceMetricsOverride", { width: 720, height: 432, deviceScaleFactor: scale, mobile: false });
    const circle = await evaluate(`(() => {
      const button = document.querySelector('.media-ambient-primary');
      const rect = button.getBoundingClientRect(), style = getComputedStyle(button);
      return { width: rect.width, height: rect.height, radius: style.borderRadius, action: button.dataset.action };
    })()`);
    assert.ok(Math.abs(circle.width - circle.height) < 0.1, `Play must be square at ${scale}x: ${circle.width} × ${circle.height}`);
    assert.equal(circle.radius, "50%");
    assert.equal(circle.action, "play");
  }
  await command("Emulation.clearDeviceMetricsOverride");
});

test("supported controls render and the primary button follows native playback state", async () => {
  await scene("playing");
  assert.deepEqual((await inspect()).controls, [
    { label: "Previous track", disabled: false },
    { label: "Pause", disabled: false },
    { label: "Next track", disabled: false },
  ]);
  await evaluate(
    "mediaPreview.actions.length = 0; document.querySelector('.media-primary').click()",
  );
  await evaluate(settled);
  assert.equal((await inspect()).controls[1].label, "Play");
  assert.equal((await inspect()).title, "Night Drive");
  assert.equal(await evaluate("mediaPreview.actions.at(-1)"), "pause");
  await evaluate("document.querySelector('.media-primary').click()");
  await evaluate(settled);
  assert.equal((await inspect()).controls[1].label, "Pause");
  await evaluate(
    "document.querySelector('[aria-label=\"Next track\"]').click()",
  );
  await evaluate(settled);
  assert.equal((await inspect()).title, "Next track");
  await evaluate(
    "document.querySelector('[aria-label=\"Previous track\"]').click()",
  );
  await evaluate(settled);
  assert.equal((await inspect()).title, "Previous track");
});

test("unsupported actions are disabled and unknown playback cannot imply resume", async () => {
  await scene("playing");
  await evaluate(
    "mediaPreview.publish('playing', 'Track', 'Artist', { controls: { previous: false, next: false, play: false, pause: false } })",
  );
  assert.ok((await inspect()).controls.every((button) => button.disabled));
  await scene("unknown");
  assert.ok((await inspect()).controls.every((button) => button.disabled));
  assert.equal((await inspect()).controls[1].label, "Playback unavailable");
  await scene("none");
  assert.ok((await inspect()).controls.every((button) => button.disabled));
});

test("failed controls leave playback unchanged and allow a graceful retry", async () => {
  await scene("playing");
  await evaluate(
    "mediaPreview.controlError = true; document.querySelector('.media-primary').click()",
  );
  await evaluate(settled);
  assert.equal((await inspect()).controls[1].label, "Pause");
  assert.equal((await inspect()).controls[1].disabled, false);
  assert.equal((await inspect()).status, "Try again");
  await evaluate("mediaPreview.controlError = false");
});

test("direct hover expands, leaving compacts, and sleep hover opens the full tool", async () => {
  await scene("playing");
  await evaluate(
    "mediaPreview.preferences({peekEnabled:false});mediaPreview.island.visibility.pointerEntered();mediaPreview.island.visibility.pointerLeft()",
  );
  assert.equal(await evaluate("mediaPreview.state.visibility"), "island");
  await evaluate(settled);
  assert.equal(
    await evaluate("document.querySelector('#island').dataset.compact"),
    "true",
  );
  assert.equal(
    await evaluate("document.querySelector('[aria-label*=Minimize]')"),
    null,
  );
  await evaluate("mediaPreview.island.visibility.pointerEntered()");
  assert.equal(await evaluate("mediaPreview.state.visibility"), "expanded");
  await evaluate(
    "mediaPreview.preferences({peekEnabled:true});mediaPreview.island.visibility.pointerLeft()",
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,1400))");
  assert.equal(await evaluate("mediaPreview.state.visibility"), "peek");
  await evaluate(
    "document.querySelector('#restore-island').dispatchEvent(new PointerEvent('pointerenter',{clientX:360,clientY:8}))",
  );
  assert.equal(await evaluate("mediaPreview.state.visibility"), "peek");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.visibility"), "expanded");
  assert.equal(await evaluate("document.querySelector('#island').dataset.core"), "app");
  assert.equal(await evaluate("mediaPreview.state.view"), "media");
  await evaluate(
    "mediaPreview.preferences({autoCloseInterval:120,peekEnabled:false});mediaPreview.open('media')",
  );
});
test("hover never requests native focus, including the first frame of a peek wake", async (t) => {
  await evaluate(`(async()=>{
    const {Bridge}=await import('/src/core/bridge.ts');
    window.savedHoverFocus=Bridge.focusWindow;
    window.hoverFocusRequests=[];
    Bridge.focusWindow=focused=>{window.hoverFocusRequests.push(focused);return Promise.resolve()};
  })()`);
  t.after(async () => {
    await evaluate(`(async()=>{
      const {Bridge}=await import('/src/core/bridge.ts');
      Bridge.focusWindow=window.savedHoverFocus;
      delete window.savedHoverFocus;delete window.hoverFocusRequests;
      mediaPreview.preferences({peekEnabled:false});mediaPreview.open('media');
    })()`);
  });
  for (const mode of ['compact','peek']) {
    await scene(mode==='peek'?'playing':'none');
    await evaluate(`mediaPreview.preferences({peekEnabled:${mode==='peek'}});
      mediaPreview.open('media');mediaPreview.${mode==='peek'?'hide':'compact'}()`);
    await evaluate(settled);
    await evaluate(`window.hoverFocusRequests.length=0;mediaPreview.island.onCursor(360,2)`);
    await evaluate(settled);
    assert.equal(await evaluate('mediaPreview.state.visibility'),'expanded',mode);
    assert.deepEqual(await evaluate('window.hoverFocusRequests.filter(Boolean)'),[],
      `${mode} hover must keep the app underneath focused throughout the transition`);
    await evaluate('mediaPreview.island.onCursor(0,383)');
    await evaluate(settled);
  }
  await evaluate(`window.hoverFocusRequests.length=0;mediaPreview.open('media')`);
  await evaluate(settled);
  assert.ok(await evaluate('window.hoverFocusRequests.includes(true)'),
    'Explicit Media navigation still enables keyboard controls');
});

test("Settings opens only by explicit navigation and never returns as a hover view", async (t) => {
  await scene("none");
  await evaluate("mediaPreview.preferences({workingModeEnabled:false})");
  await evaluate(`(async()=>{const {Bridge}=await import('/src/core/bridge.ts');
    window.oldSettingsOpen=Bridge.openSettingsWindow;window.settingsOpenCalls=0;
    Bridge.openSettingsWindow=()=>{window.settingsOpenCalls++;return Promise.resolve(null)};})()`);
  t.after(async () => {
    await evaluate("(async()=>{const {Bridge}=await import('/src/core/bridge.ts');Bridge.openSettingsWindow=window.oldSettingsOpen;mediaPreview.open('media')})()");
  });
  for (const navigate of ["mediaPreview.island.open('settings')", "mediaPreview.island.setView('settings')"]) {
    await evaluate(navigate);
    assert.equal(await evaluate("mediaPreview.state.view"), "media");
  }
  assert.equal(await evaluate("settingsOpenCalls"), 2);
  for (const peekEnabled of [false, true]) {
    await evaluate(`mediaPreview.preferences({peekEnabled:${peekEnabled}});mediaPreview.state.view='settings';
      mediaPreview.island.visibility.pointerLeft();mediaPreview.island.visibility.island()`);
    assert.equal(await evaluate("mediaPreview.state.view"), "overview");
    await evaluate("mediaPreview.island.visibility.pointerEntered()");
    await evaluate(settled);
    assert.equal(await evaluate("mediaPreview.state.visibility"), "expanded");
    assert.equal(await evaluate("mediaPreview.state.view"), "overview");
    assert.equal(await evaluate("settingsOpenCalls"), 2, "Hover must not open the native Settings window");
    assert.equal(await evaluate("[...document.querySelectorAll('#content .view')].some(el=>el.textContent.includes('Make Mimo yours.'))"), false);
  }
});
test("dedicated functions stay open until dismissed then return to hover collapse", async () => {
  await evaluate(
    "mediaPreview.preferences({autoCloseInterval:1,peekEnabled:true});mediaPreview.open('prompt');mediaPreview.island.visibility.pointerLeft()",
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,1300))");
  assert.equal(await evaluate("mediaPreview.state.visibility"), "expanded");
  assert.equal(await evaluate("mediaPreview.state.view"), "prompt");
  await evaluate(
    "mediaPreview.island.setView('overview');mediaPreview.island.visibility.pointerLeft()",
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,1400))");
  assert.equal(await evaluate("mediaPreview.state.visibility"), "peek");
  await evaluate(
    "mediaPreview.preferences({autoCloseInterval:120,peekEnabled:false});mediaPreview.open('media')",
  );
});
test("disabled modules reflow in Integrations and disabled destinations return to Home", async (t) => {
  t.after(()=>loadPage('Page.reload')); await loadPage('Page.reload');
  await evaluate(
    "mediaPreview.preferences({modules:{media:true,vscode:true,developerIntegrations:true},codingHooksInstalled:{claude:true},activeIntegrations:['integration_github']});mediaPreview.open('integrations')",
  );
  await evaluate(settled);
  const ids = () =>
    evaluate(
      "[...document.querySelectorAll('.home-workspace > [data-module]')].map(el=>el.dataset.module)",
    );
  assert.deepEqual(await ids(), ["vscode", "developerIntegrations"]);
  await evaluate("mediaPreview.preferences({modules:{vscode:false}})");
  await evaluate(settled);
  assert.deepEqual(await ids(), ["vscode", "developerIntegrations"]);
  assert.equal(await evaluate("document.querySelector('.module-activity').dataset.integration"),'integration_github','The shared workspace falls back to the enabled tool');
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('[data-module=developerIntegrations]')).gridColumnStart",
    ),
    "span 1",
  );
  assert.equal(await evaluate("mediaPreview.state.tasks.some(task=>task.id==='integration_claude')"),false);
  await capture("sections-integrations-only");
  await evaluate(
    "mediaPreview.preferences({modules:{developerIntegrations:false}})",
  );
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"), "overview");
  assert.equal(
    await evaluate(
      "document.querySelector('[data-section=integrations]')===null",
    ),
    true,
  );
  assert.deepEqual(await ids(), ["developerIntegrations"]);
  assert.equal(await evaluate("document.querySelectorAll('.integration-tile').length"),4);
  assert.equal(await evaluate("document.querySelectorAll('.integration-tile[data-integration]').length"),0,
    "Disabled services are absent; explicit Connect choices remain available");
  await capture("sections-media-only-home");
  await evaluate(
    "document.querySelector('[data-home-media]').click();mediaPreview.preferences({modules:{media:false}})",
  );
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"), "overview");
  assert.equal(
    await evaluate("document.querySelector('[data-home-media]').hidden"),
    true,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.media-summary') === null && document.querySelector('.media-row') === null && document.querySelector('.media-ambient') === null",
    ),
    true,
  );
  await capture("sections-all-disabled-home");
});

test("disabled media detaches rendering and reenable displays the latest player", async (t) => {
  t.after(() => loadPage("Page.reload"));
  await loadPage("Page.reload");
  await evaluate("mediaPreview.preferences({modules:{media:false}})");
  await evaluate(settled);
  const wakeups = await evaluate(`(async () => {
    const ensure=mediaPreview.island.ensureRunning;let count=0;
    mediaPreview.island.ensureRunning=function(){count++;return ensure.call(this);};
    mediaPreview.publish('playing','While disabled','Artist');await new Promise(resolve=>setTimeout(resolve,40));
    mediaPreview.island.ensureRunning=ensure;return count;
  })()`);
  assert.equal(wakeups, 0);
  await evaluate(
    "mediaPreview.preferences({modules:{media:true,vscode:true,developerIntegrations:true}});mediaPreview.open('media')",
  );
  await evaluate(settled);
  assert.equal(
    await evaluate("document.querySelector('.media-title').textContent"),
    "While disabled",
  );
  assert.equal((await inspect()).title, "While disabled");
});

test("native timeline displays time, advances without store revisions, and freezes when paused", async () => {
  await evaluate(`mediaPreview.preferences({modules:{media:true,vscode:false,developerIntegrations:false}});
    mediaPreview.publish('playing', 'A quieter kind of evening', 'Mimo preview', {sessionId:'timeline-session',artwork:{dataUrl:mediaPreview.artwork}, timeline:{positionMs:84000,durationMs:252000,updatedAtUnixMs:Date.now(),playbackRateMilli:1000}}); mediaPreview.open('media');`);
  await evaluate(settled);
  assert.equal(
    await evaluate("document.querySelector('.media-duration').textContent"),
    "4:12",
  );
  const revision = await evaluate("mediaPreview.store.snapshot().revision");
  const before = await evaluate(
    "document.querySelector('.media-elapsed').textContent",
  );
  await evaluate("new Promise(resolve => setTimeout(resolve, 2200))");
  assert.notEqual(
    await evaluate("document.querySelector('.media-elapsed').textContent"),
    before,
  );
  assert.equal(
    await evaluate("mediaPreview.store.snapshot().revision"),
    revision,
  );
  await capture("mimo-player-timeline");
  await evaluate(
    "mediaPreview.publish('paused','A quieter kind of evening','Mimo preview',{timeline:{positionMs:84000,durationMs:252000,updatedAtUnixMs:Date.now(),playbackRateMilli:1000}})",
  );
  await evaluate(settled);
  assert.equal(
    await evaluate("document.querySelector('.media-elapsed').textContent"),
    "1:24",
  );
  await evaluate("new Promise(resolve => setTimeout(resolve, 1200))");
  assert.equal(
    await evaluate("document.querySelector('.media-elapsed').textContent"),
    "1:24",
  );
  await evaluate("mediaPreview.publish('unknown')");
  assert.equal(
    await evaluate(
      "document.querySelector('.media-progress').getAttribute('aria-valuetext')",
    ),
    "Playback time unavailable",
  );
  await evaluate("mediaPreview.preferences({peekEnabled:false,workingModeEnabled:false});mediaPreview.publish('paused');mediaPreview.compact()");
  await evaluate(settled);
  assert.equal(
    await evaluate(
      "document.querySelector('.media-ambient').classList.contains('has-full-controls')",
    ),
    true,
  );
  await capture("mimo-compact-controls");
  assert.equal(await evaluate("document.querySelector('.media-ambient').getAttribute('aria-hidden')"),'false');
  await pointerClick('.media-ambient-primary');
  assert.equal(await evaluate("mediaPreview.actions.at(-1)"),'play');
  await pointerClick('.media-ambient-primary');
  assert.equal(await evaluate("mediaPreview.actions.at(-1)"), "pause");
});

test("settings sidebar exposes real preferences, hides inactive controls, and fits Windows scaling", async () => {
  await command("Emulation.setDeviceMetricsOverride", {
    width: 760,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await loadPage("Page.navigate", {
    url: "http://127.0.0.1:1431/settings.html",
  });
  await evaluate("new Promise(resolve => setTimeout(resolve, 1200))");
  assert.equal(await evaluate("document.title"), "Settings");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Auto-collapse delay in seconds\"]')"), null);
  assert.equal(await evaluate("document.querySelector('#settings-general').textContent.includes('Activity settles after')"), false);
  assert.equal(
    await evaluate("document.querySelector('.settings-brand').textContent"),
    "Settings",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.app-mark').complete && document.querySelector('.app-mark').naturalWidth > 0",
    ),
    true,
  );
  for (const page of [
    "general",
    "media",
    "chat",
    "modules",
    "integrations",
    "usage",
    "hotkeys",
    "about",
  ]) {
    await evaluate(
      `document.querySelector('[aria-controls="settings-${page}"]').click()`,
    );
    await evaluate("new Promise(resolve => setTimeout(resolve, 250))");
    assert.equal(
      await evaluate(
        "document.querySelectorAll('.settings-page:not([hidden])').length",
      ),
      1,
    );
    assert.equal(
      await evaluate(`document.querySelector('#settings-${page}').inert`),
      false,
    );
    assert.equal(
      await evaluate(
        "document.querySelectorAll('.settings-page[hidden]:not([inert])').length",
      ),
      0,
    );
    if (page === "modules") {
      await evaluate(
        `document.querySelector('#settings-modules [aria-label="VS Code"]').click()`,
      );
      assert.equal(
        await evaluate(
          `document.querySelector('#settings-modules [aria-label="VS Code"]').getAttribute('aria-checked')`,
        ),
        "false",
      );
    }
    if (page === "modules") await capture("mimo-settings-modules");
  }
  await evaluate(
    "document.querySelector('[aria-controls=\"settings-general\"]').click()",
  );
  await evaluate("new Promise(resolve => setTimeout(resolve, 250))");
  for (const scale of [1, 1.25, 1.5, 2, 3, 4]) {
    await command("Emulation.setDeviceMetricsOverride", {
      width: 760,
      height: 640,
      deviceScaleFactor: scale,
      mobile: false,
    });
    assert.equal(
      await evaluate("document.documentElement.scrollWidth <= innerWidth"),
      true,
    );
    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('.preference-label')).fontSize",
      ),
      "14px",
    );
    assert.ok(
      await evaluate(
        "document.querySelector('.switch').getBoundingClientRect().width >= 44",
      ),
    );
    await capture(`mimo-settings-general-${scale}x`);
  }
  await command("Emulation.setDeviceMetricsOverride", {
    width: 620,
    height: 480,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.equal(
    await evaluate("document.documentElement.scrollWidth <= innerWidth"),
    true,
  );
  await capture("mimo-settings-minimum");
  await command("Emulation.setDeviceMetricsOverride", {
    width: 720,
    height: PANEL_H,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await loadPage("Page.navigate", {
    url: "http://127.0.0.1:1431/dev/media-preview.html",
  });
  await evaluate("new Promise(resolve => setTimeout(resolve, 1200))");
  await scene("playing");
});

test("tool switcher retains four usable slots even with fewer connected tools", async (t) => {
  t.after(clearPanelFixture); await panelFixture();
  await evaluate(`(async()=>{const {Bridge}=await import('/src/core/bridge.ts');
    window.connectionPages=[];Bridge.openSettingsWindow=async page=>connectionPages.push(page);})()`);
  for (const [coding,ids] of [[true,[]],[true,['integration_github']],[true,['integration_github','integration_vercel']],[false,[]]]) {
    await evaluate(`mediaPreview.preferences({modules:{vscode:${coding},developerIntegrations:true},activeIntegrations:${JSON.stringify(ids)}});mediaPreview.open('overview')`);
    await evaluate(settled);
    assert.equal(await evaluate("document.querySelectorAll('.module-developer .integration-tile').length"),4);
    assert.equal(await evaluate("[...document.querySelectorAll('.integration-tile[data-integration]')].every(b=>b.dataset.integration!==document.querySelector('.module-activity')?.dataset.integration)"),true);
    assert.equal(await evaluate("[...document.querySelectorAll('.integration-tile')].every(b=>!b.disabled&&b.getAttribute('aria-label'))"),true);
    await capture('switcher-four-slots-'+coding+'-'+ids.length);
  }
  await pointerClick('.connection-slot');
  assert.deepEqual(await evaluate('connectionPages'),['connections']);
});

test("concurrent sessions keep request decisions, projects, and deadline recovery isolated", async (t) => {
  t.after(async()=>{
    await evaluate("(async()=>{const {resetHookSession}=await import('/src/island/hooks.ts');resetHookSession(mediaPreview.island)})()");
    await clearPanelFixture();
  });
  await panelFixture();
  await evaluate(`(async()=>{
    const {Bridge}=await import('/src/core/bridge.ts');
    const {handleHook,expireApprovals}=await import('/src/island/hooks.ts');window.workflowCalls=[];
    Bridge.approvalAck=async id=>workflowCalls.push(['ack',id]);Bridge.approvalDecline=async id=>workflowCalls.push(['decline',id]);
    Bridge.approvalDecision=async(id,decision)=>workflowCalls.push([decision,id]);
    mediaPreview.preferences({workflowSetupDone:true,autoCollapseEnabled:false});
    window.workEvent=(session,event,extra={})=>handleHook(mediaPreview.island,{mimo_provider:session==='gamma'?'codex':'claude',session_id:session,cwd:'C:/work/'+session,hook_event_name:event,...extra});
    window.expireWork=()=>expireApprovals(mediaPreview.island);
    for(const session of ['alpha','beta','gamma']) workEvent(session,'UserPromptSubmit',{prompt:'Fix '+session});
    for(const session of ['alpha','beta','gamma']) workEvent(session,'PermissionRequest',{request_id:session,tool_name:'Bash',tool_use_id:session+'-tool',tool_input:{command:'npm test '+session}});
  })()`);
  await evaluate(settled);
  assert.equal(await evaluate('mediaPreview.state.pendingApprovals.length'),3);
  assert.equal(await evaluate('mediaPreview.state.pendingApproval.requestId'),'alpha');
  await pointerClick('.approvals-entry');await evaluate(settled);
  assert.equal(await evaluate("document.querySelectorAll('.approval-inbox-row[data-active=true]').length"),3);
  assert.match(await evaluate("document.querySelector('.approval-inbox-list').textContent"),/alpha.*beta.*gamma/);
  await pointerClick('.approval-inbox-row[data-request=beta] .approval-inbox-review');await evaluate(settled);
  assert.equal(await evaluate('mediaPreview.state.pendingApproval.requestId'),'beta');
  assert.match(await evaluate("document.querySelector('.approval-view.on').textContent"),/npm test beta/);
  await evaluate("[...document.querySelectorAll('.approval-view.on button')].find(b=>b.textContent.startsWith('Allow')).click()");
  assert.deepEqual(await evaluate('mediaPreview.state.pendingApprovals.map(r=>r.requestId)'),['alpha','gamma']);
  assert.deepEqual(await evaluate("workflowCalls.filter(c=>c[0]==='allow')"),[['allow','beta']]);
  await evaluate("mediaPreview.state.pendingApprovals.find(r=>r.requestId==='alpha').deadline=Date.now()-1;expireWork()");await evaluate(settled);
  assert.equal(await evaluate('mediaPreview.state.pendingApproval.requestId'),'gamma');
  assert.equal(await evaluate('mediaPreview.state.focusTask.sessionId'),'gamma');
  assert.match(await evaluate("document.querySelector('.approval-view.on').textContent"),/npm test gamma/);
  await capture('workflow-concurrent-requests');
  await pointerClick('.approvals-entry');await evaluate(settled);
  assert.equal(await evaluate("document.querySelectorAll('.approval-inbox-row[data-request=alpha] [data-review=active]').length"),0);
  await evaluate("workEvent('beta','SessionEnd');workEvent('beta','PostToolUse',{tool_name:'Edit',tool_use_id:'late'})");
  assert.equal(await evaluate("mediaPreview.state.tasks.some(t=>t.sessionId==='beta')"),false);
  assert.equal(await evaluate('mediaPreview.state.pendingApproval.requestId'),'gamma');
});

test("Service readings update existing cards without Watch project or saved work", async (t) => {
  t.after(() => clearPanelFixture());
  await panelFixture();
  await evaluate(`(async()=>{
    const {handle}=await import('/src/island/integrations.ts');
    const {normalizeSettings}=await import('/src/core/state.ts');
    mediaPreview.state.settings=normalizeSettings({...mediaPreview.state.settings,
      watchedProject:{cwd:'C:/work/shop',repository:'team/shop',branch:'main',vercelProject:'shop'}});
    localStorage.removeItem('mimo.project.v1');localStorage.removeItem('mimo.work.v1');
    for(const id of ['integration_github','integration_vercel'])mediaPreview.state.updateTask(id,'idle');
    handle(mediaPreview.island,{id:'integration_github',error:null,event:null,
      data:{checks:[{repo:'team/shop',branch:'main',sha:'abc',runs:[{id:7,name:'Checkout tests',status:'completed',conclusion:'failure',url:'https://github.com/team/shop/actions/runs/7'}]}],reviews:[]}});
    handle(mediaPreview.island,{id:'integration_vercel',error:null,event:null,
      data:{deployments:[{id:'deployment-1',projectId:'shop',projectName:'shop',state:'ERROR',inspectorUrl:'https://vercel.com/team/shop/deployment-1'}]}});
  })()`);
  assert.equal(await evaluate("mediaPreview.state.integrations.integration_github.data.checks[0].runs[0].name"),'Checkout tests');
  assert.equal(await evaluate("mediaPreview.state.integrations.integration_vercel.data.deployments[0].state"),'ERROR');
  assert.equal(await evaluate("localStorage.getItem('mimo.project.v1')"),null);
  assert.equal(await evaluate("localStorage.getItem('mimo.work.v1')"),null);
  assert.deepEqual(await evaluate("mediaPreview.state.tasks.filter(t=>['integration_github','integration_vercel'].includes(t.id)).map(t=>t.state)"),['idle','idle']);
  assert.equal(await evaluate("mediaPreview.state.view"),'overview');
  assert.deepEqual(browserErrors,[]);
});

test("integration icons reflow into four compact choices with a persistent right picker", async (t) => {
  t.after(() => loadPage("Page.reload"));
  await connectedToolFixtures();
  const ids = ["integration_resend","integration_n8n","integration_vercel","integration_github",
    "integration_notion","integration_calcom","integration_stripe"];
  for (const [vscode, count] of [[true,4],[true,7],[false,7]]) {
    await evaluate(`mediaPreview.preferences({peekEnabled:false,modules:{vscode:${vscode},developerIntegrations:true},
      activeIntegrations:${JSON.stringify(ids.slice(0,count))}});mediaPreview.open('integrations')`);
    await evaluate(settled);
    const layout = await evaluate(`(() => {
      const card=document.querySelector('[data-module=developerIntegrations]');
      const outer=card.getBoundingClientRect();
      const buttons=[...card.querySelectorAll('.integration-tile')];
      return {height:outer.height,active:document.querySelector('.module-activity').dataset.integration,
        mimos:card.querySelectorAll('canvas').length,
        more:!card.querySelector('.integration-more-picker').hidden,
        moreInside:(()=>{const r=card.querySelector('.integration-more').getBoundingClientRect();
          return r.height===0||(r.left>=outer.left&&r.right<=outer.right&&r.top>=outer.top&&r.bottom<=outer.bottom);})(),
        tiles:buttons.map(button=>{const r=button.getBoundingClientRect();return {
          id:button.dataset.integration,width:r.width,height:r.height,y:r.y,
          inside:r.left>=outer.left&&r.right<=outer.right&&r.top>=outer.top&&r.bottom<=outer.bottom,
          name:button.textContent,title:button.title,label:button.getAttribute('aria-label'),
        };})};
    })()`);
    assert.equal(layout.height,count > 4 || !vscode ? 124 : 120);
    assert.equal(layout.tiles.length,4);
    assert.equal(new Set(layout.tiles.map(tile=>Math.round(tile.y))).size,2);
    assert.equal(layout.mimos,4,"The four choices each contain a mini Mimo");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#bot-canvas')).opacity"),"1",
      "The active tool keeps its original full-size interactive companion");
    assert.ok(await evaluate("Math.abs(mediaPreview.island.botSize.value*.6-52)<.1"));
    assert.equal(layout.more,count+Number(vscode)>5);
    assert.equal(layout.moreInside,true,"The dropdown trigger fits inside the compact picker card");
    for (const tile of layout.tiles) {
      assert.ok(tile.width>=110);
      assert.equal(tile.height,32);
      assert.equal(tile.inside,true);
      assert.equal(tile.name,tile.title);
      assert.ok(tile.label);
      assert.notEqual(tile.id,layout.active,"The active tool is absent from the right picker");
    }
    await capture(`integrations-four-choices-${vscode ? "coding" : "tools"}-${count}`);
  }
  const companionPoint = await evaluate(`(() => {const r=document.querySelector('#island').getBoundingClientRect();
    return {x:r.x+mediaPreview.island.botCx.value,y:r.y+mediaPreview.island.botCy.value};})()`);
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',...companionPoint});
  await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...companionPoint});
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...companionPoint});
  assert.equal(await evaluate("mediaPreview.island.engine.eyeOverride"),'stern',
    "Clicking the selected Mimo keeps its existing interactive reaction");
  await pointerClick('.integration-tile[data-integration=integration_n8n]');
  await evaluate(settled);
  assert.match(await evaluate("document.querySelector('.module-activity').textContent"),/n8n/);
  assert.equal(await evaluate("document.querySelector('.module-developer .int-card')===null"),true);
  assert.equal(await evaluate("document.querySelectorAll('.integration-picker').length"),1);
  await pointerClick('.integration-tile[data-integration=integration_github]');
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.integration-tile[data-integration=integration_n8n]')!==null"),true,
    "The previous tool returns to the picker");
  await command("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.integration-tile')).transitionDuration"),"0s");
  await command("Emulation.setEmulatedMedia",{features:[]});
});

test("integration icons reflow while selection replaces the left tool and returns the previous choice", async (t) => {
  t.after(() => loadPage("Page.reload"));
  await connectedToolFixtures();
  await evaluate(`mediaPreview.preferences({peekEnabled:false,modules:{vscode:true,developerIntegrations:true},
    activeIntegrations:['integration_resend','integration_n8n','integration_vercel','integration_github',
      'integration_notion','integration_calcom','integration_stripe']});mediaPreview.open('integrations')`);
  await evaluate(settled);
  for (const appearance of ["dark"]) {
    await evaluate(`mediaPreview.preferences({appearance:'${appearance}'})`);
    await selectIntegration("integration_claude");
    assert.equal(await evaluate("document.querySelector('.module-activity .int-head b').textContent"),"VS Code");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.integration-tile')].map(button=>button.title)"),
      ["Resend","n8n","Vercel","GitHub"]);
    assert.equal(await evaluate("document.querySelectorAll('.module-developer canvas').length"),4);
    const companions = await evaluate(`(async () => {
      const {MIMO_PICKER_COLORS} = await import('/src/mimo/palette.ts');
      const {miniBotCount} = await import('/src/mimo/minibots.ts');
      return {
        live:miniBotCount(), mounted:document.querySelectorAll('.mini canvas').length,
        leftVisible:getComputedStyle(document.querySelector('#bot-canvas')).opacity,
        tiles:[...document.querySelectorAll('.integration-tile')].map(button => {
          const canvas=button.querySelector('canvas');
          const label=button.querySelector('.integration-label');
          const outer=button.getBoundingClientRect();
          const inside=el => {const r=el.getBoundingClientRect();
            return r.left>=outer.left&&r.right<=outer.right&&r.top>=outer.top&&r.bottom<=outer.bottom;};
          const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
          const color=MIMO_PICKER_COLORS[button.dataset.integration].slice(1).match(/../g).map(hex=>parseInt(hex,16));
          let bodyPixels=0;
          for(let i=0;i<data.length;i+=4)
            if(data[i+3]>200&&color.every((value,index)=>Math.abs(value-data[i+index])<3)) bodyPixels++;
          const labelBounds=label.getBoundingClientRect();
          const avatar=button.querySelector('.integration-avatar');
          return {id:button.dataset.integration,bodyPixels,fit:inside(avatar)&&inside(label),
            centerError:Math.abs((labelBounds.left+labelBounds.right-outer.left-outer.right)/2),
            fullName:label.scrollWidth<=label.clientWidth,
            noIcons:!button.querySelector('.integration-app-badge,.integration-mark,.ui-icon,svg'),
            rounded:parseFloat(getComputedStyle(button).borderRadius)>=16,
            small:avatar.getBoundingClientRect().width===20,
            textSize:parseFloat(getComputedStyle(label).fontSize),
            painted:canvas.width===Math.round(20/.6*devicePixelRatio)};
        }),
      };
    })()`);
    assert.equal(companions.leftVisible,"1");
    assert.equal(companions.live,companions.mounted,"Switching releases detached mini companion engines");
    for(const tile of companions.tiles) {
      assert.ok(tile.bodyPixels>20,`${appearance} ${tile.id} uses its soft companion color`);
      assert.equal(tile.fit,true,"Mini Mimos and names fit inside each choice");
      assert.ok(tile.centerError<1,"Tool names are centered in their whole choice card");
      assert.equal(tile.fullName,true,"Centering keeps each tool name fully readable");
      assert.equal(tile.noIcons,true,"The selector contains no integration icons or app badges");
      assert.equal(tile.rounded&&tile.small,true,"The choices use smaller Mimos and rounded pills");
      assert.equal(tile.textSize,10);
      assert.equal(tile.painted,true,"Mini Mimos render at the current display DPI");
    }
    await capture(`integrations-default-${appearance}`);
    await evaluate("window.retainedIntegrationMimo=document.querySelector('.integration-tile[data-integration=integration_resend] canvas')");
    await selectIntegration("integration_github");
    assert.equal(await evaluate("retainedIntegrationMimo===document.querySelector('.integration-tile[data-integration=integration_resend] canvas')"),true,
      "Choices that remain available keep their companion and animation state");
    assert.match(await evaluate("document.querySelector('.module-activity').textContent"),/GitHub/);
    assert.equal(await evaluate("document.querySelector('.integration-tile[data-integration=integration_github]')===null"),true);
    assert.equal(await evaluate("document.querySelector('.integration-tile[data-integration=integration_claude]')!==null"),true);
    assert.equal(await evaluate("document.activeElement.closest('.module-developer')!==null"),true,
      "Focus stays with the right picker after its selected button is removed");
    assert.equal(await evaluate("document.querySelector('.module-developer .int-card')===null"),true);
    await selectIntegration("integration_n8n");
    assert.match(await evaluate("document.querySelector('.module-activity').textContent"),/n8n/);
    assert.equal(await evaluate("document.querySelector('.integration-tile[data-integration=integration_github]')!==null"),true);
    await capture(`integrations-active-n8n-${appearance}`);
    await pointerClick(".integration-more");
    await evaluate(settled);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.integration-more-picker [role=option]')].map(button=>button.dataset.device)"),
      ["integration_notion","integration_calcom","integration_stripe"]);
    await capture(`integrations-more-tools-${appearance}`);
    await command("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    await command("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    assert.equal(await evaluate("document.querySelector('.integration-more').getAttribute('aria-expanded')"),"false");
    assert.equal(await evaluate("mediaPreview.state.visibility"),"expanded","Escape dismisses the dropdown without collapsing the tool");
    await evaluate("document.querySelector('.integration-more').focus()");
    await command("Input.dispatchKeyEvent",{type:"keyDown",key:"ArrowDown",code:"ArrowDown",windowsVirtualKeyCode:40});
    await command("Input.dispatchKeyEvent",{type:"keyDown",key:"End",code:"End",windowsVirtualKeyCode:35});
    assert.equal(await evaluate("document.activeElement.dataset.device"),"integration_stripe");
    await command("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13,text:"\r"});
    await command("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
    await evaluate(settled);
    assert.match(await evaluate("document.querySelector('.module-activity').textContent"),/Stripe/);
    assert.equal(await evaluate("document.activeElement===document.querySelector('.integration-more')"),true);
    assert.equal(await evaluate("document.querySelector('.integration-more-picker [data-device=integration_stripe]')===null"),true);
    await selectIntegration("integration_claude");
    assert.equal(await evaluate("document.querySelectorAll('.integration-tile').length"),4);
    assert.equal(await evaluate("document.querySelector('.module-activity .int-head b').textContent"),"VS Code");
    await selectIntegration("integration_github");
    await evaluate("mediaPreview.preferences({activeIntegrations:['integration_resend','integration_n8n','integration_vercel','integration_notion','integration_calcom','integration_stripe']})");
    await evaluate(settled);
    assert.equal(await evaluate("document.querySelector('.module-activity').dataset.integration"),"integration_claude",
      "Removing the current integration returns to VS Code");
    await evaluate("mediaPreview.preferences({activeIntegrations:['integration_resend','integration_n8n','integration_vercel','integration_github','integration_notion','integration_calcom','integration_stripe']})");
    await evaluate(settled);
  }
  assert.deepEqual(browserErrors,[]);
});

test("integration icons reflow opens a compact whole-tab code preview and hides integration and permission scrollbars", async (t) => {
  t.after(() => loadPage("Page.reload"));
  await loadPage("Page.reload");
  await connectedToolFixtures();
  await evaluate(`mediaPreview.preferences({workflowSetupDone:true,peekEnabled:false,workingModeEnabled:false,autoCollapseEnabled:false,hooksInstalled:true,
    codingAssistant:'claude',modules:{vscode:true,developerIntegrations:true},
    activeIntegrations:['integration_resend','integration_n8n','integration_vercel','integration_github',
      'integration_notion','integration_calcom','integration_stripe']});
    mediaPreview.state.setFocus('integration_claude');mediaPreview.open('integrations')`);
  const codeLayout = `(() => {
    const preview=document.querySelector('.coding-preview');
    return {height:document.querySelector('#island').getBoundingClientRect().height,
      left:document.querySelector('.module-activity').getBoundingClientRect().height,
      right:document.querySelector('.module-developer')?.getBoundingClientRect().height??0,
      width:preview.clientWidth,previewHeight:preview.clientHeight,scrollHeight:preview.scrollHeight,
      rows:[...preview.querySelectorAll('.coding-line')].filter(el=>!el.hidden).map(el=>({
        height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width,text:el.textContent?.length})),
      overflow:preview.scrollHeight-preview.clientHeight,
      bars:[preview,...document.querySelectorAll('.module-layout .card')].every(el=>
        getComputedStyle(el).scrollbarWidth==='none'&&getComputedStyle(el,'::-webkit-scrollbar').display==='none')};
  })()`;
  const permissionLayout = `(() => {
    const code=document.querySelector('.approval-view .code');
    const reason=document.querySelector('.coding-approval-reason');
    const island=document.querySelector('#island').getBoundingClientRect();
    return {height:island.height,overflow:code.scrollHeight-code.clientHeight,
      bars:[code,reason].every(el=>getComputedStyle(el).scrollbarWidth==='none'
        &&getComputedStyle(el,'::-webkit-scrollbar').display==='none'),
      actions:[...document.querySelectorAll('.approval-view .actions button')].every(el=>{
        const r=el.getBoundingClientRect();return r.height>=28&&r.top>=island.top&&r.bottom<=island.bottom;})};
  })()`;
  for(const appearance of ['dark']) {
    await evaluate(`mediaPreview.preferences({appearance:'${appearance}'});
      Object.assign(mediaPreview.state.codingTask,{state:'working',name:'Mimo',steps:['Edit'],stepIndex:0,
        activity:{action:'Edit',target:'src/integrations.ts',preview:{startLine:12,
          lines:Array.from({length:3},(_,i)=>'const integration'+i+' = '+JSON.stringify('Useful live integration details '.repeat(4))+';')}}});
      mediaPreview.state.notify();mediaPreview.open('integrations')`);
    await evaluate(settled);
    let layout=await evaluate(codeLayout);
    assert.ok(Math.abs(layout.height-214)<.5,"Incoming code keeps the merged workspace compact with Home actions");
    assert.equal(layout.left,124);
    assert.equal(layout.right,124);
    assert.equal(layout.bars,true);
    assert.equal(await evaluate("document.querySelector('.module-activity .coding-project').textContent"),'Claude');
    assert.ok(await evaluate("document.querySelectorAll('.coding-preview [data-token=keyword]').length>0"));
    assert.equal(await evaluate("document.querySelector('.coding-preview').hidden"),true,
      "The default reference shows a summary instead of an inline code block");
    assert.equal(await evaluate("document.querySelector('.coding-expand')"),null);
    await pointerClick('.coding-preview-trigger');
    await evaluate(settled);
    layout=await evaluate(codeLayout);
    assert.ok(Math.abs(layout.height-332)<.5,"Tapping the preview opens one bounded card across the whole tab");
    assert.equal(layout.left,280);
    assert.equal(layout.right,0);
    assert.equal(await evaluate("document.querySelectorAll('.module-layout.on > .home-workspace').length"),1);
    await capture(`integrations-long-code-${appearance}`);
    assert.ok(layout.overflow>0,"Long wrapped edits stay inside the bounded expanded preview: "+JSON.stringify(layout));
    await evaluate("document.querySelector('.coding-preview').focus()");
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35});
    await evaluate(settled);
    assert.ok(await evaluate("document.querySelector('.coding-preview').scrollTop>0"),"The bounded preview permits keyboard access to the rest of a long edit");
    assert.equal(layout.bars,true);
    assert.equal(await evaluate(`(()=>{
      const footer=document.querySelector('.coding-editor-footer').getBoundingClientRect();
      const open=document.querySelector('.coding-open').getBoundingClientRect();
      const back=document.querySelector('.coding-expand').getBoundingClientRect();
      return open.left-back.right>=8&&open.height===back.height&&open.top===back.top
        &&open.right<=footer.right&&back.left>=footer.left;
    })()`),true,"Reference footer keeps Back and Back to work aligned below the content");
    assert.equal(await evaluate("document.querySelector('.coding-expand').textContent"),'Back');
    await evaluate("mediaPreview.state.codingTask.activity.preview.lines=['return 42;'];mediaPreview.state.notify()");
    await evaluate(settled);
    layout=await evaluate(codeLayout);
    assert.ok(Math.abs(layout.height-332)<.5,"Live updates do not resize the expanded preview");
    await pointerClick('.coding-expand');
    await evaluate("(()=>{const p={...mediaPreview.state.mouse};mediaPreview.island.onCursor(-10000,-10000);mediaPreview.island.onCursor(p.x,p.y)})()");
    await evaluate(settled);
    layout=await evaluate(codeLayout);
    assert.ok(Math.abs(layout.height-214)<.5,"Back restores the merged Home workspace and actions: "+JSON.stringify(layout));
    assert.equal(layout.left,124);
    assert.equal(layout.right,124);
    await evaluate(`mediaPreview.state.pendingApproval={taskId:'integration_claude',provider:'claude',
      requestId:'layout-check',tool:'Bash',command:Array.from({length:10},(_,i)=>'npm run verify:integration-'+i).join('\\n'),
      reason:'Verify the integration changes before continuing.'};mediaPreview.open('approval')`);
    await evaluate(settled);
    let permission=await evaluate(permissionLayout);
    assert.ok(permission.height>224&&permission.height<=PANEL_H,"Permission content determines the island height");
    assert.equal(permission.actions&&permission.bars,true);
    assert.ok(permission.overflow<=1,"Permission content fits: "+JSON.stringify(permission));
    await capture(`integrations-long-permission-${appearance}`);
    await evaluate(`Object.assign(mediaPreview.state.pendingApproval,{
      command:Array.from({length:200},(_,i)=>'npm run verify:integration-'+i).join('\\n'),
      reason:'Detailed permission context. '.repeat(50)});mediaPreview.state.notify()`);
    await evaluate(settled);
    permission=await evaluate(permissionLayout);
    assert.equal(permission.height,PANEL_H,"Very long content respects the desktop window limit");
    assert.ok(permission.overflow>0);
    assert.equal(permission.actions&&permission.bars,true,"Permission controls remain visible at the maximum height");
    await evaluate("document.querySelector('.approval-view .code').focus()");
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35});
    await evaluate(settled);
    assert.ok(await evaluate("document.querySelector('.approval-view .code').scrollTop>0"),
      "Hidden scrollbars retain keyboard scrolling for content beyond the island bounds");
    await evaluate("Object.assign(mediaPreview.state.pendingApproval,{command:'npm test',reason:''});mediaPreview.state.notify()");
    await evaluate(settled);
    permission=await evaluate(permissionLayout);
    assert.equal(permission.height,224,"Short requests restore the compact permission panel");
    assert.equal(permission.actions&&permission.bars,true);
    await evaluate("mediaPreview.state.pendingApproval=null;mediaPreview.open('integrations')");
  }
  assert.deepEqual(browserErrors,[]);
});

test("Mimo panels service workspaces keep circle headers, colored row icons, compact hierarchy, and real expanded actions", async (t) => {
  t.after(clearPanelFixture); await panelFixture();
  await evaluate(`(async()=>{const {Bridge}=await import('/src/core/bridge.ts');
    window.serviceRefreshes=[]; Bridge.refreshIntegration=async id=>{serviceRefreshes.push(id);await new Promise(resolve=>setTimeout(resolve,60));};
    Bridge.openN8n=async()=>panelLinks.push('n8n');Bridge.openN8nPage=async(page,id)=>panelLinks.push('n8n/'+page+'/'+id);
    mediaPreview.preferences({activeIntegrations:['integration_github','integration_vercel','integration_resend','integration_stripe','integration_notion','integration_calcom','integration_n8n']});
    const now=Date.now(),ready=data=>({configured:true,loaded:true,error:null,data});
    Object.assign(mediaPreview.state.integrations,{
      integration_vercel:ready({deployments:[{id:'deploy-1',projectName:'Mimo web',state:'BUILDING',branch:'main',commitMessage:'Ship the new panels',url:'mimo.vercel.app',inspectorUrl:'https://vercel.com/mimo/deploy-1',createdAt:now},{id:'deploy-2',projectName:'Mimo docs',state:'ERROR',branch:'docs',url:'docs.vercel.app',createdAt:now-3600000}]}),
      integration_resend:ready({total:42,emails:[{id:'email-1',to:['reader@example.com'],subject:'Welcome to Mimo',lastEvent:'delivered',createdAt:now},{id:'email-2',to:['other@example.com'],subject:'Your update',lastEvent:'bounced',createdAt:now-3600000}]}),
      integration_stripe:ready({balance:12345,currency:'usd',testMode:true,payments:[{id:'pi_mimo',description:'Mimo subscription',currency:'usd',amount:1200,status:'succeeded',createdAt:now},{id:'ch_pending',description:'Team plan',currency:'usd',amount:2400,status:'pending',createdAt:now-60000},{id:'ch_refunded',description:'Mimo credit',currency:'usd',amount:600,status:'succeeded',refunded:true,createdAt:now-120000}],events:[{id:'evt_mimo',type:'payment_intent.succeeded',createdAt:now}]}),
      integration_notion:ready({pages:[{id:'page-1',title:'Project notes',lastEditedAt:now,url:'https://notion.so/mimo-notes'},{id:'page-2',title:'Design decisions',lastEditedAt:now-3600000,url:'https://notion.so/mimo-design'}]}),
      integration_calcom:ready({bookings:[{id:'booking-1',title:'Design review',start:new Date(now+3600000).toISOString(),status:'accepted',attendeeName:'Sam',attendeeEmail:'sam@example.com',attendeeNotes:'Discuss keyboard navigation and release readiness.'},{id:'booking-2',title:'Release check',start:new Date(now+90000000).toISOString(),status:'accepted',attendeeName:'Alex'}]}),
      integration_n8n:ready({executions:[{id:'run-1',name:'Nightly sync',status:'success',mode:'trigger',startedAt:new Date(now-12000).toISOString(),stoppedAt:new Date(now).toISOString()}],workflows:[{id:'flow-1',name:'Nightly sync',active:true,updatedAt:new Date(now).toISOString()}]})
    });mediaPreview.state.notify();mediaPreview.open('integrations')})()`); await evaluate(settled);
  const services=[['integration_vercel','Vercel','Building'],['integration_resend','Resend','Delivered'],['integration_stripe','Stripe','Available balance'],['integration_notion','Notion','Latest page'],['integration_calcom','Cal.com','Next call'],['integration_n8n','n8n','Active']];
  for(const [id,name,label] of services){
    await selectIntegration(id);
    const vercel=id==='integration_vercel';
    assert.match(await evaluate("document.querySelector('"+(vercel?'.vercel-summary .github-summary':'.integration-summary')+"').textContent"),new RegExp(label));
    assert.equal(await evaluate("document.querySelectorAll('"+(vercel?'.vercel-summary .github-summary-row':'.integration-summary-row')+"').length"),3);
    assert.equal(await evaluate("document.querySelector('"+(vercel?'.github-compact-heading':'.integration-activity-head')+" .dot')!==null"),true);
    assert.equal(await evaluate("mediaPreview.island.engine.badge"),null,name+' left Mimo has no app badge');
    assert.equal(await evaluate("document.querySelector('.integration-feature-label svg')===null"),true,name+' main label has no app icon');
    assert.ok(await evaluate("new Set([...document.querySelectorAll('"+(vercel?'.github-summary-row':'.integration-summary-row')+" .integration-summary-icon')].map(mark=>getComputedStyle(mark).color)).size>=2"),name+' summary icons have distinct role colors');
    assert.equal(await evaluate("document.querySelectorAll('.integration-recent button').length>0"),!vercel,name+' uses its approved compact composition');
    assert.ok(await evaluate("(()=>{const body=document.querySelector('.integration-activity'),outer=body.getBoundingClientRect();return body.scrollHeight<=body.clientHeight+1&&[...body.querySelectorAll('button')].every(el=>{const r=el.getBoundingClientRect();return r.left>=outer.left&&r.right<=outer.right&&r.top>=outer.top&&r.bottom<=outer.bottom+1})})()"),name+' compact fits');
    await capture('mimo-'+id.slice(12)+'-compact-dark');
    if(vercel){await pointerClick('.vercel-expand');await evaluate(settled);}
    const recentItem = await evaluate("document.querySelector('"+(vercel?'.integration-activity-row':'.integration-recent button')+"').dataset.item");
    await pointerClick(vercel?'.integration-activity-link':'.integration-recent button');await evaluate(settled);
    assert.equal(await evaluate("document.querySelector('.integration-selection').hidden"),false,name+' recent shortcut selects the item');
    assert.equal(await evaluate("document.querySelector('.integration-activity-row[data-selected=true]').dataset.item"),recentItem);
    assert.ok(await evaluate("document.querySelectorAll('.integration-selection-facts dd').length>0"));
    if(id==='integration_calcom')assert.equal(await evaluate("document.querySelectorAll('.integration-agenda-date').length"),2);
    await pointerClick('.integration-back');await evaluate(settled);
    await pointerClick(vercel?'.vercel-expand':'.integration-expand');await evaluate(settled);
    assert.equal(await evaluate("Math.round(document.querySelector('#island').getBoundingClientRect().height)"),432);
    assert.equal(await evaluate("document.querySelector('.module-developer')===null"),true);
    assert.equal(await evaluate("document.activeElement.classList.contains('integration-back')"),true);
    assert.equal(await evaluate("document.querySelector('.integration-full h1').textContent"),name);
    assert.ok(await evaluate("document.querySelector('.integration-full .integration-summary-icon')!==null"));
    if(id==='integration_stripe'){
      for(const [category,item] of [['paid','pi_mimo'],['pending','ch_pending'],['refunded','ch_refunded']]){
        await pointerClick('[data-category='+category+']');
        assert.equal(await evaluate("document.querySelectorAll('.integration-activity-row').length"),1);
        assert.equal(await evaluate("document.querySelector('.integration-activity-row').dataset.item"),item);
      }
      assert.equal(await evaluate("document.querySelector('.integration-state').textContent"),'Refunded');
      await pointerClick('[data-category=payments]');
    }
    if(id==='integration_vercel'){
      await pointerClick('[data-category=building]');
      assert.equal(await evaluate("document.querySelector('.integration-activity-row').dataset.item"),'deploy-1');
      await pointerClick('[data-category=attention]');
      assert.equal(await evaluate("document.querySelector('.integration-activity-row').dataset.item"),'deploy-2');
      await pointerClick('[data-category=deployments]');
    }
    const fit=await evaluate("(()=>{const root=document.querySelector('.integration-full'),r=root.getBoundingClientRect();return root.scrollHeight<=root.clientHeight+1&&[...root.querySelectorAll('button,input')].every(el=>{const b=el.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom})})()");assert.equal(fit,true,name+' expanded fits');
    await pointerClick('.integration-activity-link');
    assert.equal(await evaluate("document.querySelector('.integration-selection').hidden"),false);
    if(id==='integration_calcom')assert.match(await evaluate("document.querySelector('.integration-selection').textContent"),/sam@example.com.*keyboard navigation/s);
    if(id==='integration_vercel'){
      assert.equal(await evaluate("document.querySelector('.integration-activity-row').dataset.tone"),'pending');
      await pointerClick('.integration-log-link');assert.equal(await evaluate("panelLinks.at(-1)"),'https://vercel.com/mimo/deploy-1');
    }
    if(id!=='integration_calcom'){
      await pointerClick('.integration-detail-action');
      const url=await evaluate("panelLinks.at(-1)");
      assert.ok(url.startsWith(id==='integration_n8n'?'n8n/executions/':'https://'),name+' opens real item');
      if(id==='integration_stripe')assert.match(url,/test\/payments\/pi_mimo$/);
    }
    await capture('mimo-'+id.slice(12)+'-full-dark');
    await pointerClick('[aria-label="Close item details"]');
    await pointerClick('.integration-activity-filter');
    await evaluate("document.querySelector('.integration-activity-filter').value='no-such-item';document.querySelector('.integration-activity-filter').dispatchEvent(new Event('input',{bubbles:true}))");
    assert.match(await evaluate("document.querySelector('.integration-activity-empty').textContent"),/No matching items/);
    await evaluate("mediaPreview.state.integrations['"+id+"'].data.checkedAt=Date.now();mediaPreview.state.notify()");
    assert.equal(await evaluate("document.activeElement.classList.contains('integration-activity-filter')"),true);
    assert.equal(await evaluate("document.querySelector('.integration-activity-filter').value"),'no-such-item');
    await evaluate("document.querySelector('.integration-activity-filter').value='';document.querySelector('.integration-activity-filter').dispatchEvent(new Event('input',{bubbles:true}))");
    await pointerClick('[aria-label="Refresh '+name+'"]');await evaluate("new Promise(resolve=>setTimeout(resolve,100))");
    assert.equal(await evaluate("serviceRefreshes.at(-1)"),id);
    assert.equal(await evaluate("document.querySelector('[data-focus-key=refresh]').disabled"),false);
    if(id==='integration_n8n'){
      await pointerClick('[data-category=workflows]');await pointerClick('.integration-activity-link');await pointerClick('.integration-detail-action');
      assert.equal(await evaluate("panelLinks.at(-1)"),'n8n/workflow/flow-1');
      await evaluate("mediaPreview.state.notify();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      assert.equal(await evaluate("document.activeElement.classList.contains('integration-detail-action')"),true,'Live updates retain focus on the selected workflow action');
    }
    await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await evaluate("document.querySelector('.integration-full').getAnimations({subtree:true}).length"),0);
    await command('Emulation.setEmulatedMedia',{features:[]});
    // The smaller overview returns under the pointer; keep hover inside it while
    // checking keyboard focus, independently of the normal leave-to-collapse timer.
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:110,y:60});
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});await evaluate(settled);
    assert.equal(await evaluate("document.querySelector('.integration-full')===null"),true);
    assert.equal(await evaluate("document.activeElement.classList.contains('"+(vercel?'vercel-expand':'integration-expand')+"')"),true,await evaluate("JSON.stringify({active:document.activeElement.className,view:mediaPreview.state.view,visibility:mediaPreview.state.visibility})"));
  }
  assert.ok(await evaluate("panelSounds.includes('open')&&panelSounds.includes('close')&&panelSounds.includes('tick')"));
  assert.deepEqual(browserErrors,[]);
});

test("Integration mini Mimos badge fresh events and clear them when reviewed", async (t) => {
  t.after(async () => {
    await command('Emulation.setEmulatedMedia',{features:[]});
    await clearPanelFixture();
  }); await panelFixture();
  await evaluate("mediaPreview.preferences({activeIntegrations:['integration_github','integration_vercel','integration_resend','integration_n8n','integration_notion','integration_calcom','integration_stripe']})");
  await connectedToolFixtures();
  await evaluate(`(async()=>{const {handle}=await import('/src/island/integrations.ts');window.integrationEvent=handle;
    mediaPreview.open('overview');
    integrationEvent(mediaPreview.island,{id:'integration_resend',data:{total:1,emails:[{id:'email-new',subject:'Fresh mail',lastEvent:'delivered'}]},error:null,event:{success:true,label:'Email delivered',detail:'Fresh mail'}});
    integrationEvent(mediaPreview.island,{id:'integration_n8n',data:{executions:[{id:'run-new',name:'Sync',status:'error'}]},error:null,event:{success:false,label:'Run failed',detail:'Sync'}});
    integrationEvent(mediaPreview.island,{id:'integration_notion',data:{pages:[{id:'page-new',title:'New notes'}]},error:null,event:{success:true,label:'Page updated',detail:'New notes'}});
  })()`); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.integration-tile[data-integration=integration_resend] .integration-avatar .mini-notification').dataset.status"),'finished');
  assert.match(await evaluate("document.querySelector('.integration-tile[data-integration=integration_resend]').getAttribute('aria-label')"),/New activity/);
  assert.equal(await evaluate("document.querySelector('.integration-tile[data-integration=integration_n8n] .mini-notification').dataset.status"),'error');
  assert.equal(await evaluate("document.querySelector('.integration-more-picker').dataset.unread"),'true');
  assert.equal(await evaluate("document.querySelectorAll('.integration-picker .integration-tile').length"),4);
  await capture('mimo-mini-notifications');
  await selectIntegration('integration_resend');
  assert.equal(await evaluate("mediaPreview.state.tasks.find(task=>task.id==='integration_resend').pillBadge"),null);
  await selectIntegration('integration_vercel');
  assert.equal(await evaluate("document.querySelector('.integration-tile[data-integration=integration_resend] .mini-notification')===null"),true);
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await evaluate("integrationEvent(mediaPreview.island,{id:'integration_resend',data:{total:2},error:null,event:{success:true,label:'New mail',detail:null}})");
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  assert.equal(await evaluate("document.querySelector('.integration-tile[data-integration=integration_resend] .mini-notification').getAnimations().length"),0);
  await command('Emulation.setEmulatedMedia',{features:[]});
  assert.deepEqual(browserErrors,[]);
});

test("Mini Mimos use a small animated blue mark on the left and retain live coding canvases", async (t) => {
  t.after(async()=>{
    await command('Emulation.setDeviceMetricsOverride',{width:720,height:PANEL_H,deviceScaleFactor:1,mobile:false});
    await command('Emulation.setEmulatedMedia',{features:[]});
    await evaluate("delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))");
    await clearPanelFixture();
  }); await panelFixture();
  await evaluate("mediaPreview.preferences({usageEnabled:false,autoCollapseEnabled:false});mediaPreview.publish('none')");
  await selectIntegration('integration_github');
  await evaluate(`(async()=>{const {handleHook}=await import('/src/island/hooks.ts');
    window.badgeHook=(name,extra={})=>handleHook(mediaPreview.island,{mimo_provider:'codex',session_id:'blue-badge',
      cwd:'C:/work/mimo',hook_event_name:name,...extra});
    badgeHook('UserPromptSubmit',{prompt:'Polish the companion'});
    badgeHook('PreToolUse',{tool_name:'Read',tool_use_id:'badge-read',tool_input:{file_path:'src/mimo.ts'}});
  })()`); await evaluate(settled);
  const tile = '.integration-tile[data-integration=integration_claude]';
  const mark = tile + ' .mini-notification';
  assert.match(await evaluate(`document.querySelector('${tile}').getAttribute('aria-label')`), /Codex, Working/);
  const shape = await evaluate(`(()=>{const b=document.querySelector('${mark}'),m=b.parentElement;
    const s=getComputedStyle(b),r=b.getBoundingClientRect(),p=m.getBoundingClientRect();
    window.badgeCanvas=m.querySelector('canvas');window.badgeMark=b;
    return {width:r.width,height:r.height,left:r.left-p.left,color:s.backgroundColor,
      accent:getComputedStyle(b).getPropertyValue('--accent').trim(),highlight:getComputedStyle(b,'::after').animationName,
      target:document.querySelector('${tile}').getBoundingClientRect().height};})()`);
  assert.deepEqual([shape.width,shape.height,shape.left],[7,7,-3]);
  assert.equal(shape.color,'rgb(45, 164, 249)');
  assert.equal(shape.highlight,'mini-work-breathe');
  assert.ok(shape.target>=32,'The visual marker does not reduce the tile hit target');
  await capture('mini-mimo-working-blue-left-1x');
  await command('Emulation.setDeviceMetricsOverride',{width:720,height:PANEL_H,deviceScaleFactor:2,mobile:false});
  await evaluate(settled); await capture('mini-mimo-working-blue-left-2x');
  await evaluate(`for(let i=0;i<120;i++)mediaPreview.state.notify();
    badgeHook('PostToolUse',{tool_name:'Read',tool_use_id:'badge-read'});`);
  await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  assert.equal(await evaluate(`badgeCanvas===document.querySelector('${tile} canvas')&&badgeMark===document.querySelector('${mark}')`),true,
    'Progress updates retain the companion buffer and running highlight');
  await evaluate("mediaPreview.open('media')"); await evaluate(settled);
  assert.equal(await evaluate("getComputedStyle(badgeMark,'::after').animationPlayState"),'paused');
  await evaluate(`Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));`);
  assert.equal(await evaluate("badgeMark.parentElement.dataset.paused"),'true');
  await evaluate("delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));mediaPreview.open('overview')");
  await evaluate(settled);
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await evaluate("getComputedStyle(badgeMark,'::after').animationName"),'none');
  await command('Emulation.setEmulatedMedia',{features:[]});
  await evaluate(`const normalTimeout=window.setTimeout;
    window.setTimeout=(fn,delay,...args)=>normalTimeout(fn,delay===5200?30:delay,...args);
    badgeHook('Stop',{message:'Companion polished'});window.setTimeout=normalTimeout;`);
  await evaluate(settled);
  assert.equal(await evaluate(`document.querySelector('${mark}').dataset.status`),'finished');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('${mark}'),'::after').animationName`),'none');
  await capture('mini-mimo-unread-blue-left-2x');
  await selectIntegration('integration_claude');
  assert.equal(await evaluate("mediaPreview.state.focusTask.id"),'session_codex_blue-badge');
  assert.equal(await evaluate("mediaPreview.state.focusTask.pillBadge"),null);
  await selectIntegration('integration_github');
  assert.equal(await evaluate(`document.querySelector('${mark}')===null`),true);
  await command('Emulation.setDeviceMetricsOverride',{width:720,height:PANEL_H,deviceScaleFactor:1,mobile:false});
  assert.deepEqual(browserErrors,[]);
});

test("The island detects quiet agents and confirmed stops without inventing completion", async (t) => {
  t.after(clearPanelFixture); await panelFixture();
  await evaluate(`mediaPreview.preferences({workingModeEnabled:false,usageEnabled:false,autoCollapseEnabled:false});mediaPreview.publish('none');
    mediaPreview.state.pendingApprovals=[];mediaPreview.state.selectedCodingId=null;`);
  await evaluate(`(async()=>{const {handleHook}=await import('/src/island/hooks.ts');
    window.stopHook=(name,extra={})=>handleHook(mediaPreview.island,{mimo_provider:'codex',session_id:'island-stop',
      cwd:'C:/work/mimo',hook_event_name:name,...extra});
    stopHook('UserPromptSubmit',{prompt:'Polish the mini Mimo'});
    window.quietTask=mediaPreview.state.tasks.find(t=>t.sessionId==='island-stop');
    quietTask.lastEventAt=Date.now()-88000;mediaPreview.state.notify();mediaPreview.compact();
  })()`); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.activity-work-title').textContent"),'Thinking');
  await evaluate("new Promise(r=>setTimeout(r,1400))");
  assert.equal(await evaluate("document.querySelector('.activity-work-title').textContent"),'No recent activity',
    'The existing visible clock detects silence without another hook or polling');
  assert.equal(await evaluate("document.querySelector('.activity-strip').dataset.state"),'quiet');
  assert.equal(await evaluate("document.querySelector('.activity-work-indicator').hidden"),true);
  assert.equal(await evaluate("quietTask.state"),'thinking');
  assert.equal(await evaluate("document.querySelector('#island').getBoundingClientRect().height"),40);
  await capture('island-agent-no-recent-activity-1x');
  const quietBounds = await evaluate("document.querySelector('#island').getBoundingClientRect().toJSON()");
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:400});
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:quietBounds.left+60,y:quietBounds.top+20});
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.visibility"),'island','Only the quiet coding strip ignores hover expansion');
  await pointerClick('.activity-review');await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.visibility"),'expanded','Review explicitly opens quiet activity');
  assert.equal(await evaluate("document.querySelector('.coding-current-label').textContent"),'No recent activity');
  assert.equal(await evaluate("document.querySelector('.overview').dataset.preview"),'true');
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:400});
  await evaluate("mediaPreview.compact()");await evaluate(settled);
  await evaluate("stopHook('PreToolUse',{tool_name:'Bash',tool_use_id:'stop-run',tool_input:{command:'npm test'}})");
  await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  assert.equal(await evaluate("document.querySelector('.activity-work-title').textContent"),'Running tests');
  await evaluate("stopHook('Interrupt')"); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.activity-work-title').textContent"),'Stopped');
  assert.equal(await evaluate("document.querySelector('.activity-strip').dataset.state"),'stopped');
  assert.equal(await evaluate("document.querySelector('.activity-work-indicator').hidden"),true);
  assert.equal(await evaluate("document.querySelector('.activity-review').hidden"),false);
  assert.equal(await evaluate("mediaPreview.state.tasks.some(t=>t.sessionId==='island-stop')"),false);
  await capture('island-agent-stopped-1x');
  await command('Emulation.setDeviceMetricsOverride',{width:720,height:PANEL_H,deviceScaleFactor:2,mobile:false});
  await evaluate(settled); await capture('island-agent-stopped-2x');
  await pointerClick('.activity-review'); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-current-label').textContent"),'Stopped');
  assert.equal(await evaluate("document.querySelector('.coding-stage[data-stage=Done]').dataset.state"),'inactive');
  assert.equal(await evaluate("mediaPreview.state.codingTask.pillBadge"),null);
  await command('Emulation.setDeviceMetricsOverride',{width:720,height:PANEL_H,deviceScaleFactor:1,mobile:false});
  assert.deepEqual(browserErrors,[]);
});

test("Ongoing service executions use the same blue mini badge and reject stale readings", async (t) => {
  t.after(clearPanelFixture); await panelFixture();
  await evaluate("mediaPreview.preferences({activeIntegrations:['integration_github','integration_vercel','integration_n8n'],usageEnabled:false})");
  await connectedToolFixtures();
  await evaluate(`mediaPreview.state.integrations.integration_vercel.data={deployments:[{state:'BUILDING'}]};
    mediaPreview.state.integrations.integration_n8n.data={executions:[{status:'running'}]};
    mediaPreview.state.notify()`); await evaluate(settled);
  for(const id of ['integration_vercel','integration_n8n']) {
    assert.equal(await evaluate(`document.querySelector('.integration-tile[data-integration=${id}] .mini-notification').dataset.status`),'working');
    assert.match(await evaluate(`document.querySelector('.integration-tile[data-integration=${id}]').getAttribute('aria-label')`),/Working/);
  }
  await evaluate(`mediaPreview.state.integrations.integration_vercel.error='Connection unavailable';
    mediaPreview.state.integrations.integration_n8n.data={workflows:[{active:true}],executions:[{status:'success'}]};
    mediaPreview.state.notify()`); await evaluate(settled);
  for(const id of ['integration_vercel','integration_n8n'])
    assert.equal(await evaluate(`document.querySelector('.integration-tile[data-integration=${id}] .mini-notification')===null`),true);
  assert.deepEqual(browserErrors,[]);
});

test("VS Code terminal uses one flat surface and keeps keyboard scrolling", async (t) => {
  t.after(() => loadPage("Page.reload")); await loadPage("Page.reload");
  await evaluate(`mediaPreview.preferences({codingAssistant:'claude',hooksInstalled:true,modules:{media:false,vscode:true,developerIntegrations:false}});
    mediaPreview.state.setFocus('integration_claude');
    Object.assign(mediaPreview.state.codingTask,{state:'working',steps:['Run'],stepIndex:0,activity:{action:'Run',tool:'Bash',phase:'running',target:'npm test',preview:{lines:Array.from({length:12},(_,index)=>'PASS tests/panel-'+index+'.test.ts')}}});
    mediaPreview.state.notify();mediaPreview.open('integrations')`); await evaluate(settled);
  await pointerClick('.coding-preview-trigger'); await evaluate(settled);
  const terminal=await evaluate(`(()=>{const preview=document.querySelector('.coding-preview'),style=getComputedStyle(preview),card=document.querySelector('.coding-card').getBoundingClientRect(),rect=preview.getBoundingClientRect();return {kind:preview.dataset.kind,corners:[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius],fits:rect.left>=card.left&&rect.right<=card.right&&rect.bottom<=card.bottom,overflow:preview.scrollHeight>preview.clientHeight}})()`);
  assert.equal(terminal.kind,'terminal'); assert.deepEqual(terminal.corners,['0px','0px','0px','0px']); assert.equal(terminal.fits,true); assert.equal(terminal.overflow,true);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-preview')).backgroundColor"),'rgba(0, 0, 0, 0)');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-preview')).borderWidth"),'0px');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-current')).boxShadow"),'none');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-output-copy')).borderWidth"),'1px');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-output-copy')).borderRadius"),'10px');
  const passBadge = await evaluate(`(() => {
    const badges=[...document.querySelectorAll('.coding-preview .code-token[data-result=pass]')];
    const badge=badges[0],style=getComputedStyle(badge),rect=badge.getBoundingClientRect();
    return {count:badges.length,text:badge.parentElement.textContent,fill:style.backgroundColor,
      ink:style.color,radius:style.borderRadius,width:rect.width,height:rect.height};
  })()`);
  assert.deepEqual(passBadge,{count:11,text:'PASS tests/panel-0.test.ts',fill:'rgb(52, 209, 122)',
    ink:'rgb(4, 33, 15)',radius:'4px',width:38,height:24},'Reported PASS labels match the supplied terminal reference');
  await evaluate("document.querySelector('.coding-preview').focus()");
  assert.equal(await evaluate("document.activeElement.classList.contains('coding-preview')"),true);
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35});
  await evaluate(settled);
  assert.ok(await evaluate("document.querySelector('.coding-preview').scrollTop>0"));
  assert.ok(await evaluate("(()=>{const preview=document.querySelector('.coding-preview').getBoundingClientRect(),command=document.querySelector('.coding-line[data-command=true]').getBoundingClientRect();return command.top>=preview.top&&command.bottom<preview.bottom})()"),'The command stays visible above scrolled output');
  await capture('mimo-terminal-flat-dark');
  const reported = ['  PASS tests/invoice.test.ts','FAIL tests/tax.test.ts','Tests: 48 passed, 48 total',
    'skip PASS in a sentence','PASSING stays plain','<script>PASS</script>'];
  await evaluate(`Object.assign(mediaPreview.state.codingTask.activity,{preview:{lines:${JSON.stringify(reported)}},phase:'failed'});mediaPreview.state.notify()`);
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.coding-preview .code-token[data-result]')].map(el=>el.dataset.result)"),['pass','fail']);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-preview [data-result=fail]')).backgroundColor"),
    await evaluate("getComputedStyle(document.querySelector('.coding-stage[data-state=failed]')).color"));
  assert.equal(await evaluate("[...document.querySelectorAll('.coding-preview .coding-line:not([hidden]) .coding-line-text')].map(el=>el.textContent).join('\\n')"),
    ['$ npm test',...reported].join('\n'),'Result styling preserves exact output and reported counts');
  assert.equal(await evaluate("document.querySelector('.coding-preview script')"),null);
  await evaluate("Object.assign(mediaPreview.state.codingTask.activity,{action:'Read',target:'src/invoice.ts',preview:{lines:['const PASS = \"FAIL\";']}});mediaPreview.state.notify()");
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  assert.equal(await evaluate("document.querySelectorAll('.coding-preview [data-result]').length"),0,'Source code never receives terminal badges');
  await evaluate("Object.assign(mediaPreview.state.codingTask.activity,{action:'Run',phase:'complete',target:'node --version',preview:{lines:['v22.0.0']}});mediaPreview.state.notify()");
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  assert.equal(await evaluate("document.querySelectorAll('.coding-preview [data-result]').length"),0,'A completed command does not invent passing tests');
});

test("integration icons reflow keeps empty and error panels compact in both themes", async (t) => {
  t.after(() => loadPage("Page.reload"));
  await loadPage("Page.reload");
  const ids = ['integration_claude','integration_resend','integration_n8n','integration_vercel',
    'integration_github','integration_notion','integration_calcom','integration_stripe'];
  await evaluate(`mediaPreview.preferences({peekEnabled:false,modules:{vscode:true,developerIntegrations:true},
    activeIntegrations:${JSON.stringify(ids.slice(1))}});mediaPreview.open('integrations')`);
  for (const appearance of ['dark']) {
    await evaluate(`mediaPreview.preferences({appearance:'${appearance}'});
      for(const id of ${JSON.stringify(ids)}) mediaPreview.state.integrations[id]={configured:false,loaded:false,error:null,data:{}};
      mediaPreview.state.notify()`);
    assert.equal(await evaluate("document.querySelectorAll('.integration-tile[data-integration]').length"),4,"Enabled unconfigured services remain in the switcher");
    assert.equal(await evaluate("document.querySelectorAll('.integration-tile').length"),4);
    for(const id of ids) {
      await selectIntegration(id);
      await evaluate(settled);
      const compact = await evaluate(`(() => {
        const body=document.querySelector('.module-activity .int-card');
        const outer=document.querySelector('.module-activity').getBoundingClientRect();
        return {overflow:body.scrollHeight-body.clientHeight,
          height:outer.height,title:!!body.querySelector('.int-head b')?.textContent,
          hint:!!body.querySelector('.int-hint')?.textContent,
          actions:[...body.querySelectorAll('button')].every(button=>{
            const r=button.getBoundingClientRect();return r.top>=outer.top&&r.bottom<=outer.bottom;
          })};
      })()`);
      assert.ok(compact.overflow<=1,`${appearance} ${id} has no unnecessary scrollbar`);
      assert.equal(compact.height,124);
      assert.equal(compact.title&&compact.hint&&compact.actions,true);
    }
    await evaluate(`mediaPreview.state.integrations.integration_github={configured:true,loaded:true,
      error:'Connection unavailable. Please refresh.',data:{}};mediaPreview.state.notify()`);
    await evaluate(settled);
    await selectIntegration('integration_github');
    assert.equal(await evaluate(`(() => {const body=document.querySelector('.module-activity .int-card');
      return body.scrollHeight<=body.clientHeight+1 && body.textContent.includes('Connection unavailable')
        && [...body.querySelectorAll('button')].some(button=>button.textContent==='Refresh');})()`),true);
    await capture(`integrations-error-${appearance}`);
  }
});

test("Home, Chat and Mimo Shelf keep three tabs and Now playing reuses the retained player", async () => {
  await evaluate("mediaPreview.preferences({workflowSetupDone:true,modules:{media:true,vscode:true,developerIntegrations:true}});mediaPreview.publish('playing');mediaPreview.open('overview')");await evaluate(settled);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#header .tabs [data-section]:not([hidden])')].map(b=>b.getAttribute('aria-label'))"),['Home','Chat','Mimo Shelf']);
  assert.equal(await evaluate("document.querySelector('.home-view .module-activity')!==null && document.querySelector('.home-view .media-row')===null"),true);
  await pointerClick('[data-home-media]');await evaluate(settled);
  await evaluate("window.retainedPlayer=document.querySelector('.media-row');window.retainedIsland=document.querySelector('#island')");
  for(const destination of ['integrations','utilities','activity','overview']) {
    await evaluate("mediaPreview.open('"+destination+"')");await evaluate(settled);
    assert.equal(await evaluate('mediaPreview.state.view'),'overview');
    assert.equal(await evaluate('mediaPreview.store.snapshot().state.playbackState'),'playing');
  }
  await pointerClick('[data-home-media]');await evaluate(settled);
  assert.equal(await evaluate("retainedPlayer===document.querySelector('.media-row') && retainedIsland===document.querySelector('#island')"),true);
});

test("Home actions open retained chat and file flows and preserve the draft", async () => {
  await evaluate("mediaPreview.open('overview')");await evaluate(settled);
  await pointerClick('[data-section=prompt]');await evaluate(settled);
  assert.equal(await evaluate('mediaPreview.state.view'),'prompt');
  assert.equal(await evaluate("document.querySelector('[data-section=prompt]').getAttribute('aria-current')"),'page');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.chat-input')).outlineStyle"),'none');
  await evaluate("mediaPreview.state.chatDraft='Keep my task';mediaPreview.open('overview');[...document.querySelectorAll('.home-footer button')].find(b=>b.textContent==='Drop a file').click()");await evaluate(settled);
  assert.equal(await evaluate('mediaPreview.state.view'),'upload');
  assert.equal(await evaluate('mediaPreview.state.chatDraft'),'Keep my task');
  await pointerClick('[data-section=overview]');await evaluate(settled);
  assert.equal(await evaluate('mediaPreview.state.view'),'overview');
  await scene('playing');
});

test("source app logos follow the same revisioned source metadata and have a quiet fallback", async () => {
  await scene("playing");
  for (const [source, id, name] of [
    ["Spotify.exe", "spotify", "Spotify"],
    ["chrome.exe", "chrome", "Chrome"],
    ["msedge.exe", "edge", "Microsoft Edge"],
    ["vlc.exe", "vlc", "VLC"],
    ["OtherPlayer.exe", "generic", "OtherPlayer"],
  ]) {
    await evaluate(
      `(() => { const current=mediaPreview.store.snapshot();mediaPreview.store.apply({...current,revision:current.revision+1,state:{...current.state,sourceAppId:${JSON.stringify(source)}}}); })()`,
    );
    assert.equal(
      await evaluate("document.querySelector('.media-source').dataset.source"),
      id,
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.media-source > span').textContent",
      ),
      name,
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.media-source svg').getAttribute('aria-hidden')",
      ),
      "true",
    );
    await evaluate("new Promise(resolve=>setTimeout(resolve,250))");
    if (id === "spotify" || id === "chrome")
      await capture(`sections-media-${id}`);
  }
});

test("Home summary, navigation and glyphs fit every startup DPI scale", async () => {
  for (const scale of [1, 1.25, 1.5, 2]) {
    await command("Emulation.setDeviceMetricsOverride", {
      width: 720,
      height: PANEL_H,
      deviceScaleFactor: scale,
      mobile: false,
    });
    await loadPage("Page.reload");
    await evaluate("new Promise(resolve=>setTimeout(resolve,1200))");
    await evaluate(
      `mediaPreview.publish('playing','Long title '.repeat(60),'Long artist '.repeat(60));mediaPreview.open('media')`,
    );
    await evaluate(settled);
    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('.media-title')).textOverflow",
      ),
      "ellipsis",
    );
    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('.media-artist')).textOverflow",
      ),
      "ellipsis",
    );
    assert.equal(
      await evaluate(
        `(() => { const outer=document.querySelector('#island').getBoundingClientRect();return [...document.querySelectorAll('.home-view.on button, #header button:not([hidden])')].filter(el=>el.getClientRects().length&&!el.closest('[hidden],[inert]')).every(el=>{const r=el.getBoundingClientRect();return r.left>=outer.left && r.right<=outer.right}); })()`,
      ),
      true,
    );
    const icons = await evaluate(
      `(() => [...document.querySelectorAll('.ui-icon')].map(el=>{ const r=el.getBoundingClientRect(); const b=el.getBBox(); const css=getComputedStyle(el); return {width:r.width,height:r.height,layoutWidth:Number.parseFloat(css.width),layoutHeight:Number.parseFloat(css.height),size:Number.parseFloat(el.style.getPropertyValue('--icon-size')),inside:b.x>=0 && b.y>=0 && b.x+b.width<=24 && b.y+b.height<=24}; }).filter(r=>r.width>0 && r.height>0))()`,
    );
    assert.ok(icons.length >= 8);
    for (const glyph of icons) {
      assert.ok(Math.abs(glyph.width - glyph.height) < 0.1);
      // Retained inactive views uniformly scale to .97; layout sizing must still
      // match the declared icon box, and any rendered transform must stay square.
      assert.ok(
        Math.abs(glyph.layoutWidth - glyph.size) < 0.1,
        JSON.stringify(glyph),
      );
      assert.ok(
        Math.abs(glyph.layoutHeight - glyph.size) < 0.1,
        JSON.stringify(glyph),
      );
      assert.equal(glyph.inside, true);
    }
    const gear = await evaluate(
      "(() => {const r=document.querySelector('[aria-label=Settings] path').getBBox(); return [r.width,r.height];})()",
    );
    assert.ok(Math.abs(gear[0] - gear[1]) < 0.01);
    await capture(`sections-home-${scale}x`);
  }
  await command("Emulation.setDeviceMetricsOverride", {
    width: 720,
    height: PANEL_H,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await loadPage("Page.reload");
  await evaluate("new Promise(resolve=>setTimeout(resolve,1200))");
  await scene("playing");
});

test("Dark retains the white mascot, compact artwork, and functional media hover", async () => {
  const masks=await evaluate(`(async () => {
    const {BotEngine}=await import('/src/mimo/engine.ts');
    return ['dark'].map(appearance=>{
      mediaPreview.preferences({appearance});
      const canvas=document.createElement('canvas');canvas.width=160;canvas.height=200;
      const ctx=canvas.getContext('2d');new BotEngine().draw(ctx,160,200);
      return Array.from(ctx.getImageData(0,0,160,200).data);
    });
  })()`);
  assert.ok(masks[0].some((value,index)=>index%4===3&&value>0));
  for(const appearance of ["dark"]) {
    await scene("playing","Balisong","Rivermaya","compact");
    await evaluate(`mediaPreview.preferences({appearance:${JSON.stringify(appearance)},peekEnabled:false,
      modules:{vscode:false,developerIntegrations:false}});
      mediaPreview.publish('playing','Balisong','Rivermaya',{artwork:{dataUrl:mediaPreview.artwork}})`);
    await evaluate(settled);
    const compact=await evaluate(`(() => {
      const island=document.querySelector('#island'),r=island.getBoundingClientRect();
      const cover=document.querySelector('.activity-art'),clock=document.querySelector('.activity-time').getBoundingClientRect();
      const shell=getComputedStyle(island,'::before');
      return {appearance:document.documentElement.dataset.appearance,loaded:cover.complete&&cover.naturalWidth>0,
        clock:Math.abs(clock.x+clock.width/2-r.x-r.width/2),width:r.width,height:r.height,top:r.top,
        radius:getComputedStyle(island).borderBottomLeftRadius,blur:shell.backdropFilter,fill:shell.backgroundColor,
        aura:getComputedStyle(document.querySelector('.activity-strip'),'::after').content};
    })()`);
    assert.equal(compact.appearance,appearance);
    assert.equal(compact.loaded,true);
    assert.ok(compact.clock<0.5);
    assert.equal(Math.round(compact.width),264);assert.equal(Math.round(compact.height),40);assert.equal(compact.top,0);
    assert.equal(compact.radius,"20px");
    assert.equal(compact.blur,"blur(0px)");
    assert.equal(compact.fill,"rgb(0, 0, 0)");
    assert.equal(compact.aura,'none','Compact album art has no light or aura');
    await capture(`appearance-${appearance}-compact`);
    await command("Input.dispatchMouseEvent",{type:"mouseMoved",x:360,y:20});
    await evaluate(settled);
    const hover=await evaluate(`(() => {
      const el=document.querySelector('.media-ambient'),r=document.querySelector('#island').getBoundingClientRect();
      const title=el.querySelector('.media-ambient-title'),artist=el.querySelector('.media-ambient-artist');
      return {title:title.textContent,artist:artist.textContent,loaded:el.querySelector('img').classList.contains('is-loaded'),
        aura:getComputedStyle(el,'::before').content,
        below:artist.getBoundingClientRect().top>=title.getBoundingClientRect().bottom,
        quieter:getComputedStyle(title).color!==getComputedStyle(artist).color,
        buttons:[...el.querySelectorAll('button')].map(b=>{const bounds=b.getBoundingClientRect();
          return {label:b.getAttribute('aria-label'),inside:bounds.left>=r.left&&bounds.right<=r.right};})};
    })()`);
    assert.equal(hover.title,"Balisong");assert.equal(hover.artist,"Rivermaya");assert.equal(hover.loaded,true);
    assert.equal(hover.below,true);assert.equal(hover.quieter,true);
    assert.equal(hover.aura,'none','Hover album art has no light or aura');
    assert.deepEqual(hover.buttons.map(b=>b.label),["Previous track","Pause","Next track"]);
    assert.ok(hover.buttons.every(b=>b.inside));
    await evaluate("mediaPreview.open('media')");
    await evaluate(settled);
    assert.equal(await evaluate("document.querySelector('.media-artwork').classList.contains('has-art')"),true);
    const material=await evaluate("(() => {const shell=getComputedStyle(document.querySelector('#island'),'::before');return {blur:shell.backdropFilter,fill:shell.backgroundColor};})()");
    assert.equal(material.blur,'blur(0px)');
    assert.equal(material.fill,'rgb(0, 0, 0)');
    await capture(`appearance-${appearance}-expanded`);
  }
  await evaluate("mediaPreview.preferences({appearance:'dark',modules:{vscode:true,developerIntegrations:true}})");
});

test("media hover transport works with real pointer clicks for Spotify, browsers and generic sessions", async () => {
  for(const sourceAppId of ["Spotify.exe","chrome.exe","msedge.exe","vlc.exe","OtherPlayer.exe"]) {
    await scene("playing","Track","Artist","compact");
    await evaluate(`mediaPreview.publish('playing','Track','Artist',{sourceAppId:${JSON.stringify(sourceAppId)},artwork:{dataUrl:mediaPreview.artwork}})`);
    await command("Input.dispatchMouseEvent",{type:"mouseMoved",x:360,y:20});
    await evaluate(settled);
    assert.equal(await evaluate("document.querySelector('.media-ambient-image').classList.contains('is-loaded')"),true);
    for(const [selector,action] of [
      ['.media-ambient [aria-label="Previous track"]',"previous"],
      ['.media-ambient-primary',"pause"],['.media-ambient-primary',"play"],
      ['.media-ambient [aria-label="Next track"]',"next"]
    ]) {
      await pointerClick(selector);
      await evaluate("new Promise(resolve=>setTimeout(resolve,30))");
      assert.equal(await evaluate("mediaPreview.actions.at(-1)"),action);
      assert.equal(await evaluate("document.querySelector('#island').dataset.core"),"hover");
    }
  }
});

test("expanded cards fit the shell and leave room above Windows audio", async () => {
  await scene("playing");
  for (const appearance of ["dark"]) {
    await evaluate(`mediaPreview.preferences({appearance:${JSON.stringify(appearance)}})`);
    for (const view of ["overview", "integrations", "utilities", "media"]) {
      await evaluate(`mediaPreview.open(${JSON.stringify(view)})`);
      await evaluate(settled);
      const layout = await evaluate(`(() => {
        const island = document.querySelector('#island');
        const shell = island.getBoundingClientRect();
        const cards = [...document.querySelectorAll('.view.on > .card, .view.on > .media-row, .view.on > .home-workspace')];
        return {height:shell.height, cards:cards.map(card => {
          const r = card.getBoundingClientRect();
          return {left:r.left-shell.left-8, right:shell.right-r.right-8, bottom:shell.bottom-r.bottom,
            radius:parseFloat(getComputedStyle(card).borderBottomLeftRadius),
            shellRadius:parseFloat(getComputedStyle(island).borderBottomLeftRadius)};
        })};
      })()`);
      assert.ok(layout.height <= PANEL_H, `${appearance} ${view} fits the native window`);
      assert.ok(layout.cards.length > 0, `${view} has a visible surface`);
      // Integrations has two adjacent cards; only the outer edges meet the shell.
      assert.ok(Math.abs(layout.cards[0].left - 10) < 0.5, `${appearance} ${view} left gutter`);
      assert.ok(Math.abs(layout.cards.at(-1).right - 10) < 0.5, `${appearance} ${view} right gutter`);
      for (const card of layout.cards) {
        assert.ok(card.bottom >= 9.5, `${appearance} ${view} bottom gutter`);
        assert.ok(Math.abs(card.shellRadius - card.radius - 10) < 0.5,
          `${appearance} ${view} lower corner radii follow their inset`);
      }
      if (view === "integrations") {
        assert.equal(await evaluate(`(() => {
          const card = document.querySelector('[data-module=vscode]');
          return !card || [...card.querySelectorAll('.int-actions button')].every(button => {
            const r = button.getBoundingClientRect(), outer = card.getBoundingClientRect();
            return r.right <= outer.right && r.bottom <= outer.bottom && r.height === 24 && button.title === button.textContent;
          });
        })()`), true, "Integration actions stay on one line with full-label tooltips");
      }
      await capture(`polish-${appearance}-${view}`);
    }
    const player = await evaluate(`(() => {
      const bounds = selector => document.querySelector(selector).getBoundingClientRect();
      const art = bounds('.media-artwork'), timeline = bounds('.media-timeline');
      const audio = bounds('.audio-panel'), disclosure = bounds('.audio-disclosure'), row = bounds('.media-row');
      return {artwork:art.width, timelineGap:timeline.top-art.bottom, audioGap:audio.top-timeline.bottom,
        audioBottom:audio.bottom, rowBottom:row.bottom,
        hit:document.querySelector('.audio-disclosure').contains(document.elementFromPoint(disclosure.x+disclosure.width/2,disclosure.y+disclosure.height/2))};
    })()`);
    assert.equal(player.artwork, 80);
    assert.ok(player.timelineGap >= 11.5);
    assert.ok(player.audioGap >= 11.5, "Windows audio starts below the complete timeline");
    assert.ok(player.audioBottom <= player.rowBottom - 15.5);
    assert.equal(player.hit, true, "The lower audio disclosure receives pointer input");
  }
  await evaluate("mediaPreview.preferences({appearance:'dark'})");
});

test("Phase 1 core centers the clock, uses miniature integrations, and opens the original tool from media hover", async () => {
  for (const appearance of ["dark"]) {
    await scene("none");
    await evaluate(`mediaPreview.preferences({appearance:${JSON.stringify(appearance)},peekEnabled:false,
      modules:{media:true,vscode:true,developerIntegrations:true},
      activeIntegrations:['integration_github','integration_n8n','integration_vercel']});
      mediaPreview.open('overview');mediaPreview.island.visibility.pointerLeft()`);
    await evaluate(settled);
    const idle = await evaluate(`(() => {
      const island=document.querySelector('#island').getBoundingClientRect();
      const clock=document.querySelector('.activity-time').getBoundingClientRect();
      return {height:island.height,offset:Math.abs(clock.x+clock.width/2-island.x-island.width/2),
        cats:document.querySelectorAll('.activity-integrations canvas').length,
        columns:getComputedStyle(document.querySelector('.activity-integrations')).gridTemplateColumns};
    })()`);
    assert.equal(Math.round(idle.height), 40);
    assert.ok(idle.offset < 0.5, "The clock is centered independently of the integration grid");
    assert.equal(idle.cats, 4);
    assert.equal(idle.columns.split(" ").length, 2);
    await capture(`phase1-${appearance}-idle`);

    await evaluate("mediaPreview.publish('playing','Die With A Smile','Lady Gaga, Bruno Mars',{artwork:{dataUrl:mediaPreview.artwork}})");
    await evaluate(settled);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#bot-canvas')).opacity"), "0");
    assert.equal(await evaluate("document.querySelector('.activity-strip').dataset.kind"), "music");
    assert.equal(await evaluate("document.querySelector('.media-ambient').getAttribute('aria-hidden')"), "true");
    await capture(`phase1-${appearance}-music`);

    await command("Input.dispatchMouseEvent", {type:"mouseMoved",x:360,y:20});
    await evaluate(settled);
    assert.equal(await evaluate("document.querySelector('#island').dataset.core"), "hover");
    assert.equal(Math.round((await inspect()).height), 48);
    assert.equal(await evaluate("document.querySelector('.media-ambient-title').textContent"), "Die With A Smile");
    await capture(`phase1-${appearance}-hover`);
    await pointerClick(".media-ambient-primary");
    assert.equal(await evaluate("mediaPreview.store.snapshot().state.playbackState"), "paused");
    assert.equal(await evaluate("document.querySelector('#island').dataset.core"), "hover");
    await pointerClick("#restore-island");
    await evaluate(settled);
    assert.equal(await evaluate("mediaPreview.state.view"), "media");
    assert.equal(await evaluate("document.querySelector('#island').dataset.core"), "app");
    assert.equal(await evaluate("document.querySelector('#header').getBoundingClientRect().height>0"), true);
    assert.equal(await evaluate("document.querySelector('.audio-disclosure').textContent.includes('Windows audio')"), true);
    assert.equal(Math.round((await inspect()).height), 52 + MEDIA_VIEW_CARD_HEIGHT);
    await capture(`phase1-${appearance}-full-media`);

    await scene("none");
    await evaluate("mediaPreview.preferences({peekEnabled:true});mediaPreview.hide()");
    await evaluate(settled);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.mimo-sleep-glyphs')).display"), "block");
    await capture(`phase1-${appearance}-sleep`);
  }
});

test("Phase 1 paused compact buttons stay stationary through real pointer playback and body hover still opens immediately", async () => {
  await evaluate("mediaPreview.preferences({peekEnabled:false,modules:{media:true}})");
  await scene("paused", "Night Drive", "The Midnight", "compact");
  const point = await evaluate(`(() => {const r=document.querySelector('.media-ambient-primary').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  // Approach from below through the native 14px hit margin before reaching the button.
  await command("Input.dispatchMouseEvent", {type:"mouseMoved",x:point.x,y:52});
  await evaluate("new Promise(resolve=>setTimeout(resolve,250))");
  assert.equal(await evaluate("mediaPreview.state.visibility"), "island",
    JSON.stringify(await evaluate(`({point:${JSON.stringify(point)},core:mediaPreview.island.coreMode,
      mediaCore:mediaPreview.island.media.coreMode,held:mediaPreview.island.compactControlsHeld,
      hit:mediaPreview.island.media.compactControlHit(${point.x},52,14),
      ambient:document.querySelector('.media-ambient').className})`)));
  await pointerClick(".media-ambient-primary");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.visibility"), "island");
  assert.equal(await evaluate("mediaPreview.store.snapshot().state.playbackState"), "playing");
  const resumed = await evaluate(`(() => {const r=document.querySelector('.media-ambient-primary').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  assert.ok(Math.abs(resumed.x-point.x)<0.5 && Math.abs(resumed.y-point.y)<0.5, "Resuming keeps the clicked control in place");
  await pointerClick(".media-ambient-skip:last-child");
  assert.equal(await evaluate("mediaPreview.actions.at(-1)"), "next");
  assert.equal(await evaluate("mediaPreview.state.visibility"), "island");
  await capture("phase1-paused-controls-held");
  await command("Input.dispatchMouseEvent", {type:"mouseMoved",x:360,y:20});
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('#island').dataset.core"), "hover");
  assert.equal(Math.round((await inspect()).height), 48);
  await command("Input.dispatchMouseEvent", {type:"mouseMoved",x:0,y:383});
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.visibility"), "island");
  assert.equal(Math.round((await inspect()).height), 40);
});

test("Phase 1 Media removes unused space below Windows audio for collapsed and empty players", async () => {
  await evaluate("mediaPreview.preferences({peekEnabled:false,modules:{media:true}})");
  await scene("paused");
  await pointerClick(".audio-disclosure");
  await evaluate(settled);
  assert.equal(Math.round((await inspect()).height), 52 + MEDIA_VIEW_COLLAPSED_HEIGHT);
  const trailingSpace = () => evaluate(`(() => {const card=document.querySelector('.media-page .media-row')??document.querySelector('.media-page .section-empty');
    return card.getBoundingClientRect().bottom-document.querySelector('.audio-disclosure').getBoundingClientRect().bottom;})()`);
  assert.ok(await trailingSpace()<=20, "A collapsed player ends at the normal card padding");
  await capture("phase1-media-collapsed");
  await scene("none");
  assert.equal(Math.round((await inspect()).height), 52 + MEDIA_EMPTY_COLLAPSED_HEIGHT);
  assert.ok(await trailingSpace()<=20, "An empty player has no reserved artwork or timeline gap");
  await capture("phase1-media-empty-collapsed");
  await pointerClick(".audio-disclosure");
  await evaluate(settled);
  assert.equal(Math.round((await inspect()).height), 52 + MEDIA_EMPTY_CARD_HEIGHT);
});

test("Phase 1 sleep settles, retracts above the screen, and wakes only from the top edge", async () => {
  await scene("none");
  await evaluate("mediaPreview.preferences({peekEnabled:true});mediaPreview.open('overview');mediaPreview.hide()");
  await evaluate(settled);
  assert.ok(await evaluate("mediaPreview.island.botSize.value*.6<=34.1"), "Sleeping Mimo fits a compact 34 px silhouette");
  assert.ok(await evaluate("document.querySelector('#island').getBoundingClientRect().width<=96.1"));
  assert.ok(await evaluate("document.querySelector('#island').getBoundingClientRect().height<=32.1"));
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#bot-canvas')).animationName"),"mimo-sleep");
  assert.equal(await evaluate("document.querySelector('#island').dataset.peekHidden"),"false");
  const sleeping = await evaluate("(() => {const glyphs=[...document.querySelectorAll('.mimo-sleep-glyphs svg')];return {breath:getComputedStyle(document.querySelector('#bot-canvas')).transform,glyphs:glyphs.map(glyph=>({transform:getComputedStyle(glyph).transform,opacity:getComputedStyle(glyph).opacity})),delays:glyphs.map(glyph=>getComputedStyle(glyph).animationDelay)};})()");
  await evaluate("new Promise(resolve=>setTimeout(resolve,200))");
  const breathing = await evaluate("({breath:getComputedStyle(document.querySelector('#bot-canvas')).transform,glyphs:[...document.querySelectorAll('.mimo-sleep-glyphs svg')].map(glyph=>({transform:getComputedStyle(glyph).transform,opacity:getComputedStyle(glyph).opacity}))})");
  assert.notEqual(breathing.breath,sleeping.breath,"Sleeping Mimo breathes continuously");
  assert.notDeepEqual(breathing.glyphs,sleeping.glyphs,"The Zs rise and fade instead of remaining static");
  assert.equal(new Set(sleeping.delays).size,3,"The Zs are staggered");
  await evaluate("new Promise(resolve=>setTimeout(resolve,1900))");
  const retract=await evaluate(`(() => {const style=getComputedStyle(document.querySelector('#bot-canvas'));return {hidden:document.querySelector('#island').dataset.peekHidden,shift:parseFloat(style.translate.split(' ')[1])};})()`);
  assert.equal(retract.hidden,"true");
  assert.ok(retract.shift<0&&retract.shift>-56,"The head retracts continuously instead of jumping");
  await evaluate("new Promise(resolve=>setTimeout(resolve,800))");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#bot-canvas')).opacity"),"0");
  assert.equal(await evaluate("mediaPreview.island.pushedRect.h"),6);
  assert.equal(await evaluate("mediaPreview.island.running"),false,"Sleeping keeps the app frame loop parked");
  await command("Input.dispatchMouseEvent",{type:"mouseMoved",x:360,y:36});
  assert.equal(await evaluate("mediaPreview.state.visibility"),"peek","The area below the top wake target stays inactive");
  await command("Input.dispatchMouseEvent",{type:"mouseMoved",x:360,y:2});
  await evaluate("new Promise(resolve=>setTimeout(resolve,80))");
  assert.equal(await evaluate("mediaPreview.state.visibility"),"peek","Mimo appears before the full tool opens");
  assert.equal(await evaluate("document.querySelector('#island').dataset.peekWaking"),"true");
  assert.equal(await evaluate("mediaPreview.island.engine.state"),"idle");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.visibility"),"expanded");
  assert.equal(await evaluate("document.querySelector('#island').dataset.core"),"app");
  assert.equal(await evaluate("mediaPreview.state.view"),"overview");
  assert.equal(await evaluate("document.querySelector('#island').dataset.peekHidden"),"false");
  await command("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
  await command("Input.dispatchMouseEvent",{type:"mouseMoved",x:0,y:383});
  await evaluate("mediaPreview.hide()");
  await evaluate("new Promise(resolve=>setTimeout(resolve,3100))");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#bot-canvas')).opacity"),"0");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.mimo-sleep-glyphs svg')).animationName"),"none");
  await command("Emulation.setEmulatedMedia",{features:[]});
  await evaluate("mediaPreview.preferences({peekEnabled:false});mediaPreview.open('media')");
});

test("Phase 1 equalizer responds to quiet measured audio, smooths release, and clears on mute", async () => {
  await evaluate("mediaPreview.publishAudio(48,false,'preview-output')");
  await scene("playing","Track","Artist","compact");
  await evaluate(`mediaPreview.publish('playing','Track','Artist',{sourceAppId:'Spotify.exe'});
    mediaPreview.levels.apply({revision:mediaPreview.levels.snapshot().revision+1,available:true,peak:0})`);
  await command("Input.dispatchMouseEvent",{type:"mouseMoved",x:360,y:20});
  await evaluate(settled);
  const levels=peak=>evaluate(`(() => {
    mediaPreview.levels.apply({revision:mediaPreview.levels.snapshot().revision+1,available:true,peak:${peak}});
    return [...document.querySelectorAll('.media-ambient .spotify-equalizer i')].map(bar=>Number(bar.style.transform.slice(7,-1)));
  })()`);
  const quiet=await levels(30);
  assert.ok(Math.max(...quiet)>0.17,"Quiet passages visibly lift the bars");
  const loud=await levels(700);
  assert.ok(Math.max(...loud)>Math.max(...quiet)+0.4,"A real peak gets a fast response");
  const release=await levels(0);
  assert.ok(release[0]<loud[0]&&Math.max(...release)>0.1,"The leading edge releases smoothly while the peak moves right");
  for (let sample=0;sample<30;sample++) await levels(950);
  let pulsing;
  for (const peak of [820,1000,880,970,840,1000]) pulsing=await levels(peak);
  assert.ok(Math.max(...pulsing)-Math.min(...pulsing)>.15,"Loud passages still contain lower pulses");
  assert.equal(await evaluate("document.querySelector('.media-ambient .spotify-equalizer').dataset.measured"),"true");
  await evaluate("mediaPreview.publishAudio(48,true,'preview-output')");
  assert.deepEqual(await levels(700),[0.1,0.1,0.1,0.1,0.1,0.1]);
  await evaluate("mediaPreview.publishAudio(48,false,'preview-output');mediaPreview.open('media')");
});

test("wake opens the full tool directly and native window resizing preserves the transition", async (t) => {
  t.after(async () => {
    await evaluate("for(const event of ['mousemove','mouseout','pointerenter','pointerleave']) window.removeEventListener(event,window.nativeCursorOnly,true);delete window.nativeCursorOnly");
    await command("Emulation.setDeviceMetricsOverride", {width:720,height:PANEL_H,deviceScaleFactor:1,mobile:false});
    await command("Input.dispatchMouseEvent", {type:"mouseMoved",x:0,y:383});
    await evaluate("mediaPreview.preferences({peekEnabled:false});mediaPreview.open('media')");
  });
  await scene("none");
  await evaluate("mediaPreview.preferences({peekEnabled:true});mediaPreview.open('overview');mediaPreview.hide()");
  await evaluate("new Promise(resolve=>setTimeout(resolve,3700))");
  // Native windows recenter on the desktop; CDP viewport emulation does not.
  await evaluate("window.nativeCursorOnly=event=>event.stopImmediatePropagation();for(const event of ['mousemove','mouseout','pointerenter','pointerleave']) window.addEventListener(event,window.nativeCursorOnly,true)");
  await command("Emulation.setDeviceMetricsOverride", {width:104,height:48,deviceScaleFactor:1,mobile:false});
  const start = await evaluate("performance.now()");
  await evaluate("mediaPreview.island.onCursor(52,2,{x:52,y:2,screenX:960,screenY:2,windowWidth:104})");
  await evaluate("new Promise(resolve=>setTimeout(resolve,100))");
  assert.equal(await evaluate("mediaPreview.state.visibility"),"peek");
  assert.equal(await evaluate("document.querySelector('#island').dataset.peekWaking"),"true");
  const buffer = await evaluate("[document.querySelector('#bot-canvas').width,document.querySelector('#bot-canvas').height]");
  await evaluate("window.wakeModes=[];window.stopWakeModes=mediaPreview.island.visibility.subscribe((from,to)=>window.wakeModes.push(to))");
  await evaluate(`new Promise(resolve => {
    const until=()=>mediaPreview.state.visibility==='expanded'?resolve():requestAnimationFrame(until);
    until();
  })`);
  assert.ok(await evaluate(`performance.now()-${start}`)<400,"The initial reveal ends well below a second");
  // Same desktop cursor; only its coordinates inside the centered window change.
  // Deliver it before the WebView receives its new viewport width, too.
  await evaluate("mediaPreview.island.onCursor(360,2,{x:360,y:2,screenX:960,screenY:2,windowWidth:720})");
  await command("Emulation.setDeviceMetricsOverride", {width:720,height:PANEL_H,deviceScaleFactor:1,mobile:false});
  await evaluate("mediaPreview.island.onCursor(360,2,{x:360,y:2,screenX:960,screenY:2,windowWidth:720})");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.visibility"),"expanded");
  assert.equal(await evaluate("document.querySelector('#island').dataset.core"),"app");
  assert.equal(await evaluate("Math.round(document.querySelector('#island').getBoundingClientRect().width)"),640);
  assert.deepEqual(await evaluate("window.wakeModes"),["expanded"],"Wake never visits the compact island or shallow player");
  await evaluate("window.stopWakeModes();delete window.stopWakeModes;delete window.wakeModes");
  assert.deepEqual(await evaluate("[document.querySelector('#bot-canvas').width,document.querySelector('#bot-canvas').height]"),buffer,"The companion buffer stays allocated throughout the morph");
  await evaluate("mediaPreview.island.onCursor(366,20,{x:366,y:20,screenX:966,screenY:20,windowWidth:720})");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.visibility"),"expanded","Actual movement keeps the open tool stable");
});

test("media hover exit reveals sleeping Mimo without a gap and hides him only after retraction", async () => {
  await scene("playing", "Track", "Artist", "compact");
  await evaluate("mediaPreview.preferences({peekEnabled:true})");
  await command("Input.dispatchMouseEvent", {type:"mouseMoved",x:360,y:20});
  await evaluate(settled);
  await command("Input.dispatchMouseEvent", {type:"mouseMoved",x:0,y:383});
  await evaluate(`new Promise(resolve => {
    const until=()=>mediaPreview.state.visibility==='peek'?resolve():requestAnimationFrame(until);
    until();
  })`);
  await evaluate("new Promise(resolve=>setTimeout(resolve,120))");
  assert.ok(await evaluate("Number(getComputedStyle(document.querySelector('#bot-canvas')).opacity)")>.5,
    "Sleep begins revealing the companion immediately");
  await evaluate("new Promise(resolve=>setTimeout(resolve,2750))");
  assert.equal(await evaluate("document.querySelector('#island').dataset.peekHidden"),"true");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#bot-canvas')).opacity"),"1",
    "The head remains visible while it slides above the screen");
  await evaluate("new Promise(resolve=>setTimeout(resolve,750))");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#bot-canvas')).opacity"),"0");
  await evaluate("mediaPreview.preferences({peekEnabled:false});mediaPreview.open('media')");
});

test("equalizer follows browser and generic player meters without reacting to unrelated audio", async () => {
  await evaluate("mediaPreview.publishAudio(48,false,'preview-output')");
  for (const source of ["chrome.exe","msedge.exe","vlc.exe"]) {
    await scene("playing", "Track", "Artist", "compact");
    await evaluate(`mediaPreview.publish('playing','Track','Artist',{sourceAppId:${JSON.stringify(source)}});
      mediaPreview.levels.apply({revision:mediaPreview.levels.snapshot().revision+1,available:true,peak:0,
        sources:{${JSON.stringify(source)}:30,'discord.exe':1000}})`);
    const read = () => evaluate("[...document.querySelectorAll('.activity-strip .spotify-equalizer i')].map(bar=>Number(bar.style.transform.slice(7,-1)))");
    assert.equal(await evaluate("document.querySelector('.activity-strip .spotify-equalizer').dataset.measured"),"true");
    const quiet=await read();
    assert.ok(Math.max(...quiet)>.17&&Math.max(...quiet)<.4,"Unrelated loud audio cannot lift the playing source's meter");
    await evaluate(`mediaPreview.levels.apply({revision:mediaPreview.levels.snapshot().revision+1,available:true,peak:0,
      sources:{${JSON.stringify(source)}:700,'discord.exe':0}})`);
    assert.ok(Math.max(...await read())>Math.max(...quiet)+.4);
  }
  await evaluate("mediaPreview.levels.apply({revision:mediaPreview.levels.snapshot().revision+1,available:false,peak:0});mediaPreview.open('media')");
});

test("equalizer measures packaged players and unidentified media, and rests on pause or mute", async () => {
  await evaluate("mediaPreview.publishAudio(48,false,'preview-output')");
  for (const [source, meter] of [
    ['Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic','microsoft.media.player.exe'],
    ['VideoLAN.VLC_paz6r1rewnh0a!App','vlc.exe'],
    ['OtherPackagedPlayer_123!Player','other-player.exe'],
  ]) {
    await scene('playing','Track','Artist','compact');
    await evaluate(`mediaPreview.levels.apply({revision:mediaPreview.levels.snapshot().revision+1,available:true,peak:30,
        sources:{${JSON.stringify(meter)}:30}});
      mediaPreview.publish('playing','Track','Artist',{sourceAppId:${JSON.stringify(source)}})`);
    const read = () => evaluate("[...document.querySelectorAll('.activity-strip .spotify-equalizer i')].map(bar=>Number(bar.style.transform.slice(7,-1)))");
    const quiet = await read();
    assert.equal(await evaluate("document.querySelector('.activity-strip .spotify-equalizer').dataset.measured"), 'true');
    await evaluate(`mediaPreview.levels.apply({revision:mediaPreview.levels.snapshot().revision+1,available:true,peak:700,
      sources:{${JSON.stringify(meter)}:700}})`);
    assert.ok(Math.max(...await read()) > Math.max(...quiet) + .4, source);
    await evaluate("mediaPreview.publishAudio(48,true,'preview-output')");
    assert.ok((await read()).every(value => value === .1));
    await evaluate(`mediaPreview.publishAudio(48,false,'preview-output');mediaPreview.publish('paused','Track','Artist',{sourceAppId:${JSON.stringify(source)}})`);
    assert.ok((await read()).every(value => value === .1));
  }
  await evaluate("mediaPreview.levels.apply({revision:mediaPreview.levels.snapshot().revision+1,available:false,peak:0});mediaPreview.open('media')");
});

test("VS Code hooks show ready without a data fetch and keep Mimo white", async (t) => {
  const original = await evaluate("JSON.parse(JSON.stringify(mediaPreview.state.settings))");
  const previous = await evaluate("mediaPreview.state.integrations.integration_claude ?? null");
  t.after(async () => {
    await evaluate(`mediaPreview.preferences(${JSON.stringify(original)});
      ${previous ? `mediaPreview.state.integrations.integration_claude=${JSON.stringify(previous)}` : "delete mediaPreview.state.integrations.integration_claude"};
      mediaPreview.state.notify();mediaPreview.open('media')`);
    await evaluate(settled);
  });
  await scene("none");
  await evaluate(`(async()=>{mediaPreview.preferences({hooksInstalled:false,peekEnabled:false,modules:{vscode:true,developerIntegrations:false}});
    mediaPreview.state.updateTask('integration_claude','idle');
    const {refreshConfigured}=await import('/src/island/integrations.ts');
    await refreshConfigured();mediaPreview.open('integrations');})()`);
  await evaluate(settled);
  await selectIntegration('integration_claude');
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.int-status').textContent"), "Hooks not installed");
  await evaluate(`(async()=>{mediaPreview.state.settings.hooksInstalled=true;
    const {refreshConfigured}=await import('/src/island/integrations.ts');await refreshConfigured();})()`);
  await evaluate(settled);
  const ready = await evaluate(`(() => {
    const info=mediaPreview.state.integrations.integration_claude;
    const engine=mediaPreview.island.engine;
    return {configured:info.configured,loaded:info.loaded,label:document.querySelector('.int-status').textContent,
      color:engine.faceColor,tile:engine.tile};
  })()`);
  assert.equal(ready.configured,true);
  assert.equal(ready.loaded,true);
  assert.equal(ready.label,"Connected","Installed hooks have no pending fetch");
  assert.equal(ready.tile,false);
  assert.ok(ready.color.every((value,i)=>Math.abs(value-[247/255,245/255,242/255][i])<.005));
  await capture("vscode-white-ready");
});

test("Settings restores the separate pages and removes Downloads", async (t) => {
  t.after(async () => {
    await command("Emulation.clearDeviceMetricsOverride");
    await loadPage("Page.navigate", { url: "http://127.0.0.1:1431/dev/media-preview.html" });
  });
  await command("Emulation.setDeviceMetricsOverride", { width: 760, height: 640, deviceScaleFactor: 1, mobile: false });
  await loadPage("Page.navigate", { url: "http://127.0.0.1:1431/settings.html" });
  await evaluate("new Promise(resolve=>setTimeout(resolve,400))");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.settings-nav-item span')].map(el=>el.textContent)"),
    ["General", "Media", "Chat", "Modules", "Integrations", "Usage", "Hotkeys", "About"]);
  assert.equal(await evaluate("document.body.textContent.includes('Downloads')"), false);
  assert.equal(await evaluate("document.querySelector('.watched-project,#watch-cwd')"), null);
  assert.equal(await evaluate("document.querySelector('#settings-general .settings-assistant')"), null);
  assert.equal(await evaluate("document.querySelector('#settings-chat [data-chat-provider=openai]')!==null"), true);
  assert.equal(await evaluate("document.querySelector('#settings-modules .settings-assistant')!==null"), true);
  assert.equal(await evaluate("document.querySelector('#settings-about').textContent.includes('John Paul')"), false);
  for (const [width, height, scale] of [[620,480,1],[760,640,1.5]]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
    for (const id of ["general", "media", "chat", "modules", "integrations", "usage", "hotkeys", "about"]) {
      await pointerClick(`[aria-controls=settings-${id}]`);
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.settings-page:not([hidden])')].map(el=>el.id)"), [`settings-${id}`]);
      assert.equal(await evaluate("[...document.querySelectorAll('.settings-page[hidden]')].every(el=>el.inert)"), true);
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
    }
  }
  await pointerClick('[aria-controls=settings-general]');
  await capture("checkpoint-settings-general");
  assert.deepEqual(browserErrors, []);
});

test("Settings dropdowns use the shared premium picker without overextending", async (t) => {
  t.after(async () => {
    await command("Emulation.setDeviceMetricsOverride", {
      width:720,height:PANEL_H,deviceScaleFactor:1,mobile:false,
    });
    await loadPage("Page.navigate", {
      url: "http://127.0.0.1:1431/dev/media-preview.html",
    });
    await scene("playing");
  });
  await loadPage("Page.navigate", {
    url: "http://127.0.0.1:1431/settings.html",
  });
  await evaluate("new Promise(resolve=>setTimeout(resolve,400))");
  assert.equal(
    await evaluate("document.querySelector('#settings-general .audio-panel') === null"),
    true,
    "Windows audio belongs in the island rather than Settings",
  );
  assert.equal(
    await evaluate("document.querySelector('#settings-modules [role=switch][aria-label=Media]') !== null"),
    true,
    "The Media module preference remains available",
  );
  assert.equal(await evaluate("document.querySelectorAll('select').length"), 0);
  assert.equal(await evaluate("document.querySelector('#appearance-mode')===null"), true);
  const assertMenuFits = async (selector) => {
    const fit = await evaluate(`(() => {
      const anchor=document.querySelector(${JSON.stringify(selector)}).closest('.audio-device-picker').getBoundingClientRect();
      const menu=document.querySelector('.audio-device-menu:popover-open').getBoundingClientRect();
      return {delta:Math.abs(anchor.width-menu.width),left:menu.left,right:menu.right,
        top:menu.top,bottom:menu.bottom,width:innerWidth,height:innerHeight};
    })()`);
    assert.ok(fit.delta<1,`Menu matches its control: ${JSON.stringify(fit)}`);
    assert.ok(fit.left>=12 && fit.right<=fit.width-11);
    assert.ok(fit.top>=8 && fit.bottom<=fit.height-7);
  };
  for (const [width,height,scale] of [[620,480,1],[760,640,1.25],[760,640,1.5],[760,640,2]]) {
    await command("Emulation.setDeviceMetricsOverride", {width,height,deviceScaleFactor:scale,mobile:false});
    await pointerClick(".settings-display");
    await evaluate("new Promise(resolve=>setTimeout(resolve,220))");
    await assertMenuFits(".settings-display");
    await evaluate("document.querySelector('.audio-device-menu:popover-open').hidePopover()");
  }
  await capture("settings-premium-dropdown");
  const settingsFill = await evaluate("getComputedStyle(document.body).backgroundColor");
  assert.equal(settingsFill, "rgb(6, 6, 6)", "Settings uses the reference's black shell");
  for (const trigger of [".settings-display", ".settings-assistant"]) {
    if (trigger === ".settings-assistant")
      await pointerClick('[aria-controls="settings-modules"]');
    await pointerClick(trigger);
    await evaluate("new Promise(resolve=>setTimeout(resolve,220))");
    await assertMenuFits(trigger);
    const next = await evaluate(
      "document.querySelector('.audio-device-menu:popover-open [role=option]:not([aria-selected=true])').dataset.device",
    );
    await pointerClick(
      `.audio-device-menu:popover-open [data-device=${JSON.stringify(next)}]`,
    );
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(trigger)}).closest('.audio-device-picker').querySelector('[aria-selected=true]').dataset.device`,
      ),
      next,
    );
    assert.equal(
      await evaluate(
        "document.querySelectorAll('.audio-device-menu:popover-open').length",
      ),
      0,
    );
  }
  await command("Emulation.setDeviceMetricsOverride", {
    width:720,height:PANEL_H,deviceScaleFactor:1,mobile:false,
  });
  await loadPage("Page.navigate", {
    url: "http://127.0.0.1:1431/dev/media-preview.html",
  });
  await scene("playing");
});

test("Legacy Glass preferences migrate to Dark through Settings save and Light is absent", async () => {
  const init = await command("Page.addScriptToEvaluateOnNewDocument", {
    source: "window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(cmd,args)=>{if(cmd==='boot')return {settings:JSON.parse(localStorage.getItem('appearance-settings-test')||'{}'),version:'test'};if(cmd==='save_settings'){localStorage.setItem('appearance-settings-test',JSON.stringify(args.settings));return null;}if(cmd==='secret_present')return false;if(cmd==='plugin:event|listen')return 1;return null;}};",
  });
  try {
    await evaluate("localStorage.setItem('appearance-settings-test',JSON.stringify({appearance:'glass',soundEnabled:false,activeIntegrations:['integration_github']}))");
    await loadPage("Page.navigate",{url:"http://127.0.0.1:1431/settings.html"});
    await evaluate("new Promise(resolve=>setTimeout(resolve,400))");
    assert.equal(await evaluate("document.documentElement.dataset.appearance"),'dark');
    assert.equal(await evaluate("document.querySelector('#appearance-mode')"),null);
    assert.equal(await evaluate("document.querySelector('[data-device=light]')"),null);
    await pointerClick('[role=switch][aria-label="Working mode"]');
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Grab Mimo\"]').getAttribute('aria-checked')"),'true');
    await pointerClick('[role=switch][aria-label="Grab Mimo"]');
    const saved=await evaluate("JSON.parse(localStorage.getItem('appearance-settings-test'))");
    assert.equal(saved.appearance,'dark');assert.equal(saved.soundEnabled,false);
    assert.equal(saved.grabEnabled,false);
    assert.deepEqual(saved.activeIntegrations,['integration_github']);
    await loadPage("Page.reload");await evaluate("new Promise(resolve=>setTimeout(resolve,400))");
    assert.equal(await evaluate("document.documentElement.dataset.appearance"),'dark');
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Working mode\"]').getAttribute('aria-checked')"),String(saved.workingModeEnabled));
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Grab Mimo\"]').getAttribute('aria-checked')"),'false');
    await capture('appearance-migrated-dark-settings');
  }finally{
    await evaluate("localStorage.removeItem('appearance-settings-test')");
    await command("Page.removeScriptToEvaluateOnNewDocument",{identifier:init.identifier});
    await loadPage("Page.navigate",{url:"http://127.0.0.1:1431/dev/media-preview.html"});
  }
});

test("Mimo family renders cleanly at actual sizes on dark and light surfaces", async (t) => {
  t.after(async () => {
    await command("Emulation.setDeviceMetricsOverride", {
      width: 720,
      height: PANEL_H,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await loadPage("Page.navigate", {
      url: "http://127.0.0.1:1431/dev/media-preview.html",
    });
  });
  await command("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 780,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await loadPage("Page.navigate", {
    url: "http://127.0.0.1:1431/dev/icon-preview.html",
  });
  assert.equal(await evaluate("window.iconPreviewReady"), true);
  const expected = [
    "companion",
    "winter",
    "compact-mode",
    "expand",
    "collapse",
    "music-mode",
    "affection",
    "mood",
    "sleep",
    "wake",
    "secret",
    "unlock",
    "summon-mimo",
    "interaction",
    "achievement",
    "pin",
    "appearance",
    "light-mode",
    "dark-mode",
    "sound",
    "sound-off",
    "sound-low",
    "sound-medium",
    "home",
  ];
  const samples =
    await evaluate(`(() => [...document.querySelectorAll('.mimo-icon')].map(el => {
    const bounds = el.getBoundingClientRect(); const art = el.getBBox();
    const path = el.querySelector('path'); const style = getComputedStyle(el);
    return { name: el.dataset.mimoIcon, size: Number(el.getAttribute('width')),
      width: bounds.width, height: bounds.height, stroke: style.strokeWidth,
      caps: style.strokeLinecap, joins: style.strokeLinejoin, color: el.getAttribute('stroke')==='none'?style.fill:style.stroke,
      filled: el.getAttribute('stroke')==='none',
      surface: el.closest('.sheet').dataset.surface, surfaceColor: getComputedStyle(el.closest('.sheet')).color, hidden: el.getAttribute('aria-hidden'),
      focusable: el.getAttribute('focusable'), nodes: el.children.length,
      pathLength: path.getTotalLength(), art: {x:art.x,y:art.y,width:art.width,height:art.height} };
  }))()`);
  assert.equal(samples.length, expected.length * 4 * 2);
  await capture("mimo-icon-family-actual-sizes");
  assert.deepEqual(
    [...new Set(samples.map((icon) => icon.name))].sort(),
    expected.sort(),
  );
  for (const sample of samples) {
    const context = `${sample.name} ${sample.size}px ${sample.surface}`;
    assert.equal(sample.width, sample.size, context);
    assert.equal(sample.height, sample.size, context);
    if (!sample.filled) {
      assert.equal(sample.stroke, "1.6px", context);
      assert.equal(sample.caps, "round", context);
      assert.equal(sample.joins, "round", context);
    }
    assert.equal(sample.hidden, "true", context);
    assert.equal(sample.focusable, "false", context);
    assert.equal(sample.nodes, 1, context);
    assert.ok(
      Number.isFinite(sample.pathLength) && sample.pathLength > 20,
      context,
    );
    assert.ok(sample.art.x >= 2 && sample.art.y >= 2, context);
    assert.ok(sample.art.x + sample.art.width <= 22, context);
    assert.ok(sample.art.y + sample.art.height <= 22, context);
    assert.equal(
      sample.color,
      sample.surfaceColor,
      context,
    );
  }
  // Rasterize the actual 16px glyphs, including strokes. Reject clipped edges,
  // invisible glyphs, or dense blobs even when their SVG geometry is valid.
  const rasters = await evaluate(`(async () => {
    const results = [];
    for (const el of document.querySelectorAll('.sheet[data-surface="dark"] svg[width="16"]')) {
      const copy = el.cloneNode(true); copy.setAttribute('xmlns','http://www.w3.org/2000/svg');
      copy.setAttribute('style','color:black');
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], {type:'image/svg+xml'}));
      try {
        const img = new Image(); img.src = url; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
        const pixels = ctx.getImageData(0,0,16,16).data; let ink = 0, edge = 0;
        for(let y=0;y<16;y++) for(let x=0;x<16;x++) {
          const a = pixels[(y*16+x)*4+3]; ink += a / 255;
          if(x === 0 || y === 0 || x === 15 || y === 15) edge += a;
        }
        results.push({name:el.dataset.mimoIcon, ink, edge});
      } finally { URL.revokeObjectURL(url); }
    }
    return results;
  })()`);
  for (const raster of rasters) {
    assert.equal(
      raster.edge,
      0,
      `${raster.name} touches the 16px viewport edge`,
    );
    assert.ok(
      raster.ink >= 20 && raster.ink <= 105,
      `${raster.name} lost its negative space`,
    );
  }
  // Measure rendered ink through the middle of a straight stroke, not just an
  // SVG attribute. Small functional glyphs must keep their optical weight.
  const weights = await evaluate(`(async () => {
    const { mimoIcon } = await import('/src/icons/render.ts');
    const { icon } = await import('/src/views/icons.ts');
    const results = [];
    for (const size of [16,18,20,24]) for (const family of ['mimo','universal']) {
      const el = family === 'mimo'
        ? mimoIcon({name:'stroke-probe',path:'M6 12h12'},size)
        : icon('M6 11h12v2H6Z',size);
      el.setAttribute('xmlns','http://www.w3.org/2000/svg');
      el.style.color = 'black';
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(el)], {type:'image/svg+xml'}));
      try {
        const img = new Image(); img.src = url; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img,0,0);
        const pixels = ctx.getImageData(size/2,0,1,size).data;
        let weight = 0;
        for(let y=0;y<size;y++) weight += pixels[y*4+3]/255;
        results.push({size,family,weight,expectedWeight:family==='mimo'?1.6:2*size/24});
      } finally { URL.revokeObjectURL(url); }
    }
    return results;
  })()`);
  for (const { size, family, weight, expectedWeight } of weights) {
    // Chromium quantizes coverage at this scale; allow a tenth-pixel AA margin.
    assert.ok(
      Math.abs(weight - expectedWeight) < 0.12,
      `${family} ${size}px rendered ${weight}px stroke`,
    );
  }
  // Check standalone semantics and the optional name-based API in the browser.
  const semantics = await evaluate(`(async () => {
    const { MimoIcon } = await import('/src/icons/index.ts');
    const meaningful = MimoIcon({name:'winter',size:18,label:' Winter '});
    const decorative = MimoIcon({name:'companion',size:16});
    let invalid = false;
    try { MimoIcon({name:'companion',size:0}); } catch(error) { invalid = error instanceof RangeError; }
    return {role:meaningful.getAttribute('role'),label:meaningful.getAttribute('aria-label'),
      hidden:meaningful.hasAttribute('aria-hidden'),decorative:decorative.getAttribute('aria-hidden'),invalid};
  })()`);
  assert.deepEqual(semantics, {
    role: "img",
    label: "Winter",
    hidden: false,
    decorative: "true",
    invalid: true,
  });
});

test("custom Mimo controls preserve names, bounds, states, and keyboard actions", async () => {
  await scene("playing", "Balisong", "Rivermaya", "expanded");
  const controls =
    await evaluate(`(() => [...document.querySelectorAll('#header button:not([hidden])')].filter(el=>el.getClientRects().length&&!el.closest('[hidden],[inert]')).map(button => {
    const r = button.getBoundingClientRect(); const svg = button.querySelector('svg');
    return {label:button.getAttribute('aria-label'),icon:svg?.dataset.mimoIcon ?? null,
      hidden:svg?.getAttribute('aria-hidden'),width:r.width,height:r.height};
  }))()`);
  assert.equal(
    controls.find((control) => control.label === "Home").icon,
    "home",
  );
  assert.equal(
    controls.find((control) => control.label === "Media").icon,
    "music-mode",
  );
  assert.equal(
    controls.some((control) => control.label === "Minimize to island"),
    false,
  );
  assert.ok(
    controls.every((control) => control.label && (!control.icon || control.hidden === "true")),
  );
  assert.ok(
    controls.every((control) => control.width >= 28 && control.height >= 28),
  );
  await evaluate(
    "document.querySelector('#header button[aria-label=Unmute]')?.click()",
  );
  await evaluate(settled);
  assert.equal(
    await evaluate(
      "document.querySelector('#header button[aria-label=Mute] svg').dataset.mimoIcon",
    ),
    "sound",
  );
  await evaluate(
    "document.querySelector('#header button[aria-label=Mute]').click()",
  );
  await evaluate(settled);
  assert.equal(
    await evaluate(
      "document.querySelector('#header button[aria-label=Unmute] svg').dataset.mimoIcon",
    ),
    "sound-off",
  );
  await command("Runtime.evaluate", {
    expression: "document.querySelector('[data-section=overview]').focus()",
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"), "overview");
  await capture("mimo-home-custom-icons");
});

test("compact and peek retain full-resolution drawing buffers through Windows DPI changes", async (t) => {
  t.after(async () => {
    await evaluate("mediaPreview.state.removeTask('agent_dpi_probe')");
    await command("Emulation.setDeviceMetricsOverride", {
      width: 720,
      height: PANEL_H,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate("window.dispatchEvent(new Event('resize'))");
    await scene("playing");
  });
  await evaluate(
    "mediaPreview.state.upsertExternalAgent('agent_dpi_probe','DPI check','#ffffff')",
  );
  for (const scale of [1, 1.25, 1.5, 2, 3, 4, 1]) {
    await command("Emulation.setDeviceMetricsOverride", {
      width: 720,
      height: PANEL_H,
      deviceScaleFactor: scale,
      mobile: false,
    });
    await evaluate("window.dispatchEvent(new Event('resize'))");
    await scene("playing", "Balisong", "Rivermaya", "compact");
    for (const mode of ["compact", "peek"]) {
      if (mode === "peek") {
        await evaluate("mediaPreview.preferences({peekEnabled:true});mediaPreview.hide()");
        await evaluate(settled);
      }
      const buffers =
        await evaluate(`(() => [...document.querySelectorAll('#bot-canvas, .mini canvas')].map(el => ({
        width:el.width,height:el.height,cssWidth:parseFloat(el.style.width),cssHeight:parseFloat(el.style.height),
      })))()`);
      assert.ok(buffers.length >= 1);
      for (const buffer of buffers) {
        assert.equal(
          buffer.width,
          Math.round(buffer.cssWidth * scale),
          `${mode} ${scale}x width`,
        );
        assert.equal(
          buffer.height,
          Math.round(buffer.cssHeight * scale),
          `${mode} ${scale}x height`,
        );
      }
      const bounds = await evaluate(
        `(() => {const r=document.querySelector('#island').getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)];})()`,
      );
      assert.deepEqual(bounds, mode === "compact" ? [264, 40] : [72, 32]);
      await capture(`icons-${mode}-${scale}x`);
    }
  }
});

test("native window edges stay transparent in expanded, compact, and peek states", async () => {
  assert.equal(
    await evaluate("getComputedStyle(document.documentElement).colorScheme"),
    "normal",
  );
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('#island')).colorScheme",
    ),
    "dark",
  );
  await command("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
  try {
    for (const appearance of ["dark"]) {
      await evaluate(
        `mediaPreview.preferences({appearance:${JSON.stringify(appearance)},peekEnabled:true})`,
      );
      for (const [mode, width, height] of [
        ["expanded", 720, PANEL_H],
        ["compact", 320, 56],
        ["peek", 104, 48],
      ]) {
        await command("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await evaluate(
          mode === "expanded"
            ? "mediaPreview.open('media')"
            : mode === "compact"
              ? "mediaPreview.compact()"
              : "mediaPreview.preferences({workingModeEnabled:true});mediaPreview.hide()",
        );
        await evaluate(settled);
        if (appearance === 'glass' && mode !== 'peek') {
          assert.equal(await evaluate("getComputedStyle(document.querySelector('#island'),'::before').borderTopWidth"),'0px',
            "Glass has one curved rim rather than a clipped rectangular border");
          assert.equal(await evaluate("getComputedStyle(document.querySelector('.core-rim')).strokeLinejoin"),'round');
          const clips = await evaluate("[getComputedStyle(document.querySelector('.core-rim')).clipPath,getComputedStyle(document.querySelector('#island'),'::before').clipPath]");
          assert.equal(clips[0], clips[1], JSON.stringify({appearance,mode,clips}));
        }
        const { data } = await command("Page.captureScreenshot", {
          format: "png",
        });
        const edges = await evaluate(`(async () => {
          const response = await fetch(${JSON.stringify(`data:image/png;base64,${data}`)});
          const bitmap = await createImageBitmap(await response.blob());
          const canvas = document.createElement('canvas'); canvas.width = ${width}; canvas.height = ${height};
          const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap,0,0); bitmap.close();
          const alpha = (x,y) => ctx.getImageData(x,y,1,1).data[3];
          const pixels = ctx.getImageData(0,0,${width},${height}).data;
          let painted = 0;
          for(let i=3;i<pixels.length;i+=4) if(pixels[i]>0) painted++;
          return {corners:[alpha(0,${height - 1}),alpha(${width - 1},${height - 1})],painted};
        })()`);
        assert.deepEqual(
          edges.corners,
          [0, 0],
          `${appearance} ${mode} paints a rectangular window corner`,
        );
        assert.ok(
          edges.painted > 30,
          `${appearance} ${mode} must still render Mimo`,
        );
        await writeFile(
          join(artifacts, `mimo-transparent-${appearance}-${mode}.png`),
          Buffer.from(data, "base64"),
        );
      }
    }
  } finally {
    await command("Emulation.setDefaultBackgroundColorOverride");
    await command("Emulation.setDeviceMetricsOverride", {
      width: 720,
      height: PANEL_H,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(
      "mediaPreview.preferences({appearance:'dark'});mediaPreview.open('media')",
    );
    await evaluate(settled);
  }
});

test("rapid playback clicks issue one command and wait for native confirmation without dimming", async () => {
  for (const [selector, action] of [
    [".media-primary", "pause"],
    [".media-controls [aria-label=\"Previous track\"]", "previous"],
    [".media-controls [aria-label=\"Next track\"]", "next"],
  ]) {
    await evaluate(
      `mediaPreview.publish('playing','Track','Artist',{sourceAppId:'Spotify.exe',controls:{previous:true,play:true,pause:true,next:true}});mediaPreview.open('media');mediaPreview.controlDelay=120;mediaPreview.actions.length=0;`,
    );
    await evaluate(settled);
    const before = await evaluate(
      `(() => { const button=document.querySelector(${JSON.stringify(selector)});for(let n=0;n<20;n++)button.click();return {label:document.querySelector('.media-primary').getAttribute('aria-label'),busy:button.getAttribute('aria-disabled'),disabled:button.disabled};})()`,
    );
    assert.equal(before.label, "Pause");
    assert.equal(before.busy, "true");
    assert.equal(before.disabled, false);
    await evaluate("new Promise(resolve=>setTimeout(resolve,190))");
    assert.deepEqual(await evaluate("mediaPreview.actions"), [action]);
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-disabled')`,
      ),
      "false",
    );
    if (action === "pause")
      assert.equal(
        await evaluate(
          "document.querySelector('.media-primary').dataset.action",
        ),
        "play",
      );
  }
  await evaluate("mediaPreview.controlDelay=0");
});

test("master volume steps, mute and external changes keep the percentage and speaker states synchronized", async () => {
  await scene("playing");
  await evaluate(
    "mediaPreview.publishAudio(48);document.querySelector('.media-volume-up').click()",
  );
  assert.equal(
    await evaluate("document.querySelector('.media-volume-label').textContent"),
    "50%",
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,60))");
  assert.equal(await evaluate("mediaPreview.store.audioSnapshot().volume"), 50);
  await evaluate("document.querySelector('.media-volume-down').click()");
  await evaluate("new Promise(resolve=>setTimeout(resolve,60))");
  assert.equal(await evaluate("mediaPreview.store.audioSnapshot().volume"), 48);
  for (const [volume, muted, level] of [
    [12, false, "sound-low"],
    [48, false, "sound-medium"],
    [88, false, "sound"],
    [88, true, "sound-off"],
    [0, false, "sound-off"],
  ]) {
    await evaluate(`mediaPreview.publishAudio(${volume},${muted})`);
    await evaluate("new Promise(resolve=>setTimeout(resolve,190))");
    assert.deepEqual(
      await evaluate(
        `(() => { const button=document.querySelector('.media-volume-mute');return [button.dataset.level,document.querySelector('.media-volume-label').textContent,[...button.children].filter(node=>Number(getComputedStyle(node).opacity)>.99).length]; })()`,
      ),
      [level, `${volume}%`, 1],
    );
  }
  await evaluate(
    "mediaPreview.publishAudio(48);document.querySelector('.media-volume-mute').click()",
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,50))");
  assert.equal(
    await evaluate("mediaPreview.store.audioSnapshot().muted"),
    true,
  );
  assert.equal(await evaluate("mediaPreview.store.audioSnapshot().volume"), 48);
  await evaluate("document.querySelector('.media-volume-mute').click()");
  await evaluate("new Promise(resolve=>setTimeout(resolve,50))");
  assert.equal(
    await evaluate("mediaPreview.store.audioSnapshot().muted"),
    false,
  );
  await capture("master-audio-media-tab");
});

test("slider feedback stays immediate while delayed native writes coalesce and failures recover", async () => {
  await evaluate(`(() => {mediaPreview.publishAudio(48);mediaPreview.audioDelay=120;mediaPreview.audioActions.length=0;
    const slider=document.querySelector('.media-volume-slider');
    for(let value=49;value<=83;value++){slider.value=String(value);slider.dispatchEvent(new Event('input'));}})()`);
  assert.deepEqual(
    await evaluate(
      "[document.querySelector('.media-volume-slider').value,document.querySelector('.media-volume-label').textContent,mediaPreview.store.audioSnapshot().volume,mediaPreview.audioActions.length]",
    ),
    ["83", "83%", 48, 1],
  );
  await evaluate("mediaPreview.publishAudio(20)");
  assert.equal(
    await evaluate("document.querySelector('.media-volume-slider').value"),
    "83",
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,300))");
  assert.deepEqual(
    await evaluate("mediaPreview.audioActions.map(action=>action.volume)"),
    [49, 83],
  );
  assert.equal(await evaluate("mediaPreview.store.audioSnapshot().volume"), 83);
  await evaluate(
    "mediaPreview.audioDelay=0;mediaPreview.audioError=true;document.querySelector('.media-volume-down').click()",
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,60))");
  assert.equal(
    await evaluate("document.querySelector('.media-volume-slider').value"),
    "83",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.media-volume .media-announcement').textContent.includes('Try again')",
    ),
    true,
  );
  await evaluate("mediaPreview.audioError=false;mediaPreview.publishAudio(48)");
});

test("real slider dragging and keyboard adjustment update master audio without fighting external changes", async () => {
  await scene("playing");
  await evaluate("mediaPreview.publishAudio(48)");
  const bounds = await evaluate(
    "(() => {const r=document.querySelector('.media-volume-slider').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()",
  );
  assert.ok(bounds.w > bounds.h * 3, "Windows volume is horizontal");
  assert.equal(
    await evaluate(
      "document.querySelector('.media-volume-slider').getAttribute('aria-orientation')",
    ),
    "horizontal",
  );
  const y = bounds.y + bounds.h / 2;
  await command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: bounds.x + bounds.w * 0.48,
    y,
    button: "left",
    clickCount: 1,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: bounds.x + bounds.w * 0.75,
    y,
    button: "left",
    buttons: 1,
  });
  const held = await evaluate(
    "document.querySelector('.media-volume-slider').value",
  );
  await evaluate("mediaPreview.publishAudio(15)");
  assert.equal(
    await evaluate("document.querySelector('.media-volume-slider').value"),
    held,
  );
  await command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: bounds.x + bounds.w * 0.85,
    y,
    button: "left",
    buttons: 1,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: bounds.x + bounds.w * 0.85,
    y,
    button: "left",
    clickCount: 1,
  });
  await evaluate("new Promise(resolve=>setTimeout(resolve,100))");
  assert.equal(
    await evaluate(
      "Number(document.querySelector('.media-volume-slider').value) === mediaPreview.store.audioSnapshot().volume",
    ),
    true,
  );
  assert.ok(
    await evaluate("mediaPreview.store.audioSnapshot().volume >= 75"),
    "Dragging right increases volume",
  );
  await evaluate(
    "mediaPreview.publishAudio(48);document.querySelector('.media-volume-slider').focus()",
  );
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  });
  await evaluate("new Promise(resolve=>setTimeout(resolve,70))");
  assert.equal(await evaluate("mediaPreview.store.audioSnapshot().volume"), 49);
});

test("master audio remains usable without a media session and fits existing Dark and Glass layouts", async () => {
  await scene("none");
  assert.equal(
    await evaluate(
      "document.querySelector('.section-empty .media-volume') !== null",
    ),
    true,
  );
  await evaluate(
    "mediaPreview.publishAudio(48);document.querySelector('.media-volume-up').click()",
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,60))");
  assert.equal(await evaluate("mediaPreview.store.audioSnapshot().volume"), 50);
  await capture("master-audio-no-player");
  for (const appearance of ["dark"]) {
    await evaluate(
      `mediaPreview.preferences({appearance:${JSON.stringify(appearance)}});mediaPreview.publish('playing');mediaPreview.open('media')`,
    );
    await evaluate(settled);
    const bounds = await evaluate(
      `(() => {const audio=document.querySelector('.media-volume');const r=audio.getBoundingClientRect();const p=document.querySelector('.media-row').getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,parentLeft:p.left,parentRight:p.right,parentBottom:p.bottom,scroll:audio.scrollWidth,client:audio.clientWidth};})()`,
    );
    assert.ok(
      bounds.left >= bounds.parentLeft &&
        bounds.right <= bounds.parentRight &&
        bounds.bottom <= bounds.parentBottom &&
        bounds.scroll <= bounds.client,
      JSON.stringify(bounds),
    );
    await capture(`master-audio-${appearance}`);
  }
  await evaluate("mediaPreview.preferences({appearance:'dark'})");
});

test("play-pause crossfade never goes blank and reduced motion keeps meaningful feedback", async () => {
  await scene("playing");
  const sample = await evaluate(
    `(async () => {const button=document.querySelector('.media-primary');button.click();const start=performance.now();let minimum=2;while(performance.now()-start<190){await new Promise(requestAnimationFrame);minimum=Math.min(minimum,[...button.children].reduce((sum,node)=>sum+Number(getComputedStyle(node).opacity),0));}return minimum;})()`,
  );
  assert.ok(sample >= 0.95, `icon crossfade became blank: ${sample}`);
  await command("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    await evaluate("document.querySelector('.media-primary').click()");
    assert.equal(
      await evaluate(
        "document.querySelector('.media-primary').getAnimations().filter(animation=>animation.effect?.target===document.querySelector('.media-primary')).length",
      ),
      0,
    );
    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('.media-play-glyph')).transitionDuration",
      ),
      "0.08s",
    );
  } finally {
    await command("Emulation.setEmulatedMedia", { features: [] });
  }
});

test("media matches the relayout reference and confirms repeat and shuffle", async (t) => {
  t.after(async()=>{await command('Emulation.clearDeviceMetricsOverride');await loadPage('Page.reload');});
  await loadPage('Page.reload');
  for (const sourceAppId of ["Spotify.exe", "chrome.exe"]) {
    await evaluate(
      `mediaPreview.publish('playing','Track','Artist',{sourceAppId:${JSON.stringify(sourceAppId)},controls:{previous:true,play:true,pause:true,next:true,repeat:true,shuffle:true}});mediaPreview.open('media')`,
    );
    await evaluate(settled);
    assert.equal(
      await evaluate(
        "document.querySelectorAll('.media-shuffle,.media-repeat').length",
      ),
      2,
    );
    assert.equal(
      await evaluate(
        "document.querySelectorAll('.media-controls > button').length",
      ),
      5,
    );
    assert.equal(await evaluate("document.querySelector('.media-shuffle').disabled&&document.querySelector('.media-repeat').disabled"),true,'Missing mode values cannot be shown as available');
  }
  await evaluate("mediaPreview.preferences({workingModeEnabled:false});mediaPreview.publish('playing','Balisong','Rivermaya',{sourceAppId:'Spotify.exe',artwork:{dataUrl:mediaPreview.artwork},controls:{previous:true,play:true,pause:true,next:true,shuffle:true,repeat:true,seek:true,volume:true},volume:69,timeline:{positionMs:115000,durationMs:184000,updatedAtUnixMs:Date.now(),playbackRateMilli:0},shuffle:false,repeatMode:'off'});mediaPreview.open('media');mediaPreview.controlDelay=180");
  await evaluate(`mediaPreview.store.applyAudio({...mediaPreview.store.audioSnapshot(),revision:mediaPreview.store.audioSnapshot().revision+1,
    inputs:[{id:'preview-mic',name:'Microphone'}],inputId:'preview-mic',canSwitchInput:true,
    sessions:[{id:'spotify',name:'Spotify',source:'Spotify.exe',kind:'audio-only',outputId:'preview-output',volume:69,muted:false,canControl:true}]})`);
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('#bot-canvas').dataset.color"),'#4FB29E','Spotify playback owns the soft green companion only in Media');
  for(const scale of [1,2]) {
    await command('Emulation.setDeviceMetricsOverride',{width:720,height:PANEL_H,deviceScaleFactor:scale,mobile:false});await evaluate(settled);
    const layout=await evaluate(`(()=>{const panel=document.querySelector('.media-row').getBoundingClientRect(),island=document.querySelector('#island').getBoundingClientRect();
      const art=document.querySelector('.media-artwork').getBoundingClientRect(),head=document.querySelector('#header').getBoundingClientRect(),mimo=mediaPreview.island;
      const copy=document.querySelector('.media-copy').getBoundingClientRect(),timeline=document.querySelector('.media-timeline').getBoundingClientRect(),transport=document.querySelector('.media-controls').getBoundingClientRect();
      const disclosure=document.querySelector('.audio-disclosure > svg').getBoundingClientRect(),volume=document.querySelector('.media-session-volume').getBoundingClientRect();
      const x=island.x+mimo.botCx.value,y=island.y+mimo.botCy.value,d=mimo.botSize.value*.6;
      return {mimo:d>=43&&d<=45&&x-d/2>=copy.right&&x+d/2<panel.right&&y-d/2>=head.bottom&&Math.abs(y-art.top-art.height/2)<3,
        layout:copy.left>=art.right&&timeline.top>=art.bottom&&Math.abs(timeline.left-art.left)<1&&Math.abs(timeline.right-panel.right+16)<1
          &&Math.abs(transport.left+transport.width/2-panel.left-panel.width/2)<1&&transport.top>timeline.bottom
          &&Math.abs(disclosure.left-art.left-6)<1&&volume.left>transport.right&&Math.abs(volume.top+volume.height/2-transport.top-transport.height/2)<1,
        artWidth:art.width,disclosureHeight:document.querySelector('.audio-disclosure').getBoundingClientRect().height,
        controls:[...document.querySelectorAll('.media-controls button')].every(button=>{const r=button.getBoundingClientRect();return r.left>=panel.left&&r.right<=panel.right&&r.top>=panel.top&&r.bottom<=panel.bottom;})};})()`);
    assert.equal(layout.mimo,true,JSON.stringify(layout));assert.equal(layout.layout,true,JSON.stringify(layout));assert.equal(layout.artWidth,80);assert.equal(layout.disclosureHeight,28);assert.equal(layout.controls,true);
    await capture('media-layout-expanded-'+scale+'x');
    if(await evaluate("document.querySelector('.audio-disclosure').getAttribute('aria-expanded')==='true'")) await pointerClick('.audio-disclosure');
    await evaluate(settled);
    assert.equal(await evaluate("Math.round(document.querySelector('#island').getBoundingClientRect().height)"),52+MEDIA_VIEW_COLLAPSED_HEIGHT);
    assert.equal(await evaluate("(()=>{const a=document.querySelector('.audio-disclosure').getBoundingClientRect(),b=document.querySelector('.media-controls').getBoundingClientRect();return Math.abs(a.top+a.height/2-b.top-b.height/2)<1})()"),true);
    await capture('media-layout-reference-'+scale+'x');
    await pointerClick('.audio-disclosure');await evaluate(settled);
  }
  await evaluate("mediaPreview.actions.length=0;document.querySelector('.media-shuffle').click();document.querySelector('.media-shuffle').click()");
  assert.equal(await evaluate("document.querySelector('.media-shuffle').getAttribute('aria-pressed')"),'false','Pending mode stays unconfirmed');
  await evaluate(settled);
  assert.deepEqual(await evaluate('mediaPreview.actions'),[{shuffle:true}]);
  assert.equal(await evaluate("document.querySelector('.media-shuffle').getAttribute('aria-pressed')"),'true');
  for(const [mode,label] of [['list','Repeat all'],['track','Repeat one'],['off','Repeat off']]) {
    await pointerClick('.media-repeat');await evaluate(settled);
    assert.equal(await evaluate('mediaPreview.store.snapshot().player.repeatMode'),mode);
    assert.equal(await evaluate("document.querySelector('.media-repeat').getAttribute('aria-label')"),label);
  }
  await evaluate('mediaPreview.island.engine.musicStarted=performance.now()/1000;mediaPreview.island.ensureRunning()');await evaluate(settled);
  assert.equal(await evaluate('mediaPreview.island.engine.currentExpression'),'music');
  await evaluate('mediaPreview.island.engine.musicStarted=performance.now()/1000-14.4;mediaPreview.island.ensureRunning()');await evaluate(settled);
  assert.equal(await evaluate('mediaPreview.island.engine.currentExpression'),'dancing');await capture('media-layout-mimo-dancing');
  const travel=await evaluate(`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const ctx=canvas.getContext('2d'),samples=[];
    for(let frame=0;frame<19;frame++){
      ctx.clearRect(0,0,128,128);mediaPreview.island.engine.draw(ctx,128,128);
      const pixels=ctx.getImageData(0,0,128,128).data;let sum=0,count=0;
      for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]>220&&pixels[i+1]>pixels[i]+8&&pixels[i+1]>pixels[i+2]){sum+=(i/4)%128;count++;}
      if(count)samples.push(sum/count);await new Promise(resolve=>setTimeout(resolve,80));
    }
    return Math.max(...samples)-Math.min(...samples);
  })()`);
  assert.ok(travel>24,'The real renderer visibly dances left and right: '+travel);
  for(const [playback,source] of [['paused','Spotify.exe'],['playing','chrome.exe'],['playing','Player.exe']]){
    await evaluate(`mediaPreview.publish('${playback}','Track','Artist',{sourceAppId:'${source}'});mediaPreview.open('media')`);await evaluate(settled);
    assert.equal(await evaluate("document.querySelector('#bot-canvas').dataset.color"),'','Other players and paused Spotify keep the silver companion');
  }
  await evaluate("mediaPreview.publish('playing','Track','Artist',{sourceAppId:'Spotify.exe'})");await evaluate(settled);
  for(const view of ['overview','prompt','grab','approval']) {
    await evaluate(`mediaPreview.open('${view}')`);await evaluate(settled);
    assert.equal(await evaluate("['music','dancing'].includes(mediaPreview.island.engine.currentExpression)"),false,'Music never performs in '+view);
  }
});

test("Spotify volume beside its percentage controls only the current app and retains the final drag value", async (t) => {
  t.after(async()=>{await loadPage('Page.reload');});
  await loadPage('Page.reload');
  await evaluate(`mediaPreview.preferences({workingModeEnabled:false});mediaPreview.publishAudio(48);
    mediaPreview.publish('playing','Track','Artist',{sourceAppId:'Spotify.exe',sessionId:'spotify-volume',volume:69,controls:{previous:true,play:true,pause:true,next:true,volume:true}});
    mediaPreview.open('media');mediaPreview.controlDelay=180;mediaPreview.actions.length=0;mediaPreview.audioActions.length=0;`);
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.media-session-volume-value').textContent"),'69%');
  assert.equal(await evaluate("document.querySelector('.media-session-volume-slider').getAttribute('aria-label')"),'Spotify volume');
  const fill=await evaluate("(()=>{const s=getComputedStyle(document.querySelector('.media-session-volume-slider'));return {background:s.backgroundImage,height:parseFloat(s.height)}})()");
  assert.match(fill.background,/linear-gradient\(.*69%/,'The app volume fill survives the shared range-input styles');
  assert.equal(fill.height,20,'The thin rail keeps a comfortable input area');
  const setVolume=value=>evaluate(`(()=>{const slider=document.querySelector('.media-session-volume-slider');slider.value='${value}';slider.dispatchEvent(new Event('input'));slider.dispatchEvent(new Event('change'));})()`);
  await setVolume(39);
  await setVolume(52);
  assert.equal(await evaluate("document.querySelector('.media-session-volume-value').textContent"),'52%','The latest drag value is shown immediately while native confirmation is pending');
  await evaluate(settled);
  assert.deepEqual(await evaluate('mediaPreview.actions'),[{volume:39},{volume:52}]);
  assert.equal(await evaluate("document.querySelector('.media-session-volume-value').textContent"),'52%');
  assert.match(await evaluate("getComputedStyle(document.querySelector('.media-session-volume-slider')).backgroundImage"),/52%/);
  await capture('spotify-volume-fill-adjusted');
  assert.equal(await evaluate('mediaPreview.store.audioSnapshot().volume'),48);
  assert.deepEqual(await evaluate('mediaPreview.audioActions'),[],'The app fader never writes Windows master volume');
  await evaluate('mediaPreview.controlError=true');await setVolume(7);await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.media-session-volume-value').textContent"),'52%','Failed writes retain confirmed app volume');
  assert.equal(await evaluate("document.querySelector('.media-session-volume-slider').value"),'52');
  await evaluate(`mediaPreview.controlError=false;mediaPreview.actions.length=0;
    const slider=document.querySelector('.media-session-volume-slider');
    for(const value of ['11','12']){slider.value=value;slider.dispatchEvent(new Event('input'));}
    mediaPreview.publish('playing','Other track','Other artist',{sourceAppId:'chrome.exe',sessionId:'other-volume',volume:22,controls:{play:true,pause:true,volume:true}});`);
  await evaluate(settled);
  assert.deepEqual(await evaluate('mediaPreview.actions'),[{volume:11}],'The first write starts immediately, and the queued value is discarded when the session changes');
  assert.equal(await evaluate("document.querySelector('.media-session-volume-value').textContent"),'22%');
  assert.equal(await evaluate("document.querySelector('.media-session-volume-slider').getAttribute('aria-label')"),'Chrome volume');
  await evaluate("mediaPreview.publish('playing','Track','Artist',{sourceAppId:'Spotify.exe',volume:null,controls:{play:true,pause:true,volume:false}})");
  assert.equal(await evaluate("document.querySelector('.media-session-volume-slider').disabled"),true);
  assert.equal(await evaluate("document.querySelector('.media-session-volume-value').textContent"),'—','Unavailable app volume never falls back to Windows volume');
});

test("dedicated views own content while playback continues in the background", async () => {
  await scene("playing");
  for (const view of [
    "overview",
    "prompt",
    "upload",
    "uploading",
    "choose",
    "confused",
    "approval",
    "question",
    "error",
    "finished",
    "integrations",
    "utilities",
  ]) {
    await evaluate(`mediaPreview.open(${JSON.stringify(view)})`);
    await evaluate(settled);
    assert.equal(
      await evaluate(
        "document.querySelector('.media-row.is-visible') !== null",
      ),
      false,
      view,
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.media-summary:not([hidden])') !== null",
      ),
      false,
      view,
    );
    assert.equal(
      await evaluate("mediaPreview.store.snapshot().state.playbackState"),
      "playing",
      view,
    );
  }
  await scene("playing");
  assert.equal((await inspect()).rowVisible, true);
});

test("device popovers and per-app mixer reconcile native state without altering playback", async () => {
  await scene("playing");
  await evaluate(`mediaPreview.store.applyAudio({...mediaPreview.store.audioSnapshot(), revision:mediaPreview.store.audioSnapshot().revision+1,
    inputId:'mic',inputs:[{id:'mic',name:'Microphone'},{id:'usb',name:'USB Microphone'}],canSwitchInput:true,
    sessions:[{id:'spotify',name:'Spotify',source:'spotify.exe',kind:'audio-only',outputId:'preview-output',volume:80,muted:false,canControl:true},
      {id:'discord',name:'Discord',source:'discord.exe',kind:'communication',outputId:'preview-output',volume:45,muted:false,canControl:true}]})`);
  await evaluate("document.querySelector('.media-audio-output').click()");
  assert.equal(
    await evaluate(
      "document.querySelector('.audio-device-menu:popover-open[role=listbox]').getAttribute('aria-label')",
    ),
    "Output device",
  );
  await evaluate(
    "[...document.querySelectorAll('.audio-device-menu:popover-open [role=option]')].find(el=>el.textContent.includes('Headphones')).click()",
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,250))");
  assert.equal(
    await evaluate("mediaPreview.store.audioSnapshot().deviceId"),
    "headphones",
  );
  await evaluate(
    "document.querySelector('.media-app-slider').value='65';document.querySelector('.media-app-slider').dispatchEvent(new Event('input'));document.querySelector('.media-app-slider').dispatchEvent(new Event('change'))",
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,100))");
  assert.equal(
    await evaluate("mediaPreview.store.audioSnapshot().sessions[0].volume"),
    65,
  );
  assert.equal(await evaluate("mediaPreview.store.audioSnapshot().volume"), 32);
  await evaluate(
    "mediaPreview.store.applyAudio({...mediaPreview.store.audioSnapshot(),revision:mediaPreview.store.audioSnapshot().revision+1,sessions:mediaPreview.store.audioSnapshot().sessions.map(s=>s.id==='spotify'?{...s,volume:41,muted:true}:s)})",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-session=spotify] .media-app-slider').value",
    ),
    "41",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-session=spotify] .media-app-mute').getAttribute('aria-pressed')",
    ),
    "true",
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,180))");
  assert.ok(
    await evaluate(
      "[...document.querySelector('[data-session=spotify] .media-app-mute').children].some(svg=>Number(getComputedStyle(svg).opacity)>0.9)",
    ),
  );
  await evaluate(
    "document.querySelector('[data-session=spotify] .media-app-mute').click()",
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,80))");
  assert.equal(
    await evaluate("mediaPreview.store.audioSnapshot().sessions[0].muted"),
    false,
  );
  assert.equal(await evaluate("mediaPreview.store.audioSnapshot().volume"), 32);
  assert.equal(
    await evaluate(
      "document.querySelector('[data-session=discord]').textContent.includes('Voice audio active')",
    ),
    true,
  );
  await evaluate(
    "document.querySelector('.media-audio-input').click();[...document.querySelectorAll('.audio-device-menu:popover-open [role=option]')].find(el=>el.textContent.includes('USB Microphone')).click()",
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,250))");
  assert.equal(
    await evaluate("mediaPreview.store.audioSnapshot().inputId"),
    "usb",
  );
  await evaluate(
    "mediaPreview.store.applyAudio({...mediaPreview.store.audioSnapshot(),revision:mediaPreview.store.audioSnapshot().revision+1,sessions:[]});mediaPreview.publishAudio(48)",
  );
  await scene("playing");
});

test("activity cannot displace explicit content and companion activation opens the full player", async () => {
  await scene("playing");
  await evaluate("mediaPreview.preferences({hooksInstalled:true,codexHooksInstalled:true,usageEnabled:true,modules:{vscode:true}})");
  for (const view of [
    "prompt",
    "upload",
    "uploading",
    "choose",
    "confused",
    "usage",
    "approvals",
  ]) {
    await evaluate(
      `mediaPreview.open('${view}');mediaPreview.island.alert('finished')`,
    );
    await evaluate(settled);
    assert.equal(await evaluate("mediaPreview.state.view"), view);
    assert.equal(
      await evaluate(
        "document.querySelectorAll('.media-row.is-visible').length",
      ),
      0,
    );
  }
  await evaluate(
    "mediaPreview.open('media');mediaPreview.hide();document.querySelector('#restore-island').click()",
  );
  assert.equal(await evaluate("mediaPreview.state.view"), "media");
  await evaluate("document.querySelector('#restore-island').click()");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"), "media");
  assert.equal(
    await evaluate("document.querySelectorAll('.media-row.is-visible').length"),
    1,
  );
  await evaluate(
    "mediaPreview.island.engine.slap();mediaPreview.island.engine.slap();mediaPreview.island.engine.slap()",
  );
  await evaluate("new Promise(requestAnimationFrame)");
  assert.equal(await evaluate("mediaPreview.state.view"), "confused");
  assert.equal(
    await evaluate("document.querySelectorAll('.media-row.is-visible').length"),
    0,
  );
  assert.equal(
    await evaluate("mediaPreview.store.snapshot().state.playbackState"),
    "playing",
  );
  await evaluate("mediaPreview.open('media')");
});

test("device popovers accept real pointer clicks and stay open while choosing", async () => {
  await scene("playing");
  await pointerClick(".media-audio-output");
  await evaluate("new Promise(resolve=>setTimeout(resolve,220))");
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.audio-device-menu:popover-open').length",
    ),
    1,
  );
  await pointerClick(
    ".audio-device-menu:popover-open [data-device=headphones]",
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,220))");
  assert.equal(
    await evaluate("mediaPreview.store.audioSnapshot().deviceId"),
    "headphones",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.audio-device-menu:popover-open').length",
    ),
    0,
  );
  await evaluate("mediaPreview.publishAudio(48,false,'preview-output')");
  await evaluate(
    "mediaPreview.store.applyAudio({...mediaPreview.store.audioSnapshot(),revision:mediaPreview.store.audioSnapshot().revision+1,inputId:'mic',inputs:[{id:'mic',name:'Microphone'},{id:'webcam',name:'Webcam microphone'}],canSwitchInput:true})",
  );
  await pointerClick(".media-audio-input");
  await pointerClick(".audio-device-menu:popover-open [data-device=webcam]");
  await evaluate("new Promise(resolve=>setTimeout(resolve,220))");
  assert.equal(
    await evaluate("mediaPreview.store.audioSnapshot().inputId"),
    "webcam",
  );
  await pointerClick(".media-audio-input");
  await pointerClick(".media-audio-input");
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.audio-device-menu:popover-open').length",
    ),
    0,
  );
});

test("device listboxes support keyboard navigation, focus return, and external changes", async () => {
  await scene("playing");
  await evaluate("mediaPreview.publishAudio(48,false,'preview-output')");
  await evaluate("document.querySelector('.media-audio-output').focus()");
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowDown",
    code: "ArrowDown",
    windowsVirtualKeyCode: 40,
  });
  assert.equal(
    await evaluate("document.activeElement.dataset.device"),
    "preview-output",
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,220))");
  await capture("audio-output-popover");
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "End",
    code: "End",
    windowsVirtualKeyCode: 35,
  });
  assert.equal(
    await evaluate("document.activeElement.dataset.device"),
    "headphones",
  );
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  assert.equal(
    await evaluate(
      "document.activeElement.classList.contains('media-audio-output')",
    ),
    true,
  );
  assert.equal(
    await evaluate("mediaPreview.store.audioSnapshot().deviceId"),
    "headphones",
  );
  await evaluate(
    "mediaPreview.publishAudio(48, false, 'preview-output');document.querySelector('.media-audio-output').click()",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.audio-device-menu:popover-open .audio-device-option[aria-selected=true]').dataset.device",
    ),
    "preview-output",
  );
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.audio-device-menu:popover-open').length",
    ),
    0,
  );
  assert.equal(await evaluate("mediaPreview.state.visibility"), "expanded");
  assert.equal(
    await evaluate(
      "document.activeElement.classList.contains('media-audio-output')",
    ),
    true,
  );
});

test("Windows audio disclosure remembers its choice without interrupting playback", async () => {
  await scene("playing");
  assert.equal(
    await evaluate(
      "document.querySelector('.audio-disclosure')?.getAttribute('aria-expanded')",
    ),
    "true",
  );
  await evaluate("document.querySelector('.audio-disclosure').click()");
  await evaluate(settled);
  assert.equal(
    await evaluate(
      "document.querySelector('.audio-disclosure').getAttribute('aria-expanded')",
    ),
    "false",
  );
  assert.equal(
    await evaluate("document.querySelector('.audio-body').hidden"),
    true,
  );
  assert.equal(Math.round((await inspect()).height), 52 + MEDIA_VIEW_COLLAPSED_HEIGHT);
  assert.equal(
    await evaluate("mediaPreview.store.snapshot().state.playbackState"),
    "playing",
  );
  await capture("audio-collapsed");
  await evaluate("mediaPreview.open('overview');mediaPreview.open('media')");
  assert.equal(
    await evaluate(
      "document.querySelector('.audio-disclosure').getAttribute('aria-expanded')",
    ),
    "false",
  );
  await loadPage("Page.reload", {});
  await evaluate("mediaPreview.publish('playing');mediaPreview.open('media')");
  await evaluate(settled);
  assert.equal(
    await evaluate(
      "document.querySelector('.audio-disclosure').getAttribute('aria-expanded')",
    ),
    "false",
  );
  await evaluate("document.querySelector('.audio-disclosure').focus()");
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await evaluate(settled);
  assert.equal(
    await evaluate(
      "document.querySelector('.audio-disclosure').getAttribute('aria-expanded')",
    ),
    "true",
  );
  assert.equal(Math.round((await inspect()).height), 52 + MEDIA_VIEW_CARD_HEIGHT);
});

test("compact playback stays free of equalizers; horizontal mixer and seeking respect capability", async () => {
  await scene("playing");
  await evaluate(
    "mediaPreview.publish('playing','Night Drive','The Midnight',{sourceAppId:'Spotify.exe',artwork:{dataUrl:mediaPreview.artwork},controls:{previous:true,play:true,pause:true,next:true,seek:true},timeline:{positionMs:0,durationMs:240000,updatedAtUnixMs:Date.now(),playbackRateMilli:0}})",
  );
  await evaluate(
    "mediaPreview.publishAudio(70);mediaPreview.levels.apply({revision:mediaPreview.levels.snapshot().revision+1,available:true,peak:700})",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.media-row .spotify-equalizer').length",
    ),
    0,
  );
  assert.equal(
    await evaluate("document.querySelector('.media-seek').hidden"),
    false,
  );
  await evaluate(
    "document.querySelector('.media-seek').value='90000';document.querySelector('.media-seek').dispatchEvent(new Event('change'))",
  );
  await evaluate("new Promise(resolve=>setTimeout(resolve,100))");
  assert.deepEqual(await evaluate("mediaPreview.actions.at(-1)"), {
    seekMs: 90000,
  });
  assert.equal(
    await evaluate("mediaPreview.store.snapshot().player.timeline.positionMs"),
    90000,
  );
  assert.equal(
    await evaluate(
      "(() => {const mixer=document.querySelector('.audio-mixer').getBoundingClientRect();const row=document.querySelector('.audio-app-row');if(!row)return true;const r=row.getBoundingClientRect();return r.top>=mixer.top&&r.bottom<=mixer.bottom;})()",
    ),
    true,
    "First application row fits without scrolling",
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('.media-app-slider')].every(el=>el.getAttribute('aria-orientation')==='horizontal'&&el.getBoundingClientRect().width>el.getBoundingClientRect().height*3)",
    ),
    true,
  );
  await capture("notch-spotify-filled-audio");
  await command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 0,
    y: 383,
  });
  await evaluate(
    "mediaPreview.preferences({peekEnabled:false});mediaPreview.island.visibility.pointerLeft()",
  );
  await evaluate(settled);
  await capture("notch-spotify-compact-activity");
  assert.equal(
    await evaluate(
      "document.querySelector('.activity-strip').getAttribute('aria-hidden')",
    ),
    "false",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.activity-time').textContent.length>0",
    ),
    true,
  );
  await evaluate(
    "mediaPreview.open('media');mediaPreview.publish('playing','Video','Netflix',{sourceAppId:'chrome.exe',controls:{previous:true,play:true,pause:true,next:true,seek:false}})",
  );
  await evaluate(settled);
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.media-row .spotify-equalizer').length",
    ),
    0,
  );
  assert.equal(
    await evaluate("document.querySelector('.media-seek').hidden"),
    true,
  );
  await evaluate("mediaPreview.open('prompt')");
  await evaluate(settled);
  assert.equal((await inspect()).rowVisible, false);
  await evaluate(
    "mediaPreview.preferences({autoCloseInterval:120,peekEnabled:false});mediaPreview.open('media')",
  );
});
test("The working island reference stays compact, follows real states, and makes Review clickable", async(t)=>{
  t.after(clearPanelFixture);await panelFixture();
  await evaluate(`mediaPreview.publish('none');mediaPreview.preferences({peekEnabled:false,autoCollapseEnabled:false,modules:{vscode:true}});
    mediaPreview.state.tasks=mediaPreview.state.tasks.filter(t=>!t.sessionId);
    window.compactTask=mediaPreview.state.upsertCodingTask('codex','Mimo','C:/work/mimo','compact-reference');
    compactTask.state='thinking';compactTask.activity={tool:'',action:'Thinking',target:'',intent:'Planning the change'};
    mediaPreview.state.selectCodingTask(compactTask.id);mediaPreview.compact();`);
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.activity-strip').dataset.kind"),'coding');
  assert.equal(await evaluate("document.querySelector('.activity-work-title').textContent"),'Thinking');
  assert.equal(await evaluate("document.querySelector('.activity-work-detail').textContent"),'Planning the change');
  const bounds = await evaluate(`(()=>{const island=document.querySelector('#island').getBoundingClientRect();
    const copy=document.querySelector('.activity-work-copy').getBoundingClientRect(),status=document.querySelector('.activity-work-status').getBoundingClientRect();
    return {width:island.width,height:island.height,aligned:Math.abs(copy.top+copy.height/2-status.top-status.height/2)<1,
      fits:copy.left>=island.left+52&&copy.right<=status.left+1&&status.right<=island.right-10};})()`);
  assert.deepEqual(bounds,{width:264,height:40,aligned:true,fits:true});
  await capture('working-island-thinking-reference');
  for(const [action,title,target] of [['Read','Reading files','src-tauri/src/media.rs'],['Edit','Codex','media.rs'],['Run','Running tests','npm test']]){
    await evaluate(`compactTask.state='working';compactTask.activity={tool:${JSON.stringify(action)},action:${JSON.stringify(action)},phase:'running',
      target:${JSON.stringify(target)},startedAt:Date.now()-12000,stageCounts:{Read:2},changes:{added:42,removed:8}};mediaPreview.state.notify()`);
    await evaluate(settled);
    assert.equal(await evaluate("document.querySelector('.activity-work-title').textContent"),title);
    assert.equal(await evaluate("mediaPreview.island.engine.state"),'working');
    if(action==='Run')assert.match(await evaluate("document.querySelector('.activity-work-metric').textContent"),/^00:1[23]$/);
    await capture('working-island-'+action.toLowerCase()+'-reference');
  }
  await evaluate("compactTask.activity.phase='complete';mediaPreview.state.notify()");await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.activity-work-detail').textContent"),'Waiting for next action');
  assert.equal(await evaluate("document.querySelector('.activity-work-indicator').dataset.kind"),'dots');
  await evaluate(`compactTask.state='approval';compactTask.activity.phase='running';
    mediaPreview.state.pendingApproval={requestId:'compact-approval',taskId:compactTask.id,provider:'codex',tool:'Bash',command:'npm test'};
    mediaPreview.state.notify();mediaPreview.compact()`);await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.activity-work-title').textContent"),'Needs your approval');
  assert.equal(await evaluate("document.querySelector('.activity-review').textContent"),'Review');
  await capture('working-island-approval-reference');
  await pointerClick('.activity-review');await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"),'approval');
  assert.equal(await evaluate("mediaPreview.state.pendingApproval.requestId"),'compact-approval');
  await evaluate(`mediaPreview.state.pendingApprovals=[];mediaPreview.state.isPinned=false;
    compactTask.state='finished';compactTask.activity={tool:'Edit',action:'Edit',target:'media.rs',completed:true,
      files:[{target:'media.rs',phase:'complete',changes:{added:42,removed:8},preview:{lines:['return 42;']}}]};mediaPreview.open('overview');mediaPreview.compact();mediaPreview.state.notify()`);
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.activity-work-title').textContent"),'Finished');
  assert.equal(await evaluate("document.querySelector('.activity-work-detail').textContent"),'1 file · +42 −8');
  await capture('working-island-finished-reference');
  await pointerClick('.activity-review');await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-card').dataset.expanded"),'true');
  assert.equal(await evaluate("document.querySelector('.coding-edits').hidden"),false);
  assert.equal(await evaluate("document.querySelector('#island').getBoundingClientRect().height"),332);
  await evaluate("compactTask.state='idle';mediaPreview.compact();mediaPreview.state.notify()");await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.activity-strip').dataset.kind"),'idle');
});

test("Regular island hover follows coding or music without changing Working mode", async (t) => {
  t.after(() => loadPage('Page.reload'));
  await loadPage('Page.reload');
  await evaluate(`mediaPreview.preferences({workingModeEnabled:false,autoCollapseEnabled:true,
    hooksInstalled:true,codexHooksInstalled:true,modules:{media:true,vscode:true,developerIntegrations:false}});
    window.hoverTask=mediaPreview.state.upsertCodingTask('codex','Mimo','C:/work/mimo','hover-routing');
    mediaPreview.state.selectCodingTask(hoverTask.id);`);
  const prepare = async (state, action = '', playback = 'none') => {
    await command('Input.dispatchMouseEvent', {type:'mouseMoved',x:0,y:383});
    await evaluate(`hoverTask.state=${JSON.stringify(state)};hoverTask.pillBadge=null;hoverTask.lastEventAt=Date.now();
      hoverTask.activity={action:${JSON.stringify(action)},tool:${JSON.stringify(action === 'Run' ? 'Bash' : action)},
        target:${JSON.stringify(action === 'Run' ? 'npm test' : action ? 'src/app.ts' : '')},
        phase:${JSON.stringify(state === 'finished' ? 'complete' : 'running')},completed:${state === 'finished'},
        intent:'Following the current coding session',startedAt:Date.now()-3000};
      mediaPreview.publish(${JSON.stringify(playback)},'Night Drive','The Midnight');
      mediaPreview.open('media');mediaPreview.compact();mediaPreview.state.notify();`);
    await evaluate(settled);
  };
  const hover = async (view, core = 'app') => {
    const point = await evaluate(`(()=>{const r=document.querySelector('#island').getBoundingClientRect();return {x:r.left+80,y:r.top+20}})()`);
    await command('Input.dispatchMouseEvent', {type:'mouseMoved',...point});
    await evaluate(settled);
    assert.equal(await evaluate('mediaPreview.state.visibility'),'expanded');
    assert.equal(await evaluate('mediaPreview.state.view'),view);
    assert.equal(await evaluate("document.querySelector('#island').dataset.core"),core);
    assert.equal(await evaluate('mediaPreview.island.keyboardActive'),false,'Hover keeps keyboard focus in the source app');
  };
  for (const [state,action] of [['thinking',''],['working',''],['working','Read'],['working','Edit'],['working','Run'],['finished','Run']]) {
    await prepare(state,action);
    assert.equal(await evaluate("document.querySelector('.activity-strip').dataset.kind"),'coding');
    await hover('overview');
    assert.equal(await evaluate("document.querySelector('.coding-card').dataset.provider"),'codex');
  }
  await prepare('working','Run','playing');
  assert.equal(await evaluate("document.querySelector('.activity-strip').dataset.kind"),'music');
  await hover('media','hover');
  await capture('island-hover-music-with-coding');
  await prepare('working','Run','playing');
  await evaluate('new Promise(resolve=>setTimeout(resolve,8300))');
  assert.equal(await evaluate("document.querySelector('.activity-strip').dataset.kind"),'coding','The real activity rotation shows coding over ongoing playback');
  await hover('overview');
  assert.equal(await evaluate("mediaPreview.store.snapshot().state.playbackState"),'playing');
  await capture('island-hover-coding-with-music');
  await prepare('finished','Run','playing');
  assert.equal(await evaluate("document.querySelector('.activity-strip').dataset.kind"),'coding');
  await hover('overview');
  await command('Input.dispatchMouseEvent', {type:'mouseMoved',x:0,y:383});
  await evaluate('mediaPreview.preferences({workingModeEnabled:true});mediaPreview.hide()');
  await evaluate(settled);
  const lip = await evaluate(`(()=>{const r=document.querySelector('#island').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+6,width:r.width,height:r.height}})()`);
  assert.deepEqual([lip.width,lip.height],[156,12]);
  await command('Input.dispatchMouseEvent', {type:'mouseMoved',x:lip.x,y:lip.y});
  await evaluate(settled);
  assert.equal(await evaluate('mediaPreview.state.visibility'),'peek','Working mode keeps its existing click-only lip');
  await pointerClick('#restore-island');
  await evaluate(settled);
  assert.equal(await evaluate('mediaPreview.state.visibility'),'expanded');
});

test("compact music rolls real activity without integration avatars", async () => {
  await scene("playing");
  await evaluate(
    "mediaPreview.preferences({peekEnabled:false,modules:{media:true,vscode:true,developerIntegrations:true}});mediaPreview.publish('playing','Night Drive','The Midnight',{sourceAppId:'Spotify.exe'});mediaPreview.state.updateTask('integration_claude','working')",
  );
  await command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 0,
    y: 383,
  });
  await evaluate("mediaPreview.island.visibility.pointerLeft()");
  await evaluate("new Promise(resolve=>setTimeout(resolve,8300))");
  assert.equal(
    await evaluate("document.querySelector('#island').dataset.notification"),
    "true",
  );
  assert.equal(
    await evaluate("document.querySelector('.activity-work-title').textContent"),
    "Working",
  );
  assert.equal(
    await evaluate("document.querySelector('#mini-grid')"),
    null,
  );
  await capture("notch-rolling-activity");
  await evaluate("new Promise(resolve=>setTimeout(resolve,2500))");
  assert.equal(
    await evaluate("document.querySelector('#island').dataset.notification"),
    "false",
  );
  await evaluate(
    "mediaPreview.state.updateTask('integration_claude','idle');mediaPreview.open('media')",
  );
});
test("sleep hover opens the full player directly for playing and paused media", async () => {
  for (const playback of ["playing","paused"]) {
    await scene(playback);
    await evaluate(
      "mediaPreview.preferences({peekEnabled:true});mediaPreview.state.updateTask('integration_claude','working');mediaPreview.island.visibility.pointerLeft();mediaPreview.hide()",
    );
    await evaluate(settled);
    assert.equal(await evaluate("mediaPreview.state.visibility"), "peek");
    assert.equal(
      await evaluate("document.querySelector('#bot-canvas').style.opacity"),
      "1",
    );
    await command("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 0,
      y: 383,
    });
    await evaluate("mediaPreview.island.onCursor(360,8)");
    assert.equal(await evaluate("mediaPreview.state.visibility"), "peek");
    await evaluate(settled);
    assert.equal(await evaluate("mediaPreview.state.visibility"), "expanded");
    assert.equal(await evaluate("document.querySelector('#island').dataset.core"), "app");
    assert.equal(await evaluate("mediaPreview.state.view"), "media");
    assert.equal(await evaluate("mediaPreview.island.keyboardActive"), false, "Hover never steals keyboard focus");
    assert.equal((await inspect()).rowVisible, true);
    assert.ok(Math.round((await inspect()).height)>200);
    await pointerClick(".media-row .media-primary");
    assert.equal(await evaluate("mediaPreview.store.snapshot().state.playbackState"), playback==="playing"?"paused":"playing");
    await evaluate(settled);
    assert.equal(await evaluate("mediaPreview.state.view"), "media");
    assert.equal(await evaluate("document.querySelector('#island').dataset.core"), "app");
    assert.equal(await evaluate("mediaPreview.island.keyboardActive"), true);
  }
  await evaluate(
    "mediaPreview.state.updateTask('integration_claude','idle');mediaPreview.preferences({peekEnabled:false});mediaPreview.open('media')",
  );
  await evaluate(settled);
});

test("Home keeps a crisp Mimo when Spotify plays with peek enabled or disabled", async () => {
  await scene("playing");
  for (const peekEnabled of [true, false]) {
    await evaluate(
      `mediaPreview.preferences({peekEnabled:${peekEnabled},modules:{media:true,vscode:true,developerIntegrations:true}});mediaPreview.state.setFocus('integration_claude');mediaPreview.open('overview')`,
    );
    await evaluate(settled);
    assert.equal(
      await evaluate("document.querySelector('#bot-canvas').style.opacity"),
      "1",
    );
    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('#bot-canvas')).filter",
      ),
      "none",
    );
    assert.equal((await inspect()).rowVisible, false);
  }
  await capture("home-crisp-mimo-playing");
  await evaluate("mediaPreview.open('media')");
  await evaluate(settled);
});

test("idle bar has no stray vertical line beside Mimo", async () => {
  await scene("none", "", "", "compact");
  for (const appearance of ["dark"]) {
    await evaluate(`mediaPreview.preferences({appearance:${JSON.stringify(appearance)},peekEnabled:false});mediaPreview.compact()`);
    await evaluate(settled);
    assert.equal(await evaluate("document.querySelector('.activity-strip').dataset.kind"), "idle");
    const separator = await evaluate("getComputedStyle(document.querySelector('.activity-strip'),'::before').content");
    assert.equal(separator, "none");
  }
  await evaluate("mediaPreview.preferences({appearance:'dark'})");
});

test("Home retains useful actions and four connection choices when coding is disabled", async (t) => {
  t.after(()=>loadPage('Page.reload'));await loadPage('Page.reload');
  for(const vscode of [false,true,false]) {
    await evaluate("mediaPreview.preferences({modules:{media:false,vscode:"+vscode+",developerIntegrations:false}});mediaPreview.open('overview')");await evaluate(settled);
    assert.equal(await evaluate("document.querySelector('.home-welcome')"),null);
    assert.equal(await evaluate("document.querySelectorAll('.home-view .integration-tile').length"),4);
    assert.equal(await evaluate("!document.querySelector('[data-section=prompt]').hidden"),true);
  }
  await capture('home-coding-disabled');
});

test("idle bar centers the clock with zero to four real integration miniatures, including media off", async () => {
  await scene("none");
  for (let flags = 0; flags < 8; flags++) {
    const modules = {media:!!(flags&1),vscode:!!(flags&2),developerIntegrations:!!(flags&4)};
    await evaluate(`mediaPreview.preferences({modules:${JSON.stringify(modules)},peekEnabled:false,
      activeIntegrations:['integration_github','integration_n8n','integration_vercel']});
      mediaPreview.open('overview');mediaPreview.island.visibility.pointerLeft()`);
    await evaluate(settled);
    const state = await evaluate(`(() => {
      const island=document.querySelector('#island').getBoundingClientRect();
      const clock=document.querySelector('.activity-time').getBoundingClientRect();
      const grid=document.querySelector('.activity-integrations');
      return {kind:document.querySelector('.activity-strip').dataset.kind,
        cats:grid.querySelectorAll('canvas').length,hidden:grid.hidden,
        clock:document.querySelector('.activity-time').textContent,
        center:Math.abs(clock.left+clock.width/2-island.left-island.width/2),
        fits:grid.hidden||clock.right<grid.getBoundingClientRect().left,
        date:!!document.querySelector('.activity-date')};
    })()`);
    const expected=Number(modules.vscode)+3*Number(modules.developerIntegrations);
    assert.equal(state.kind,"idle");
    assert.equal(state.cats,expected);
    assert.equal(state.hidden,expected===0);
    assert.ok(state.clock.length>0 && state.center<0.5 && state.fits);
    assert.equal(state.date,false);
  }
  for(const clockEnabled of [false,true]) {
    await evaluate(`mediaPreview.preferences({clockEnabled:${clockEnabled}})`);await evaluate(settled);
    const divider=await evaluate(`(()=>{const strip=document.querySelector('.activity-strip'),style=getComputedStyle(strip,'::before');return {clockHidden:document.querySelector('.activity-time').hidden,dividerHidden:style.content==='none'||style.display==='none'}})()`);
    assert.equal(divider.clockHidden,!clockEnabled);
    assert.equal(divider.dividerHidden,true,'The clock never adds a vertical divider');
    if(!clockEnabled)await capture('idle-island-clock-off-no-divider');
  }
  await evaluate("mediaPreview.preferences({modules:{media:false,vscode:false,developerIntegrations:false},activeIntegrations:[]});mediaPreview.publish('playing','Background','Artist')");
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.activity-strip').dataset.kind"),"idle");
  await evaluate("mediaPreview.preferences({peekEnabled:true});mediaPreview.island.visibility.pointerEntered();mediaPreview.island.visibility.pointerLeft()");
  await evaluate("new Promise(resolve=>setTimeout(resolve,1100))");
  assert.equal(await evaluate("mediaPreview.state.visibility"),"island");
  assert.equal(await evaluate("mediaPreview.island.engine.state"),"idle");
  await evaluate("mediaPreview.preferences({peekEnabled:false,modules:{media:true,vscode:true,developerIntegrations:true},activeIntegrations:['integration_github']});mediaPreview.publish('paused');mediaPreview.open('media');mediaPreview.island.visibility.pointerLeft()");
  await evaluate(settled);
  assert.equal((await inspect()).ambientVisible,true);
  await evaluate("mediaPreview.open('media')");
  await evaluate(settled);
});

test("every resting mode has a working click and keyboard route into the full tool", async () => {
  for (const peekEnabled of [false,true]) {
    for (const playback of ["none","paused","playing"]) {
      await scene(playback,"Track","Artist","compact");
      await evaluate(`mediaPreview.preferences({peekEnabled:${peekEnabled}});${peekEnabled?"mediaPreview.hide()":"mediaPreview.compact()"}`);
      await evaluate(settled);
      // A keyboard/assistive activation follows the same handler as a mouse click.
      await evaluate("document.querySelector('#restore-island').click()");
      await evaluate(settled);
      assert.equal(await evaluate("mediaPreview.state.visibility"),"expanded");
      assert.equal(await evaluate("document.querySelector('#island').dataset.core"),"app");
      assert.equal(await evaluate("mediaPreview.state.view"),playback==="none"?"overview":"media");
      assert.ok(await evaluate("document.querySelector('#header').getBoundingClientRect().height>0"));
    }
  }
  await evaluate("mediaPreview.preferences({peekEnabled:false});mediaPreview.open('media')");
});

test("media fixtures finish without browser exceptions or unexpected controls", async () => {
  assert.deepEqual(browserErrors, []);
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.media-controls > button').length",
    ),
    5,
  );
});

test("Mimo matches the reference states at 32 px and follows both turns with either motion setting", async () => {
  const rendered = await evaluate(`(async () => {
    const { drawMimoFace, drawMimoBackdrop, drawMimoBadge } = await import('/src/mimo/face.ts');
    const { MIMO_VARIANTS } = await import('/src/mimo/status.ts');
    const results = [];
    for (const diameter of [16,24,32,58]) for (const lookX of [-1,0,1]) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 120;
      const ctx = canvas.getContext('2d'); ctx.translate(60,60);
      drawMimoFace(ctx, {radius:diameter/2,lookX});
      const pixels = ctx.getImageData(0,0,120,120).data;
      const bounds = {left:120,right:0,top:120,bottom:0}; let ink=0;
      for (let y=0;y<120;y++) for(let x=0;x<120;x++) {
        const i=(y*120+x)*4;
        if(pixels[i+3]>100) {bounds.left=Math.min(bounds.left,x);bounds.right=Math.max(bounds.right,x);bounds.top=Math.min(bounds.top,y);bounds.bottom=Math.max(bounds.bottom,y);}
        if(pixels[i+3]>200 && pixels[i]<70) ink++;
      }
      const earY=Math.round(60-diameter*0.37);
      const leftEar=pixels[(earY*120+Math.round(60-diameter*0.38))*4+3];
      const rightEar=pixels[(earY*120+Math.round(60+diameter*0.38))*4+3];
      results.push({diameter,lookX,bounds,ink,leftEar,rightEar});
    }
    const canvas=document.createElement('canvas'); canvas.width=canvas.height=120;
    const ctx=canvas.getContext('2d'); ctx.translate(60,60);
    drawMimoFace(ctx,{radius:24,eye:'closed',upsideDown:true});
    const pixels=ctx.getImageData(0,0,120,120).data;
    const alpha=(x,y)=>pixels[(y*120+x)*4+3];
    const variants=[];
    for(const status of ['loading','connected','sleepy','error']) {
      const tile=document.createElement('canvas'); tile.width=tile.height=32;
      const c=tile.getContext('2d'); c.translate(16,16);
      const radius=9.6, variant=MIMO_VARIANTS[status];
      drawMimoBackdrop(c,radius,true);
      drawMimoFace(c,{radius,eye:variant.eye,lookX:status==='loading'?-.4:0});
      drawMimoBadge(c,{radius,kind:variant.icon,color:variant.color});
      const data=c.getImageData(0,0,32,32).data;
      const target=variant.color.match(/[a-f\\d]{2}/gi).map(value=>parseInt(value,16));
      let badgeColor=0, glyph=0, eyes=0, lightestGlyph=0;
      for(let y=0;y<32;y++) for(let x=0;x<32;x++) {
        const i=(y*32+x)*4;
        const badgeDistance=Math.hypot(x+.5-(16-radius*1.2),y+.5-(16-radius*.45));
        if(badgeDistance<radius*.23) {
          if(target.every((v,k)=>Math.abs(data[i+k]-v)<32)) badgeColor++;
          if(data[i]>180&&data[i+1]>180&&data[i+2]>180) glyph++;
          lightestGlyph=Math.max(lightestGlyph,Math.min(data[i],data[i+1],data[i+2]));
        }
        if(x>=9&&x<23&&y>=16&&y<22&&data[i+3]>240&&data[i]<120&&data[i+1]<120&&data[i+2]<120) eyes++;
      }
      variants.push({status,badgeColor,glyph,lightestGlyph,eyes,forehead:[...c.getImageData(16,13,1,1).data]});
    }
    const appBadges=[];
    for(const [kind,color] of [['github','#F4505E'],['n8n','#F29B38'],['vscode','#3B82F6'],['vercel','#7C5CFF'],['stripe','#0570DE']]) {
      const tile=document.createElement('canvas'); tile.width=tile.height=32;
      const c=tile.getContext('2d'); c.translate(16,16);
      const badge={radius:9.6,kind,color:'#FFFFFF',appColor:color};
      drawMimoBadge(c,badge);
      const pixels=c.getImageData(0,0,32,32).data;
      const ink=color.match(/[a-f\\d]{2}/gi).map(value=>parseInt(value,16));
      const base=[27,27,34], axis=ink.map((v,i)=>v-base[i]);
      const strongest=axis.indexOf(Math.max(...axis));
      let visible=0, deviation=0;
      for(let y=0;y<32;y++) for(let x=0;x<32;x++) {
        if(Math.hypot(x+.5-4.48,y+.5-11.68)>2.6) continue;
        const i=(y*32+x)*4, opacity=(pixels[i+strongest]-base[strongest])/axis[strongest];
        if(opacity<.1) continue;
        visible++;
        deviation=Math.max(deviation,...axis.map((v,k)=>Math.abs(pixels[i+k]-(base[k]+opacity*v))));
      }
      appBadges.push({kind,visible,deviation});
    }
    return {results,variants,appBadges,sleep:{earBelow:alpha(78,78),earAbove:alpha(78,33)}};
  })()`);
  for (const item of rendered.results) {
    assert.ok(item.ink >= (item.diameter === 16 ? 2 : 6), JSON.stringify(item));
    assert.ok(item.bounds.right-item.bounds.left > item.bounds.bottom-item.bounds.top, JSON.stringify(item));
    assert.ok(item.leftEar > 100 && item.rightEar > 100, JSON.stringify(item));
  }
  assert.ok(rendered.sleep.earBelow > 100);
  assert.equal(rendered.sleep.earAbove,0);
  for(const badge of rendered.appBadges) {
    assert.ok(badge.visible>=1,`${badge.kind} stays visible at 32 px`);
    assert.ok(badge.deviation<8,`${badge.kind} inherits Mimo's color: ${JSON.stringify(badge)}`);
  }
  for (const variant of rendered.variants) {
    assert.ok(variant.badgeColor>=2,JSON.stringify(variant));
    assert.ok(variant.glyph>=1,JSON.stringify(variant));
    assert.ok(variant.eyes>=2,JSON.stringify(variant));
    assert.deepEqual(variant.forehead,[247,245,242,255],`${variant.status} keeps a clean white forehead`);
  }
  await evaluate("mediaPreview.preferences({peekEnabled:false,modules:{vscode:false,developerIntegrations:false}});mediaPreview.publish('none');mediaPreview.open('overview')");
  await evaluate(settled);
  await command("Emulation.setEmulatedMedia", {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const reduced = await evaluate(`new Promise(resolve=>setTimeout(()=>{
    const engine=mediaPreview.island.engine; engine.triggerEmote('love');
    mediaPreview.island.onCursor(2000,800);
    setTimeout(()=>resolve({yaw:engine.yaw,oy:engine.oy,sx:engine.sx,eye:engine.eyeOverride}),600);
  },100))`);
  assert.ok(reduced.yaw>.55); assert.equal(reduced.oy,0); assert.ok(Math.abs(reduced.sx-1)<1e-6); assert.equal(reduced.eye,'heart');
  await command("Emulation.setEmulatedMedia", {features:[]});
  await evaluate("mediaPreview.island.engine.eyeOverride=null;mediaPreview.island.ensureRunning()");
  await evaluate(settled);
  const homePlacement = await evaluate(`(() => {
    const card=document.querySelector('.module-activity,.module-empty').getBoundingClientRect();
    const island=document.querySelector('#island').getBoundingClientRect();
    return {x:mediaPreview.island.botCx.value,y:mediaPreview.island.botCy.value,
      top:card.top-island.top,bottom:card.bottom-island.top,
      tile:mediaPreview.island.engine.tile};
  })()`);
  assert.ok(Math.abs(homePlacement.x-68)<0.1);
  assert.ok(Math.abs(homePlacement.y-96)<0.1);
  assert.ok(homePlacement.y-29>=homePlacement.top && homePlacement.y+29<=homePlacement.bottom,'Mimo stays inside its Home card');
  assert.equal(homePlacement.tile,false,'Home keeps Mimo transparent');
  assert.equal(await evaluate("mediaPreview.island.engine.badge"),null,'Neutral Home has no persistent badge');
  await capture("mimo-home");
  await evaluate("mediaPreview.state.lastActivity=performance.now()-91000;mediaPreview.island.ensureRunning()");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.island.engine.state"),'sleeping');
  await evaluate("mediaPreview.island.onCursor(2050,850)");
  await evaluate("new Promise(resolve=>setTimeout(resolve,600))");
  assert.equal(await evaluate("mediaPreview.island.engine.state"),'idle','Desktop cursor activity wakes the companion outside the native window');
  assert.ok(await evaluate("mediaPreview.island.engine.yaw>0.55"));
  await connectedToolFixtures();
  await evaluate("mediaPreview.preferences({modules:{developerIntegrations:true,vscode:false},activeIntegrations:['integration_github','integration_stripe','integration_n8n','integration_vercel']});mediaPreview.open('integrations')");
  await evaluate(settled);
  await evaluate("mediaPreview.state.integrations.integration_github={configured:true,loaded:false,error:null,data:{}};mediaPreview.state.notify()");
  await selectIntegration('integration_github');
  await evaluate(settled);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#bot-canvas')).opacity"),'1',
    'The selected tool keeps its full-size interactive companion');
  assert.deepEqual(await evaluate("[Math.round(mediaPreview.island.botCx.value),Math.round(mediaPreview.island.botCy.value),Math.round(mediaPreview.island.botSize.value*.6)]"),[68,96,58]);
  assert.equal(await evaluate("document.querySelectorAll('.module-developer .mini canvas').length"),3,
    'The remaining tools retain their mini companions');
  for (const [name,id] of [['GitHub','integration_github'],['n8n','integration_n8n'],['Vercel','integration_vercel'],['Stripe','integration_stripe']]) {
    await evaluate(`mediaPreview.state.integrations.${id}={configured:true,loaded:false,error:null,data:{}};mediaPreview.state.notify()`);
    await evaluate("new Promise(resolve=>setTimeout(resolve,100))");
    await selectIntegration(id);
    await evaluate(settled);
    assert.equal(await evaluate("document.querySelector('.module-activity canvas')===null"),true);
    assert.equal(await evaluate("document.querySelectorAll('.module-developer .mini canvas').length"),3);
    assert.equal(await evaluate("document.querySelector('#bot-canvas').getAttribute('aria-hidden')"),'false',
      `${name} keeps its companion visible`);
    await capture(`mimo-choices-${id}`);
  }
  await evaluate("delete mediaPreview.state.integrations.integration_github;mediaPreview.preferences({modules:{developerIntegrations:false},activeIntegrations:[]});mediaPreview.open('overview')");
  await evaluate("mediaPreview.preferences({modules:{vscode:true}});mediaPreview.open('integrations')");
  await evaluate(settled);
  await selectIntegration('integration_claude');
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.island.engine.badge"),null,'The left companion omits app icon badges');
  assert.equal(await evaluate("mediaPreview.island.engine.tile"),false,'VS Code keeps Mimo transparent');
  assert.ok(await evaluate("mediaPreview.island.engine.faceColor.every((value,i)=>Math.abs(value-[247/255,245/255,242/255][i])<.005)"),'VS Code keeps the original white Mimo');
  await capture("mimo-app-vscode");
  await evaluate("mediaPreview.preferences({modules:{vscode:false}});mediaPreview.open('overview')");
  await evaluate(settled);
  assert.ok(await evaluate("mediaPreview.island.engine.faceColor.every((value,i)=>Math.abs(value-[247/255,245/255,242/255][i])<.005)"),'Home returns to the sheet white');
  await evaluate("mediaPreview.state.settings.lastVisibility='expanded';mediaPreview.island.launch()");
  await evaluate("new Promise(resolve=>setTimeout(resolve,600))");
  assert.equal(await evaluate("mediaPreview.state.view"),'greeting');
  await capture("mimo-greeting-rise");
  await evaluate("new Promise(resolve=>setTimeout(resolve,1200))");
  await capture("mimo-greeting-wave");
  await evaluate("new Promise(resolve=>setTimeout(resolve,1400))");
  await capture("mimo-greeting-badge");
  await evaluate("new Promise(resolve=>setTimeout(resolve,1700))");
  assert.equal(await evaluate("mediaPreview.state.view"),'overview','Intro completes into Home');
  await evaluate("mediaPreview.publish('playing','Night Drive','The Midnight');mediaPreview.compact()");
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('#bot-canvas').style.opacity"),'1');
  await capture("mimo-compact");
  await evaluate("mediaPreview.publish('none');mediaPreview.preferences({peekEnabled:true});mediaPreview.hide()");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.island.running"),false);
  await command("Emulation.setDefaultBackgroundColorOverride", {color:{r:11,g:13,b:18,a:1}});
  await capture("mimo-peek");
  await command("Emulation.setDefaultBackgroundColorOverride", {});
  await loadPage("Page.navigate", {url:'http://127.0.0.1:1431/dev/mimo-preview.html'});
  await evaluate("new Promise(resolve=>setTimeout(resolve,350))");
  await command("Emulation.setDeviceMetricsOverride", {width:960,height:1500,deviceScaleFactor:1,mobile:false});
  await capture("mimo-study");
  assert.deepEqual(browserErrors,[]);
});

test("Mimo's 24 expressions, hover petting, circling spirals and playback preserve attention and parking", async (t) => {
  t.after(async () => {
    await command("Emulation.setDeviceMetricsOverride", {width:960,height:800,deviceScaleFactor:1,mobile:false});
    await command("Emulation.setEmulatedMedia", {features:[]});
    await command("Emulation.setDefaultBackgroundColorOverride");
    await loadPage("Page.navigate", {url:'http://127.0.0.1:1431/dev/media-preview.html'});
  });
  await loadPage("Page.navigate", {url:'http://127.0.0.1:1431/dev/mimo-preview.html'});
  await evaluate("new Promise(resolve=>setTimeout(resolve,150))");
  const forehead = await evaluate(`(async () => {
    const {drawMimoFace}=await import('/src/mimo/face.ts');
    const canvas=document.createElement('canvas');canvas.width=canvas.height=128;
    const ctx=canvas.getContext('2d');ctx.translate(64,64);
    drawMimoFace(ctx,{radius:24,eye:'pill'});
    return [51,52,53].map(x=>[...ctx.getImageData(x,56,1,1).data]);
  })()`);
  assert.ok(forehead.every(([r,g,b,a])=>r>=230&&g>=230&&b>=r&&a===255),'The shared renderer keeps the current cool silver material');
  const codingIdentity = await evaluate(`(()=>[...document.querySelectorAll('#integrations figure')]
    .filter(figure=>figure.querySelector('figcaption').textContent==='VS Code')
    .map(figure=>{const c=figure.querySelector('canvas');return [...c.getContext('2d').getImageData(c.width/2,c.height*.42,1,1).data]}))()`);
  assert.equal(codingIdentity.length,2);
  assert.ok(codingIdentity.every(([r,g,b,a])=>r>=230&&g>=230&&b>=r&&a===255),'Both coding-provider studies retain the current silver identity');
  const performance = await evaluate(`(async () => {
    const {drawMimoFace}=await import('/src/mimo/face.ts');
    const render=(expression,eye,spiralAngle=0,reducedMotion=false)=>{
      const canvas=document.createElement('canvas');canvas.width=canvas.height=128;
      const ctx=canvas.getContext('2d');ctx.translate(64,64);
      drawMimoFace(ctx,{radius:24,expression,eye,expressionTime:1,spiralAngle,reducedMotion});
      return ctx.getImageData(0,0,128,128).data;
    };
    const a=render('dizzy','spiral'), b=render('dizzy','spiral',.7);
    let changed=0,left=128,right=0,top=128,bottom=0;
    for(let y=62;y<80;y++)for(let x=43;x<62;x++){
      const i=(y*128+x)*4;
      if(a[i+3]>200&&a[i]<140&&a[i+1]<140&&a[i+2]<140){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
      if(Math.abs(a[i]-b[i])>15)changed++;
    }
    const reducedA=render('dizzy','spiral',0,true),reducedB=render('dizzy','spiral',.7,true);
    const mouth=(expression)=>[...render(expression,'happy').slice((79*128+66)*4,(79*128+66)*4+4)];
    return {width:right-left+1,height:bottom-top+1,changed,reducedStill:reducedA.every((v,i)=>v===reducedB[i]),mouthMusic:mouth('music'),mouthDance:mouth('dancing')};
  })()`);
  assert.ok(performance.width>=8&&performance.height>=9,JSON.stringify(performance));
  assert.ok(performance.changed>4,'The larger spiral pupils visibly circle');
  assert.equal(performance.reducedStill,false,'Mimo keeps its spiral motion with either system motion setting');
  assert.ok(performance.mouthMusic[0]<100&&performance.mouthDance[0]>200,'Only the Music pose owns the tiny whistle mouth');
  for (const scale of [1, 2]) {
    await command("Emulation.setDeviceMetricsOverride", {width:960,height:1800,deviceScaleFactor:scale,mobile:false});
    // Recreate the static study at the current DPR rather than upscale its buffer.
    await loadPage("Page.reload");
    await evaluate("new Promise(resolve=>setTimeout(resolve,150))");
    const samples = await evaluate(`(() => {
      const measure = selector => [...document.querySelectorAll(selector+' canvas')].map(canvas => {
        const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
        let body=0, eye=0, coloredEye=0;
        for(let i=0;i<data.length;i+=4) {
          if(data[i]>200&&data[i+1]>180&&data[i+2]>180&&data[i+3]>200) body++;
          const x=(i/4)%canvas.width,y=Math.floor(i/4/canvas.width);
          if(x>canvas.width*.27&&x<canvas.width*.73&&y>canvas.height*.49&&y<canvas.height*.75
            &&data[i]<140&&data[i+1]<140&&data[i+2]<140&&data[i+3]>200) eye++;
          if(x>canvas.width*.27&&x<canvas.width*.73&&y>canvas.height*.49&&y<canvas.height*.75
            &&data[i]>175&&data[i+1]<210&&data[i+2]<180&&data[i+3]>200) coloredEye++;
        }
        return {name:canvas.closest('figure').dataset.expression,width:canvas.width,body,eye,coloredEye};
      });
      return {full:measure('#expressions'),compact:measure('#compact-expressions')};
    })()`);
    assert.equal(samples.full.length,24); assert.equal(samples.compact.length,24);
    for (const sample of [...samples.full,...samples.compact]) {
      assert.ok(sample.body>20,`${sample.name} has a visible head: ${JSON.stringify(sample)}`);
      if(sample.name!=='love') assert.ok(sample.eye>0,`${sample.name} has readable eyes: ${JSON.stringify(sample)}`);
      else assert.ok(sample.coloredEye>=2*scale*scale,`${sample.name} keeps the reference's colored pupils: ${JSON.stringify(sample)}`);
    }
    assert.ok(samples.compact.every(sample=>sample.width===32*scale));
    await evaluate("document.querySelector('#expressions').scrollIntoView({block:'start'})");
    await capture(`mimo-expressions-${scale}x`);
    await evaluate("document.querySelector('#compact-expressions').scrollIntoView({block:'start'})");
    await capture(`mimo-expressions-compact-${scale}x`);
  }
  const legacyStudy = await evaluate("[...document.querySelectorAll('#states canvas,#integrations canvas,#directions canvas')].map(c=>c.toDataURL())");
  await evaluate("document.querySelector('#expressions').scrollIntoView({block:'start'});document.querySelector('#replay-expressions').click()");
  await evaluate("new Promise(resolve=>setTimeout(resolve,180))");
  await capture('mimo-expressions-motion-180ms');
  const motion180 = await evaluate("document.querySelector('#expressions [data-expression=love] canvas').toDataURL()");
  await evaluate("new Promise(resolve=>setTimeout(resolve,300))");
  await capture('mimo-expressions-motion-480ms');
  assert.notEqual(await evaluate("document.querySelector('#expressions [data-expression=love] canvas').toDataURL()"),motion180,'Replay actually advances the expression canvases');
  await evaluate("new Promise(resolve=>setTimeout(resolve,450))");
  await capture('mimo-expressions-motion-930ms');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#states canvas,#integrations canvas,#directions canvas')].map(c=>c.toDataURL())"),legacyStudy,'Gesture replay preserves the app identity and gaze studies');
  await command("Emulation.setEmulatedMedia", {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await evaluate("mimoPreview.selectExpression('love')");
  await evaluate("new Promise(resolve=>setTimeout(resolve,350))");
  assert.deepEqual(await evaluate("mimoPreview.engine.expressionPose"),{eye:'heart',open:1,expression:'love'});
  assert.equal(await evaluate("mimoPreview.engine.busy"),true,'The system motion setting preserves the expression entrance');
  await command("Emulation.setEmulatedMedia", {features:[]});
  await command("Emulation.setDeviceMetricsOverride", {width:960,height:800,deviceScaleFactor:1,mobile:false});
  await loadPage("Page.navigate", {url:'http://127.0.0.1:1431/dev/media-preview.html'});
  await evaluate(`mediaPreview.preferences({peekEnabled:false,autoCollapseEnabled:false,modules:{vscode:false,developerIntegrations:false,media:true}});
    mediaPreview.publish('none');mediaPreview.open('media');
    mediaPreview.state.isPinned=true;mediaPreview.island.visibility.setPinned(true);mediaPreview.state.notify();`);
  await evaluate(settled);
  await evaluate("mediaPreview.publish('playing','Expression Track','Mimo')");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"),'music');
  assert.equal(await evaluate("mediaPreview.island.engine.busy"),true,'Actual visible playback animates the whistle and notes');
  const whistle = await evaluate("document.querySelector('#bot-canvas').toDataURL()");
  await capture('mimo-expression-whistling-media-dark');
  await evaluate("new Promise(resolve=>setTimeout(resolve,350))");
  assert.notEqual(await evaluate("document.querySelector('#bot-canvas').toDataURL()"),whistle,'The music notes keep moving during playback');
  const pet = await evaluate(`(()=>{const b=document.querySelector('#pat-mimo'),r=b.getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,title:b.getAttribute('title'),cursor:getComputedStyle(b).cursor,parentCursor:getComputedStyle(b.parentElement).cursor};})()`);
  assert.ok(pet.width>=44&&pet.height>=44);
  assert.equal(pet.title,null); assert.equal(pet.cursor,pet.parentCursor,'Petting has no cursor change or visible instruction');
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:pet.x-18,y:pet.y});
  await evaluate("new Promise(resolve=>setTimeout(resolve,220))");
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:pet.x+18,y:pet.y});
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"),'music','Two gentle passes acknowledge without changing expression');
  await evaluate("new Promise(resolve=>setTimeout(resolve,220))");
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:pet.x-18,y:pet.y});
  await evaluate("new Promise(resolve=>setTimeout(resolve,500))");
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"),'love','Three pointer passes show affection without a click');
  await capture('mimo-expression-hover-love-media-dark');
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:783});
  await evaluate("new Promise(resolve=>setTimeout(resolve,2600))");
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"),'music');
  for(let i=0;i<3;i++) await pointerClick('#pat-mimo');
  await evaluate("new Promise(resolve=>setTimeout(resolve,1550))");
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"),'dizzy','Three actual pointer pokes retain confusion');
  assert.equal(await evaluate("mediaPreview.state.view"),'confused');
  const confused = await evaluate("document.querySelector('#bot-canvas').toDataURL()");
  await capture('mimo-expression-circling-confusion-dark');
  await evaluate("new Promise(resolve=>setTimeout(resolve,250))");
  assert.notEqual(await evaluate("document.querySelector('#bot-canvas').toDataURL()"),confused,'Spirals circle after the original face roll');
  await evaluate("new Promise(resolve=>setTimeout(resolve,1800))");
  assert.equal(await evaluate("mediaPreview.state.view"),'media','Recovery returns to Media when it is the only enabled module');
  await evaluate("mediaPreview.open('media')");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"),'music','Playback belongs to the companion inside the player');
  assert.equal(await evaluate("document.querySelector('.media-companion')===null"),true,'No new companion is inserted beside the player');
  await evaluate("mediaPreview.open('media')");
  await evaluate(settled);
  await evaluate("mediaPreview.island.engine.musicStarted=performance.now()/1000-14.4;mediaPreview.island.ensureRunning()");
  await evaluate("new Promise(resolve=>setTimeout(resolve,600))");
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"),'dancing','A short dance punctuates longer whistle phrases');
  await capture('mimo-expression-dancing-media-dark');
  await command("Emulation.setEmulatedMedia", {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await evaluate("new Promise(resolve=>setTimeout(resolve,150))");
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"),'dancing');
  assert.equal(await evaluate("mediaPreview.island.engine.busy"),true);
  await command("Emulation.setEmulatedMedia", {features:[]});
  await evaluate("mediaPreview.open('approval');mediaPreview.state.stateOverride='approval';mediaPreview.state.notify();mediaPreview.island.engine.triggerEmote('love')");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"),'approval');
  assert.equal(await evaluate("mediaPreview.island.engine.badge.kind"),'bang');
  await capture('mimo-expression-approval-dark');
  await evaluate("mediaPreview.open('error');mediaPreview.state.stateOverride='ratelimit';mediaPreview.state.notify()");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.island.engine.badge.kind"),'hourglass');
  await evaluate("mediaPreview.publish('paused');mediaPreview.state.stateOverride=null;mediaPreview.state.observePower({onBattery:true,percent:20});mediaPreview.open('overview');mediaPreview.state.notify()");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"),'lowbattery');
  assert.equal(await evaluate("mediaPreview.island.engine.badge.kind"),'bolt');
  await evaluate("mediaPreview.preferences({appearance:'glass'})");
  await command("Emulation.setDefaultBackgroundColorOverride",{color:{r:15,g:16,b:21,a:1}});
  await evaluate(settled);
  await capture('mimo-expression-battery-glass');
  await evaluate("mediaPreview.state.observePower({onBattery:false,percent:20});mediaPreview.open('result');mediaPreview.state.searchResult={title:'Search',items:[]};mediaPreview.state.notify()");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"),'confused');
  await evaluate("mediaPreview.state.searchResult=null;mediaPreview.state.missedApprovals=[{requestId:'expression-missed',resolvedAt:null}];mediaPreview.open('overview');mediaPreview.state.notify()");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"),'worried');
  await capture('mimo-expression-worried-glass');
  await evaluate("mediaPreview.state.missedApprovals=[];mediaPreview.preferences({modules:{vscode:true}});mediaPreview.open('integrations')");
  await selectIntegration('integration_claude');
  await evaluate("mediaPreview.state.codingTask.activity={tool:'Edit',action:'Edit',target:'src/app.ts',phase:'running'};mediaPreview.state.updateTask('integration_claude','working');mediaPreview.state.notify()");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"),'focus');
  assert.equal(await evaluate("mediaPreview.island.engine.badge.kind"),'focus');
  await capture('mimo-expression-coding-focus-glass');
  await evaluate("mediaPreview.state.codingTask.activity=null;mediaPreview.state.updateTask('integration_claude','idle')");
  await evaluate("mediaPreview.state.missedApprovals=[];mediaPreview.state.notify();mediaPreview.preferences({peekEnabled:true});mediaPreview.hide()");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"),'idle','The minimized lip parks the hidden mascot in its neutral pose');
  assert.equal(await evaluate("mediaPreview.island.running"),false,'Peek retains its parked frame loop');
  assert.deepEqual(browserErrors,[]);
});

test("Assistant Settings separates chat, aligns provider details, and protects keys without Notices", async (t) => {
  const init = await command("Page.addScriptToEvaluateOnNewDocument", {
    source: "(" + function () {
      window.savedCredentials = { "stripe-api-key": true };
      window.usageReads = 0;
      window.lastHookProvider = null;
      window.failSave = false;
      window.hookConfigured = { claude: false, codex: false };
      window.events = {};
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      const callbacks = {};
      let next = 0;
      window.__TAURI_INTERNALS__ = {
        transformCallback: callback => { callbacks[++next] = callback; return next; },
        invoke: async (cmd, args) => {
          if (cmd === "boot") return { settings: { codingAssistant: "codex", downloadsEnabled: true,
            watchedProject: { cwd: "C:/work/shop", repository: "team/shop", branch: "main", vercelProject: "shop" } }, version: "test" };
          if (cmd === "hooks_status") return { installed: window.hookConfigured[args.provider], hookReady: true,
            usageReady: true, settingsPath: "test/" + (["codex","cursor"].includes(args.provider) ? "hooks.json" : "settings.json"), hookPath: "test/relay.exe" };
          if (cmd === "save_settings") { window.lastSettings = args.settings; return null; }
          if (cmd === "secret_present") return !!window.savedCredentials[args.key];
          if (cmd === "secret_set") {
            if (window.failSave) throw new Error("synthetic-private");
            window.savedCredentials[args.key] = true;
            return null;
          }
          if (cmd === "secret_clear") { delete window.savedCredentials[args.key]; return null; }
          if (cmd === "codex_usage" || cmd === "claude_usage") { window.usageReads++; return null; }
          if (cmd === "hooks_preview") {
            window.lastHookProvider = args.provider;
            return { diff: "+ SessionStart: Mimo companion", backup: "test/hooks.json.bak", fingerprint: "test-fingerprint" };
          }
          if (cmd === "hooks_apply") {
            window.hookConfigured[args.provider] = args.install;
            window.lastHookProvider = args.provider;
            return "test/hooks.json.bak";
          }
          if (cmd === "plugin:event|listen") { window.events[args.event] = callbacks[args.handler]; return ++next; }
          return null;
        },
      };
    }.toString() + ")()",
  });
  t.after(async () => {
    await command("Page.removeScriptToEvaluateOnNewDocument", { identifier: init.identifier });
    await command("Emulation.clearDeviceMetricsOverride");
    await loadPage("Page.navigate", { url: "http://127.0.0.1:1431/dev/media-preview.html" });
  });
  await command("Emulation.setDeviceMetricsOverride", { width: 760, height: 640, deviceScaleFactor: 1, mobile: false });
  await loadPage("Page.navigate", { url: "http://127.0.0.1:1431/settings.html" });
  await evaluate("new Promise(resolve=>setTimeout(resolve,400))");
  assert.equal(await evaluate("document.body.textContent.includes('Island behavior')"), false);
  assert.equal(await evaluate("[...document.querySelectorAll('h2')].some(el=>el.textContent==='Notices')"), false);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(el=>/Snooze|End snooze/.test(el.textContent))"), false);
  assert.equal(await evaluate("/Sleeping|Floating|Sleep mode/.test(document.querySelector('#settings-general').textContent)"), false);
  assert.equal(await evaluate("document.querySelector('[role=switch][aria-label=\"Working mode\"]').getAttribute('aria-checked')"), "true");
  await pointerClick('[role=switch][aria-label="Working mode"]');
  assert.equal(await evaluate("lastSettings.workingModeEnabled"), false, "Working mode saves the actual notch preference");
  assert.equal(await evaluate("document.querySelector('.working-mode-status').textContent"), "Tabs stay clear");
  await pointerClick('[role=switch][aria-label="Working mode"]');
  assert.equal(await evaluate("lastSettings.workingModeEnabled"), true);
  assert.deepEqual(await evaluate("(()=>{const r=document.querySelector('.working-mode-lip').getBoundingClientRect();return [r.width,r.height]})()"), [156,12]);
  assert.equal(await evaluate("document.querySelector('.working-mode-scene').getAnimations({subtree:true}).length"), 0);
  await evaluate("document.querySelector('[aria-controls=settings-general]').click()");
  assert.equal(await evaluate("document.querySelector('[aria-controls=settings-codex]')===null"), true);
  assert.equal(await evaluate("document.querySelector('.agent-usage')===null"), true, "Settings contains a preference, not usage charts");
  await evaluate("events['settings-page']({payload:'connections'})");
  assert.equal(await evaluate("document.querySelector('#settings-modules').hidden"),false,"Old connection links still open coding settings");
  await pointerClick('[aria-controls=settings-usage]');
  await evaluate("document.querySelector('[role=switch][aria-label=\"Limits & remaining capacity\"]').click()");
  assert.equal(await evaluate("lastSettings.usageEnabled"), false);
  assert.equal(await evaluate("'watchedProject' in lastSettings || 'downloadsEnabled' in lastSettings"),false,"Saving old preferences drops removed features");
  await evaluate("document.querySelector('[role=switch][aria-label=\"Limits & remaining capacity\"]').click()");
  assert.equal(await evaluate("lastSettings.usageEnabled"), true);
  for (let i = 0; i < 20; i++) await evaluate("document.querySelector('[aria-controls=settings-general]').click();document.querySelector('[aria-controls=settings-general]').click()");
  assert.equal(await evaluate("usageReads"), 0, "Settings never starts a usage read");
  await pointerClick('[aria-controls=settings-usage]');
  await capture("assistant-usage-settings");
  await pointerClick('[aria-controls=settings-modules]');
  await evaluate("document.querySelector('[aria-controls=settings-modules]').click()");
  const count = await evaluate("document.querySelectorAll('.audio-device-picker').length");
  for (let i = 0; i < 20; i++) await evaluate("document.querySelector('.settings-assistant').parentElement.querySelector('[data-device=claude]').click();document.querySelector('.settings-assistant').parentElement.querySelector('[data-device=codex]').click()");
  assert.equal(await evaluate("document.querySelectorAll('.audio-device-picker').length"), count);
  assert.equal(await evaluate("document.querySelectorAll('#settings-modules [data-assistant]:not([hidden])').length"), 1);
  for (const provider of ["codex", "claude", "cursor", "gemini", "antigravity", "muse", "opencode", "copilot", "hermes"]) {
    await evaluate("document.querySelector('.settings-assistant').parentElement.querySelector('[data-device=" + provider + "]').click()");
    await evaluate("document.querySelector('[data-assistant=" + provider + "] button.primary').click()");
    await evaluate("new Promise(resolve=>setTimeout(resolve,50))");
    assert.equal(await evaluate("lastHookProvider"), provider);
    await evaluate("[...document.querySelectorAll('[data-assistant=" + provider + "] button')].find(el=>el.textContent==='Back up and write').click()");
    await evaluate("new Promise(resolve=>setTimeout(resolve,50))");
    assert.match(await evaluate("document.querySelector('[data-assistant=" + provider + "]').textContent"), /Mimo will follow along/);
    assert.equal(await evaluate("lastSettings.chatProvider"), "openai", "Changing the coding connection preserves migrated chat");
    if(provider==='cursor') {
      assert.match(await evaluate("document.querySelector('[data-assistant=cursor]').textContent"), /hooks\.json/);
      await capture('cursor-connection-settings');
    }
  }
  await evaluate("document.querySelector('.settings-assistant').parentElement.querySelector('[data-device=codex]').click()");
  await capture("assistant-connection-settings");
  await pointerClick('[aria-controls=settings-chat]');
  const providerSpacing = await evaluate(`(()=>{const sections=[...document.querySelectorAll('#settings-chat [data-chat-provider] section')];
    return sections.slice(1).map((section,i)=>section.getBoundingClientRect().top-sections[i].getBoundingClientRect().bottom);})()`);
  assert.ok(providerSpacing.every(gap=>gap>=20),`Provider groups need a clear pause after the preceding key field: ${providerSpacing}`);
  assert.equal(await evaluate("document.querySelector('#settings-chat').textContent.includes('Add a key to use this provider')"),false,
    'Repeated instructions do not compete with provider details and the key field');
  for (const [width, dpr] of [[760, 1], [640, 2]]) {
    await command("Emulation.setDeviceMetricsOverride", {width, height:640, deviceScaleFactor:dpr, mobile:false});
    const providers = await evaluate(`([...document.querySelectorAll('#settings-chat [data-chat-provider] section')].map(section=>{
      const box=section.getBoundingClientRect(), heading=section.querySelector('h2').getBoundingClientRect();
      const link=section.querySelector('.chat-provider-link').getBoundingClientRect();
      const label=section.querySelector('.credential-field label')?.getBoundingClientRect();
      const controls=[...section.querySelectorAll('.credential-field input,.credential-field button')].filter(el=>!el.hidden&&el.checkVisibility()).map(el=>el.getBoundingClientRect());
      const innerLeft=box.left+parseFloat(getComputedStyle(section).paddingLeft);
      return {headingLeft:heading.left-innerLeft, aligned:Math.abs(heading.top+heading.height/2-link.top-link.height/2)<1,
        labelLeft:label?label.left-innerLeft:0, controlsAligned:controls.every(r=>Math.abs(r.top+r.height/2-controls[0].top-controls[0].height/2)<1),
        fits:link.right<=box.right+1&&controls.every(r=>r.left>=box.left-1&&r.right<=box.right+1)};
    }))`);
    assert.ok(providers.every(p=>p.headingLeft<1&&p.labelLeft<1&&p.aligned&&p.controlsAligned&&p.fits),
      `Provider headings, details and API key controls align at ${width}px / ${dpr}x: ${JSON.stringify(providers)}`);
  }
  await command("Emulation.setDeviceMetricsOverride", {width:760,height:640,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate("document.querySelector('#settings-chat [data-chat-provider=openai]').hidden"), false);
  assert.equal(await evaluate("document.querySelector('#settings-modules [data-assistant] input[type=password]')===null"), true, "Coding settings never request chat keys");
  const field = "[data-credential=openai-api-key]";
  assert.equal(await evaluate("document.querySelector('" + field + " button.danger').hidden"), true);
  await evaluate("document.querySelector('" + field + " input').value='synthetic-private';document.querySelector('" + field + " button:not(.danger)').click()");
  assert.equal(await evaluate("document.querySelector('" + field + " input').value"), "");
  await evaluate("new Promise(resolve=>setTimeout(resolve,50))");
  assert.equal(await evaluate("document.querySelector('" + field + " button.danger').hidden"), false);
  await evaluate("document.querySelector('" + field + " button.danger').click()");
  assert.equal(await evaluate("!!savedCredentials['openai-api-key']"), true, "Opening Danger zone keeps the credential until confirmation");
  assert.equal(await evaluate("document.querySelector('" + field + " .credential-removal').hidden"), false);
  await capture("settings-red-danger-zone");
  await evaluate("document.querySelector('" + field + " .credential-removal button:not(.danger)').click()");
  assert.equal(await evaluate("!!savedCredentials['openai-api-key']"), true, "Cancel keeps the saved credential");
  assert.equal(await evaluate("document.querySelector('" + field + " .credential-removal').hidden"), true);
  await evaluate("document.querySelector('" + field + " button.danger').click();document.querySelector('" + field + " .confirm-credential-removal').click()");
  await evaluate("new Promise(resolve=>setTimeout(resolve,50))");
  assert.equal(await evaluate("document.querySelector('" + field + " button.danger').hidden"), true);
  assert.equal(await evaluate("!!savedCredentials['openai-api-key']"), false);
  await evaluate("failSave=true;document.querySelector('" + field + " input').value='synthetic-private';document.querySelector('" + field + " button:not(.danger)').click()");
  await evaluate("new Promise(resolve=>setTimeout(resolve,50))");
  assert.equal(await evaluate("document.body.textContent.includes('synthetic-private')"), false, "Errors never echo credentials");
  await evaluate("document.querySelector('" + field + " input').value='synthetic-private';events['settings-hidden']({payload:null})");
  assert.equal(await evaluate("document.querySelector('" + field + " input').value"), "", "Closing Settings clears unsaved credentials");
  await evaluate("failSave=false");
  assert.equal(await evaluate("document.querySelector('.settings-connections-provider')===null"), true);
  assert.equal(await evaluate("document.querySelector('#settings-chat [data-chat-provider] [aria-haspopup=listbox]')===null"), true, "Providers and models are selected in chat");
  assert.equal(await evaluate("document.querySelectorAll('#settings-chat [data-chat-provider]:not([hidden]):not([inert])').length"), 7);
  for (const provider of ["gemini", "openrouter", "xai", "groq", "ollama"]) {
    assert.equal(await evaluate("lastSettings.codingAssistant"), "codex");
    assert.equal(await evaluate("lastSettings.chatProvider"), "openai");
    if (provider === "ollama") {
      assert.equal(await evaluate("document.querySelector('[data-chat-provider=ollama] input[type=password]')===null"), true);
    } else {
      const key = provider + "-api-key";
      await evaluate("document.querySelector('[data-credential=" + key + "] input').value='synthetic-private';document.querySelector('[data-credential=" + key + "] button:not(.danger)').click()");
      await evaluate("new Promise(resolve=>setTimeout(resolve,20))");
      assert.equal(await evaluate("document.querySelector('[data-credential=" + key + "] input').value"), "");
      assert.equal(await evaluate("savedCredentials['" + key + "']"), true);
    }
  }
  await capture("chat-key-settings");
  await pointerClick('[aria-controls=settings-integrations]');
  assert.equal(await evaluate("document.querySelector('.watched-project')"),null);
  await evaluate("document.querySelector('.connection-settings').open=true");
  const stripe = "[data-credential=stripe-api-key]";
  assert.equal(await evaluate("document.querySelector('" + stripe + " button.danger').hidden"), false);
  await evaluate("document.querySelector('" + stripe + " button.danger').click()");
  await evaluate("document.querySelector('" + stripe + " .confirm-credential-removal').click()");
  await evaluate("new Promise(resolve=>setTimeout(resolve,50))");
  assert.equal(await evaluate("document.querySelector('" + stripe + " button.danger').hidden"), true);
});

test("Startup greeting waits for hover and never waves on the compact island", async (t) => {
  t.after(async () => {
    await evaluate("window.pawGreeting?.interrupt();delete window.pawGreeting;delete window.pawCanvas;delete window.paintPaw");
    await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  });
  await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  const readings = await evaluate(`(async()=>{
    const {Greeting}=await import('/src/mimo/greeting.ts');
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=150;window.pawCanvas=canvas;
    const ctx=canvas.getContext('2d');window.pawGreeting=new Greeting();pawGreeting.start();
    window.paintPaw=seconds=>{
      pawGreeting.startMs=performance.now()-seconds*1000;pawGreeting.draw(ctx);
      const pixels=ctx.getImageData(360,66,24,44).data;let white=0;
      for(let i=0;i<pixels.length;i+=4)if(pixels[i]>170&&pixels[i+1]>170&&pixels[i+2]>170&&pixels[i+3]>190)white++;
      return white;
    };
    return {before:paintPaw(1),wave:paintPaw(2),after:paintPaw(3)};
  })()`);
  assert.equal(readings.before,0);
  assert.ok(readings.wave>40,`The greeting raises a visible white paw: ${JSON.stringify(readings)}`);
  assert.equal(readings.after,0,"The paw tucks away before Mimo settles");
  const pawFrame=await evaluate("paintPaw(2);pawCanvas.toDataURL('image/png')");
  await writeFile(join(artifacts,"checkpoint-greeting-paw.png"),Buffer.from(pawFrame.split(',')[1],"base64"));
  await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  assert.ok(await evaluate("paintPaw(2)")>40,"The system motion setting does not suppress Mimo's wave");
  await command("Input.dispatchMouseEvent", {type:"mouseMoved",x:0,y:400});
  await evaluate("mediaPreview.publish('none');mediaPreview.state.tasks=[];mediaPreview.state.pendingApprovals=[];mediaPreview.state.pendingApproval=null;mediaPreview.preferences({workingModeEnabled:false,modules:{media:false}});mediaPreview.state.settings.lastVisibility='island';mediaPreview.island.launch()");
  await evaluate(settled);
  assert.notEqual(await evaluate("mediaPreview.state.view"),'greeting');
  assert.notEqual(await evaluate("mediaPreview.island.engine.currentExpression"),'greeting');
  const hover = await evaluate("(()=>{const r=document.querySelector('#island').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+20}})()");
  await command("Input.dispatchMouseEvent", {type:"mouseMoved",...hover});
  await evaluate("new Promise(resolve=>setTimeout(resolve,150))");
  assert.equal(await evaluate("mediaPreview.state.visibility"),'expanded');
  assert.equal(await evaluate("mediaPreview.state.view"),'greeting');
  await command("Input.dispatchMouseEvent", {type:"mouseMoved",x:0,y:400});
  await evaluate("mediaPreview.island.visibility.island()");
  await evaluate(settled);
  assert.notEqual(await evaluate("mediaPreview.state.view"),'greeting');
  assert.notEqual(await evaluate("mediaPreview.island.engine.currentExpression"),'greeting');
  await command("Input.dispatchMouseEvent", {type:"mouseMoved",...hover});
  await evaluate(settled);
  assert.notEqual(await evaluate("mediaPreview.state.view"),'greeting',"Leaving the intro consumes it; later hovers show Home");
});

test("Greeting cards stay visible and share the shell insets in Dark and Glass", async (t) => {
  t.after(() => loadPage("Page.reload"));
  const surfaces = [];
  for (const appearance of ["dark"]) {
    await command("Input.dispatchMouseEvent", {type:"mouseMoved",x:0,y:400});
    await evaluate(`mediaPreview.publish('none');mediaPreview.preferences({appearance:'${appearance}',autoCollapseEnabled:false});mediaPreview.state.settings.lastVisibility='expanded';mediaPreview.island.launch()`);
    await command("Input.dispatchMouseEvent", {type:"mouseMoved",x:360,y:30});
    await evaluate("new Promise(resolve=>setTimeout(resolve,700))");
    assert.equal(await evaluate("mediaPreview.state.view"), "greeting");
    await capture(`greeting-card-${appearance}`);
    const surface = await evaluate(`(() => {
      const canvas=document.querySelector('#greeting-canvas'),ctx=canvas.getContext('2d');
      const dpr=canvas.width/640;
      const pixel=(x,y)=>[...ctx.getImageData(Math.round(x*dpr),Math.round(y*dpr),1,1).data];
      return {inside:pixel(32,90),outside:pixel(12,90),above:pixel(320,34),
        island:document.querySelector('#island').getBoundingClientRect().height};
    })()`);
    assert.ok(surface.inside[3] > 40, `${appearance} has a visible greeting surface`);
    assert.equal(surface.outside[3], 0, "Greeting leaves the same side inset as the other cards");
    assert.equal(surface.above[3], 0, "Greeting leaves the header clear");
    assert.ok(Math.abs(surface.island-150)<1);
    surfaces.push(surface.inside);
    await evaluate("mediaPreview.open('overview')");
    await evaluate(settled);
    const home = await evaluate(`(() => {
      const island=document.querySelector('#island').getBoundingClientRect();
      const card=document.querySelector('.module-activity,.module-empty'),r=card.getBoundingClientRect();
      const css=getComputedStyle(card);
      return {left:r.left-island.left,right:island.right-r.right,
        fill:css.backgroundColor,border:css.borderTopColor,blur:css.backdropFilter,
        top:r.top-island.top,bottom:r.bottom-island.top,mascot:mediaPreview.island.botCy.value};
    })()`);
    assert.ok(Math.abs(home.left-18)<1 && home.right>=18,'Home keeps the original shell inset');
    assert.notEqual(home.fill, "rgba(0, 0, 0, 0)");
    assert.notEqual(home.border, "rgba(0, 0, 0, 0)");
    assert.equal(home.blur, "none");
    assert.ok(home.mascot-29>=home.top && home.mascot+29<=home.bottom,'Mimo fits its retained workspace');
    await capture(`home-card-${appearance}`);
  }
  assert.ok(surfaces[0][3] > 40, "Dark keeps the greeting visible");
});

test("Shared island usage stays static, follows both connections, and releases when off", async (t) => {
  t.after(() => loadPage("Page.reload"));
  await loadPage("Page.navigate", {url:'http://127.0.0.1:1431/dev/media-preview.html'});
  await evaluate("(async()=>{const {Bridge}=await import('/src/core/bridge.ts');window.usageReads=0;window.claudeReads=0;Bridge.codexUsage=async()=>{usageReads++;return {plan:'pro',primary:{usedPercent:25,windowMinutes:300,resetsAt:1900000000},secondary:{usedPercent:63,windowMinutes:10080,resetsAt:1900600000},lifetimeTokens:1234567,peakDailyTokens:null,checkedAt:Date.now()/1000}};Bridge.claudeUsage=async()=>{claudeReads++;return {plan:null,primary:{usedPercent:20,windowMinutes:300,resetsAt:1900000000},secondary:{usedPercent:45,windowMinutes:10080,resetsAt:1900600000},lifetimeTokens:null,contextUsedPercent:28,inputTokens:12000,outputTokens:1400,sessionCostUsd:0.14,checkedAt:Date.now()/1000}}})()");
  await evaluate("mediaPreview.preferences({codingAssistant:'codex',codexHooksInstalled:true,hooksInstalled:false,usageEnabled:true,appearance:'dark',modules:{vscode:true}});mediaPreview.open('usage')");
  await evaluate(settled);
  assert.equal(await evaluate("usageReads"), 1);
  assert.equal(await evaluate("document.querySelector('[data-section=usage]').hidden"), false);
  assert.equal(await evaluate("document.querySelector('[data-section=overview]').getAttribute('aria-current')"),null);
  assert.equal(await evaluate("document.querySelector('[data-section=usage]').getAttribute('aria-current')"),'page');
  const headerClear = () => evaluate(`(() => {
    const island=document.querySelector('#island').getBoundingClientRect();
    const home=document.querySelector('[data-section=overview]').getBoundingClientRect();
    const headRight=mediaPreview.island.botCx.value+mediaPreview.island.botSize.value*.36+8;
    return home.left-island.left>=headRight;
  })()`);
  assert.equal(await headerClear(), true, "Usage reserves space for Mimo before the Home button");
  await capture("assistant-usage-island-dark");
  await evaluate("window.retainedUsage=document.querySelector('.agent-usage');mediaPreview.preferences({appearance:'glass'})");
  await evaluate(settled);
  assert.equal(await evaluate("retainedUsage===document.querySelector('.agent-usage')"), true);
  await pointerClick('.usage-back');
  await evaluate(settled);
  await pointerClick('[data-section=usage]');
  await evaluate(settled);
  assert.equal(await headerClear(), true, "Hovering Usage keeps Home clear in Glass");
  assert.equal(await evaluate("[...retainedUsage.querySelectorAll('*')].some(el=>getComputedStyle(el).backdropFilter!=='none')"), false);
  await capture("assistant-usage-island-glass");
  for (let i = 0; i < 20; i++) await evaluate("mediaPreview.open('overview');mediaPreview.open('usage')");
  assert.equal(await evaluate("usageReads"), 1);
  assert.equal(await evaluate("retainedUsage===document.querySelector('.agent-usage')"), true);
  assert.equal(await evaluate("retainedUsage.getAnimations({subtree:true}).length"), 0);
  await evaluate("mediaPreview.preferences({hooksInstalled:true})");await evaluate(settled);
  await pointerClick('.usage-agent-select');await pointerClick('.audio-device-menu:popover-open [data-device=claude]');
  await evaluate(settled);
  assert.equal(await evaluate("claudeReads"), 1);
  assert.deepEqual(await evaluate("[...retainedUsage.querySelectorAll('[role=progressbar]')].map(el=>el.getAttribute('aria-valuenow'))"), ["80", "55"]);
  assert.match(await evaluate("retainedUsage.textContent"), /28% context/);
  await capture("assistant-usage-island-both");
  await evaluate("document.querySelector('.usage-agent-select').click();document.querySelector('.audio-device-menu:popover-open [data-device=codex]').click()");
  assert.equal(await evaluate("usageReads"), 1);
  await evaluate(`(async()=>{const {Activity}=await import('/src/core/activity.ts');
    Activity.observeUsage('codex',{plan:'pro',primary:{usedPercent:25,windowMinutes:1440,resetsAt:1900000000},secondary:{usedPercent:63,windowMinutes:10080,resetsAt:1900600000},lifetimeTokens:null,checkedAt:Date.now()/1000+1})})()`);
  assert.equal(await evaluate("document.querySelector('.header-capacity').hidden"),true,"The header shows only a reported five-hour window");
  assert.equal(await evaluate("document.querySelector('.header-limits').textContent.includes('Limits')"),true,"Limits remains accessible without a five-hour reading");
  const disposed = await evaluate("(async()=>{const {UsagePanel}=await import('/src/views/codex-usage.ts');const {Bridge}=await import('/src/core/bridge.ts');let finish;Bridge.codexUsage=()=>new Promise(resolve=>finish=resolve);mediaPreview.preferences({hooksInstalled:false});const panel=new UsagePanel();document.body.append(panel.el);panel.setVisible(true);await new Promise(resolve=>setTimeout(resolve,0));panel.el.querySelector('.agent-usage-refresh').click();const before=panel.el.textContent;panel.destroy();finish({plan:'pro',primary:null,secondary:null,lifetimeTokens:null,checkedAt:1});await Promise.resolve();await Promise.resolve();return {detached:!panel.el.isConnected,unchanged:before===panel.el.textContent}})()");
  assert.deepEqual(disposed, { detached: true, unchanged: true });
  await evaluate("mediaPreview.preferences({usageEnabled:false})");
  await evaluate(settled);
  assert.equal(await evaluate("[...document.querySelectorAll('.home-footer button')].some(b=>b.textContent==='Limits')"),false);
  assert.equal(await evaluate("document.querySelector('.agent-usage')===null"), true);
  assert.equal(await evaluate("mediaPreview.state.view"), "overview");
});

test("Ask panel follows its chat provider independently and discards stale chat replies", async (t) => {
  t.after(() => loadPage("Page.reload"));
  for (const [provider, name] of [["anthropic", "Claude"], ["openai", "OpenAI"], ["gemini", "Gemini"], ["openrouter", "OpenRouter"], ["ollama", "Ollama"]]) {
    await evaluate("mediaPreview.preferences({chatProvider:'" + provider + "',codingAssistant:'opencode'});mediaPreview.state.clearChat();mediaPreview.open('prompt')");
    await evaluate(settled);
    assert.equal(await evaluate("document.querySelector('.chat-input').placeholder"), "Ask " + name + "…");
    assert.equal(await evaluate("document.querySelector('.chat-input').getAttribute('aria-label')"), "Ask " + name);
    await evaluate("mediaPreview.open('utilities')");
    await evaluate(settled);
    assert.equal(await evaluate("document.querySelector('[data-section=prompt]').getAttribute('aria-label')"), "Chat");
    await evaluate("mediaPreview.open('overview')");
    await evaluate(settled);
    await pointerClick('[data-section=prompt]'); await evaluate(settled);
    assert.equal(await evaluate("document.querySelector('.chat-input').placeholder"), "Ask " + name + "…");
  }
  await evaluate("(async()=>{const {Bridge}=await import('/src/core/bridge.ts');Bridge.chatSend=()=>new Promise(resolve=>window.finishChat=resolve);mediaPreview.open('prompt')})()");
  await evaluate("document.querySelector('.chat-input').value='old-provider-question';document.querySelector('.send-btn').click()");
  await evaluate("mediaPreview.preferences({chatProvider:'anthropic'});mediaPreview.state.clearChat();mediaPreview.state.notify();finishChat({text:'stale-private-reply'})");
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.chat-log').textContent.includes('stale-private-reply')"), false);
  assert.equal(await evaluate("document.querySelector('.chat-input').placeholder"), "Ask Claude…");
});

test("Chat picker switches connected providers and models inside chat without changing coding", async (t) => {
  t.after(() => loadPage("Page.reload"));
  await evaluate(`(async()=>{
    const {Bridge}=await import('/src/core/bridge.ts');
    const {normalizeSettings}=await import('/src/core/state.ts');
    window.chatSelections=[]; window.failSelection=false;
    Bridge.chatConnections=async()=>({anthropic:true,gemini:true,openai:false,openrouter:true,ollama:true});
    Bridge.chatSelect=async(provider,model)=>{
      chatSelections.push({provider,model});
      if(failSelection) throw new Error('Could not save this chat model. Try again.');
      return normalizeSettings({...mediaPreview.state.settings,chatProvider:provider,
        chatModels:{...mediaPreview.state.settings.chatModels,[provider]:model}});
    };
    mediaPreview.preferences({codingAssistant:'opencode',chatProvider:'anthropic',autoCollapseEnabled:false});
    mediaPreview.state.clearChat();mediaPreview.open('prompt');
  })()`);
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('[data-section=prompt]').getAttribute('aria-current')"), "page");
  await pointerClick(".chat-model-toggle");
  assert.equal(await evaluate("document.querySelector('.chat-model-toggle').getAttribute('aria-expanded')"), "true");
  assert.equal(await evaluate("document.querySelector('[data-chat-provider=openai]').disabled"), true);
  await evaluate(`mediaPreview.state.chatHistory=[{id:901,role:'user',content:'earlier message'}];
    mediaPreview.state.droppedFiles=[{name:'notes.txt',path:'inbox/notes.txt'}];
    document.querySelector('.chat-input').value='keep this draft';
    document.querySelector('.chat-input').dispatchEvent(new Event('input'));mediaPreview.state.notify()`);
  await pointerClick(".chat-model-panel [data-chat-provider=gemini]");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.settings.chatProvider"), "gemini",
    "Provider selection stays clickable after the conversation and attachment change");
  assert.equal(await evaluate("mediaPreview.state.settings.codingAssistant"), "opencode");
  assert.equal(await evaluate("document.querySelector('.chat-input').value"), "keep this draft");
  assert.equal(await evaluate("mediaPreview.state.droppedFiles[0].name"), "notes.txt");
  assert.equal(await evaluate("mediaPreview.state.chatHistory.length"), 0, "The backend starts a fresh conversation when switching");
  await pointerClick(".chat-model-select");
  await command("Input.dispatchKeyEvent", {type:"keyDown",key:"ArrowDown",code:"ArrowDown"});
  await command("Input.dispatchKeyEvent", {type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13,text:"\r"});
  await command("Input.dispatchKeyEvent", {type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.settings.chatModels.gemini"), "gemini-2.5-flash");
  assert.equal(await evaluate("document.querySelector('.chat-model-toggle').getAttribute('aria-expanded')"), "false");
  await pointerClick(".chat-model-toggle");
  await evaluate("failSelection=true");
  await pointerClick(".chat-model-panel [data-chat-provider=openrouter]");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.settings.chatProvider"), "gemini");
  assert.equal(await evaluate("document.querySelector('.chat-input').value"), "keep this draft");
  assert.match(await evaluate("document.querySelector('.chat-error').textContent"), /Could not save/);
  await evaluate("failSelection=false;document.querySelector('.chat-model-panel [data-chat-provider=openrouter]').click()");
  await evaluate(settled);
  await pointerClick(".chat-model-select");
  await evaluate("document.querySelector('.chat-model-panel [data-device=custom]').click()");
  await evaluate("document.querySelector('.chat-custom-model input').value='openrouter/auto:free';document.querySelector('.chat-custom-model button').click()");
  assert.equal(await evaluate("chatSelections.at(-1).model"), "openrouter/free", "Invalid free model IDs never reach IPC");
  await evaluate("document.querySelector('.chat-custom-model input').value='example/model:free';document.querySelector('.chat-custom-model button').click()");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.settings.chatModels.openrouter"), "example/model:free");
  await pointerClick(".chat-model-toggle");
  await command("Input.dispatchKeyEvent", {type:"keyDown",key:"Escape",code:"Escape"});
  assert.equal(await evaluate("mediaPreview.state.view"), "prompt");
  assert.equal(await evaluate("document.querySelector('.chat-model-toggle').getAttribute('aria-expanded')"), "false");
});

test("Chat drops preserve drafts and history, wait for copying, and attach later turns", async (t) => {
  t.after(async () => {
    await command("Emulation.setEmulatedMedia", {features:[]});
    await loadPage("Page.reload");
  });
  await command("Emulation.setEmulatedMedia", {features:[{name:"prefers-reduced-motion",value:"reduce"}]});
  await evaluate(`(async()=>{
    const {Bridge}=await import('/src/core/bridge.ts');window.chatCalls=[];
    const {Sound}=await import('/src/core/sound.ts');const {UploadSeq}=await import('/src/upload/sequence.ts');
    window.fileSounds=[];const play=Sound.play.bind(Sound);Sound.play=name=>{fileSounds.push({name,since:UploadSeq.sinceDrop()});play(name)};
    Bridge.chatConnections=async()=>({anthropic:true});
    Bridge.ingestFile=()=>new Promise((resolve,reject)=>{window.finishIngest=resolve;window.failIngest=reject});
    Bridge.chatSend=async(query,context)=>{chatCalls.push({query,context});return {text:'Attached reply'}};
    mediaPreview.state.clearChat();mediaPreview.open('prompt');
    mediaPreview.state.uploadDuration=0.2;
    mediaPreview.state.chatHistory=[{id:801,role:'user',content:'first'},{id:802,role:'assistant',content:'earlier reply'}];
    mediaPreview.state.notify();
  })()`);
  await evaluate(settled);
  await aimFileAtIsland();
  await evaluate("document.querySelector('.chat-input').value='about this file';mediaPreview.island.onDragDrop({type:'enter'});mediaPreview.island.onDragDrop({type:'drop',paths:['C:/fixture/notes.txt']})");
  await evaluate("new Promise(resolve=>requestAnimationFrame(resolve))");
  assert.equal(await evaluate("mediaPreview.state.view"), "uploading");
  assert.equal(await evaluate("document.querySelector('.chat-input').value"), "about this file");
  assert.equal(await evaluate("mediaPreview.state.chatHistory.length"), 2);
  assert.equal(await evaluate("mediaPreview.state.chatAttachmentLoading"), "notes.txt");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"), "uploading", "A slow copy cannot return to chat before the file is ready");
  assert.equal(await evaluate("fileSounds.filter(sound=>['approve','finish'].includes(sound.name)).length"),0,'Starting a drop and waiting for a slow copy do not ring a completion chime');
  const gulp = await evaluate("fileSounds.filter(sound=>sound.name==='gulp')");
  assert.equal(gulp.length,1,'One gulp plays when the file is swallowed');
  assert.ok(gulp[0].since>=.72,'The gulp waits until the file reaches the mouth');
  await evaluate("finishIngest({name:'notes.txt',path:'inbox/notes.txt',size:42})");
  await evaluate(ateFile);
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"), "choose");
  assert.equal(await evaluate("fileSounds.filter(sound=>sound.name==='gulp').length"),1,'Later animation frames never repeat the gulp');
  assert.equal(await evaluate("fileSounds.filter(sound=>sound.name==='finish').length"),1,'The loaded file chimes exactly once with the selected finish cue');
  await pointerClick('.upload-hit[aria-label="Ask a question about this file"]');
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"), "prompt");
  assert.match(await evaluate("document.querySelector('.chip-row').textContent"), /notes.txt/);
  await evaluate("document.querySelector('.send-btn').click()");
  await evaluate(settled);
  assert.deepEqual(await evaluate("chatCalls[0]"), {query:"about this file",context:{kind:"file",name:"notes.txt",path:"inbox/notes.txt"}});
  assert.equal(await evaluate("mediaPreview.state.chatHistory[1].content"), "earlier reply");
  assert.deepEqual(await evaluate("mediaPreview.state.droppedFiles"), [], "A sent file belongs to its turn");
  assert.match(await evaluate("document.querySelector('.chat-log').textContent"), /notes.txt/);
  const completionChimesBeforeFailure=await evaluate("fileSounds.filter(sound=>sound.name==='finish').length");
  await aimFileAtIsland();
  await evaluate("document.querySelector('.chat-input').value='draft after error';mediaPreview.island.onDragDrop({type:'drop',paths:['C:/fixture/unreadable.txt']});failIngest(new Error('Could not read this file.'))");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"), "prompt");
  assert.equal(await evaluate("document.querySelector('.chat-input').value"), "draft after error");
  assert.match(await evaluate("document.querySelector('.chat-error').textContent"), /Could not read/);
  assert.equal(await evaluate("fileSounds.filter(sound=>sound.name==='gulp').length"),1,'A failed intake cannot play a delayed gulp');
  assert.equal(await evaluate("fileSounds.filter(sound=>sound.name==='finish').length"),completionChimesBeforeFailure,'A failed copy never adds a success chime after the preceding chat reply');
  await aimFileAtIsland();
  await evaluate("mediaPreview.island.onDragDrop({type:'drop',paths:['one.txt','two.txt','three.txt','four.txt','five.txt','six.txt']})");
  await evaluate("new Promise(resolve=>requestAnimationFrame(resolve))");
  assert.match(await evaluate("document.querySelector('.chat-error').textContent"), /up to 5 files/);
});

test("Chat shows up to five individual files, appends later drops, and sends the complete batch", async (t) => {
  t.after(async () => { await command('Emulation.clearDeviceMetricsOverride'); await loadPage('Page.reload'); });
  await loadPage('Page.reload');
  await evaluate(`(async()=>{
    const {Bridge}=await import('/src/core/bridge.ts');window.batchIngests=[];window.batchSends=[];
    Bridge.chatConnections=async()=>({anthropic:true});
    Bridge.ingestFile=async path=>{
      batchIngests.push(path);
      if(path.endsWith('five.txt')) await new Promise(resolve=>window.finishBatch=resolve);
      const name=path.split('/').pop();return {name,path:'inbox/'+name,size:42};
    };
    Bridge.chatSend=async(query,context)=>{batchSends.push({query,context});return {text:'Compared all files'}};
    mediaPreview.state.clearChat();mediaPreview.state.uploadDuration=.05;
    mediaPreview.preferences({workingModeEnabled:false});mediaPreview.open('prompt');
  })()`); await evaluate(settled);
  await evaluate("document.querySelector('.chat-input').value='Compare these files';document.querySelector('.chat-input').dispatchEvent(new Event('input'))");
  await aimFileAtIsland();
  await evaluate("mediaPreview.island.onDragDrop({type:'drop',paths:['C:/fixture/one.txt','C:/fixture/two.txt','C:/fixture/three.txt']})");
  await evaluate(ateFile); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.upload-hit[aria-label=\"Put file on Drop Shelf\"]').hidden"),true);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.upload-hit[aria-label=\"Put file on Drop Shelf\"]')).display"),'none');
  await pointerClick('.upload-hit.primary'); await evaluate(settled);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.chat-attachment > span[title]')].map(el=>el.title)"),['one.txt','two.txt','three.txt']);
  await aimFileAtIsland();
  await evaluate("mediaPreview.island.onDragDrop({type:'drop',paths:['C:/fixture/four.txt','C:/fixture/five.txt']})");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"),'uploading');
  assert.equal(await evaluate("mediaPreview.state.droppedFiles.length"),3,'A partial copy never publishes half a batch');
  assert.equal(await evaluate("mediaPreview.state.chatAttachmentLoading"),'2 files');
  await evaluate("document.querySelector('.send-btn').click()");
  assert.equal(await evaluate('batchSends.length'),0,'Chat cannot submit an incomplete batch');
  await evaluate("finishBatch()"); await evaluate(ateFile); await evaluate(settled);
  await pointerClick('.upload-hit.primary'); await evaluate(settled);
  const names=['one.txt','two.txt','three.txt','four.txt','five.txt'];
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.chat-attachment > span[title]')].map(el=>el.title)"),names);
  assert.equal(await evaluate("document.querySelector('.chat-input').value"),'Compare these files');
  for(const scale of [1,2]) {
    await command('Emulation.setDeviceMetricsOverride',{width:720,height:PANEL_H,deviceScaleFactor:scale,mobile:false});await evaluate(settled);
    assert.equal(await evaluate(`(()=>{const island=document.querySelector('#island').getBoundingClientRect(),chips=[...document.querySelectorAll('.chat-attachment')];
      return chips.length===5&&chips.every(chip=>{const r=chip.getBoundingClientRect();return r.left>=island.left&&r.right<=island.right&&r.top>=island.top&&r.bottom<=island.bottom;})})()`),true);
    await capture('chat-five-attachments-'+scale+'x');
  }
  await aimFileAtIsland();await evaluate("mediaPreview.island.onDragDrop({type:'drop',paths:['C:/fixture/six.txt']})");await evaluate(settled);
  assert.match(await evaluate("mediaPreview.state.chatError"),/up to 5 files/);
  assert.equal(await evaluate("batchIngests.length"),5,'Over-limit drops are rejected before touching the inbox');
  assert.equal(await evaluate("mediaPreview.state.droppedFiles.length"),5);
  await pointerClick('.chat-remove-attachment[aria-label="Remove two.txt"]');await evaluate(settled);
  assert.deepEqual(await evaluate("mediaPreview.state.droppedFiles.map(file=>file.name)"),['one.txt','three.txt','four.txt','five.txt']);
  await pointerClick('.send-btn');await evaluate(settled);
  assert.deepEqual(await evaluate('batchSends[0]'),{query:'Compare these files',context:{kind:'files',files:['one.txt','three.txt','four.txt','five.txt'].map(name=>({name,path:'inbox/'+name}))}});
  assert.equal(await evaluate("document.querySelectorAll('.chat-log .chat-sent-file').length"),4);
  assert.deepEqual(await evaluate('mediaPreview.state.droppedFiles'),[]);
});

test("A failed or cancelled batch preserves earlier chat files and cannot publish stale attachments", async (t) => {
  t.after(()=>loadPage('Page.reload'));await loadPage('Page.reload');
  await evaluate(`(async()=>{const {Bridge}=await import('/src/core/bridge.ts');
    Bridge.ingestFile=async path=>{if(path.endsWith('bad.txt'))throw new Error('Unreadable file');return {name:'copied.txt',path:'inbox/copied.txt',size:3}};
    mediaPreview.state.clearChat();mediaPreview.state.droppedFiles=[{name:'earlier.txt',path:'inbox/earlier.txt'}];
    mediaPreview.state.chatDraft='Keep this question';mediaPreview.open('prompt');
  })()`);await evaluate(settled);await aimFileAtIsland();
  await evaluate("mediaPreview.island.onDragDrop({type:'drop',paths:['good.txt','bad.txt']})");await evaluate(settled);
  assert.match(await evaluate('mediaPreview.state.chatError'),/Unreadable file/);
  assert.deepEqual(await evaluate('mediaPreview.state.droppedFiles'),[{name:'earlier.txt',path:'inbox/earlier.txt'}]);
  assert.equal(await evaluate('mediaPreview.state.chatDraft'),'Keep this question');
  await evaluate("(async()=>{const {Bridge}=await import('/src/core/bridge.ts');Bridge.ingestFile=()=>new Promise(resolve=>window.finishStaleBatch=resolve)})()");
  await aimFileAtIsland();await evaluate("mediaPreview.island.onDragDrop({type:'drop',paths:['late.txt']});mediaPreview.state.clearChat();mediaPreview.open('prompt');finishStaleBatch({name:'late.txt',path:'inbox/late.txt'})");
  await evaluate(settled);
  assert.deepEqual(await evaluate('mediaPreview.state.droppedFiles'),[]);
  assert.equal(await evaluate('mediaPreview.state.chatAttachmentLoading'),null);
});

test("File choices stay open after pointer departure until Ask or Cancel is selected", async (t) => {
  t.after(() => loadPage("Page.reload")); await loadPage("Page.reload");
  await evaluate(`(async()=>{const {Bridge}=await import('/src/core/bridge.ts');
    Bridge.ingestFile=async()=>({name:'notes.txt',path:'inbox/notes.txt',size:42});
    mediaPreview.preferences({autoCollapseEnabled:true,peekEnabled:true});
    mediaPreview.state.uploadDuration=.05;mediaPreview.state.chatDraft='Keep my question';
    mediaPreview.open('overview');const r=mediaPreview.island.islandRect();mediaPreview.island.onCursor(r.x+r.w/2,r.y+r.h/2);
    mediaPreview.island.onDragDrop({type:'drop',paths:['C:/fixture/notes.txt']});
  })()`);
  await evaluate(ateFile);
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:430});
  await evaluate("new Promise(resolve=>setTimeout(resolve,2200))");
  assert.equal(await evaluate("mediaPreview.state.view"),'choose');
  assert.equal(await evaluate("mediaPreview.state.visibility"),'expanded');
  assert.equal(await evaluate("document.querySelector('#views').inert"),true,'Hidden underlying choices are not keyboard targets');
  assert.equal(await evaluate("mediaPreview.island.running"),false,'The settled choice parks its animation');
  await capture('mimo-file-choice');
  await evaluate("document.querySelector('.upload-hit[aria-label=\"Cancel file attachment\"]').focus()");
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"),'overview');
  assert.deepEqual(await evaluate("mediaPreview.state.droppedFiles"),[]);
  assert.equal(await evaluate("mediaPreview.state.chatDraft"),'Keep my question');
  assert.equal(await evaluate("document.querySelector('#upload-layer').inert"),true);
});

test("File dragging opens Mimo only within 8px of the island and cancellation restores chat", async (t) => {
  t.after(async () => {
    await command("Emulation.setDeviceMetricsOverride",{width:720,height:PANEL_H,deviceScaleFactor:1,mobile:false});
    await loadPage("Page.reload");
  });
  await loadPage("Page.reload");
  await evaluate(`(async()=>{
    const {Bridge}=await import('/src/core/bridge.ts');
    Bridge.chatConnections=async()=>({anthropic:true});
    window.dragIngests=0;Bridge.ingestFile=async()=>{dragIngests++;return {name:'far.txt',path:'inbox/far.txt'}};
    mediaPreview.preferences({autoCollapseEnabled:false});mediaPreview.state.clearChat();mediaPreview.open('prompt');
  })()`);
  await evaluate(settled);
  await evaluate("document.querySelector('.chat-input').value='read my file';document.querySelector('.chat-input').dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await evaluate("document.querySelector('.chat-attach-file')===null"), true);
  assert.equal(await evaluate("document.querySelectorAll('.chat-bar button').length"), 2);
  for (const scale of [1,2]) {
    await command("Emulation.setDeviceMetricsOverride",{width:720,height:PANEL_H,deviceScaleFactor:scale,mobile:false});
    await evaluate(settled);
    await evaluate("mediaPreview.island.onCursor(0,430);mediaPreview.island.onFileDragActive(true);mediaPreview.island.onDragDrop({type:'enter'})");
    assert.equal(await evaluate("mediaPreview.state.view"),'prompt','A desktop file drag away from Mimo does not open intake');
    assert.equal(await evaluate("mediaPreview.state.fileDragOver"),false);
    assert.equal(await evaluate("document.querySelector('#bot-canvas').dataset.fileApproach"),'false');
    await evaluate("mediaPreview.island.onDragDrop({type:'drop',paths:['C:/fixture/far.txt']});mediaPreview.island.onFileDragActive(false)");
    assert.equal(await evaluate("dragIngests"),0,'A distant file is never swallowed or copied');
    await evaluate("(()=>{const r=mediaPreview.island.islandRect();mediaPreview.island.onCursor(r.x-20,r.y+r.h/2);mediaPreview.island.onFileDragActive(true)})()");
    assert.equal(await evaluate("mediaPreview.state.view"),'prompt','Anticipation does not open intake');
    assert.equal(await evaluate("document.querySelector('#bot-canvas').dataset.fileApproach"),'true');
    await evaluate("(()=>{const r=mediaPreview.island.islandRect();mediaPreview.island.onCursor(r.x-9,r.y+r.h/2)})()");
    assert.equal(await evaluate("mediaPreview.state.view"),'prompt','Nine logical pixels remains outside the activation zone');
    await evaluate("(()=>{const r=mediaPreview.island.islandRect();mediaPreview.island.onCursor(r.x-7,r.y+r.h/2)})()");
    await evaluate("new Promise(resolve=>requestAnimationFrame(resolve))");
    assert.equal(await evaluate("mediaPreview.state.view"),'upload','The existing cursor poll activates intake only on close approach');
    assert.equal(await evaluate("mediaPreview.state.visibility"),'expanded');
    await evaluate("mediaPreview.island.onDragDrop({type:'enter'});mediaPreview.island.onDragDrop({type:'leave'})");
    assert.equal(await evaluate("mediaPreview.state.view"),'upload','A deliberately opened target stays available while the file is held');
    await evaluate("mediaPreview.island.onFileDragActive(false)");
    await evaluate(settled);
    assert.equal(await evaluate("mediaPreview.state.view"),'prompt');
    assert.equal(await evaluate("document.querySelector('.chat-input').value"),'read my file');
    await evaluate("mediaPreview.preferences({workingModeEnabled:true});mediaPreview.open('overview');mediaPreview.island.collapse()");
    await evaluate(settled);
    assert.equal(await evaluate("mediaPreview.state.visibility"),'peek');
    await evaluate("mediaPreview.island.onCursor(0,430);mediaPreview.island.onFileDragActive(true)");
    assert.equal(await evaluate("mediaPreview.state.visibility"),'peek','An unrelated desktop drag leaves the working lip closed');
    await evaluate("(()=>{const r=mediaPreview.island.islandRect();mediaPreview.island.onCursor(r.x+r.w/2,r.y+r.h+9)})()");
    assert.equal(await evaluate("mediaPreview.state.visibility"),'peek');
    await evaluate("(()=>{const r=mediaPreview.island.islandRect();mediaPreview.island.onCursor(r.x+r.w/2,r.y+r.h+7)})()");
    assert.equal(await evaluate("mediaPreview.state.view"),'upload','Close file drags explicitly open the thin lip');
    await evaluate("mediaPreview.island.onFileDragActive(false)"); await evaluate(settled);
    assert.equal(await evaluate("mediaPreview.state.visibility"),'peek','Cancellation restores the previous lip');
    await evaluate("mediaPreview.preferences({workingModeEnabled:false});mediaPreview.open('prompt')"); await evaluate(settled);
    assert.equal(await evaluate("document.querySelector('.chat-input').value"),'read my file');
  }
  await evaluate("mediaPreview.state.droppedFiles=[{name:'chosen.txt',path:'inbox/chosen.txt'}];mediaPreview.state.notify()");
  await evaluate("new Promise(resolve=>requestAnimationFrame(resolve))");
  await pointerClick(".chat-remove-attachment");
  await evaluate("new Promise(resolve=>requestAnimationFrame(resolve))");
  assert.deepEqual(await evaluate("mediaPreview.state.droppedFiles"), []);
  assert.equal(await evaluate("document.querySelector('.chat-input').value"), "read my file");
});

test("Chat reference layout keeps picker and attachment controls inside Dark and Glass at both scales", async (t) => {
  t.after(async () => { await command("Emulation.clearDeviceMetricsOverride"); await loadPage("Page.reload"); });
  await evaluate(`(async()=>{
    const {Bridge}=await import('/src/core/bridge.ts');
    Bridge.chatConnections=async()=>({anthropic:true,gemini:true,openai:true,openrouter:true,ollama:true});
    mediaPreview.state.clearChat();mediaPreview.preferences({chatProvider:'openrouter',autoCollapseEnabled:false});mediaPreview.open('prompt');
  })()`);
  for (const scale of [1, 2]) for (const appearance of ["dark"]) {
    await command("Emulation.setDeviceMetricsOverride", {width:760,height:384,deviceScaleFactor:scale,mobile:false});
    await evaluate(`mediaPreview.preferences({appearance:'${appearance}'});mediaPreview.state.clearChat();mediaPreview.state.notify()`);
    await evaluate(settled);
    await pointerClick(".chat-model-toggle");
    await evaluate(settled);
    const layout = await evaluate(`(() => {
      const shell=document.querySelector('#island').getBoundingClientRect();
      return [...document.querySelectorAll('.chat-model-panel,.chat-providers button,.chat-bar,.chat-model-toggle')].map(el=>{
        const r=el.getBoundingClientRect();return {className:el.className,
          inside:r.left>=shell.left&&r.right<=shell.right&&r.top>=shell.top&&r.bottom<=shell.bottom,
          clipped:el.scrollWidth>el.clientWidth+1};
      });
    })()`);
    assert.ok(layout.every(item=>item.inside&&!item.clipped), JSON.stringify(layout));
    await capture(`chat-picker-${appearance}-${scale}x`);
    await evaluate("document.querySelector('.chat-model-toggle').click();mediaPreview.state.droppedFiles=[{name:'Meeting notes – October.txt',path:'inbox/meeting.txt'}];mediaPreview.state.notify()");
    await evaluate(settled);
    await capture(`chat-attachment-${appearance}-${scale}x`);
    assert.equal(await evaluate("document.querySelector('.chat-remove-attachment').getAttribute('aria-label')"), "Remove Meeting notes – October.txt");
  }
});

test("Mimo has calm work eyes, a visible wide eating mouth, and a small tap displacement", async (t) => {
  t.after(async () => { await command("Emulation.clearDeviceMetricsOverride"); await loadPage("Page.reload"); });
  for (const scale of [1, 2]) {
    await command("Emulation.setDeviceMetricsOverride", {width:760,height:384,deviceScaleFactor:scale,mobile:false});
    const mouth = await evaluate(`(async()=>{
      const {drawMimoFace}=await import('/src/mimo/face.ts');
      const {UploadSeq}=await import('/src/upload/sequence.ts');
      const {UploadCanvas}=await import('/src/upload/canvas.ts');
      document.querySelector('#companion-check')?.remove();
      const study=document.createElement('div');study.id='companion-check';
      Object.assign(study.style,{position:'fixed',inset:'0',background:'#0B0D10',color:'#F4F4F5',zIndex:'10000',font:'12px var(--font)',padding:'12px 60px'});
      const row=document.createElement('div');Object.assign(row.style,{display:'flex',height:'148px',justifyContent:'center',gap:'44px'});study.append(row);
      for(const [name,eye,expression,lookX,lookY] of [['Thinking','pill','thinking',-.12,-.08],['Focus','focus','focus',0,0],['Annoyed','stern','annoyed',0,0]]) {
        const pose=document.createElement('div'),label=document.createElement('div'),canvas=document.createElement('canvas');
        label.textContent=name;label.style.textAlign='center';canvas.width=100*devicePixelRatio;canvas.height=110*devicePixelRatio;canvas.style.width='100px';canvas.style.height='110px';
        const context=canvas.getContext('2d');context.scale(devicePixelRatio,devicePixelRatio);context.translate(50,53);
        drawMimoFace(context,{radius:29,eye,expression,lookX,lookY});pose.append(canvas,label);row.append(pose);
      }
      const originalNow=UploadSeq.now;let fixtureTime=100;UploadSeq.now=()=>fixtureTime;
      try {
        UploadSeq.enterZone(270,108);fixtureTime+=.45;UploadSeq.frame();UploadSeq.performDrop(1);fixtureTime+=.2;
        const frame=UploadSeq.frame(),scene=new UploadCanvas({ask(){},cancel(){}});
        study.append(scene.el);scene.el.style.position='relative';scene.el.style.width='640px';scene.el.style.height='176px';scene.el.style.opacity='1';scene.el.style.pointerEvents='none';
        document.body.append(study);scene.draw(frame,fixtureTime);
        const canvas=scene.el.querySelector('canvas');canvas.style.position='relative';canvas.style.opacity='1';
        const bounds=frame.mouthRect,x=Math.round((bounds.x+bounds.w/2)*devicePixelRatio),y=Math.round((bounds.y+bounds.h*.75)*devicePixelRatio);
        const pixel=[...canvas.getContext('2d').getImageData(x,y,1,1).data];
        UploadSeq.deactivate();UploadSeq.enterZone(270,108);fixtureTime+=.45;UploadSeq.frame();UploadSeq.performDrop(1);
        const droppedAt=fixtureTime,frames=[];
        for(const offset of [0,.3,.45,.58,.7,1.1]) {fixtureTime=droppedAt+offset;frames.push(UploadSeq.frame());}
        window.intakeStudy={scene,frames};
        return {height:bounds.h,width:bounds.w,pixel};
      } finally {UploadSeq.deactivate();UploadSeq.now=originalNow;}
    })()`);
    assert.ok(mouth.height>10 && mouth.width>15, JSON.stringify(mouth));
    assert.ok(mouth.pixel[0]<70 && mouth.pixel[1]<70 && mouth.pixel[2]<70 && mouth.pixel[3]>200,
      `The eating scene must draw a mouth below the swallowed sheet: ${JSON.stringify(mouth)}`);
    await capture(`mimo-calm-eating-${scale}x`);
    if(scale===1)for(let index=0;index<6;index++){
      await evaluate(`intakeStudy.scene.draw(intakeStudy.frames[${index}],intakeStudy.frames[${index}].t)`);
      await capture(`mimo-intake-frame-${index}`);
    }
  }
  await command("Emulation.clearDeviceMetricsOverride");
  await evaluate(`document.querySelector('#companion-check').remove();
    mediaPreview.preferences({autoCollapseEnabled:false,modules:{media:false,vscode:false,developerIntegrations:false}});
    mediaPreview.state.clearChat();mediaPreview.open('prompt');`);
  await evaluate(settled);
  await evaluate(`window.tapSamples=[];document.querySelector('#pat-mimo').addEventListener('click',()=>{
    const until=performance.now()+600;const sample=()=>{tapSamples.push(mediaPreview.island.engine.ox);if(performance.now()<until)requestAnimationFrame(sample);};sample();
  },{once:true})`);
  await pointerClick('#pat-mimo');
  await evaluate(settled);
  const displacement = await evaluate("Math.max(...tapSamples.map(Math.abs))");
  assert.ok(displacement>.04 && displacement<.1, `Tap displacement: ${displacement}`);
  assert.equal(await evaluate("mediaPreview.island.engine.ox"),0);
});

test("One hook subscription handles both assistants, owned approvals, and session cleanup", async (t) => {
  const init = await command("Page.addScriptToEvaluateOnNewDocument", {
    source: "(" + function () {
      window.hookEvents = {};
      window.hookCalls = [];
      window.editorCalls = [];
      window.hookListeners = 0;
      window.hookUnlisteners = 0;
      const callbacks = {};
      const subscriptions = {};
      let next = 0;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "island" }, currentWebview: { label: "island" } },
        transformCallback: callback => { callbacks[++next] = callback; return next; },
        invoke: async (cmd, args = {}) => {
          if (cmd === "plugin:event|listen") {
            subscriptions[++next] = args.event;
            window.hookEvents[args.event] = callbacks[args.handler];
            if (args.event === "hook") window.hookListeners++;
            return next;
          }
          if (cmd === "plugin:event|unlisten") {
            if (subscriptions[args.eventId] === "hook") window.hookUnlisteners++;
            delete window.hookEvents[subscriptions[args.eventId]];
            delete subscriptions[args.eventId];
          }
          if (cmd.startsWith("approval_")) window.hookCalls.push({ cmd, ...args });
          if (cmd === 'return_to_work') {window.editorCalls.push({path:args.path});return 'project';}
          return null;
        },
      };
    }.toString() + ")()",
  });
  t.after(async () => {
    await command("Page.removeScriptToEvaluateOnNewDocument", { identifier: init.identifier });
    await loadPage("Page.reload");
  });
  await loadPage("Page.navigate", { url: "http://127.0.0.1:1431/dev/media-preview.html" });
  await evaluate("(async()=>{const {registerHookHandlers}=await import('/src/island/hooks.ts');window.stopHooks=await registerHookHandlers(mediaPreview.island);window.emitHook=(provider,event,extra={})=>hookEvents.hook({payload:{mimo_provider:provider,hook_event_name:event,session_id:provider+'-session',cwd:'C:/work/'+provider,...extra}})})()");
  await evaluate("mediaPreview.preferences({codingAssistant:'codex',hooksInstalled:true,codexHooksInstalled:true,workflowSetupDone:true,autoCollapseEnabled:true,modules:{vscode:true}});mediaPreview.state.setFocus('session_claude_claude-session');mediaPreview.open('integrations');emitHook('claude','SessionStart');emitHook('claude','UserPromptSubmit',{prompt:'Claude work'});emitHook('codex','SessionStart');emitHook('codex','UserPromptSubmit',{prompt:'Codex work'});emitHook('claude','PreToolUse',{tool_name:'Read',tool_use_id:'claude-read',tool_input:{file_path:'src/invoice.ts'}});emitHook('claude','PostToolUse',{tool_name:'Read',tool_use_id:'claude-read',mimo_preview:{text:'export function total() {\\n  return 42;\\n}',start_line:12}});emitHook('codex','PreToolUse',{tool_name:'Bash',tool_use_id:'codex-test',tool_input:{command:'npm test'}})");
  assert.equal(await evaluate("hookListeners"), 1);
  assert.deepEqual(await evaluate("mediaPreview.state.tasks.filter(t=>t.id==='session_claude_claude-session'||t.id==='session_codex_codex-session').sort((a,b)=>a.id.localeCompare(b.id)).map(t=>[t.id,t.state])"), [
    ["session_claude_claude-session", "working"], ["session_codex_codex-session", "working"],
  ]);
  await evaluate(settled);
  await selectIntegration('integration_claude');
  await evaluate(settled);
  await evaluate("mediaPreview.state.selectCodingTask('session_claude_claude-session')");await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-session-picker .audio-device-button').textContent"), "Claude");
  assert.equal(await evaluate("document.querySelector('.coding-action').textContent"), "Read");
  assert.equal(await evaluate("document.querySelector('.coding-target').textContent"), "src/invoice.ts");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.coding-live-preview .coding-line-number')].map(el=>el.textContent)"), ["12", "13", "14"]);
  assert.match(await evaluate("document.querySelector('.coding-preview').textContent"), /export function total/);
  assert.equal(await evaluate("document.querySelector('.module-activity .coding-project').textContent"), "Claude");
  assert.equal(await evaluate("document.querySelector('.coding-progress')"), null,
    "Mimo carries session activity without a separate loading bar");
  assert.equal(await evaluate("document.querySelector('.coding-expand')"), null);
  assert.equal(await evaluate("document.querySelector('.coding-preview').hidden"), true);
  await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  assert.equal(await evaluate("document.querySelector('.coding-target').getAnimations().length"), 0);
  await command("Emulation.setEmulatedMedia", { features: [] });
  await evaluate("mediaPreview.open('overview')");
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-target').getAnimations().length"), 0);
  await evaluate("mediaPreview.open('integrations')");
  await evaluate(settled);
  await evaluate("window.codingCardNode=document.querySelector('.coding-card');window.codingPreviewNode=document.querySelector('.coding-preview')");
  await capture("coding-reference-claude-read-dark");
  await evaluate("document.querySelector('.coding-session-picker .audio-device-button').click();[...document.querySelectorAll('.coding-session-picker [role=option]')].find(el=>el.textContent.startsWith('Codex')).click()");
  assert.equal(await evaluate("mediaPreview.state.codingTask.source"), "codexCode");
  await evaluate(settled);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-session-picker .audio-device-label')).display"), "none");
  assert.match(await evaluate("document.querySelector('.module-activity .coding-preview').textContent"), /npm test/);
  assert.equal(await evaluate("document.querySelector('.module-activity .coding-preview').textContent.includes('export function total')"), false);
  assert.equal(await evaluate("document.querySelector('.coding-card')===codingCardNode && document.querySelector('.coding-preview')===codingPreviewNode"), true);
  assert.equal(await evaluate("document.querySelector('.coding-session-picker .audio-device-button').getBoundingClientRect().right<=document.querySelector('.home-workspace').getBoundingClientRect().right"), true);
  assert.equal(await evaluate("document.querySelector('.coding-session-picker').getBoundingClientRect().top>=document.querySelector('.home-workspace').getBoundingClientRect().bottom"),true,'Agent selection sits below the right panel');
  await capture("shared-codex-live-audit");
  await pointerClick('.coding-preview-trigger'); await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-session-picker').getBoundingClientRect().top>=document.querySelector('.home-workspace').getBoundingClientRect().bottom"),true,'Expanded agent selection remains below the editor');
  await pointerClick('.coding-expand'); await evaluate(settled);
  await evaluate("emitHook('codex','PostToolUse',{tool_name:'Bash',tool_use_id:'codex-test',mimo_preview:{text:'PASS tests/invoice.test.ts\\nTests: 48 passed, 48 total'}});emitHook('codex','Stop',{message:'48 tests passed'});mediaPreview.open('integrations')");
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-action').textContent"), "Done");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-target')).animationIterationCount"), "1");
  assert.match(await evaluate("document.querySelector('.coding-preview').textContent"), /npm test.*PASS tests\/invoice\.test\.ts.*48 passed/);
  await capture("coding-reference-codex-done-dark");
  await evaluate("mediaPreview.preferences({appearance:'glass'});mediaPreview.state.selectCodingTask('session_claude_claude-session');mediaPreview.open('integrations')");
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-action').textContent"), "Read");
  assert.equal(await evaluate("document.querySelector('.coding-preview')===codingPreviewNode"), true);
  assert.equal(await evaluate("document.querySelector('.coding-preview').getAnimations().length"), 0);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-preview')).backdropFilter"), "none");
  assert.equal(await evaluate("(()=>{const c=document.querySelector('.module-activity').getBoundingClientRect();return [...document.querySelectorAll('.coding-heading,.coding-provider-slot,.coding-action-row,.coding-preview-trigger')].filter(el=>el.getBoundingClientRect().width).every(el=>{const r=el.getBoundingClientRect();return r.left>=c.left&&r.right<=c.right&&r.top>=c.top&&r.bottom<=c.bottom})})()"), true);
  await capture("coding-reference-claude-read-glass");
  await pointerClick('.coding-preview-trigger');
  await evaluate(settled);
  await evaluate(`emitHook('claude','PostToolUse',${JSON.stringify({tool_name:'Read',tool_use_id:'claude-read',
    tool_response:{file:{startLine:10,content:"import { Item } from './types';\nconst TVA = 0.196;\n\nexport function total(items: Item[]) {\n  const sum = items.reduce((s, i) => s + i.price, 0);\n  return sum * (1 + TVA);\n}"}}})})`);
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.module-activity .coding-project').textContent"),'Claude');
  assert.equal(await evaluate("document.querySelector('.coding-file-name').textContent"),'invoice.ts');
  assert.equal(await evaluate("document.querySelector('.coding-file-icon').dataset.technology"),'typescript');
  assert.equal(await evaluate("document.querySelector('.coding-file-path').textContent"),'src/invoice.ts');
  assert.equal(await evaluate("[...document.querySelectorAll('.coding-live-preview .coding-line')].filter(el=>!el.hidden).length"),7);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.coding-live-preview .coding-line')].filter(el=>!el.hidden).map(el=>el.querySelector('.coding-line-number').textContent)"),['10','11','12','13','14','15','16']);
  assert.equal(await evaluate("document.querySelector('.coding-stage[data-stage=Read]').dataset.state"),'complete');
  assert.equal(await evaluate("document.querySelectorAll('.module-layout.on > .home-workspace').length"),1);
  assert.equal(await evaluate("document.querySelector('.coding-stage[data-stage=Read]').getBoundingClientRect().top>mediaPreview.island.botCy.value+30"),true,
    "The reference activity icons sit beneath Mimo");
  await capture('coding-live-editor-reference-glass');
  await evaluate("emitHook('claude','PreToolUse',{tool_name:'Edit',tool_use_id:'live-edit',tool_input:{file_path:'src/invoice.ts',old_string:'return sum;',new_string:'const tax = sum * 0.196;\\nreturn sum + tax;'}})");
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-stage[data-stage=Edit]').dataset.state"),'active');
  assert.equal(await evaluate("document.querySelector('.coding-stage[data-stage=Read]').dataset.state"),'complete');
  assert.equal(await evaluate("mediaPreview.island.engine.status"),'loading');
  assert.equal(await evaluate("document.querySelector('.coding-added').textContent"),'+2');
  assert.equal(await evaluate("document.querySelector('.coding-removed').textContent"),'−1');
  assert.equal(await evaluate("document.querySelectorAll('.coding-live-preview .coding-line[data-kind=added]').length"),2);
  assert.equal(await evaluate("document.querySelector('.coding-preview').dataset.numbering"),'preview');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.coding-live-preview .coding-line')].filter(el=>!el.hidden).map(el=>el.querySelector('.coding-line-number').textContent)"),['','',''],
    'Unpositioned input excerpts never pretend to be file lines 1–3');
  assert.equal(await evaluate("document.querySelector('#island').getBoundingClientRect().height"),332,
    "Live edits preserve the bounded preview size");
  await capture('coding-live-edit-reference-glass');
  await evaluate("emitHook('claude','PostToolUseFailure',{tool_name:'Edit',tool_use_id:'live-edit'})");
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-stage[data-stage=Edit]').dataset.state"),'failed');
  assert.equal(await evaluate("mediaPreview.island.engine.status"),'error');
  await evaluate("emitHook('claude','PreToolUse',{tool_name:'Edit',tool_use_id:'retry-edit',tool_input:{file_path:'src/invoice.ts',old_string:'return sum;',new_string:'return sum * (1 + TVA);'}});emitHook('claude','PostToolUse',{tool_name:'Edit',tool_use_id:'retry-edit'})");
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-stage[data-stage=Edit]').dataset.state"),'complete');
  await evaluate("emitHook('claude','PostToolUse',{tool_name:'Edit',tool_use_id:'retry-edit',tool_response:{structuredPatch:[{oldStart:15,newStart:15,lines:['-return sum;','+return sum * (1 + TVA);']}]}})");
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-preview').dataset.numbering"),'source');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.coding-live-preview .coding-line')].filter(el=>!el.hidden).map(el=>el.querySelector('.coding-line-number').textContent)"),['15','15']);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-line[data-kind=added]')).borderLeftColor===getComputedStyle(document.querySelector('.coding-line[data-kind=removed]')).borderLeftColor"),false);
  await capture('coding-live-changed-file-lines-glass');
  const relayEdits = [
    {target:'src/style.css',changes:{added:3,removed:0},preview:{
      lines:['border: 0;',':root[data-appearance="glass"] #island::before {','  box-shadow: var(--shadow-shell);'],
      kinds:['added','added','added'],lineNumbers:[1768,1770,1771]}},
    {target:'src/views/sections.css',changes:{added:0,removed:3},preview:{
      lines:['.home-view[data-mascot="header"] .home-welcome {','  padding-left: 24px;','}'],
      kinds:['removed','removed','removed'],lineNumbers:[66,67,68]}},
    {target:'src/views/sections.ts',changes:{added:4,removed:2},preview:{
      lines:['import { moduleLayout } from "../core/modules";','const plan = () => moduleLayout();',
        'const height = 240;','const botX = 68;','const botY = 96;','const botDiam = 58;'],
      kinds:['removed','removed','added','added','added','added'],lineNumbers:[3,75,75,76,77,78]}},
  ];
  await evaluate(`emitHook('claude','UserPromptSubmit',{prompt:'Keep Home Mimo visible and refine the Glass outline'});
    emitHook('claude','PostToolUse',${JSON.stringify({tool_name:'apply_patch',tool_use_id:'summary-edit',
      tool_input:{file_path:'src/style.css'},mimo_edits:relayEdits})})`);
  await evaluate(settled);
  await pointerClick('.coding-view-button:nth-child(2)');
  await evaluate(settled);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.coding-edit-path')].map(el=>el.textContent)"),relayEdits.map(file=>file.target));
  assert.equal(await evaluate("document.querySelector('.coding-edits').hidden"),false);
  assert.equal(await evaluate("document.querySelector('.coding-live-preview').hidden"),true);
  assert.equal(await evaluate("document.querySelector('.coding-edit-preview').dataset.numbering"),'source');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.coding-edit:first-child .coding-line-number')].map(el=>el.textContent)"),['1768','1770','1771']);
  assert.equal(await evaluate("document.querySelector('.coding-edit:first-child .coding-edit-counts').textContent"),'+3−0');
  for (const appearance of ['dark']) {
    await evaluate(`mediaPreview.preferences({appearance:'${appearance}'})`);
    await evaluate(settled);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-edits')).scrollbarWidth"),'none');
    assert.ok(await evaluate("[...document.querySelectorAll('.coding-edit:first-child .coding-line-number')].every(el=>{const r=el.getBoundingClientRect();return r.height>0&&r.width>0&&!el.hidden})"),
      'Real file line numbers are painted in the expanded preview');
    assert.ok(await evaluate("Math.abs(document.querySelector('#island').getBoundingClientRect().height-332)<1"));
    assert.equal(await evaluate("(()=>{const open=document.querySelector('.coding-open').getBoundingClientRect(),back=document.querySelector('.coding-expand').getBoundingClientRect();return open.left-back.right>=7.5})()"),true);
    await capture('coding-summary-reference-'+appearance);
  }
  await pointerClick('.coding-edit:last-child .coding-edit-details');
  assert.equal(await evaluate("document.querySelector('.coding-edit:last-child').dataset.expanded"),'true');
  assert.equal(await evaluate("document.querySelectorAll('.coding-edit:last-child .coding-line').length"),6);
  await evaluate("window.retainedEdit=document.querySelector('.coding-edit:last-child');document.querySelector('.coding-edit:last-child .coding-edit-details').focus();emitHook('claude','PreToolUse',{tool_name:'Read',tool_use_id:'summary-read',tool_input:{file_path:'src/style.css'}})");
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-edit:last-child')===retainedEdit"),true);
  assert.equal(await evaluate("document.activeElement.className"),'coding-edit-details');
  assert.equal(await evaluate("document.querySelector('.coding-edits').hidden"),false,'Incoming activity preserves the chosen summary view');
  await pointerClick('.coding-view-button:first-child');
  assert.equal(await evaluate("document.querySelector('.coding-live-preview').hidden"),false);
  await evaluate("document.querySelector('.coding-expand').click()");
  await evaluate(settled);
  assert.ok(await evaluate("Math.abs(document.querySelector('#island').getBoundingClientRect().height-210)<1"));
  assert.equal(await evaluate("document.querySelector('.integration-picker').isConnected"),true);
  assert.equal(await evaluate("document.querySelector('#island').getBoundingClientRect().height"),210);
  await evaluate(`mediaPreview.preferences({appearance:'dark'});mediaPreview.state.selectCodingTask('session_codex_codex-session');
    emitHook('codex','UserPromptSubmit',{prompt:'Update billing totals'});
    emitHook('codex','PreToolUse',{tool_name:'Edit',tool_use_id:'compact-edit',
      tool_input:{file_path:'src/billing.ts',old_string:'return 0;',new_string:'const total = 42;\\nreturn total;'}})`);
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  assert.equal(await evaluate("document.querySelector('.coding-action-row').getAnimations().length"),1,
    "A real action change settles with a brief offset");
  assert.equal(await evaluate("document.querySelector('.coding-action-outgoing').getAttribute('aria-hidden')"),'true');
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-action-row').getAnimations().length"),0);
  assert.equal(await evaluate("document.querySelector('.coding-summary').textContent"),'Waiting for next action');
  assert.equal(await evaluate("document.querySelector('.coding-added').textContent"),'+2');
  assert.equal(await evaluate("document.querySelector('.coding-expand')"),null);
  assert.equal(await evaluate("document.querySelector('#island').getBoundingClientRect().height"),236);
  await capture('coding-default-codex-edit-reference-dark');
  await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await evaluate("emitHook('codex','PreToolUse',{tool_name:'Read',tool_input:{file_path:'reduced-motion.ts'}})");
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  assert.equal(await evaluate("document.querySelector('.coding-action-row').getAnimations().length"),0);
  await command("Emulation.setEmulatedMedia", { features: [] });
  await evaluate("mediaPreview.preferences({codingAssistant:'claude'});for(let i=0;i<40;i++)emitHook('codex','PreToolUse',{tool_name:'Read',tool_input:{file_path:'file-'+i+'.ts'}})");
  assert.equal(await evaluate("mediaPreview.state.tasks.find(t=>t.id==='session_codex_codex-session').steps.length"), 20);
  await evaluate("new Promise(resolve=>setTimeout(resolve,2000))");
  assert.match(await evaluate("document.querySelector('.module-activity .coding-target').textContent"), /file-39\.ts/);
  await evaluate("(async()=>{mediaPreview.preferences({autoCollapseEnabled:false});const {Visibility}=await import('/src/core/visibility.ts');Visibility.peek();emitHook('codex','PermissionRequest',{request_id:'codex-owned',tool_name:'Bash',tool_input:{command:'npm test -- --runInBand',description:'Run the invoice test suite'}})})()");
  assert.equal(await evaluate("mediaPreview.state.view"), "approval");
  assert.equal(await evaluate("mediaPreview.state.visibility"), "expanded");
  assert.equal(await evaluate("mediaPreview.state.pendingApproval.provider"), "codex");
  assert.equal(await evaluate("mediaPreview.state.focusId"), "session_codex_codex-session");
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-approval-provider').textContent"), 'Codex');
  assert.match(await evaluate("document.querySelector('.coding-approval-status').textContent"), /Codex.*Permission needed/);
  assert.equal(await evaluate("document.querySelector('.coding-approval-status .ui-icon path').getAttribute('d').startsWith('M12 3.5')"),true);
  assert.equal(await evaluate("document.querySelector('.coding-approval-request,.coding-approval-title')===null"),true,'Only the permission status line changes');
  await capture('codex-permission-status');
  assert.match(await evaluate("document.querySelector('.view.on').textContent"), /npm test -- --runInBand/);
  assert.match(await evaluate("document.querySelector('.view.on').textContent"), /Run the invoice test suite/);
  assert.equal(await evaluate("(()=>{const c=document.querySelector('.approval-view .card').getBoundingClientRect();return [...document.querySelectorAll('.approval-view .code,.approval-view .coding-approval-status,.approval-view .actions button')].every(el=>{const r=el.getBoundingClientRect();return r.left>=c.left&&r.right<=c.right&&r.top>=c.top&&r.bottom<=c.bottom})})()"), true);
  assert.equal(await evaluate("hookCalls.filter(c=>c.cmd==='approval_ack'&&c.requestId==='codex-owned').length"), 1);
  await evaluate("emitHook('codex','PostToolUse',{tool_name:'Read',tool_use_id:'old-read',mimo_preview:{text:'stale result'}})");
  assert.equal(await evaluate("mediaPreview.state.pendingApproval.requestId"), "codex-owned");
  await evaluate("emitHook('claude','PermissionRequest',{request_id:'claude-second',tool_name:'Read',tool_use_id:'second-review',tool_input:{file_path:'review.ts'}})");
  assert.equal(await evaluate("mediaPreview.state.pendingApproval.requestId"), "codex-owned");
  assert.equal(await evaluate("mediaPreview.state.pendingApprovals.length"),2);
  await evaluate("(async()=>{mediaPreview.state.pendingApprovals.find(r=>r.requestId==='claude-second').deadline=Date.now()-1;const {expireApprovals}=await import('/src/island/hooks.ts');expireApprovals(mediaPreview.island)})()");
  assert.equal(await evaluate("hookCalls.filter(c=>c.cmd==='approval_decline'&&c.requestId==='claude-second').length"),1);
  await evaluate("mediaPreview.island.collapse()");
  assert.equal(await evaluate("mediaPreview.state.pendingApproval.requestId"),'codex-owned');
  assert.equal(await evaluate("mediaPreview.state.visibility"),'expanded',"An unanswered approval survives collapse");
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.approval-count').textContent"),'2');
  await pointerClick('.approvals-entry');
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelectorAll('.approval-inbox-row').length"),2);
  assert.equal(await evaluate("document.querySelectorAll('.approval-inbox-row[data-active=false] [data-review=active]').length"),0);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.approval-inbox-list')).scrollbarWidth"),'none');
  await pointerClick('.approval-inbox-row[data-active=true] .approval-inbox-review');
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.view"),'approval');
  await capture("shared-codex-approval");
  await evaluate("[...document.querySelectorAll('.view.on button')].find(el=>el.textContent.startsWith('Allow')).click()");
  assert.equal(await evaluate("mediaPreview.state.pendingApproval"), null);
  assert.equal(await evaluate("hookCalls.filter(c=>c.cmd==='approval_decision'&&c.requestId==='codex-owned'&&c.decision==='allow').length"), 1);
  assert.equal(await evaluate("mediaPreview.state.view"), "overview");
  await evaluate(settled);
  assert.match(await evaluate("document.querySelector('.approvals-entry').textContent"),/Approval1/);
  await pointerClick('.approvals-entry');
  await evaluate(settled);
  await capture('coding-missed-approvals-dark');
  await pointerClick('.approval-inbox-row[data-active=false] .approval-inbox-review');
  assert.deepEqual(await evaluate("editorCalls.at(-1)"),{path:'C:/work/claude'},"Missed approvals open their original workspace");
  await evaluate("document.querySelector('.approval-inbox-review').focus();emitHook('claude','PostToolUse',{tool_name:'Read',tool_use_id:'other-review',tool_input:{file_path:'review.ts'}})");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.approvalCount"),1,'An unrelated result cannot clear the missed notification');
  await evaluate("emitHook('claude','PostToolUse',{tool_name:'Read',tool_use_id:'second-review',tool_input:{file_path:'review.ts'}})");
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.approvalCount"),0,'Approving and completing the tool in VS Code clears its notification');
  assert.equal(await evaluate("mediaPreview.state.approvalInboxCount"),1,'The resolved missed approval stays reviewable without a persistent work feed');
  assert.equal(await evaluate("document.querySelector('.approval-inbox-row').dataset.resolved"),'true');
  assert.equal(await evaluate("document.querySelector('.approval-inbox-status').textContent"),'Approved · Completed');
  assert.equal(await evaluate("document.querySelector('.approval-count').hidden"),true);
  assert.equal(await evaluate("document.querySelector('.approvals-entry').hidden"),false);
  assert.equal(await evaluate("document.activeElement.className"),'approval-inbox-review','Live resolution preserves the focused control');
  await capture('coding-missed-approved-in-editor-dark');
  await pointerClick('.approval-inbox-dismiss');
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.approvalCount"),0);
  assert.equal(await evaluate("document.querySelector('.approvals-entry').hidden"),true,'Dismissing the final approval clears its header entry');
  await evaluate("mediaPreview.preferences({appearance:'dark',autoCollapseEnabled:true});mediaPreview.open('integrations');emitHook('codex','PermissionRequest',{request_id:'codex-deny',tool_name:'Bash',tool_input:{command:'Remove-Item -LiteralPath C:/work/test -Recurse'}})");
  await evaluate(settled);
  await capture("coding-codex-approval-dark");
  await evaluate("[...document.querySelectorAll('.view.on button')].find(el=>el.textContent.startsWith('Deny')).click()");
  assert.equal(await evaluate("hookCalls.filter(c=>c.cmd==='approval_decision'&&c.requestId==='codex-deny'&&c.decision==='deny').length"), 1);
  await evaluate("mediaPreview.open('overview');emitHook('claude','PermissionRequest',{request_id:'claude-owned',tool_name:'Read',tool_input:{file_path:'review.ts'}})");
  await evaluate(settled);
  assert.match(await evaluate("document.querySelector('.coding-approval-status').textContent"), /Claude.*Permission needed/);
  await evaluate("emitHook('claude','StopFailure')");
  assert.equal(await evaluate("mediaPreview.state.pendingApproval"), null);
  assert.equal(await evaluate("hookCalls.filter(c=>c.cmd==='approval_decline'&&c.requestId==='claude-owned').length"), 1);
  await evaluate(`(() => {
    mediaPreview.preferences({appearance:'glass'});mediaPreview.open('integrations');
    const original=window.setTimeout;
    window.setTimeout=(callback,delay,...args)=>{
      const id=original(callback,delay,...args);
      if(delay===107000)window.expireApproval=()=>{clearTimeout(id);callback();};
      return id;
    };
    try {emitHook('codex','PermissionRequest',{request_id:'codex-expired',tool_name:'Edit',
      tool_input:{file_path:'src/invoice.ts'}});} finally {window.setTimeout=original;}
    mediaPreview.state.pendingApproval.deadline=Date.now()-1;window.expireApproval();
  })()`);
  assert.equal(await evaluate("mediaPreview.state.pendingApproval"),null);
  assert.equal(await evaluate("mediaPreview.state.missedApprovals.find(item=>item.requestId==='codex-expired').status"),'Timed out · Review in tool');
  assert.equal(await evaluate("hookCalls.filter(c=>c.cmd==='approval_decline'&&c.requestId==='codex-expired').length"),1);
  await evaluate(settled);
  await pointerClick('.approvals-entry');
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.view.on').textContent.includes('Allow')"),false,
    "Expired requests stay reviewable without offering a stale approval action");
  await capture('coding-missed-approvals-glass');
  await pointerClick('.approval-inbox-clear');
  await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.state.approvalCount"),0);
  await evaluate("mediaPreview.open('prompt');emitHook('codex','PermissionRequest',{request_id:'protected-chat',tool_name:'Read'})");
  assert.equal(await evaluate("mediaPreview.state.pendingApproval.requestId"),'protected-chat');
  assert.equal(await evaluate("mediaPreview.state.view"),'prompt');
  assert.equal(await evaluate("hookCalls.filter(c=>c.cmd==='approval_ack'&&c.requestId==='protected-chat').length"),1);
  await evaluate("emitHook('codex','SessionEnd')");
  await evaluate("emitHook('codex','SessionStart',{session_id:'new-codex-session'});emitHook('codex','UserPromptSubmit',{session_id:'new-codex-session',prompt:'fresh work'});emitHook('codex','Stop');mediaPreview.open('overview');emitHook('codex','PermissionRequest',{request_id:'old-session',tool_name:'Read'})");
  assert.equal(await evaluate("mediaPreview.state.tasks.find(t=>t.id==='session_codex_new-codex-session').state"), "thinking");
  assert.equal(await evaluate("hookCalls.filter(c=>c.cmd==='approval_decline'&&c.requestId==='old-session').length"), 1);
  await evaluate("emitHook('codex','Stop',{session_id:'new-codex-session'});emitHook('codex','UserPromptSubmit',{session_id:'new-codex-session',prompt:'keep working'})");
  await evaluate("new Promise(resolve=>setTimeout(resolve,5400))");
  assert.equal(await evaluate("mediaPreview.state.tasks.find(t=>t.id==='session_codex_new-codex-session').state"), "thinking");
  await evaluate("(async()=>{const {resetProviderSession}=await import('/src/island/hooks.ts');mediaPreview.state.settings.codexHooksInstalled=false;resetProviderSession(mediaPreview.island,'codex')})()");
  assert.equal(await evaluate("mediaPreview.state.tasks.some(t=>t.id==='session_codex_new-codex-session')"), false);
  assert.equal(await evaluate("mediaPreview.state.tasks.find(t=>t.id==='session_claude_claude-session').state"), "error");
  await evaluate("stopHooks();stopHooks=null;new Promise(resolve=>setTimeout(resolve,50))");
  assert.equal(await evaluate("hookListeners"), 1);
  assert.equal(await evaluate("hookUnlisteners"), 1);
  assert.equal(await evaluate("mediaPreview.state.pendingApproval"), null);
});

test("Coding Preview identifies current work with truthful completion rings and parked motion", async (t) => {
  const init = await command("Page.addScriptToEvaluateOnNewDocument", {
    source: "(" + function () {
      const callbacks = {}, subscriptions = {};
      let sequence = 0;
      window.hookEvents = {};
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "island" }, currentWebview: { label: "island" } },
        transformCallback: callback => { callbacks[++sequence] = callback; return sequence; },
        invoke: async (cmd, args = {}) => {
          if (cmd === "plugin:event|listen") {
            subscriptions[++sequence] = args.event;
            window.hookEvents[args.event] = callbacks[args.handler];
            return sequence;
          }
          if (cmd === "plugin:event|unlisten") {
            delete window.hookEvents[subscriptions[args.eventId]];
            delete subscriptions[args.eventId];
          }
          return null;
        },
      };
    }.toString() + ")()",
  });
  t.after(async () => {
    await evaluate("stopPreviewHooks?.()");
    await command("Page.removeScriptToEvaluateOnNewDocument", { identifier: init.identifier });
    await command("Emulation.setEmulatedMedia", { features: [] });
    await command("Emulation.setDeviceMetricsOverride", { width: 720, height: PANEL_H, deviceScaleFactor: 1, mobile: false });
    await loadPage("Page.reload");
  });
  await loadPage("Page.navigate", { url: "http://127.0.0.1:1431/dev/media-preview.html" });
  await evaluate("(async()=>{const {registerHookHandlers}=await import('/src/island/hooks.ts');window.stopPreviewHooks=await registerHookHandlers(mediaPreview.island);window.emitHook=(provider,event,extra={})=>hookEvents.hook({payload:{mimo_provider:provider,hook_event_name:event,session_id:provider+'-progress',cwd:'C:/work/'+provider,...extra}})})()");
  await evaluate("(async()=>{const {Sound}=await import('/src/core/sound.ts');window.progressSound=Sound;window.completionSounds=0;const play=Sound.play.bind(Sound);Sound.play=name=>{if(name==='finish'&&Sound.enabled)completionSounds++;play(name)}})()");
  await evaluate("mediaPreview.preferences({hooksInstalled:true,codexHooksInstalled:true,soundEnabled:true,modules:{vscode:true},appearance:'dark'});mediaPreview.state.pinned=true;mediaPreview.state.setFocus('integration_claude');mediaPreview.open('integrations')");
  const emit = (provider, event, extra = {}) => evaluate(`emitHook(${JSON.stringify(provider)},${JSON.stringify(event)},${JSON.stringify(extra)})`);
  const nextFrame = () => evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  const stages = () => evaluate("[...document.querySelectorAll('.coding-stage')].map(el=>el.dataset.state)");
  const rings = () => evaluate("document.querySelector('.coding-card').getAnimations({subtree:true}).filter(a=>a.animationName==='coding-activity-orbit').length");
  const greenBadgePixels = () => evaluate("(()=>{const canvas=document.querySelector('#bot-canvas'),pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let green=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+1]-pixels[i]>45&&pixels[i+1]-pixels[i+2]>5&&pixels[i+2]>80&&pixels[i+3]>180)green++;return green})()");
  await emit('claude', 'SessionStart');
  await emit('claude', 'UserPromptSubmit', { prompt: 'Verify and improve invoice totals' });
  await emit('claude', 'PreToolUse', { tool_name: 'Read', tool_use_id: 'progress-read-1',
    tool_input: { file_path: 'C:/work/claude/src/invoice.ts' } });
  await evaluate(settled);
  await pointerClick('.coding-preview-trigger');
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-current-label').textContent"), 'Read');
  assert.equal(await evaluate("document.querySelector('.coding-current-target').textContent"), 'src/invoice.ts');
  assert.equal(await evaluate("document.querySelector('.coding-preview').textContent"), 'Reading file…');
  assert.equal(await evaluate("document.querySelector('.coding-file-name').textContent"), 'invoice.ts');
  assert.equal(await evaluate("document.querySelector('.coding-file-icon').dataset.technology"),'typescript');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-stage[data-stage=Edit] .coding-ring-track')).opacity"),'0','Inactive operations keep their soft icons without a loading ring');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-stage[data-stage=Edit] .ui-icon')).opacity"),'1');
  assert.deepEqual(await evaluate("['Edit','Run'].map(name=>{const style=getComputedStyle(document.querySelector('.coding-stage[data-stage='+name+'] .ui-icon path'));return [style.strokeWidth,style.strokeLinecap,style.strokeLinejoin]})"),
    [['1.9px','round','round'],['1.9px','round','round']],'Edit and Bash have soft rounded contours');
  assert.equal(await evaluate("document.querySelector('.coding-preview').dataset.numbered"), 'false');
  assert.deepEqual(await stages(), ['active', 'inactive', 'inactive', 'inactive']);
  assert.equal(await evaluate("document.querySelectorAll('.coding-stage[aria-current=step]').length"), 1);
  assert.equal(await rings(), 1, 'Only the current operation in the sidebar has an animated arc');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.coding-indicator[data-state=active] .ui-icon')].map(el=>getComputedStyle(el).visibility)"),['hidden','hidden'],
    'Loading shows only white rings without operation or IDE icons inside');
  assert.equal(await evaluate("document.querySelector('.coding-current').hidden"),true,'The sidebar owns progress without a duplicate status row');
  assert.equal(await evaluate("document.querySelector('.coding-stage .coding-indicator').getBoundingClientRect().width"),20);
  assert.equal(await evaluate("document.querySelector('.coding-current .ui-icon').getAttribute('fill')"),'currentColor');
  assert.equal(await evaluate("document.querySelector('.coding-current .ui-icon').getAttribute('stroke')"),'none');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.coding-indicator[data-state=active]')].map(el=>({ink:getComputedStyle(el).color,arc:getComputedStyle(el.querySelector('.coding-ring-arc')).stroke}))"),
    [{ink:'rgb(255, 255, 255)',arc:'rgb(255, 255, 255)'},{ink:'rgb(255, 255, 255)',arc:'rgb(255, 255, 255)'}],
    'Both the current operation and its rail loader are pure white');
  assert.ok(await evaluate("Number(document.querySelector('.coding-stage[data-state=active] .coding-ring-arc').getAttribute('stroke-width'))>=2.4"));
  const rotation = await evaluate("getComputedStyle(document.querySelector('.coding-stage[data-state=active] .coding-ring-arc')).transform");
  await evaluate("new Promise(resolve=>setTimeout(resolve,160))");
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.coding-stage[data-state=active] .coding-ring-arc')).transform"), rotation);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-current .ui-icon')).transform"), 'none');
  await capture('coding-progress-reading-dark');
  await emit('claude', 'PostToolUse', { tool_name: 'Read', tool_use_id: 'progress-read-1',
    mimo_preview: { text: 'export function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}', start_line: 71 } });
  await nextFrame();
  assert.equal(await evaluate("document.querySelector('.coding-current-label').textContent"), 'Read complete');
  assert.equal(await evaluate("document.querySelector('.coding-current-hint').textContent"), 'Waiting for next action');
  assert.equal(await evaluate("document.querySelector('.coding-current-count').textContent"), '1 action completed');
  assert.equal(await rings(), 0, 'Completed operations park their rings while the agent waits for the next reported action');
  assert.deepEqual(await stages(), ['complete', 'inactive', 'inactive', 'inactive']);
  const completedBadge = await evaluate(`(() => {
    const badge=document.querySelector('.coding-stage[data-stage=Read] .coding-indicator'),
      circle=badge.querySelector('.coding-ring-track'),check=badge.querySelector('.coding-ring-check'),style=getComputedStyle(check);
    return {fill:getComputedStyle(circle).fill,stroke:style.stroke,width:style.strokeWidth,
      cap:style.strokeLinecap,join:style.strokeLinejoin,check:style.display,diameter:circle.getBoundingClientRect().width,
      fallback:getComputedStyle(badge.querySelector('.ui-icon')).visibility};
  })()`);
  assert.equal(completedBadge.fill,'rgb(79, 178, 158)');
  assert.equal(completedBadge.stroke,'rgb(4, 33, 15)');
  assert.equal(completedBadge.width,'2.8px','Our own checkmark has a thick stroke');
  assert.deepEqual([completedBadge.cap,completedBadge.join],['round','round'],'Rounded ends and joins keep the check soft');
  assert.deepEqual([completedBadge.check,completedBadge.fallback],['block','hidden']);
  assert.ok(Math.abs(completedBadge.diameter-14.5)<.1,'Completion stays inside the sidebar indicator');
  await evaluate("mediaPreview.state.paused=true;mediaPreview.state.notify()"); await nextFrame();
  assert.equal(await rings(),0);
  assert.equal(await evaluate("document.querySelector('.coding-current-label').textContent"),'Updates paused');
  assert.equal((await stages())[0],'complete');
  await evaluate("mediaPreview.state.paused=false;mediaPreview.state.notify()"); await nextFrame();
  assert.equal(await rings(),0,'Resuming updates does not invent an active operation');
  await emit('claude', 'PostToolUse', { tool_name: 'Read', tool_use_id: 'progress-read-1' });
  assert.equal(await evaluate("document.querySelector('.coding-current-count').textContent"), '1 action completed');
  await emit('claude', 'PreToolUse', { tool_name: 'Read', tool_use_id: 'progress-read-2',
    tool_input: { file_path: 'C:/work/claude/src/types.ts' } });
  await emit('claude', 'PostToolUse', { tool_name: 'Read', tool_use_id: 'progress-read-2' });
  await nextFrame();
  assert.equal(await evaluate("document.querySelector('.coding-stage[data-stage=Read] .coding-stage-count').textContent"), '2');
  await emit('claude', 'PreToolUse', { tool_name: 'Edit', tool_use_id: 'progress-edit-1',
    tool_input: { file_path: 'C:/work/claude/src/invoice.ts', old_string: 'return sum;', new_string: 'const tax = sum * 0.196;\nreturn sum + tax;' } });
  await evaluate("mediaPreview.preferences({appearance:'glass'});document.body.style.background='#1c2834'");
  await command("Emulation.setDeviceMetricsOverride", { width: 720, height: PANEL_H, deviceScaleFactor: 2, mobile: false });
  await nextFrame();
  assert.equal(await evaluate("document.querySelector('.coding-current-label').textContent"), 'Edit');
  assert.deepEqual(await stages(), ['complete', 'active', 'inactive', 'inactive']);
  assert.equal(await evaluate("document.querySelector('.coding-current-count').textContent"), '2 actions completed');
  assert.ok(await evaluate("document.querySelector('#island').getBoundingClientRect().height") <= PANEL_H,'The expanded Terminal stays within the native panel cap');
  await capture('coding-progress-editing-glass-2x');
  await emit('claude', 'PostToolUseFailure', { tool_name: 'Edit', tool_use_id: 'progress-edit-1' });
  await nextFrame();
  assert.equal(await evaluate("document.querySelector('.coding-current-label').textContent"), 'Edit failed');
  assert.equal(await rings(), 0);
  assert.deepEqual(await stages(), ['complete', 'failed', 'inactive', 'inactive']);
  await capture('coding-progress-failed-glass-2x');
  await emit('claude', 'PreToolUse', { tool_name: 'Edit', tool_use_id: 'progress-edit-2',
    tool_input: { file_path: 'C:/work/claude/src/invoice.ts', old_string: 'return sum;', new_string: 'return sum * 1.196;' } });
  await emit('claude', 'PostToolUse', { tool_name: 'Edit', tool_use_id: 'progress-edit-2' });
  await emit('claude', 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'progress-run',
    tool_input: { command: 'npm test -- --runInBand' } });
  await nextFrame();
  assert.equal(await evaluate("document.querySelector('.coding-current-label').textContent"), 'Bash');
  assert.equal(await evaluate("document.querySelector('.coding-current-target').textContent"), 'npm test -- --runInBand');
  assert.equal(await evaluate("document.querySelector('.coding-edits').hidden"), false,
    'Reviewing prior edits keeps the actual current command visible');
  assert.deepEqual(await stages(), ['complete', 'complete', 'active', 'inactive']);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.coding-indicator[data-state=active] .ui-icon')].map(el=>getComputedStyle(el).visibility)"),['hidden','hidden'],
    'Bash shows only its white loading ring in the current row and operation rail');
  await evaluate("window.progressCard=document.querySelector('.coding-card');window.progressStatus=document.querySelector('.coding-current');window.progressEdits=document.querySelector('.coding-edits');mediaPreview.state.paused=true;mediaPreview.state.notify()");
  await nextFrame();
  assert.equal(await evaluate("document.querySelector('.coding-current-label').textContent"), 'Updates paused');
  assert.equal(await rings(), 0);
  await evaluate("mediaPreview.state.paused=false;mediaPreview.state.notify()");
  await nextFrame();
  assert.equal(await rings(), 1);
  await command("Emulation.setEmulatedMedia", { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await nextFrame();
  assert.equal(await rings(), 0);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-stage[data-state=active] .coding-ring-arc')).display"), 'block');
  assert.equal(await evaluate("document.querySelector('.coding-current-label').textContent"), 'Bash');
  await command("Emulation.setEmulatedMedia", { features: [] });
  await evaluate("mediaPreview.preferences({appearance:'dark'})");
  await command("Emulation.setDeviceMetricsOverride", { width: 720, height: PANEL_H, deviceScaleFactor: 1, mobile: false });
  await nextFrame();
  await capture('coding-progress-running-dark');
  await emit('claude', 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'progress-run',
    mimo_preview: { text: 'PASS invoice.test.ts\nTests: 48 passed, 48 total' },
    mimo_tests: { passed:48, failed:0, total:48, cases:[{name:'invoice.test.ts',status:'passed',kind:'suite'}] } });
  await emit('claude', 'Stop', { message: 'Invoice totals updated. All 48 tests passed.' });
  await evaluate("new Promise(resolve=>setTimeout(resolve,400))");
  const finishedMimo = await evaluate(`(()=>{const engine=mediaPreview.island.engine;return {
    expression:engine.currentExpression,eye:engine.expressionPose.eye,badge:engine.badge?.kind,
    color:engine.badge?.color.map(value=>Math.round(value*255))}})()`);
  assert.deepEqual(finishedMimo,{expression:'finished',eye:'happy',badge:'check',color:[79,178,158]},
    'The real completed turn gives Mimo happy eyes and the native green check badge');
  await evaluate("mediaPreview.state.updateTask('session_claude_claude-progress','idle')"); await nextFrame();
  assert.equal(await evaluate("mediaPreview.island.engine.badge?.kind"),'check','The green check stays with the retained Done result after the short reaction settles');
  assert.ok(await greenBadgePixels()>3,'The retained green badge is painted on Mimo, not just stored in state');
  const happyLids = await evaluate(`(async()=>{const {drawMimoFace}=await import('/src/mimo/face.ts');
    return [10,28].map(radius=>{const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
      let curves=0;const curve=ctx.quadraticCurveTo.bind(ctx);ctx.quadraticCurveTo=(...args)=>{curves++;curve(...args)};
      ctx.translate(60,60);drawMimoFace(ctx,{radius,eye:'happy',expression:'finished',expressionTime:1});return curves;});})()`);
  assert.deepEqual(happyLids,[2,2],'Completion renders two happy curved lids at compact and expanded sizes');
  const completionCue = await evaluate("({sounds:completionSounds,animations:document.querySelector('.coding-card').getAnimations({subtree:true}).filter(a=>a.id==='coding-done').length})");
  assert.equal(completionCue.sounds,1,'A completed turn plays the finish cue once');
  assert.equal(completionCue.animations,0,'A finished turn keeps its status without a game celebration');
  await emit('claude', 'Stop', { message: 'Duplicate completion' });
  assert.equal(await evaluate("completionSounds"),1,'Repeated Stop events never replay the finish cue');
  assert.equal(await evaluate("document.querySelector('.coding-current-label').textContent"), 'Done');
  assert.equal(await evaluate("document.querySelector('.coding-current-count').textContent"), '4 actions completed');
  assert.deepEqual(await stages(), ['complete', 'complete', 'complete', 'complete']);
  assert.deepEqual(await evaluate("(()=>{const check=document.querySelector('.coding-stage[data-stage=Done] .coding-ring-check'),style=getComputedStyle(check);return [style.display,style.strokeWidth,style.strokeLinecap,style.strokeLinejoin]})()"),
    ['block','2.8px','round','round'],'Done uses the same thick, soft checkmark as the completed operations');
  assert.equal(await rings(), 0);
  assert.equal(await evaluate("progressCard===document.querySelector('.coding-card') && progressStatus===document.querySelector('.coding-current') && progressEdits===document.querySelector('.coding-edits')"), true);
  await capture('coding-progress-done-dark');
  await pointerClick('.coding-result-button[aria-expanded]'); await nextFrame();
  assert.equal(await evaluate("document.querySelector('.coding-test-cases').hidden"),false,'Reported test cases open from the result summary');
  assert.equal(await evaluate("document.querySelector('.coding-run-output [data-result=pass]').parentElement.textContent"),'PASS invoice.test.ts');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-stage[data-stage=Done]')).color"),'rgb(79, 178, 158)');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-current-label')).color"),'rgb(79, 178, 158)');
  assert.equal(await evaluate("document.querySelector('.coding-editor-content').dataset.combined"),'true','Live shows reported edits above their command results');
  assert.equal(await evaluate("document.querySelector('.coding-edits').hidden"),false);
  await capture('coding-terminal-reference-pass-dark');
  await evaluate("mediaPreview.preferences({appearance:'glass'})");
  await command("Emulation.setDeviceMetricsOverride", { width: 720, height: PANEL_H, deviceScaleFactor: 2, mobile: false });
  await nextFrame();
  await capture('coding-progress-done-glass');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-run-output [data-result=pass]')).backgroundColor"),'rgb(79, 178, 158)');
  assert.ok(await evaluate("[...document.querySelectorAll('.coding-indicator[data-state=complete] .coding-ring-check')].every(el=>getComputedStyle(el).strokeLinecap==='round'&&getComputedStyle(el).strokeWidth==='2.8px')"));
  await capture('coding-terminal-reference-pass-glass-2x');
  await command("Emulation.setDeviceMetricsOverride", { width: 720, height: PANEL_H, deviceScaleFactor: 1, mobile: false });
  const bounds = await evaluate(`(() => {
    const c=document.querySelector('.coding-card').getBoundingClientRect();
    return [...document.querySelectorAll('.coding-current,.coding-current-label,.coding-current-target,.coding-current-meta,.coding-current-count,.coding-stage,.coding-stage-count,.coding-preview,.coding-edits')]
      .filter(el=>el.getBoundingClientRect().width && !el.hidden).map(el=>{
        const r=el.getBoundingClientRect();return {name:el.className,inside:r.left>=c.left&&r.right<=c.right+.5&&r.top>=c.top&&r.bottom<=c.bottom+.5};});
  })()`);
  assert.ok(bounds.every(item => item.inside), JSON.stringify(bounds));
  await evaluate("(async()=>{await new Promise(resolve=>setTimeout(resolve,850));mediaPreview.state.notify()})()"); await nextFrame();
  assert.equal(await evaluate("document.querySelector('.coding-card').getAnimations({subtree:true}).filter(a=>a.id==='coding-done').length"),0);
  assert.equal(await evaluate("completionSounds"),1,'Rendering a retained result never replays completion audio');
  await emit('codex', 'SessionStart');
  await emit('codex', 'UserPromptSubmit', { prompt: 'Read only' });
  await emit('codex', 'PreToolUse', { tool_name: 'Read', tool_use_id: 'codex-read', tool_input: { file_path: 'C:/work/codex/' + 'long-folder/'.repeat(40) + 'invoice.ts' } });
  await evaluate("mediaPreview.state.selectCodingTask('session_codex_codex-progress');mediaPreview.open('integrations')");
  await evaluate(settled);
  await evaluate("if(document.querySelector('.coding-card')?.dataset.expanded!=='true')document.querySelector('.coding-preview-trigger')?.click()");
  await nextFrame();
  assert.equal(await evaluate("document.querySelector('.coding-current-label').textContent"), 'Read');
  assert.equal(await evaluate("document.querySelector('.coding-current-count').hidden"), true, 'Provider progress stays independent');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.coding-current-target')).textOverflow"), 'ellipsis');
  const originalTarget = await evaluate("mediaPreview.state.codingTask.activity.target");
  for (const [target, technology] of [['src/view.jsx','javascript'],['vite.config.ts','vite'],['src/styles.css','css'],['src/index.html','html'],['package.json','json']]) {
    await evaluate(`mediaPreview.state.codingTask.activity.target=${JSON.stringify(target)};mediaPreview.state.notify()`);
    await nextFrame();
    assert.equal(await evaluate("document.querySelector('.coding-file-icon').dataset.technology"),technology);
    assert.equal(await evaluate("document.querySelector('.coding-file-icon .ui-icon').getAttribute('fill')"),'currentColor');
  }
  await evaluate(`mediaPreview.state.codingTask.activity.target=${JSON.stringify(originalTarget)};mediaPreview.state.notify()`);
  assert.deepEqual(await stages(), ['active', 'inactive', 'inactive', 'inactive']);
  await evaluate("mediaPreview.state.updateTask('session_codex_codex-progress','approval')");
  await nextFrame();
  assert.equal(await evaluate("document.querySelector('.coding-current-label').textContent"), 'Needs approval');
  assert.equal(await rings(), 0);
  assert.equal((await stages())[0], 'waiting');
  await capture('coding-progress-waiting-glass');
  await evaluate("mediaPreview.state.updateTask('session_codex_codex-progress','working');mediaPreview.open('media')");
  await nextFrame();
  assert.equal(await evaluate("progressCard.getAnimations({subtree:true}).filter(a=>a.animationName==='coding-activity-orbit').length"), 0);
  await evaluate("mediaPreview.open('integrations')");
  await evaluate(settled);
  assert.equal(await evaluate("document.querySelector('.coding-card').dataset.expanded"), 'false');
  await pointerClick('.coding-preview-trigger');
  await nextFrame();
  assert.equal(await rings(), 1);
  await emit('codex', 'PostToolUse', { tool_name: 'Read', tool_use_id: 'codex-read' });
  await emit('codex', 'Stop', { message: 'Read complete' });
  await nextFrame();
  assert.deepEqual(await stages(), ['complete', 'inactive', 'inactive', 'complete'], 'Read-only work skips Editing and Running truthfully');
  assert.equal(await evaluate("document.querySelector('.coding-current-count').textContent"), '1 action completed');
  await emit('codex', 'UserPromptSubmit', { prompt: 'A new task' });
  await nextFrame();
  assert.equal(await evaluate("document.querySelector('.coding-current-label').textContent"), 'Thinking');
  assert.deepEqual(await stages(), ['inactive', 'inactive', 'inactive', 'inactive']);
  assert.equal(await rings(), 0, 'Thinking does not invent an active tool stage');
  await command("Input.dispatchKeyEvent", { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await command("Input.dispatchKeyEvent", { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await nextFrame();
  assert.equal(await evaluate("document.querySelector('.coding-card').dataset.expanded"), 'false');
  assert.equal(await rings(), 0);
  assert.equal(await evaluate("document.activeElement.classList.contains('coding-preview-trigger')"), true);
  await evaluate("progressSound.setEnabled(false)");
  const mutedSounds = await evaluate("completionSounds");
  await emit('codex','Stop',{message:'All done, quietly'}); await nextFrame();
  assert.equal(await evaluate("completionSounds"),mutedSounds,'The existing mute setting silences completion');
  await emit('codex','UserPromptSubmit',{prompt:'Background work'});
  await evaluate("mediaPreview.open('media')"); await nextFrame();
  await emit('codex','Stop',{message:'Background done'}); await nextFrame();
  assert.equal(await evaluate("completionSounds"),mutedSounds,'A hidden coding companion never queues a later celebration');
  await evaluate("mediaPreview.open('integrations')"); await nextFrame();
  assert.equal(await evaluate("document.querySelector('.coding-card').getAnimations({subtree:true}).filter(a=>a.id==='coding-done').length"),0);
  await evaluate("mediaPreview.preferences({workingModeEnabled:false});mediaPreview.open('media');mediaPreview.compact()"); await evaluate(settled);
  assert.equal(await evaluate("mediaPreview.island.engine.currentExpression"),'finished','The compact coding companion owns its completion even after the Media tab');
  assert.equal(await evaluate("mediaPreview.island.engine.badge?.kind"),'check');
  assert.ok(await greenBadgePixels()>3,'The compact companion paints the green completion badge');
  await capture('coding-completion-compact-from-media');
  assert.deepEqual(browserErrors, []);
});
