// SPDX-License-Identifier: MIT
/** Own DOM listeners, one-shot timers and late asynchronous registrations. */
export class Lifetime {
  private controller = new AbortController();
  private stops: (() => void)[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();

  get signal(): AbortSignal { return this.controller.signal; }
  get active(): boolean { return !this.signal.aborted; }

  own(stop: () => void): void {
    if (this.active) this.stops.push(stop);
    else stop();
  }

  after(callback: () => void, milliseconds: number): void {
    if (!this.active) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.active) callback();
    }, milliseconds);
    this.timers.add(timer);
  }

  destroy(): void {
    if (!this.active) return;
    this.controller.abort();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.stops.splice(0).forEach(stop => stop());
  }
}
