// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSource } from "./ts-test-loader.mjs";

const { MediaStore, connectAudioStore } = await import(
  await loadSource("../src/core/media-store.ts")
);
const { AudioInteraction, sharedAudioInteraction } = await import(
  await loadSource("../src/core/master-audio.ts")
);
const wait = (ms = 65) => new Promise((resolve) => setTimeout(resolve, ms));
const state = (revision = 0, volume = 48, deviceId = "speakers") => ({
  revision,
  volume,
  deviceId,
  available: true,
  muted: false,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("drag feedback is immediate; bridge writes serialize and keep only the latest value", async () => {
  const store = new MediaStore();
  store.applyAudio(state());
  const calls = [];
  const first = deferred();
  store.setAudioController(async (action) => {
    calls.push(action);
    if (calls.length === 1) await first.promise;
    return {
      ...store.audioSnapshot(),
      ...action,
      revision: store.audioSnapshot().revision + 1,
    };
  });
  const interaction = new AudioInteraction(store, () => {});
  try {
    interaction.begin();
    interaction.volume(49);
    for (let volume = 50; volume <= 82; volume++) interaction.volume(volume);
    assert.equal(interaction.snapshot().volume, 82);
    assert.equal(store.audioSnapshot().volume, 48);
    assert.equal(calls.length, 1);
    store.applyAudio(state(1, 15)); // Keyboard volume during the drag never pulls the thumb away.
    assert.equal(interaction.snapshot().volume, 82);
    interaction.end();
    first.resolve();
    await wait();
    assert.deepEqual(
      calls.map((action) => action.volume),
      [49, 82],
    );
    assert.equal(store.audioSnapshot().volume, 82);
    interaction.volume(82);
    await wait();
    assert.equal(calls.length, 2); // change/pointerup never duplicate the final write.
    store.applyAudio(state(5, 21));
    assert.equal(interaction.snapshot().volume, 21);
  } finally {
    interaction.destroy();
  }
});

test("failed audio commands return to confirmed volume and allow immediate recovery", async () => {
  const store = new MediaStore();
  store.applyAudio(state());
  const flight = deferred();
  store.setAudioController(() => flight.promise);
  const interaction = new AudioInteraction(store, () => {});
  interaction.volume(50, true);
  assert.equal(interaction.snapshot().volume, 50);
  flight.reject(new Error("Endpoint lost"));
  await wait(0);
  assert.equal(interaction.snapshot().volume, 48);
  assert.equal(interaction.error, true);
  store.setAudioController(async (action) => ({
    ...store.audioSnapshot(),
    ...action,
    revision: 1,
  }));
  interaction.mute();
  assert.equal(interaction.snapshot().muted, true);
  await wait(0);
  assert.equal(store.audioSnapshot().volume, 48);
  assert.equal(store.audioSnapshot().muted, true);
  interaction.mute();
  await wait(0); // Same native revision is ignored, no invented confirmation.
  assert.equal(interaction.snapshot().muted, true);
  interaction.destroy();
});

test("output changes cancel old drag intent; a late failure cannot overwrite the new output", async () => {
  const store = new MediaStore();
  store.applyAudio(state());
  const old = deferred();
  const calls = [];
  store.setAudioController(async (action) => {
    calls.push(action);
    if (action.deviceId === "speakers") return old.promise;
    return { ...store.audioSnapshot(), ...action, revision: 3 };
  });
  const interaction = new AudioInteraction(store, () => {});
  interaction.begin();
  interaction.volume(90);
  store.applyAudio(state(2, 18, "headphones"));
  assert.equal(interaction.snapshot().volume, 18);
  interaction.volume(20, true);
  old.reject(new Error("Output changed"));
  await wait();
  assert.equal(interaction.snapshot().volume, 20);
  assert.equal(interaction.error, false);
  assert.deepEqual(
    calls.map((action) => action.deviceId),
    ["speakers", "headphones"],
  );
  interaction.destroy();
});

test("audio transport registers before fetching, ignores stale replies, and unregisters on stop", async () => {
  const store = new MediaStore();
  const order = [];
  let receive;
  let stopped = false;
  const stop = await connectAudioStore(store, {
    listen: async (callback) => {
      order.push("listen");
      receive = callback;
      receive(state(5, 20));
      return () => {
        stopped = true;
      };
    },
    snapshot: async () => {
      order.push("snapshot");
      return state(4, 80);
    },
    control: async () => state(6, 22),
  });
  assert.deepEqual(order, ["listen", "snapshot"]);
  assert.equal(store.audioSnapshot().volume, 20);
  await store.controlAudio({ deviceId: "speakers", volume: 22 });
  assert.equal(store.audioSnapshot().volume, 22);
  stop();
  receive(state(7, 99));
  assert.equal(stopped, true);
  assert.equal(store.audioSnapshot().volume, 22);
  await assert.rejects(
    store.controlAudio({ deviceId: "speakers", volume: 24 }),
  );
});

test("controllers share one interaction queue and confirm output changes without inventing volume", async () => {
  const store = new MediaStore();
  store.applyAudio({
    ...state(),
    canSwitchOutput: true,
    outputs: [
      { id: "speakers", name: "Speakers" },
      { id: "headphones", name: "Headphones" },
    ],
    sessions: [],
  });
  const home = sharedAudioInteraction(store);
  const media = sharedAudioInteraction(store);
  assert.equal(home, media);
  const flight = deferred();
  const calls = [];
  store.setAudioController((action) => {
    calls.push(action);
    return flight.promise;
  });
  const switching = home.output("headphones");
  void media.output("headphones");
  media.volume(90);
  assert.equal(media.switching, true);
  assert.equal(home.snapshot().deviceId, "speakers");
  assert.equal(home.snapshot().volume, 48);
  assert.deepEqual(calls, [{ deviceId: "speakers", outputId: "headphones" }]);
  flight.resolve({
    ...store.audioSnapshot(),
    revision: 1,
    deviceId: "headphones",
    volume: 32,
  });
  await switching;
  assert.equal(media.snapshot().deviceId, "headphones");
  assert.equal(home.snapshot().volume, 32);
  assert.equal(home.switching, false);
  store.setAudioController(async () => {
    throw new Error("disconnected");
  });
  await home.output("speakers");
  assert.equal(media.snapshot().deviceId, "headphones");
  assert.equal(home.error, true);
  home.destroy();
});

test("output/activity payloads are immutable and malformed snapshots cannot erase confirmed audio", () => {
  const store = new MediaStore();
  const outputs = [{ id: "speakers", name: "Speakers" }];
  const sessions = [
    {
      id: "teams",
      name: "Microsoft Teams",
      kind: "communication",
      outputId: "speakers",
    },
  ];
  assert.equal(store.applyAudio({ ...state(), outputs, sessions }), true);
  outputs[0].name = "changed";
  sessions[0].name = "changed";
  assert.equal(store.audioSnapshot().outputs[0].name, "Speakers");
  assert.equal(store.audioSnapshot().sessions[0].name, "Microsoft Teams");
  assert.ok(Object.isFrozen(store.audioSnapshot().sessions[0]));
  for (const patch of [
    { outputs: null },
    { outputs: [{}] },
    { sessions: [{ kind: "song" }] },
    { canSwitchOutput: "yes" },
  ])
    assert.equal(store.applyAudio({ ...state(1), ...patch }), false);
  assert.equal(store.audioSnapshot().revision, 0);
});

test("session mixer commands target only a current controllable app and preserve master audio", async () => {
  const store = new MediaStore();
  const spotify = {
    id: "spotify",
    name: "Spotify",
    kind: "audio-only",
    outputId: "speakers",
    source: "spotify.exe",
    volume: 80,
    muted: false,
    canControl: true,
  };
  store.applyAudio({ ...state(), sessions: [spotify] });
  const calls = [];
  store.setAudioController(async (action) => {
    calls.push(action);
    return {
      ...store.audioSnapshot(),
      revision: store.audioSnapshot().revision + 1,
      sessions: [
        {
          ...spotify,
          volume: action.volume ?? spotify.volume,
          muted: action.muted ?? spotify.muted,
        },
      ],
    };
  });
  await store.controlAudio({
    deviceId: "speakers",
    sessionId: "spotify",
    volume: 45,
  });
  assert.equal(store.audioSnapshot().sessions[0].volume, 45);
  assert.equal(store.audioSnapshot().volume, 48);
  await assert.rejects(
    store.controlAudio({
      deviceId: "speakers",
      sessionId: "expired",
      volume: 90,
    }),
  );
  assert.equal(calls.length, 1);
});

test("input switching validates real devices and reconciles the confirmed microphone", async () => {
  const store = new MediaStore();
  store.applyAudio({
    ...state(),
    inputId: "mic",
    inputs: [
      { id: "mic", name: "Microphone" },
      { id: "usb", name: "USB Microphone" },
    ],
    canSwitchInput: true,
  });
  store.setAudioController(async (action) => ({
    ...store.audioSnapshot(),
    revision: 1,
    inputId: action.inputId,
  }));
  await store.controlAudio({ deviceId: "speakers", inputId: "usb" });
  assert.equal(store.audioSnapshot().inputId, "usb");
  await assert.rejects(
    store.controlAudio({ deviceId: "speakers", inputId: "missing" }),
  );
  await assert.rejects(
    store.controlAudio({ deviceId: "speakers", inputId: "mic", volume: 40 }),
  );
});

test("malformed app levels and input inventory do not replace authoritative audio", () => {
  const store = new MediaStore();
  store.applyAudio(state());
  for (const patch of [
    { inputs: null },
    { inputId: 3 },
    { canSwitchInput: "yes" },
    {
      sessions: [
        {
          id: "a",
          name: "App",
          kind: "audio-only",
          outputId: "speakers",
          volume: 101,
        },
      ],
    },
  ])
    assert.equal(store.applyAudio({ ...state(1), ...patch }), false);
  assert.equal(store.audioSnapshot().revision, 0);
});
