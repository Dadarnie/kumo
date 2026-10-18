// SPDX-License-Identifier: MIT
/** Sparse Windows power observations. Unknown hardware never means low battery. */
export interface PowerSnapshot {
  onBattery: boolean | null;
  percent: number | null;
}

export function normalizePower(value: unknown): PowerSnapshot {
  const raw = value && typeof value === "object" ? value as Partial<PowerSnapshot> : {};
  return {
    onBattery: typeof raw.onBattery === "boolean" ? raw.onBattery : null,
    percent: typeof raw.percent === "number" && Number.isInteger(raw.percent) && raw.percent >= 0 && raw.percent <= 100
      ? raw.percent : null,
  };
}
