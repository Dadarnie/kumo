// SPDX-License-Identifier: MIT
export interface NoticePreferences { coding: boolean; other: boolean }

/** Current coding and service notifications share the existing snooze preference. */
export function shouldNotify(source: keyof NoticePreferences, preferences: NoticePreferences, snoozeUntil: number, now = Date.now()): boolean {
  return preferences[source] !== false && !(Number.isFinite(snoozeUntil) && snoozeUntil > now);
}
