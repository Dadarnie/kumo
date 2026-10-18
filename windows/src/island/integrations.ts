// SPDX-License-Identifier: MIT
// Integration events → island state. Port of the `handle…` methods in the Swift
// pollers: a genuinely new item flips the pill to finished/error, badges it when
// the service isn't visible, plays a sound, and settles its reaction after 60 s.
// The unread badge stays until the user opens the integration.

import { onEvent, Bridge, type IntegrationUpdate } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { CODING_IDS, CODING_PROVIDERS, codingConnections } from "../core/coding";
import type { Island } from "./island";
import { shouldNotify } from "../core/notices";

/** Which Credential Manager key backs each pill. */
const KEY_FOR: Record<string, string> = {
  integration_stripe: "stripe-api-key",
  integration_github: "github-token",
  integration_vercel: "vercel-token",
  integration_n8n: "n8n-api-key",
  integration_resend: "resend-api-key",
  integration_notion: "notion-api-key",
  integration_calcom: "calcom-api-key",
};

const clearTimers = new Map<string, number>();

export async function registerIntegrationHandlers(island: Island): Promise<() => void> {
  let active = true;
  const stop = await onEvent<IntegrationUpdate>("integration", (update) => {
    if (active) handle(island, update);
  });
  return () => {
    active = false;
    stop();
    for (const timer of clearTimers.values()) window.clearTimeout(timer);
    clearTimers.clear();
  };
}

/** Asks Rust which keys exist so the idle cards can say so. */
export async function refreshConfigured() {
  for (const [id, timer] of clearTimers) {
    if (
      !State.settings.modules.developerIntegrations ||
      !State.settings.activeIntegrations.includes(id)
    ) {
      window.clearTimeout(timer);
      clearTimers.delete(id);
    }
  }
  for (const [id, key] of Object.entries(KEY_FOR)) {
    if (
      !State.settings.modules.developerIntegrations ||
      !State.settings.activeIntegrations.includes(id)
    )
      continue;
    const present = (await Bridge.secretPresent(key)) ?? false;
    if (
      !State.settings.modules.developerIntegrations ||
      !State.settings.activeIntegrations.includes(id)
    )
      continue;
    const info = State.integrations[id] ?? {
      data: {},
      error: null,
      loaded: false,
      configured: false,
    };
    State.integrations[id] = { ...info, configured: present };
  }
  if (!State.settings.modules.vscode) {
    State.notify();
    return;
  }
  const connections = codingConnections(State.settings, State.tasks);
  const hooks = Object.values(connections).some(Boolean);
  const claude = State.integrations.integration_claude ?? {
    data: {},
    error: null,
    loaded: false,
    configured: false,
  };
  // VS Code is event driven; installed hooks are ready without a data fetch.
  State.integrations.integration_claude = { ...claude, configured: hooks, loaded: hooks };
  for (const { id } of CODING_PROVIDERS) {
    if (id === "claude") continue;
    const taskId = CODING_IDS[id];
    const info = State.integrations[taskId] ?? { data: {}, error: null, loaded: false, configured: false };
    State.integrations[taskId] = { ...info, configured: connections[id], loaded: connections[id] };
  }
  State.notify();
}

export function handle(island: Island, update: IntegrationUpdate) {
  if (
    State.paused ||
    !State.settings.modules.developerIntegrations ||
    !State.settings.activeIntegrations.includes(update.id)
  )
    return;

  const previous = State.integrations[update.id];
  State.integrations[update.id] = {
    data: update.error ? (previous?.data ?? {}) : update.data,
    error: update.error,
    loaded: update.error ? (previous?.loaded ?? false) : true,
    configured: previous?.configured ?? true,
  };

  const event = update.event;
  if (event) {
    const task = State.tasks.find((t) => t.id === update.id);
    if (task) {
      task.state = event.success ? "finished" : "error";
      task.steps = event.detail ? [event.label, event.detail] : [event.label];
      task.stepIndex = task.steps.length - 1;
      const visible = State.visibility === "expanded" && ["overview", "integrations"].includes(State.view)
        && State.focusId === update.id;
      if (!visible) {
        task.pillBadge = event.success ? "finished" : "error";
      }
      const notify=shouldNotify('other',State.settings.notices,State.settings.snoozeUntil);
      if(notify)Sound.play(event.success ? "finish" : "error");
      // Same as the Swift pollers: show the compact island so the badge is seen,
      // but never steal the screen for a successful deploy.
      if(notify)island.reveal();

      const existing = clearTimers.get(update.id);
      if (existing != null) window.clearTimeout(existing);
      clearTimers.set(
        update.id,
        window.setTimeout(() => {
          clearTimers.delete(update.id);
          const t = State.tasks.find((x) => x.id === update.id);
          if (!t || !["finished","error","question"].includes(t.state)) return;
          t.state = "idle";
          t.steps = [];
          t.stepIndex = 0;
          State.notify();
        }, 60_000),
      );
    }
  }

  State.notify();
}
