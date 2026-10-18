// SPDX-License-Identifier: MIT
export const VOICE_PROVIDERS = [
  { id: "auto", name: "Automatic" },
  { id: "openai", name: "OpenAI" },
  { id: "gemini", name: "Gemini" },
  { id: "xai", name: "Grok" },
  { id: "groq", name: "Groq · English voice" },
] as const;
export type VoiceProvider = typeof VOICE_PROVIDERS[number]["id"];
export type SpeechProvider = Exclude<VoiceProvider, "auto">;
export interface VoiceConnection { provider: SpeechProvider; name: string; readReplies: boolean; chatProvider?: import("./chat-providers").ChatProvider; chatName?: string }
export function isVoiceProvider(value: unknown): value is VoiceProvider {
  return VOICE_PROVIDERS.some(provider => provider.id === value);
}
