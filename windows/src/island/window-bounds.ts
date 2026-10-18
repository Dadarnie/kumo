// SPDX-License-Identifier: MIT
import type { IslandVisibility } from "../core/visibility";

/** Grow before opening; shrink after the existing close curve. Rapid changes cancel stale work. */
export class IslandWindowBounds {
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private queue = Promise.resolve();
  constructor(private apply: (visibility: IslandVisibility) => Promise<unknown>) {}

  transition(from: IslandVisibility, to: IslandVisibility, reducedMotion: boolean): void {
    const revision = ++this.revision;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const order = { peek: 0, island: 1, expanded: 2 };
    const commit = () => {
      this.queue = this.queue.then(async () => {
        if (revision === this.revision) await this.apply(to);
      });
    };
    // Keep the outgoing surface until the close curve finishes. Clipping to
    // the working lip early would make the entire animation disappear.
    if (!reducedMotion && order[to] < order[from]) this.timer = setTimeout(commit, 380);
    else commit();
  }
  destroy(): void {
    ++this.revision;
    if (this.timer) clearTimeout(this.timer);
  }
}
