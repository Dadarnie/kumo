// SPDX-License-Identifier: MIT
// Mimo's state, tween and particle engine with a shared earless silver renderer.
// Existing events and sound cues remain compatible; movement is adapted to Mimo.

import { Ease, type EaseFn } from "../core/anim";
import { Lifetime } from "../core/lifetime";
import { drawMimoFace, drawMimoBackdrop, drawMimoBadge, drawMimoExpressionDetail } from "./face";
import { MIMO_EXPRESSIONS, EXPRESSION_PRIORITY, ExpressionTransition, mimoDanceMotion, type MimoExpressionName } from "./expressions";
import { mimoAppStatus, MIMO_VARIANTS, type MimoStatus, type MimoBadgeIcon } from "./status";
import { MIMO_PALETTE } from "./palette";
import { MIMO_APPS, type MimoAppIcon } from "./brands";
import { Sound } from "../core/sound";
import type { BotEmoteName, BotStateName } from "../core/layout";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EyeShape =
  | "pill" | "wide" | "dot" | "line" | "flat" | "happy" | "closed"
  | "spiral" | "heart" | "star" | "tired" | "wink" | "cup" | "stern" | "worried" | "focus";

export type BadgeKind = MimoBadgeIcon | MimoAppIcon;

export interface Badge {
  kind: BadgeKind;
  color: RGB;
}

export type RGB = readonly [number, number, number]; // components 0…1

export type TweenKey = readonly [target: number, durationMs: number, ease: EaseFn];

interface Tween {
  prop: PropKey;
  keys: TweenKey[];
  index: number;
  from: number;
  startMs: number;
  onComplete?: () => void;
}

type PropKey =
  | "yaw" | "pitch" | "roll" | "tilt" | "open" | "sx" | "sy"
  | "oy" | "ox" | "morph" | "hands" | "es" | "badgeS" | "orbit" | "winkAmount";

interface BotStateCfg {
  eye: EyeShape;
  bounces: boolean;
  scans: boolean;
  sweat: boolean;
  look: readonly [number, number] | null;
  tilt: number;
}

interface Particle {
  type: "heart" | "sweat";
  x: number; y: number; vx: number; vy: number;
  age: number; life: number; rot: number; size: number;
  expression: MimoExpressionName;
}

// ── Constants (MimoConst / PISTES.mochi) ─────────────────────────────────────

const base = {
  bounces: false, scans: false, sweat: false,
  look: null, tilt: 0,
};

export const BOT_STATES: Record<BotStateName, BotStateCfg> = {
  idle: { ...base, eye: "pill" },
  working: { ...base, eye: "pill", look: [-0.2, 0] },
  thinking: { ...base, eye: "pill", look: [-0.12, -0.08] },
  searching: { ...base, eye: "pill", scans: true },
  approval: { ...base, eye: "pill" },
  question: { ...base, eye: "pill" },
  error: { ...base, eye: "pill" },
  finished: { ...base, eye: "happy" },
  ratelimit: { ...base, eye: "tired" },
  dizzy: { ...base, eye: "pill" },
};

/** State → sound, as in BotStateCfg.sound. */
export const STATE_SOUND: Partial<Record<BotStateName, string>> = {
  working: "work", thinking: "think", searching: "search", approval: "approval",
  question: "question", error: "error", ratelimit: "rate",
  dizzy: "dizzy",
};

const EMOTE_EYE: Record<BotEmoteName, EyeShape> = {
  love: "heart", surprised: "wide", proud: "pill", wink: "wink",
  yawn: "closed", happy: "happy", annoyed: "stern",
};
const ATTENTION_STATES: ReadonlySet<BotStateName> = new Set(["approval", "question", "error", "ratelimit", "finished", "dizzy"]);
const EYE_EXPRESSIONS: Partial<Record<EyeShape, MimoExpressionName>> = {
  heart: "love", star: "proud", wink: "wink", tired: "yawn", closed: "yawn",
  line: "annoyed", stern: "annoyed", happy: "happy", spiral: "dizzy",
};

// ── Small helpers ─────────────────────────────────────────────────────────────

const now = () => performance.now() / 1000;

export function hexToRGB(hex: string): RGB {
  const h = hex.replace("#", "");
  const v = parseInt(h, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const rgba = (c: RGB, a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
const WHITE_RGB = hexToRGB(MIMO_PALETTE.body);

function heartPath(x: CanvasRenderingContext2D, s: number) {
  x.beginPath();
  x.moveTo(0, s * 0.38);
  x.bezierCurveTo(-s * 1.05, -s * 0.15, -s * 0.5, -s * 0.95, 0, -s * 0.38);
  x.bezierCurveTo(s * 0.5, -s * 0.95, s * 1.05, -s * 0.15, 0, s * 0.38);
  x.closePath();
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class BotEngine {
  private voice: "ready" | "listening" | "waiting" | "speaking" | null = null;
  get voiceMode() { return this.voice; }
  set voiceMode(value: "ready" | "listening" | "waiting" | "speaking" | null) {
    if (this.voice === value) return;
    this.voice = value;this.syncStatusBadge();this.onWake?.();
  }
  isMini = false;
  orbit = 0;
  tile = false;
  backdrop = true;
  showBadge = true;
  status: MimoStatus = "idle";
  private presentedStatus: MimoStatus | null = null;
  private menuBadge = false;
  private integrationId: string | null = null;
  private validationUntil = 0;
  private emoteToken = 0;
  private expressionContext: MimoExpressionName | null = null;
  private reaction: MimoExpressionName | null = null;
  private musicStarted: number | null = null;
  private expressionTransition = new ExpressionTransition();
  private expressionStarted = 0;
  private presentedExpression: MimoExpressionName = "idle";
  get expressionPose() { return this.expressionTransition.pose; }
  get currentExpression(): MimoExpressionName {
    if (ATTENTION_STATES.has(this.state)) return this.state;
    if (this.status === "error") return "error";
    let expression: MimoExpressionName = this.state !== "idle"
      ? this.state === "working" && this.expressionContext === "focus" ? "focus" : this.state
      : this.status === "loading" ? "thinking" : "idle";
    // Ready is an idle baseline; actual completion has the catalog's priority.
    let priority = this.state === "idle" && this.status === "connected" ? 10 : EXPRESSION_PRIORITY[expression];
    if (this.expressionContext && EXPRESSION_PRIORITY[this.expressionContext] > priority) {
      expression = this.expressionContext; priority = EXPRESSION_PRIORITY[expression];
    }
    // A long, composed whistle gives way to four seconds of dancing. This
    // clock exists only for confirmed playback in the foreground tab.
    if (expression === "music" && this.musicStarted !== null
      && (now() - this.musicStarted) % 18 >= 14) {
      expression = "dancing"; priority = EXPRESSION_PRIORITY.dancing;
    }
    if (this.eyeOverride && now() <= this.eyeOverrideUntil) {
      const reaction = this.reaction ?? EYE_EXPRESSIONS[this.eyeOverride] ?? "surprised";
      if (EXPRESSION_PRIORITY[reaction] > priority || (reaction === "annoyed" && this.workPokeAllowed)) expression = reaction;
    }
    return expression;
  }
  setExpressionContext(expression: MimoExpressionName | null): void {
    if (expression === this.expressionContext) return;
    if (this.expressionContext && !expression) {
      this.nextBlink = now() + 4; this.nextIdle = now() + 7;
      this.idleLook.until = 0;
    }
    this.expressionContext = expression;
    this.musicStarted = expression === "music" ? now() : null;
    if ((this.reaction === "dancing" && expression !== "music")
      || (this.reaction && expression && EXPRESSION_PRIORITY[expression] > EXPRESSION_PRIORITY[this.reaction]
        && !(this.reaction === "annoyed" && this.workPokeAllowed))) {
      this.cancelReaction();
    }
    this.syncStatusBadge(); this.onWake?.();
  }
  /** Temporary gestures belong to the tab that requested them. */
  clearExpressionReaction(): void {
    this.patTimes = [];
    if (!this.reaction && !this.eyeOverride) return;
    this.cancelReaction(); this.syncStatusBadge(); this.onWake?.();
  }
  private get musicMotionTime(): number | null {
    return this.expressionContext === "music" && this.musicStarted !== null
      && (this.currentExpression === "music" || this.currentExpression === "dancing")
      ? now() - this.musicStarted : null;
  }
  triggerExpression(expression: MimoExpressionName, duration = 1.8): void {
    if (this.attentionLocked || (this.expressionContext && EXPRESSION_PRIORITY[this.expressionContext] > EXPRESSION_PRIORITY[expression])) return;
    this.cancelReaction();
    this.emoteToken++;
    this.reaction = expression;
    this.eyeOverride = MIMO_EXPRESSIONS[expression].eye;
    this.eyeOverrideUntil = now() + Math.max(.2, Math.min(5, duration));
    if (expression === "confused") this.shakeOffConfusion();
    this.syncStatusBadge(); this.onWake?.();
  }
  private get targetFaceColor(): RGB {
    return this.bodyColor ?? WHITE_RGB;
  }
  bodyColor: RGB | null = null;
  private col: [number, number, number] = [...WHITE_RGB];
  get faceColor(): RGB { return this.col; }
  get auraColor(): RGB { return this.showBadge && this.badge ? this.badge.color : this.col; }

  /** Settled pose for static previews; live companions always animate. */
  settlePose(): void {
    this.expressionTransition.settle(this.currentEye, this.currentExpression);
    this.expressionStarted = now() - .8;
    const color = this.targetFaceColor;
    for (let i = 0; i < 3; i++) this.col[i] = color[i];
  }

  set badgeMode(value: "contextual" | "menu") {
    const next = value === "menu";
    if (this.menuBadge === next) return;
    this.menuBadge = next; this.syncStatusBadge();
  }
  setIntegration(id: string | null) {
    if (id === this.integrationId) return;
    this.integrationId = id; this.validationUntil = 0;
    this.syncStatusBadge();
  }

  private syncStatusBadge() {
    if (this.voiceMode) {
      this.setBadge({ kind: this.voiceMode === "speaking" ? "speaker" : this.voiceMode === "waiting" ? "dots" : "microphone",
        color: hexToRGB(this.voiceMode === "speaking" ? "#4fb29e" : this.voiceMode === "waiting" ? "#8358e9" : "#2da4f9") });
      return;
    }
    const app = this.integrationId ? MIMO_APPS[this.integrationId] : undefined;
    const normal = this.status === "idle" || this.status === "connected";
    const validating = this.status === "connected" && (this.state === "finished" || now() < this.validationUntil);
    const variant = MIMO_VARIANTS[this.status];
    const expression = MIMO_EXPRESSIONS[this.currentExpression];
    if (this.state !== "idle" || this.expressionContext) {
      if (expression.badge || ["searching", "question"].includes(this.currentExpression)) {
        this.setBadge(expression.badge ? { kind: expression.badge, color: hexToRGB(expression.accent) } : null);
        return;
      }
    }
    this.setBadge(normal && !this.menuBadge && !validating ? null
      : normal && app && !validating ? { kind: app.icon, color: hexToRGB(app.color) }
      : { kind: variant.icon, color: hexToRGB(variant.color) });
  }

  get currentEye(): EyeShape {
    return MIMO_EXPRESSIONS[this.currentExpression].eye;
  }
  private get attentionLocked(): boolean {
    return this.state !== "idle" || this.status === "error" || this.status === "loading";
  }
  private cancelReaction(): void {
    this.emoteToken++;
    this.reaction = null; this.eyeOverride = null; this.eyeOverrideUntil = 0;
    this.patTimes = [];
    this.particles = [];
    this.interruptGreet();
    this.orbit = 0;
    this.winkAmount = 0;
    this.ox = 0;
    this.open = 1;
    for (const prop of ["tilt", "ox", "oy", "sx", "sy", "es", "orbit", "winkAmount", "open"] as const) {
      this.tweens.delete(prop); this.locks.delete(prop);
    }
  }

  // Animated state (BotEngine `s`)
  yaw = 0; pitch = 0; roll = 0; tilt = 0; open = 1;
  sx = 1; sy = 1; oy = 0; ox = 0;
  morph = 0; hands = 0; es = 1; badgeS = 0;
  winkAmount = 0;

  // Targets
  tgYaw = 0; tgPitch = 0; tgTilt = 0; tgSy = 1; tgSx = 1; tgEs = 1;

  /** Extra canvas height above the body so hearts can fly out without clipping. */
  particleOverhang = 0;

  // Mouth spring (fraction of R)
  slotH = 0; slotHTarget = 0; slotHVel = 0; isChewing = false;

  state: BotStateName = "idle";
  cfg: BotStateCfg = BOT_STATES.idle;

  eyeOverride: EyeShape | null = null;
  eyeOverrideUntil = 0;
  permanentEye: EyeShape | null = null;
  permanentEmote: BotEmoteName | null = null;
  miniNextBehavior = 0;

  badge: Badge | null = null;
  private badgeKey = "none";
  private badgeExpression: MimoExpressionName = "idle";
  private badgeToken = 0;

  private tweens = new Map<PropKey, Tween>();
  private activeTweens: Tween[] = [];
  private lifetime = new Lifetime();
  private locks = new Set<PropKey>();
  private particles: Particle[] = [];

  lookX = 0;
  lookY = 0;

  lastTime = now();
  private t0 = now() - Math.random() * 5;
  private nextBlink = now() + 3.5 + Math.random() * 4;
  private nextMiniWink = now() + 8 + Math.random() * 10;
  private nextIdle = now() + 6 + Math.random() * 6;
  private lastIdle = -1;
  private idleLook = { x: 0, y: 0, until: 0 };
  waveUntil = 0;
  waveStart = 0;
  private lastAmbient = 0;
  private slapTimes: number[] = [];
  private patTimes: number[] = [];
  private greetToken = 0;
  private miniLookTarget = { x: 0, y: 0 };
  private miniLookNextTime = 0;

  /** Fired when three slaps land inside 1.7 s (→ dizzy + confused view). */
  onDizzy: (() => void) | null = null;
  onWake: (() => void) | null = null;

  // ── Public API ──────────────────────────────────────────────────────────────

  destroy(): void {
    this.lifetime.destroy();
    this.onWake = this.onDizzy = null;
    this.particles = [];
    this.tweens.clear();
    this.activeTweens.length = 0;
    this.locks.clear();
    this.expressionTransition.settle("pill");
  }

  setState(next: BotStateName, force = false) {
    if (this.state === next && !force) return;
    this.state = next;
    this.cfg = BOT_STATES[next];
    this.cancelReaction();
    if (!this.locks.has("tilt")) this.tgTilt = this.cfg.tilt;
    this.setStatus(mimoAppStatus(next));
    this.syncStatusBadge();

    // The reference rolls the ordinary eyes over the sphere, leaving it upright.
    if (next === "dizzy") this.shakeOffConfusion();
  }

  setStatus(next: MimoStatus) {
    if (this.presentedStatus === next) return;
    this.validationUntil = this.status === "loading" && next === "connected" ? now() + 1.8 : 0;
    this.presentedStatus = this.status = next;
    this.syncStatusBadge();
    if (next === "error") {
      this.cancelReaction();
    }
    this.onWake?.();
  }

  setBadge(b: Badge | null) {
    const expression = this.currentExpression;
    const key = `${expression}:${b ? `${b.kind}-${b.color.join(",")}` : "none"}`;
    if (key === this.badgeKey) return;
    this.badgeKey = key;
    const tok = ++this.badgeToken;
    if (!this.showBadge) {
      this.badge = b; this.badgeExpression = expression; this.badgeS = b ? 1 : 0; this.onWake?.(); return;
    }
    this.anim("badgeS", [[0, 90, Ease.inOut]]);
    this.lifetime.after(() => {
      if (tok !== this.badgeToken) return;
      this.badge = b;
      this.badgeExpression = expression;
      if (b) this.anim("badgeS", [[1, 280, Ease.out]]);
    }, 100);
  }

  blink(slow = false) {
    if (this.locks.has("open")) return;
    this.anim("open", [[0.06, slow ? 180 : 70, Ease.inOut], [1, slow ? 280 : 130, Ease.out]]);
  }

  wink(): void {
    if (!this.isMini || ATTENTION_STATES.has(this.state) || this.status === "error"
      || !["pill", "wide", "dot", "focus"].includes(this.currentEye) || this.eyeOverride) return;
    this.anim("winkAmount", [[1, 110, Ease.inOut], [1, 100, Ease.inOut], [0, 210, Ease.out]]);
  }

  squash() {
    this.anim("sy", [[0.78, 70, Ease.out], [1.1, 130, Ease.out], [1, 170, Ease.inOut]]);
    this.anim("sx", [[1.16, 70, Ease.out], [0.95, 130, Ease.out], [1, 170, Ease.inOut]]);
  }

  /** Mailbox swallow — opens the slot, chews, then closes. */
  gulp() {
    this.slotHTarget = 0.42;
    this.lifetime.after(() => {
      this.slotHTarget = 0;
      this.isChewing = true;
      this.onWake?.();
      this.lifetime.after(() => { this.isChewing = false; this.onWake?.(); }, 800);
    }, 460);
    this.anim("sy", [[0.78, 80, Ease.out], [1.18, 130, Ease.out], [1, 220, Ease.back]]);
    this.anim("sx", [[1.28, 80, Ease.out], [0.92, 130, Ease.out], [1, 220, Ease.back]]);
    this.blink();
  }

  get canPat(): boolean {
    return !this.attentionLocked && (!this.expressionContext || EXPRESSION_PRIORITY[this.expressionContext] <= 30);
  }
  /** Intentional VS Code pokes may briefly override a work pose. */
  allowWorkPokes = false;
  private get workPokeAllowed(): boolean {
    return !this.isMini && this.allowWorkPokes && ["working", "thinking", "searching", "finished"].includes(this.state)
      && this.status !== "error";
  }
  get canPoke(): boolean {
    return !this.attentionLocked || this.workPokeAllowed;
  }

  /** Three gentle pats within three seconds earn a little affection. */
  pat(): boolean {
    if (!this.canPat) return false;
    const t = now();
    this.patTimes = this.patTimes.filter(time => t - time < 3);
    this.patTimes.push(t);
    if (this.patTimes.length >= 3) {
      this.patTimes = [];
      this.triggerEmote("love", 2.4); Sound.play("love");
      return true;
    } else {
      this.anim("tilt", [[-.045, 80, Ease.out], [0, 220, Ease.inOut]]);
    }
    return false;
  }

  slap(direction = 1) {
    if (!this.canPoke) return;
    this.interruptGreet();
    Sound.play("slap");
    const t = now();
    this.slapTimes = this.slapTimes.filter((s) => t - s < 1.7);
    this.slapTimes.push(t);
    if (this.slapTimes.length >= 3) {
      this.slapTimes = [];
      this.onDizzy?.();
    } else {
      this.triggerEmote("annoyed", .8, false);
      this.nudge(direction);
    }
  }

  private nudge(direction: number): void {
    const away = direction < 0 ? -1 : 1;
    this.anim("ox", [[away * .14, 75, Ease.out], [-away * .02, 100, Ease.out], [0, 220, Ease.out]]);
    this.anim("oy", [[.035, 75, Ease.out], [0, 300, Ease.out]]);
  }

  doRoll(durationMs: number, turns: number) {
    this.orbit = 0;
    // Original face-roll choreography; the spherical body stays upright.
    this.anim("orbit", [[Math.PI * 2 * turns, durationMs, Ease.inOut]], () => { this.orbit = 0; });
  }

  private shakeOffConfusion(): void {
    this.doRoll(650, 2);
    const shake = [-.14, .14, -.14, .14, -.13, .13, -.12, .12, -.1, .1, -.07, .05];
    this.anim("tilt", [[0, 650, Ease.inOut],
      ...shake.map((value, index): [number, number, EaseFn] => [value, index === 0 ? 40 : 50, Ease.inOut]),
      [0, 220, Ease.out]]);
    this.anim("ox", [[0, 650, Ease.inOut],
      ...shake.map((value, index): [number, number, EaseFn] => [value * .5, index === 0 ? 40 : 50, Ease.inOut]),
      [0, 220, Ease.out]]);
    // A crisp lens reset and tiny servo nod make the recovery feel intentional.
    const resetAt = 650 + 40 + (shake.length - 1) * 50;
    this.anim("open", [[1, resetAt, Ease.inOut], [.045, 70, Ease.inOut],
      [.045, 70, Ease.inOut], [1, 150, Ease.out]]);
    this.anim("oy", [[0, resetAt, Ease.inOut], [.035, 80, Ease.inOut], [0, 200, Ease.out]]);
  }

  /** A greeting retains the authored wave without a generic body bob. */
  greet() {
    if (this.attentionLocked) return;
    this.triggerExpression("greeting", 2);
    Sound.play("greet");
  }

  interruptGreet() {
    this.greetToken++;
    this.waveUntil = 0;
    this.waveStart = 0;
    this.hands = 0;
  }

  setPermanentEmote(emote: BotEmoteName | null) {
    this.reaction = null;
    this.permanentEmote = emote;
    if (emote === "wink") {
      this.miniNextBehavior = now() + 0.8 + Math.random() * 1.7;
      return;
    }
    this.permanentEye = emote ? EMOTE_EYE[emote] : null;
    if (this.permanentEye) {
      this.eyeOverride = this.permanentEye;
      this.eyeOverrideUntil = Number.POSITIVE_INFINITY;
    } else if (this.eyeOverrideUntil === Number.POSITIVE_INFINITY) {
      this.eyeOverride = null;
      this.eyeOverrideUntil = 0;
    }
    this.miniNextBehavior = now() + 0.8 + Math.random() * 1.7;
  }

  triggerEmote(emote: BotEmoteName, duration = 1.8, audible = true) {
    if (!(emote === "annoyed" && this.workPokeAllowed) && (this.attentionLocked
      || (this.expressionContext && EXPRESSION_PRIORITY[this.expressionContext] > EXPRESSION_PRIORITY[emote]))) return;
    this.cancelReaction();
    this.onWake?.();
    const t = now();
    const token = ++this.emoteToken;
    this.reaction = emote;
    this.eyeOverride = EMOTE_EYE[emote];
    this.eyeOverrideUntil = t + duration;

    if (emote === "annoyed") {
      this.eyeOverrideUntil = t + .8;
      if (audible) this.lifetime.after(() => { if (token === this.emoteToken) Sound.play("annoyed"); }, 60);
    }
  }

  emit(type: Particle["type"], count: number) {
    this.onWake?.();
    for (let i = 0; i < Math.min(count, 3); i++) {
      this.particles.push({
        type,
        x: (Math.random() - 0.5) * 0.9,
        y: -0.7 - Math.random() * 0.2,
        vx: (Math.random() - 0.5) * 0.35,
        vy: -(0.45 + Math.random() * 0.35),
        age: -i * 0.14,
        life: 1.3 + Math.random() * 0.5,
        rot: Math.random() * Math.PI * 2,
        size: 0.15 + Math.random() * 0.08,
        expression: this.currentExpression,
      });
    }
  }

  animateMorph(target: number, durationMs?: number) {
    const dur = durationMs ?? (target > 0.5 ? 550 : 650);
    this.anim("morph", [[target, dur, Ease.inOut]]);
  }

  resetMorph() {
    this.tweens.delete("morph");
    this.locks.delete("morph");
    this.morph = 0;
  }

  /** True while anything is still moving — lets the island stop its RAF loop. */
  get busy(): boolean {
    const color = this.targetFaceColor;
    return (
      this.tweens.size > 0 || (this.voiceMode !== null && this.voiceMode !== "ready") ||
      this.musicMotionTime !== null ||
      this.expressionTransition.active || (this.expressionPose.expression !== "idle" && now() - this.expressionStarted < (this.expressionPose.expression === "greeting" ? 1.9 : .8)) ||
      this.waveUntil > now() ||
      this.particles.length > 0 ||
      this.cfg.scans || this.cfg.bounces ||
      (this.showBadge && this.badge?.kind === "dots" && this.status === "loading") || this.state === "dizzy" ||
      Math.abs(this.tgYaw - this.yaw) > 0.002 ||
      Math.abs(this.tgPitch - this.pitch) > 0.002 ||
      Math.abs(this.tgTilt - this.tilt) > 0.002 ||
      Math.abs(this.tgSy - this.sy) > 0.002 ||
      Math.abs(this.tgSx - this.sx) > 0.002 ||
      Math.abs(this.tgEs - this.es) > 0.002 ||
      Math.abs(this.oy) > 0.002 ||
      this.slotH > 0.001 || Math.abs(this.slotHVel) > 0.001
      || Math.abs(this.col[0] - color[0]) > .001 || Math.abs(this.col[1] - color[1]) > .001 || Math.abs(this.col[2] - color[2]) > .001
    );
  }

  rise() {
    this.oy = 0.14;
    this.anim("oy", [[0, 420, Ease.out]]);
    this.blink();
  }

  /** A single eye-opening cue for the short desktop-edge wake. */
  wake() {
    this.setState("idle");
    this.tweens.delete("open");
    this.locks.delete("open");
    if (Math.abs(this.roll) < 0.001) {
      this.roll = 0;
      this.tweens.delete("roll");
      this.locks.delete("roll");
    }
    this.oy = 0;
    this.open = 0.2;
    this.anim("open", [[1, 120, Ease.out]]);
    this.nextBlink = now() + 4;
    this.nextIdle = now() + 7;
    this.expressionTransition.settle(this.currentEye, this.currentExpression);
  }

  get changingOrientation(): boolean { return this.tweens.has("roll"); }

  // ── Tweens ──────────────────────────────────────────────────────────────────

  /** Wake parked canvases only for an idle action or expression expiry. */
  get nextWakeDelayMs(): number {
    const t = now();
    const expiry = this.eyeOverride && Number.isFinite(this.eyeOverrideUntil) ? this.eyeOverrideUntil : Infinity;
    const blink = this.currentExpression === "idle" ? this.nextBlink : Infinity;
    const ambient = (this.isMini ? this.state === "idle" : this.currentExpression === "idle") ? Math.min(blink,
      this.isMini ? Math.min(this.miniLookNextTime, this.miniNextBehavior) : this.nextIdle) : Infinity;
    const glance = this.idleLook.until > t ? this.idleLook.until : Infinity;
    const validation = this.validationUntil > t ? this.validationUntil : Infinity;
    const wink = this.isMini && !ATTENTION_STATES.has(this.state) && this.status !== "error"
      && !this.eyeOverride ? this.nextMiniWink : Infinity;
    return Math.max(20, (Math.min(expiry, ambient, glance, validation, wink) - t) * 1000);
  }

  anim(prop: PropKey, keys: TweenKey[], onComplete?: () => void) {
    this.onWake?.();
    // Keep original cue timing and bound deformation for the compact sphere.
    keys = keys.map(([target, duration, ease]) => {
      if (prop === "sx" || prop === "sy") target = 1 + (target - 1) * 0.65;
      if (prop === "oy" || prop === "ox") target *= 0.65;
      if (prop === "tilt") target = Math.max(-0.14, Math.min(0.14, target));
      return [target, Math.max(1, duration), ease];
    });
    this.tweens.set(prop, {
      prop, keys, index: 0, from: this[prop], startMs: performance.now(), onComplete,
    });
    this.locks.add(prop);
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  update(dt: number) {
    const n = now();
    const nowMs = performance.now();
    dt = Math.max(0, Math.min(0.05, dt));
    if (this.eyeOverride && n > this.eyeOverrideUntil) {
      this.eyeOverride = this.permanentEye; this.reaction = null;
      this.eyeOverrideUntil = this.permanentEye ? Infinity : 0;
    }
    if (this.validationUntil > 0 && n >= this.validationUntil) {
      this.validationUntil = 0; this.syncStatusBadge();
    }
    if (this.expressionContext === "music" && ["music", "dancing"].includes(this.currentExpression)) {
      if (this.musicStarted === null) this.musicStarted = n;
    } else this.musicStarted = null;
    const expression = this.currentExpression;
    if (expression !== this.presentedExpression) {
      this.presentedExpression = expression;
      this.syncStatusBadge();
    }
    const previousExpression = this.expressionPose.expression;
    this.expressionTransition.update(this.currentEye, nowMs, expression);
    if (this.expressionPose.expression !== previousExpression) this.expressionStarted = n;
    const targetColor = this.targetFaceColor;
    const colorEase = 1 - Math.exp(-dt / 0.075);
    for (let i = 0; i < 3; i++) this.col[i] += (targetColor[i] - this.col[i]) * colorEase;

    // Callbacks can replace a tween. Snapshot into one owned, reusable buffer.
    this.activeTweens.length = 0;
    for (const tween of this.tweens.values()) this.activeTweens.push(tween);
    for (const tw of this.activeTweens) {
      const k = tw.keys[tw.index];
      const p = Math.min(1, Math.max(0, (nowMs - tw.startMs) / k[1]));
      this[tw.prop] = tw.from + (k[0] - tw.from) * k[2](p);
      if (p >= 1) {
        tw.from = k[0];
        tw.index += 1;
        tw.startMs = nowMs;
        if (tw.index >= tw.keys.length) {
          this.tweens.delete(tw.prop);
          this.locks.delete(tw.prop);
          tw.onComplete?.();
        }
      }
    }
    this.activeTweens.length = 0;

    const t = n - this.t0;
    const bounded = (v: number) => Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    let ty = bounded(this.lookX) * .62;
    let tp = bounded(this.lookY) * .5;
    if (!this.isMini && this.currentExpression === "idle" && n > this.nextIdle) this.doIdle();
    if (this.state === "idle" && n < this.idleLook.until && Math.abs(ty) + Math.abs(tp) < 0.2) {
      ty = this.idleLook.x; tp = this.idleLook.y;
    }

    const neutralCursor = Math.abs(ty) + Math.abs(tp) < 0.15;
    if (this.cfg.look && neutralCursor) {
      ty = this.cfg.look[0]; tp = this.cfg.look[1];
    }
    if (this.cfg.scans && neutralCursor) {
      ty = Math.sin(t * 1.2) * 0.32;
      tp = -0.06;
    }
    if (this.state === "dizzy") { ty = 0; tp = 0; }

    // Mini bots never follow the mouse — they wander.
    if (this.isMini && !this.cfg.look && !this.cfg.scans && this.state !== "dizzy") {
      if (n > this.miniLookNextTime) {
        this.miniLookTarget.x = -0.88 + Math.random() * 1.76;
        this.miniLookTarget.y = -0.55 + Math.random() * 1.0;
        this.miniLookNextTime = n + .5 + Math.random() * 1.5;
      }
      ty = this.miniLookTarget.x * 0.62;
      tp = this.miniLookTarget.y * 0.5;
    }

    this.tgYaw = ty;
    this.tgPitch = tp;
    this.tgTilt = this.cfg.tilt + (this.state === "idle" ? ty * 0.018 : 0);

    if (n > this.waveStart && n < this.waveUntil) {
      const wt = n - this.waveStart;
      this.tgTilt = -0.06 + Math.sin(2 * Math.PI * 1.2 * wt) * 0.07;
    }

    const bounce = this.cfg.bounces ? -Math.abs(Math.sin(t * 5.2)) * 0.07 : 0;
    const kGen = 1 - Math.pow(0.0008, dt);
    if (!this.locks.has("oy")) this.oy += (bounce - this.oy) * kGen;
    this.tgSy = 1;
    this.tgSx = 1;

    if (this.isMini && n > this.miniNextBehavior) this.doMiniBehaviorLoop();
    if (this.isMini && n >= this.nextMiniWink) {
      this.nextMiniWink = n + 12 + Math.random() * 16;
      this.wink();
    }

    // Original Mochi easing, independent of display refresh rate.
    const kLook = 1 - Math.pow(.0025, dt);
    if (!this.locks.has("yaw")) this.yaw += (this.tgYaw - this.yaw) * kLook;
    if (!this.locks.has("pitch")) this.pitch += (this.tgPitch - this.pitch) * kLook;
    if (!this.locks.has("tilt")) this.tilt += (this.tgTilt - this.tilt) * kGen;
    if (!this.locks.has("sy")) this.sy += (this.tgSy - this.sy) * kGen;
    if (!this.locks.has("sx")) this.sx += (this.tgSx - this.sx) * kGen;
    if (!this.locks.has("es")) this.es += (this.tgEs - this.es) * kGen;

    if (n > this.nextBlink) {
      if (this.currentExpression === "idle") {
        this.blink(true);
        const token = this.emoteToken;
        if (Math.random() < 0.18) this.lifetime.after(() => {
          if (token === this.emoteToken && this.currentExpression === "idle") this.blink();
        }, 550);
      }
      this.nextBlink = n + 4 + Math.random() * 4;
    }

    if (this.eyeOverride && n > this.eyeOverrideUntil) {
      this.eyeOverride = this.permanentEye;
      this.reaction = null;
      this.eyeOverrideUntil = this.permanentEye ? Number.POSITIVE_INFINITY : 0;
    }

    if (n - this.lastAmbient > 1.3) {
      this.lastAmbient = n;
      if (!this.isMini && this.cfg.sweat && Math.random() < 0.5) this.emit("sweat", 1);
    }

    let remaining = 0;
    for (const p of this.particles) {
      p.age += dt;
      if (p.age < p.life) this.particles[remaining++] = p;
    }
    this.particles.length = remaining;

    // Mouth slot spring — ω₀ = 2π/0.25, ζ = 0.6
    const omega = (2 * Math.PI) / 0.25;
    const zeta = 0.6;
    const acc = omega * omega * (this.slotHTarget - this.slotH) - 2 * zeta * omega * this.slotHVel;
    this.slotHVel += acc * dt;
    this.slotH = Math.max(0, this.slotH + this.slotHVel * dt);

    this.lastTime = n;
  }

  private doIdle() {
    const n = now();
    const actions = [0, 1, 2, 3, 4].filter((action) => action !== this.lastIdle);
    const action = actions[Math.floor(Math.random() * actions.length)];
    this.lastIdle = action;
    this.nextIdle = n + 7 + Math.random() * 9;
    if (this.eyeOverride || this.permanentEye) return;
    if (action === 0) this.blink(true);
    if (action === 1 || action === 2) this.idleLook = { x: action === 1 ? -0.6 : 0.6, y: 0, until: n + 0.8 };
    if (action === 3) { this.eyeOverride = "tired"; this.eyeOverrideUntil = n + 0.7; }
    if (action === 4) this.anim("oy", [[-0.12, 350, Ease.inOut], [0, 550, Ease.inOut]]);
  }

  private doMiniBehaviorLoop() {
    const n = now();
    this.miniNextBehavior = n + 4 + Math.random() * 3;
    if (this.attentionLocked || !this.permanentEmote) return;
    if (this.permanentEmote === "wink") {
      this.triggerEmote("wink", .9); return;
    }
    const expression = this.permanentEmote;
    if (this.currentExpression !== expression) return;
    // Reuse the owned eye/glyph gesture; a miniature never runs a competing
    // head shake, bob, or squash behind its work or attention expression.
    this.expressionStarted = n; this.onWake?.();
  }

  // ── Draw ────────────────────────────────────────────────────────────────────

  /** Draw the shared head, existing state badges and restrained particles. */
  draw(x: CanvasRenderingContext2D, W: number, H: number) {
    const R = W * 0.3;
    const expression = this.expressionPose.expression;
    const musicTime = this.musicMotionTime;
    const musicPhase = (musicTime ?? 0) % 18;
    const dance = expression === "dancing" && this.currentExpression === "dancing"
      ? mimoDanceMotion(musicPhase >= 14 ? musicPhase - 14 : now() - this.expressionStarted) : null;
    const cx = W / 2 + (this.ox + (dance?.x ?? 0)) * R;
    const cy = H / 2 + this.particleOverhang / 2 + (this.oy + (dance?.y ?? 0)) * R + R * 0.06;
    if (R >= 4 && this.backdrop) {
      x.save(); x.translate(cx, cy - this.oy * R);
      if (this.isMini) x.globalAlpha *= .55;
      const auraColor = this.auraColor;
      drawMimoBackdrop(x, R, this.tile, 0.5,
        "#" + auraColor.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0")).join("")); x.restore();
    }
    x.save();
    x.translate(cx, cy);
    x.rotate(this.tilt + (dance?.tilt ?? 0));
    x.scale(this.sx, this.sy);
    if (this.voiceMode && this.voiceMode !== "ready") {
      const breath = Math.sin(now() * (this.voiceMode === "speaking" ? 5 : 2.4));
      x.translate(0, breath * R * .025);
      x.scale(1 + breath * .015, 1 - breath * .012);
    }
    const expressionTime = Math.min(1, (now() - this.expressionStarted) / .8);
    let shape = this.expressionPose.eye;
    if (this.isChewing) shape = "happy";
    if (this.morph < .25 && expression === "greeting") drawMimoExpressionDetail(x, { radius: R, expression,
      progress: expression !== this.currentExpression ? this.expressionPose.open : Math.min(1, (now() - this.expressionStarted) / .3),
      time: now() - this.expressionStarted, musicTime });
    drawMimoFace(x, {
      radius: R, eye: shape, open: this.open, lookX: this.yaw, lookY: this.pitch,
      expressionOpen: this.expressionPose.open, expression,
      expressionProgress: expression !== this.currentExpression ? this.expressionPose.open : Math.min(1, (now() - this.expressionStarted) / .22),
      expressionTime, musicTime,
      eyeScale: this.es, time: now(),
      wink: this.winkAmount,
      mouthOpening: this.slotH,
      intakeMorph: this.morph,
      color: this.col,
      rotation: this.roll,
      eyeRoll: this.orbit,
      spiralAngle: expression === "dizzy" ? (now() - this.expressionStarted) * Math.PI * .8 : 0,
    });
    if (this.morph < .25 && expression !== "greeting") drawMimoExpressionDetail(x, { radius: R, expression,
      progress: expression !== this.currentExpression ? this.expressionPose.open : Math.min(1, (now() - this.expressionStarted) / .3),
      time: now() - this.expressionStarted, musicTime });
    x.restore();
    if (this.showBadge && this.badge && this.badgeS > 0.01 && this.morph < 0.25 && (this.voiceMode || this.badgeExpression === expression))
      this.drawBadge(x, this.badge, R, cx, cy);
    this.drawParticles(x, R, cx, cy);
  }

  private drawBadge(x: CanvasRenderingContext2D, badge: Badge, R: number, cx: number, cy: number) {
    x.save(); x.translate(cx, cy);
    drawMimoBadge(x, {
      radius: R, kind: badge.kind, color: rgba(badge.color), scale: this.badgeS,
      appColor: rgba(this.col),
      loading: this.status === "loading", time: now(),
      motionProgress: Math.min(1, (now() - this.expressionStarted) / .8),
    });
    x.restore();
  }

  private drawParticles(x: CanvasRenderingContext2D, R: number, cx: number, cy: number) {
    for (const p of this.particles) {
      if (p.expression !== this.expressionPose.expression) continue;
      if (p.age <= 0) continue;
      const k = p.age / p.life;
      const a = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
      const px = cx + (p.x + p.vx * p.age) * R * 1.3;
      const py = cy + (p.y + p.vy * p.age) * R * 1.3;
      const sz = R * p.size * (1 + k * 0.4);

      x.save();
      x.translate(px, py);
      x.globalAlpha = Math.min(1, Math.max(0, a));
      switch (p.type) {
        case "heart":
          x.rotate(Math.sin(p.age * 6) * 0.3);
          x.fillStyle = MIMO_PALETTE.love;
          heartPath(x, sz);
          x.fill();
          break;
        case "sweat":
          x.fillStyle = "#7CC7FF";
          x.beginPath();
          x.moveTo(0, -sz);
          x.quadraticCurveTo(sz * 0.8, sz * 0.2, 0, sz * 0.6);
          x.quadraticCurveTo(-sz * 0.8, sz * 0.2, 0, -sz);
          x.fill();
          break;
      }
      x.restore();
    }
  }
}
