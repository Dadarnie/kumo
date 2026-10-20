// SPDX-License-Identifier: MIT
// "peek" remains the serialized name for the working-mode lip in older settings.
export type IslandVisibility = "expanded" | "island" | "peek";
export type VisibilityReason = "explicit" | "automatic" | "restore";
export const ACTIVITY_SETTLE_MS = 1000;

export interface VisibilityPreferences {
  autoCollapseEnabled: boolean;
  autoCloseInterval: number;
  rememberCompactState: boolean;
  lastVisibility: IslandVisibility;
  workingModeEnabled?: boolean;
}

type Scheduler = {
  now(): number;
  after(callback: () => void, milliseconds: number): unknown;
  cancel(timer: unknown): void;
};
const scheduler: Scheduler = {
  now: () => performance.now(),
  after: (callback, milliseconds) => setTimeout(callback, milliseconds),
  cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function restoredVisibility(preferences: VisibilityPreferences): IslandVisibility {
  if (!preferences.rememberCompactState) return "expanded";
  // A saved detached state never restores itself in the new presentation.
  return preferences.lastVisibility === "peek" ? "island" : preferences.lastVisibility;
}

/** Hover opens the awake island; the working lip requires an explicit click. */
export class IslandVisibilityController {
  private current: IslandVisibility = "island";
  private preferences: VisibilityPreferences = {
    autoCollapseEnabled: true, autoCloseInterval: 1,
    rememberCompactState: true, lastVisibility: "island", workingModeEnabled: true,
  };
  private timer: unknown;
  private inside = false;
  private pinned = false;
  private protectedContent = false;
  private dragging = false;
  private grabReady = false;
  private working = false;
  /** A minimize during work keeps the lip until that work ends. */
  private minimizedDuringWork = false;
  private dense = false;
  private presentation = new Set<() => void>();
  private listeners = new Set<(from: IslandVisibility, to: IslandVisibility, reason: VisibilityReason) => void>();
  deadline: number | null = null;

  constructor(private clock: Scheduler = scheduler) {}
  get state(): IslandVisibility { return this.current; }
  get compact(): boolean { return this.current === "island" && this.dense; }
  private mediaPlaying = false;
  private inCall = false;
  private get minimizeForWork(): boolean {
    return this.preferences.workingModeEnabled === true && !this.mediaPlaying && !this.working && !this.inCall;
  }

  subscribePresentation(fn: () => void): () => void {
    this.presentation.add(fn);
    return () => { this.presentation.delete(fn); };
  }
  subscribe(listener: (from: IslandVisibility, to: IslandVisibility, reason: VisibilityReason) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private setCompact(value: boolean): void {
    if (this.dense === value) return;
    this.dense = value;
    for (const fn of this.presentation) fn();
  }

  configure(preferences: VisibilityPreferences): void {
    this.preferences = { ...preferences };
    if (this.current === "peek" && preferences.workingModeEnabled === false)
      this.change("island", "automatic");
    this.cancel(); this.schedule();
  }
  restore(preferences: VisibilityPreferences): void {
    this.configure(preferences);
    this.change(restoredVisibility(preferences), "restore");
  }
  setWorking(active: boolean): void {
    if (this.working === active) return;
    this.working = active;
    this.cancel();
    // Work shows its status in the small island; only approvals and questions expand.
    if (active && this.current === "peek" && !this.minimizedDuringWork) this.change("island", "automatic");
    if (!active) this.minimizedDuringWork = false;
    this.schedule();
  }
  /** While music plays, minimizing shows the artwork pill instead of the bare lip. */
  setMediaPlaying(playing: boolean): void {
    if (this.mediaPlaying === playing) return;
    this.mediaPlaying = playing;
    if (playing && this.current === "peek") this.change("island", "automatic");
    else { this.cancel(); this.schedule(); }
  }
  /** A call shows its pill instead of the bare lip, like music. */
  setCall(active: boolean): void {
    if (this.inCall === active) return;
    this.inCall = active;
    if (active && this.current === "peek") this.change("island", "automatic");
    else { this.cancel(); this.schedule(); }
  }
  setMediaPeekFlow(_value: boolean): void {}
  setDragging(value: boolean): void {
    this.dragging = value; this.cancel();
    if (!value && !this.inside) this.pointerLeft(); else this.schedule();
  }
  /** Ctrl temporarily reveals the ordinary island, including from the working lip. */
  setGrabReady(value: boolean): void {
    if (this.grabReady === value) return;
    this.grabReady = value;
    this.cancel();
    if (value && this.current === "peek") this.change("island", "explicit");
    else this.schedule();
  }
  setProtected(value: boolean): void {
    if (this.protectedContent === value) return;
    this.protectedContent = value; this.cancel();
    if (!value && !this.inside) this.pointerLeft(); else this.schedule();
  }
  setPinned(value: boolean): void { this.pinned = value; this.cancel(); this.schedule(); }

  expand(): void { this.change("expanded", "explicit"); }
  island(): void { this.change(this.minimizeForWork ? "peek" : "island", "explicit"); }
  peek(): void { this.change(this.preferences.workingModeEnabled === false ? "island" : "peek", "explicit"); }
  dock(): void { this.island(); }
  minimize(): void {
    if (this.working) this.minimizedDuringWork = true;
    if (this.current === "expanded") this.island();
    else this.peek();
  }
  activate(): void { this.expand(); }
  requestExpansion(): boolean {
    if (this.current === "expanded") return true;
    if (!this.preferences.autoCollapseEnabled || this.current === "peek") return false;
    this.change("expanded", "automatic");
    return true;
  }
  pointerEntered(deferExpansion = false): void {
    this.inside = true; this.cancel();
    if (deferExpansion || this.grabReady || this.dragging || this.current === "peek") return;
    this.setCompact(false);
    if (this.current !== "expanded") this.change("expanded", "explicit");
  }
  pointerLeft(_legacyMediaPeek = false): void {
    this.inside = false;
    if (this.preferences.autoCollapseEnabled && !this.protectedContent && !this.grabReady && !this.dragging && !this.pinned && this.current !== "peek") {
      this.change(this.minimizeForWork ? "peek" : "island", "automatic");
      this.setCompact(this.current === "island");
    } else this.schedule();
  }
  focusLost(): void { this.schedule(); }
  outsideClick(): void { this.schedule(); }

  private change(next: IslandVisibility, reason: VisibilityReason): void {
    this.cancel(); this.setCompact(false);
    const previous = this.current;
    this.current = next;
    if (previous !== next) for (const listener of this.listeners) listener(previous, next, reason);
    this.schedule();
  }
  private schedule(): void {
    if (this.timer !== undefined || !this.preferences.autoCollapseEnabled || this.current === "peek" ||
      (this.current === "island" && this.dense && !this.minimizeForWork) ||
      this.protectedContent || this.grabReady || this.dragging || this.inside || this.pinned) return;
    this.deadline = this.clock.now() + ACTIVITY_SETTLE_MS;
    this.timer = this.clock.after(() => {
      this.timer = undefined; this.deadline = null;
      if (!this.preferences.autoCollapseEnabled || this.inside || this.pinned || this.protectedContent || this.grabReady || this.dragging) return;
      if (this.minimizeForWork) this.change("peek", "automatic");
      else if (this.current === "expanded") this.change("island", "automatic");
      else this.setCompact(true);
    }, ACTIVITY_SETTLE_MS);
  }
  private cancel(): void {
    if (this.timer !== undefined) this.clock.cancel(this.timer);
    this.timer = undefined; this.deadline = null;
  }
  destroy(): void { this.cancel(); this.listeners.clear(); this.presentation.clear(); }
}

export const Visibility = new IslandVisibilityController();
