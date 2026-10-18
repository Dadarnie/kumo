// SPDX-License-Identifier: MIT
import {
  MEDIA_CARD_HEIGHT,
  ACTIVITY_CARD_HEIGHT,
  MODULE_GAP,
  INTEGRATION_TILE_SIZE,
  INTEGRATION_GAP,
  INTEGRATION_PADDING,
} from "./design";
export interface ModulePreferences {
  media: boolean;
  vscode: boolean;
  developerIntegrations: boolean;
}
export type ModuleId = keyof ModulePreferences;
export interface IslandModuleDefinition {
  id: ModuleId;
  priority: number;
  preferredSize: "half" | "wide";
  hostsMascot?: boolean;
}
export const MODULES: readonly IslandModuleDefinition[] = [
  { id: "vscode", priority: 10, preferredSize: "half", hostsMascot: true },
  { id: "developerIntegrations", priority: 20, preferredSize: "half" },
  { id: "media", priority: 30, preferredSize: "wide" },
];
export const DEFAULT_MODULES: ModulePreferences = {
  media: true,
  vscode: true,
  developerIntegrations: true,
};

export interface ModuleLayout {
  modules: readonly (IslandModuleDefinition & { span: 1 | 2 })[];
  height: number;
  activityHeight: number;
  integrationColumns: number;
  mascot: "activity" | "header" | "empty";
}

export function moduleLayout(
  preferences: ModulePreferences,
  mediaAvailable: boolean,
  integrations: number,
): ModuleLayout {
  const available = MODULES.filter(
    (module) =>
      preferences[module.id] &&
      (module.id !== "media" || mediaAvailable) &&
      (module.id !== "developerIntegrations" || integrations > 0),
  ).sort((left, right) => left.priority - right.priority);
  const halves = available.filter((module) => module.preferredSize === "half");
  const integrationColumns = Math.max(1, Math.min(integrations, halves.length === 1 ? 8 : 4));
  const integrationRows = available.some((module) => module.id === "developerIntegrations")
    ? Math.ceil(integrations / integrationColumns)
    : 0;
  const activityHeight = halves.length
    ? Math.max(
        ACTIVITY_CARD_HEIGHT,
        integrationRows * (INTEGRATION_TILE_SIZE + INTEGRATION_GAP) -
          INTEGRATION_GAP +
          INTEGRATION_PADDING * 2,
      )
    : 0;
  const hasMedia = available.some((module) => module.id === "media");
  return {
    modules: available.map((module) => ({
      ...module,
      span: module.preferredSize === "wide" || halves.length === 1 ? 2 : 1,
    })),
    height: available.length
      ? 52 + activityHeight + (hasMedia ? MEDIA_CARD_HEIGHT + (halves.length ? MODULE_GAP : 0) : 0)
      : 160,
    activityHeight,
    integrationColumns,
    mascot: available.some((module) => module.hostsMascot)
      ? "activity"
      : available.length
        ? "header"
        : "empty",
  };
}
