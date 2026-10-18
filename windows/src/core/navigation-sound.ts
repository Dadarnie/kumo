// SPDX-License-Identifier: MIT
import { Sound } from "./sound";

/** Back buttons share the existing close cue and the user's sound preferences. */
export function backAction(action: () => void): () => void {
  return () => {
    const loaded = Sound.preload();
    Sound.resume();
    void loaded.then(() => Sound.play("close")).catch(() => {});
    action();
  };
}
