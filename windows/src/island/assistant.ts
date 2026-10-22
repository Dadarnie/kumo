// SPDX-License-Identifier: MIT
// Kumo, the local voice assistant, as an agent in the island. The native
// sidecar (assistant.rs) relays kumo_bridge.py's JSON events as `assistant` events.
// Kumo is the `agent_assistant` task: the compact strip, Home pill and mascot
// follow its state. Its approvals use `assistant:<id>` request ids, which the
// bridge routes back to Kumo instead of the coding-agent pipe.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type AgentTask } from "../core/state";
import { Visibility } from "../core/visibility";
import type { Island } from "./island";
import { cancelApprovalTimeout } from "./hooks";

export const ASSISTANT_TASK = "agent_kumo";
export const ASSISTANT_PREFIX = "assistant:";
const REMINDER_MS = 30_000;

type AssistantEvent =
  | { t: "ready" | "unavailable" }
  | { t: "state"; v: "idle" | "listening" | "thinking" | "speaking" }
  | { t: "you" | "reply" | "note"; v: string }
  | { t: "activity"; icon: string; text: string }
  | { t: "muted"; v: boolean }
  | { t: "level"; v: number }
  | { t: "approve"; id: number; name: string; detail: string; danger: boolean; timeout: number }
  | { t: "approve_close"; id: number }
  | { t: "notify"; title: string; v: string }
  | { t: "news_updated"; count: number; free?: string[] }
  | { t: "exit"; code: number | null };

/** What the header's mic button and the voice shortcut need to know. */
export const Assistant = { ready: false, muted: false, busy: false, speaking: false };

function task(): AgentTask {
  State.upsertExternalAgent(ASSISTANT_TASK, "Kumo", "#f67e7d");
  return State.tasks.find(t => t.id === ASSISTANT_TASK)!;
}

function show(state: AgentTask["state"], status: string | null) {
  const t = task();
  t.state = state;
  t.statusText = status;
  t.lastEventAt = Date.now();
  Assistant.busy = state !== "idle";
  Assistant.speaking = status === "Speaking";
  State.notify();
}

let reminderTimer: number | undefined;
let chatId = 1_000_000_000;

/** Kumo's turns, spoken or typed, are the Chat tab's conversation. */
function chatLine(role: "user" | "assistant", content: string) {
  if (!content.trim()) return;
  State.chatHistory.push({ id: chatId++, role, content });
  if (State.chatHistory.length > 100) State.chatHistory.splice(0, State.chatHistory.length - 100);
}

export function handleAssistant(island: Island, event: AssistantEvent) {
  switch (event.t) {
    case "ready":
      Assistant.ready = true;
      show("idle", null);
      break;
    case "state":
      if (task().pillBadge === "approval") break; // an open approval outranks talking
      if (event.v === "thinking") show("thinking", "Thinking…");
      else if (event.v === "speaking") show("working", "Speaking");
      else if (task().pillBadge !== "finished") show("idle", null);
      break;
    case "you":
      chatLine("user", event.v);
      State.appendStep(ASSISTANT_TASK, `“${event.v.slice(0, 80)}”`);
      show("thinking", "Thinking…");
      break;
    case "reply":
      chatLine("assistant", event.v);
      State.appendStep(ASSISTANT_TASK, event.v.slice(0, 120));
      break;
    case "activity":
      if (event.icon === "▶") show("working", event.text.slice(0, 60));
      State.appendStep(ASSISTANT_TASK, `${event.icon} ${event.text}`.slice(0, 100));
      break;
    case "muted":
      Assistant.muted = event.v;
      State.notify();
      break;
    case "approve": {
      const requestId = ASSISTANT_PREFIX + event.id;
      State.enqueueApproval({
        requestId, sessionId: "", tool: event.name.replace(/_/g, " "), command: event.detail,
        taskId: ASSISTANT_TASK, agentName: "Kumo", danger: event.danger,
        reason: event.danger ? "Kumo marks this as able to change, delete or send something." : undefined,
      });
      State.setPillBadge(ASSISTANT_TASK, "approval");
      show("approval", "Approval needed");
      State.isPinned = true;
      Visibility.setPinned(true);
      Sound.play("approval");
      island.alert("approval");
      break;
    }
    case "approve_close":
      closeApproval(island, ASSISTANT_PREFIX + event.id);
      break;
    case "notify":
      notice(island, `⏰ ${event.v}`, event.v, "approval");
      break;
    case "news_updated": {
      const free = (event.free ?? []).filter(title => typeof title === "string" && title.trim());
      if (free.length) notice(island, `🆓 ${free.join(" · ")}`,
        free.length === 1 ? `Free: ${free[0]}` : `${free.length} new free finds · ${free[0]}`, "tick");
      break;
    }
    case "exit":
    case "unavailable":
      Assistant.ready = Assistant.busy = false;
      for (const request of State.pendingApprovals)
        if (request.requestId.startsWith(ASSISTANT_PREFIX)) closeApproval(island, request.requestId);
      if (!State.settings.assistantEnabled) State.removeTask(ASSISTANT_TASK);
      else show("error", event.t === "exit" ? "Restarting…" : "Not found: check its folder in Settings");
      break;
  }
}

/** A short message in the compact strip (reminders, free finds) that clears itself. */
function notice(island: Island, step: string, status: string, sound: Parameters<typeof Sound.play>[0]) {
  State.appendStep(ASSISTANT_TASK, step.slice(0, 120));
  State.setPillBadge(ASSISTANT_TASK, "finished");
  show("idle", status.slice(0, 80));
  Sound.play(sound);
  island.reveal();
  window.clearTimeout(reminderTimer);
  reminderTimer = window.setTimeout(() => {
    if (task().pillBadge === "finished") { State.setPillBadge(ASSISTANT_TASK, null); show("idle", null); }
  }, REMINDER_MS);
}

/** Kumo timed out or stopped: the card goes, nothing is sent back. */
function closeApproval(island: Island, requestId: string) {
  const request = State.finishApproval(requestId);
  if (!request) return;
  cancelApprovalTimeout(requestId);
  State.rememberApproval(request, "Timed out");
  State.setPillBadge(ASSISTANT_TASK, null);
  show("idle", null);
  State.isPinned = State.pendingApprovals.length > 0;
  Visibility.setPinned(State.isPinned);
  if (!State.pendingApproval && ["approval", "question"].includes(State.view)) {
    island.dropPin();
    island.setView(State.defaultView());
  }
}

export function toggleAssistantMute(): boolean {
  if (!State.settings.assistantEnabled || !Assistant.ready) return false;
  void Bridge.assistantSend({ t: "mute", v: !Assistant.muted });
  return true;
}

export function stopAssistant(): void {
  void Bridge.assistantSend({ t: "stop" });
}

export async function registerAssistantHandlers(island: Island): Promise<() => void> {
  const stop = await onEvent<AssistantEvent>("assistant", event => handleAssistant(island, event));
  return () => { stop(); window.clearTimeout(reminderTimer); };
}

/** Settings turned Kumo off: forget its task and any open card. */
export function syncAssistantSettings(island: Island): void {
  if (State.settings.assistantEnabled) return;
  Assistant.ready = Assistant.busy = Assistant.muted = false;
  for (const request of [...State.pendingApprovals])
    if (request.requestId.startsWith(ASSISTANT_PREFIX)) closeApproval(island, request.requestId);
  State.removeTask(ASSISTANT_TASK);
}
