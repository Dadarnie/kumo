// SPDX-License-Identifier: MIT
// Mimo's shared silver sphere. Coordinates are head-radius units.
import { clamp } from "../core/anim";
import type { EyeShape } from "./engine";
import type { MimoBadgeIcon } from "./status";
import { MIMO_PALETTE } from "./palette";
import { MIMO_EXPRESSIONS, type MimoExpressionName } from "./expressions";
import { drawMimoAppIcon, isMimoAppIcon, type MimoAppIcon } from "./brands";
import { drawMimoWave } from "./wave";
import { ICONS } from "../views/icons";
import { soundFilled } from "../icons/filled";

export const MIMO_WHITE = MIMO_PALETTE.body;
export const MIMO_INK = MIMO_PALETTE.eyes;
export const MIMO_BODY_SCALE = 1.1;
export const MIMO_HEAD = "M0-1.1 A1.1 1.1 0 1 1 0 1.1 A1.1 1.1 0 1 1 0-1.1Z";
let head: Path2D | undefined;
const intakeHeads = new Map<number, Path2D>();
let tile: Path2D | undefined;
let voiceMicrophone: Path2D | undefined;
let voiceSpeaker: Path2D | undefined;
const faceMaterials = new WeakMap<CanvasRenderingContext2D, {
  key: string; a: number; b: number; c: number; d: number; e: number; f: number;
  body: CanvasGradient; rim: CanvasGradient;
}>();

export interface MimoFace {
  radius: number;
  eye?: EyeShape;
  open?: number;
  wink?: number;
  lookX?: number;
  lookY?: number;
  eyeScale?: number;
  time?: number;
  upsideDown?: boolean;
  rotation?: number;
  eyeRoll?: number;
  spiralAngle?: number;
  color?: readonly [number, number, number];
  expressionOpen?: number;
  expression?: MimoExpressionName;
  expressionProgress?: number;
  /** One authored 800 ms entrance; 1 is the stable reference pose. */
  expressionTime?: number;
  /** Local playback rhythm; absent outside the foreground music performance. */
  musicTime?: number | null;
  /** File intake, shared with the sheet's clipping anchor. */
  mouthOpening?: number;
  /** The temporary soft square body used while receiving a file. */
  intakeMorph?: number;
}

/** The top intake slot and descending sheet share these bounds. */
export function mimoIntake(radius: number, opening: number) {
  const amount = clamp(Number.isFinite(opening) ? opening / .5 : 0, 0, 1);
  const w = radius * (.65 + .65 * amount), h = radius * .24 * amount;
  return { x: -w / 2, y: -radius * .73 - h / 2, w, h };
}

function headOutline(morph = 0): Path2D {
  head ??= new Path2D(MIMO_HEAD);
  const step = Math.round(clamp(morph, 0, 1) * 48);
  if (step === 0) return head;
  let outline = intakeHeads.get(step);
  if (!outline) {
    outline = new Path2D();
    outline.roundRect(-1.1, -1.1, 2.2, 2.2, 1.1 - .78 * step / 48);
    intakeHeads.set(step, outline);
  }
  return outline;
}

const safeLook = (value = 0) => Number.isFinite(value) ? clamp(value, -1, 1) : 0;

function closedEye(ctx: CanvasRenderingContext2D, w: number, radius: number, happy = false) {
  ctx.lineWidth = Math.max(.12, 1.25 / radius);
  ctx.beginPath();
  ctx.moveTo(-w * .7, 0);
  if (happy) ctx.quadraticCurveTo(0, -w * 1.25, w * .7, 0);
  else ctx.lineTo(w * .7, 0);
  ctx.stroke();
}

function heart(ctx: CanvasRenderingContext2D, w: number) {
  ctx.beginPath();
  ctx.moveTo(0, w * 0.8);
  ctx.bezierCurveTo(-w * 1.6, -w * 0.1, -w * 0.65, -w * 1.3, 0, -w * 0.55);
  ctx.bezierCurveTo(w * 0.65, -w * 1.3, w * 1.6, -w * 0.1, 0, w * 0.8);
  ctx.fill();
}

function eye(ctx: CanvasRenderingContext2D, face: MimoFace, side: number) {
  const shape = face.eye ?? "pill";
  const opening = clamp(face.open ?? 1, 0, 1) * (side < 0 ? 1 - .96 * clamp(face.wink ?? 0, 0, 1) : 1);
  const scale = clamp(face.eyeScale ?? 1, 0.85, 1.12);
  const lookX = safeLook(face.lookX);
  const lookY = safeLook(face.lookY);
  // Same spherical projection as Mochi, restrained to keep both eyes readable.
  // Neutral is front-facing; the far eye narrows naturally on either turn.
  const longitude = side * 0.32 + lookX;
  const roll = face.eyeRoll ?? 0;
  const latitude = lookY + roll;
  const cp = Math.cos(latitude);
  const phase = clamp(face.expressionTime ?? 1, 0, 1);
  const pulse = Math.sin(Math.PI * phase);
  const expression = face.expression;
  if (Math.cos(longitude) * cp <= 0.04) return; // Mochi's face-roll passes around the soft head.
  const w = Math.max(0.125 * scale * Math.max(0.18, Math.cos(longitude)), 0.7 / face.radius) * (shape === "wide" ? 1.18 : 1) * MIMO_BODY_SCALE;
  const h = Math.max(0.205 * scale * cp, 0.9 / face.radius) * (shape === "wide" || shape === "dot" ? 1.16 : 1) * MIMO_BODY_SCALE;
  ctx.save();
  ctx.translate(Math.sin(longitude) * Math.cos(lookY) * MIMO_BODY_SCALE,
    (.055 * Math.cos(roll) + Math.sin(lookY) * .33 * Math.cos(roll) - Math.cos(lookY) * Math.sin(roll)) * MIMO_BODY_SCALE);
  if (expression === "focus" || expression === "worried") ctx.translate(-side * .025 * pulse, .015 * pulse);
  if (expression === "question") ctx.translate(0, side > 0 ? -.025 * pulse : 0);
  if (expression === "music" || expression === "dancing") ctx.translate(0, -.018 * Math.sin(phase * Math.PI * 2 + side * .25) * pulse);
  if (expression === "dancing" && face.musicTime != null) {
    ctx.rotate(side * .12 * Math.sin(face.musicTime * Math.PI * 2 / 1.6) * Math.min(1, phase * 2));
  }
  if (expression === "surprised") ctx.scale(1 + .08 * pulse, 1 + .06 * pulse);
  ctx.fillStyle = MIMO_INK;
  ctx.strokeStyle = MIMO_INK;
  ctx.lineWidth = Math.max(0.075, 1.1 / face.radius);
  ctx.lineCap = "round";
  // Every expression uses the same eyelid handoff.
  ctx.scale(1, Math.max(.025, clamp(face.expressionOpen ?? 1, 0, 1)));

  if (shape === "closed" || opening < 0.12 || shape === "happy" || (shape === "wink" && side < 0)) {
    if (shape === "happy" || shape === "wink") ctx.translate(0, -.045);
    closedEye(ctx, w, face.radius, shape === "happy" && (expression === "music" || expression === "dancing" || expression === "finished"));
  } else if (shape === "line" || shape === "flat") {
    ctx.rotate(shape === "line" ? side * -0.12 : 0);
    closedEye(ctx, w, face.radius);
  } else if (shape === "heart") {
    ctx.fillStyle = face.color?.some(value => value < 0.68) ? MIMO_INK : MIMO_PALETTE.love;
    ctx.scale(1 + .07 * pulse, 1 + .07 * pulse);
    heart(ctx, w * 1.65);
  } else if (shape === "spiral") {
    ctx.rotate(side * (face.spiralAngle ?? 0));
    ctx.lineWidth = Math.max(.032, .65 / face.radius);
    const spiralRadius = w * 2.1;
    ctx.beginPath();
    for (let a = 0; a < Math.PI * 4 * (.55 + .45 * (1 - (1 - phase) ** 3)); a += 0.15) {
      const r = spiralRadius * (0.09 + a * 0.071);
      const angle = a - Math.PI / 2 + side * .3 * pulse;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  } else {
    // Solid eyes stay rounded at both ends across every companion size.
    ctx.scale(1, Math.max(0.12, opening));
    if (shape === "worried") ctx.rotate(side * -.22);
    if (shape === "tired" || shape === "cup" || shape === "stern" || shape === "focus") {
      ctx.beginPath();
      const lid = shape === "tired" ? -h * .05 : -h * .3;
      if (shape === "stern") {
        const angle = side * -.6;
        ctx.moveTo(-w - .05, lid - angle * w); ctx.lineTo(w + .05, lid + angle * w);
        ctx.lineTo(w + .05, h * 1.2); ctx.lineTo(-w - .05, h * 1.2); ctx.closePath();
      } else if (shape === "focus") {
        // Relaxed, level lids distinguish concentration from the stern pose.
        ctx.moveTo(-w - .05, -h * .55);
        ctx.quadraticCurveTo(0, -h * .8, w + .05, -h * .55);
        ctx.lineTo(w + .05, h * 1.2); ctx.lineTo(-w - .05, h * 1.2); ctx.closePath();
      } else ctx.rect(-w - .05, lid, w * 2 + .1, h * 1.2);
      ctx.clip();
    }
    if (shape === "worried") {
      ctx.beginPath(); ctx.moveTo(-w - .02, -h * .55); ctx.quadraticCurveTo(0, -h * .85, w + .02, -h * .15);
      ctx.lineTo(w + .03, h * 1.2); ctx.lineTo(-w - .03, h * 1.2); ctx.closePath(); ctx.clip();
    }
    ctx.beginPath();
    if (shape === "wide" || shape === "dot") ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
    else ctx.roundRect(-w, -h, w * 2, h * 2, Math.min(w, h));
    ctx.fillStyle = MIMO_INK;
    ctx.fill();
  }
  ctx.restore();
}

/** One earless spherical master, shared by main, mini and service companions. */
export function drawMimoFace(ctx: CanvasRenderingContext2D, face: MimoFace) {
  if (face.radius <= 0) return;
  const outline = headOutline(face.intakeMorph);
  ctx.save();
  ctx.scale(face.radius, face.radius);
  ctx.rotate(face.rotation ?? (face.upsideDown ? Math.PI : 0));
  const r = Math.round(clamp(face.color?.[0] ?? 1, 0, 1) * 255);
  const g = Math.round(clamp(face.color?.[1] ?? 1, 0, 1) * 255);
  const b = Math.round(clamp(face.color?.[2] ?? 1, 0, 1) * 255);
  const colored = Math.min(r, g, b) < 174;
  const key = colored ? `${r},${g},${b}` : "silver";
  const matrix = ctx.getTransform();
  let material = faceMaterials.get(ctx);
  if (!material || material.key !== key || material.a !== matrix.a || material.b !== matrix.b
    || material.c !== matrix.c || material.d !== matrix.d || material.e !== matrix.e || material.f !== matrix.f) {
    const rgb = (mix: number, factor = 1) => `rgb(${Math.round(r * factor + (255 - r) * mix)},${Math.round(g * factor + (255 - g) * mix)},${Math.round(b * factor + (255 - b) * mix)})`;
    const body = ctx.createRadialGradient(-.374, -.396, .066, -.022, -.022, 1.408);
    body.addColorStop(0, colored ? rgb(.18) : MIMO_PALETTE.highlight);
    body.addColorStop(.42, colored ? rgb(.03) : MIMO_WHITE);
    body.addColorStop(1, colored ? rgb(0, .68) : MIMO_PALETTE.shade);
    const rim = ctx.createLinearGradient(-.85, -.9, .7, .85);
    rim.addColorStop(0, "rgba(255,255,255,.62)");
    rim.addColorStop(.44, "rgba(255,255,255,.12)");
    rim.addColorStop(1, "rgba(71,83,94,.14)");
    material = { key, a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f, body, rim };
    faceMaterials.set(ctx, material);
  }
  ctx.fillStyle = material.body;
  ctx.fill(outline);
  ctx.save();
  ctx.clip(outline);
  ctx.strokeStyle = material.rim;
  ctx.lineWidth = Math.max(.024, .55 / face.radius);
  ctx.stroke(outline);
  eye(ctx, face, -1);
  eye(ctx, face, 1);
  // File intake opens at the top; expressive mouths remain on the lower face.
  if ((face.mouthOpening ?? 0) > .002) {
    const mouth = mimoIntake(1, face.mouthOpening!);
    ctx.fillStyle = MIMO_INK;
    ctx.beginPath();
    ctx.roundRect(mouth.x, mouth.y, mouth.w, mouth.h, Math.min(.08, mouth.h / 2));
    ctx.fill();
  } else if (face.expression === "surprised" || face.expression === "yawn" || face.expression === "music") {
    const yawn = face.expression === "yawn";
    const whistling = face.expression === "music";
    ctx.globalAlpha = clamp(face.expressionProgress ?? 1, 0, 1) * clamp(face.expressionOpen ?? 1, 0, 1);
    ctx.fillStyle = MIMO_INK;
    const opening = 1 - (1 - clamp(face.expressionProgress ?? 1, 0, 1)) ** 3;
    const breath = face.musicTime == null ? .65 : (.5 - .5 * Math.cos(face.musicTime * Math.PI * 2 / 3.2));
    ctx.beginPath();
    ctx.ellipse(whistling ? .1 : 0, .64, whistling ? .06 : yawn ? .065 : .085,
      (whistling ? .045 + .028 * breath : yawn ? .11 : .105) * Math.max(.05, opening), 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  ctx.restore();
}

const backdropGradients = new WeakMap<CanvasRenderingContext2D, {
  a: number; b: number; c: number; d: number; e: number; f: number; blue: number; color?: string;
  inner: CanvasGradient; outer: CanvasGradient;
}>();

/** Mochi's two-pass aura, contained in the existing buffer. No blur or extra canvas. */
export function drawMimoBackdrop(ctx: CanvasRenderingContext2D, radius: number, withTile = false, introBlue = 0, stateColor?: string) {
  if (radius < 4 && !withTile) return;
  ctx.save(); ctx.scale(radius, radius);
  if (withTile) {
    tile ??= new Path2D("M-.85-1.35 H.85 Q1.35-1.35 1.35-.85 V.85 Q1.35 1.35.85 1.35 H-.85 Q-1.35 1.35-1.35.85 V-.85 Q-1.35-1.35-.85-1.35 Z");
    ctx.fillStyle = MIMO_PALETTE.tile; ctx.fill(tile); ctx.clip(tile);
  }
  const blue = clamp(introBlue, 0, 1);
  const matrix = ctx.getTransform();
  let glow = backdropGradients.get(ctx);
  if (!glow || glow.blue !== blue || glow.color !== stateColor || glow.a !== matrix.a || glow.b !== matrix.b || glow.c !== matrix.c
    || glow.d !== matrix.d || glow.e !== matrix.e || glow.f !== matrix.f) {
    const hue = stateColor?.startsWith("#") && stateColor.length === 7
      ? `${parseInt(stateColor.slice(1, 3), 16)},${parseInt(stateColor.slice(3, 5), 16)},${parseInt(stateColor.slice(5, 7), 16)}`
      : `${Math.round(232 - 173 * blue)},${Math.round(195 - 37 * blue)},${Math.round(154 + 101 * blue)}`;
    const inner = ctx.createRadialGradient(0, .02, .2, 0, .02, 1.6);
    inner.addColorStop(0, `rgba(${hue},.38)`);
    inner.addColorStop(.55, `rgba(${hue},.23)`);
    inner.addColorStop(1, `rgba(${hue},0)`);
    const outer = ctx.createRadialGradient(0, .02, 0, 0, .02, 2.12);
    outer.addColorStop(0, `rgba(${hue},.16)`);
    outer.addColorStop(.55, `rgba(${hue},.07)`);
    outer.addColorStop(1, `rgba(${hue},0)`);
    glow = { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f, blue, color: stateColor, inner, outer };
    backdropGradients.set(ctx, glow);
  }
  ctx.fillStyle = glow.outer; ctx.fillRect(-2.12, -2.12, 4.24, 4.24);
  ctx.fillStyle = glow.inner; ctx.fillRect(-1.6, -1.6, 3.2, 3.2);
  ctx.restore();
}

/** Badge glyphs stay vector paths rather than font characters at small sizes. */
export function drawMimoBadge(ctx: CanvasRenderingContext2D, badge: {
  radius: number; kind: MimoBadgeIcon | MimoAppIcon; color: string; scale?: number;
  loading?: boolean; time?: number;
  appColor?: string;
  motionProgress?: number;
}) {
  const R = badge.radius;
  if (R <= 0) return;
  const app = isMimoAppIcon(badge.kind);
  const p = clamp(badge.motionProgress ?? 1, 0, 1);
  const reveal = (start = 0, duration = .5) => 1 - (1 - clamp((p - start) / duration, 0, 1)) ** 3;
  const br = Math.max(0.27, (app ? 4 : 3) / R);
  ctx.save(); ctx.translate(-R * .9, -R * .68);
  ctx.scale(R * (badge.scale ?? 1), R * (badge.scale ?? 1));
  // Clear the contact arc so the circular badge sits just above the sphere.
  // Transparency lets the surrounding surface show through at every size.
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  const gap = clamp(R * .055, 1.15, 2.2) / R;
  ctx.beginPath(); ctx.arc(0, 0, br + gap, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.fillStyle = app ? MIMO_PALETTE.eyes : badge.color;
  ctx.beginPath(); ctx.arc(0, 0, br, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(237,245,255,.3)";
  ctx.lineWidth = Math.max(.018, .45 / R); ctx.stroke();
  if (app) {
    ctx.strokeStyle = "rgba(237,241,244,0.24)";
    ctx.lineWidth = Math.max(0.025, 0.6 / R); ctx.stroke();
    drawMimoAppIcon(ctx, badge.kind as MimoAppIcon, br * 1.44, badge.appColor ?? badge.color);
    ctx.restore(); return;
  }
  const darkGlyph = ["dots", "check", "bang", "hourglass"].includes(badge.kind);
  ctx.fillStyle = ctx.strokeStyle = darkGlyph ? MIMO_INK : "#FFFFFF";
  ctx.scale(br / 0.23, br / 0.23);
  if (badge.kind === "microphone" || badge.kind === "speaker") {
    const glyph = badge.kind === "microphone" ? voiceMicrophone ??= new Path2D(ICONS.microphone) : voiceSpeaker ??= new Path2D(soundFilled.path);
    ctx.scale(.015, .015);ctx.translate(-12, -12);ctx.fill(glyph);ctx.restore();return;
  }
  ctx.lineWidth = Math.max(0.045, 0.8 / R); ctx.lineCap = ctx.lineJoin = "round";
  if (badge.kind === "dots") {
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = reveal(i * .12, .25) * (badge.loading ? 0.6 + Math.sin((badge.time ?? 0) * 2.4 - i * 0.8) * 0.4 : 1);
      ctx.beginPath(); ctx.arc((i - 1) * Math.max(0.095, 1.15 / R), 0, Math.max(0.032, 0.5 / R), 0, Math.PI * 2); ctx.fill();
    }
  } else if (badge.kind === "check") {
    ctx.setLineDash([.32 * reveal(0, .45), .5]);
    ctx.beginPath(); ctx.moveTo(-0.09, 0); ctx.lineTo(-0.02, 0.075); ctx.lineTo(0.10, -0.075); ctx.stroke();
  } else if (badge.kind === "cross") {
    for (const [side, start] of [[1, 0], [-1, .14]]) {
      const amount = reveal(start, .35);
      ctx.beginPath(); ctx.moveTo(-.075, -.075 * side);
      ctx.lineTo(-.075 + .15 * amount, side * (-.075 + .15 * amount)); ctx.stroke();
    }
  } else if (badge.kind === "hourglass") {
    ctx.beginPath(); ctx.moveTo(-.09, -.10); ctx.lineTo(.09, -.10); ctx.lineTo(-.09, .10);
    ctx.lineTo(.09, .10); ctx.lineTo(-.09, -.10); ctx.stroke();
  } else if (badge.kind === "focus") {
    ctx.beginPath(); ctx.arc(0, 0, .10, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * reveal(0, .45)); ctx.stroke();
  } else if (badge.kind === "bolt") {
    ctx.beginPath(); ctx.rect(-.15, -.15, .3, .3 * reveal(0, .55)); ctx.clip();
    ctx.beginPath(); ctx.moveTo(.03, -.13); ctx.lineTo(-.09, .015); ctx.lineTo(.015, .015);
    ctx.lineTo(-.03, .13); ctx.lineTo(.09, -.025); ctx.lineTo(-.015, -.025); ctx.closePath(); ctx.fill();
  } else {
    ctx.beginPath(); ctx.moveTo(0, -0.095); ctx.lineTo(0, -.095 + .095 * reveal(0, .3)); ctx.stroke();
    ctx.globalAlpha = reveal(.2, .25);
    ctx.beginPath(); ctx.arc(0, 0.11, Math.max(0.025, 0.35 / R), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

let question: Path2D | undefined;
let note: Path2D | undefined;
let tear: Path2D | undefined;
let heartAccent: Path2D | undefined;
/** A few clear vector accents, contained in the character's existing buffer. */
export function drawMimoExpressionDetail(ctx: CanvasRenderingContext2D, options: {
  radius: number; expression: MimoExpressionName; progress?: number; time?: number; musicTime?: number | null;
}) {
  const detail = MIMO_EXPRESSIONS[options.expression].detail;
  if (!detail || options.radius < 7) return;
  const progress = clamp(options.progress ?? 1, 0, 1);
  if (progress <= 0) return;
  if (detail === "wave") {
    ctx.save(); ctx.globalAlpha *= progress;
    drawMimoWave(ctx, options.radius, options.time ?? .8); ctx.restore(); return;
  }
  question ??= new Path2D("M-.08-.12 C-.08-.25.17-.27.17-.12 C.17-.02.025-.02.025.07 M.025.18 L.025.19");
  note ??= new Path2D("M.04.1 V-.25 L.22-.18 V.13 M.04-.25 V-.13 L.22-.06");
  tear ??= new Path2D("M0-.135 C-.018-.075-.075-.005-.07.045 C-.065.125.064.13.071.045 C.077-.004.019-.077 0-.135 Z");
  heartAccent ??= new Path2D("M0 .15 C-.25-.02-.11-.22 0-.1 C.11-.22.25-.02 0 .15 Z");
  ctx.save(); ctx.scale(options.radius, options.radius);
  ctx.globalAlpha *= 1 - (1 - progress) ** 3;
  const phase = clamp((options.time ?? .8) / .8, 0, 1);
  const reveal = (start = 0, duration = .5) => 1 - (1 - clamp((phase - start) / duration, 0, 1)) ** 3;
  ctx.lineWidth = Math.max(.055, 1 / options.radius); ctx.lineCap = ctx.lineJoin = "round";
  ctx.fillStyle = ctx.strokeStyle = MIMO_EXPRESSIONS[options.expression].accent;
  if (detail === "question") {
    ctx.translate(1.2, -.75); ctx.setLineDash([.85 * reveal(0, .7), 1.3]); ctx.stroke(question);
  } else if (detail === "search") {
    ctx.translate(1.1, -.05); ctx.beginPath(); ctx.arc(0, 0, .18, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * reveal(0, .55)); ctx.stroke();
    const handle = .13 + .2 * reveal(.35, .35);
    ctx.beginPath(); ctx.moveTo(.13, .13); ctx.lineTo(handle, handle); ctx.stroke();
  } else if (detail === "tear") {
    const arrival = reveal(options.expression === "error" ? .3 : .15, .5);
    ctx.globalAlpha *= arrival;
    ctx.translate(.78, -.5 + .055 * arrival); ctx.rotate(-.18);
    const size = .88 + .12 * arrival; ctx.scale(size, size);
    ctx.fillStyle = "#78AEC7"; ctx.fill(tear);
    ctx.fillStyle = "rgba(226,245,250,.7)";
    ctx.beginPath(); ctx.ellipse(-.021,.027,.012,.027,.22,0,Math.PI*2); ctx.fill();
  } else if (detail === "bang") {
    ctx.strokeStyle = ctx.fillStyle = MIMO_PALETTE.pride; ctx.translate(1.12, -.7);
    ctx.beginPath(); ctx.moveTo(0, -.17); ctx.lineTo(0, -.17 + .185 * reveal(0, .4)); ctx.stroke();
    ctx.globalAlpha *= reveal(.3, .3);
    ctx.beginPath(); ctx.arc(0, .14, .032, 0, Math.PI * 2); ctx.fill();
  } else if (detail === "hourglass") {
    ctx.translate(1.15, -.73);
    ctx.beginPath(); ctx.moveTo(-.12, -.18); ctx.lineTo(.12, -.18); ctx.lineTo(-.12, .18);
    ctx.lineTo(.12, .18); ctx.lineTo(-.12, -.18); ctx.stroke();
    if (phase > .25 && phase < .95) {
      const grain = clamp((phase - .25) / .7, 0, 1);
      ctx.beginPath(); ctx.arc(0, -.09 + .2 * grain, .023, 0, Math.PI * 2); ctx.fill();
    }
  } else if (detail === "hearts") {
    ctx.fillStyle = MIMO_PALETTE.love;
    for (const [x, y, scale, delay, sign] of [[1.12, -.9, .9, 0, 1], [1.3, -.43, .65, .2, -1]]) {
      const arrival = reveal(delay, .65);
      ctx.save(); ctx.globalAlpha *= arrival;
      ctx.translate(x + sign * Math.sin(arrival * Math.PI) * .08, y + (1 - arrival) * .12);
      ctx.scale(scale, scale); ctx.fill(heartAccent); ctx.restore();
    }
  } else if (detail === "notes") {
    ctx.fillStyle = ctx.strokeStyle = MIMO_PALETTE.music;
    for (const [x, y, scale, delay, sign] of [[1.05, -.84, .8, 0, 1], [1.27, -.18, .55, .18, -1]]) {
      const arrival = reveal(delay, .65);
      const playing = options.musicTime != null;
      const dancing = options.expression === "dancing";
      const beat = playing ? options.musicTime! * Math.PI * 2 / 1.6 : 0;
      const flight = playing ? ((options.musicTime! / 3.2 + delay * 2.8) % 1) : 1;
      const swing = dancing && playing ? Math.sin(beat + delay * Math.PI * 3) * .12
        : Math.sin(arrival * Math.PI) * (dancing ? .13 : .045);
      ctx.save(); ctx.globalAlpha *= arrival;
      if (playing && !dancing) {
        // Phrases leave the puckered mouth, travel around the cheek, then fade
        // above the body. Both notes keep the reference's purple double stem.
        ctx.globalAlpha *= clamp(flight / .16, 0, 1) * clamp((1 - flight) / .22, 0, 1);
        const u = 1 - flight;
        ctx.translate(u * u * .38 + 2 * u * flight * 1.3 + flight * flight * x,
          u * u * .53 + 2 * u * flight * .28 + flight * flight * y);
        ctx.rotate(-.12 * Math.sin(flight * Math.PI));
      } else {
        ctx.translate(x + sign * swing, y + sign * swing * .65); ctx.rotate(playing ? sign * swing * .7 : 0);
      }
      ctx.scale(scale * (playing && !dancing ? .6 + .4 * flight : 1), scale * (playing && !dancing ? .6 + .4 * flight : 1)); ctx.stroke(note);
      for (const [nx, ny] of [[-.025, .14], [.15, .18]]) { ctx.beginPath(); ctx.ellipse(nx, ny, .07, .045, -.3, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    if (options.expression !== "dancing" && options.musicTime != null) {
      // A single curved breath line identifies whistling without adding audio.
      const breath = .5 - .5 * Math.cos(options.musicTime * Math.PI * 2 / 3.2);
      ctx.globalAlpha *= reveal(0, .4) * breath * .55;
      ctx.lineWidth *= .65;
      ctx.beginPath(); ctx.moveTo(.24, .59); ctx.quadraticCurveTo(.38, .5, .49, .56); ctx.stroke();
    }
  }
  ctx.restore();
}
