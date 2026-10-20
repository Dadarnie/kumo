// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mimoBrowser } from "./mimo-browser.mjs";

let browser;
before(async () => { browser = await mimoBrowser({ page: "/dev/mimo-preview.html", ready: "window.mimoPreview?.engine", port: 1447 }); });
after(async () => { await browser?.close(); });

test("the shared bot keeps a circular earless outline, silver depth and legible dark capsules at both DPI scales", async () => {
  for (const scale of [1, 2]) {
    const result = await browser.evaluate(`(async () => {
      const { drawMimoFace, MIMO_BODY_SCALE } = await import('/src/mimo/face.ts');
      const observations = [];
      for (const diameter of [16, 24, 32, 58]) for (const lookX of [-.62, 0, .62]) {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128 * ${scale};
        const ctx = canvas.getContext('2d'); ctx.scale(${scale}, ${scale}); ctx.translate(64, 64);
        const radius = diameter / 2; drawMimoFace(ctx, { radius, lookX });
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let outside = 0, eyes = 0, eyeX = 0;
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
          const index = (y * canvas.width + x) * 4;
          if (pixels[index + 3] > 128 && Math.hypot((x + .5) / ${scale} - 64, (y + .5) / ${scale} - 64) > radius * MIMO_BODY_SCALE + .4) outside++;
          if (pixels[index + 3] > 240 && Math.max(...pixels.slice(index, index + 3)) < 70) { eyes++; eyeX += (x + .5) / ${scale}; }
        }
        const point = (x, y) => [...ctx.getImageData(Math.round(x * ${scale}), Math.round(y * ${scale}), 1, 1).data];
        observations.push({ diameter, lookX, outside, eyes, eyeX: eyeX / eyes,
          corner: point(64 + radius * .94, 64 - radius * .94)[3],
          light: point(64 - radius * .3, 64 - radius * .35),
          shade: point(64 + radius * .6, 64 + radius * .4) });
      }
      return observations;
    })()`);
    for (const pose of result) {
      assert.equal(pose.outside, 0, JSON.stringify(pose));
      assert.equal(pose.corner, 0, "The old ear corners remain fully transparent");
      assert.ok(pose.eyes >= 2 * scale, "Both turns keep readable dark eyes: " + JSON.stringify(pose));
      assert.ok(pose.light[0] > pose.shade[0] + 10, "Silver depth follows the supplied PNG");
      assert.ok(pose.light[2] >= pose.light[0], "The body stays neutral silver");
    }
    for (const diameter of [16, 24, 32, 58]) {
      const turns = result.filter(pose => pose.diameter === diameter);
      assert.ok(turns[0].eyeX < turns[1].eyeX - diameter * .1);
      assert.ok(turns[2].eyeX > turns[1].eyeX + diameter * .1);
    }
  }
  assert.deepEqual(browser.errors, []);
});

test("main, mini and service bots share the spherical renderer while service identity and top intake remain animated", async () => {
  const observations = await browser.evaluate(`(async () => {
    const { BotEngine, hexToRGB } = await import('/src/mimo/engine.ts');
    const { mimoIntake } = await import('/src/mimo/face.ts');
    const colors = [];
    for (const color of [null, '#E13D44', '#4FB29E', '#8358E9', '#E69537']) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
      const ctx = canvas.getContext('2d'), engine = new BotEngine();
      engine.backdrop = false; engine.showBadge = false; engine.isMini = color !== null;
      engine.bodyColor = color ? hexToRGB(color) : null; engine.settlePose(); engine.draw(ctx, 128, 128);
      colors.push([...ctx.getImageData(64, 47, 1, 1).data]); engine.destroy();
    }
    const intake = mimoIntake(32, .5);
    return { colors, intake };
  })()`);
  assert.ok(observations.colors[0][2] >= observations.colors[0][0], "Main Mimo uses the silver master");
  assert.ok(observations.colors[1][0] > observations.colors[1][1] * 1.5, "The red service remains red");
  assert.ok(observations.colors[2][1] > observations.colors[2][0] * 1.3, "The green service remains green");
  assert.ok(observations.colors[3][2] > observations.colors[3][1] * 1.5, "The purple service remains purple");
  assert.ok(observations.colors[4][0] > observations.colors[4][2] * 1.5, "The orange service remains orange");
  assert.ok(observations.intake.y + observations.intake.h < -12, "File intake opens above the eyes");
  assert.deepEqual(browser.errors, []);
});

