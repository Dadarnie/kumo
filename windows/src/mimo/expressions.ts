// SPDX-License-Identifier: MIT
// Mimo's shared expressions, state colors and gestures.
import { Ease, clamp } from "../core/anim";
import type { EyeShape } from "./engine";
import type { MimoBadgeIcon } from "./status";
import { MIMO_PALETTE as P } from "./palette";
import type { BotStateName, IslandViewName } from "../core/layout";

export type MimoExpressionName = "idle" | "working" | "thinking" | "searching" | "approval" | "question"
  | "error" | "finished" | "ratelimit" | "dizzy" | "greeting" | "love" | "surprised"
  | "proud" | "happy" | "wink" | "yawn" | "annoyed" | "confused" | "worried" | "focus" | "music" | "dancing" | "lowbattery";
export type ExpressionDetail = "search" | "question" | "tear" | "wave" | "hearts" | "bang" | "notes" | "hourglass" | null;
export interface MimoExpression {
  label: string; eye: EyeShape; accent: string; tone: number;
  badge: MimoBadgeIcon | null; detail: ExpressionDetail;
}
const pose = (label: string, eye: EyeShape, accent = P.body as string, tone = 0,
  badge: MimoBadgeIcon | null = null, detail: ExpressionDetail = null): MimoExpression => ({ label, eye, accent, tone, badge, detail });

export const MIMO_EXPRESSIONS: Record<MimoExpressionName, MimoExpression> = {
  idle: pose("Idle", "pill"),
  working: pose("Working", "pill", P.loading, .12, "dots"),
  thinking: pose("Thinking", "pill", P.thinking, .12, "dots"),
  searching: pose("Searching", "pill", P.thinking, .10, null, "search"),
  approval: pose("Approval", "pill", P.error, .10, "bang"),
  question: pose("Question", "pill", P.question, .08, null, "question"),
  error: pose("Error", "pill", P.failure, .14, "cross", "tear"),
  finished: pose("Finished", "happy", P.connected, .12, "check"),
  ratelimit: pose("Rate limit", "tired", P.error, .08, "hourglass", "hourglass"),
  dizzy: pose("Confused", "pill"),
  greeting: pose("Greeting", "happy", P.body, 0, null, "wave"),
  love: pose("Love", "heart", P.love, .16, null, "hearts"),
  surprised: pose("Surprised", "wide", P.body, 0, null, "bang"),
  proud: pose("Proud", "pill", P.connected, .08, "check"),
  happy: pose("Happy", "happy"),
  wink: pose("Wink", "wink"),
  yawn: pose("Yawn", "closed"),
  annoyed: pose("Angry", "stern"),
  confused: pose("Confused", "pill"),
  worried: pose("Worried", "worried", P.body, 0, null, "tear"),
  focus: pose("Focus", "focus", P.thinking, .08, "focus"),
  music: pose("Music", "happy", P.thinking, .10, null, "notes"),
  dancing: pose("Dancing", "happy", P.thinking, .12, null, "notes"),
  lowbattery: pose("Low battery", "tired", P.failure, .10, "bolt"),
};

/** A short side-to-side dance, measured in head-radius units on the owned clock. */
export function mimoDanceMotion(seconds: number) {
  const soften = (value: number) => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
  const strength = soften(seconds / .3) * soften((4 - seconds) / .35);
  const beat = seconds * Math.PI * 2 / 1.2;
  return {
    x: Math.sin(beat) * .38 * strength,
    y: -(.5 - .5 * Math.cos(beat * 2)) * .09 * strength,
    tilt: Math.sin(beat) * .11 * strength,
  };
}

/** One interruptible eyelid handoff, advanced by the existing Canvas clock. */
export class ExpressionTransition {
  readonly pose: { eye: EyeShape; open: number; expression: MimoExpressionName } = { eye: "pill", open: 1, expression: "idle" };
  private target: EyeShape = "pill";
  private targetExpression: MimoExpressionName = "idle";
  private start = -Infinity;
  private from = 1;
  active = false;
  update(eye: EyeShape, timeMs: number, expression: MimoExpressionName = "idle"): void {
    if (eye !== this.target || expression !== this.targetExpression) {
      this.target = eye; this.targetExpression = expression;
      this.start = timeMs; this.from = this.pose.open; this.active = true;
    }
    if (!this.active) return;
    const elapsed = timeMs - this.start;
    if (elapsed < 90) this.pose.open = this.from * (1 - Ease.inOut(clamp(elapsed / 90, 0, 1)));
    else {
      this.pose.eye = this.target;
      this.pose.expression = this.targetExpression;
      this.pose.open = Ease.out(clamp((elapsed - 90) / 190, 0, 1));
      if (elapsed >= 280) { this.pose.open = 1; this.active = false; }
    }
  }
  settle(eye: EyeShape, expression: MimoExpressionName = "idle"): void {
    this.target = this.pose.eye = eye;
    this.targetExpression = this.pose.expression = expression;
    this.pose.open = 1; this.active = false;
  }
}

/** One foreground task state: unrelated background work never crosses tabs. */
export function companionStateForView(context: {
  view: IslandViewName; override: BotStateName | null; integrationState?: BotStateName;
  integrationCompleted?: boolean;
  pendingApproval: boolean; mediaError: boolean;
}): BotStateName {
  if (context.pendingApproval) return "approval";
  if (context.override && !["overview", "media", "integrations", "utilities", "usage", "greeting"].includes(context.view)) return context.override;
  const explicit: Partial<Record<IslandViewName, BotStateName>> = {
    approval: "approval", question: "question", error: "error", finished: "finished",
    searching: "searching", confused: "dizzy",
  };
  if (explicit[context.view]) return explicit[context.view]!;
  if (context.view === "integrations" || context.view === "overview")
    return context.integrationState === "idle" && context.integrationCompleted ? "finished" : context.integrationState ?? "idle";
  if (context.view === "media" && context.mediaError) return "error";
  return "idle";
}

/** Higher ratings win only when their source belongs to the current tab. */
export const EXPRESSION_PRIORITY = {
  approval: 95, question: 90, error: 85, ratelimit: 80,
  finished: 75, dizzy: 70, searching: 65, thinking: 60, working: 55,
  focus: 50, confused: 45, worried: 40, lowbattery: 35,
  greeting: 30, happy: 30, love: 30, surprised: 30, proud: 30, wink: 30, yawn: 30, annoyed: 30,
  dancing: 25, music: 20, idle: 10,
} satisfies Record<MimoExpressionName, number>;

export interface ExpressionContext {
  editing: boolean; focusedFile: boolean; emptyResult: boolean; missedApproval: boolean; playing: boolean;
  power?: { onBattery: boolean | null; percent: number | null } | null;
}
/** Playback performs only inside the visible media player. */
export function musicPerformanceActive(context: {
  view: IslandViewName; expanded: boolean; enabled: boolean; playing: boolean;
}): boolean {
  return context.view === "media" && context.expanded && context.enabled && context.playing;
}
/** Ambient cues come from real inputs; the engine protects owned attention. */
export function expressionForContext(context: ExpressionContext): MimoExpressionName | null {
  if (context.editing || context.focusedFile) return "focus";
  if (context.emptyResult) return "confused";
  if (context.missedApproval) return "worried";
  const power = context.power;
  if (power?.onBattery === true && Number.isInteger(power.percent) && power.percent! >= 0 && power.percent! <= 20) return "lowbattery";
  return context.playing ? "music" : null;
}
