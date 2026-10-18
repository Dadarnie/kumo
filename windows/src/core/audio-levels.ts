// SPDX-License-Identifier: MIT
export interface AudioLevel {
  readonly revision: number;
  readonly available: boolean;
  readonly peak: number;
  readonly sources?: Readonly<Record<string, number>>;
}

export interface AudioMeasurement {
  readonly peak: number;
  /** Null identifies the shared desktop fallback. */
  readonly source: string | null;
}

/** Prefer the playing app's meter; unidentified players use real desktop peaks. */
export function measuredAudio(level: AudioLevel, source: string | null | undefined): AudioMeasurement | undefined {
  if (!level.available) return undefined;
  const key = audioSourceKey(source);
  if (key && level.sources) {
    const matches = Object.entries(level.sources).filter(([name]) => audioSourceKey(name) === key);
    if (matches.length) return { peak: Math.max(...matches.map(([, peak]) => peak)), source: key };
  }
  return { peak: level.peak, source: null };
}

export function measuredPeak(level: AudioLevel, source: string | null | undefined): number | undefined {
  return measuredAudio(level, source)?.peak;
}

/** GSMTC can report an executable, path or packaged app ID for the same player. */
export function audioSourceKey(source: string | null | undefined): string | undefined {
  if (!source?.trim()) return undefined;
  if (isSpotifySource(source)) return "spotify.exe";
  const key = source.trim().toLowerCase().split(/[\\/]/).pop()!;
  if (/^microsoft\.zunemusic_[^!]+!/.test(key)) return "microsoft.media.player.exe";
  if (/^videolan\.vlc_[^!]+!/.test(key)) return "vlc.exe";
  return key.includes("!") || key.endsWith(".exe") ? key : `${key}.exe`;
}
export function isSpotifySource(source: string | null | undefined): boolean {
  return /^(?:spotify(?:\.exe)?|SpotifyAB\.SpotifyMusic_[^!]+!Spotify)$/i.test(
    source ?? "",
  );
}
/** One measured stream; views project it without subscribing to Windows independently. */
export class AudioLevels {
  private current: AudioLevel = { revision: -1, available: false, peak: 0 };
  private listeners = new Set<() => void>();
  private demand: ((active: boolean) => void) | undefined;
  /** One native owner follows the number of visible waveform subscribers. */
  onDemand(handler: (active: boolean) => void): () => void {
    this.demand = handler;
    handler(this.listeners.size > 0);
    return () => {
      if (this.demand !== handler) return;
      this.demand = undefined;
      handler(false);
    };
  }
  snapshot(): AudioLevel {
    return this.current;
  }
  apply(level: AudioLevel): boolean {
    if (
      !Number.isSafeInteger(level.revision) ||
      level.revision <= this.current.revision ||
      typeof level.available !== "boolean" ||
      !Number.isInteger(level.peak) ||
      level.peak < 0 ||
      level.peak > 1000 ||
      (level.sources !== undefined &&
        (!level.sources || typeof level.sources !== "object" || Array.isArray(level.sources) ||
          Object.entries(level.sources).some(([source, peak]) =>
            !source || !Number.isInteger(peak) || peak < 0 || peak > 1000)))
    )
      return false;
    this.current = Object.freeze({ ...level,
      ...(level.sources ? { sources: Object.freeze({ ...level.sources }) } : {}),
    });
    for (const fn of this.listeners) fn();
    return true;
  }
  subscribe(fn: () => void): () => void {
    const wasEmpty = this.listeners.size === 0;
    this.listeners.add(fn);
    if (wasEmpty) this.demand?.(true);
    return () => {
      if (this.listeners.delete(fn) && !this.listeners.size) this.demand?.(false);
    };
  }
}
export const audioLevels = new AudioLevels();
