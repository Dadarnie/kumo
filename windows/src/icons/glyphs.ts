// SPDX-License-Identifier: MIT
import { homeFilled, musicFilled, soundFilled, soundOffFilled } from "./filled";

/** Filled Mimo geometry. One path, 24px canvas, ~18px optical area per glyph.
 * Keep individual exports so unused designs can be removed by the bundler. */
export interface MimoGlyph {
  readonly name: string;
  readonly path: string;
  readonly filled?: boolean;
  readonly fillRule?: "evenodd" | "nonzero";
}

export const companion = {
  name: "companion", filled: true,
  path: "M12 5.25C6.65 5.25 3 7.9 3 12.5c0 4.15 3.25 6.25 9 6.25s9-2.1 9-6.25c0-4.6-3.65-7.25-9-7.25ZM8.5 11a.9.9 0 0 0-.9.9v1.7a.9.9 0 0 0 1.8 0v-1.7a.9.9 0 0 0-.9-.9Zm7 0a.9.9 0 0 0-.9.9v1.7a.9.9 0 0 0 1.8 0v-1.7a.9.9 0 0 0-.9-.9Z",
} as const satisfies MimoGlyph;

/** A softly arched shelter for Home, distinct from the companion's face. */
export const home = homeFilled;

export const winter = {
  name: "winter", filled: true, fillRule: "nonzero",
  path: "M11 3.5h2v17h-2ZM4.3 6.9l15.4 8.9-1 1.7L3.3 8.6Zm-1 8.9 15.4-8.9 1 1.7-15.4 8.9Z",
} as const satisfies MimoGlyph;

export const compactMode = {
  name: "compact-mode", filled: true,
  path: "M7.5 7.5h9a4.5 4.5 0 0 1 0 9h-9a4.5 4.5 0 0 1 0-9ZM6.7 11h1.6v2H6.7ZM11 11h6v2h-6Z",
} as const satisfies MimoGlyph;

export const expand = {
  name: "expand", filled: true,
  path: "M4 4h6v2H6v4H4Zm10 0h6v6h-2V6h-4ZM4 14h2v4h4v2H4Zm14 0h2v6h-6v-2h4Z",
} as const satisfies MimoGlyph;

export const collapse = {
  name: "collapse", filled: true,
  path: "M8 4h2v6H4V8h4Zm6 0h2v4h4v2h-6ZM4 14h6v6H8v-4H4Zm10 0h6v2h-4v4h-2Z",
} as const satisfies MimoGlyph;

export const musicMode = musicFilled;

export const affection = {
  name: "affection", filled: true,
  path: "M12 19.5C10 18.3 3.75 14 3.75 9.5c0-2.6 1.85-4.5 4.25-4.5 1.85 0 3.2 1 4 2.4.8-1.4 2.15-2.4 4-2.4 2.4 0 4.25 1.9 4.25 4.5 0 4.5-6.25 8.8-8.25 10Z",
} as const satisfies MimoGlyph;

export const mood = {
  name: "mood", filled: true,
  path: "M12 3.75c5.05 0 8.25 3.35 8.25 8.25s-3.2 8.25-8.25 8.25S3.75 16.9 3.75 12 6.95 3.75 12 3.75ZM7.7 8.5h1.6V11H7.7Zm7 0h1.6V11h-1.6ZM7.7 13.6c.8 2 2.25 3.15 4.3 3.15s3.5-1.15 4.3-3.15l-1.4-.65c-.65 1.5-1.55 2.25-2.9 2.25s-2.25-.75-2.9-2.25Z",
} as const satisfies MimoGlyph;

export const sleep = {
  name: "sleep", filled: true,
  path: "M12 8.5c-5 0-8.5 2.35-8.5 6.25 0 3.5 3.25 5.5 8.5 5.5s8.5-2 8.5-5.5C20.5 10.85 17 8.5 12 8.5ZM7 13h3v1.6H7Zm7 0h3v1.6h-3ZM13 3.5h5v1.4l-2.5 1.5H18v1.4h-5V6.4l2.5-1.5H13Z",
} as const satisfies MimoGlyph;

export const wake = {
  name: "wake", filled: true,
  path: "M12 9.25c-5 0-8.5 2.35-8.5 6 0 3.25 3.25 5 8.5 5s8.5-1.75 8.5-5c0-3.65-3.5-6-8.5-6ZM7.7 13.5h1.6v2.8H7.7Zm7 0h1.6v2.8h-1.6ZM11 3.5h2v3h-2ZM4.5 6l1.4-1.4L8 6.7 6.6 8Zm11.5.7 2.1-2.1L19.5 6 17.4 8Z",
} as const satisfies MimoGlyph;

/** Four quiet points evoke the four-digit secret without tiny lettering. */
export const secret = {
  name: "secret", filled: true,
  path: "M8.5 4.5h7c3.2 0 5 2.7 5 7.5s-1.8 7.5-5 7.5h-7c-3.2 0-5-2.7-5-7.5s1.8-7.5 5-7.5ZM7.5 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm3 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm3 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm3 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
} as const satisfies MimoGlyph;

export const unlock = {
  name: "unlock", filled: true,
  path: "M8 10V7.5a4.5 4.5 0 0 1 8.7-1.6l-1.9.7A2.5 2.5 0 0 0 10 7.5V10h5.75a3 3 0 0 1 3 3v4.25a3 3 0 0 1-3 3h-7.5a3 3 0 0 1-3-3V13A3 3 0 0 1 8 10Zm3 4v3h2v-3Z",
} as const satisfies MimoGlyph;

export const summonMimo = {
  name: "summon-mimo", filled: true,
  path: "M13.25 10.25c-4.3 0-7.25 1.85-7.25 5.25 0 3.05 2.75 4.75 7.25 4.75s7.25-1.7 7.25-4.75c0-3.4-2.95-5.25-7.25-5.25ZM9.7 14h1.6v2.5H9.7Zm5.5 0h1.6v2.5h-1.6ZM3 10.5C3 5.9 6.1 3 11 3h1l-1-1h3l3 3-3 3h-3l1-1h-1c-3.6 0-6 1.5-6 3.5Z",
} as const satisfies MimoGlyph;

export const interaction = {
  name: "interaction", filled: true,
  path: "M9 12.75V6.5a2 2 0 0 1 4 0v3.25h1.5c3.3 0 5 1.7 5 4.5v.5c0 3.75-2.3 5.75-5.75 5.75h-1.5c-2 0-3.55-.95-4.5-2.5L4.5 13.75c-.65-1.05-.15-2.25.85-2.65.65-.25 1.3-.1 1.9.5L9 13.25Z",
} as const satisfies MimoGlyph;

export const achievement = {
  name: "achievement", filled: true,
  path: "M12 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM9 8.8l2 2L14.6 7l1.2 1.2L11 13l-3.2-3.2ZM8.25 16.5l-.75 3.8c-.1.6.35 1.05.9.85L12 19.8l3.6 1.35c.55.2 1.02-.25.9-.85l-.75-3.8L12 18Z",
} as const satisfies MimoGlyph;

export const pin = {
  name: "pin", filled: true,
  path: "M7.5 3.5h9v2h-1l.5 4.25 2.5 2.5V15H13v5.5h-2V15H5.5v-2.75l2.5-2.5.5-4.25h-1Z",
} as const satisfies MimoGlyph;

export const appearance = {
  name: "appearance", filled: true,
  path: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 5.5v13a6.5 6.5 0 0 0 0-13Z",
} as const satisfies MimoGlyph;

export const lightMode = {
  name: "light-mode", filled: true,
  path: "M12 7.75a4.25 4.25 0 1 1 0 8.5 4.25 4.25 0 0 1 0-8.5ZM11 2.5h2v3h-2Zm0 16h2v3h-2ZM2.5 11h3v2h-3Zm16 0h3v2h-3ZM4.6 6l1.4-1.4 2.1 2.1-1.4 1.4Zm11.3 11.3 1.4-1.4 2.1 2.1-1.4 1.4ZM4.6 18l2.1-2.1 1.4 1.4L6 19.4ZM15.9 6.7 18 4.6 19.4 6l-2.1 2.1Z",
} as const satisfies MimoGlyph;

export const darkMode = {
  name: "dark-mode", filled: true,
  path: "M13.75 3.75c-1.55 1.55-2.25 3.3-2.25 5.35 0 4.05 3.2 7.15 7.15 7.15.75 0 1.45-.1 2.1-.35-1.45 2.9-4.2 4.35-7.75 4.35-5 0-8.75-3.4-8.75-8.25 0-4.7 3.6-8.25 8.25-8.25h1.25Z",
} as const satisfies MimoGlyph;

export const sound = soundFilled;

/** A state variant of sound, used by the existing mute control. */
export const soundOff = soundOffFilled;

/** Endpoint-volume states share the same optically aligned speaker body. */
export const soundLow = {
  name: "sound-low", filled: true,
  path: "M10.3 5.75 7.25 8.5H5a1.5 1.5 0 0 0-1.5 1.5v4A1.5 1.5 0 0 0 5 15.5h2.25l3.05 2.75c.65.6 1.7.15 1.7-.75v-11c0-.9-1.05-1.35-1.7-.75Z",
} as const satisfies MimoGlyph;
export const soundMedium = {
  name: "sound-medium", filled: true,
  path: "M10.3 5.75 7.25 8.5H5a1.5 1.5 0 0 0-1.5 1.5v4A1.5 1.5 0 0 0 5 15.5h2.25l3.05 2.75c.65.6 1.7.15 1.7-.75v-11c0-.9-1.05-1.35-1.7-.75ZM15.65 8.1a5.5 5.5 0 0 1 0 7.8l-1.2-1.2a3.8 3.8 0 0 0 0-5.4Z",
} as const satisfies MimoGlyph;
