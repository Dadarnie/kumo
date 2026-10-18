// SPDX-License-Identifier: MIT
/** Persisted island appearance; the Settings window always uses Dark tokens. */
export type Appearance = "dark";

export function normalizeAppearance(_value: unknown): Appearance {
  return "dark";
}

export function applyAppearance(value: Appearance): void {
  document.documentElement.dataset.appearance = normalizeAppearance(value);
}
