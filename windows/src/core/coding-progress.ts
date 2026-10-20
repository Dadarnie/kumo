// SPDX-License-Identifier: MIT
import { codingTarget, type CodingStage } from "./coding-activity";
import type { AgentTask } from "./state";
import { codingLabel } from "./coding";

export type CodingProgressState = "active" | "complete" | "waiting" | "failed" | "stopped" | "idle";
export type CodingStageState = Exclude<CodingProgressState, "idle"> | "inactive";

const STAGES = ["Read", "Edit", "Run", "Done"] as const;
const LABELS = { Read: "Read", Edit: "Edit", Run: "Bash", Done: "Done" } as const;
const ACTIVE_LABELS: Record<string, string> = {
  Read: "Read", Edit: "Edit", Write: "Edit", Run: "Bash", Find: "Finding files",
  Search: "Searching", Fetch: "Fetching", List: "Listing files", Plan: "Planning", Delegate: "Delegating",
};

/** Two compact lines from observed work, matching the supplied working-island reference. */
export const CODING_QUIET_AFTER_MS = 90_000;

export function codingQuiet(task: Pick<AgentTask, "state" | "activity" | "lastEventAt">, paused = false, now = Date.now()): boolean {
  return !paused && ["working", "thinking", "searching"].includes(task.state) && task.activity?.phase !== "failed"
    && Number.isFinite(task.lastEventAt) && now - task.lastEventAt! >= CODING_QUIET_AFTER_MS;
}

export function compactCodingProgress(task: AgentTask, updatesPaused = false, now = Date.now()) {
  const progress = codingProgress(task, updatesPaused);
  const activity = task.activity;
  const action = activity?.action;
  const target = progress.target;
  const result = { title: "Working", detail: target || activity?.intent || "Following your agent",
    state: progress.state as CodingProgressState | "quiet", indicator: "dots", metric: "", changes: null as CodingActivityChanges | null,
    review: false, timed: false, code: !!target };
  if (progress.done) {
    const files = activity?.files?.filter(file => file.phase === "complete") ?? [];
    const changes = files.reduce((sum, file) => ({ added: sum.added + (file.changes?.added ?? 0),
      removed: sum.removed + (file.changes?.removed ?? 0) }), { added: 0, removed: 0 });
    result.title = "Finished";
    result.detail = files.length ? `${files.length} ${files.length === 1 ? "file" : "files"}`
      + (changes.added || changes.removed ? ` · +${changes.added} −${changes.removed}` : "")
      : activity?.summary || "Turn finished";
    result.indicator = "none"; result.review = true; result.code = false;
  } else if (progress.state === "stopped") {
    result.title = activity?.stopped === "interrupted" ? "Stopped" : "Session ended";
    result.detail = target || "Review the last activity";
    result.indicator = "none"; result.review = true;
  } else if (updatesPaused) {
    result.title = "Updates paused"; result.detail = "Resume to follow your agent";
    result.indicator = "none"; result.code = false;
  } else if (progress.state === "waiting") {
    result.title = task.state === "approval" ? "Needs your approval" : task.state === "question" ? "Needs your answer" : "Rate limited";
    result.detail = target || progress.hint; result.indicator = "none"; result.review = true;
  } else if (progress.state === "failed") {
    result.title = "Needs a look"; result.detail = target || progress.hint;
    result.indicator = "none"; result.review = true;
  } else if (progress.active && codingQuiet(task, updatesPaused, now)) {
    const lastUpdate = new Date(task.lastEventAt!).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    result.title = "No recent activity";
    result.detail = `${codingLabel(task)} · last update ${lastUpdate}`;
    result.state = "quiet"; result.indicator = "none"; result.review = true; result.code = false;
  } else if (task.state === "thinking") {
    result.title = "Thinking"; result.detail = activity?.intent || "Planning the change"; result.code = false;
  } else if (activity?.phase === "complete") {
    result.title = "Working"; result.detail = "Waiting for next action"; result.code = false;
  } else if (action === "Read") {
    result.title = "Reading files"; result.indicator = "ring";
    const count = activity?.stageCounts?.Read ?? 0;
    result.metric = count ? `${count} read` : "";
  } else if (action === "Edit" || action === "Write") {
    result.title = codingLabel(task); result.detail = `Editing ${target || "file"}`;
    result.changes = activity?.changes ?? null;
  } else if (action === "Run") {
    result.title = /\b(?:npm|pnpm|yarn|bun|cargo|go|dotnet)\s+(?:run\s+)?test\b|\b(?:pytest|vitest|jest)\b|\bnode\s+--test\b/i.test(target)
      ? "Running tests" : "Running command";
    result.detail = target ? "$ " + target : "Command in progress";
    result.indicator = "ring"; result.timed = true;
  } else if (["Find", "Search", "Fetch", "List"].includes(action ?? "") || task.state === "searching") {
    result.title = "Searching"; result.indicator = "ring";
  }
  return result;
}

type CodingActivityChanges = { added: number; removed: number };

/** Current operation and observed results; stages are not a predicted workflow. */
export function codingProgress(task: Pick<AgentTask, "state" | "activity" | "sessionCwd">, updatesPaused = false) {
  const { activity } = task;
  const action = activity?.action ?? "";
  const stage = ["Edit", "Write"].includes(action) ? "Edit" : ["Read", "Run"].includes(action) ? action as CodingStage : null;
  const waiting = ["approval", "question", "ratelimit"].includes(task.state);
  const stopped = !waiting && task.state === "idle" && !!activity?.stopped;
  const done = !waiting && (task.state === "finished" || (task.state === "idle" && !!activity?.completed));
  const failed = !stopped && !done && !waiting && (activity?.phase === "failed" || task.state === "error");
  const complete = !stopped && !failed && !waiting && (done || activity?.phase === "complete");
  const active = !done && !waiting && !failed && ["working", "thinking", "searching"].includes(task.state);
  const operationActive = active && !complete;
  const paused = updatesPaused && active;
  const state: CodingProgressState = waiting || paused ? "waiting" : failed ? "failed"
    : stopped ? "stopped" : done ? "complete" : active ? "active" : complete ? "complete" : "idle";
  const label = stopped ? activity?.stopped === "interrupted" ? "Stopped" : "Session ended" : paused ? "Updates paused" : done ? "Done" : task.state === "approval" ? "Needs approval"
    : task.state === "question" ? "Needs your answer" : task.state === "ratelimit" ? "Rate limited"
    : failed ? `${stage ?? (action || "Action")} failed`
    : complete ? action === "Edit" || action === "Write" ? "Edit applied" : `${action || "Action"} complete`
    : task.state === "thinking" ? "Thinking" : active ? ACTIVE_LABELS[action] ?? "Working" : "Ready";
  const hint = stopped ? "Review the last activity in VSCodium" : paused ? "Resume updates to follow progress" : done ? activity?.summary || "Turn finished"
    : task.state === "approval" ? "Waiting for your decision" : task.state === "question" ? "Waiting for your reply"
    : task.state === "ratelimit" ? "Waiting to resume" : failed ? "Review the result in VSCodium"
    : complete ? "Waiting for next action" : active ? "In progress" : "Waiting for activity";
  const target = activity ? codingTarget(activity, task.sessionCwd) : "";
  const completedCount = activity?.completedCount ?? activity?.completedActions?.length ?? 0;
  const countLabel = completedCount ? `${completedCount} ${completedCount === 1 ? "action" : "actions"} completed` : "";
  const stages = STAGES.map(name => {
    const count = name === "Done" ? 0 : activity?.stageCounts?.[name] ?? (activity?.completedActions?.includes(name) ? 1 : 0);
    const current = name === "Done" ? done : name === stage && !done;
    const stageState: CodingStageState = name === "Done" ? done ? "complete" : "inactive"
      : current && failed ? "failed" : current && !complete && (waiting || paused) ? "waiting"
      : current && operationActive ? "active" : count ? "complete" : "inactive";
    const status = stageState === "active" ? "in progress" : stageState === "waiting" ? "waiting"
      : stageState === "failed" ? "failed" : stageState === "complete" ? name === "Done" ? "turn finished" : `${count} completed`
      : "no completed activity";
    return { name, label: LABELS[name], state: stageState, count,
      current: current && (stageState !== "inactive" && stageState !== "complete" || name === "Done"),
      description: `${LABELS[name]}: ${status}${stageState !== "complete" && count ? `, ${count} completed` : ""}` };
  });
  return { state, label, hint, target, countLabel, completedCount, stages, stage, done,
    active: active && !paused, operationActive: operationActive && !paused };
}
