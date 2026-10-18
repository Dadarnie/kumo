// SPDX-License-Identifier: MIT
import { audioLevels, audioSourceKey, measuredAudio } from "../core/audio-levels";
import { mediaStore } from "../core/media-store";
import { MeasuredWaveform } from "../core/audio-waveform";
import { h } from "../views/dom";
import { Lifetime } from "../core/lifetime";

/** A short history of real audio peaks, never a simulated spectrum. */
export class MediaEqualizer {
  readonly el = h("span", {
    class: "spotify-equalizer",
    "aria-hidden": "true",
  });
  private waveform = new MeasuredWaveform();
  private visible = false;
  private source: string | null = null;
  private meterSource: string | null | undefined;
  private stops: (() => void)[] = [];
  private stopMeter: (() => void) | undefined;
  private inputSampleAt = 0;
  private lifetime = new Lifetime();
  constructor(private externalPeak?: () => number | undefined) {
    this.el.append(...this.waveform.values.map(() => h("i")));
    document.addEventListener("visibilitychange", () => this.syncSubscriptions(),
      { signal: this.lifetime.signal });
  }
  setVisible(value: boolean): void {
    if (this.visible === value) return;
    this.visible = value;
    this.inputSampleAt = 0;
    this.syncSubscriptions();
  }
  private syncSubscriptions(): void {
    if (this.visible && !document.hidden && this.lifetime.active) {
      if (this.externalPeak) { this.draw(false); return; }
      if (!this.stops.length) this.stops = [
        mediaStore.subscribe(() => this.draw(false)),
        mediaStore.subscribeAudio(() => this.draw(false)),
      ];
      this.draw(false);
    } else {
      // A pause can hide the strip before its store subscriber is called. Keep
      // the same resting bars through the outgoing transition, then unsubscribe.
      this.waveform.reset();
      this.el.dataset.measured = "false";
      for (const bar of this.el.children) {
        if (this.externalPeak) (bar as HTMLElement).style.height = "3px";
        else (bar as HTMLElement).style.transform = "scaleY(0.1)";
        (bar as HTMLElement).style.transitionDuration = "180ms";
      }
      this.stops.splice(0).forEach(stop => stop());
      this.stopMeter?.();
      this.stopMeter = undefined;
    }
  }
  private draw(sample: boolean): void {
    if (!this.visible || document.hidden || !this.lifetime.active) return;
    if (this.externalPeak) {
      const peak = this.externalPeak();
      if (peak === undefined) this.waveform.reset();
      else if (sample) this.waveform.sample(peak);
      this.el.dataset.measured = String(peak !== undefined);
      [...this.el.children].forEach((bar, index) => {
        // Height preserves circular bar ends at every level. Music retains its
        // existing transform and layout; this branch belongs to microphone input.
        const element = bar as HTMLElement;
        const height = Math.max(3, 23 * this.waveform.values[index]);
        element.style.transitionDuration = height > (parseFloat(element.style.height) || 3) ? "160ms" : "260ms";
        element.style.height = `${height}px`;
      });
      return;
    }
    const media = mediaStore.snapshot().state,
      audio = mediaStore.audioSnapshot(),
      level = audioLevels.snapshot();
    if (media.playbackState === "playing") {
      this.stopMeter ??= audioLevels.subscribe(() => this.draw(true));
    } else {
      this.stopMeter?.();
      this.stopMeter = undefined;
    }
    const measured = measuredAudio(level, media.sourceAppId);
    if (this.source !== media.sourceAppId || this.meterSource !== measured?.source) {
      this.source = media.sourceAppId;
      this.meterSource = measured?.source;
      this.waveform.reset();
    }
    const peak = measured?.peak;
    const source = audioSourceKey(media.sourceAppId);
    const sessions = audio.sessions?.filter(session =>
      source !== undefined && audioSourceKey(session.source) === source);
    const audible = !audio.muted && audio.volume > 0 &&
      !(sessions?.length && sessions.every(session => session.muted || session.volume === 0));
    const active =
      media.playbackState === "playing" &&
      peak !== undefined &&
      audible;
    if (!active) this.waveform.reset();
    else if (sample || this.waveform.values.every(value => value === 0))
      this.waveform.sample(peak!);
    this.el.dataset.measured = String(active);
    // The unmeasured waveform is a static music glyph, never fake meter motion.
    const fallback = [0.38, 0.7, 1, 0.82, 0.6, 0.3];
    const staticGlyph = media.playbackState === "playing" &&
      peak === undefined && audible;
    [...this.el.children].forEach((bar, index) => {
      (bar as HTMLElement).style.transform =
        `scaleY(${active ? Math.max(0.1, this.waveform.values[index]) : staticGlyph ? fallback[index] : 0.1})`;
      (bar as HTMLElement).style.transitionDuration = active && sample &&
        this.waveform.values[index] > 0.1 ? "80ms" : "180ms";
    });
  }
  destroy(): void {
    this.visible = false;
    this.lifetime.destroy();
    this.syncSubscriptions();
  }
  tick(): void {
    if (!this.externalPeak || !this.visible || document.hidden) return;
    const time = performance.now();
    // Let each microphone sample travel visibly across the six bars. The shared
    // frame clock owns this cadence; the music meter keeps its existing timing.
    if (time - this.inputSampleAt < 50) return;
    this.inputSampleAt = time;
    this.draw(true);
  }
}
