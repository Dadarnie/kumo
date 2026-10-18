// SPDX-License-Identifier: MIT
import { icon, ICONS } from "./icons";

/** Soft operation contours from the terminal references, in the shared 24px frame. */
export const CODING_ICONS = {
  read: "M13 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9ZM13 3.5v6h6M8.5 13h7M8.5 16.5h5",
  edit: "m15.6 4.4 4 4M4.5 19.5l4.6-1.2L20 7.4a2.1 2.1 0 0 0-3-3L6.1 15.3Z",
  bash: "M4.5 4.5h15a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2ZM7 9l3.5 3L7 15M13.5 15h4",
  done: ICONS.check,
} as const;

// Small filled file identities, kept local to the coding surface.
const S = "M19.5 10.2c-.5-.7-1.2-1.1-2.3-1.1-1.5 0-2.5.8-2.5 2.1 0 1.1.7 1.7 2.1 2.3l.7.3c.8.4 1.1.6 1.1 1.1 0 .5-.4.8-1.1.8-.8 0-1.3-.4-1.7-1l-1.4.8c.6 1.2 1.6 1.8 3.1 1.8 1.7 0 2.8-.9 2.8-2.4 0-1.2-.7-1.8-2.2-2.4l-.7-.3c-.7-.3-1-.6-1-1 0-.4.3-.7.8-.7.5 0 .8.2 1.1.7Z";
const TECHNOLOGIES = {
  typescript: { label: "TypeScript", path: "M3 3h18v18H3ZM5.5 9.3v1.6h2.6v6.2h1.7v-6.2h2.6V9.3Z" + S },
  javascript: { label: "JavaScript", path: "M3 3h18v18H3ZM10.7 9.3v5.4c0 .8-.3 1.1-.9 1.1-.6 0-.9-.3-1.2-.8l-1.4.8c.5 1 1.4 1.5 2.7 1.5 1.6 0 2.5-.8 2.5-2.6V9.3Z" + S },
  vite: { label: "Vite", path: "M2.4 4.4 11.3 21a.8.8 0 0 0 1.4 0l8.9-16.6a.7.7 0 0 0-.8-1L12 5 3.2 3.4a.7.7 0 0 0-.8 1ZM13.2 2 7.8 12h4l-1 7L17 8h-4.4Z" },
  html: { label: "HTML", path: "m4 2 1.6 18L12 22l6.4-2L20 2Zm3.2 4h9.6l-.2 2H9.4l.2 2h6.9l-.6 7L12 18.2 8.1 17l-.3-3h2l.1 1.5 2.1.6 2.1-.6.2-3.5H7.7Z" },
  css: { label: "CSS", path: "m4 2 1.6 18L12 22l6.4-2L20 2Zm3.2 4h9.6l-.2 2-5.4 2h5.2l-.7 7L12 18.2 8.1 17l-.3-3h2l.1 1.5 2.1.6 2.1-.6.2-3.5H7.7l-.2-2 5.4-2H7.4Z" },
  json: { label: "JSON", path: "M7 3h3v2H8v4a3 3 0 0 1-1.4 3A3 3 0 0 1 8 15v4h2v2H7a1 1 0 0 1-1-1v-5c0-1-.5-2-2-2v-2c1.5 0 2-1 2-2V4a1 1 0 0 1 1-1Zm10 0a1 1 0 0 1 1 1v5c0 1 .5 2 2 2v2c-1.5 0-2 1-2 2v5a1 1 0 0 1-1 1h-3v-2h2v-4a3 3 0 0 1 1.4-3A3 3 0 0 1 16 9V5h-2V3Z" },
} as const;

/** File and command identity comes from the reported target, never guessed content. */
export function setCodingIdentity(host: HTMLElement, target: string, fallback: string = ICONS.doc,
  size = 14, terminal = false): void {
  const file = target.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ?? "";
  const key = /^vite\.config\.|(?:^|\s)(?:npx\s+)?vite(?:\s|$)/i.test(terminal ? target : file) ? "vite"
    : terminal ? null : /\.(?:[cm]?ts|tsx)$/.test(file) ? "typescript"
    : /\.(?:[cm]?js|jsx)$/.test(file) ? "javascript" : /\.html?$/.test(file) ? "html"
    : /\.(?:css|scss|sass|less)$/.test(file) ? "css" : /\.(?:json|jsonc)$/.test(file) ? "json" : null;
  const identity = key ? TECHNOLOGIES[key] : null;
  const cacheKey = `${key ?? fallback}:${size}`;
  if (host.dataset.identity === cacheKey) return;
  host.dataset.identity = cacheKey;
  host.dataset.technology = key ?? "generic";
  host.title = identity?.label ?? (terminal ? "Terminal" : "File");
  const glyph = icon(identity?.path ?? fallback, size);
  if (key === "typescript" || key === "javascript") {
    const paper = document.createElementNS(glyph.namespaceURI, "rect");
    for (const [name, value] of Object.entries({ x: "3", y: "3", width: "18", height: "18",
      fill: key === "typescript" ? "#f3f4f6" : "#191b20" })) paper.setAttribute(name, value);
    glyph.prepend(paper);
  }
  host.replaceChildren(glyph);
}
