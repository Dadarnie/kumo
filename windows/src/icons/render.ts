// SPDX-License-Identifier: MIT
import type { MimoGlyph } from "./glyphs";

export interface MimoIconOptions {
  /** Omit for decorative icons. Label the button, not its decorative SVG. */
  label?: string;
}

/** Static, tree-shakeable entry point for the app's framework-free DOM views. */
export function mimoIcon(
  glyph: MimoGlyph,
  size = 18,
  { label }: MimoIconOptions = {},
): SVGSVGElement {
  if (!Number.isFinite(size) || size <= 0) throw new RangeError("Icon size must be positive");
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("fill", glyph.filled ? "currentColor" : "none");
  el.setAttribute("stroke", glyph.filled ? "none" : "currentColor");
  if (!glyph.filled) {
    el.setAttribute("stroke-width", "1.6");
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("stroke-linejoin", "round");
  }
  el.setAttribute("preserveAspectRatio", "xMidYMid meet");
  el.setAttribute("focusable", "false");
  el.setAttribute("data-mimo-icon", glyph.name);
  el.classList.add("ui-icon", "mimo-icon");
  el.style.setProperty("--icon-size", `${size}px`);
  if (label?.trim()) {
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", label.trim());
  } else {
    el.setAttribute("aria-hidden", "true");
  }
  const path = document.createElementNS(el.namespaceURI, "path");
  path.setAttribute("d", glyph.path);
  if (glyph.filled) path.setAttribute("fill-rule", glyph.fillRule ?? "evenodd");
  if (!glyph.filled) path.setAttribute("vector-effect", "non-scaling-stroke");
  el.append(path);
  return el;
}
