// SPDX-License-Identifier: MIT
let query: MediaQueryList | undefined;

/** All animation owners read one live preference instead of allocating per frame. */
export function reducedMotionQuery(): MediaQueryList {
  return query ??= window.matchMedia("(prefers-reduced-motion: reduce)");
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && reducedMotionQuery().matches;
}
