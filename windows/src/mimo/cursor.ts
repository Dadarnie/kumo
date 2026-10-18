// SPDX-License-Identifier: MIT
import { clamp } from "../core/anim";

/** Cursor coordinates and companion centre share window-logical pixels. */
export function mimoCursorGaze(x: number, y: number, cx: number, cy: number) {
  // Native coordinates may lie outside the narrow island window: follow the
  // desktop cursor everywhere. Browser previews send this sentinel on exit.
  if (![x, y, cx, cy].every(Number.isFinite) || (x <= -9000 && y <= -9000)) return { x: 0, y: 0 };
  const dx = x - cx;
  const dy = y - cy;
  return { x: clamp(Math.tanh(dx / 260), -1, 1), y: clamp(Math.tanh(dy / 200), -1, 1) };
}
