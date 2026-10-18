// SPDX-License-Identifier: MIT
import type { BotStateName } from "../core/layout";
import type { IntegrationInfo } from "../core/state";
import type { EyeShape } from "./engine";
import { MIMO_PALETTE } from "./palette";

export type MimoStatus = "idle" | "loading" | "connected" | "error";
export type MimoBadgeIcon = "dots" | "check" | "bang" | "cross" | "hourglass" | "focus" | "bolt" | "microphone" | "speaker";

export const MIMO_VARIANTS: Record<MimoStatus, { eye: EyeShape; color: string; icon: MimoBadgeIcon }> = {
  idle: { eye: "pill", color: MIMO_PALETTE.loading, icon: "dots" },
  loading: { eye: "pill", color: MIMO_PALETTE.loading, icon: "dots" },
  connected: { eye: "pill", color: MIMO_PALETTE.connected, icon: "check" },
  error: { eye: "pill", color: MIMO_PALETTE.failure, icon: "cross" },
};

/** Report confirmed app state; a missing configuration never claims a connection. */
export function mimoAppStatus(state: BotStateName, info?: IntegrationInfo, taskId?: string): MimoStatus {
  if (info?.error || ["error", "ratelimit", "approval", "question"].includes(state)) return "error";
  if (["working", "thinking", "searching"].includes(state)) return "loading";
  if (state === "finished") return "connected";
  if (state === "dizzy") return "idle";
  if (!info?.configured) return "idle";
  // Hook installation is the coding module's readiness signal; it has no poll.
  return info.loaded || taskId === "integration_claude" ? "connected" : "loading";
}
