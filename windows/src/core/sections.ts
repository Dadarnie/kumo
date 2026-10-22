// SPDX-License-Identifier: MIT
import type { ModulePreferences } from "./modules";
import type { IslandViewName, IslandVisibility } from "./layout";

/** Dedicated content owns the region; playback remains independent of presentation. */
export function mediaPresentation(
  mode: IslandVisibility,
  view: IslandViewName,
): "player" | "compact" | "hidden" {
  if (mode === "expanded") return view === "media" ? "player" : "hidden";
  if (mode === "island" && ["overview", "empty", "media"].includes(view))
    return "compact";
  return "hidden";
}

/** User-owned content stays in place until explicit navigation or completion. */
export function ownsContent(view: IslandViewName): boolean {
  return [
    "prompt",
    "grab",
    "upload",
    "uploading",
    "choose",
    "confused",
    "integrations",
    "notes",
    "news",
    "usage",
    "greeting",
    "mail",
    "searching",
    "result",
    "note",
    "approval",
    "approvals",
    "question",
  ].includes(view);
}

export type IslandSection = "overview" | "prompt" | "media" | "grab" | "integrations" | "notes" | "news" | "utilities" | "usage";
export const SECTIONS = [
  { id: "overview", label: "Home" },
  { id: "prompt", label: "Chat" },
  { id: "integrations", label: "Tools" },
  { id: "notes", label: "Notes" },
  { id: "news", label: "News" },
  { id: "grab", label: "Kumo Shelf" },
] as const;

export function sectionEnabled(
  section: IslandSection,
  modules: ModulePreferences,
  _integrations: number,
  usageEnabled = false,
  connected = false,
): boolean {
  if (section === "usage") return usageEnabled && modules.vscode && connected;
  if (section === "media") return modules.media;
  // Everything else, including Tools (app launcher, Docker, Ollama, Obsidian), is always there.
  return true;
}

export function sectionForView(view: IslandViewName): IslandSection | null {
  if (view === "settings" || view === "greeting") return null;
  return view === "media" ? "media" : view === "grab" ? "grab" : view === "usage" ? "usage"
    : view === "integrations" ? "integrations"
    : view === "notes" ? "notes" : view === "news" ? "news"
    : view === "prompt" ? "prompt" : "overview";
}

export function safeSectionView(
  view: IslandViewName,
  modules: ModulePreferences,
  integrations: number,
  usageEnabled = false,
  connected = false,
): IslandViewName {
  // Old links from previous builds must never mount removed surfaces.
  if (["activity", "utilities", "history"].includes(view)) return "overview";
  return (view === "media" || view === "usage" || view === "integrations") &&
    !sectionEnabled(view, modules, integrations, usageEnabled, connected)
    ? "overview"
    : view;
}
