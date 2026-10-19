// SPDX-License-Identifier: MIT
import type { MimoGlyph } from "./glyphs";
import { settingsPath } from "./settings-path";

/** Solid companions to the existing navigation shapes, in the same 24px frame. */
export const homeFilled = {
  name: "home", filled: true,
  path: "M10.15 3.7a3 3 0 0 1 3.7 0l6.45 5.05a1.25 1.25 0 0 1-.77 2.23H19v6.27A3.25 3.25 0 0 1 15.75 20.5h-7.5A3.25 3.25 0 0 1 5 17.25v-6.27h-.53a1.25 1.25 0 0 1-.77-2.23ZM10 14.5v6h4v-6a2 2 0 0 0-4 0Z",
} as const satisfies MimoGlyph;

export const musicFilled = {
  name: "music-mode", filled: true,
  path: "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20ZM7.25 9a1 1 0 0 0-1 1v3a1 1 0 0 0 2 0v-3a1 1 0 0 0-1-1Zm4 0a1 1 0 0 0-1 1v3a1 1 0 0 0 2 0v-3a1 1 0 0 0-1-1Zm4-3v8.1a2.4 2.4 0 0 0-1-.2c-1.15 0-2.1.7-2.1 1.6s.85 1.5 1.95 1.5c1.3 0 2.4-.8 2.4-2.1V8.5l2.25.75V7.5Z",
} as const satisfies MimoGlyph;

export const integrationsFilled = {
  name: "integrations", filled: true,
  path: "M7 2.5h2v4h6v-4h2v4h1A1.5 1.5 0 0 1 19.5 8v4a7.5 7.5 0 0 1-6.5 7.43V22h-2v-2.57A7.5 7.5 0 0 1 4.5 12V8A1.5 1.5 0 0 1 6 6.5h1Z",
} as const satisfies MimoGlyph;

export const toolsFilled = {
  name: "utilities", filled: true,
  path: "M5.25 3.5h4a1.75 1.75 0 0 1 1.75 1.75v4A1.75 1.75 0 0 1 9.25 11h-4A1.75 1.75 0 0 1 3.5 9.25v-4A1.75 1.75 0 0 1 5.25 3.5Zm9.5 0h4a1.75 1.75 0 0 1 1.75 1.75v4A1.75 1.75 0 0 1 18.75 11h-4A1.75 1.75 0 0 1 13 9.25v-4a1.75 1.75 0 0 1 1.75-1.75ZM5.25 13h4A1.75 1.75 0 0 1 11 14.75v4a1.75 1.75 0 0 1-1.75 1.75h-4a1.75 1.75 0 0 1-1.75-1.75v-4A1.75 1.75 0 0 1 5.25 13Zm9.5 0h4a1.75 1.75 0 0 1 1.75 1.75v4a1.75 1.75 0 0 1-1.75 1.75h-4A1.75 1.75 0 0 1 13 18.75v-4a1.75 1.75 0 0 1 1.75-1.75Z",
} as const satisfies MimoGlyph;

export const usageFilled = {
  name: "usage", filled: true,
  path: "M4.5 12h1a1.25 1.25 0 0 1 1.25 1.25v5.5A1.25 1.25 0 0 1 5.5 20h-1a1.25 1.25 0 0 1-1.25-1.25v-5.5A1.25 1.25 0 0 1 4.5 12Zm7-8h1a1.25 1.25 0 0 1 1.25 1.25v13.5A1.25 1.25 0 0 1 12.5 20h-1a1.25 1.25 0 0 1-1.25-1.25V5.25A1.25 1.25 0 0 1 11.5 4Zm7 4h1a1.25 1.25 0 0 1 1.25 1.25v9.5A1.25 1.25 0 0 1 19.5 20h-1a1.25 1.25 0 0 1-1.25-1.25v-9.5A1.25 1.25 0 0 1 18.5 8Z",
} as const satisfies MimoGlyph;

export const settingsFilled = {
  name: "settings", filled: true,
  path: settingsPath,
} as const satisfies MimoGlyph;

export const soundFilled = {
  name: "sound", filled: true,
  path: "M10.3 5.75 7.25 8.5H5a1.5 1.5 0 0 0-1.5 1.5v4A1.5 1.5 0 0 0 5 15.5h2.25l3.05 2.75c.65.6 1.7.15 1.7-.75v-11c0-.9-1.05-1.35-1.7-.75ZM15.65 8.1a5.5 5.5 0 0 1 0 7.8l-1.2-1.2a3.8 3.8 0 0 0 0-5.4ZM18.3 5.5a9.2 9.2 0 0 1 0 13l-1.2-1.2a7.5 7.5 0 0 0 0-10.6Z",
} as const satisfies MimoGlyph;
export const soundOffFilled = {
  name: "sound-off", filled: true,
  path: "M10.3 5.75 7.25 8.5H5a1.5 1.5 0 0 0-1.5 1.5v4A1.5 1.5 0 0 0 5 15.5h2.25l3.05 2.75c.65.6 1.7.15 1.7-.75v-11c0-.9-1.05-1.35-1.7-.75Zm5.2 3 2.25 2.25 2.25-2.25 1.25 1.25-2.25 2.25 2.25 2.25-1.25 1.25-2.25-2.25-2.25 2.25-1.25-1.25 2.25-2.25-2.25-2.25Z",
} as const satisfies MimoGlyph;
