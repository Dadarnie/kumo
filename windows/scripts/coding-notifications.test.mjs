// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { loadSource } from "./ts-test-loader.mjs";

const previousWindow = globalThis.window;
let nextTimer = 0;
let nextSession = 0;
const timers = new Map();
globalThis.window = {
  setTimeout(callback, delay) {
    const id = ++nextTimer;
    timers.set(id, { callback, delay });
    return id;
  },
  clearTimeout: id => timers.delete(id),
};

const { State, normalizeSettings } = await import(await loadSource("../src/core/state.ts"));
const { CODING_IDS, codingProvider } = await import(await loadSource("../src/core/coding.ts"));
const { sessionKey } = await import(await loadSource("../src/core/coding-session.ts"));
const { Visibility } = await import(await loadSource("../src/core/visibility.ts"));
const { Bridge } = await import(await loadSource("../src/core/bridge.ts"));
const { Sound } = await import(await loadSource("../src/core/sound.ts"));
const { compactCodingProgress, codingProgress } = await import(await loadSource("../src/core/coding-progress.ts"));
const { miniNotification, miniNotificationTask } = await import(await loadSource("../src/mimo/notifications.ts"));
const { handleHook, resetHookSession } = await import(await loadSource("../src/island/hooks.ts"));

const savedBridge = { approvalAck: Bridge.approvalAck, approvalDecline: Bridge.approvalDecline };
const savedSound = Sound.play;
const returned = [];
const sounds = [];
Bridge.approvalAck = async () => {};
Bridge.approvalDecline = async id => returned.push(id);
Sound.play = name => sounds.push(name);

const island = {
  reveal() { if (State.visibility === "peek") Visibility.island(); },
  dropPin() { Visibility.setPinned(false); },
  setView(view) { State.view = view; },
  expand(view) { State.view = view; Visibility.expand(); },
  alert(view) { State.view = view; Visibility.expand(); },
};

function work(provider, label, extra = {}) {
  const session = `${label}-${++nextSession}`;
  const id = sessionKey(provider, session);
  const emit = (name, values = {}) => handleHook(island, {
    mimo_provider: provider,
    session_id: session,
    cwd: `C:/work/${label}`,
    hook_event_name: name,
    ...values,
  });
  emit("UserPromptSubmit", { prompt: `Fix ${label}`, ...extra });
  emit("PreToolUse", { tool_name: "Read", tool_use_id: `${session}-read`,
    tool_input: { file_path: `C:/work/${label}/src/main.ts` } });
  return { id, session, emit, task: State.tasks.find(task => task.id === id) };
}

function settleCompletion() {
  const pending = [...timers.entries()].filter(([, timer]) => timer.delay === 5200);
  assert.equal(pending.length, 1, "A finished turn gets one short reaction timer");
  const [id, timer] = pending[0];
  timers.delete(id);
  timer.callback();
}

beforeEach(() => {
  resetHookSession(island);
  timers.clear();
  returned.length = sounds.length = 0;
  State.settings = normalizeSettings({ hooksInstalled: true, codexHooksInstalled: true,
    activeIntegrations: ["integration_resend"] });
  State.tasks = [];
  State.pendingApprovals = [];
  State.missedApprovals = [];
  State.integrations = {};
  State.paused = false;
  State.isPinned = false;
  State.stateOverride = null;
  State.selectedCodingId = null;
  State.lastCodingId = CODING_IDS.claude;
  State.loadIntegrationTasks();
  State.focusId = CODING_IDS.claude;
  State.view = "overview";
  Visibility.configure({ autoCollapseEnabled: false, autoCloseInterval: 1,
    rememberCompactState: false, lastVisibility: "expanded" });
  Visibility.expand();
});

afterEach(() => {
  resetHookSession(island);
  assert.equal(timers.size, 0, "Cleanup cancels pending hook reaction timers");
});

after(() => {
  Object.assign(Bridge, savedBridge);
  Sound.play = savedSound;
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

for (const provider of ["claude", "codex"]) {
  for (const context of ["compact", "unrelated expanded view"]) {
    test(`${provider} keeps focused ${context} completion unread after its reaction settles`, () => {
      const session = work(provider, `${provider}-unread`);
      State.focusId = session.id;
      if (context === "compact") Visibility.island();
      else State.view = "media";

      assert.equal(session.task.state, "working", "Tool activity is ongoing before Stop");
      assert.equal(codingProgress(session.task).state, "active");
      session.emit("Stop", { message: "Updated checkout" });

      assert.equal(session.task.state, "finished");
      assert.equal(session.task.pillBadge, "finished", "Focus alone does not acknowledge hidden updates");
      assert.equal(compactCodingProgress(session.task).title, "Finished");
      assert.equal(sounds.filter(name => name === "finish").length, 1, "Confirmed completion plays one finish cue");
      session.emit("Stop", { message: "Duplicate completion" });
      assert.equal(sounds.filter(name => name === "finish").length, 1, "A duplicate Stop never replays the cue");
      settleCompletion();
      assert.equal(session.task.state, "idle");
      assert.equal(session.task.pillBadge, "finished", "Unread completion outlives the 5200ms reaction");
      assert.equal(session.task.activity.summary, "Updated checkout");
      State.setFocus(session.id);
      assert.equal(session.task.pillBadge, null, "Opening this Mimo acknowledges its update");
    });
  }

  test(`${provider} does not mark a visible coding workspace completion unread`, () => {
    const session = work(provider, `${provider}-visible`);
    State.setFocus(session.id);
    State.view = "integrations";
    session.emit("Stop", { message: "Changes ready" });
    assert.equal(session.task.pillBadge, null);
    settleCompletion();
    assert.equal(session.task.pillBadge, null);
  });

  for (const [event, stopped, title] of [
    ["SessionEnd", "session-ended", "Session ended"],
    ["Interrupt", "interrupted", "Stopped"],
  ]) {
    test(`${provider} ${event} retains one unread stopped result and rejects late activity`, () => {
      const session = work(provider, `${provider}-${event}`);
      State.focusId = session.id;
      Visibility.island();
      const target = { pid: 24, createdAt: "created", hwnd: "124" };
      session.task.returnTarget = target;
      session.emit(event);

      const retained = State.tasks.find(task => task.id === CODING_IDS[provider]);
      assert.ok(retained, "The existing provider slot keeps the final observed activity");
      assert.equal(State.tasks.some(task => task.id === session.id), false, "Ended real sessions leave the live list");
      assert.equal(retained.sessionId, undefined);
      assert.equal(retained.state, "idle");
      assert.equal(retained.activity.stopped, stopped);
      assert.equal(retained.activity.completed, false, "A stopped session cannot claim a completed turn");
      assert.equal(retained.pillBadge, "finished");
      assert.equal(retained.returnTarget, target);
      assert.ok(Number.isFinite(retained.lastEventAt));
      assert.equal(State.focusId, retained.id, "The currently viewed closed session follows its retained result");
      assert.equal(codingProgress(retained).state, "stopped");
      assert.equal(compactCodingProgress(retained).title, title);
      assert.equal(sounds.includes("finish"), false, "Stopped work has no completion sound");

      const lastActivity = retained.activity;
      for (const late of ["PreToolUse", "PostToolUse", "Stop", "StopFailure"])
        session.emit(late, { tool_name: "Read", tool_use_id: "late", message: "Late result" });
      session.emit("PermissionRequest", { request_id: `${session.session}-late-request`, tool_name: "Bash" });
      assert.equal(State.tasks.some(task => task.id === session.id), false);
      assert.equal(retained.activity, lastActivity, "Late hooks cannot replace the stopped result");
      assert.deepEqual(returned, [`${session.session}-late-request`]);
      assert.equal(timers.size, 0, "Late Stop cannot create a completion timer for a closed session");
      State.setFocus(retained.id);
      assert.equal(retained.pillBadge, null);
    });
  }

  test(`${provider} closing a completed turn preserves its actual result and unread badge`, () => {
    const session = work(provider, `${provider}-completed`);
    State.focusId = session.id;
    Visibility.island();
    session.emit("Stop", { message: "Implemented checkout and passed tests" });
    const completed = session.task.activity;
    assert.equal(timers.size, 1);
    session.emit("SessionEnd");

    const retained = State.tasks.find(task => task.id === CODING_IDS[provider]);
    assert.equal(State.tasks.some(task => task.id === session.id), false);
    assert.equal(retained.activity, completed);
    assert.equal(retained.activity.completed, true);
    assert.equal(retained.activity.stopped, undefined);
    assert.equal(retained.activity.summary, "Implemented checkout and passed tests");
    assert.equal(retained.pillBadge, "finished");
    assert.equal(codingProgress(retained).state, "complete");
    assert.equal(compactCodingProgress(retained).title, "Finished");
    assert.equal(sounds.filter(name => name === "finish").length, 1, "SessionEnd never replays the completed turn's cue");
    assert.equal(timers.size, 0, "SessionEnd cancels the completed session reaction timer");
  });
}

test("retained results are bounded to one provider slot rather than accumulating closed sessions", () => {
  State.focusId = "integration_resend";
  for (const provider of ["claude", "codex"]) {
    for (let index = 0; index < 16; index++) {
      const session = work(provider, `${provider}-bounded-${index}`);
      session.emit(index % 2 ? "Interrupt" : "SessionEnd");
    }
    const results = State.tasks.filter(task => codingProvider(task) === provider);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, CODING_IDS[provider]);
    assert.equal(results[0].sessionCwd, `C:/work/${provider}-bounded-15`);
    assert.equal(results[0].activity.stopped, "interrupted");
  }
});

test("closing an older unselected session preserves the newer active session and its focus", () => {
  const older = work("codex", "older");
  const newer = work("claude", "newer");
  State.setFocus(newer.id);
  assert.equal(State.lastCodingId, newer.id);
  older.emit("SessionEnd");
  assert.equal(State.focusId, newer.id);
  assert.equal(State.lastCodingId, newer.id, "Retaining old work does not rewrite the latest live session");
  assert.equal(State.codingTask.id, newer.id);
  assert.equal(newer.task.state, "working");
});

test("background work and completion do not steal the focus of another active coding session", () => {
  const active = work("codex", "active-project");
  State.setFocus(active.id);
  const background = work("claude", "background-project");
  assert.equal(State.focusId, active.id);
  background.emit("Stop", { message: "Background fix ready" });
  assert.equal(State.focusId, active.id);
  assert.equal(State.codingTask.id, active.id);
  assert.equal(background.task.pillBadge, "finished");
  background.emit("SessionEnd");
  assert.equal(State.focusId, active.id);
  assert.equal(State.codingTask.id, active.id);
});

test("manual selection remains focused after its finished session settles while another session starts", () => {
  const selected = work("codex", "manually-selected");
  selected.emit("Stop", { message: "Selected work complete" });
  settleCompletion();
  State.selectCodingTask(selected.id);
  assert.equal(selected.task.state, "idle");
  work("claude", "another-session");
  assert.equal(State.selectedCodingId, selected.id);
  assert.equal(State.codingTask.id, selected.id);
  assert.equal(State.focusId, selected.id, "New hooks respect the explicitly selected idle session");
});

test("a focused session remains unread when a different manually selected coding session is displayed", () => {
  const displayed = work("codex", "displayed-session");
  const focused = work("claude", "focused-session");
  State.selectCodingTask(displayed.id);
  State.setFocus(focused.id);
  State.view = "integrations";
  assert.equal(State.visibility, "expanded");
  assert.equal(State.codingTask.id, displayed.id);
  focused.emit("Stop", { message: "Hidden selected-session update" });
  assert.equal(focused.task.pillBadge, "finished", "Only the displayed coding session acknowledges an update");
  assert.equal(State.codingTask.id, displayed.id);
});

test("StopFailure followed by SessionEnd preserves the error badge for review", () => {
  const session = work("codex", "failed-session");
  State.setFocus("integration_resend");
  session.emit("StopFailure", { message: "Agent failed to finish" });
  assert.equal(session.task.pillBadge, "error");
  session.emit("SessionEnd");
  const retained = State.tasks.find(task => task.id === CODING_IDS.codex);
  assert.equal(retained.pillBadge, "error", "Closing a failed session keeps its error severity");
  assert.equal(State.tasks.some(task => task.id === session.id), false);
});

test("Interrupt after a failed tool result shows stopped work instead of a lingering failed operation", () => {
  const session = work("claude", "failed-operation");
  session.emit("PostToolUseFailure", { tool_name: "Read", tool_use_id: `${session.session}-read` });
  assert.equal(session.task.activity.phase, "failed");
  session.emit("Interrupt");
  const retained = State.tasks.find(task => task.id === CODING_IDS.claude);
  assert.equal(retained.activity.stopped, "interrupted");
  assert.equal(codingProgress(retained).state, "stopped");
  assert.equal(compactCodingProgress(retained).title, "Stopped");
});

for (const provider of ["claude", "codex"]) {
  test(`${provider} manually selected session follows its retained result while newer work runs`, () => {
    const selected = work(provider, `${provider}-selected-before-end`);
    State.selectCodingTask(selected.id);
    const newer = work(provider === "claude" ? "codex" : "claude", "newer-unselected-work");
    assert.equal(State.codingTask.id, selected.id);
    selected.emit("SessionEnd");

    assert.equal(State.selectedCodingId, CODING_IDS[provider], "Explicit selection moves to the retained provider result");
    assert.equal(State.codingTask.id, CODING_IDS[provider], "Closing selected work does not switch to another live session");
    assert.equal(State.focusId, CODING_IDS[provider]);
    assert.equal(newer.task.state, "working");
  });
}

test("shared mini follows ongoing work while an exact retained stopped task keeps its selection", () => {
  const stopped = work("codex", "retained-exact-target");
  stopped.emit("Interrupt");
  const retained = State.tasks.find(task => task.id === CODING_IDS.codex);
  State.selectCodingTask(retained.id);
  const newer = work("claude", "ongoing-mini-target");
  const slot = State.tasks.find(task => task.id === CODING_IDS.claude);

  assert.equal(State.codingTask, retained, "New activity respects the manually selected retained result");
  assert.equal(miniNotificationTask(slot, State.tasks, State.codingTask), newer.task, "Shared mini advertises ongoing work");
  assert.equal(miniNotificationTask(retained, State.tasks, State.codingTask), retained, "Exact target identity does not aggregate");
  assert.equal(codingProgress(retained).done, false);
  assert.equal(compactCodingProgress(retained).title, "Stopped");
});

test("retained unread errors outrank newer ongoing work in the shared mini", () => {
  const failed = work("codex", "retained-error-priority");
  State.setFocus("integration_resend");
  failed.emit("StopFailure", { message: "Unable to finish" });
  failed.emit("SessionEnd");
  const retained = State.tasks.find(task => task.id === CODING_IDS.codex);
  const newer = work("claude", "active-error-priority");
  const slot = State.tasks.find(task => task.id === CODING_IDS.claude);

  assert.equal(miniNotificationTask(slot, State.tasks, newer.task), retained);
  assert.equal(miniNotification(retained).badge, "error");
  State.setFocus(retained.id);
  assert.equal(miniNotificationTask(slot, State.tasks, newer.task), newer.task, "Reading the ended error releases shared attention");
});

test("quiet coding work keeps its active lifecycle and restores current activity on the next hook", () => {
  const live = work("codex", "quiet-status");
  const observed = live.task.lastEventAt;
  assert.equal(compactCodingProgress(live.task, false, observed + 89_999).state, "active");
  const quiet = compactCodingProgress(live.task, false, observed + 90_000);
  assert.equal(quiet.title, "No recent activity");
  assert.equal(quiet.state, "quiet");
  assert.equal(quiet.review, true);
  assert.equal(quiet.indicator, "none");
  assert.equal(live.task.state, "working", "Quiet UI never invents an ended session");
  assert.equal(codingProgress(live.task).done, false);
  assert.equal(compactCodingProgress(live.task, true, observed + 90_000).title, "Updates paused");
  live.emit("PreToolUse", { tool_name: "Read", tool_use_id: "fresh-quiet-read", tool_input: { file_path: "next.ts" } });
  assert.equal(compactCodingProgress(live.task, false, live.task.lastEventAt).state, "active");
});
