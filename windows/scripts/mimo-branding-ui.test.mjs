// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mimoBrowser } from "./mimo-browser.mjs";

test("Settings and About show the supplied new icon at native and high DPI", async () => {
  const port=1483,browser=await mimoBrowser({port});
  const expected=createHash('sha256').update(readFileSync(new URL('../src/assets/app-icon-ui.png',import.meta.url))).digest('hex');
  try{
    await browser.command('Page.addScriptToEvaluateOnNewDocument',{source:`window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async cmd=>cmd==='boot'?{settings:{},version:'0.1.1'}:cmd==='secret_present'?false:cmd==='plugin:event|listen'?1:null};`});
    await browser.command('Page.navigate',{url:`http://127.0.0.1:${port}/settings.html`});
    await browser.evaluate(`new Promise((resolve,reject)=>{const end=performance.now()+8000;const poll=()=>document.querySelector('[aria-controls=settings-about]')?resolve():performance.now()>end?reject(new Error('Settings did not initialize')):setTimeout(poll,30);poll()})`);
    await browser.click('[aria-controls=settings-about]');
    for(const scale of [1,2,4]){
      await browser.command('Emulation.setDeviceMetricsOverride',{width:760,height:640,deviceScaleFactor:scale,mobile:false});
      await browser.settle();
      const icons=await browser.evaluate(`(async()=>Promise.all([...document.querySelectorAll('.app-mark,.about-icon')].map(async image=>{await image.decode();const bytes=await(await fetch(image.src)).arrayBuffer();const digest=await crypto.subtle.digest('SHA-256',bytes);return {hash:[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join(''),width:image.naturalWidth,visible:image.getBoundingClientRect().width>0}})))()`);
      assert.equal(icons.length,2);
      for(const icon of icons){assert.equal(icon.hash,expected);assert.equal(icon.width,256);assert.equal(icon.visible,true);}
      await browser.capture('mimo-new-app-icon-'+scale+'x');
    }
    assert.deepEqual(browser.errors,[]);
  }finally{await browser.close();}
});

test("Mimo About credits the Windows build and installer and fits native Settings sizes", async () => {
  const browser = await mimoBrowser();
  try {
    await browser.command("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(cmd)=>{
        if(cmd==='boot')return {settings:{},version:'0.1.1'};
        if(cmd==='secret_present')return false;
        if(cmd==='plugin:event|listen')return 1;
        return null;
      }};`,
    });
    await browser.command("Page.navigate", { url: "http://127.0.0.1:1441/settings.html" });
    await browser.evaluate(`new Promise((resolveReady,reject)=>{
      const deadline=performance.now()+8000;
      const ready=()=>document.querySelector('[aria-controls=settings-about]')?resolveReady():
        performance.now()>deadline?reject(new Error('Settings did not initialize')):setTimeout(ready,30);
      ready();
    })`);

    // Reach About with the keyboard and retain the shared visible focus ring.
    await browser.evaluate("document.querySelector('[aria-controls=settings-hotkeys]').focus()");
    for (const type of ["keyDown", "keyUp"]) {
      await browser.command("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    }
    const focused = await browser.evaluate(`(()=>{
      const el=document.activeElement,style=getComputedStyle(el);
      return {target:el.getAttribute('aria-controls'),visible:el.matches(':focus-visible'),outline:style.outlineWidth};
    })()`);
    assert.equal(focused.target, "settings-about");
    assert.equal(focused.visible, true);
    assert.notEqual(focused.outline, "0px");
    for (const type of ["keyDown", "keyUp"]) {
      await browser.command("Input.dispatchKeyEvent", {
        type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
        ...(type === "keyDown" ? { text: "\r" } : {}),
      });
    }
    assert.deepEqual(await browser.evaluate(`({
      name:document.querySelector('.about-product h2').textContent,
      version:document.querySelector('.about-version').textContent,
      rows:[...document.querySelectorAll('.about-build > div')].map(row=>
        [row.querySelector('dt').textContent,row.querySelector('dd').textContent]),
      current:document.querySelector('[aria-controls=settings-about]').getAttribute('aria-current'),
      active:[...document.querySelectorAll('.settings-page:not([hidden])')].map(el=>el.id),
      hiddenInert:[...document.querySelectorAll('.settings-page[hidden]')].every(el=>el.inert)
    })`), {
      name: "Mimo",
      version: "Version 0.1.1",
      rows: [["Windows build by", "John Paul"], ["Installation publisher", "John Paul"]],
      current: "page",
      active: ["settings-about"],
      hiddenInert: true,
    });

    for (const { name, width, height, scale } of [
      { name: "native", width: 760, height: 640, scale: 1 },
      { name: "high-dpi", width: 760, height: 640, scale: 2 },
      { name: "minimum", width: 620, height: 480, scale: 2 },
    ]) {
      await browser.command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
      await browser.settle();
      const layout = await browser.evaluate(`(()=>{
        const content=document.querySelector('.settings-content'),bounds=content.getBoundingClientRect();
        const nodes=[...document.querySelectorAll('.about-panel *')];
        const icon=document.querySelector('.about-icon');
        const toLum=value=>{
          const channels=value.match(/[\\d.]+/g).slice(0,3).map(v=>Number(v)/255)
            .map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
          return .2126*channels[0]+.7152*channels[1]+.0722*channels[2];
        };
        const background=toLum(getComputedStyle(document.body).backgroundColor);
        const contrast=[...document.querySelectorAll('.about-product h2,.about-version,.about-description,.about-build dt,.about-build dd,.about-privacy')]
          .map(el=>{const foreground=toLum(getComputedStyle(el).color);return (Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05)});
        return {
          horizontalOverflow:document.documentElement.scrollWidth>innerWidth || content.scrollWidth>content.clientWidth,
          outside:nodes.filter(el=>{const r=el.getBoundingClientRect();return r.left<bounds.left-.5 || r.right>bounds.right+.5}).map(el=>el.className || el.tagName),
          iconLoaded:icon.complete && icon.naturalWidth>0,
          contrast,
          bottom:document.querySelector('.about-panel').getBoundingClientRect().bottom,
          height:innerHeight,
        };
      })()`);
      assert.equal(layout.horizontalOverflow, false, name + " must not scroll horizontally");
      assert.deepEqual(layout.outside, [], name + " must keep About inside its content column");
      assert.equal(layout.iconLoaded, true, name + " must load the existing app icon");
      assert.ok(layout.contrast.every(ratio => ratio >= 4.5), name + " must preserve readable text contrast");
      assert.ok(layout.bottom <= layout.height, name + " must show the full About panel");
      await browser.capture("mimo-about-" + name);
    }
    await browser.click('[aria-controls=settings-general]');
    assert.equal(await browser.evaluate("document.querySelector('#settings-about').inert"), true);
    await browser.click('[aria-controls=settings-about]');
    assert.equal(await browser.evaluate("document.querySelector('#settings-about').hidden"), false);
    assert.deepEqual(browser.errors, []);
  } finally {
    await browser.close();
  }
});
