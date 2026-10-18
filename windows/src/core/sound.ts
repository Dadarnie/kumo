// SPDX-License-Identifier: MIT
// One selected recording per event, combining retained Mimo and new console cues.
// See assets/sounds/README.md and manifest.json for the current 28-file pack.
// Default volume 0.12, slider range 0–0.2; overlap and idle suspension are shared.

export const SOUND_NAMES = [
  "peek",
  "open",
  "close",
  "hover",
  "blip",
  "slap",
  "annoyed",
  "dizzy",
  "greet",
  "work",
  "finish",
  "error",
  "approval",
  "question",
  "approve",
  "gulp",
  "tick",
  "send",
  "love",
  "pop",
  "proud",
  "wink",
  "yawn",
  "attach",
  "think",
  "search",
  "rate",
  "sleep",
] as const;

export type SoundName = (typeof SOUND_NAMES)[number];

class SoundEngine {
  enabled = true;
  volume = 0.12;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loading: Promise<void> | null = null;
  private idleTimer: number | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private requests: AbortController | null = null;

  /** Creates the context and decodes every WAV. Safe to call more than once. */
  preload(): Promise<void> {
    if (this.loading) return this.loading;
    const requests = new AbortController();
    this.requests = requests;
    this.loading = (async () => {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = this.volume;
      master.connect(ctx.destination);
      this.master = master;
      await Promise.all(
        SOUND_NAMES.map(async (name) => {
          try {
            const res = await fetch(`/sounds/console-${name}.wav`, { signal: requests.signal });
            if (!res.ok) return;
            const buf = await ctx.decodeAudioData(await res.arrayBuffer());
            if (!requests.signal.aborted && this.ctx === ctx) this.buffers.set(name, buf);
          } catch {
            /* a missing sound must never break the island */
          }
        }),
      );
      if (this.ctx === ctx) this.idle();
    })();
    return this.loading;
  }

  /** WebView2 can hand us a suspended context; call after any user input. */
  resume() {
    if (this.idleTimer != null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    void this.ctx?.resume();
  }

  /**
   * Called when the island goes quiet. A running AudioContext keeps an audio
   * thread and its render quantum alive even with nothing playing, which shows
   * up as a steady trickle of CPU on a machine that is supposed to be idle.
   *
   * The delay covers the tail of whatever just played — suspending mid-sound
   * would clip it — and `play()` resumes the context on its own.
   */
  idle() {
    if (!this.ctx || this.ctx.state !== "running" || this.idleTimer != null || this.sources.size) return;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      void this.ctx?.suspend();
    }, 1500);
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(0.2, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
  }

  play(name: SoundName | string) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const master = this.master;
    const buf = this.buffers.get(name);
    if (!ctx || !master || !buf) return;
    if (this.idleTimer != null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (ctx.state === "suspended") void ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(master);
    this.sources.add(src);
    src.onended = () => {
      src.onended = null;
      src.disconnect();
      src.buffer = null;
      this.sources.delete(src);
      this.idle();
    };
    src.start();
  }

  destroy(): void {
    this.requests?.abort();
    this.requests = null;
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
      source.buffer = null;
    }
    this.sources.clear();
    this.master?.disconnect();
    this.master = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) void ctx.close().catch(() => {});
    this.buffers.clear();
    this.loading = null;
  }
}

export const Sound = new SoundEngine();
