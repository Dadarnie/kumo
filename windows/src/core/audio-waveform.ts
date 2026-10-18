// SPDX-License-Identifier: MIT
/** Six recent measured peaks, with equal gain across the entire strip. */
export class MeasuredWaveform {
  readonly values = Array<number>(6).fill(0);
  private history = Array<number>(6).fill(0);
  private average = 0;
  private variation = 0.025;

  sample(peak: number): readonly number[] {
    const energy = Math.pow(Math.min(1000, Math.max(0, peak)) / 1000, 0.42);
    const change = energy - this.average;
    this.average += change * 0.15;
    this.variation += (Math.abs(change) - this.variation) * 0.1;
    // Adaptive contrast preserves quiet fluctuations inside loud passages.
    // Every bar uses the same measured envelope; history always moves right.
    const pulse = Math.max(-1, Math.min(1, change / (Math.max(0.025, this.variation) * 2)));
    const target = energy * (0.62 + pulse * 0.38);
    this.history.pop();
    this.history.unshift(target);
    for (let index = 0; index < this.values.length; index++) {
      const value = this.history[index];
      const response = value > this.values[index] ? 0.88 : 0.32;
      this.values[index] += (value - this.values[index]) * response;
    }
    return this.values;
  }

  reset(): void {
    this.history.fill(0);
    this.values.fill(0);
    this.average = 0;
    this.variation = 0.025;
  }
}
