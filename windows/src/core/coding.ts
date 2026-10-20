// SPDX-License-Identifier: MIT
import type { AgentTask, Settings } from "./state";
import { chatDefinition } from "./chat-providers";

export const CODING_PROVIDERS = [
  { id: "claude", name: "Claude Code", source: "claudeCode" },
  { id: "codex", name: "Codex", source: "codexCode" },
  { id: "cursor", name: "Cursor", source: "cursorAgent" },
  { id: "gemini", name: "Gemini CLI", source: "geminiCli" },
  { id: "antigravity", name: "Antigravity", source: "antigravity" },
  { id: "muse", name: "Muse Code", source: "museCode" },
  { id: "opencode", name: "OpenCode", source: "openCode" },
  { id: "copilot", name: "Copilot CLI", source: "copilotCli" },
  { id: "hermes", name: "Hermes Agent", source: "hermesAgent" },
] as const;
export type CodingProvider = typeof CODING_PROVIDERS[number]["id"];
export const CODING_IDS = Object.fromEntries(CODING_PROVIDERS.map(p =>
  [p.id, p.id === "claude" ? "integration_claude" : "coding_" + p.id])) as Record<CodingProvider, string>;
export function isCodingProvider(value: unknown): value is CodingProvider {
  return CODING_PROVIDERS.some(p => p.id === value);
}
export function codingDefinition(provider: CodingProvider) {
  return CODING_PROVIDERS.find(p => p.id === provider)!;
}

/** Provider identity dots reuse the existing interface and syntax colors. */
const ACCOUNT_COLORS: Record<CodingProvider, string> = {
  codex: "var(--green)", claude: "var(--amber)", cursor: "var(--ink-2)", gemini: "var(--accent)",
  antigravity: "var(--code-keyword)", muse: "var(--red-text)",
  opencode: "var(--ink-2)", copilot: "var(--code-type)", hermes: "var(--code-function)",
};
export function codingAccountColor(provider: CodingProvider): string { return ACCOUNT_COLORS[provider]; }

export function codingProvider(task: AgentTask | null | undefined): CodingProvider | null {
  return CODING_PROVIDERS.find(p => p.source === task?.source)?.id ?? null;
}

export function codingLabel(task: AgentTask | null | undefined): string {
  const provider = codingProvider(task);
  return provider === "claude" ? "Claude" : provider ? codingDefinition(provider).name : "VSCodium";
}

export function chatAssistantName(settings: Pick<Settings, "chatProvider">): string {
  return chatDefinition(settings.chatProvider).name.split(" · ")[0];
}

export function codingInstalled(settings: Settings, provider: CodingProvider): boolean {
  return provider === "claude" ? settings.hooksInstalled : provider === "codex"
    ? settings.codexHooksInstalled : settings.codingHooksInstalled[provider] === true;
}

/** Installed relays or a live local session; never infer a connection from a key. */
export function codingConnections(settings: Settings, tasks: AgentTask[]) {
  return Object.fromEntries(CODING_PROVIDERS.map(({ id }) => [id,
    codingInstalled(settings, id) || tasks.some(task => codingProvider(task) === id && !!task.sessionCwd),
  ])) as Record<CodingProvider, boolean>;
}

/** A live hook session detects an agent; installed hooks alone do not. */
export function detectedCodingProviders(tasks: AgentTask[]): CodingProvider[] {
  return CODING_PROVIDERS.map(provider => provider.id).filter(provider =>
    tasks.some(task => !!task.sessionId && codingProvider(task) === provider));
}

/** One explicit Limits selection shared by the header and account panel. */
export function preferredUsageProvider(settings: Settings, tasks: AgentTask[], active: AgentTask | null, selected: CodingProvider | null): CodingProvider {
  const connections = codingConnections(settings, tasks);
  const detected = detectedCodingProviders(tasks);
  const preferred = active && (active.state !== "idle" || active.sessionCwd)
    ? codingProvider(active) ?? settings.codingAssistant : settings.codingAssistant;
  if (detected.length) return selected && detected.includes(selected) ? selected
    : detected.includes(preferred) ? preferred : detected[0];
  return selected && connections[selected] ? selected : connections[preferred] ? preferred
    : CODING_PROVIDERS.find(p => connections[p.id])?.id ?? settings.codingAssistant;
}
