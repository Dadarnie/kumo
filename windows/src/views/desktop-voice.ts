// SPDX-License-Identifier: MIT
import { Activity } from "../core/activity";
import { State } from "../core/state";
import { h } from "./dom";
import { icon, ICONS } from "./icons";
import type { ViewActions, ViewHost } from "./views";
import "./desktop-voice.css";
import { MediaEqualizer } from "../island/equalizer";
import { VIEW_LAYOUTS } from "../core/layout";

export function buildDesktopVoice(actions: ViewActions): ViewHost {
  const equalizer = new MediaEqualizer(() => actions.voicePeak());
  equalizer.el.classList.add("desktop-voice-equalizer");
  equalizer.el.setAttribute("role", "img");
  equalizer.el.setAttribute("aria-label", "Microphone sound level");
  equalizer.el.removeAttribute("aria-hidden");
  const label = h("div", { class: "desktop-voice-label", role: "status", "aria-live": "polite" });
  const detail = h("div", { class: "desktop-voice-detail" });
  const action = h("button", { type: "button", class: "desktop-voice-action", onclick: () => { actions.blip(); actions.toggleVoice(); } });
  const settings = h("button", { type: "button", class: "desktop-voice-settings", text: "Voice settings", hidden: true,
    onclick: () => actions.openSettingsWindow("chat") });
  const close = h("button", { type: "button", class: "desktop-voice-close", "aria-label": "Close voice control", title: "Close voice control",
    onclick: () => actions.closeVoice() }, icon(ICONS.xmark, 12));
  const el = h("div", { class: "view desktop-voice-view", "aria-label": "Mimo voice control" },
    close, h("div", { class: "desktop-voice-copy" }, label, equalizer.el, detail),
    h("div", { class: "desktop-voice-controls" }, action, settings));
  return { el, sync() {
    const { phase, error, service, assistant } = Activity.voice;
    const labels = { idle: "Ready to listen", connecting: "Connecting…", recording: "Listening…", transcribing: "Understanding…",
      waiting: "Thinking…", speaking: "Speaking…", paused: "Paused for your approval", error: "Voice needs a moment" };
    el.dataset.phase = phase;
    const measured = phase === "recording";
    label.hidden = measured;
    equalizer.el.hidden = !measured;
    equalizer.el.setAttribute("aria-label", "Microphone sound level");
    equalizer.setVisible(measured);
    label.textContent = labels[phase];
    detail.textContent = error || (phase === "recording" ? "Press the shortcut again to send" : phase === "paused" ? "Review the permission request first" :
      service ? `${assistant} · ${service} voice` : State.settings.voiceShortcut ? State.settings.voiceShortcut.replaceAll("+", " + ") : "Tap to speak");
    detail.title = detail.textContent;
    action.textContent = phase === "recording" ? "Send" : ["idle", "error", "paused"].includes(phase) ? "Talk" : "Stop";
    action.setAttribute("aria-label", phase === "recording" ? "Send voice message" : ["idle", "error", "paused"].includes(phase) ? "Start voice control" : "Stop voice control");
    settings.hidden = !error;
  }, tick() { equalizer.tick(); }, setVisible(visible) { equalizer.setVisible(visible && Activity.voice.phase === "recording"); },
  destroy() { equalizer.destroy(); }, layout() { return { ...VIEW_LAYOUTS.voice, height: Activity.voice.phase === "error" ? 168 : 148 }; },
  focus() { action.focus({ preventScroll: true }); } };
}
