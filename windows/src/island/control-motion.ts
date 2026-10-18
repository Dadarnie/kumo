// SPDX-License-Identifier: MIT
import { prefersReducedMotion } from "../core/motion";

/** Bounded press feedback, shared by playback and master audio. */
export function pressFeedback(button: HTMLElement, x = 0, y = 0): void {
  if (prefersReducedMotion()) return;
  for (const animation of button.getAnimations()) animation.cancel();
  button.animate(
    [
      { transform: "translate(0, 0) scale(1)" },
      { transform: `translate(${x}px, ${y}px) scale(.94)`, offset: 0.32 },
      { transform: "translate(0, 0) scale(1)" },
    ],
    { duration: 160, easing: "cubic-bezier(.16, 1, .3, 1)" },
  );
}
