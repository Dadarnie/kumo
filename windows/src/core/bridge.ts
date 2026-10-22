// SPDX-License-Identifier: MIT
// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings } from "./state";
import type { IslandVisibility } from "./visibility";
import type { CodexUsage, ClaudeUsage } from "./codex-usage";
import type { PowerSnapshot } from "./power";
import type { CodingProvider } from "./coding";
import type { ChatProvider } from "./chat-providers";
import type { ReturnTarget } from "./coding-session";
import type { DesktopCompanionPosition } from "./companion";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[mimo] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: {
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
  };
  position: IslandPositionInfo;
  version: string;
  hookPath: string;
  /** Windows global-cursor capability; retained in the existing boot contract. */
  cursorPoll: boolean;
  power: PowerSnapshot;
}

/** Island center, or the detached mascot's anchor, inside the retained native window. */
export interface IslandPositionInfo {
  anchorX: number;
  ratio: number | null;
  anchorY?: number;
  desktopCompanion?: DesktopCompanionPosition | null;
  dockReady?: boolean;
  dragMoved?: boolean;
  pickupHeld?: boolean;
  pickupOffsetX?: number;
  pickupOffsetY?: number;
  dockTargetX?: number;
  dockTargetY?: number;
}

/** An app holding the microphone right now (see src-tauri/src/windows/call.rs). */
export interface CallState {
  readonly app: string;
  readonly path: string | null;
  readonly startedAtUnixMs: number;
  readonly muted: boolean | null;
}

export interface StartApp { readonly name: string; readonly id: string; }
export interface DockerContainer { readonly id: string; readonly name: string; readonly image: string; readonly state: string; readonly status: string; }
export interface DockerState { readonly installed: boolean; readonly running: boolean; readonly containers: readonly DockerContainer[]; }
export interface OllamaModel { readonly name: string; readonly sizeVram: number; readonly size: number; }
export interface OllamaState { readonly running: boolean; readonly models: readonly OllamaModel[]; }
export interface ObsidianVault { readonly id: string; readonly name: string; }
/** A note in the vault's inbox/ (title from its frontmatter). */
export interface VaultNote { readonly path: string; readonly title: string; readonly modified: number; }

export const Bridge = {
  grabRead: () => callOrThrow<import("./grab").GrabSnapshot>("grab_read"),
  grabAction: <T = unknown>(action:string,args:Record<string,unknown> = {}) => callOrThrow<T>("grab_action",{action,args}),
  captureReturnTarget: (pid:number) => call<ReturnTarget>("capture_return_target", {pid}),
  returnToWork: (target:ReturnTarget | null, path:string | null, provider:CodingProvider | null = null) => call<"window" | "project" | "tool" | "unavailable">("return_to_work",{target,path,provider}),
  workflowShortcutStatus: () => call<{shortcut:string;registered:boolean;error:string|null}>("workflow_shortcut_status"),
  configureWorkflowShortcut: (shortcut:string) => callOrThrow<{shortcut:string;registered:boolean;error:string|null}>("configure_workflow_shortcut",{shortcut}),
  boot: () => call<BootInfo>("boot"),

  saveSettings: (settings: Settings) =>
    call<void>("save_settings", { settings }),

  setVisibility: (visibility: IslandVisibility) =>
    call<void>("set_island_visibility", { visibility }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number, radius: number) =>
    call<void>("set_island_rect", { x, y, width, height, radius }),

  /** Give the window keyboard focus (chat and media controls) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),
  beginIslandMove: (offsetX = 0, offsetY = 0) => call<IslandPositionInfo>("begin_island_move", {offsetX,offsetY}),
  moveIslandAnchor: () => call<IslandPositionInfo>("move_island_anchor"),
  finishIslandMove: () => call<IslandPositionInfo>("finish_island_move"),
  cancelIslandMove: () => call<IslandPositionInfo>("cancel_island_move"),
  showMimoMenu: () => call<void>("show_mimo_menu"),

  openUrl: (url: string) => call<void>("open_url", { url }),
  /** Brings the app playing the current media to the front. */
  openMediaSource: (appId: string) => call<boolean>("open_media_source", { appId }),
  callState: () => call<CallState | null>("call_state"),
  callFocus: () => call<boolean>("call_focus"),
  toolsApps: (refresh = false) => call<StartApp[]>("tools_apps", { refresh }),
  toolsLaunch: (id: string) => call<void>("tools_launch", { id }),
  toolsDocker: () => call<DockerState>("tools_docker"),
  toolsDockerAction: (id: string, action: "start" | "stop" | "restart") => call<void>("tools_docker_action", { id, action }),
  toolsOllama: () => call<OllamaState>("tools_ollama"),
  toolsOllamaUnload: (name: string) => call<void>("tools_ollama_unload", { name }),
  toolsVaults: () => call<ObsidianVault[]>("tools_vaults"),
  /** Saves inbox/<slug>.md; resolves to that path. */
  toolsQuickNote: (vault: string, text: string) => callOrThrow<string>("tools_quick_note", { vault, text }),
  toolsRecentNotes: (vault: string) => call<VaultNote[]>("tools_recent_notes", { vault }),
  toolsOpenNote: (vault: string, path: string) => callOrThrow<void>("tools_open_note", { vault, path }),

  /** "Open terminal" → opens the folder in VS Code when `code` is on PATH. */
  openInVSCode: (path: string | null) =>
    call<boolean>("open_in_vscode", { path }),

  quit: () => call<void>("quit_app"),

  openSettingsWindow: (page?:string) => call<void>("open_settings_window",{page:page ?? null}),
  installedCodingTools: () => call<string[]>("installed_coding_tools"),

  /** Writes to %LOCALAPPDATA%\Kumo\kumo.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Claude Code hooks ─────────────────────────────────────────────────────
  hooksStatus: (provider: CodingProvider = "claude") => call<HookStatus>("hooks_status", { provider }),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (install: boolean, provider: CodingProvider = "claude") =>
    callOrThrow<HookPreview>("hooks_preview", { install, provider }),
  /**
   * Writes ~/.claude/settings.json — only ever after an explicit click, and only
   * when the file still matches the preview the user looked at.
   */
  hooksApply: (install: boolean, fingerprint: string, provider: CodingProvider = "claude") =>
    callOrThrow<string>("hooks_apply", { install, fingerprint, provider }),
  codexUsage: (force = false) => callOrThrow<CodexUsage>("codex_usage", { force }),
  claudeUsage: () => callOrThrow<ClaudeUsage | null>("claude_usage"),

  approvalDecision: (requestId: string, decision: "allow" | "deny") =>
    requestId.startsWith("assistant:")
      ? call<void>("assistant_send", { msg: { t: "answer", id: Number(requestId.slice(10)), allow: decision === "allow" } })
      : call<void>("approval_decision", { requestId, decision }),
  questionAnswer: (requestId: string, answers: Record<string,string>) =>
    callOrThrow<void>("question_answer", {requestId,answers}),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) =>
    requestId.startsWith("assistant:")
      ? call<void>("assistant_send", { msg: { t: "answer", id: Number(requestId.slice(10)), allow: false } })
      : call<void>("approval_decline", { requestId }),
  /** One command to Kumo: answer, text, mute or stop (see kumo_bridge.py). */
  assistantSend: (msg: Record<string, unknown>) => call<void>("assistant_send", { msg }),
  /** Kumo's saved headlines (data/news.json in its folder), newest first. */
  assistantNews: () => call<NewsItem[]>("assistant_news"),
  assistantNewsSettings: () => call<NewsSettings | null>("assistant_news_settings"),
  saveAssistantNewsSettings: (value: NewsSettings) => callOrThrow<void>("assistant_news_settings_save", { value }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /** One chat turn. The API key and any file bytes never leave Rust. */
  chatSend: (query: string, context: ChatContext | null) =>
    callOrThrow<{ text: string }>("chat_send", { query, context }),
  chatReset: () => call<void>("chat_reset"),
  chatCancel: () => call<void>("chat_cancel"),
  voiceShortcutStatus: () => call<{shortcut:string;registered:boolean;error:string|null}>("voice_shortcut_status"),
  configureVoiceShortcut: (shortcut:string) => callOrThrow<{shortcut:string;registered:boolean;error:string|null}>("configure_voice_shortcut",{shortcut}),
  chatConnections: () => call<Partial<Record<ChatProvider, boolean>>>("chat_connections"),
  chatSelect: (provider: ChatProvider, model: string) =>
    callOrThrow<Settings>("chat_select", { provider, model }),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) =>
    callOrThrow<DroppedFile>("ingest_file", { path }),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) =>
    callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  // ── Integrations ──────────────────────────────────────────────────────────
  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => call<void>("open_n8n"),
  openN8nPage: (page: "executions" | "workflow", id: string) => call<void>("open_n8n_page", {page,id}),

  /** Tray → Pause. Stops the integration pollers, not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),
};

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

export type ChatContext =
  | { kind: "file"; name: string; path: string }
  | { kind: "files"; files: { name: string; path: string }[] }
  | { kind: "window"; appName: string; title: string; url?: string };

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
  usageReady?: boolean;
  usageCommand?: string | null;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Mimo");
  return invoke<T>(cmd, args);
}

export interface CursorSample {
  x: number;
  y: number;
  screenX?: number;
  screenY?: number;
  windowWidth?: number;
  control?: boolean;
  down?: boolean;
}

export type BridgeEvent =
  | { name: "cursor"; payload: CursorSample }
  | { name: "tray"; payload: string }
  | { name: "hook"; payload: Record<string, unknown> }
  | { name: "screen-changed"; payload: null };

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

/** Files dragged onto the island. Only reaches us when the window takes the mouse. */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  return listen<DragDropPayload>("mimo-file-drop", event => handler(event.payload));
}

/** Kumo's news settings (data/news_settings.json), edited in Settings › Kumo. */
export interface NewsSettings {
  interval_hours: number; digest: boolean; free_notice: boolean;
  sources: { name: string; url: string; category: string }[];
}

/** One headline from Kumo's news reader (news.py). */
export interface NewsItem {
  id: string; title: string; link: string; summary: string; source: string;
  categories: string[]; published: number; seen: number;
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
