// SPDX-License-Identifier: MIT
// Island geometry — ported from IslandTypes.swift + IslandWindowController.islandSize
// + IslandRootView.botPosition. All values are logical pixels, identical to the
// macOS app's points.

import type { IslandVisibility } from "./visibility";
import { MIMO_PALETTE } from "../mimo/palette";
export type { IslandVisibility } from "./visibility";

export type IslandViewName =
  | "overview"
  | "grab"
  | "media"
  | "integrations"
  | "notes"
  | "news"
  | "utilities"
  | "usage"
  | "activity"
  | "empty"
  | "approval"
  | "approvals"
  | "question"
  | "error"
  | "finished"
  | "confused"
  | "upload"
  | "uploading"
  | "choose"
  | "mail"
  | "prompt"
  | "searching"
  | "result"
  | "note"
  | "settings"
  | "greeting";

export type BotStateName =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "dizzy";

export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

export type AgentLayoutMode = "none" | "grid" | "pills" | "column";

export interface ViewLayout {
  height: number;
  botX: number;
  botY: number | null; // null = auto-centred
  botDiameter: number;
  agentMode: AgentLayoutMode;
  /** Expanded width override; defaults to EXPANDED_W. */
  width?: number;
}

// Expanded bounds retain room for the largest view and mascot overhang.
// Compact shapes share a single native surface and a top-center anchor.
export const PANEL_W = 1080;
export const PANEL_H = 680;

// Phase 1 core dimensions. The native compact envelope includes shadow gutters.
export const NOTCH_W = 184;
export const NOTCH_H = 32;
export const COMPACT_W = 264;
export const COMPACT_H = 40;
export const COMPACT_WINDOW_W = 320;
export const COMPACT_WINDOW_H = 56;
export const MEDIA_HOVER_W = 400;
export const MEDIA_HOVER_H = 48;
export const EXPANDED_W = 640;
/** The big live-session panel while an agent works. */
export const WIDE_W = 1000;
/** Left rail holding the section tabs; the panel widens by it so views keep their size. */
export const RAIL_W = 56;
/** Expanded panels are at least this tall while the rail shows, so all six tabs fit. */
export const RAIL_MIN_H = 228;
export function railFor(view: IslandViewName): number {
  return view === "greeting" ? 0 : RAIL_W;
}

export const ROUNDED_CORNER = 16;
// Parallel lower corners: the 16px card radius plus its 10px shell inset.
export const EXPANDED_CORNER = 26;

/** Working-mode lip attached to the display top, above browser tabs. */
export const PEEK_W = 190;
export const PEEK_H = 28;

export const VIEW_LAYOUTS: Record<IslandViewName, ViewLayout> = {
  overview: { height: 160, botX: 68, botY: null, botDiameter: 52, agentMode: "pills" },
  grab: { height: 304, botX: 27, botY: 24, botDiameter: 18, agentMode: "none" },
  media: { height: 264, botX: EXPANDED_W - 56, botY: 98, botDiameter: 44, agentMode: "none" },
  integrations: { height: 176, botX: 68, botY: 96, botDiameter: 52, agentMode: "pills" },
  notes: { height: 300, botX: 27, botY: 24, botDiameter: 18, agentMode: "none" },
  news: { height: 360, botX: 27, botY: 24, botDiameter: 18, agentMode: "none" },
  utilities: { height: 300, botX: 68, botY: 96, botDiameter: 58, agentMode: "none" },
  usage: { height: 238, botX: 27, botY: 24, botDiameter: 18, agentMode: "none" },
  activity: { height: 200, botX: 27, botY: 24, botDiameter: 18, agentMode: "none" },
  empty: { height: 160, botX: 70, botY: null, botDiameter: 62, agentMode: "none" },
  approval: { height: 176, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
  approvals: { height: 240, botX: 27, botY: 24, botDiameter: 18, agentMode: "none" },
  question: { height: 288, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
  error: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  finished: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  confused: { height: 160, botX: 76, botY: null, botDiameter: 66, agentMode: "none" },
  upload: { height: 176, botX: 140, botY: 104, botDiameter: 62, agentMode: "column" },
  // botY 103 = bar top (42 + 58) + 3, so the dot really rides the bar. The Swift
  // layout says 118 while its own comment says 103; the comment matches the spec.
  uploading: { height: 176, botX: 46, botY: 103, botDiameter: 20, agentMode: "none" },
  choose: { height: 176, botX: 60, botY: 101, botDiameter: 52, agentMode: "column" },
  mail: { height: 240, botX: 56, botY: null, botDiameter: 46, agentMode: "column" },
  prompt: { height: 160, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
  searching: { height: 160, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
  result: { height: 160, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
  note: { height: 160, botX: 60, botY: null, botDiameter: 50, agentMode: "column" },
  settings: { height: 160, botX: 54, botY: null, botDiameter: 46, agentMode: "none" },
  greeting: { height: 150, botX: 320, botY: 90, botDiameter: 0, agentMode: "none" },
};

// The upload views above are only the fallback geometry. Once a file is actually
// dropped the whole sequence — Mimo included — is drawn by src/upload, which
// owns its own constants (USC) straight from UploadSequenceEngine.swift.

/** Chat view grows with the conversation — IslandContainer.chatPromptHeight. */
export function chatPromptHeight(messageCount: number): number {
  return Math.min(360, 288 + messageCount * 40);
}

export function islandSize(
  mode: IslandVisibility,
  view: IslandViewName,
  chatCount = 0,
): { w: number; h: number } {
  switch (mode) {
    case "peek":
      return { w: PEEK_W, h: PEEK_H };
    case "island":
      return { w: COMPACT_W, h: COMPACT_H };
    case "expanded": {
      const h = view === "prompt" ? chatPromptHeight(chatCount) : VIEW_LAYOUTS[view].height;
      return { w: EXPANDED_W + railFor(view), h };
    }
  }
}

export interface BotPlacement {
  cx: number;
  cy: number;
  diameter: number;
  opacity: number;
}

/** IslandRootView.botPosition — cy is measured from the island's top edge. */
export function botPosition(
  mode: IslandVisibility,
  view: IslandViewName,
  islandH: number,
  uploadProgress = 0,
): BotPlacement {
  switch (mode) {
    case "peek":
      // A small mascot peeks out of the lip so it is easy to spot.
      return { cx: PEEK_W - 20, cy: PEEK_H / 2 + 1, diameter: 20, opacity: 1 };
    case "island":
      // Mascot on the right; the time takes the left.
      return { cx: COMPACT_W - 30, cy: 20, diameter: 24, opacity: 1 };
    case "expanded": {
      const layout = VIEW_LAYOUTS[view];
      if (view === "uploading") {
        return {
          cx: railFor(view) + 36 + uploadProgress * 526,
          cy: layout.botY ?? 103,
          diameter: layout.botDiameter,
          opacity: 1,
        };
      }
      if (layout.botY != null) {
        return { cx: railFor(view) + layout.botX, cy: layout.botY, diameter: layout.botDiameter, opacity: 1 };
      }
      // Centre of the fixed 84 pt card (8 pt top inset + 34 pt header → content at y = 42)
      const headerBottom = 42;
      const cardH = 84;
      const cy = headerBottom + (islandH - headerBottom - cardH) / 2 + cardH / 2;
      return { cx: railFor(view) + layout.botX, cy, diameter: layout.botDiameter, opacity: 1 };
    }
  }
}

export function botGlowColor(s: BotStateName): string {
  switch (s) {
    case "working":
      return MIMO_PALETTE.loading;
    case "thinking":
      return MIMO_PALETTE.thinking;
    case "searching":
      return MIMO_PALETTE.thinking;
    case "approval":
      return MIMO_PALETTE.error;
    case "error":
      return MIMO_PALETTE.failure;
    case "finished":
      return MIMO_PALETTE.connected;
    case "ratelimit":
      return MIMO_PALETTE.error;
    default:
      return "#FFFFFF";
  }
}

export function botGlowOpacity(s: BotStateName): number {
  switch (s) {
    case "idle":
      return 0.15;
    case "dizzy":
      return 0;
    default:
      return 0.65;
  }
}

// Project colours (IslandConst.projectColors)
const PROJECT_COLORS: Record<string, string> = {
  korus: "#FF5A4E",
  "sbe hub": "#2EC4A0",
  "morning ai brief": "#F29B38",
  "publication ig": "#7C5CFF",
  "ig post": "#7C5CFF",
  "louisraille.fr": "#38BDF8",
  louisraille: "#38BDF8",
  "notch buddy": "#EC4899",
  "notch-buddy": "#EC4899",
  notchbuddy: "#EC4899",
};

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

export function colorForProject(name: string): string {
  const key = name.toLowerCase().trim();
  const exact = PROJECT_COLORS[key];
  if (exact) return exact;
  for (const [k, c] of Object.entries(PROJECT_COLORS)) {
    if (key.startsWith(k) || key.includes(k)) return c;
  }
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

// Card wash colours (CardBackground.washColor)
export type Wash = "red" | "green" | "pink" | "amber" | "cyan" | "indigo" | "soft" | null;

export function washRGBA(wash: Wash): string {
  switch (wash) {
    case "red":
      return "rgba(244,80,94,0.55)";
    case "green":
      return "rgba(52,211,153,0.5)";
    case "pink":
      return "rgba(244,114,182,0.55)";
    case "amber":
      return "rgba(245,165,36,0.42)";
    case "cyan":
      return "rgba(34,211,238,0.38)";
    case "indigo":
      return "rgba(99,102,241,0.5)";
    case "soft":
      return "rgba(255,255,255,0.08)";
    default:
      return "rgba(0,0,0,0)";
  }
}
