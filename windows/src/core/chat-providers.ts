// SPDX-License-Identifier: MIT
/** Chat APIs are independent of editor tools and their account sign-ins. */
export const CHAT_PROVIDERS = [
  { id: "anthropic", name: "Claude", key: "anthropic-api-key", model: "claude-opus-5",
    models: [["claude-sonnet-5-5", "Claude Sonnet 5.5"], ["claude-opus-5-5", "Claude Opus 5.5"],
      ["claude-haiku-5-5", "Claude Haiku 5.5"], ["claude-opus-5", "Claude Opus 5"],
      ["claude-sonnet-5", "Claude Sonnet 5"], ["claude-haiku-4-5", "Claude Haiku 4.5"]],
    hint: "Uses your Anthropic API account, separate from Claude Code.", url: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI", key: "openai-api-key", model: "gpt-6.1-sol",
    models: [["gpt-6.1-sol", "GPT-6.1 Sol"], ["gpt-6-astra", "GPT-6 Astra"], ["gpt-6-luna", "GPT-6 Luna"]],
    hint: "Uses your OpenAI API account, separate from Codex.", url: "https://platform.openai.com/api-keys" },
  { id: "gemini", name: "Gemini", key: "gemini-api-key", model: "gemini-2.5-flash-lite",
    models: [["gemini-3.8-flash", "Gemini 3.8 Flash"], ["gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"],
      ["gemini-3.1-pro-preview", "Gemini 3.1 Pro · Preview"], ["gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite"],
      ["gemini-2.5-flash", "Gemini 2.5 Flash"], ["gemini-2.5-pro", "Gemini 2.5 Pro"]],
    hint: "Uses your Gemini API quota. Paid keys can incur charges. Google may use free-tier content to improve Gemini.", url: "https://ai.google.dev/gemini-api/docs/pricing" },
  { id: "openrouter", name: "OpenRouter · free models", key: "openrouter-api-key", model: "openrouter/free",
    models: [["openrouter/free", "Free model router"], ["nvidia/nemotron-3-ultra-550b-a55b:free", "Nemotron 3 Ultra · Free"],
      ["nvidia/nemotron-3.5-lightning:free", "Nemotron 3.5 Lightning · Free"], ["poolside/laguna-s-2.1:free", "Laguna S 2.1 · Free"]],
    hint: "Free models, with usage limits. Choose the free router or a model ending in :free.", url: "https://openrouter.ai/collections/free-models" },
  { id: "xai", name: "Grok", key: "xai-api-key", model: "grok-4.7",
    models: [["grok-4.7", "Grok 4.7"]],
    hint: "Uses xAI API billing. This key can also handle voice messages.", url: "https://console.x.ai" },
  { id: "groq", name: "Groq", key: "groq-api-key", model: "openai/gpt-oss-120b",
    models: [["openai/gpt-oss-120b", "GPT OSS · 120B"], ["openai/gpt-oss-20b", "GPT OSS · 20B"]],
    hint: "Uses your Groq API quota. Voice replies use its English speech model.", url: "https://console.groq.com/keys" },
  { id: "ollama", name: "Ollama · local models", key: null, model: "hermes3",
    models: [["hermes3", "Hermes 3"], ["hermes3:3b", "Hermes 3 · 3B"], ["llama3.2:3b", "Llama 3.2 · 3B"],
      ["qwen3:4b", "Qwen 3 · 4B"], ["gemma3:4b", "Gemma 3 · 4B"]],
    hint: "Runs on this PC. No key needed. Install your chosen model in Ollama first.", url: "https://ollama.com/library" },
] as const;
export type ChatProvider = typeof CHAT_PROVIDERS[number]["id"];
export type ChatModels = Record<ChatProvider, string>;
export const DEFAULT_CHAT_MODELS = Object.fromEntries(CHAT_PROVIDERS.map(p => [p.id, p.model])) as ChatModels;
export function isChatProvider(value: unknown): value is ChatProvider {
  return CHAT_PROVIDERS.some(p => p.id === value);
}
export function chatDefinition(provider: ChatProvider) {
  return CHAT_PROVIDERS.find(p => p.id === provider)!;
}
export function validChatModel(provider: ChatProvider, model: string): boolean {
  if (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(model) || model.includes("..")) return false;
  if (provider === "gemini" && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model)) return false;
  if (provider === "openrouter" && model !== "openrouter/free"
      && (model.startsWith("openrouter/") || !model.endsWith(":free"))) return false;
  // Cloud-tagged Ollama models would send a local chat to a cloud service.
  return provider !== "ollama" || !/(?:[:\-]cloud)$/i.test(model);
}
