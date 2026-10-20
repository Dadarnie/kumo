// SPDX-License-Identifier: MIT
// Passive media state: no AppState, island, DOM, animation, or polling effects.
import { createMediaState, type MediaState } from "./media";
import { CurrentArtwork } from "./media-artwork";
import {
  unavailableAudio,
  type AudioSnapshot,
  type AudioAction,
  type AudioController,
} from "./master-audio";
import {
  freezeMediaPlayer,
  type MediaPlayerState,
  type MediaController,
  type MediaAction,
} from "./media-player";

/** Native transport envelope; the Phase 1 MediaState stays unchanged. */
export interface MediaSnapshot {
  readonly revision: number;
  readonly state: MediaState;
  readonly player?: MediaPlayerState;
}

export interface StoredMediaSnapshot extends MediaSnapshot {
  readonly player: MediaPlayerState;
}

type Subscriber = (snapshot: StoredMediaSnapshot) => void;
type Unlisten = () => void;

export class MediaStore {
  private artwork = new CurrentArtwork();
  private generation = 0;
  /** Local lifetime token; never part of the native revisioned wire contract. */
  get epoch(): number { return this.generation; }
  // -1 is local-only, so the first native snapshot at revision 0 is accepted.
  private current: StoredMediaSnapshot = Object.freeze({
    revision: -1,
    state: Object.freeze(createMediaState()),
    player: freezeMediaPlayer(),
  });
  private subscribers = new Set<Subscriber>();
  private controller?: MediaController;
  private flights = new Map<
    string,
    { action: MediaAction; promise: Promise<void> }
  >();
  private audio = unavailableAudio();
  private audioSubscribers = new Set<(snapshot: AudioSnapshot) => void>();
  private audioController?: AudioController;

  audioSnapshot(): AudioSnapshot {
    return this.audio;
  }
  subscribeAudio(subscriber: (snapshot: AudioSnapshot) => void): Unlisten {
    this.audioSubscribers.add(subscriber);
    return () => {
      this.audioSubscribers.delete(subscriber);
    };
  }
  applyAudio(snapshot: AudioSnapshot): boolean {
    if (
      !snapshot ||
      typeof snapshot.available !== "boolean" ||
      typeof snapshot.muted !== "boolean" ||
      (snapshot.deviceId !== null && typeof snapshot.deviceId !== "string") ||
      (snapshot.available && !snapshot.deviceId)
    )
      return false;
    const devicesValid = (devices: AudioSnapshot["outputs"]) =>
      devices === undefined ||
      (Array.isArray(devices) &&
        devices.every(
          (device) =>
            device &&
            typeof device.id === "string" &&
            device.id &&
            typeof device.name === "string",
        ));
    const levelValid = (level: unknown) =>
      level == null ||
      (Number.isInteger(level) && Number(level) >= 0 && Number(level) <= 100);
    if (
      !devicesValid(snapshot.inputs) ||
      !devicesValid(snapshot.outputs) ||
      (snapshot.inputId !== undefined &&
        snapshot.inputId !== null &&
        typeof snapshot.inputId !== "string") ||
      (snapshot.canSwitchInput !== undefined &&
        typeof snapshot.canSwitchInput !== "boolean") ||
      (snapshot.canSwitchOutput !== undefined &&
        typeof snapshot.canSwitchOutput !== "boolean") ||
      (snapshot.outputs !== undefined &&
        (!Array.isArray(snapshot.outputs) ||
          snapshot.outputs.some(
            (output) =>
              !output ||
              typeof output.id !== "string" ||
              !output.id ||
              typeof output.name !== "string",
          ))) ||
      (snapshot.sessions !== undefined &&
        (!Array.isArray(snapshot.sessions) ||
          snapshot.sessions.some(
            (session) =>
              !session ||
              typeof session.id !== "string" ||
              typeof session.name !== "string" ||
              typeof session.outputId !== "string" ||
              !["communication", "audio-only"].includes(session.kind) ||
              !levelValid(session.volume) ||
              (session.muted != null && typeof session.muted !== "boolean") ||
              (session.canControl !== undefined &&
                typeof session.canControl !== "boolean") ||
              (session.mixed !== undefined &&
                typeof session.mixed !== "boolean") ||
              (session.source !== undefined &&
                typeof session.source !== "string"),
          )))
    )
      return false;
    if (
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 0 ||
      snapshot.revision <= this.audio.revision ||
      !Number.isInteger(snapshot.volume) ||
      snapshot.volume < 0 ||
      snapshot.volume > 100
    )
      return false;
    this.audio = Object.freeze({
      ...snapshot,
      outputs: Object.freeze(
        (snapshot.outputs ?? []).map((output) => Object.freeze({ ...output })),
      ),
      inputs: Object.freeze(
        (snapshot.inputs ?? []).map((input) => Object.freeze({ ...input })),
      ),
      sessions: Object.freeze(
        (snapshot.sessions ?? []).map((session) =>
          Object.freeze({ ...session }),
        ),
      ),
    });
    for (const subscriber of this.audioSubscribers) subscriber(this.audio);
    return true;
  }
  setAudioController(controller?: AudioController): Unlisten {
    this.audioController = controller;
    return () => {
      if (this.audioController === controller) this.audioController = undefined;
    };
  }
  async controlAudio(action: AudioAction): Promise<void> {
    const epoch = this.epoch;
    const switches = [action.outputId, action.inputId].filter(
      (id) => id !== undefined,
    ).length;
    const session = this.audio.sessions?.find(
      (session) => session.id === action.sessionId,
    );
    if (
      !this.audioController ||
      (!switches && !this.audio.available) ||
      (!switches && action.deviceId !== this.audio.deviceId) ||
      (action.volume === undefined &&
        action.muted === undefined &&
        !switches) ||
      switches > 1 ||
      (switches > 0 &&
        (action.sessionId !== undefined ||
          action.volume !== undefined ||
          action.muted !== undefined)) ||
      (action.inputId !== undefined &&
        (!this.audio.canSwitchInput ||
          !this.audio.inputs?.some((input) => input.id === action.inputId))) ||
      (action.sessionId !== undefined &&
        (!session?.canControl ||
          session.volume == null ||
          session.muted == null)) ||
      (action.outputId !== undefined &&
        (!this.audio.canSwitchOutput ||
          !this.audio.outputs?.some(
            (output) => output.id === action.outputId,
          ) ||
          action.volume !== undefined ||
          action.muted !== undefined)) ||
      (action.volume !== undefined &&
        (!Number.isInteger(action.volume) ||
          action.volume < 0 ||
          action.volume > 100)) ||
      (action.muted !== undefined && typeof action.muted !== "boolean")
    )
      throw new Error("Windows audio is unavailable or the output changed");
    const confirmed = await this.audioController(action);
    if (epoch === this.epoch) this.applyAudio(confirmed);
  }

  snapshot(): StoredMediaSnapshot {
    return this.current;
  }

  subscribe(subscriber: Subscriber): Unlisten {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  apply(message: MediaSnapshot): boolean {
    if (
      !Number.isSafeInteger(message.revision) ||
      message.revision < 0 ||
      message.revision <= this.current.revision
    )
      return false;
    const artwork = this.artwork.replace(
      message.state.playbackState === "none" ? null : message.player?.artwork?.dataUrl ?? null,
    );
    this.current = Object.freeze({
      revision: message.revision,
      state: Object.freeze({ ...message.state }),
      player:
        message.state.playbackState === "none"
          ? freezeMediaPlayer()
          : freezeMediaPlayer(message.player && {
              ...message.player,
              artwork: artwork.url ? { dataUrl: artwork.url } : null,
            }),
    });
    try {
      this.notify();
    } finally {
      // Synchronous consumers have replaced their img/CSS references before the
      // previous URL is revoked, including when a subscriber throws.
      artwork.release();
    }
    return true;
  }

  /** Entry-point teardown; ordinary hide/show keeps only the current image. */
  dispose(): void {
    this.generation++;
    this.subscribers.clear();
    this.audioSubscribers.clear();
    this.controller = undefined;
    this.audioController = undefined;
    this.audio = unavailableAudio();
    this.artwork.replace(null).release();
    this.current = Object.freeze({ revision: -1, state: Object.freeze(createMediaState()), player: freezeMediaPlayer() });
  }

  /** A missing bridge must not replace data already received from an event. */
  unavailable(): void {
    if (
      this.current.revision >= 0 ||
      this.current.state.providerStatus === "unavailable"
    )
      return;
    this.current = Object.freeze({
      revision: -1,
      state: Object.freeze(createMediaState("unavailable")),
      player: freezeMediaPlayer(),
    });
    this.notify();
  }

  setController(controller?: MediaController): Unlisten {
    this.controller = controller;
    return () => {
      if (this.controller === controller) this.controller = undefined;
    };
  }

  async control(action: MediaAction): Promise<void> {
    const { state, player } = this.current;
    if (
      !this.controller ||
      state.providerStatus !== "ready" ||
      !player.sessionId ||
      (typeof action === "string" && !["previous", "play", "pause", "next"].includes(action)) ||
      ["none", "unknown", "closed", "changing"].includes(state.playbackState) ||
      !player.controls[
        typeof action === "string"
          ? action
          : "seekMs" in action
            ? "seek"
            : "shuffle" in action ? "shuffle" : "repeatMode" in action ? "repeat" : "volume"
      ] ||
      (typeof action !== "string" &&
        ("seekMs" in action
          ? !Number.isSafeInteger(action.seekMs) ||
            action.seekMs < 0 ||
            !player.timeline ||
            action.seekMs > player.timeline.durationMs
          : "shuffle" in action ? typeof action.shuffle !== "boolean" || player.shuffle == null
          : "repeatMode" in action ? !["off", "list", "track"].includes(action.repeatMode) || player.repeatMode == null
          : !Number.isInteger(action.volume) ||
            action.volume < 0 ||
            action.volume > 100))
    ) {
      throw new Error("This player does not support that action");
    }
    const current = this.flights.get(player.sessionId);
    if (current) {
      if (JSON.stringify(current.action) === JSON.stringify(action))
        return current.promise;
      throw new Error("A media action is already in progress");
    }
    const session = player.sessionId;
    // Register before invoking so even a synchronous bridge callback cannot duplicate a command.
    const controller = this.controller;
    const promise = Promise.resolve().then(() => controller(session, action));
    this.flights.set(session, { action, promise });
    try {
      await promise;
    } finally {
      if (this.flights.get(session)?.promise === promise)
        this.flights.delete(session);
    }
  }

  /** Makes the notch show and control another app's media session. */
  async selectSession(id: string): Promise<void> {
    if (!this.controller || this.current.state.providerStatus !== "ready") return;
    await this.controller(id, "select");
  }

  private notify(): void {
    const snapshot = this.current;
    for (const subscriber of this.subscribers) subscriber(snapshot);
  }
}

export async function connectAudioStore(
  store: MediaStore,
  transport: {
    listen(receive: (snapshot: AudioSnapshot) => void): Promise<Unlisten>;
    snapshot(): Promise<AudioSnapshot>;
    control: AudioController;
  },
  report: (message: string, error: unknown) => void = console.error,
): Promise<Unlisten> {
  let active = true;
  const epoch = store.epoch;
  const stopController = store.setAudioController(transport.control);
  let stop: Unlisten;
  try {
    stop = await transport.listen((snapshot) => {
      if (active && epoch === store.epoch) store.applyAudio(snapshot);
    });
  } catch (error) {
    stopController();
    report("[mimo] audio listener failed", error);
    return () => {};
  }
  try {
    const snapshot = await transport.snapshot();
    if (epoch === store.epoch) store.applyAudio(snapshot);
  } catch (error) {
    report("[mimo] get_audio_state failed", error);
  }
  return () => {
    active = false;
    stopController();
    stop();
  };
}

export const mediaStore = new MediaStore();

export interface MediaTransport {
  listen(receive: (snapshot: MediaSnapshot) => void): Promise<Unlisten>;
  snapshot(): Promise<MediaSnapshot>;
  control?: MediaController;
}

/** Listener registration precedes the fetch; events and snapshots share a guard. */
export async function connectMediaStore(
  store: MediaStore,
  transport: MediaTransport,
  report: (message: string, error: unknown) => void = console.error,
): Promise<Unlisten> {
  let active = true;
  const epoch = store.epoch;
  const stopController = store.setController(transport.control);
  let unlisten: Unlisten;
  try {
    unlisten = await transport.listen((snapshot) => {
      if (active && epoch === store.epoch) store.apply(snapshot);
    });
  } catch (error) {
    active = false;
    stopController();
    store.unavailable();
    report("[mimo] media listener registration failed", error);
    return () => {};
  }

  try {
    const snapshot = await transport.snapshot();
    if (epoch === store.epoch) store.apply(snapshot);
  } catch (error) {
    store.unavailable();
    report("[mimo] get_media_state failed", error);
  }
  // Keep listening after a failed initial fetch so later events can recover.
  return () => {
    if (!active) return;
    active = false;
    stopController();
    unlisten();
  };
}
