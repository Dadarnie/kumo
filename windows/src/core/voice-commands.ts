// SPDX-License-Identifier: MIT
export type VoiceCommand = "settings" | "home" | "limits" | "stop";
/** Only exact, deliberately addressed navigation commands bypass chat. */
export function voiceCommand(transcript: string): VoiceCommand | null {
  const words = transcript.toLowerCase().replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
  const command = words.replace(/^(?:hey )?(?:kumo|mimo)\s+/, "");
  if (command === words) return null;
  if (["open settings", "show settings"].includes(command)) return "settings";
  if (["go home", "show home", "open home"].includes(command)) return "home";
  if (["show limits", "open limits", "show usage", "open usage"].includes(command)) return "limits";
  if (["stop", "cancel", "stop voice chat"].includes(command)) return "stop";
  return null;
}
