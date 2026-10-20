// SPDX-License-Identifier: MIT
// Claude Code and Codex hook events share one local subscription and audit UI.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, approvalMatches, type ApprovalInfo } from "../core/state";
import type { Island } from "./island";
import { CODING_IDS, codingDefinition, codingProvider, isCodingProvider, type CodingProvider } from "../core/coding";
import { activityText, codingActivity, type CodingActivityEvent } from "../core/coding-activity";
import { Visibility } from "../core/visibility";
import { sessionKey } from "../core/coding-session";
import { Activity } from "../core/activity";
import { codingUsage } from "../core/coding-usage";
import { ownsContent } from "../core/sections";
import { shouldNotify } from "../core/notices";
import { agentQuestions } from "../core/agent-question";
import { forgetPermissions, permissionInputKey, permissionRemembered } from "../core/permission-memory";

/** Clears the approval card if no decision was made before the hook gave up. */
const approvalTimers = new Map<string, number>();
const closedSessions = new Set<string>();
export function cancelApprovalTimeout(id?: string): void {
  for (const [key,timer] of approvalTimers) if (!id || key===id) {
    window.clearTimeout(timer);approvalTimers.delete(key);
  }
}
export function expireApprovals(island: Island): void {
  const hadPending=State.pendingApprovals.length>0;
  for (const request of [...State.pendingApprovals]) if ((request.deadline ?? Infinity)<=Date.now()) {
    cancelApprovalTimeout(request.requestId);
    State.rememberApproval(request,"Timed out · Review in tool");
    State.finishApproval(request.requestId);void Bridge.approvalDecline(request.requestId);
    if (request.taskId) State.updateTask(request.taskId,request.questions ? "question" : "working");
  }
  if (hadPending) {State.isPinned=State.pendingApprovals.length>0; Visibility.setPinned(State.isPinned);}
  if (State.isPinned && ['approval','question'].includes(State.view) && State.pendingApproval?.taskId)
    State.focusId=State.pendingApproval.taskId;
  if (!State.isPinned && ['approval','question'].includes(State.view)) { island.dropPin();island.setView(State.defaultView()); }
  State.notify();
}

interface HookPayload extends CodingActivityEvent {
  mimo_usage?: {totalTokens:number;cumulative:boolean};
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  notification_type?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  mimo_agent?: string;
  mimo_provider?: CodingProvider;
  vscode_pid?: string;
  mimo_questions?: unknown;
  mimo_response_channel?: "mcp";
}

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || isCodingProvider(raw)) return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
  apply_patch: "Modifie",
  exec_command: "Exécute",
  run_command: "Exécute",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) =>
    typeof input[k] === "string" ? (input[k] as string) : null;
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

function approvalInfo(payload: HookPayload): ApprovalInfo {
  const provider = payload.mimo_provider ?? "claude";
  const tool = payload.tool_name ?? "Tool";
  const input = payload.tool_input ?? {};
  return { requestId: payload.request_id ?? "", taskId: payload.session_id ? sessionKey(provider,payload.session_id) : CODING_IDS[provider], provider,
    toolUseId: payload.tool_use_id,
    sessionId: payload.session_id ?? "", tool, command: approvalTarget(tool, input),
    inputKey: permissionInputKey(input),
    reason: activityText(input.description ?? input.justification, 240) || undefined,
    cwd: payload.cwd || null, project: aliasProjectName(lastPathComponent(payload.cwd ?? "") || "Session"),
    ...(payload.hook_event_name === 'QuestionRequest' ? {questions:agentQuestions(payload.mimo_questions) ?? undefined} : {}) };
}

function clearSession(id: string) {
  const task = State.tasks.find(task => task.id === id);
  if (!task) return;
  task.steps = [];
  task.stepIndex = 0;
  const provider = codingProvider(task);
  task.name = provider && provider !== "claude" ? codingDefinition(provider).name : "VSCodium";
  task.pillBadge = null;
  task.activity = undefined;
  task.usage = undefined;
}

function cancelCompletion(id: string): void {
  const timer = completionTimers.get(id);
  if (timer != null) window.clearTimeout(timer);
  completionTimers.delete(id);
}

export function resetHookSession(island: Island): void {
  forgetPermissions();
  cancelApprovalTimeout();
  for (const timer of completionTimers.values()) window.clearTimeout(timer);
  completionTimers.clear();
  for (const request of [...State.pendingApprovals]) {
    State.rememberApproval(request,"Monitoring stopped · Review in tool");void Bridge.approvalDecline(request.requestId);
    State.finishApproval(request.requestId);
  }
  State.isPinned=false;island.dropPin();
  for (const task of [...State.tasks]) if (codingProvider(task) || task.source==='agent') {
    if (task.sessionId || task.source==='agent') State.removeTask(task.id);
    else {clearSession(task.id);State.updateTask(task.id,'idle');}
  }
  if (['approval','question'].includes(State.view)) island.setView(State.defaultView());
}
export function resetProviderSession(island: Island, provider: CodingProvider): void {
  forgetPermissions(provider);
  for (const request of [...State.pendingApprovals]) if (request.provider===provider) {
    cancelApprovalTimeout(request.requestId);State.rememberApproval(request,"Connection removed · Review in tool");
    State.finishApproval(request.requestId);void Bridge.approvalDecline(request.requestId);
  }
  for (const task of [...State.tasks]) if (codingProvider(task)===provider) {
    cancelCompletion(task.id);
    if (task.sessionId) closedSessions.add(task.id);
    if (task.sessionId || provider!=='claude') State.removeTask(task.id);
    else {clearSession(task.id);task.sessionCwd=null;State.updateTask(task.id,'idle');}
  }
  if (!State.pendingApproval) {State.isPinned=false;island.dropPin();}
}

export async function registerHookHandlers(
  island: Island,
): Promise<() => void> {
  let active = true;
  const stop = await onEvent<HookPayload>("hook", (payload) => {
    if (active) handleHook(island, payload);
  });
  return () => {
    active = false;
    stop();
    resetHookSession(island);
  };
}

const completionTimers = new Map<string, number>();

export function handleHook(island: Island, payload: HookPayload) {
  const provider = payload.mimo_provider ?? "claude";
  const notify=()=>shouldNotify('coding',State.settings.notices,State.settings.snoozeUntil);
  if (!isCodingProvider(provider)) return;
  const questionChannel = (provider === 'claude' && payload.tool_name === 'AskUserQuestion')
    || (payload.mimo_response_channel === 'mcp' && payload.tool_name === 'mimo.ask_user');
  if (payload.hook_event_name === "QuestionRequest" && (!questionChannel || !agentQuestions(payload.mimo_questions))) {
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }
  if (payload.hook_event_name === "PermissionRequest" && !["claude", "codex"].includes(provider)) {
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }
  if (
    State.paused ||
    !State.settings.modules.vscode
  ) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) {
      if (!State.paused && State.settings.modules.vscode && !validateAgent(payload.mimo_agent)) {
        const request = approvalInfo(payload);
        const owner = State.tasks.find(task => task.id === request.taskId);
        if (!owner?.sessionId || !request.sessionId || owner.sessionId === request.sessionId)
          State.rememberApproval(request, "Returned to editor");
      }
      void Bridge.approvalDecline(payload.request_id);
    }
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");

  // Route to the right pill. Valid mimo_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → Claude Code pill unchanged.
  const validAgent = validateAgent(payload.mimo_agent);
  const agentId = validAgent ? `agent_${validAgent}` : payload.session_id ? sessionKey(provider,payload.session_id) : CODING_IDS[provider];
  if (closedSessions.has(agentId)) {
    if (["SessionStart","UserPromptSubmit"].includes(name)) closedSessions.delete(agentId);
    else {if(payload.request_id) void Bridge.approvalDecline(payload.request_id);return;}
  }
  const isExternalAgent = validAgent !== null;

  const current = State.tasks.find(task => task.id === agentId);
  const session = payload.session_id;
  const toolResult = ["PostToolUse", "PostToolUseFailure"].includes(name);
  const hadPending=State.pendingApprovals.length>0;
  if (!isExternalAgent && toolResult)
    State.resolveMissedApproval(approvalInfo(payload), name === "PostToolUseFailure");
  Activity.observeHook(provider, payload as unknown as Record<string, unknown>);
  for (const approval of [...State.pendingApprovals]) if (approval.taskId===agentId &&
      ((toolResult && approvalMatches(approval,approvalInfo(payload))) || ['SessionEnd','Interrupt','Stop','StopFailure','UserPromptSubmit'].includes(name))) {
    cancelApprovalTimeout(approval.requestId);
    if (!(name === 'SessionEnd' && payload.mimo_response_channel === 'mcp'))
      State.rememberApproval(approval,toolResult ? 'Handled in tool' : 'Session moved on');
    if (toolResult) State.resolveMissedApproval(approvalInfo(payload),name==='PostToolUseFailure');
    State.finishApproval(approval.requestId);void Bridge.approvalDecline(approval.requestId);
  }
  if (hadPending && !State.pendingApproval && State.isPinned) { State.isPinned=false;island.dropPin(); }
  if (State.pendingApproval?.taskId && ['approval','question'].includes(State.view)) State.focusId=State.pendingApproval.taskId;
  if (hadPending && !State.pendingApproval && ['approval','question'].includes(State.view)) island.setView(State.defaultView());
  if (toolResult && current?.activity && codingActivity(payload,current.activity)===current.activity) return;
  if (["SessionStart", "UserPromptSubmit", "BeforeModel", "PreToolUse", "PostToolUse", "PermissionRequest", "QuestionRequest"].includes(name))
    cancelCompletion(agentId);
  // A fresh coding session can use the idle VS Code slot; ongoing work keeps focus.
  if (!isExternalAgent && ["SessionStart", "UserPromptSubmit", "BeforeModel", "BackgroundWork", "PreToolUse"].includes(name) && codingProvider(State.focusTask)
      && State.focusTask?.state === "idle" && !State.pendingApproval && !State.selectedCodingId)
    State.focusId = agentId;
  const focused = State.focusId === agentId;
  const workspaceVisible = focused && State.visibility === "expanded"
    && ["overview", "integrations"].includes(State.view) && State.codingTask?.id === agentId;

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (isAlert) {
      island.alert(view);
    } else if (State.visibility === "peek") {
      island.reveal();
    }
  };

  /** Ensure the agent pill exists (no-op for Claude Code). */
  const ensurePill = () => {
    if (isExternalAgent) {
      State.upsertExternalAgent(agentId, validAgent!, agentColor(validAgent!));
    } else {
      State.upsertCodingTask(provider, projectName, cwd, session);
      const task = State.tasks.find(task => task.id === agentId);
      if (task && session) task.sessionId = session;
      const pid=Number(payload.vscode_pid);
      if (task && !task.returnTarget && Number.isInteger(pid) && pid>0) void Bridge.captureReturnTarget(pid).then(target=>{
        if (!target || !State.tasks.includes(task)) return;
        task.returnTarget=target;State.notify();
      });
      const info = State.integrations[agentId] ?? { data: {}, error: null };
      State.integrations[agentId] = { ...info, configured: true, loaded: true };
    }
  };
  const updateActivity = () => {
    const task = State.tasks.find(task => task.id === agentId);
    if (task && !isExternalAgent) {
      const previous = task.activity;
      const next = codingActivity(payload, previous);
      if (next && next !== previous && !next.completed) {
        const begins = ["UserPromptSubmit", "BeforeModel", "BackgroundWork", "PreToolUse", "PermissionRequest"].includes(name);
        const repeated = previous?.phase === "running" && next.toolUseId && next.toolUseId === previous.toolUseId;
        next.startedAt = begins && !repeated ? Date.now() : previous?.startedAt;
      }
      task.activity = next;
    }
  };

  if (!current && !["SessionEnd","Interrupt"].includes(name)) ensurePill();
  const usageTask = State.tasks.find(task => task.id === agentId);
  if (usageTask && !isExternalAgent) usageTask.usage = codingUsage(payload, usageTask.usage);
  switch (name) {
    case "BackgroundWork":
    case "BeforeModel":
      ensurePill();
      updateActivity();
      State.updateTask(agentId, name === "BackgroundWork" ? "working" : "thinking");
      surface("overview", false);
      break;
    case "SessionStart":
      clearSession(agentId);
      ensurePill();
      State.updateTask(agentId, "idle");
      surface("overview", false);
      break;

    case "UserPromptSubmit": {
      ensurePill();
      updateActivity();
      State.updateTask(agentId, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(agentId, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      ensurePill();
      updateActivity();
      State.updateTask(agentId, "working");
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(agentId, stepLabel(tool, payload.tool_input ?? {}));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      updateActivity();
      State.updateTask(agentId, "working");
      break;

    case "PostToolUseFailure":
      updateActivity();
      State.updateTask(agentId, "working");
      State.appendStep(agentId, "⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(agentId, "ratelimit");
        if(notify())Sound.play("rate");
      } else if (["idle_prompt","permission_prompt"].includes(payload.notification_type ?? "") || message.endsWith("?")) {
        State.updateTask(agentId, "question");
        State.appendStep(agentId, message);
        if(notify()) {
          Sound.play("approval");island.reveal();
          if (!State.pendingApproval && (State.visibility !== 'expanded' || !ownsContent(State.view))) {
            State.focusId=agentId;island.alert('question');
          }
        }
      }
      break;
    }

    case "Stop": {
      if (current?.state === "finished" || current?.activity?.completed) break;
      updateActivity();
      State.updateTask(agentId, "finished");
      if (notify()) Sound.play("finish");
      if (payload.message)
        State.appendStep(agentId, payload.message.slice(0, 60));
      if (focused) surface(isExternalAgent ? "finished" : "integrations", false);
      if (!workspaceVisible) State.setPillBadge(agentId, "finished");
      const completion = window.setTimeout(() => {
        completionTimers.delete(agentId);
        if (!State.settings.modules.vscode || State.tasks.find(task => task.id === agentId)?.state !== "finished") return;
        if (isExternalAgent) {
          State.removeTask(agentId);
        } else {
          State.updateTask(agentId, "idle");
        }
      }, 5200);
      cancelCompletion(agentId);
      completionTimers.set(agentId, completion);
      break;
    }

    case "StopFailure":
      updateActivity();
      State.updateTask(agentId, "error");
      if(notify())Sound.play("error");
      if (focused && notify()) surface("error", true);
      else State.setPillBadge(agentId, "error");
      break;

    case "SessionEnd":
    case "Interrupt":
      forgetPermissions(provider, payload.session_id);
      cancelCompletion(agentId);
      if (isExternalAgent) {
        State.removeTask(agentId);
      } else {
        updateActivity();
        State.updateTask(agentId, "idle");
        if (!workspaceVisible && !current?.activity?.completed && current?.pillBadge !== "error")
          State.setPillBadge(agentId, "finished");
      }
      break;

    case "SubagentStart":
      State.appendStep(agentId, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(agentId, "• subagent done");
      break;

    case "PermissionRequest":
    case "QuestionRequest": {
      // Registered providers can ask through MCP. Custom observer agents keep
      // their terminal response flow and cannot become permission relays.
      if (isExternalAgent) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      if (!requestId) break;
      ensurePill();updateActivity();
      const first=State.pendingApprovals.length===0;
      const request={...approvalInfo(payload),returnTarget:State.tasks.find(t=>t.id===agentId)?.returnTarget};
      if (request.questions) request.command=request.questions[0].question;
      if (!request.questions && permissionRemembered(request)) {
        void Bridge.approvalDecision(requestId,'allow');
        State.updateTask(agentId,'working');
        break;
      }
      State.enqueueApproval(request);State.updateTask(agentId,request.questions ? 'question' : 'approval');
      State.isPinned=true;Visibility.setPinned(true);
      if(first && notify())Sound.play('approval');
      // Questions and permissions take priority over Working mode and open
      // content. Keep the selected request and any unfinished answer in place.
      State.focusId=State.pendingApproval?.taskId ?? agentId;
      if (State.visibility !== 'expanded' || State.view !== State.pendingReviewView)
        island.expand(State.pendingReviewView,true);
      State.setPillBadge(agentId,'approval');
      void Bridge.approvalAck(requestId);
      if (!approvalTimers.has(requestId)) approvalTimers.set(requestId,window.setTimeout(()=>expireApprovals(island),107_000));
      break;
    }

    default:
      break;
  }
  const observed = State.tasks.find(task => task.id === agentId);
  if (observed && !isExternalAgent) observed.lastEventAt = Date.now();
  if (['SessionEnd','Interrupt'].includes(name) && session && !isExternalAgent) {
    // Retain one bounded result in the provider's existing slot. Ended sessions
    // still leave the live list and reject late events through the tombstone.
    const ended = State.tasks.find(task => task.id === agentId);
    const selected = State.selectedCodingId === agentId;
    const previousLatest = State.lastCodingId;
    const retained = ended?.activity ? State.upsertCodingTask(provider, ended.name, cwd) : null;
    if (ended && retained) {
      retained.state = "idle";
      retained.activity = ended.activity;
      retained.usage = ended.usage;
      retained.lastEventAt = ended.lastEventAt;
      retained.pillBadge = ended.pillBadge;
      retained.steps = [...ended.steps];
      retained.stepIndex = ended.stepIndex;
      retained.returnTarget = ended.returnTarget;
    }
    if (selected && retained) State.selectedCodingId = retained.id;
    closedSessions.add(agentId);State.removeTask(agentId);
    if (previousLatest !== agentId && State.tasks.some(task => task.id === previousLatest)) State.lastCodingId = previousLatest;
    if (focused && retained) State.focusId = retained.id;
    if (closedSessions.size>128) closedSessions.delete(closedSessions.values().next().value!);
  }
  State.notify();
}
