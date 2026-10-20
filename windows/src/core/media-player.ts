// SPDX-License-Identifier: MIT
// Supplemental player data; the normalized Phase 1 MediaState stays unchanged.
export type RepeatMode = "off" | "list" | "track";
export type MediaAction =
  | "previous"
  | "play"
  | "pause"
  | "next"
  | { readonly volume: number }
  | { readonly seekMs: number }
  | { readonly shuffle: boolean }
  | { readonly repeatMode: RepeatMode };
export interface MediaControls {
  readonly previous: boolean;
  readonly play: boolean;
  readonly pause: boolean;
  readonly next: boolean;
  readonly volume?: boolean;
  readonly seek?: boolean;
  readonly shuffle?: boolean;
  readonly repeat?: boolean;
}
export interface MediaPlayerState {
  readonly sessionId: string | null;
  readonly controls: MediaControls;
  /** Native data URL on the wire; the store publishes a shared, owned blob URL. */
  readonly artwork: { readonly dataUrl: string } | null;
  readonly timeline?: MediaTimeline | null;
  /** Spotify's own volume, or another app's session volume; unknown is null. */
  readonly volume?: number | null;
  /** Smallest adjustment exposed by this player's volume provider. */
  readonly volumeStep?: number;
  readonly shuffle?: boolean | null;
  readonly repeatMode?: RepeatMode | null;
  /** Every app with a media session; the notch can switch between them. */
  readonly sessions?: readonly MediaSessionInfo[];
}
export interface MediaSessionInfo {
  readonly id: string;
  readonly sourceAppId: string | null;
  readonly playing: boolean;
}
export interface MediaTimeline {
  readonly positionMs: number;
  readonly durationMs: number;
  readonly updatedAtUnixMs: number;
  readonly playbackRateMilli: number | null;
}
export type MediaController = (
  sessionId: string,
  action: MediaAction | "select",
) => Promise<void>;

export function emptyMediaPlayer(): MediaPlayerState {
  return {
    sessionId: null,
    controls: { previous: false, play: false, pause: false, next: false },
    artwork: null,
    timeline: null,
    volume: null,
  };
}

export function freezeMediaPlayer(
  player: MediaPlayerState = emptyMediaPlayer(),
): MediaPlayerState {
  return Object.freeze({
    sessionId: player.sessionId,
    controls: Object.freeze({
      previous: !!player.controls.previous,
      play: !!player.controls.play,
      pause: !!player.controls.pause,
      next: !!player.controls.next,
      volume: !!player.controls.volume,
      seek: !!player.controls.seek,
      shuffle: !!player.controls.shuffle,
      repeat: !!player.controls.repeat,
    }),
    artwork: player.artwork ? Object.freeze({ ...player.artwork }) : null,
    timeline: player.timeline ? Object.freeze({ ...player.timeline }) : null,
    volume: player.volume ?? null,
    ...(Number.isInteger(player.volumeStep) && player.volumeStep! > 0 && player.volumeStep! <= 100 ? { volumeStep: player.volumeStep } : {}),
    shuffle: typeof player.shuffle === "boolean" ? player.shuffle : null,
    repeatMode: ["off", "list", "track"].includes(player.repeatMode ?? "") ? player.repeatMode : null,
    sessions: Object.freeze((player.sessions ?? []).map(session => Object.freeze({ ...session }))),
  });
}

/** Display projection only; this never writes the store or creates a revision. */
export function timelinePosition(
  timeline: MediaTimeline | null | undefined,
  playing: boolean,
  now = Date.now(),
): number | null {
  if (
    !timeline ||
    !Number.isFinite(timeline.durationMs) ||
    timeline.durationMs <= 0 ||
    !Number.isFinite(timeline.positionMs)
  )
    return null;
  const elapsed =
    playing &&
    Number.isFinite(timeline.updatedAtUnixMs) &&
    (timeline.playbackRateMilli === null ||
      Number.isFinite(timeline.playbackRateMilli))
      ? // When the optional native rate is omitted, display assumes normal speed
        // until the next native timeline event corrects the anchor.
        (Math.max(0, now - timeline.updatedAtUnixMs) *
          Math.max(0, timeline.playbackRateMilli ?? 1000)) /
        1000
      : 0;
  return Math.min(
    timeline.durationMs,
    Math.max(0, timeline.positionMs + elapsed),
  );
}

export function mediaTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—:—";
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
