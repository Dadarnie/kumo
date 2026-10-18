// SPDX-License-Identifier: MIT
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  connectMediaStore,
  connectAudioStore,
  mediaStore,
  type MediaSnapshot,
  type MediaStore,
} from "./media-store";
import { audioLevels, type AudioLevel } from "./audio-levels";
import type { AudioSnapshot } from "./master-audio";

// Visibility can flip while a previous IPC is pending. Serialize the compact
// demand changes so an older hide cannot stop a newly visible waveform.
let meterCommands: Promise<unknown> = Promise.resolve();
function meterDemand(active: boolean): void {
  meterCommands = meterCommands
    .then(() => invoke("set_audio_meter_active", { active }))
    .catch(error => console.error("[mimo] audio metering failed", error));
}

const audioConnections = new WeakMap<
  MediaStore,
  { users: number; ready: Promise<() => void> }
>();
const mediaConnections = new WeakMap<
  MediaStore,
  { users: number; ready: Promise<() => void> }
>();
/** One audio bridge subscription per webview, mirroring the one native runtime. */
export async function startAudioStore(
  store: MediaStore = mediaStore,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  let connection = audioConnections.get(store);
  if (!connection) {
    connection = {
      users: 0,
      ready: Promise.all([
        connectAudioStore(store, {
          listen: (receive) =>
            listen<AudioSnapshot>("audio-changed", (event) =>
              receive(event.payload),
            ),
          snapshot: () => invoke<AudioSnapshot>("get_audio_state"),
          control: (action) =>
            invoke<AudioSnapshot>("audio_control", { action }),
        }),
        listen<AudioLevel>("audio-levels", (event) =>
          audioLevels.apply(event.payload),
        ).catch(() => () => {}),
      ]).then((stops) => {
        stops.push(audioLevels.onDemand(meterDemand));
        return () => stops.forEach(stop => stop());
      }),
    };
    audioConnections.set(store, connection);
  }
  connection.users++;
  const stop = await connection.ready;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (--connection.users === 0) {
      stop();
      audioConnections.delete(store);
    }
  };
}

/** Share a single native media subscription across all owners in this webview. */
export async function startMediaStore(
  store: MediaStore = mediaStore,
): Promise<() => void> {
  if (!isTauri()) {
    store.unavailable();
    return () => {};
  }
  let connection = mediaConnections.get(store);
  if (!connection) {
    connection = {
      users: 0,
      ready: Promise.all([
        connectMediaStore(store, {
          listen: (receive) =>
            listen<MediaSnapshot>("media-changed", (event) => receive(event.payload)),
          snapshot: () => invoke<MediaSnapshot>("get_media_state"),
          control: async (sessionId, action) => {
            const epoch = store.epoch;
            const confirmed = await invoke<MediaSnapshot>("media_control", { sessionId, action });
            if (confirmed && epoch === store.epoch) store.apply(confirmed);
          },
        }),
        startAudioStore(store),
      ]).then(stops => () => stops.forEach(stop => stop())),
    };
    mediaConnections.set(store, connection);
  }
  connection.users++;
  const stop = await connection.ready;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (--connection.users === 0) {
      stop();
      mediaConnections.delete(store);
    }
  };
}
