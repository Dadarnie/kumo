// SPDX-License-Identifier: MIT
// The upload canvas — port of UploadCanvasView.swift.
//
// While the sequence engine is active this canvas draws the whole island body:
// card, dashed drop frame, drop text, progress bar, the choose card, Mimo and
// the file being sucked in. The island's own Mimo is hidden for the duration,
// exactly as on macOS, because this canvas draws its own.

import { drawMimoFace, drawMimoBackdrop, drawMimoBadge } from "../mimo/face";
import { MIMO_VARIANTS } from "../mimo/status";
import { State } from "../core/state";
import { resizeCanvas } from "../core/canvas";
import { codingProvider } from "../core/coding";
import { createMiniBot, miniNotificationLabel, pruneMiniBots } from "../mimo/minibots";
import { MIMO_PICKER_COLORS } from "../mimo/palette";
import { prefersReducedMotion } from "../core/motion";
import {icon} from "../views/icons";
import {Sound} from "../core/sound";
import {
  USC,
  eOut,
  fileIntakePose,
  lerp,
  progressAt,
  type UploadFrame,
} from "./sequence";

const FONT = 'system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif';

/** Mirrors the reference `rr()`: a rounded rect, radius clamped to the box. */
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rad);
}

function text(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  font: string,
  color: string,
  align: CanvasTextAlign = "left",
) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  // SwiftUI's .leading / .center / .trailing anchors are vertically centred.
  ctx.textBaseline = "middle";
  ctx.fillText(s, x, y);
}

export interface UploadCanvasActions {
  /** Primary button — hand the file to the chat. */
  ask(): void;
  shelf(): void;
  /** Secondary button. */
  cancel(): void;
}

export class UploadCanvas {
  /** Shared canvas choreography with accessible, visible file actions. */
  readonly el: HTMLElement;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private overlay: HTMLElement;
  private integrations: HTMLElement;
  private integrationKey = "";
  private contentInset = 0;
  private visible = false;
  private transfers: { animation: Animation; restore: () => void }[] = [];

  setVisible(value: boolean): void {
    if (this.visible === value) return;
    this.visible = value;
    this.transfers.forEach(({ animation, restore }) => { animation.cancel(); restore(); });
    this.transfers = [];
    if (prefersReducedMotion()) return;
    for (const [index, item] of [...this.integrations.children].entries()) {
      const id = (item as HTMLElement).dataset.integration;
      const source = document.querySelector<HTMLElement>(`#views .integration-tile[data-integration="${id}"] .mini`);
      const target = item.querySelector<HTMLElement>(".mini");
      if (!source || !target) continue;
      if (value && getComputedStyle(source).visibility !== "visible") continue;
      const from = source.getBoundingClientRect(), to = target.getBoundingClientRect();
      if (!from.width || !to.width) continue;
      const offset = `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.width / to.width})`;
      const animation = target.animate(value
        ? [{ transform: offset }, { transform: "none" }]
        : [{ transform: "none" }, { transform: offset }],
        { duration: 260, delay: Math.min(index, 4) * 18, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" });
      const previous = source.style.visibility;
      source.style.visibility = "hidden";
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        if (source.style.visibility === "hidden") source.style.visibility = previous;
      };
      this.transfers.push({ animation, restore });
      void animation.finished.catch(() => {}).finally(restore);
    }
  }
  private colors = {
    bg: "#0b0c0f", card: "#111318", ink: "#f3f4f6", dim: "#b1b4bc",
    green: "#79d5aa", green2: "#91debd", accent: "#9ab8f2", control: "rgba(255,255,255,.08)",
  };
  destroy(): void {
    this.transfers.forEach(({ animation, restore }) => { animation.cancel(); restore(); });
    this.transfers = [];
  }
  private greenRgb: readonly [number, number, number];
  private green2Rgb: readonly [number, number, number];
  private cardSheen: CanvasGradient | undefined;
  private materialDpr = 0;

  constructor(actions: UploadCanvasActions) {
    const css = getComputedStyle(document.documentElement);
    for (const [key, token] of Object.entries({ bg: "--bg", card: "--card", ink: "--ink", dim: "--dim",
      green: "--green", green2: "--green-2", accent: "--accent", control: "--control-fill" })) {
      const value = css.getPropertyValue(token).trim();
      if (value) this.colors[key as keyof typeof this.colors] = value;
    }
    // Canvas resolves computed CSS colors, including color-mix(), into sRGB.
    // Cache these channels once; the progress flash never parses a token per frame.
    const swatch = document.createElement("canvas");
    swatch.width = swatch.height = 1;
    const colorContext = swatch.getContext("2d", { willReadFrequently: true });
    const channels = (value: string): readonly [number, number, number] => {
      if (!colorContext) return [79, 178, 158];
      colorContext.clearRect(0, 0, 1, 1);
      colorContext.fillStyle = value;
      colorContext.fillRect(0, 0, 1, 1);
      const pixel = colorContext.getImageData(0, 0, 1, 1).data;
      return [pixel[0], pixel[1], pixel[2]];
    };
    this.greenRgb = channels(this.colors.green);
    this.green2Rgb = channels(this.colors.green2);
    this.canvas = document.createElement("canvas");
    this.canvas.id = "upload-canvas";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Drop a file for Mimo");

    const mk = (x: number, w: number, label: string, text: string, glyph:string|null, onclick: () => void,primary=false) => {
      const b = document.createElement("button");
      b.className = "upload-hit";
      b.type = "button";
      b.setAttribute("aria-label", label);
      b.classList.toggle("primary",primary);
      if(glyph)b.append(icon(glyph,14));b.append(document.createTextNode(text));
      b.style.left = `${x}px`;
      b.style.top = "113px";
      b.style.width = `${w}px`;
      b.style.height = "26px";
      b.addEventListener("click", ()=>{Sound.play("tick");onclick();});
      return b;
    };
    this.overlay = document.createElement("div");
    this.overlay.id = "upload-overlay";
    this.overlay.setAttribute("role","group");this.overlay.setAttribute("aria-label","Choose what to do with your file");
    this.overlay.append(mk(114,168,"Ask a question about this file","Ask a question",null,actions.ask,true),
      mk(290,132,"Put file on Drop Shelf","Drop Shelf",null,actions.shelf),mk(430,90,"Cancel file attachment","Cancel",null,actions.cancel));

    this.integrations = document.createElement("div");
    this.integrations.className = "upload-integrations";
    this.integrations.setAttribute("role", "list");
    this.integrations.setAttribute("aria-label", "Enabled integrations");
    this.integrations.hidden = true;

    this.el = document.createElement("div");
    this.el.id = "upload-layer";
    this.el.append(this.canvas, this.integrations, this.overlay);

    this.ctx = this.canvas.getContext("2d");
  }

  syncIntegrations(): void {
    const tasks = State.tasks.filter(task => task.isIntegration && !codingProvider(task)
      && State.settings.modules.developerIntegrations && State.settings.activeIntegrations.includes(task.id));
    const key = JSON.stringify(tasks.map(task => [task.id, task.name, miniNotificationLabel(task)]));
    if (key === this.integrationKey) return;
    this.integrationKey = key;
    const retained = [...this.integrations.children] as HTMLElement[];
    this.integrations.replaceChildren(...tasks.map((task, index) => {
      const item = retained.find(item => item.dataset.integration === task.id) ?? document.createElement("span");
      if (!item.firstChild) item.append(createMiniBot(task, 20, false, MIMO_PICKER_COLORS[task.id]));
      const status = miniNotificationLabel(task);
      item.className = "upload-integration mimo-stack-item";
      item.style.setProperty("--integration-color", MIMO_PICKER_COLORS[task.id] ?? task.color);
      item.dataset.integration = task.id;
      item.style.zIndex = String(tasks.length - index);
      item.setAttribute("role", "listitem");
      item.setAttribute("aria-label", task.name + (status ? ", " + status : ""));
      item.title = task.name + (status ? ", " + status : "");
      return item;
    }));
    this.integrations.hidden = tasks.length === 0;
    this.integrations.style.setProperty("--upload-stack-overlap", tasks.length > 5 ? "12px" : "7px");
    this.contentInset = tasks.length ? 52 : 0;
    pruneMiniBots();
  }

  /** `wallTime` in seconds drives the marching dashes, like the macOS timeline. */
  draw(f: UploadFrame, wallTime: number) {
    const dpr = resizeCanvas(this.canvas, USC.W, USC.ISL_H);
    const ctx = this.ctx;
    if (!ctx) return;
    if (dpr !== this.materialDpr) {
      this.materialDpr = dpr;
      this.cardSheen = undefined;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, USC.W, USC.ISL_H);

    this.drawScene(ctx, f, wallTime);
    const multiple = State.droppedFiles.length > 1;
    const label = f.fileVisible ? f.dropped ? "Mimo is eating your files" : "Drop up to 5 files for Mimo"
      : f.chooseAlpha > 0 ? multiple ? "Files ready. Ask Mimo about them together." : "File ready. Ask Mimo or put it on the Drop Shelf."
      : f.check > 0 ? "Files copied" : "Copying your files";
    if (this.canvas.getAttribute("aria-label") !== label) this.canvas.setAttribute("aria-label", label);

    // The buttons only exist once the choose card has faded in.
    this.overlay.style.display = f.chooseAlpha > 0.5 ? "block" : "none";
    this.overlay.querySelector<HTMLButtonElement>('[aria-label="Put file on Drop Shelf"]')!.hidden = multiple;
    const ask = this.overlay.querySelector<HTMLButtonElement>(".primary")!;
    ask.setAttribute("aria-label", multiple ? `Ask a question about these ${State.droppedFiles.length} files` : "Ask a question about this file");
    this.overlay.querySelector<HTMLButtonElement>('[aria-label="Cancel file attachment"]')!.style.left = multiple ? "290px" : "430px";
  }

  // ── Scene ─────────────────────────────────────────────────────────────────

  private drawScene(ctx: CanvasRenderingContext2D, f: UploadFrame, wallTime: number) {
    // Island background.
    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, USC.W, USC.ISL_H);

    // Reserve the right service rail while preserving the intake's size and
    // the exact release point. Only the card's available width changes.
    ctx.save();
    const cardWidth = USC.CARD_W - this.contentInset;
    const maxX = USC.CARD_X + cardWidth - f.d / 2 - 12;
    const dx = Math.min(maxX, f.x) - f.x;
    if (dx) f = { ...f, x: f.x + dx, mouthRect: { ...f.mouthRect, x: f.mouthRect.x + dx } };

    // Card.
    ctx.save();
    rr(ctx, USC.CARD_X, USC.CARD_Y, cardWidth, USC.CARD_H, USC.CARD_R);
    ctx.clip();
    ctx.fillStyle = this.colors.card;
    ctx.fillRect(USC.CARD_X, USC.CARD_Y, cardWidth, USC.CARD_H);
    if (!this.cardSheen) {
      this.cardSheen = ctx.createLinearGradient(USC.CARD_X, USC.CARD_Y, USC.CARD_W, USC.ISL_H);
      this.cardSheen.addColorStop(0, "rgba(238,243,255,.028)");
      this.cardSheen.addColorStop(.58, "rgba(238,243,255,0)");
      this.cardSheen.addColorStop(1, "rgba(255,255,255,.008)");
    }
    ctx.fillStyle = this.cardSheen;
    ctx.fillRect(USC.CARD_X, USC.CARD_Y, cardWidth, USC.CARD_H);

    // Green glow, fanning up from the bottom edge of the card.
    if (f.greenWash > 0) {
      const gx = USC.CARD_X + cardWidth / 2;
      const gy = USC.CARD_Y + USC.CARD_H;
      const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, USC.CARD_H * 1.5);
      g.addColorStop(0, `rgba(${this.greenRgb.join(",")},${f.greenWash * 0.9})`);
      g.addColorStop(0.55, `rgba(${this.greenRgb.join(",")},${f.greenWash * 0.3})`);
      g.addColorStop(1, `rgba(${this.greenRgb.join(",")},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(USC.CARD_X, USC.CARD_Y, cardWidth, USC.CARD_H);
    }
    ctx.restore();

    // Dashed border, marching left to right at ~20 pt/s.
    if (f.zoneAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = f.zoneAlpha;
      ctx.strokeStyle = f.zoneOver ? `rgba(${this.greenRgb.join(",")},.55)` : "rgba(255,255,255,0.14)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -wallTime * 20;
      rr(
        ctx,
        USC.CARD_X + 0.75,
        USC.CARD_Y + 0.75,
        cardWidth - 1.5,
        USC.CARD_H - 1.5,
        USC.CARD_R - 0.5,
      );
      ctx.stroke();
      ctx.restore();
    }

    if (f.zoneAlpha > 0 && f.textAlpha > 0) this.drawDropText(ctx, f);
    if (f.barAlpha > 0 || f.barReveal > 0) this.drawProgressBar(ctx, f);
    if (f.chooseAlpha > 0) this.drawChoose(ctx, f);

    this.drawMimo(ctx, f);
    if (f.fileVisible) this.drawFile(ctx, f);
    ctx.restore();
  }

  // ── Drop zone text and chips ──────────────────────────────────────────────

  private drawDropText(ctx: CanvasRenderingContext2D, f: UploadFrame) {
    ctx.save();
    ctx.globalAlpha = f.textAlpha;
    text(ctx, "Drop up to 5 files here", USC.TEXT_X, USC.TEXT_Y - 4, `500 13px ${FONT}`, this.colors.ink);

    let cx = USC.TEXT_X;
    for (const chip of ["PDF", "Images", "Code", "Docs"]) {
      // The macOS port measures chips the same rough way, so the row lines up.
      const w = chip.length * 6.5 + 16;
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      rr(ctx, cx, USC.TEXT_Y + 9, w, 18, 9);
      ctx.fill();
      text(ctx, chip, cx + 8, USC.TEXT_Y + 18, `500 11px ${FONT}`, this.colors.dim);
      cx += w + 6;
    }
    ctx.restore();
  }

  // ── Progress bar ──────────────────────────────────────────────────────────

  private drawProgressBar(ctx: CanvasRenderingContext2D, f: UploadFrame) {
    ctx.save();
    ctx.globalAlpha = Math.max(f.barAlpha, 0.001);

    const x0 = USC.BAR_X0;
    const x1 = USC.BAR_X1;
    const by = USC.BAR_Y;
    const barLen = (x1 - x0) * f.barReveal;

    const name = State.droppedFileLabel ?? State.chatAttachmentLoading ?? "file";
    text(ctx, `Uploading ${name}`, x0, by - 30, `500 12.5px ${FONT}`, this.colors.dim);

    if (f.check > 0) {
      ctx.save();
      ctx.translate(x1 - 8, by - 30);
      ctx.scale(f.check, f.check);
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.fillStyle = this.colors.green;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-3.6, 0.2);
      ctx.lineTo(-1, 2.8);
      ctx.lineTo(3.8, -2.6);
      ctx.strokeStyle = "#07130E";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();
    } else {
      text(
        ctx,
        `${Math.round(f.progress * 100)} %`,
        x1,
        by - 30,
        `500 12.5px ${FONT}`,
        this.colors.dim,
        "right",
      );
    }

    // Track.
    if (barLen > 0) {
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      rr(ctx, x0, by - 3, barLen, 6, 3);
      ctx.fill();
    }

    // Fill.
    const fx = lerp(x0, x1, f.progress);
    if (fx > x0 + 1) {
      const flashGreen = `rgb(${this.greenRgb.map((value, i) => Math.round(lerp(value, this.green2Rgb[i], f.flash))).join(",")})`;
      const g = ctx.createLinearGradient(x0, 0, fx, 0);
      g.addColorStop(0, this.colors.green);
      g.addColorStop(1, flashGreen);
      ctx.fillStyle = g;
      rr(ctx, x0, by - 3, fx - x0, 6, 3);
      ctx.fill();
    }

    // Glow trail, its length driven by how fast the bar is moving.
    if (f.progress > 0.01 && f.progress < 1) {
      const v =
        (progressAt(f.t + 0.01, USC.T_PROG_START, f.progEnd) -
          progressAt(f.t, USC.T_PROG_START, f.progEnd)) /
        0.01;
      const tl = Math.max(8, Math.min(34, 8 + v * 40));
      const g = ctx.createLinearGradient(fx - tl, 0, fx, 0);
      g.addColorStop(0, `rgba(${this.greenRgb.join(",")},0)`);
      g.addColorStop(1, `rgba(${this.green2Rgb.join(",")},.45)`);
      ctx.save();
      ctx.filter = "blur(3px)";
      ctx.fillStyle = g;
      rr(ctx, fx - tl, by - 4, tl, 8, 4);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  // ── Choose card ───────────────────────────────────────────────────────────

  private drawChoose(ctx: CanvasRenderingContext2D, f: UploadFrame) {
    ctx.save();
    ctx.globalAlpha = f.chooseAlpha;
    ctx.translate(0, (1 - f.chooseAlpha) * 4);

    let name = State.droppedFileLabel ?? State.chatAttachmentLoading ?? "Your file";
    ctx.font=`600 14px ${FONT}`;
    while(name.length>1&&ctx.measureText(name).width>390)name=name.slice(0,-2)+"\u2026";
    const multiple = State.droppedFiles.length > 1;
    text(ctx,`${name} ${multiple ? "are" : "is"} ready.`,114,80,`600 14px ${FONT}`,this.colors.ink);
    text(ctx,multiple ? "Ask Mimo about them together." : "What do you want to do with it?",114,100,`400 12.5px ${FONT}`,this.colors.dim);
    ctx.restore();
  }

  // ── Mimo ─────────────────────────────────────────────────────────────────

  private drawMimo(ctx: CanvasRenderingContext2D, f: UploadFrame) {
    const R = f.d / 2 / 1.14;
    const ready = f.check > 0 || f.chooseAlpha > 0;
    const loading = !ready && (f.barAlpha > 0 || f.suck > 0);
    const variant = MIMO_VARIANTS[ready ? "connected" : loading ? "loading" : "idle"];
    ctx.save();
    ctx.translate(f.x, f.y + f.hop);
    drawMimoBackdrop(ctx, R);
    ctx.rotate(Math.max(-0.06, Math.min(0.06, f.tilt)));
    ctx.scale(f.sx, f.sy);
    drawMimoFace(ctx, {
      radius: R, eye: ready ? variant.eye : f.eye === "content" ? "happy" : f.eye,
      lookX: f.lookX * .62, lookY: f.lookY * .5, mouthOpening: f.mouth * Math.min(1, f.morph),
      intakeMorph: ready ? 0 : f.morph,
    });
    if (ready || f.morph < .05)
      drawMimoBadge(ctx, { radius: R, kind: variant.icon, color: variant.color, loading, time: f.t });
    ctx.restore();
  }

  private drawFile(ctx: CanvasRenderingContext2D, f: UploadFrame) {
    const file = fileIntakePose(f);

    if (f.suck <= 0) {
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.translate(file.x, file.top + 21 * file.sy);
      ctx.rotate(file.rotation);
      drawDoc(ctx, 0, 0, file.sx, file.sy, this.colors.accent);
      ctx.restore();
      return;
    }

    const m = f.mouthRect;
    const W0 = 34;
    const H0 = 42;
    const topY = file.top;
    const hs = file.sy;
    const Hh = H0 * hs;
    const sc = file.sx;
    const q = eOut(f.suck);
    const fCx = file.x;
    const wob = file.rotation;
    const clipY = file.clipY;

    // The sheet is drawn as 28 horizontal strips, each narrowed towards the
    // mouth, so the page appears to funnel in. Everything below the mouth line
    // is clipped away — that is what makes it look swallowed.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, USC.W, clipY);
    ctx.clip();

    for (let i = 0; i < 28; i++) {
      const v0 = i / 28;
      const wsc = lerp(1, lerp(0.92, (0.22 * m.w) / W0, Math.pow(v0, 1.2)), q) * sc;
      const yy = topY + v0 * Hh;
      const hh = Hh / 28 + 0.6;

      ctx.save();
      ctx.translate(fCx, yy);
      ctx.rotate(wob);
      ctx.beginPath();
      ctx.rect((-W0 * wsc) / 2, 0, W0 * wsc, hh);
      ctx.clip();
      ctx.translate(-fCx, -yy);
      drawDoc(ctx, fCx, topY + Hh / 2, wsc, hs, this.colors.accent);
      ctx.restore();
    }
    ctx.restore();

    // Green crumbs pulled in with the file.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.6;
      const k = Math.max(0, Math.min(1, (f.suck - i * 0.08) / 0.7));
      if (k <= 0 || k >= 1) continue;
      const sx0 = file.x + Math.cos(a) * 18;
      const sy0 = topY - 4 - Math.abs(Math.sin(a)) * 14;
      const ex = m.x + m.w / 2;
      const ey = clipY;
      const kk = Math.pow(k, 0.7);
      const px = lerp(sx0, ex, kk);
      const py = lerp(sy0, ey, kk) - Math.sin(Math.PI * k) * 6;
      const rad = 2.2 * (1 - k * 0.5);
      ctx.beginPath();
      ctx.arc(px, py, rad, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${this.greenRgb.join(",")},${(1 - k) * .65})`;
      ctx.fill();
    }
  }
}

// ── Eye shapes ──────────────────────────────────────────────────────────────

function drawDoc(ctx: CanvasRenderingContext2D, cx: number, cy: number, wsc: number, hsc: number, accent: string) {
  const w = 34 * wsc;
  const h = 42 * hsc;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const fold = 8 * Math.min(wsc, hsc);

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.beginPath();
  ctx.moveTo(x + 2, y);
  ctx.lineTo(x + w - fold, y);
  ctx.lineTo(x + w, y + fold);
  ctx.lineTo(x + w, y + h - 2);
  ctx.quadraticCurveTo(x + w, y + h, x + w - 2, y + h);
  ctx.lineTo(x + 2, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - 2);
  ctx.lineTo(x, y + 2);
  ctx.quadraticCurveTo(x, y, x + 2, y);
  ctx.closePath();
  ctx.fillStyle = "#F4F4F6";
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(x + w - fold, y);
  ctx.lineTo(x + w - fold, y + fold);
  ctx.lineTo(x + w, y + fold);
  ctx.closePath();
  ctx.fillStyle = "#D5D6DB";
  ctx.fill();

  ctx.fillStyle = accent;
  rr(ctx, x + w * 0.18, y + h * 0.58, w * 0.64, h * 0.16, 2);
  ctx.fill();
}
