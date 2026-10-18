// SPDX-License-Identifier: MIT
import github from "./brands/github.svg?raw";
import n8n from "./brands/n8n.svg?raw";
import vscode from "./brands/vscode.svg?raw";
import stripe from "./brands/stripe.svg?raw";
import { MIMO_PALETTE, MIMO_PICKER_COLORS } from "./palette";

export type MimoAppIcon = "github" | "n8n" | "vscode" | "vercel" | "stripe";
export const MIMO_APPS: Record<string, { icon: MimoAppIcon; color: string; label: string }> = {
  integration_github: { icon: "github", color: MIMO_PICKER_COLORS.integration_github, label: "GitHub" },
  integration_n8n: { icon: "n8n", color: MIMO_PICKER_COLORS.integration_n8n, label: "n8n" },
  integration_claude: { icon: "vscode", color: MIMO_PALETTE.loading, label: "VS Code" },
  coding_codex: { icon: "vscode", color: MIMO_PALETTE.loading, label: "VS Code" },
  integration_vercel: { icon: "vercel", color: MIMO_PICKER_COLORS.integration_vercel, label: "Vercel" },
  integration_stripe: { icon: "stripe", color: MIMO_PICKER_COLORS.integration_stripe, label: "Stripe" },
};

// The first path is the official silhouette (VS Code's alpha-mask contour).
// Trim source whitespace for optical centering; keep each mark's proportions.
const marks: Record<MimoAppIcon, { svg: string; bounds: [number, number, number, number]; evenodd?: boolean }> = {
  github: { svg: github, bounds: [0, 0, 24, 24] },
  n8n: { svg: n8n, bounds: [0, 5, 30.4, 16], evenodd: true },
  vscode: { svg: vscode, bounds: [0, 0, 100, 100], evenodd: true },
  stripe: { svg: stripe, bounds: [11, 0, 362, 512] },
  vercel: { svg: '<path d="M12 0 L24 20.785 H0 Z"/>', bounds: [0, 0, 24, 20.785] },
};
const paths = new Map<MimoAppIcon, Path2D>();
export function isMimoAppIcon(kind: string): kind is MimoAppIcon {
  return kind === "github" || kind === "n8n" || kind === "vscode" || kind === "vercel" || kind === "stripe";
}

/** Rasterize original vector contours directly at the display's current DPI. */
export function drawMimoAppIcon(ctx: CanvasRenderingContext2D, kind: MimoAppIcon, size: number, color: string) {
  const mark = marks[kind];
  let path = paths.get(kind);
  if (!path) {
    path = new Path2D(mark.svg.match(/<path\b[^>]*\bd="([^"]+)"/)![1]);
    paths.set(kind, path);
  }
  const [left, top, width, height] = mark.bounds;
  const scale = size / Math.max(width, height);
  ctx.save(); ctx.scale(scale, scale); ctx.translate(-left - width / 2, -top - height / 2);
  ctx.fillStyle = color; ctx.fill(path, mark.evenodd ? "evenodd" : "nonzero"); ctx.restore();
}
