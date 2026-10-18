// SPDX-License-Identifier: MIT
/** Serializes asynchronous listener registration and releases obsolete starts. */
export class ModuleSubscription {
  private wanted = false;
  private stop?: () => void;
  private chain: Promise<void> = Promise.resolve();
  private version = 0;
  constructor(private start: () => Promise<() => void>) {}

  setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.wanted) return this.chain;
    this.wanted = enabled;
    const version = ++this.version;
    // Stop a registered listener synchronously when switched off.
    if (!enabled) {
      this.stop?.();
      this.stop = undefined;
    }
    this.chain = this.chain
      .catch(() => {})
      .then(async () => {
        if (version !== this.version || !this.wanted || this.stop) return;
        let stop: () => void;
        try {
          stop = await this.start();
        } catch (error) {
          if (version === this.version) this.wanted = false;
          throw error;
        }
        if (version !== this.version || !this.wanted) stop();
        else this.stop = stop;
      });
    return this.chain;
  }
  destroy(): Promise<void> {
    return this.setEnabled(false);
  }
}
