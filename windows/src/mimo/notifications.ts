// SPDX-License-Identifier: MIT
import type { AgentTask, IntegrationInfo, PillBadge } from "../core/state";
import { codingProvider } from "../core/coding";
import { codingQuiet } from "../core/coding-progress";

export type MiniNotificationBadge = PillBadge | "working";

/** The shared VS Code slot represents real sessions, including background agents. */
export function miniNotificationTask(task: AgentTask, tasks: AgentTask[], preferred?: AgentTask | null): AgentTask {
  if (task.id !== "integration_claude" || !task.isIntegration) return task;
  const priority = (task: AgentTask) => {
    const badge = miniNotification(task).badge;
    return badge === "error" ? 4 : badge === "approval" ? 3 : badge === "working" ? 2 : badge === "finished" ? 1 : 0;
  };
  let best = preferred && codingProvider(preferred) ? preferred : task;
  for (const candidate of tasks) if (codingProvider(candidate) && priority(candidate) > priority(best)) best = candidate;
  return best;
}

function serviceWorking(id: string, info?: IntegrationInfo): boolean {
  if (!info?.configured || !info.loaded || info.error) return false;
  const [key, field, states] = id === "integration_vercel" ? ["deployments", "state", ["BUILDING", "QUEUED", "INITIALIZING"]]
    : id === "integration_n8n" ? ["executions", "status", ["running", "waiting", "new"]]
    : id === "integration_github" ? ["checks", "state", ["pending"]] : [];
  const rows = key ? info.data[key as string] : null;
  return Array.isArray(rows) && rows.some(row => row && typeof row === "object" && states?.includes(row[field as string]));
}

/** Active work and unresolved attention remain visible after an event is read. */
export function miniNotification(task: AgentTask, info?: IntegrationInfo, paused = false): { badge: MiniNotificationBadge | null; label: string } {
  if (task.pillBadge === "error" || task.state === "error") return { badge: "error", label: "Needs attention" };
  if (task.pillBadge === "approval" || task.state === "approval") return { badge: "approval", label: "Needs approval" };
  if (task.state === "question") return { badge: "approval", label: "Needs an answer" };
  if (task.state === "ratelimit") return { badge: "approval", label: "Usage limit reached" };
  if (!paused && (["working", "thinking", "searching"].includes(task.state) || serviceWorking(task.id, info)))
    return { badge: "working", label: codingQuiet(task) ? "No recent activity" : "Working" };
  return task.pillBadge === "finished"
    ? { badge: "finished", label: task.activity?.stopped ? "Stopped · unread update"
      : task.isIntegration && !codingProvider(task) ? "New activity" : "Finished" }
    : { badge: null, label: "" };
}
