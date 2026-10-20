// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSource } from "./ts-test-loader.mjs";
const { SECTIONS, sectionEnabled, sectionForView, safeSectionView } = await import(
  await loadSource("../src/core/sections.ts")
);

test("media presentation is explicit and dedicated content outranks the compact baseline", async () => {
  const { mediaPresentation } = await import(
    await loadSource("../src/core/sections.ts")
  );
  for (const view of [
    "overview",
    "prompt",
    "upload",
    "confused",
    "approval",
    "question",
    "integrations",
    "utilities",
    "greeting",
  ])
    assert.equal(mediaPresentation("expanded", view), "hidden", view);
  assert.equal(mediaPresentation("expanded", "media"), "player");
  assert.equal(mediaPresentation("island", "overview"), "compact");
  assert.equal(mediaPresentation("island", "media"), "compact");
  assert.equal(mediaPresentation("island", "confused"), "hidden");
  assert.equal(mediaPresentation("island", "prompt"), "hidden");
  assert.equal(mediaPresentation("peek", "media"), "hidden");
});

test("sections respect parent modules, current integration choices, and existing utility routes", () => {
  const modules = { media: true, vscode: false, developerIntegrations: true };
  assert.equal(sectionEnabled("media", modules, 0), true);
  assert.equal(sectionEnabled("integrations", modules, 0), false);
  assert.equal(sectionEnabled("integrations", modules, 2), true);
  assert.equal(
    sectionEnabled("integrations", { ...modules, vscode: true }, 0),
    false,
    "coding tools alone do not need the Tools tab",
  );
  assert.equal(
    safeSectionView("media", { ...modules, media: false }, 2),
    "overview",
  );
  assert.equal(safeSectionView("integrations", modules, 0), "overview");
  assert.equal(safeSectionView("integrations", modules, 2), "integrations", "Tools tab opens once a tool is enabled");
  assert.equal(sectionForView("integrations"), "integrations");
  assert.equal(safeSectionView("utilities", modules, 0), "overview");
  assert.equal(safeSectionView("activity", modules, 0), "overview");
  assert.equal(sectionForView("prompt"), "prompt");
  assert.equal(sectionEnabled("prompt", { ...modules, media: false }, 0), true);
  assert.equal(sectionForView("upload"), "overview");
  assert.equal(sectionForView("approval"), "overview");
  assert.equal(sectionForView("settings"), null);
});

test("Home, Chat, and Mimo Shelf own their useful detail routes", () => {
  assert.deepEqual(SECTIONS.map(s => s.id), ["overview", "prompt", "integrations", "grab"]);
  assert.equal(sectionForView("grab"), "grab", "The shelf retains its own tab");
  assert.equal(sectionForView("usage"), "usage", "Limits owns the selected header control");
  assert.equal(sectionForView("voice"), "prompt");
  assert.equal(sectionForView("media"), "media", "The media header icon owns its selected state");
  for (const view of ["approvals", "error", "finished", "upload"])
    assert.equal(sectionForView(view), "overview", view);
});

const { IslandVisibilityController, restoredVisibility } = await import(
  await loadSource("../src/core/visibility.ts")
);
const { moduleLayout } = await import(
  await loadSource("../src/core/modules.ts")
);
const { ModuleSubscription } = await import(
  await loadSource("../src/core/module-lifecycle.ts")
);
const { IslandWindowBounds } = await import(
  await loadSource("../src/island/window-bounds.ts")
);
const { islandSize } = await import(await loadSource("../src/core/layout.ts"));
const { State, normalizeSettings } = await import(
  await loadSource("../src/core/state.ts")
);

test("the compact native clip waits for the outgoing animation and rapid reopening cancels it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const applied = [];
  const bounds = new IslandWindowBounds(async mode => { applied.push(mode); });
  bounds.transition("expanded", "peek", false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(applied, [], "The old surface stays available during the close");
  t.mock.timers.tick(320);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(applied, []);
  t.mock.timers.tick(60);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(applied, ["peek"]);
  bounds.transition("expanded", "peek", false);
  bounds.transition("peek", "expanded", false);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(400);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(applied, ["peek", "expanded"], "A stale close cannot clip a reopened panel");
  bounds.transition("expanded", "peek", true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(applied.at(-1), "peek", "Reduced motion commits stable compact bounds immediately");
  bounds.destroy();
});

test("new installations start with no service tiles and upgrades preserve chosen connections", () => {
  assert.deepEqual(normalizeSettings().activeIntegrations, []);
  const selected = ["integration_github", "integration_vercel"];
  assert.deepEqual(normalizeSettings({activeIntegrations: selected}).activeIntegrations, selected);
});

test("top anchors migrate centered, retain a saved position, and reject invalid settings", () => {
  for (const islandAnchor of [undefined, null, NaN, Infinity, "left", {}])
    assert.equal(normalizeSettings({islandAnchor}).islandAnchor, null);
  for (const [value, expected] of [[-1,0],[0,0],[0.23,0.23],[1,1],[2,1]]) {
    const settings = normalizeSettings({islandAnchor:value});
    assert.equal(settings.islandAnchor, expected);
    assert.equal(normalizeSettings(JSON.parse(JSON.stringify(settings))).islandAnchor, expected);
  }
});

test("chat selection migrates once and stays independent of all coding tools", async () => {
  const { CODING_PROVIDERS, CODING_IDS, codingProvider, codingConnections, chatAssistantName } =
    await import(await loadSource("../src/core/coding.ts"));
  const legacy = normalizeSettings({ codingAssistant: "codex", codexModel: "custom-model" });
  assert.equal(legacy.chatProvider, "openai");
  assert.equal(legacy.chatModels.openai, "custom-model");
  for (const { id } of CODING_PROVIDERS) {
    const restored = normalizeSettings({ ...legacy, codingAssistant: id });
    assert.equal(restored.chatProvider, "openai");
    assert.equal(chatAssistantName(restored), "OpenAI");
  }
  const current = normalizeSettings({ codingAssistant: "copilot", chatProvider: "gemini" });
  assert.equal(chatAssistantName(current), "Gemini");
  assert.equal(codingConnections(current, []).copilot, false, "Chat keys cannot imply coding connections");
  const saved = State.settings, tasks = State.tasks, last = State.lastCodingId;
  try {
    State.settings = normalizeSettings({ hooksInstalled: true, codexHooksInstalled: true,
      codingHooksInstalled: Object.fromEntries(CODING_PROVIDERS.map(p => [p.id, true])) });
    State.tasks = [];
    State.loadIntegrationTasks();
    for (const { id } of CODING_PROVIDERS) {
      const task = State.tasks.find(t => t.id === CODING_IDS[id]);
      assert.ok(task);
      assert.equal(codingProvider(task), id);
      assert.equal(codingConnections(State.settings, State.tasks)[id], true);
    }
    State.settings.modules.vscode = false;
    State.loadIntegrationTasks();
    assert.equal(State.tasks.some(t => codingProvider(t)), false);
  } finally { State.settings = saved; State.tasks = tasks; State.lastCodingId = last; }
});

test("chat model validation refuses paid routing, cloud tags, and malformed settings", async () => {
  const { validChatModel } = await import(await loadSource("../src/core/chat-providers.ts"));
  for (const id of ["openrouter/auto", "openrouter/auto:free", "openrouter/bodybuilder:free", "vendor/paid-model"])
    assert.equal(validChatModel("openrouter", id), false);
  assert.equal(validChatModel("openrouter", "openrouter/free"), true);
  assert.equal(validChatModel("openrouter", "nousresearch/hermes-3:free"), true);
  assert.equal(validChatModel("gemini", "../../secret"), false);
  assert.equal(validChatModel("gemini", "model?key=secret"), false);
  assert.equal(validChatModel("ollama", "hermes3:cloud"), false);
  assert.equal(validChatModel("ollama", "hermes3"), true);
  const normalized = normalizeSettings({ chatProvider: "openrouter", chatModels: {
    openrouter: "openrouter/auto:free", gemini: 12, ollama: "hermes3:cloud" } });
  assert.equal(normalized.chatModels.openrouter, "openrouter/free");
  assert.equal(normalized.chatModels.ollama, "hermes3");
  assert.equal(normalized.chatModels.gemini, "gemini-2.5-flash-lite");
});

test("appearance is Dark-only and migrates Glass without losing other preferences", () => {
  assert.equal(normalizeSettings().appearance, "dark");
  for (const appearance of ["dark", "glass"]) {
    const settings = normalizeSettings({ appearance, soundEnabled: false });
    assert.equal(settings.appearance, "dark");
    assert.equal(settings.soundEnabled, false);
  }
  assert.equal(normalizeSettings({ appearance: "unknown" }).appearance, "dark");
  const retired = normalizeSettings({
    appearance: "light",
    soundEnabled: false,
  });
  assert.equal(retired.appearance, "dark");
  assert.equal(retired.soundEnabled, false);
});

test("Grab defaults on and preserves the saved off preference", () => {
  assert.equal(normalizeSettings().grabEnabled, true);
  const disabled = normalizeSettings({ grabEnabled: false });
  assert.equal(disabled.grabEnabled, false);
  assert.equal(normalizeSettings(JSON.parse(JSON.stringify(disabled))).grabEnabled, false);
});

test("settling uses one automatic second and preserves the other preferences", () => {
  const fresh = normalizeSettings();
  assert.equal(fresh.autoCloseInterval, 1);
  assert.equal(fresh.autoCollapseEnabled, true);
  assert.equal(fresh.peekEnabled, false);
  assert.equal(fresh.workingModeEnabled, true);
  assert.equal(
    normalizeSettings({ autoCloseInterval: 15 }).autoCloseInterval,
    1,
  );
  assert.equal(
    normalizeSettings({ autoCloseInterval: 15, hoverBehaviorVersion: 1 })
      .autoCloseInterval,
    1,
  );
  assert.equal(
    normalizeSettings({ autoCloseInterval: 7 }).autoCloseInterval,
    1,
  );
  assert.equal(
    normalizeSettings({ autoCloseInterval: 0 }).autoCloseInterval,
    1,
  );
  assert.equal(
    normalizeSettings({ autoCloseInterval: 999 }).autoCloseInterval,
    1,
  );
  assert.equal(normalizeSettings({ autoCloseInterval: 999, soundEnabled: false }).soundEnabled, false);
});

function fixture(autoCollapseEnabled = false) {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const scheduler = {
    now: () => now,
    after: (fn, delay) => {
      const id = ++sequence;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    cancel: (id) => timers.delete(id),
  };
  const visibility = new IslandVisibilityController(scheduler);
  const preferences = {
    autoCollapseEnabled,
    autoCloseInterval: 1,
    rememberCompactState: true,
    lastVisibility: "expanded",
  };
  visibility.restore(preferences);
  return {
    visibility,
    preferences,
    timers,
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
    },
  };
}

test("minimized working lip waits for a click, while the awake island expands on hover", () => {
  const f = fixture(true);
  f.visibility.configure({ ...f.preferences, peekEnabled: true });
  f.visibility.peek();
  f.visibility.pointerEntered();
  assert.equal(f.visibility.state, "peek");
  f.visibility.expand();
  assert.equal(f.visibility.state, "expanded");
  f.visibility.pointerLeft();
  assert.equal(f.visibility.state, "island");
  assert.equal(f.visibility.compact, true);
  f.advance(999);
  assert.equal(f.visibility.state, "island");
  f.visibility.pointerEntered();
  assert.equal(f.visibility.state, "expanded");
  f.advance(1000);
  assert.equal(f.visibility.state, "expanded");
});

test("the activity scheduler ignores legacy custom delays", () => {
  const f = fixture(true);
  f.visibility.configure({ ...f.preferences, autoCloseInterval: 999 });
  f.advance(999);
  assert.equal(f.visibility.state, "expanded");
  f.advance(1);
  assert.equal(f.visibility.state, "island");
});

test("compact playback controls can hold hover without changing the normal hover behavior", () => {
  const f = fixture(true);
  f.visibility.configure({ ...f.preferences, workingModeEnabled: false });
  f.visibility.island();
  f.visibility.pointerLeft();
  f.visibility.pointerEntered(true);
  assert.equal(f.visibility.state, "island", "Entering playback controls keeps them in place");
  assert.equal(f.visibility.compact, true);
  f.visibility.setMediaPlaying(true);
  f.advance(60000);
  assert.equal(f.visibility.state, "island", "Resuming playback does not move the controls");
  f.visibility.pointerEntered();
  assert.equal(f.visibility.state, "expanded", "Moving onto the rest of the island still expands immediately");
  f.visibility.pointerLeft();
  assert.equal(f.visibility.state, "island");
});

test("media exit stays awake and respects protected interactions", () => {
  for (const peekEnabled of [false, true]) {
    const f = fixture(true);
    f.visibility.configure({...f.preferences,peekEnabled});
    f.visibility.pointerEntered();
    f.visibility.pointerLeft(true);
    assert.equal(f.visibility.state,"island");
  }
  for (const protection of ["setPinned","setProtected","setDragging"]) {
    const f = fixture(true);
    f.visibility.configure({...f.preferences,peekEnabled:true});
    f.visibility.pointerEntered();
    f.visibility[protection](true);
    f.visibility.pointerLeft(true);
    f.advance(60000);
    assert.equal(f.visibility.state,"expanded",protection);
  }
  const disabled = fixture(false);
  disabled.visibility.pointerEntered();
  disabled.visibility.pointerLeft(true);
  assert.equal(disabled.visibility.state,"expanded");
});

test("idle activity and media never start a sleeping or minimized timer", () => {
  const f = fixture(true);
  f.visibility.setMediaPlaying(true);
  f.visibility.setMediaPeekFlow(true);
  f.advance(1000); f.advance(1000); f.advance(600000);
  assert.equal(f.visibility.state, "island");
  assert.equal(f.visibility.compact, true);
  assert.equal(f.timers.size, 0);
});

test("agent work opens Mimo, holds it open, and settles closed when the work ends", () => {
  const f = fixture(true);
  f.visibility.configure({ ...f.preferences, workingModeEnabled: true });
  f.advance(1000); assert.equal(f.visibility.state, "peek");
  f.visibility.setWorking(true); assert.equal(f.visibility.state, "expanded", "work opens Mimo");
  f.visibility.pointerEntered(); f.visibility.pointerLeft(); f.advance(60000);
  assert.equal(f.visibility.state, "expanded", "stays open while the agent works");
  f.visibility.setWorking(false);
  f.advance(999); assert.equal(f.visibility.state, "expanded");
  f.advance(1); assert.equal(f.visibility.state, "peek", "settles closed when done");
  f.visibility.setWorking(true); f.visibility.minimize(); f.advance(60000);
  assert.equal(f.visibility.state, "peek", "a minimize holds until that work ends");
  f.visibility.setWorking(false); f.visibility.setWorking(true);
  assert.equal(f.visibility.state, "expanded", "the next piece of work opens again");
  f.visibility.setWorking(false);
  f.visibility.configure({...f.preferences, workingModeEnabled:false});
  f.advance(60000); assert.equal(f.visibility.state, "island", "disabled working mode settles to the island");
});

test("working mode never minimizes pinned, typing, or dragging content", () => {
  for (const protect of ["setPinned", "setProtected", "setDragging"]) {
    const f = fixture(true);
    f.visibility.configure({ ...f.preferences, workingModeEnabled: true });
    f.visibility[protect](true); f.visibility.setWorking(true);
    f.visibility.pointerLeft(); f.advance(60000);
    assert.equal(f.visibility.state, "expanded", protect);
    f.visibility[protect](false); f.visibility.setWorking(false); f.advance(1000);
    assert.equal(f.visibility.state, "peek", protect);
  }
});

test("legacy detached settings never restore a desktop companion and working mode persists", () => {
  const migrated = normalizeSettings({peekEnabled:true,desktopCompanion:{monitor:"old",x:.25,y:.6},lastVisibility:"peek"});
  assert.equal(migrated.peekEnabled,false);
  assert.equal(migrated.desktopCompanion,null);
  assert.equal(restoredVisibility(migrated),"island");
  assert.equal(normalizeSettings(JSON.parse(JSON.stringify({...migrated,workingModeEnabled:false}))).workingModeEnabled,false);
});

test("a slider drag outside holds until release without a timeout", () => {
  const f = fixture(true);
  f.visibility.pointerEntered();
  f.visibility.setDragging(true);
  f.visibility.pointerLeft();
  f.advance(600000);
  assert.equal(f.visibility.state, "expanded");
  f.visibility.setDragging(false);
  assert.equal(f.visibility.state, "island");
  assert.equal(f.visibility.compact, true);
});

test("minimized working lip activates directly into the full app", () => {
  const { visibility } = fixture();
  visibility.minimize(); assert.equal(visibility.state, "island");
  visibility.minimize(); assert.equal(visibility.state, "peek");
  visibility.minimize(); assert.equal(visibility.state, "peek");
  visibility.activate(); assert.equal(visibility.state, "expanded");
});

test("hover stays expanded while inside and settles to persistent compact when peek is off", () => {
  const f = fixture(true);
  f.visibility.pointerEntered();
  f.advance(60000);
  assert.equal(f.visibility.state, "expanded");
  f.visibility.pointerLeft();
  f.advance(14999);
  assert.equal(f.visibility.state, "island");
  f.advance(1);
  assert.equal(f.visibility.state, "island");
  f.advance(120000);
  assert.equal(f.visibility.state, "island");
  assert.equal(f.timers.size, 0);
});

test("auto-collapse OFF ignores pointer leave, focus loss, outside click and background alerts", () => {
  const f = fixture();
  f.visibility.pointerLeft();
  f.visibility.focusLost();
  f.visibility.outsideClick();
  f.advance(120000);
  assert.equal(f.visibility.state, "expanded");
  assert.equal(f.timers.size, 0);
  f.visibility.minimize();
  assert.equal(f.visibility.requestExpansion(), false);
  assert.equal(f.visibility.state, "island");
});

test("turning auto-collapse off cancels an existing deadline; reentry and pinning cancel it", () => {
  const f = fixture(true);
  f.advance(500);
  f.visibility.configure({ ...f.preferences, autoCollapseEnabled: false });
  f.advance(60000);
  assert.equal(f.visibility.state, "expanded");
  f.visibility.configure(f.preferences);
  f.visibility.pointerEntered();
  f.advance(60000);
  assert.equal(f.visibility.state, "expanded");
  f.visibility.setPinned(true);
  f.visibility.pointerLeft();
  f.advance(60000);
  assert.equal(f.visibility.state, "expanded");
  f.visibility.setPinned(false);
  f.advance(15000);
  assert.equal(f.visibility.state, "island");
});

test("automatic expansion and collapse never override peek", () => {
  const f = fixture(true);
  f.visibility.peek();
  f.visibility.pointerLeft();
  f.visibility.focusLost();
  f.visibility.outsideClick();
  assert.equal(f.visibility.requestExpansion(), false);
  f.advance(120000);
  assert.equal(f.visibility.state, "peek");
  assert.equal(f.timers.size, 0);
});

test("remembered preferences survive serialization and restore peek safely to island", () => {
  const saved = normalizeSettings({
    autoCollapseEnabled: true,
    rememberCompactState: true,
    lastVisibility: "peek",
    modules: { media: true, vscode: false, developerIntegrations: false },
    activeIntegrations: ["integration_stripe"],
  });
  const restored = normalizeSettings(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(restored, saved);
  assert.equal(restoredVisibility(restored), "island");
  assert.equal(
    restoredVisibility({ ...restored, lastVisibility: "island" }),
    "island",
  );
  assert.equal(
    restoredVisibility({ ...restored, rememberCompactState: false }),
    "expanded",
  );
  const old = normalizeSettings({ activeIntegrations: ["integration_github"] });
  assert.deepEqual(old.activeIntegrations, ["integration_github"]);
  assert.deepEqual(old.modules, {
    media: true,
    vscode: true,
    developerIntegrations: true,
  });
});

test("every module combination has only occupied slots, and solitary modules span the panel", () => {
  for (const media of [false, true])
    for (const vscode of [false, true])
      for (const developerIntegrations of [false, true]) {
        const preferences = { media, vscode, developerIntegrations };
        const plan = moduleLayout(preferences, true, 4);
        assert.deepEqual(
          plan.modules.map((m) => m.id),
          ["vscode", "developerIntegrations", "media"].filter(
            (id) => preferences[id],
          ),
        );
        if (plan.modules.length === 1) assert.equal(plan.modules[0].span, 2);
        assert.ok(plan.height <= 384);
        const halves = plan.modules.filter((m) => m.preferredSize === "half");
        assert.ok(
          halves.every((m) => m.span === (halves.length === 1 ? 2 : 1)),
        );
      }
  assert.equal(
    moduleLayout(
      { media: true, vscode: false, developerIntegrations: false },
      true,
      0,
    ).height,
    220,
  );
  assert.equal(
    moduleLayout(
      { media: true, vscode: false, developerIntegrations: false },
      false,
      0,
    ).modules.length,
    0,
  );
  assert.equal(
    moduleLayout(
      { media: false, vscode: false, developerIntegrations: true },
      false,
      0,
    ).modules.length,
    0,
  );
});

test("integration rows use available width without increasing the compact card height", () => {
  const half = moduleLayout(
    { media: false, vscode: true, developerIntegrations: true },
    false,
    7,
  );
  const wide = moduleLayout(
    { media: false, vscode: false, developerIntegrations: true },
    false,
    7,
  );
  assert.equal(half.integrationColumns, 4);
  assert.equal(wide.integrationColumns, 7);
  assert.equal(half.activityHeight, 124);
  assert.equal(wide.activityHeight, 124);
});

test("disabling modules prunes VSCodium sessions and integration tasks; reenable restores implementations", () => {
  State.settings = normalizeSettings();
  State.loadIntegrationTasks();
  State.tasks.push({
    ...State.tasks[0],
    id: "external-agent",
    source: "agent",
    isIntegration: false,
  });
  State.settings.modules.vscode = false;
  State.view = "approval";
  State.loadIntegrationTasks();
  assert.equal(State.view, "overview");
  assert.ok(
    State.tasks.every(
      (task) => task.id !== "integration_claude" && task.source !== "agent",
    ),
  );
  State.settings.modules.developerIntegrations = false;
  State.loadIntegrationTasks();
  assert.equal(State.tasks.length, 0);
  assert.equal(State.focusId, null);
  State.settings.modules.vscode = true;
  State.loadIntegrationTasks();
  assert.deepEqual(
    State.tasks.map((task) => task.id),
    ["integration_claude"],
  );
  State.settings = normalizeSettings();
  State.loadIntegrationTasks();
});

test("disabling a pending listener releases it and reenabling creates exactly one subscription", async () => {
  let resolve;
  let starts = 0;
  let stops = 0;
  const binding = new ModuleSubscription(async () => {
    starts++;
    return new Promise((yes) => {
      resolve = yes;
    });
  });
  const enabled = binding.setEnabled(true);
  await Promise.resolve();
  await Promise.resolve();
  const disabled = binding.setEnabled(false);
  resolve(() => stops++);
  await Promise.all([enabled, disabled]);
  assert.equal(stops, 1);
  const again = binding.setEnabled(true);
  await Promise.resolve();
  await Promise.resolve();
  resolve(() => stops++);
  await again;
  await binding.setEnabled(true);
  assert.equal(starts, 2);
  assert.equal(stops, 1);
  await binding.destroy();
  assert.equal(stops, 2);
});

test("Missed approvals retain the original workspace until dismissed and never replace a waiting request", () => {
  const saved = { tasks: State.tasks, pending: State.pendingApproval, missed: State.missedApprovals };
  try {
    State.tasks = [{ id: "coding_codex", name: "korus", sessionCwd: "C:/work/korus" }];
    State.missedApprovals = [];
    State.pendingApproval = { requestId: "waiting", taskId: "coding_codex", provider: "codex",
      sessionId: "session", tool: "Bash", command: "npm test" };
    const request = { ...State.pendingApproval, requestId: "missed" };
    State.rememberApproval(request, "Timed out");
    State.tasks[0].name = "new-project";
    State.tasks[0].sessionCwd = "C:/work/new-project";
    assert.equal(State.missedApprovals[0].cwd, "C:/work/korus");
    assert.equal(State.missedApprovals[0].project, "korus");
    assert.equal(State.approvalCount, 2);
    for (let i = 0; i < 12; i++) State.rememberApproval({ ...request, requestId: "missed-" + i }, "Session ended");
    assert.ok(State.missedApprovals.some(item => item.requestId === "missed"), "New requests do not silently remove older missed approvals");
    State.rememberApproval(request, "Handled in editor");
    assert.equal(State.missedApprovals.filter(item => item.requestId === "missed").length, 1);
    State.dismissApproval("missed");
    assert.equal(State.missedApprovals.some(item => item.requestId === "missed"), false);
    assert.equal(State.pendingApproval.requestId, "waiting");
  } finally {
    State.tasks = saved.tasks;
    State.pendingApproval = saved.pending;
    State.missedApprovals = saved.missed;
  }
});

test("a failed module start can recover on reenable", async () => {
  let calls = 0;
  let stops = 0;
  const binding = new ModuleSubscription(async () => {
    if (++calls === 1) throw new Error("Unavailable bridge");
    return () => stops++;
  });
  await assert.rejects(binding.setEnabled(true));
  await binding.setEnabled(true);
  assert.equal(calls, 2);
  await binding.destroy();
  assert.equal(stops, 1);
});

test("Editor results resolve only matching missed approvals and retain their review history", () => {
  const saved = { pending: State.pendingApproval, missed: State.missedApprovals };
  try {
    State.pendingApproval = null;
    State.missedApprovals = [];
    const request = { requestId: "missed-edit", provider: "codex", sessionId: "session-1",
      tool: "Edit", toolUseId: "edit-1", command: "Edit · src/invoice.ts", cwd: "C:/work/korus" };
    State.rememberApproval(request, "Timed out");
    for (const different of [{ provider: "claude" }, { sessionId: "session-2" }, { toolUseId: "edit-2" },
      { tool: "Read" }, { sessionId: "" }]) {
      State.resolveMissedApproval({ ...request, ...different });
      assert.equal(State.approvalCount, 1);
    }
    State.resolveMissedApproval(request);
    assert.equal(State.approvalCount, 0);
    assert.equal(State.approvalInboxCount, 1);
    assert.ok(State.missedApprovals[0].resolvedAt);
    assert.equal(State.missedApprovals[0].status, "Approved · Completed");
    State.rememberApproval(request, "Timed out");
    assert.equal(State.approvalCount, 0, "Repeated events never resurrect a resolved notification");
    State.rememberApproval({ ...request, requestId: "missed-2", toolUseId: undefined }, "Returned to editor");
    State.resolveMissedApproval({ ...request, toolUseId: undefined, command: "Edit · SRC\\invoice.ts" }, true);
    assert.equal(State.approvalCount, 0);
    assert.equal(State.missedApprovals[0].status, "Action failed");
    assert.equal(State.missedApprovals[0].failed, true);
    State.rememberApproval({ ...request, requestId: "unknown", toolUseId: undefined, command: "Edit" }, "Timed out");
    State.resolveMissedApproval({ ...request, toolUseId: undefined, command: "Edit" });
    assert.equal(State.approvalCount, 1, "A bare tool name cannot resolve an ambiguous request");
    State.dismissApproval("unknown");
    assert.equal(State.approvalInboxCount, 2);
  } finally {
    State.pendingApproval = saved.pending;
    State.missedApprovals = saved.missed;
  }
});

test("frontend bounds match each state and rapid transitions cancel stale native resizing", async () => {
  assert.deepEqual(islandSize("expanded", "overview", 0, false, false), {
    w: 640,
    h: 160,
  });
  assert.deepEqual(islandSize("island", "overview", 0, false, false), {
    w: 264,
    h: 40,
  });
  assert.deepEqual(islandSize("peek", "overview", 0, false, false), {
    w: 156,
    h: 12,
  });
  const applied = [];
  const bounds = new IslandWindowBounds(async (state) => {
    applied.push(state);
  });
  bounds.transition("expanded", "island", false);
  bounds.transition("island", "peek", false);
  bounds.transition("peek", "expanded", true);
  await new Promise((resolve) => setTimeout(resolve, 420));
  assert.deepEqual(applied, ["expanded"]);
  bounds.destroy();
});
