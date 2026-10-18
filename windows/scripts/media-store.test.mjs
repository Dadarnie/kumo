// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

import { loadSource } from "./ts-test-loader.mjs";

const { MediaStore, mediaStore, connectMediaStore } = await import(
  await loadSource("../src/core/media-store.ts")
);
const { createMediaState, withMediaSession } = await import(
  await loadSource("../src/core/media.ts")
);
const { startMediaStore } = await import(
  await loadSource("../src/core/media-bridge.ts")
);
const { timelinePosition, mediaTime } = await import(
  await loadSource("../src/core/media-player.ts")
);
const { State } = await import(await loadSource("../src/core/state.ts"));

test("seeking requires a current capability and an in-range real timeline", async () => {
  const store = new MediaStore(),
    calls = [];
  store.setController(async (session, action) => calls.push(action));
  const snapshot = {
    revision: 1,
    state: withMediaSession({ playbackState: "playing", title: "Video" }),
    player: {
      sessionId: "video",
      controls: {
        previous: true,
        play: true,
        pause: true,
        next: true,
        seek: true,
      },
      artwork: null,
      timeline: {
        positionMs: 1000,
        durationMs: 300000,
        updatedAtUnixMs: 0,
        playbackRateMilli: 0,
      },
    },
  };
  store.apply(snapshot);
  for (const seekMs of [-1, 300001, NaN, Infinity, 1.5])
    await assert.rejects(store.control({ seekMs }));
  await store.control({ seekMs: 90000 });
  assert.deepEqual(calls, [{ seekMs: 90000 }]);
  assert.equal(store.snapshot().player.timeline.positionMs, 1000);
  store.apply({
    ...snapshot,
    revision: 2,
    player: {
      ...snapshot.player,
      controls: { ...snapshot.player.controls, seek: false },
    },
  });
  await assert.rejects(store.control({ seekMs: 90000 }));
});

test("unstructured mode commands are rejected even if a stale payload advertises them", async () => {
  const store = new MediaStore(),
    calls = [];
  store.setController(async (session, action) => calls.push([session, action]));
  store.apply({
    revision: 1,
    state: withMediaSession({ playbackState: "playing", title: "Track" }),
    player: {
      sessionId: "generic-session",
      controls: {
        previous: true,
        play: true,
        pause: true,
        next: true,
        repeat: true,
        shuffle: true,
      },
      artwork: null,
      repeatMode: "list",
      shuffleActive: true,
    },
  });
  for (const action of ["repeat", "shuffle"])
    await assert.rejects(store.control(action));
  await store.control("previous");
  await store.control("pause");
  await store.control("next");
  assert.deepEqual(
    calls.map(([, action]) => action),
    ["previous", "pause", "next"],
  );
  assert.equal(store.snapshot().player.repeatMode, "list");
  assert.equal(store.snapshot().player.shuffleActive, undefined);
});

test("repeat and shuffle require reported modes and wait for native confirmation", async () => {
  const store = new MediaStore(), calls = [];
  store.setController(async (session, action) => calls.push([session, action]));
  const snapshot = {revision:1,state:withMediaSession({playbackState:'playing',title:'Track'}),
    player:{sessionId:'one',controls:{shuffle:true,repeat:true},artwork:null,shuffle:false,repeatMode:'off'}};
  store.apply(snapshot);
  await store.control({shuffle:true});await store.control({repeatMode:'list'});
  assert.deepEqual(calls,[['one',{shuffle:true}],['one',{repeatMode:'list'}]]);
  assert.equal(store.snapshot().player.shuffle,false);
  assert.equal(store.snapshot().player.repeatMode,'off','An accepted command cannot fabricate a confirmed mode');
  for(const action of [{shuffle:'true'},{repeatMode:'all'}]) await assert.rejects(store.control(action));
  store.apply({...snapshot,revision:2,player:{...snapshot.player,shuffle:true,repeatMode:'list'}});
  assert.equal(store.snapshot().player.shuffle,true);assert.equal(store.snapshot().player.repeatMode,'list');
  store.apply({...snapshot,revision:3,player:{...snapshot.player,shuffle:null,repeatMode:null}});
  await assert.rejects(store.control({shuffle:true}));await assert.rejects(store.control({repeatMode:'list'}));
  store.apply({...snapshot,revision:4,player:{...snapshot.player,controls:{}}});
  await assert.rejects(store.control({shuffle:true}));await assert.rejects(store.control({repeatMode:'list'}));
});

test("timeline projection advances only known playing time and clamps to duration", () => {
  const timeline = {
    positionMs: 84000,
    durationMs: 252000,
    updatedAtUnixMs: 1000,
    playbackRateMilli: 1000,
  };
  assert.equal(timelinePosition(timeline, true, 3000), 86000);
  assert.equal(timelinePosition(timeline, false, 3000), 84000);
  assert.equal(timelinePosition(timeline, true, 0), 84000);
  assert.equal(timelinePosition(timeline, true, 999999), 252000);
  assert.equal(
    timelinePosition({ ...timeline, playbackRateMilli: null }, true, 3000),
    86000,
  );
  assert.equal(
    timelinePosition({ ...timeline, playbackRateMilli: 0 }, true, 3000),
    84000,
  );
  assert.equal(
    timelinePosition({ ...timeline, playbackRateMilli: 2000 }, true, 3000),
    88000,
  );
  assert.equal(
    timelinePosition({ ...timeline, durationMs: 0 }, true, 3000),
    null,
  );
  assert.equal(mediaTime(84000), "1:24");
  assert.equal(mediaTime(252000), "4:12");
  assert.equal(mediaTime(null), "—:—");
});

test("timeline remains frozen and respects the same stale revision and session loss guards", () => {
  const store = new MediaStore();
  const timeline = {
    positionMs: 84000,
    durationMs: 252000,
    updatedAtUnixMs: 1000,
    playbackRateMilli: 1000,
  };
  const player = {
    sessionId: "one",
    controls: { previous: false, play: true, pause: true, next: true },
    artwork: null,
    timeline,
  };
  store.apply({ ...ready(2), player });
  timeline.positionMs = 0;
  assert.equal(store.snapshot().player.timeline.positionMs, 84000);
  assert.ok(Object.isFrozen(store.snapshot().player.timeline));
  store.apply({ ...ready(1), player });
  assert.equal(store.snapshot().player.timeline.positionMs, 84000);
  store.apply({ revision: 3, state: createMediaState("ready"), player });
  assert.equal(store.snapshot().player.timeline, null);
});

const ready = (revision, title = "Track") => ({
  revision,
  state: withMediaSession({ playbackState: "playing", title }),
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("50 artwork replacements keep one shared resource and release retired images", async (t) => {
  const store = new MediaStore();
  const live = new Set();
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  let created = 0;
  t.mock.method(URL, "createObjectURL", (blob) => {
    const url = create(blob);
    live.add(url);
    created++;
    assert.ok(live.size <= 2, "only the current and replacing image may overlap");
    return url;
  });
  t.mock.method(URL, "revokeObjectURL", (url) => {
    assert.ok(live.delete(url), "every object URL is released exactly once");
    revoke(url);
  });
  const stop = store.subscribe(({ player }) => {
    if (player.artwork) assert.ok(live.has(player.artwork.dataUrl));
  });
  const publish = (revision, bytes) => store.apply({
    ...ready(revision),
    player: { sessionId: "one", controls: {}, artwork: {
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
    } },
  });
  try {
    for (let i = 1; i <= 50; i++) {
      const bytes = Buffer.from(`artwork-${i}`);
      assert.ok(publish(i, bytes));
      assert.equal(live.size, 1);
      const url = store.snapshot().player.artwork.dataUrl;
      assert.match(url, /^blob:/);
      assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), bytes);
    }
    const url = store.snapshot().player.artwork.dataUrl;
    publish(51, Buffer.from("artwork-50"));
    assert.equal(store.snapshot().player.artwork.dataUrl, url);
    assert.equal(created, 50, "unchanged artwork is not reloaded");
    publish(49, Buffer.from("stale"));
    assert.equal(created, 50, "stale revisions cannot create image resources");
    store.apply({ ...store.snapshot(), revision: 52 });
    assert.equal(store.snapshot().player.artwork.dataUrl, url);
    store.apply({ revision: 53, state: createMediaState("ready") });
    assert.equal(live.size, 0, "session loss releases the last image");
    publish(54, Buffer.from("last"));
    stop();
    store.dispose();
    store.dispose();
    assert.equal(live.size, 0, "teardown releases artwork and is idempotent");
  } finally {
    stop();
    for (const url of live) revoke(url);
  }
});

test("invalid and oversized artwork falls back without allocating resources", (t) => {
  const store = new MediaStore();
  t.mock.method(URL, "createObjectURL", () => assert.fail("invalid artwork must not allocate"));
  for (const [i, dataUrl] of [
    "data:image/png;base64,!invalid!", "data:image/svg+xml;base64,PHN2Zz4=",
    `data:image/png;base64,${"A".repeat(6 * 1024 * 1024)}`,
  ].entries()) {
    store.apply({ ...ready(i + 1), player: { sessionId: "one", controls: {}, artwork: { dataUrl } } });
    assert.equal(store.snapshot().player.artwork, null);
  }
});

test("late media events and initialization replies cannot recreate disposed artwork", async (t) => {
  const store = new MediaStore(), pending = deferred();
  let receive, stopped = 0;
  t.mock.method(URL, "createObjectURL", () => assert.fail("a retired connection must not recreate artwork"));
  const connection = connectMediaStore(store, {
    listen: async callback => { receive = callback; return () => stopped++; },
    snapshot: () => pending.promise,
  });
  await Promise.resolve();
  store.dispose();
  const reply = { ...ready(1), player: { sessionId: "one", controls: {}, artwork: { dataUrl: "data:image/png;base64,ZXhhbXBsZQ==" } } };
  receive(reply);
  pending.resolve(reply);
  const stop = await connection;
  stop(); stop();
  assert.equal(stopped, 1);
  assert.equal(store.snapshot().revision, -1);
  assert.equal(store.snapshot().player.artwork, null);
});

test("repeated bridge starts share one media listener and stop only after the last owner", async () => {
  globalThis.isTauri = true;
  globalThis.window = { crypto: globalThis.crypto };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  const registrations = [], removals = [];
  mockIPC((command, payload) => {
    if (command === "set_audio_meter_active") return;
    if (command === "plugin:event|listen") {
      registrations.push(payload.event);
      return registrations.length;
    }
    if (command === "plugin:event|unlisten") {
      removals.push(payload.event);
      return;
    }
    if (command === "get_media_state") return ready(1);
    if (command === "get_audio_state") return { revision: 1, available: false, volume: 0, muted: false, deviceId: null };
    assert.fail(`unexpected command ${command}`);
  });
  try {
    const store = new MediaStore();
    const [first, second] = await Promise.all([startMediaStore(store), startMediaStore(store)]);
    assert.equal(registrations.filter(event => event === "media-changed").length, 1);
    assert.equal(registrations.length, 3);
    first();
    first();
    assert.equal(removals.length, 0);
    second();
    await Promise.resolve();
    assert.equal(removals.length, 3);
  } finally {
    await new Promise(resolve => setTimeout(resolve, 0));
    clearMocks();
    delete globalThis.window;
    delete globalThis.isTauri;
  }
});

test("rapid playback commands share one flight and never mutate confirmed state", async () => {
  const store = new MediaStore();
  const flight = deferred();
  const calls = [];
  store.apply({
    ...ready(1),
    player: {
      sessionId: "one",
      controls: { pause: true, next: true },
      artwork: null,
    },
  });
  store.setController((session, action) => {
    calls.push([session, action]);
    return flight.promise;
  });
  const first = store.control("pause");
  const duplicate = store.control("pause");
  const conflict = store.control("next").catch((error) => error);
  const failures = Promise.all([
    assert.rejects(first),
    assert.rejects(duplicate),
  ]);
  await Promise.resolve();
  const count = calls.length;
  flight.reject(new Error("Native failure"));
  await failures;
  assert.match((await conflict).message, /progress/);
  assert.equal(store.snapshot().state.playbackState, "playing");
  assert.equal(count, 1);
  store.setController(async () => calls.push("recovered"));
  await store.control("next");
  assert.equal(calls.at(-1), "recovered");
});

test("Windows master audio is independently revisioned and survives loss of media", async () => {
  const store = new MediaStore();
  assert.equal(store.audioSnapshot().available, false);
  assert.equal(
    store.applyAudio({
      revision: 2,
      available: true,
      volume: 48,
      muted: false,
      deviceId: "speakers",
    }),
    true,
  );
  assert.equal(
    store.applyAudio({
      revision: 1,
      available: true,
      volume: 95,
      muted: true,
      deviceId: "speakers",
    }),
    false,
  );
  const calls = [];
  store.setAudioController(async (action) => {
    calls.push(action);
    return {
      revision: 3,
      available: true,
      volume: 50,
      muted: false,
      deviceId: "speakers",
    };
  });
  await store.controlAudio({ volume: 50, muted: false, deviceId: "speakers" });
  assert.equal(store.audioSnapshot().volume, 50);
  assert.equal(store.snapshot().revision, -1);
  store.apply({ revision: 5, state: createMediaState("ready") });
  assert.equal(store.audioSnapshot().volume, 50);
  for (const volume of [-1, 101, 1.5, NaN])
    await assert.rejects(store.controlAudio({ volume, deviceId: "speakers" }));
  await assert.rejects(
    store.controlAudio({ volume: 20, deviceId: "old-device" }),
  );
  assert.equal(calls.length, 1);
});

test("player details share revision guards, are immutable, and clear on session loss", () => {
  const store = new MediaStore();
  const player = {
    sessionId: "session-1",
    controls: { play: true, pause: true, previous: false, next: true },
    artwork: { dataUrl: "data:image/png;base64,test" },
  };
  store.apply({ ...ready(1), player });
  player.controls.next = false;
  player.artwork.dataUrl = "Changed";
  assert.equal(store.snapshot().player.controls.next, true);
  assert.match(store.snapshot().player.artwork.dataUrl, /^blob:/);
  store.apply({ ...ready(1), player: { ...player, artwork: null } });
  assert.notEqual(store.snapshot().player.artwork, null);
  store.apply({ revision: 2, state: createMediaState("ready"), player });
  assert.equal(store.snapshot().player.sessionId, null);
  assert.equal(store.snapshot().player.artwork, null);
  assert.equal(store.snapshot().player.controls.next, false);
});

test("media controls use the current session token and never invent playback updates", async () => {
  const store = new MediaStore();
  const calls = [];
  store.setController(async (sessionId, action) =>
    calls.push({ sessionId, action }),
  );
  store.apply({
    ...ready(1),
    player: {
      sessionId: "session-1",
      controls: { play: false, pause: true, previous: false, next: true },
      artwork: null,
    },
  });
  await store.control("pause");
  assert.deepEqual(calls, [{ sessionId: "session-1", action: "pause" }]);
  assert.equal(store.snapshot().state.playbackState, "playing");
  await assert.rejects(store.control("previous"));
  store.apply({ revision: 2, state: createMediaState("ready") });
  await assert.rejects(store.control("next"));
  assert.equal(calls.length, 1);
});

test("media store accepts revision zero and ignores older or equal events", () => {
  const store = new MediaStore();
  assert.equal(store.snapshot().revision, -1);
  assert.equal(store.snapshot().state.providerStatus, "initializing");
  const received = [];
  const unsubscribe = store.subscribe((snapshot) => received.push(snapshot));
  assert.equal(store.apply(ready(0)), true);
  assert.equal(store.apply(ready(2, "Latest")), true);
  assert.equal(store.apply(ready(1, "Stale")), false);
  assert.equal(store.apply(ready(2, "Duplicate revision")), false);
  assert.equal(store.snapshot().state.title, "Latest");
  assert.equal(store.snapshot().revision, 2);
  assert.equal(received.length, 2);
  unsubscribe();
  store.apply(ready(3));
  assert.equal(received.length, 2);
});

test("media snapshots are read-only and malformed revisions are ignored", () => {
  const store = new MediaStore();
  const message = ready(0);
  store.apply(message);
  message.state.title = "Changed outside store";
  assert.equal(store.snapshot().state.title, "Track");
  assert.throws(() => {
    store.snapshot().state.title = "Changed by reader";
  });
  for (const revision of [
    -1,
    NaN,
    Infinity,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(store.apply(ready(revision)), false);
  }
  assert.equal(store.snapshot().revision, 0);
});

test("listener registration must finish before fetching the initial snapshot", async () => {
  const store = new MediaStore();
  const registration = deferred();
  const snapshot = deferred();
  const order = [];
  let receive;
  let unlistened = 0;
  const connection = connectMediaStore(
    store,
    {
      listen: (handler) => {
        order.push("listen");
        receive = handler;
        return registration.promise;
      },
      snapshot: () => {
        order.push("snapshot");
        return snapshot.promise;
      },
    },
    () => assert.fail("unexpected bridge failure"),
  );
  await Promise.resolve();
  assert.deepEqual(order, ["listen"]);
  receive(ready(2, "Event during registration"));
  registration.resolve(() => {
    unlistened += 1;
  });
  await Promise.resolve();
  assert.deepEqual(order, ["listen", "snapshot"]);
  receive(ready(3, "Event during fetch"));
  snapshot.resolve(ready(1, "Slow snapshot"));
  const stop = await connection;
  assert.equal(store.snapshot().revision, 3);
  assert.equal(store.snapshot().state.title, "Event during fetch");
  receive(ready(2, "Stale future event"));
  assert.equal(store.snapshot().revision, 3);
  stop();
  stop();
  assert.equal(unlistened, 1);
  receive(ready(4, "Queued after cleanup"));
  assert.equal(store.snapshot().revision, 3);
});

test("equal-revision initial snapshots cannot replace an event", async () => {
  const store = new MediaStore();
  await connectMediaStore(
    store,
    {
      listen: async (receive) => {
        receive(ready(1, "Event"));
        return () => {};
      },
      snapshot: async () => ready(1, "Snapshot"),
    },
    () => assert.fail("unexpected bridge failure"),
  );
  assert.equal(store.snapshot().state.title, "Event");
});

test("listener failure skips the snapshot fetch and reports unavailable media", async () => {
  const store = new MediaStore();
  const errors = [];
  const stop = await connectMediaStore(
    store,
    {
      listen: async () => {
        throw new Error("No Tauri bridge");
      },
      snapshot: async () => assert.fail("fetch before a registered listener"),
    },
    (...args) => errors.push(args),
  );
  assert.deepEqual(store.snapshot().state, createMediaState("unavailable"));
  assert.equal(store.snapshot().revision, -1);
  assert.equal(errors.length, 1);
  stop();
});

test("snapshot failure retains the listener so a later event can recover", async () => {
  const store = new MediaStore();
  let receive;
  const errors = [];
  await connectMediaStore(
    store,
    {
      listen: async (handler) => {
        receive = handler;
        return () => {};
      },
      snapshot: async () => {
        throw new Error("Snapshot failed");
      },
    },
    (...args) => errors.push(args),
  );
  assert.equal(store.snapshot().state.providerStatus, "unavailable");
  assert.equal(errors.length, 1);
  receive(ready(0));
  assert.equal(store.snapshot().state.providerStatus, "ready");
});

test("snapshot failure does not overwrite newer event data", async () => {
  const store = new MediaStore();
  await connectMediaStore(
    store,
    {
      listen: async (receive) => {
        receive(ready(5));
        return () => {};
      },
      snapshot: async () => {
        throw new Error("Snapshot failed");
      },
    },
    () => {},
  );
  assert.equal(store.snapshot().revision, 5);
  assert.equal(store.snapshot().state.title, "Track");
});

test("browser startup without a Tauri bridge resolves to unavailable media", async () => {
  const store = new MediaStore();
  assert.equal(globalThis.window, undefined);
  const stop = await startMediaStore(store);
  assert.equal(store.snapshot().state.providerStatus, "unavailable");
  assert.equal(store.snapshot().revision, -1);
  stop();
  const stopDefault = await startMediaStore();
  assert.equal(mediaStore.snapshot().state.providerStatus, "unavailable");
  stopDefault();
});

test("real Tauri adapter registers media-changed before invoking get_media_state", async () => {
  const store = new MediaStore();
  const order = [];
  let handler;
  let audioHandler;
  globalThis.window = { crypto: globalThis.crypto };
  globalThis.isTauri = true;
  mockIPC(async (command, payload) => {
    order.push(command);
    if (command === "set_audio_meter_active") return;
    if (command === "plugin:event|listen") {
      if (payload.event === "audio-levels") return 44;
      if (payload.event === "audio-changed") {
        audioHandler = payload.handler;
        window.__TAURI_INTERNALS__.runCallback(audioHandler, {
          payload: {
            revision: 4,
            available: true,
            volume: 48,
            muted: false,
            deviceId: "speakers",
          },
        });
        return 43;
      }
      assert.equal(payload.event, "media-changed");
      handler = payload.handler;
      window.__TAURI_INTERNALS__.runCallback(handler, {
        payload: ready(4, "New event"),
      });
      return 42;
    }
    if (command === "get_media_state") return ready(3, "Older snapshot");
    if (command === "get_audio_state")
      return {
        revision: 3,
        available: true,
        volume: 80,
        muted: false,
        deviceId: "speakers",
      };
    if (command === "audio_control")
      return {
        revision: 5,
        available: true,
        volume: payload.action.volume,
        muted: false,
        deviceId: "speakers",
      };
    if (command === "media_control") {
      assert.deepEqual(payload, {
        sessionId: "spotify-session",
        action: "pause",
      });
      return;
    }
    if (command === "plugin:event|unlisten") {
      if (payload.event === "audio-levels") {
        assert.equal(payload.eventId, 44);
        return;
      }
      if (payload.event === "audio-changed") {
        assert.equal(payload.eventId, 43);
        return;
      }
      assert.equal(payload.event, "media-changed");
      assert.equal(payload.eventId, 42);
      return;
    }
    assert.fail(`unexpected command ${command}`);
  });
  const unsubscribe = State.subscribe(() =>
    assert.fail("media must not notify island AppState"),
  );
  try {
    const stop = await startMediaStore(store);
    assert.deepEqual(order.filter(command => command !== "set_audio_meter_active"), [
      "plugin:event|listen",
      "plugin:event|listen",
      "plugin:event|listen",
      "get_media_state",
      "get_audio_state",
    ]);
    assert.equal(store.audioSnapshot().volume, 48);
    await store.controlAudio({ deviceId: "speakers", volume: 50 });
    assert.equal(store.audioSnapshot().volume, 50);
    assert.equal(store.snapshot().revision, 4);
    window.__TAURI_INTERNALS__.runCallback(handler, {
      payload: ready(5, "Next event"),
    });
    assert.equal(store.snapshot().state.title, "Next event");
    window.__TAURI_INTERNALS__.runCallback(handler, {
      payload: ready(4, "Stale event"),
    });
    assert.equal(store.snapshot().revision, 5);
    window.__TAURI_INTERNALS__.runCallback(handler, {
      payload: {
        ...ready(6),
        player: {
          sessionId: "spotify-session",
          controls: { previous: false, play: true, pause: true, next: true },
          artwork: null,
        },
      },
    });
    await store.control("pause");
    assert.equal(store.snapshot().state.playbackState, "playing");
    stop();
    await assert.rejects(store.control("pause"));
    assert.deepEqual(order.filter(command => command !== "set_audio_meter_active"), [
      "plugin:event|listen",
      "plugin:event|listen",
      "plugin:event|listen",
      "get_media_state",
      "get_audio_state",
      "audio_control",
      "media_control",
      "plugin:event|unlisten",
      "plugin:event|unlisten",
      "plugin:event|unlisten",
    ]);
  } finally {
    unsubscribe();
    await new Promise(resolve => setTimeout(resolve, 0));
    clearMocks();
    delete globalThis.window;
    delete globalThis.isTauri;
  }
});
