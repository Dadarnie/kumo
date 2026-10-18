// SPDX-License-Identifier: MIT
import { clamp, Ease, lerp } from "../core/anim";
import { MIMO_PALETTE } from "./palette";

let hand: Path2D | undefined;
let restingHand: Path2D | undefined;

function fillHand(ctx: CanvasRenderingContext2D, path: Path2D) {
  ctx.fillStyle = MIMO_PALETTE.body;
  ctx.fill(path);
  const shade = ctx.createLinearGradient(.4, -.22, -.4, .22);
  shade.addColorStop(0, "rgba(207,202,216,0)");
  shade.addColorStop(1, "rgba(207,202,216,.42)");
  ctx.fillStyle = shade;
  ctx.fill(path);
  ctx.strokeStyle = "rgba(0,0,0,.08)";
  ctx.lineWidth = .025;
  ctx.stroke(path);
}

/** Mochi's original capsule hand and wrist rhythm, fitted to Mimo's cheeks. */
export function drawMimoHands(ctx: CanvasRenderingContext2D, radius: number,
  left: number, right: number, wave = -1) {
  if (radius <= 0 || (left <= .01 && right <= .01)) return;
  hand ??= new Path2D();
  if (!restingHand) {
    hand.roundRect(-.4, -.22, .8, .44, .22);
    restingHand = new Path2D();
    restingHand.ellipse(0, 0, .3, .3, 0, 0, Math.PI * 2);
  }
  ctx.save(); ctx.scale(radius, radius);
  if (left > .01) {
    const amount = clamp(left, 0, 1.08);
    ctx.save();
    ctx.translate(lerp(-1.14 * .35, -1.58, amount),
      lerp(.85, .62, amount) + (wave < 0 ? 0 : Math.sin(wave * 6) * .04));
    ctx.scale(amount, amount); fillHand(ctx, restingHand); ctx.restore();
  }
  if (right > .01) {
    const amount = clamp(right, 0, 1.08);
    const rhythm = Math.max(0, wave) * Math.PI * 2 * 2.5;
    const arrival = wave < 0 ? 0 : Ease.inOut(clamp(wave / .16, 0, 1));
    ctx.save();
    ctx.translate(lerp(1.14 * .35, 1.54, amount) + Math.cos(rhythm) * .03 * arrival,
      lerp(.85, .2, amount) + Math.sin(rhythm + .8) * .08 * arrival);
    ctx.rotate(-.61 + Math.sin(rhythm) * .21 * arrival);
    ctx.scale(amount, amount); fillHand(ctx, hand); ctx.restore();
  }
  ctx.restore();
}

/** A finite hello: rise, wrist wave, then a soft tuck. Uses the owner's clock. */
export function drawMimoWave(ctx: CanvasRenderingContext2D, radius: number, elapsed: number) {
  const raised = Ease.out(clamp(elapsed / .16, 0, 1)) * (1 - Ease.inOut(clamp((elapsed - 1.55) / .35, 0, 1)));
  drawMimoHands(ctx, radius, raised * .7, raised, Math.max(0, elapsed - .16));
}
