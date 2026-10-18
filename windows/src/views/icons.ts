// SPDX-License-Identifier: MIT
// Filled actions share the navigation family's 24px frame and optical spacing.
import { svg } from "./dom";
import { integrationsFilled, toolsFilled, usageFilled } from "../icons/filled";
import { settingsPath } from "../icons/settings-path";

export const ICONS = {
  // A rounded hard drive with Mimo's capsule eyes cut into its front panel.
  shelf: "M7 3.5h10a2.5 2.5 0 0 1 2.4 1.8l2.5 7.5c.1.3.1.5.1.8V18a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-4.4c0-.3 0-.5.1-.8l2.5-7.5A2.5 2.5 0 0 1 7 3.5ZM5.5 11a1 1 0 0 0 0 2h13a1 1 0 0 0 0-2ZM9 15a1 1 0 0 0-1 1v2a1 1 0 0 0 2 0v-2a1 1 0 0 0-1-1Zm6 0a1 1 0 0 0-1 1v2a1 1 0 0 0 2 0v-2a1 1 0 0 0-1-1Z",
  // Mimo's capsule eyes inside four capture corners: a Grab mark at native DPI.
  grab: "M4 2h4v2H4v4H2V4a2 2 0 0 1 2-2Zm12 0h4a2 2 0 0 1 2 2v4h-2V4h-4ZM2 16h2v4h4v2H4a2 2 0 0 1-2-2Zm18 0h2v4a2 2 0 0 1-2 2h-4v-2h4ZM12 5.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM9.5 9a1.25 1.25 0 0 0-1.25 1.25v2.5a1.25 1.25 0 0 0 2.5 0v-2.5A1.25 1.25 0 0 0 9.5 9Zm5 0a1.25 1.25 0 0 0-1.25 1.25v2.5a1.25 1.25 0 0 0 2.5 0v-2.5A1.25 1.25 0 0 0 14.5 9Z",
  clipboard: "M9 2h6a2 2 0 0 1 2 2v1h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2V4a2 2 0 0 1 2-2Zm0 2v3h6V4Zm-2 7v2h10v-2Zm0 5v2h7v-2Z",
  camera: "M8 4h8l1.5 3H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2.5ZM12 9a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Zm0 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z",
  globe: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM5 8h3a18 18 0 0 0 0 8H5a8 8 0 0 1 0-8Zm5 0h4a16 16 0 0 1 0 8h-4a16 16 0 0 1 0-8Zm6 0h3a8 8 0 0 1 0 8h-3a18 18 0 0 0 0-8Zm-6.5-2a8 8 0 0 1 5 0H9.5Zm0 12h5a8 8 0 0 1-5 0Z",
  bubble: "M12 3C6.7 3 3 6.2 3 10.75c0 2.12.81 3.98 2.27 5.36L4.3 20a.65.65 0 0 0 .9.75l4.02-1.69c.88.2 1.81.3 2.78.3 5.3 0 9-3.2 9-7.97S17.3 3 12 3ZM7.8 9.8a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3ZM12 9.8a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3ZM16.2 9.8a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Z",
  plus: "M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7Z",
  minus: "M4 11h16v2H4Z",
  gear: settingsPath,
  microphone: "M12 2.5a3.5 3.5 0 0 1 3.5 3.5v6a3.5 3.5 0 0 1-7 0V6A3.5 3.5 0 0 1 12 2.5ZM6 10a1 1 0 0 1 1 1v1a5 5 0 0 0 10 0v-1a1 1 0 1 1 2 0v1a7 7 0 0 1-6 6.93V21h3a1 1 0 0 1 0 2H8a1 1 0 0 1 0-2h3v-2.07A7 7 0 0 1 5 12v-1a1 1 0 0 1 1-1Z",
  arrowUpRight: "m5.3 17.3 10.3-10.3H7V5h12v12h-2V8.4L6.7 18.7Z",
  chevronRight: "m8 4.5 7.5 7.5L8 19.5l-1.5-1.5 6-6-6-6Z",
  chevronLeft: "m16 4.5 1.5 1.5-6 6 6 6-1.5 1.5L8.5 12Z",
  chevronDown: "m5 8 7 7 7-7-1.5-1.5L12 12 6.5 6.5Z",
  check: "m4.3 11.3 1.4-1.4L9 13.2l9.3-9.3 1.4 1.4L9 16Z",
  arrowUp: "M11 20V8.3l-5 5L4.5 11.8 12 4.3l7.5 7.5-1.5 1.5-5-5V20Z",
  bang: "M11 4h2v10h-2ZM12 17.25a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z",
  permission: "M12 3.5 19.5 6v5.3c0 4.1-2.9 7.2-7.5 9.2-4.6-2-7.5-5.1-7.5-9.2V6Z",
  shuffle: "M4 6.5h2c3.2 0 4.6 4 6 5.5s2.8 5.5 6 5.5h2M17 14.5l3 3-3 3M4 17.5h2c1.7 0 2.9-1.1 4-2.6M14 9.1c1.1-1.5 2.3-2.6 4-2.6h2M17 3.5l3 3-3 3",
  repeat: "M4 10V8.5A3.5 3.5 0 0 1 7.5 5H20M17 2l3 3-3 3M20 14v1.5a3.5 3.5 0 0 1-3.5 3.5H4M7 16l-3 3 3 3",
  repeatOne: "M4 10V8.5A3.5 3.5 0 0 1 7.5 5H20M17 2l3 3-3 3M20 14v1.5a3.5 3.5 0 0 1-3.5 3.5H4M7 16l-3 3 3 3M10.5 10.5 12 9.5v5",
  xmark: "m5.7 4.3 6.3 6.3 6.3-6.3 1.4 1.4-6.3 6.3 6.3 6.3-1.4 1.4-6.3-6.3-6.3 6.3-1.4-1.4 6.3-6.3-6.3-6.3Z",
  timer: "M9 2h6v2h-2v1.06a8.5 8.5 0 1 1-2 0V4H9ZM11 9v6l4 2 1-1.75-3-1.5V9Z",
  usage: usageFilled.path,
  refresh: "M12 3.25c3.03 0 5.7 1.54 7.25 3.94V4h2v7h-7V9h3.85A6.75 6.75 0 0 0 5.25 12h-2c0-4.83 3.92-8.75 8.75-8.75ZM12 20.75c-3.03 0-5.7-1.54-7.25-3.94V20h-2v-7h7v2H5.9A6.75 6.75 0 0 0 18.75 12h2c0 4.83-3.92 8.75-8.75 8.75Z",
  ellipsis: "M5 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM19 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z",
  star: "m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z",
  stack: "m3 6.5 9-4.5 9 4.5-9 4.5ZM3 11l9 4.5 9-4.5v2l-9 4.5-9-4.5ZM3 15.5l9 4.5 9-4.5v2l-9 4.5-9-4.5Z",
  tools: toolsFilled.path,
  doc: "M7 2.5h6.5L19 8v11.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2ZM13 4.5V9h4.5ZM8 12v1.5h8V12ZM8 16v1.5h6V16Z",
  edit: "m16.5 3.2 4.3 4.3-12 12-5.8 1.5 1.5-5.8ZM6.3 15.8l-.7 2.6 2.6-.7 10-10-1.9-1.9Z",
  terminal: "M4.5 4h15A2.5 2.5 0 0 1 22 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 17.5v-11A2.5 2.5 0 0 1 4.5 4Zm2 3.5L5.1 8.9l3.1 3.1-3.1 3.1 1.4 1.4L11 12Zm6 7V16h5v-1.5Z",
  copy: "M7 2h10a2 2 0 0 1 2 2v2H9a3 3 0 0 0-3 3v10H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3Zm2 6h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z",
  previous: "M4 5h2.5v14H4ZM18.8 5.25c.5-.3 1.2.05 1.2.65v12.2c0 .6-.7.95-1.2.65L8.2 12.65a.75.75 0 0 1 0-1.3Z",
  next: "M17.5 5H20v14h-2.5ZM5.2 5.25l10.6 6.1a.75.75 0 0 1 0 1.3l-10.6 6.1c-.5.3-1.2-.05-1.2-.65V5.9c0-.6.7-.95 1.2-.65Z",
  play: "M7 4.75c0-.6.65-.95 1.2-.65l11.7 7.25a.75.75 0 0 1 0 1.3L8.2 19.9c-.55.3-1.2-.05-1.2-.65Z",
  pause: "M7 4.5h2a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1ZM15 4.5h2a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z",
  monitor: "M4.5 3.5h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H13v3h4v2H7v-2h4v-3H4.5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2ZM5 6v8h14V6Z",
  integrations: integrationsFilled.path,
  keyboard: "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM5 8v2h2V8ZM9 8v2h2V8ZM13 8v2h2V8ZM17 8v2h2V8ZM5 12v2h2v-2ZM9 12v2h2v-2ZM13 12v2h2v-2ZM17 12v2h2v-2ZM7 15.5V17h10v-1.5Z",
  info: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM11 10v7h2v-7ZM12 6a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 12 6Z",
  sleep: "M5 4.5h14V7L8.5 17.5H19V20H5v-2.5L15.5 7H5Z",
  moon: "M19.9 14.1A8.5 8.5 0 0 1 9.9 4.1a8.5 8.5 0 1 0 10 10Z",
} as const;

/** Render solid contours; holes retain their negative space at native DPI. */
export function icon(path: string, size = 18): SVGSVGElement {
  const el = svg(path, size);
  el.setAttribute("fill", "currentColor");
  el.setAttribute("stroke", "none");
  el.setAttribute("focusable", "false");
  el.firstElementChild!.setAttribute("fill-rule", "evenodd");
  el.classList.add("ui-icon");
  el.style.setProperty("--icon-size", `${size}px`);
  el.setAttribute("preserveAspectRatio", "xMidYMid meet");
  return el;
}
