// SPDX-License-Identifier: MIT
import {
  sharedAudioInteraction,
  releaseAudioInteraction,
  type AudioInteraction,
  type AudioSession,
} from "../core/master-audio";
import type { MediaStore } from "../core/media-store";
import { sound, soundOff, soundLow, soundMedium } from "../icons/glyphs";
import { mimoIcon } from "../icons/render";
import { h } from "../views/dom";
import { icon, ICONS } from "../views/icons";
import { DevicePicker } from "../views/device-picker";
import { Visibility } from "../core/visibility";
import { mediaSource } from "./media-source";
import { pressFeedback } from "./control-motion";
import { prefersReducedMotion } from "../core/motion";

let panelSequence = 0;

class VolumeRow {
  readonly el: HTMLElement;
  private mute = h("button", { class: "media-control", type: "button" });
  private down = h(
    "button",
    {
      class: "media-control media-volume-down",
      type: "button",
      "aria-label": "Volume down",
      title: "Volume down · 2%",
    },
    icon(ICONS.minus, 16),
  );
  private up = h(
    "button",
    {
      class: "media-control media-volume-up",
      type: "button",
      "aria-label": "Volume up",
      title: "Volume up · 2%",
    },
    icon(ICONS.plus, 16),
  );
  private slider = h("input", {
    type: "range",
    min: "0",
    max: "100",
    step: "1",
  });
  private percentage = h("span", { class: "media-volume-label" });
  private interaction: AudioInteraction;
  private stop: () => void;
  private dragging = false;

  constructor(
    private store: MediaStore,
    private name: string,
    private sessionId?: string,
    private announce: () => void = () => {},
  ) {
    this.interaction = sharedAudioInteraction(store, sessionId);
    this.mute.classList.add(sessionId ? "media-app-mute" : "media-volume-mute");
    this.slider.className = sessionId
      ? "media-app-slider"
      : "media-volume-slider";
    this.slider.setAttribute("aria-orientation", "horizontal");
    this.slider.setAttribute(
      "aria-label",
      sessionId ? `${name} volume` : "Windows master volume",
    );
    this.el = h(
      "div",
      { class: "audio-volume-row" },
      this.mute,
      ...(sessionId ? [] : [this.down]),
      this.slider,
      ...(sessionId ? [] : [this.up]),
      this.percentage,
    );
    for (const glyph of [soundOff, soundLow, soundMedium, sound]) {
      const svg = mimoIcon(glyph, 18);
      svg.classList.add("media-speaker-state");
      svg.dataset.level = glyph.name;
      this.mute.append(svg);
    }
    this.mute.addEventListener("click", (event) => {
      event.stopPropagation();
      pressFeedback(this.mute);
      this.interaction.mute();
    });
    for (const [button, delta] of [
      [this.down, -2],
      [this.up, 2],
    ] as const)
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        pressFeedback(button);
        this.interaction.volume(
          this.interaction.snapshot().volume + delta,
          true,
        );
      });
    this.slider.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      this.dragging = true;
      Visibility.setDragging(true);
      this.interaction.begin();
      this.el.classList.add("is-dragging");
      this.slider.setPointerCapture(event.pointerId);
    });
    for (const event of [
      "pointerup",
      "pointercancel",
      "lostpointercapture",
      "blur",
    ])
      this.slider.addEventListener(event, () => this.end());
    this.slider.addEventListener("input", () =>
      this.interaction.volume(Number(this.slider.value)),
    );
    this.slider.addEventListener("change", () => {
      this.interaction.volume(Number(this.slider.value));
      this.end();
    });
    this.stop = this.interaction.subscribe(() => this.render());
    this.render();
  }
  end(): void {
    if (this.dragging) {
      Visibility.setDragging(false);
      this.dragging = false;
      this.el.classList.remove("is-dragging");
    }
    this.interaction.end();
  }
  destroy(): void {
    this.end();
    this.stop();
    releaseAudioInteraction(this.store, this.sessionId);
  }
  private render(): void {
    const state = this.interaction.snapshot();
    for (const control of [this.mute, this.down, this.up, this.slider])
      control.disabled = !state.available || this.interaction.switching;
    this.down.disabled ||= state.volume === 0;
    this.up.disabled ||= state.volume === 100 && !state.muted;
    this.slider.value = String(state.volume);
    this.slider.setAttribute(
      "aria-valuetext",
      state.available
        ? `${state.volume}%${state.muted ? ", muted" : ""}`
        : "Audio unavailable",
    );
    this.percentage.textContent = state.available ? `${state.volume}%` : "—";
    this.el.style.setProperty("--volume-fill", `${state.volume}%`);
    this.mute.dataset.level =
      state.muted || !state.volume
        ? soundOff.name
        : state.volume < 34
          ? soundLow.name
          : state.volume < 67
            ? soundMedium.name
            : sound.name;
    this.mute.setAttribute(
      "aria-label",
      `${state.muted ? "Unmute" : "Mute"} ${this.name} audio`,
    );
    this.mute.setAttribute("aria-pressed", String(state.muted));
    this.mute.title = this.mute.getAttribute("aria-label")!;
    this.el.classList.toggle("has-error", this.interaction.error);
    this.announce();
  }
}

/** Media's Windows audio surface, using the shared revisioned store. */
export class MasterAudioController {
  private interaction: AudioInteraction;
  private volume: VolumeRow;
  private output: DevicePicker;
  private input: DevicePicker;
  private announcement = h("span", {
    class: "media-announcement",
    role: "status",
    "aria-live": "polite",
  });
  private sessions = h("div", { class: "media-audio-sessions", role: "list" });
  private empty = h("p", {
    class: "audio-empty",
    text: "Apps appear when they play audio.",
  });
  private rows = new Map<
    string,
    {
      el: HTMLElement;
      volume?: VolumeRow;
      label: HTMLElement;
      status: HTMLElement;
    }
  >();
  private visible = false;
  private opened = false;
  private body: HTMLElement;
  private disclosure: HTMLButtonElement;
  private summary = h("span", { class: "audio-disclosure-summary" });
  private stop: () => void;
  readonly el: HTMLElement;

  constructor(
    private store: MediaStore,
    private resized: (shrinking: boolean) => void = () => {},
  ) {
    this.interaction = sharedAudioInteraction(store);
    this.volume = new VolumeRow(store, "Windows", undefined, () =>
      this.announce(),
    );
    this.output = new DevicePicker("Output", "media-audio-output", (id) =>
      this.interaction.output(id),
    );
    this.input = new DevicePicker("Input", "media-audio-input", (id) =>
      this.interaction.input(id),
    );
    const id = `windows-audio-${++panelSequence}`;
    try {
      this.opened = localStorage.getItem("mimo.audio.expanded") === "true";
    } catch {
      /* Storage may be unavailable in a preview. */
    }
    this.body = h(
      "div",
      { id, class: "audio-body", hidden: this.opened ? undefined : "" },
      h("div", { class: "audio-device-grid" }, this.output.el, this.input.el),
      h(
        "div",
        { class: "audio-mixer" },
        h(
          "div",
          { class: "audio-system-row" },
          h("span", { class: "audio-system-name", text: "Windows" }),
          this.volume.el,
        ),
        h(
          "div",
          { class: "audio-applications" },
          h("h2", { class: "audio-heading", text: "Applications" }),
          this.sessions,
          this.empty,
        ),
      ),
    );
    this.disclosure = h(
      "button",
      {
        class: "audio-disclosure",
        type: "button",
        "aria-expanded": String(this.opened),
        "aria-controls": id,
      },
      mimoIcon(sound, 16),
      h("span", { text: "Windows audio" }),
      this.summary,
      icon(ICONS.chevronDown, 14),
    );
    this.el = h(
      "section",
      {
        class: "media-volume audio-panel",
        "aria-label": "Windows audio controller",
        hidden: "",
      },
      this.disclosure,
      this.body,
      this.announcement,
    );
    this.disclosure.addEventListener("click", () => {
      this.opened = !this.opened;
      this.disclosure.setAttribute("aria-expanded", String(this.opened));
      this.body.hidden = !this.opened;
      if (!this.opened) this.endInteractions();
      try {
        localStorage.setItem("mimo.audio.expanded", String(this.opened));
      } catch {
        /* The current choice still works. */
      }
      this.resized(!this.opened);
    });
    this.stop = this.interaction.subscribe(() => this.render());
    this.el.addEventListener("click", (event) => event.stopPropagation());
  }
  get expanded(): boolean {
    return this.opened;
  }
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    if (!visible) this.endInteractions();
    this.visible = visible;
    this.el.hidden = !visible;
    if (visible) this.render();
  }
  private endInteractions(): void {
    this.volume.end();
    this.output.close();
    this.input.close();
    for (const row of this.rows.values()) row.volume?.end();
  }
  destroy(): void {
    this.output.close();
    this.input.close();
    this.stop();
    this.volume.destroy();
    for (const row of this.rows.values()) row.volume?.destroy();
    this.rows.clear();
  }
  private render(): void {
    if (!this.visible) return;
    const state = this.store.audioSnapshot();
    this.output.update(
      state.outputs ?? [],
      state.deviceId,
      !!state.canSwitchOutput && !this.interaction.switching,
    );
    this.input.update(
      state.inputs ?? [],
      state.inputId,
      !!state.canSwitchInput && !this.interaction.switching,
    );
    this.input.el.hidden = !(state.inputs?.length || state.inputId);
    this.el.setAttribute("aria-busy", String(this.interaction.switching));
    const sessions = state.sessions ?? [],
      current = new Set(sessions.map((session) => session.id));
    for (const [id, row] of this.rows)
      if (!current.has(id)) {
        row.volume?.destroy();
        this.rows.delete(id);
        row.el.removeAttribute("data-session");
        row.el.inert = true;
        row.el.setAttribute("aria-hidden", "true");
        if (
          this.visible &&
          this.opened &&
          !prefersReducedMotion()
        ) {
          const motion = row.el.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: 150,
            easing: "ease-out",
          });
          void motion.finished.catch(() => {}).finally(() => row.el.remove());
        } else row.el.remove();
      }
    for (const session of sessions) this.renderSession(session);
    this.empty.hidden = sessions.length > 0;
    const summary = state.available
      ? `${state.muted ? "Muted · " : ""}${state.volume}%`
      : "Unavailable";
    if (this.summary.textContent !== summary)
      this.summary.textContent = summary;
    this.announce();
  }
  private announce(): void {
    const message =
      this.interaction.error ||
      [...this.rows.values()].some((row) => row.el.querySelector(".has-error"))
        ? "Could not update Windows audio. Try again."
        : "";
    if (this.announcement.textContent !== message)
      this.announcement.textContent = message;
  }
  private renderSession(session: AudioSession): void {
    let row = this.rows.get(session.id);
    if (!row) {
      const source = mediaSource(session.source ?? null);
      const label = h("b", { text: session.name, dir: "auto" });
      const status = h("span", { class: "audio-app-status" });
      const el = h(
        "div",
        {
          class: "audio-app-row",
          role: "listitem",
          "data-session": session.id,
        },
        session.kind === "communication" ? icon(ICONS.bubble, 18) : source.logo,
        h("span", { class: "audio-app-copy" }, label, status),
      );
      row = { el, label, status };
      this.rows.set(session.id, row);
      this.sessions.append(el);
    }
    const controllable =
      !!session.canControl && session.volume != null && session.muted != null;
    if (controllable && !row.volume) {
      row.volume = new VolumeRow(this.store, session.name, session.id, () =>
        this.announce(),
      );
      row.el.append(row.volume.el);
    }
    if (!controllable && row.volume) {
      row.volume.destroy();
      row.volume.el.remove();
      row.volume = undefined;
    }
    row.label.textContent = session.name;
    row.el.dataset.kind = session.kind;
    row.status.textContent =
      session.kind === "communication"
        ? "Voice audio active"
        : session.mixed
          ? "Mixed session levels"
          : "Audio active";
    row.el.title = session.name;
  }
}
