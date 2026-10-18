// SPDX-License-Identifier: MIT
/** Compact, read-only account data. Never contains identity or credentials. */
export interface UsageWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

export interface CodexUsage {
  plan: string | null;
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
  resetCredits?: { availableCount: number; nextExpiresAt: number | null } | null;
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  checkedAt: number;
}

export interface ClaudeUsage extends CodexUsage {
  contextUsedPercent: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  sessionCostUsd: number | null;
}

export function remainingPercent(window: UsageWindow): number {
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

export function windowLabel(minutes: number | null, fallback: string): string {
  if (!minutes || minutes <= 0) return fallback;
  if (minutes % 10080 === 0) return minutes / 10080 + "-week limit";
  if (minutes % 1440 === 0) return minutes / 1440 + "-day limit";
  if (minutes % 60 === 0) return minutes / 60 + "-hour limit";
  return minutes + "-minute limit";
}

/** Absolute times stay accurate without a countdown timer. */
export function resetLabel(seconds: number | null, now = Date.now()): string {
  if (seconds == null || !Number.isFinite(seconds) || Math.abs(seconds) > 8.64e12) return "Reset time unavailable";
  const reset = new Date(seconds * 1000);
  if (reset.getTime() <= now) return "Reset pending · refresh";
  return "Resets " + reset.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/** A reading's next reset; no background countdown or invented fresh quota. */
export function resetAvailability(seconds: number | null, now = Date.now()): string {
  if (seconds == null || !Number.isFinite(seconds) || Math.abs(seconds) > 8.64e12) return "Not shared";
  if (seconds * 1000 <= now) return "Refresh to confirm";
  const minutes = Math.floor((seconds * 1000 - now) / 60000);
  if (minutes < 0) return "Refresh to confirm";
  if (minutes < 1) return "In under a minute";
  if (minutes < 60) return "In " + minutes + "m";
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 24) return "In " + hours + "h" + (rest ? " " + rest + "m" : "");
  const days = Math.floor(hours / 24), remainder = hours % 24;
  return "In " + days + "d" + (remainder ? " " + remainder + "h" : "");
}
