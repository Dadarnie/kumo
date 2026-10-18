// SPDX-License-Identifier: MIT
import type { CalendarPoint } from "./activity-calendar";

export type GitHubItem = Record<string, unknown>;
export const githubList = (data: GitHubItem, key: string): GitHubItem[] => Array.isArray(data[key]) ? (data[key] as unknown[]).filter((item): item is GitHubItem => !!item && typeof item === "object") : [];
export const githubText = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" ? String(value) : "";

export function githubContributions(data: GitHubItem): CalendarPoint[] {
  return githubList(data, "contributions").filter(item => typeof item.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.date) && typeof item.count === "number" && Number.isFinite(item.count) && item.count >= 0)
    .map(item => ({ date: item.date as string, value: item.count as number }));
}

/** An unreadable or absent check is never presented as a successful build. */
export function githubChecksSummary(data: GitHubItem): { label: string; state: string } {
  const checks = githubList(data, "checks");
  if (!checks.length) return { label: "Not shared", state: "unknown" };
  if (checks.some(check => check.state === "failure")) return { label: "Needs a look", state: "failure" };
  if (checks.some(check => check.state === "pending")) return { label: "Running", state: "pending" };
  if (checks.some(check => check.state !== "success")) return { label: "Not shared", state: "unknown" };
  return { label: "All green", state: "success" };
}
