// SPDX-License-Identifier: MIT
import { Bridge } from "./bridge";
import { Activity } from "./activity";
import type { CodingProvider } from "./coding";
import type { CodexUsage } from "./codex-usage";

const pending = new Map<CodingProvider, Promise<CodexUsage | null>>();

/** Header and Limits share cached readings and any in-flight native request. */
export function readAssistantUsage(provider: CodingProvider, force = false): Promise<CodexUsage | null> {
  const current = pending.get(provider);
  if (current) return current;
  const cached = Activity.latest(provider);
  if (!force && cached && Date.now() - cached.checkedAt * 1000 < 60000) return Promise.resolve(cached);
  if (provider !== "codex" && provider !== "claude") return Promise.resolve(cached);
  const request = (provider === "codex" ? Bridge.codexUsage(force) : Bridge.claudeUsage())
    .finally(() => { pending.delete(provider); });
  pending.set(provider, request);
  return request;
}
