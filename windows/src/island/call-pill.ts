// SPDX-License-Identifier: MIT
// Call pill: when an app holds the microphone (Meet in a browser, Discord,
// Zoom, Teams…) the island shows the app, a call timer and a mic toggle.
import { h } from "../views/dom";
import { ICONS, icon } from "../views/icons";
import { Bridge, type CallState } from "../core/bridge";
import { Lifetime } from "../core/lifetime";

// ponytail: polls the registry every 2s; switch to a registry change
// notification if the poll ever shows up in CPU or battery numbers.
const POLL_MS = 2000;

export class CallPill {
  private dot = h("span", { class: "call-dot", "aria-hidden": "true" });
  private app = h("span", { class: "call-app" });
  private timer = h("span", { class: "call-timer" });
  private mic = h("button", { class: "call-mic", type: "button" }, icon(ICONS.microphone, 14));
  readonly el = h("div", { class: "call-pill", hidden: true, role: "status" },
    this.dot, this.app, this.timer, this.mic);
  private state: CallState | null = null;
  private lifetime = new Lifetime();
  private poll: ReturnType<typeof setTimeout> | undefined;
  private tick: ReturnType<typeof setInterval> | undefined;

  constructor(private onChange: (inCall: boolean) => void) {
    this.mic.addEventListener("click", event => {
      event.stopPropagation();
      if (this.state?.muted == null) return;
      void Bridge.callSetMuted(!this.state.muted).then(muted => {
        if (this.state) { this.state = { ...this.state, muted }; this.render(); }
      }).catch(() => {});
    }, { signal: this.lifetime.signal });
    // The pill body brings the call app forward (desktop apps; Store apps cannot be focused).
    this.el.addEventListener("click", event => { event.stopPropagation(); void Bridge.callFocus(); }, { signal: this.lifetime.signal });
    void this.refresh();
  }

  get active(): boolean { return this.state !== null; }

  private async refresh(): Promise<void> {
    if (!this.lifetime.active) return;
    const next = await Bridge.callState().catch(() => null);
    const changed = (next === null) !== (this.state === null);
    this.state = next;
    this.render();
    if (changed) this.onChange(next !== null);
    this.poll = setTimeout(() => void this.refresh(), POLL_MS);
  }

  private render(): void {
    const call = this.state;
    this.el.hidden = !call;
    clearInterval(this.tick);
    if (!call) return;
    this.app.textContent = call.app === "Browser" ? "Web call" : call.app;
    this.el.dataset.muted = String(call.muted === true);
    this.mic.hidden = call.muted == null;
    this.mic.title = call.muted ? "Unmute microphone" : "Mute microphone";
    this.mic.setAttribute("aria-label", this.mic.title);
    const update = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - call.startedAtUnixMs) / 1000));
      const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
      this.timer.textContent = (h ? `${h}:${String(m).padStart(2, "0")}` : String(m)) + ":" + String(s).padStart(2, "0");
    };
    update();
    this.tick = setInterval(update, 1000);
  }

  destroy(): void {
    this.lifetime.destroy();
    clearTimeout(this.poll);
    clearInterval(this.tick);
  }
}
