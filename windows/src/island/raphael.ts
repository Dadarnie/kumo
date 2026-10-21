// SPDX-License-Identifier: MIT
// Raphael, the local voice assistant, as an agent in the island. The native
// sidecar (raphael.rs) relays kumo_bridge.py's JSON events as `raphael` events.
// Raphael is the `agent_raphael` task: the compact strip, Home pill and mascot
// follow its state. Its approvals use `raphael:<id>` request ids, which the
// bridge routes back to Raphael instead of the coding-agent pipe.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type AgentTask } from "../core/state";
import { Visibility } from "../core/visibility";
import type { Island } from "./island";
import { cancelApprovalTimeout } from "./hooks";

export const RAPHAEL_TASK = "agent_raphael";
export const RAPHAEL_PREFIX = "raphael:";
const REMINDER_MS = 30_000;

type RaphaelEvent =
  | { t: "ready" | "unavailable" }
  | { t: "state"; v: "idle" | "listening" | "thinking" | "speaking" }
  | { t: "you" | "reply" | "note"; v: string }
  | { t: "activity"; icon: string; text: string }
  | { t: "muted"; v: boolean }
  | { t: "level"; v: number }
  | { t: "approve"; id: number; name: string; detail: string; danger: boolean; timeout: number }
  | { t: "approve_close"; id: number }
  | { t: "notify"; title: string; v: string }
  | { t: "exit"; code: number | null };

/** What the header's mic button and the voice shortcut need to know. */
export const Raphael = { ready: false, muted: false, busy: false };

function task(): AgentTask {
  State.upsertExternalAgent(RAPHAEL_TASK, "Raphael", "#f67e7d");
  return State.tasks.find(t => t.id === RAPHAEL_TASK)!;
}

function show(state: AgentTask["state"], status: string | null) {
  const t = task();
  t.state = state;
  t.statusText = status;
  t.lastEventAt = Date.now();
  Raphael.busy = state !== "idle";
  State.notify();
}

let reminderTimer: number | undefined;

export function handleRaphael(island: Island, event: RaphaelEvent) {
  switch (event.t) {
    case "ready":
      Raphael.ready = true;
      show("idle", null);
      break;
    case "state":
      if (task().pillBadge === "approval") break; // an open approval outranks talking
      if (event.v === "thinking") show("thinking", "Thinking…");
      else if (event.v === "speaking") show("working", "Speaking");
      else if (task().pillBadge !== "finished") show("idle", null);
      break;
    case "you":
      State.appendStep(RAPHAEL_TASK, `“${event.v.slice(0, 80)}”`);
      show("thinking", "Thinking…");
      break;
    case "reply":
      State.appendStep(RAPHAEL_TASK, event.v.slice(0, 120));
      break;
    case "activity":
      if (event.icon === "▶") show("working", event.text.slice(0, 60));
      State.appendStep(RAPHAEL_TASK, `${event.icon} ${event.text}`.slice(0, 100));
      break;
    case "muted":
      Raphael.muted = event.v;
      State.notify();
      break;
    case "approve": {
      const requestId = RAPHAEL_PREFIX + event.id;
      State.enqueueApproval({
        requestId, sessionId: "", tool: event.name.replace(/_/g, " "), command: event.detail,
        taskId: RAPHAEL_TASK, agentName: "Raphael", danger: event.danger,
        reason: event.danger ? "Raphael marks this as able to change, delete or send something." : undefined,
      });
      State.setPillBadge(RAPHAEL_TASK, "approval");
      show("approval", "Approval needed");
      State.isPinned = true;
      Visibility.setPinned(true);
      Sound.play("approval");
      island.alert("approval");
      break;
    }
    case "approve_close":
      closeApproval(island, RAPHAEL_PREFIX + event.id);
      break;
    case "notify":
      State.appendStep(RAPHAEL_TASK, `⏰ ${event.v}`);
      State.setPillBadge(RAPHAEL_TASK, "finished");
      show("idle", event.v.slice(0, 80));
      Sound.play("approval");
      island.reveal();
      window.clearTimeout(reminderTimer);
      reminderTimer = window.setTimeout(() => {
        if (task().pillBadge === "finished") { State.setPillBadge(RAPHAEL_TASK, null); show("idle", null); }
      }, REMINDER_MS);
      break;
    case "exit":
    case "unavailable":
      Raphael.ready = Raphael.busy = false;
      for (const request of State.pendingApprovals)
        if (request.requestId.startsWith(RAPHAEL_PREFIX)) closeApproval(island, request.requestId);
      if (!State.settings.raphaelEnabled) State.removeTask(RAPHAEL_TASK);
      else show("error", event.t === "exit" ? "Restarting…" : "Not found: check its folder in Settings");
      break;
  }
}

/** Raphael timed out or stopped: the card goes, nothing is sent back. */
function closeApproval(island: Island, requestId: string) {
  const request = State.finishApproval(requestId);
  if (!request) return;
  cancelApprovalTimeout(requestId);
  State.rememberApproval(request, "Timed out");
  State.setPillBadge(RAPHAEL_TASK, null);
  show("idle", null);
  State.isPinned = State.pendingApprovals.length > 0;
  Visibility.setPinned(State.isPinned);
  if (!State.pendingApproval && ["approval", "question"].includes(State.view)) {
    island.dropPin();
    island.setView(State.defaultView());
  }
}

export function toggleRaphaelMute(): boolean {
  if (!State.settings.raphaelEnabled || !Raphael.ready) return false;
  void Bridge.raphaelSend({ t: "mute", v: !Raphael.muted });
  return true;
}

export function stopRaphael(): void {
  void Bridge.raphaelSend({ t: "stop" });
}

export async function registerRaphaelHandlers(island: Island): Promise<() => void> {
  const stop = await onEvent<RaphaelEvent>("raphael", event => handleRaphael(island, event));
  return () => { stop(); window.clearTimeout(reminderTimer); };
}

/** Settings turned Raphael off: forget its task and any open card. */
export function syncRaphaelSettings(island: Island): void {
  if (State.settings.raphaelEnabled) return;
  Raphael.ready = Raphael.busy = Raphael.muted = false;
  for (const request of [...State.pendingApprovals])
    if (request.requestId.startsWith(RAPHAEL_PREFIX)) closeApproval(island, request.requestId);
  State.removeTask(RAPHAEL_TASK);
}
