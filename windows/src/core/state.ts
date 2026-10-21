// SPDX-License-Identifier: MIT
// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandViewName } from "./layout";
import { Visibility, type IslandVisibility } from "./visibility";
import { DEFAULT_MODULES, type ModulePreferences } from "./modules";
import type { EyeShape } from "../mimo/engine";
import { normalizeAppearance, type Appearance } from "./appearance";
import { CODING_IDS, CODING_PROVIDERS, codingDefinition, codingInstalled, codingProvider, isCodingProvider, type CodingProvider } from "./coding";
import { CHAT_PROVIDERS, DEFAULT_CHAT_MODELS, isChatProvider, validChatModel, type ChatProvider, type ChatModels } from "./chat-providers";
import type { CodingActivity } from "./coding-activity";
import type { CodingUsage } from "./coding-usage";
import { normalizePower, type PowerSnapshot } from "./power";
import { sessionKey, type ReturnTarget } from "./coding-session";
import type { NoticePreferences } from "./notices";
import { MIMO_PICKER_COLORS } from "../mimo/palette";
import type { DesktopCompanionPosition } from "./companion";
import type { AgentQuestion } from "./agent-question";

export type AgentSource = typeof CODING_PROVIDERS[number]["source"] | "n8n" | "agent";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
  sessionId?: string | null;
  activity?: CodingActivity;
  usage?: CodingUsage;
  /** Latest real hook observation; no heartbeat polling or saved activity history. */
  lastEventAt?: number;
  returnTarget?: ReturnTarget;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
  taskId?: string;
  provider?: CodingProvider;
  reason?: string;
  cwd?: string | null;
  project?: string;
  toolUseId?: string;
  receivedAt?: number;
  deadline?: number;
  returnTarget?: ReturnTarget;
  questions?: AgentQuestion[];
  inputKey?: string;
}

export interface MissedApproval extends ApprovalInfo {
  missedAt: number;
  status: string;
  resolvedAt?: number;
  failed?: boolean;
}

/** Match an editor result to its original request, including parallel tool calls. */
export function approvalMatches(request: ApprovalInfo, action: ApprovalInfo): boolean {
  if (!action.sessionId || request.provider !== action.provider || request.sessionId !== action.sessionId
      || request.tool !== action.tool) return false;
  if (request.toolUseId && action.toolUseId) return request.toolUseId === action.toolUseId;
  if (action.command === action.tool) return false;
  const fileTool = ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "LS"].includes(action.tool);
  const windows = /^[a-z]:[\\/]/i.test(request.cwd ?? action.cwd ?? "");
  const normalize = (command: string) => {
    const text = fileTool ? command.replace(/\\/g, "/") : command;
    return fileTool && windows ? text.toLowerCase() : text;
  };
  return normalize(request.command) === normalize(action.command);
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  attachment?: string;
  attachments?: string[];
}

export interface ChatFile { name: string; path: string }

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string }
  | { kind: "files"; files: ChatFile[] };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string,
  name: string,
  color: string,
  source: AgentSource,
): AgentTask => ({
  id,
  name,
  color: MIMO_PICKER_COLORS[id] ?? color,
  state: "idle",
  stepIndex: 0,
  steps: [],
  source,
  isIntegration: true,
});

/** Stable integration identities, using the shared reference palette. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "VSCodium", "#F5F6F8", "claudeCode"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend",
  "integration_n8n",
  "integration_vercel",
  "integration_github",
  "integration_notion",
  "integration_calcom",
  "integration_stripe",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  notices: NoticePreferences;
  snoozeUntil: number;
  workflowShortcut: string;
  workflowSetupDone: boolean;
  appearance: Appearance;
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  islandAnchor: number | null;
  desktopCompanion: DesktopCompanionPosition | null;
  autostart: boolean;
  hooksInstalled: boolean;
  codingAssistant: CodingProvider;
  codingHooksInstalled: Partial<Record<CodingProvider, boolean>>;
  chatProvider: ChatProvider;
  chatModels: ChatModels;
  voiceProvider: import("./voice-providers").VoiceProvider;
  voiceShortcut: string;
  voiceRepliesEnabled: boolean;
  codexHooksInstalled: boolean;
  codexModel: string;
  usageEnabled: boolean;
  /** Claude model used by the chat. */
  model: string;
  autoCollapseEnabled: boolean;
  rememberCompactState: boolean;
  peekEnabled: boolean;
  workingModeEnabled: boolean;
  clockEnabled: boolean;
  grabEnabled: boolean;
  hoverBehaviorVersion: number;
  lastVisibility: IslandVisibility;
  modules: ModulePreferences;
  /** Run Raphael (local voice assistant) from raphaelDir as Kumo's assistant. */
  raphaelEnabled: boolean;
  raphaelDir: string;
}

export const DEFAULT_SETTINGS: Settings = {
  notices: {coding:true,other:true},
  snoozeUntil: 0,
  workflowShortcut: "Ctrl+Alt+M",
  workflowSetupDone: false,
  appearance: "dark",
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 1,
  absenceInterval: 180,
  activeIntegrations: [],
  screen: "primary",
  islandAnchor: null,
  desktopCompanion: null,
  autostart: false,
  hooksInstalled: false,
  codingAssistant: "claude",
  codingHooksInstalled: {},
  chatProvider: "anthropic",
  chatModels: { ...DEFAULT_CHAT_MODELS },
  voiceProvider: "auto",
  voiceShortcut: "Ctrl+Alt+V",
  voiceRepliesEnabled: true,
  codexHooksInstalled: false,
  codexModel: "gpt-6.1-sol",
  usageEnabled: true,
  model: "claude-opus-5",
  autoCollapseEnabled: true,
  rememberCompactState: true,
  lastVisibility: "island",
  peekEnabled: false,
  workingModeEnabled: true,
  clockEnabled: true,
  grabEnabled: true,
  hoverBehaviorVersion: 1,
  modules: { ...DEFAULT_MODULES },
  raphaelEnabled: false,
  raphaelDir: "",
};

/** Older settings keep their existing integration selection and gain module defaults. */
export function normalizeSettings(settings: Partial<Settings> = {}): Settings {
  const current = Object.fromEntries(Object.entries(settings).filter(([key]) =>
    Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key))) as Partial<Settings>;
  const chatModels = { ...DEFAULT_CHAT_MODELS, ...settings.chatModels };
  if (!settings.chatModels) {
    chatModels.anthropic = settings.model ?? DEFAULT_SETTINGS.model;
    chatModels.openai = settings.codexModel ?? DEFAULT_SETTINGS.codexModel;
  }
  for (const provider of CHAT_PROVIDERS)
    if (!validChatModel(provider.id, chatModels[provider.id])) chatModels[provider.id] = provider.model;
  return {
    ...DEFAULT_SETTINGS,
    ...current,
    notices: Object.fromEntries(Object.entries(DEFAULT_SETTINGS.notices).map(([source,fallback]) =>
      [source, typeof settings.notices?.[source as keyof NoticePreferences] === 'boolean'
        ? settings.notices[source as keyof NoticePreferences] : fallback])) as unknown as NoticePreferences,
    snoozeUntil: Number.isFinite(settings.snoozeUntil) && settings.snoozeUntil! > 0 ? settings.snoozeUntil! : 0,
    islandAnchor: typeof settings.islandAnchor === "number" && Number.isFinite(settings.islandAnchor)
      ? Math.max(0, Math.min(1, settings.islandAnchor)) : null,
    desktopCompanion: null,
    peekEnabled: false,
    workingModeEnabled: settings.workingModeEnabled !== false,
    grabEnabled: settings.grabEnabled !== false,
    raphaelEnabled: settings.raphaelEnabled === true,
    raphaelDir: typeof settings.raphaelDir === "string" ? settings.raphaelDir : "",
    appearance: normalizeAppearance(settings.appearance),
    codingAssistant: isCodingProvider(settings.codingAssistant) ? settings.codingAssistant : "claude",
    codingHooksInstalled: Object.fromEntries(CODING_PROVIDERS.map(({ id }) =>
      [id, settings.codingHooksInstalled?.[id] === true])),
    chatProvider: isChatProvider(settings.chatProvider) ? settings.chatProvider
      : settings.codingAssistant === "codex" ? "openai" : "anthropic",
    chatModels,
    voiceProvider: ["auto", "openai", "gemini", "xai", "groq"].includes(settings.voiceProvider ?? "") ? settings.voiceProvider! : "auto",
    voiceShortcut: typeof settings.voiceShortcut === "string" ? settings.voiceShortcut : "Ctrl+Alt+V",
    voiceRepliesEnabled: settings.voiceRepliesEnabled !== false,
    autoCollapseEnabled: true,
    rememberCompactState: true,
    hoverBehaviorVersion: 1,
    // Retain the serialized key for older builds; settling is automatic now.
    autoCloseInterval: 1,
    activeIntegrations: [
      ...(settings.activeIntegrations ?? DEFAULT_SETTINGS.activeIntegrations),
    ],
    modules: { ...DEFAULT_MODULES, ...settings.modules },
  };
}

type Listener = () => void;

class AppState {
  get visibility(): IslandVisibility {
    return Visibility.state;
  }
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;
  lastCodingId = CODING_IDS.claude as string;
  selectedCodingId: string | null = null;
  usageProvider: CodingProvider | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;
  power: PowerSnapshot = normalizePower(null);

  observePower(value: unknown): void {
    const power = normalizePower(value);
    if (power.onBattery === this.power.onBattery && power.percent === this.power.percent) return;
    this.power = power;
    this.notify();
  }

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;
  fileDragActive = false;

  promptContext: PromptContext | null = null;
  droppedFiles: ChatFile[] = [];
  get droppedFileLabel(): string | null {
    return this.droppedFiles.length > 1 ? `${this.droppedFiles.length} files` : this.droppedFiles[0]?.name ?? null;
  }
  chatAttachmentLoading: string | null = null;
  chatAttachmentVersion = 0;
  chatError = "";
  chatDraft = "";
  chatConnectionsVersion = 0;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  chatEpoch = 0;

  clearChat(keepDraftAndAttachment = false): void {
    this.chatEpoch++;
    this.chatHistory = [];
    this.stateOverride = null;
    if (!keepDraftAndAttachment || this.chatAttachmentLoading) this.clearAttachment();
    if (!keepDraftAndAttachment) this.chatDraft = "";
    this.chatError = "";
  }
  clearAttachment(): void {
    this.chatAttachmentVersion++;
    this.droppedFiles = [];
    this.promptContext = null;
    this.chatAttachmentLoading = null;
  }
  pendingApprovals: ApprovalInfo[] = [];
  private selectedApproval: string | null = null;
  get pendingApproval(): ApprovalInfo | null {
    return this.pendingApprovals.find(r=>r.requestId===this.selectedApproval) ?? this.pendingApprovals[0] ?? null;
  }
  get pendingReviewView(): "approval" | "question" {
    return this.pendingApproval?.questions?.length ? "question" : "approval";
  }
  set pendingApproval(request: ApprovalInfo | null) {
    if (request) { this.enqueueApproval(request); this.selectedApproval=request.requestId; }
    else if (this.pendingApproval) this.finishApproval(this.pendingApproval.requestId);
  }
  enqueueApproval(request: ApprovalInfo): void {
    if (this.pendingApprovals.some(r=>r.requestId===request.requestId)) return;
    this.pendingApprovals.push({...request,receivedAt:Date.now(),deadline:Date.now()+107_000});
  }
  selectApproval(id: string): void {
    if (!this.pendingApprovals.some(r=>r.requestId===id)) return;
    this.selectedApproval=id; this.notify();
  }
  finishApproval(id: string): ApprovalInfo | null {
    const request=this.pendingApprovals.find(r=>r.requestId===id) ?? null;
    this.pendingApprovals=this.pendingApprovals.filter(r=>r.requestId!==id);
    if (this.selectedApproval===id) this.selectedApproval=null;
    return request;
  }
  missedApprovals: MissedApproval[] = [];

  get missedApprovalCount(): number { return this.missedApprovals.filter(item => !item.resolvedAt).length; }
  get approvalCount(): number { return this.missedApprovalCount + this.pendingApprovals.length; }
  get approvalInboxCount(): number { return this.missedApprovals.length + this.pendingApprovals.length; }

  rememberApproval(request: ApprovalInfo, status: string): void {
    const owner = this.tasks.find(task => task.id === request.taskId);
    const previous = this.missedApprovals.find(item => item.requestId === request.requestId);
    const entry: MissedApproval = { ...previous, ...request,
      status: previous?.resolvedAt ? previous.status : status, missedAt: previous?.missedAt ?? Date.now(),
      cwd: request.cwd ?? previous?.cwd ?? owner?.sessionCwd,
      project: request.project ?? previous?.project ?? owner?.name };
    this.missedApprovals = [entry, ...this.missedApprovals.filter(item => item.requestId !== request.requestId)].slice(0,20);
    this.notify();
  }

  dismissApproval(requestId: string): void {
    this.missedApprovals = this.missedApprovals.filter(item => item.requestId !== requestId);
    this.notify();
  }

  resolveMissedApproval(action: ApprovalInfo, failed = false): void {
    const index = this.missedApprovals.findIndex(request => !request.resolvedAt
      && approvalMatches(request, action));
    if (index < 0) return;
    this.missedApprovals[index] = { ...this.missedApprovals[index], resolvedAt: Date.now(), failed,
      status: failed ? "Action failed" : "Approved · Completed" };
    this.notify();
  }

  integrations: Record<string, IntegrationInfo> = {};

  lastActivity = performance.now();

  settings: Settings = normalizeSettings();

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return (
      this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null
    );
  }

  get codingTask(): AgentTask | null {
    if (this.selectedCodingId) {
      const selected = this.tasks.find(task => task.id === this.selectedCodingId && (task.sessionId || task.activity) && codingProvider(task));
      if (selected) return selected;
      this.selectedCodingId = null;
    }
    const latest=this.tasks.find(task=>task.id===this.lastCodingId && task.sessionId && codingProvider(task));
    const active=(task:AgentTask|undefined|null)=>!!task && !["idle","finished"].includes(task.state);
    if(active(latest)) return latest!;
    const focused = this.focusTask;
    const live=this.tasks.find(task=>task.sessionId && codingProvider(task) && active(task));
    if(live) return live;
    if(latest) return latest;
    if (codingProvider(focused) || focused?.source === "agent") return focused;
    return this.tasks.find(task => task.id === this.lastCodingId)
      ?? this.tasks.find(task => task.id === CODING_IDS.claude) ?? null;
  }

  selectCodingTask(id: string | null): void {
    if (id && !this.tasks.some(task => task.id === id && (task.sessionId || task.activity) && codingProvider(task))) return;
    this.selectedCodingId = id;
    const task = this.codingTask;
    if (task) this.focusId = task.id;
    this.notify();
  }

  upsertCodingTask(provider: CodingProvider, name: string, cwd: string, sessionId?: string): AgentTask | null {
    const id = sessionId ? sessionKey(provider,sessionId) : CODING_IDS[provider];
    let current = this.tasks.find(task => task.id === id);
    if (!current && (provider !== "claude" || sessionId)) {
      current = { ...task(id, name, "#F5F6F8", codingDefinition(provider).source), isIntegration: false };
      const at = this.tasks.findIndex(task => task.id === CODING_IDS.claude) + 1;
      this.tasks.splice(at, 0, current);
    }
    if (!current) return null;
    current.name = name;
    if (sessionId) current.sessionId=sessionId;
    if (cwd) current.sessionCwd = cwd;
    this.lastCodingId = id;
    return current;
  }

  get effectiveState(): BotStateName {
    const request = this.pendingApprovals.find(r=>r.taskId===this.focusTask?.id);
    return request ? request.questions?.length ? "question" : "approval" : this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** Enabled modules and individually selected integrations own their tasks. */
  loadIntegrationTasks() {
    if (this.settings.modules.vscode)
      for (const { id, name } of CODING_PROVIDERS)
        if (id !== "claude" && codingInstalled(this.settings, id)
            && !this.tasks.some(task => task.id === CODING_IDS[id]))
          this.upsertCodingTask(id, name, "");
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
        proto.id === "integration_claude"
          ? this.settings.modules.vscode
          : this.settings.modules.developerIntegrations &&
            this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Order: integration_claude first, then agent_* pills (visible in slice(0,4)),
    // then other integrations in declaration order.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => {
      const isAgentA = a.id.startsWith("agent_");
      const isAgentB = b.id.startsWith("agent_");
      // integration_claude always first
      if (a.id === "integration_claude") return -1;
      if (b.id === "integration_claude") return 1;
      const codeA = codingProvider(a), codeB = codingProvider(b);
      if (codeA && !codeB) return -1;
      if (codeB && !codeA) return 1;
      if (codeA && codeB) return CODING_PROVIDERS.findIndex(p => p.id === codeA)
        - CODING_PROVIDERS.findIndex(p => p.id === codeB);
      // agent_* before other integrations; preserve insertion order among themselves
      if (isAgentA && !isAgentB) return -1;
      if (isAgentB && !isAgentA) return 1;
      if (isAgentA && isAgentB) return 0;
      // both known integrations → declaration order
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
    if (!this.settings.modules.vscode) {
      this.tasks = this.tasks.filter((task) => task.source !== "agent" && !codingProvider(task));
      if (["approval", "question", "error", "finished"].includes(this.view))
        this.view = this.defaultView();
    }
    if (!this.tasks.some((task) => task.id === this.focusId))
      this.focusId = this.tasks[0]?.id ?? null;
    this.notify();
  }

  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.tasks.splice(idx, 1);
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? null;
    this.notify();
  }

  /** Creates a dynamic agent_ pill on first event; no-ops if it already exists.
   *  Inserted right after integration_claude so it appears in the visible slice(0,4). */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const at = this.tasks.findIndex((t) => t.id === "integration_claude") + 1;
    this.tasks.splice(at, 0, {
      id,
      name,
      color,
      state: "idle",
      stepIndex: 0,
      steps: [],
      source: "agent",
      isIntegration: false,
    });
    if (!this.focusId) this.focusId = id;
    this.notify();
  }

  toggleIntegration(id: string) {
    if (id === "integration_claude") return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = "integration_claude";
    } else {
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  defaultView(): IslandViewName {
    return "overview";
  }
}

export const State = new AppState();
