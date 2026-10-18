// SPDX-License-Identifier: MIT
/** Authoritative Windows audio inventory; independent of GSMTC metadata. */
export interface AudioSession {
  readonly id: string;
  readonly name: string;
  readonly kind: "communication" | "audio-only";
  readonly outputId: string;
  readonly source?: string;
  readonly volume?: number | null;
  readonly muted?: boolean | null;
  readonly canControl?: boolean;
  readonly mixed?: boolean;
}
export interface AudioSnapshot {
  readonly revision: number;
  readonly available: boolean;
  readonly deviceId: string | null;
  readonly volume: number;
  readonly muted: boolean;
  readonly outputs?: readonly { readonly id: string; readonly name: string }[];
  readonly canSwitchOutput?: boolean;
  readonly inputId?: string | null;
  readonly inputs?: readonly { readonly id: string; readonly name: string }[];
  readonly canSwitchInput?: boolean;
  readonly sessions?: readonly AudioSession[];
}
export interface AudioAction {
  readonly deviceId: string;
  readonly volume?: number;
  readonly muted?: boolean;
  readonly outputId?: string;
  readonly inputId?: string;
  readonly sessionId?: string;
}
export type AudioController = (action: AudioAction) => Promise<AudioSnapshot>;
export const unavailableAudio = (): AudioSnapshot =>
  Object.freeze({
    revision: -1,
    available: false,
    deviceId: null,
    volume: 0,
    muted: false,
  });

import type { MediaStore } from "./media-store";

/** Local drag feedback only. One native write in flight, with a latest-value queue. */
export class AudioInteraction {
  private desired: AudioAction | null = null;
  private queued = false;
  private flight = false;
  private dragging = false;
  private disposed = false;
  private lastWrite = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stop: () => void;
  error = false;
  switching = false;
  private listeners = new Set<() => void>();

  constructor(
    private store: MediaStore,
    changed?: () => void,
    private sessionId?: string,
  ) {
    if (changed) this.listeners.add(changed);
    this.stop = store.subscribeAudio(() => {
      const native = this.snapshotFromStore();
      if (
        !native.available ||
        (this.desired && native.deviceId !== this.desired.deviceId)
      ) {
        this.cancel();
      }
      this.changed();
    });
  }

  subscribe(changed: () => void): () => void {
    this.listeners.add(changed);
    return () => this.listeners.delete(changed);
  }
  get observers(): number {
    return this.listeners.size;
  }
  private changed(): void {
    for (const changed of this.listeners) changed();
  }

  async output(outputId: string): Promise<void> {
    await this.device(outputId, false);
  }
  async input(inputId: string): Promise<void> {
    await this.device(inputId, true);
  }
  private async device(id: string, input: boolean): Promise<void> {
    const current = this.store.audioSnapshot();
    if (this.switching || (input ? current.inputId : current.deviceId) === id)
      return;
    this.cancel();
    this.switching = true;
    this.error = false;
    this.changed();
    try {
      await this.store.controlAudio({
        deviceId: current.deviceId ?? "",
        ...(input ? { inputId: id } : { outputId: id }),
      });
    } catch {
      this.error = true;
    } finally {
      this.switching = false;
      this.changed();
    }
  }

  snapshot(): AudioSnapshot {
    const native = this.snapshotFromStore();
    return this.desired ? { ...native, ...this.desired } : native;
  }
  private snapshotFromStore(): AudioSnapshot {
    const native = this.store.audioSnapshot();
    if (!this.sessionId) return native;
    const session = native.sessions?.find(
      (session) => session.id === this.sessionId,
    );
    return {
      ...native,
      available: native.available && !!session?.canControl,
      volume: session?.volume ?? 0,
      muted: session?.muted ?? false,
    };
  }

  begin(): void {
    this.dragging = true;
  }
  end(): void {
    this.dragging = false;
    if (this.queued) void this.flush();
    else if (!this.flight) {
      this.desired = null;
      this.changed();
    }
  }

  volume(value: number, immediate = false): void {
    if (this.switching) return;
    const current = this.snapshot();
    if (!current.available || !current.deviceId || !Number.isFinite(value))
      return;
    const volume = Math.round(Math.max(0, Math.min(100, value)));
    if (volume === current.volume && !current.muted) return;
    this.desired = {
      deviceId: current.deviceId,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      volume,
      muted: false,
    };
    this.enqueue(immediate);
  }

  mute(): void {
    if (this.switching) return;
    const current = this.snapshot();
    if (!current.available || !current.deviceId) return;
    this.desired = {
      deviceId: current.deviceId,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      volume: current.volume,
      muted: !current.muted,
    };
    this.enqueue(true);
  }

  private enqueue(immediate: boolean): void {
    this.error = false;
    this.queued = true;
    this.changed();
    if (this.flight) return;
    clearTimeout(this.timer);
    const wait = immediate
      ? 0
      : Math.max(0, 40 - (Date.now() - this.lastWrite));
    if (!wait) void this.flush();
    else this.timer = setTimeout(() => void this.flush(), wait);
  }

  private async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.disposed || this.flight || !this.queued || !this.desired) return;
    const action = this.desired;
    this.queued = false;
    this.flight = true;
    this.lastWrite = Date.now();
    try {
      await this.store.controlAudio(action);
    } catch {
      // A late reply for the former output must not erase a new output's intent.
      if (this.store.audioSnapshot().deviceId === action.deviceId) {
        this.cancel();
        this.error = true;
      }
    } finally {
      this.flight = false;
      if (this.disposed) return;
      if (this.queued)
        this.timer = setTimeout(
          () => void this.flush(),
          Math.max(0, 40 - (Date.now() - this.lastWrite)),
        );
      else if (!this.dragging) this.desired = null;
      this.changed();
    }
  }

  cancel(): void {
    clearTimeout(this.timer);
    this.desired = null;
    this.queued = false;
    this.dragging = false;
  }
  destroy(): void {
    this.disposed = true;
    this.cancel();
    this.stop();
  }
}

const interactions = new WeakMap<MediaStore, Map<string, AudioInteraction>>();
/** All controller instances in a view share the same drag intent and command queue. */
export function sharedAudioInteraction(
  store: MediaStore,
  sessionId?: string,
): AudioInteraction {
  let group = interactions.get(store);
  if (!group) {
    group = new Map();
    interactions.set(store, group);
  }
  const key = sessionId ?? "master";
  let interaction = group.get(key);
  if (!interaction) {
    interaction = new AudioInteraction(store, undefined, sessionId);
    group.set(key, interaction);
  }
  return interaction;
}

export function releaseAudioInteraction(
  store: MediaStore,
  sessionId?: string,
): void {
  const key = sessionId ?? "master";
  const group = interactions.get(store),
    interaction = group?.get(key);
  if (interaction && !interaction.observers) {
    interaction.destroy();
    group!.delete(key);
  }
}
