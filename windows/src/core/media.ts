// SPDX-License-Identifier: MIT
// Native media contract. This module has no Tauri, DOM, store, or mascot effects.
// Keep the wire fields aligned with src-tauri/src/media.rs.

export type PlaybackState =
  | "none" | "closed" | "opened" | "changing"
  | "stopped" | "playing" | "paused" | "unknown";

export type MediaProviderStatus = "initializing" | "ready" | "unavailable" | "error";

/** Raw provider observation; missing and empty metadata are normalized below. */
export interface MediaSession {
  readonly playbackState: PlaybackState;
  readonly title?: string | null;
  readonly artist?: string | null;
  readonly albumTitle?: string | null;
  readonly sourceAppId?: string | null;
}

/** isPlaying is derived by the helper, never transported or stored separately. */
export interface MediaState {
  readonly providerStatus: MediaProviderStatus;
  readonly playbackState: PlaybackState;
  readonly title: string | null;
  readonly artist: string | null;
  readonly albumTitle: string | null;
  readonly sourceAppId: string | null;
  readonly error: string | null;
}

export function createMediaState(providerStatus: MediaProviderStatus = "initializing"): MediaState {
  return {
    providerStatus, playbackState: "none",
    title: null, artist: null, albumTitle: null, sourceAppId: null, error: null,
  };
}

export function isPlaying(state: MediaState): boolean {
  return state.playbackState === "playing";
}

export function withMediaSession(session: MediaSession | null): MediaState {
  if (session == null || session.playbackState === "none") return createMediaState("ready");
  return {
    providerStatus: "ready",
    playbackState: session.playbackState,
    title: normalizeText(session.title),
    artist: normalizeText(session.artist),
    albumTitle: normalizeText(session.albumTitle),
    sourceAppId: normalizeText(session.sourceAppId),
    error: null,
  };
}

/** Playback-only updates keep metadata; loss clears it without inventing a session. */
export function withPlaybackState(state: MediaState, playbackState: PlaybackState): MediaState {
  if (playbackState === "none") {
    return { ...state, playbackState, title: null, artist: null, albumTitle: null, sourceAppId: null };
  }
  if (state.playbackState === "none") return state;
  return { ...state, playbackState };
}

function normalizeText(value: string | null | undefined): string | null {
  return value == null || value.trim().length === 0 ? null : value;
}
