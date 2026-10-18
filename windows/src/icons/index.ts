// SPDX-License-Identifier: MIT
import * as glyphs from "./glyphs";
import { mimoIcon, type MimoIconOptions } from "./render";

/** Use this name-based facade for dynamic selection. Static app views import
 * individual glyphs and render.ts directly to omit the unused family. */
const names = {
  companion: glyphs.companion,
  home: glyphs.home,
  winter: glyphs.winter,
  "compact-mode": glyphs.compactMode,
  expand: glyphs.expand,
  collapse: glyphs.collapse,
  "music-mode": glyphs.musicMode,
  affection: glyphs.affection,
  mood: glyphs.mood,
  sleep: glyphs.sleep,
  wake: glyphs.wake,
  secret: glyphs.secret,
  unlock: glyphs.unlock,
  "summon-mimo": glyphs.summonMimo,
  interaction: glyphs.interaction,
  achievement: glyphs.achievement,
  pin: glyphs.pin,
  appearance: glyphs.appearance,
  "light-mode": glyphs.lightMode,
  "dark-mode": glyphs.darkMode,
  sound: glyphs.sound,
  "sound-off": glyphs.soundOff,
  "sound-low": glyphs.soundLow,
  "sound-medium": glyphs.soundMedium,
} as const;

export type MimoIconName = keyof typeof names;

export function MimoIcon({
  name,
  size = 18,
  label,
}: MimoIconOptions & { name: MimoIconName; size?: number }): SVGSVGElement {
  return mimoIcon(names[name], size, { label });
}
