// SPDX-License-Identifier: MIT
// Mimo's silver material, charcoal eyes and local state lights.
export const MIMO_PALETTE = {
  // Kumo: a warm cream cloud with a soft amber underside.
  body: "#FFF4E2",
  highlight: "#FFFDF7",
  shade: "#D9B88E",
  tongue: "#EBA8B5",
  eyes: "#11161B",
  // Ember dusk state lights: coral work, peach questions, plum-pink thinking.
  loading: "#F67E7D",
  connected: "#4FB29E",
  error: "#E69537",
  tile: "#1C1C20",
  // Anime look: iris glow, cheek blush and inner ears.
  iris: "155,107,255",
  blush: "#FF8FB1",
  // Reaction colors stay local to a temporary expression or state light.
  love: "#E13D44",
  pride: "#E69537",
  // Expression accents from mimo-core-look/mimo_expressions.png.
  thinking: "#D9668E",
  question: "#FFB997",
  music: "#D9668E",
  failure: "#E13D44",
} as const;

/** Companion identity hues sampled from the supplied Home motion reference. */
export const MIMO_PICKER_COLORS: Record<string, string> = {
  integration_claude: MIMO_PALETTE.body,
  integration_resend: "#4FB29E",
  integration_n8n: "#E69537",
  integration_vercel: "#8358E9",
  integration_github: "#E13D44",
  integration_stripe: "#2DA4F9",
  integration_notion: "#A3A1A8",
  integration_calcom: "#D2A37D",
};
