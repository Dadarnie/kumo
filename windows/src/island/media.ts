// SPDX-License-Identifier: MIT
// The store remains the sole source of media state and native actions;
// context and the render key below describe presentation, not another cache.
import { mediaStore, type MediaStore } from "../core/media-store";
import { Bridge } from "../core/bridge";
import type { MediaState } from "../core/media";
import {
  mediaTime,
  timelinePosition,
  type MediaAction,
} from "../core/media-player";
import type { IslandVisibility, IslandViewName } from "../core/layout";
import { h } from "../views/dom";
import { ICONS, icon } from "../views/icons";
import { musicMode, sound } from "../icons/glyphs";
import { mimoIcon } from "../icons/render";
import { mediaSource } from "./media-source";
import { CompactDropdown } from "../views/device-picker";
import "./media.css";
import { MasterAudioController } from "./audio-controller";
import { Visibility } from "../core/visibility";
import { MediaEqualizer } from "./equalizer";
import { pressFeedback } from "./control-motion";
import { mediaPresentation } from "../core/sections";
import { Lifetime } from "../core/lifetime";
import {
  MEDIA_VIEW_CARD_HEIGHT,
  MEDIA_VIEW_COLLAPSED_HEIGHT,
  MEDIA_EMPTY_CARD_HEIGHT,
  MEDIA_EMPTY_COLLAPSED_HEIGHT,
} from "../core/design";

const MEDIA_SPACE = 72;
export type CoreMediaMode = "hover" | null;

function hasSession(state: MediaState): boolean {
  return (
    state.providerStatus === "ready" &&
    state.playbackState !== "none" &&
    (state.playbackState !== "unknown" ||
      state.title !== null ||
      state.artist !== null)
  );
}

export class IslandMedia {
  private equalizer = new MediaEqualizer();
  private ambientProgressFill = h("span");
  private ambientProgress = h("span", { class: "media-ambient-progress", "aria-hidden": "true" }, this.ambientProgressFill);
  private ambientTitle = h("span", {
    class: "media-ambient-title",
    dir: "auto",
  });
  private ambientArtist = h("span", {
    class: "media-ambient-artist",
    dir: "auto",
  });
  private ambientImage = h("img", {
    class: "media-ambient-image",
    alt: "",
    draggable: "false",
  });
  private title = h("span", { class: "media-title", dir: "auto" });
  private artist = h("span", { class: "media-artist", dir: "auto" });
  private status = h("span", { class: "media-status" });
  private source = h("span", { class: "media-source" });
  /** Pick which app the notch shows when several are playing. */
  private apps = new CompactDropdown("Playing app", "media-app-select", id => { void this.store.selectSession(id); });
  private renderedSource: string | null | undefined;
  private elapsed = h("span", { class: "media-elapsed", text: "—:—" });
  private duration = h("span", { class: "media-duration", text: "—:—" });
  private progressFill = h("span", { class: "media-progress-fill" });
  private progress = h(
    "div",
    {
      class: "media-progress",
      role: "progressbar",
      "aria-label": "Track progress",
      "aria-valuemin": "0",
    },
    this.progressFill,
  );
  private seeking = false;
  private seek = h("input", {
    class: "media-seek",
    type: "range",
    min: "0",
    max: "0",
    step: "1000",
    "aria-label": "Playback position",
    hidden: "",
  });
  private timelineEl = h(
    "div",
    { class: "media-timeline" },
    this.progress,
    h("div", { class: "media-times" }, this.elapsed, this.duration),
  );
  private image = h("img", {
    class: "media-image",
    alt: "",
    decoding: "async",
    draggable: "false",
  });
  // Blurred copy of the artwork that fills the dedicated Music page.
  private backdrop = h("img", {
    class: "media-backdrop",
    alt: "",
    decoding: "async",
    draggable: "false",
  });
  private art = h(
    "div",
    { class: "media-artwork", "aria-hidden": "true" },
    mimoIcon(musicMode, 24),
    this.image,
  );
  private previous = h(
    "button",
    {
      class: "media-control",
      type: "button",
      "aria-label": "Previous track",
      title: "Previous track",
    },
    icon(ICONS.previous, 22),
  );
  private primary = h("button", {
    class: "media-control media-primary",
    type: "button",
  });
  private next = h(
    "button",
    {
      class: "media-control",
      type: "button",
      "aria-label": "Next track",
      title: "Next track",
    },
    icon(ICONS.next, 22),
  );
  private shuffle = h("button", { class: "media-control media-mode media-shuffle", type: "button", "aria-label": "Shuffle", title: "Shuffle", "aria-pressed": "false" }, icon(ICONS.shuffle, 17));
  private repeat = h("button", { class: "media-control media-mode media-repeat", type: "button", "aria-label": "Repeat", title: "Repeat", "aria-pressed": "false" }, icon(ICONS.repeat, 17));
  private controls = h(
    "div",
    { class: "media-controls", "aria-label": "Playback controls" },
    this.shuffle,
    this.previous,
    this.primary,
    this.next,
    this.repeat,
  );
  private volumeValue = h("span", { class: "media-session-volume-value", "aria-hidden": "true", text: "—" });
  private volumeSlider = h("input", {
    class: "media-session-volume-slider", type: "range", min: "0", max: "100", step: "1",
  });
  private sessionVolume = h("div", { class: "media-session-volume", role: "group" },
    mimoIcon(sound, 14), this.volumeSlider, this.volumeValue);
  private announcement = h("span", {
    class: "media-announcement",
    "aria-live": "polite",
  });
  private audio: MasterAudioController;
  private ambientPrimary = h(
    "button",
    {
      class: "media-control media-ambient-primary",
      type: "button",
      "aria-label": "Pause",
    },
    icon(ICONS.pause, 20),
  );
  private ambientPrevious = h(
    "button",
    {
      class: "media-control media-ambient-skip",
      type: "button",
      "aria-label": "Previous track",
    },
    icon(ICONS.previous, 20),
  );
  private ambientNext = h(
    "button",
    {
      class: "media-control media-ambient-skip",
      type: "button",
      "aria-label": "Next track",
    },
    icon(ICONS.next, 20),
  );

  readonly ambientEl = h(
    "div",
    { class: "media-ambient", "aria-hidden": "true" },
    this.equalizer.el,
    h(
      "span",
      { class: "media-ambient-art", "aria-hidden": "true" },
      mimoIcon(musicMode, 20),
      this.ambientImage,
    ),
    h(
      "span",
      { class: "media-ambient-copy" },
      this.ambientTitle,
      this.ambientArtist,
    ),
    h(
      "div",
      { class: "media-ambient-controls" },
      this.ambientPrevious,
      this.ambientPrimary,
      this.ambientNext,
    ),
    this.ambientProgress,
  );
  readonly rowEl = h(
    "section",
    { class: "media-row", "aria-label": "Media", "aria-hidden": "true" },
    this.backdrop,
    this.art,
    h(
      "div",
      { class: "media-copy" },
      this.title,
      this.artist,
      h("div", { class: "media-secondary" }, this.source, this.apps.el, this.status),
    ),
    this.timelineEl,
    this.controls,
    this.sessionVolume,
    this.announcement,
  );

  private mode: IslandVisibility = "peek";
  private view: IslandViewName = "overview";
  private renderKey = "";
  private rowVisible = false;
  private ambientVisible = false;
  private unsubscribe: () => void;
  private renderedArt: string | null = null;
  private pendingSession: string | null = null;
  private pendingTransport = false;
  private modeTarget: { session: string; shuffle?: boolean; repeatMode?: "off" | "list" | "track" } | null = null;
  private modeInFlight = false;
  private errorSession: string | null = null;
  private primaryLabel = "";
  private destroyed = false;
  private enabled = true;
  private compactFullControls = false;
  private coreMode: CoreMediaMode = null;
  private compactControlsHeld = false;
  private clock: ReturnType<typeof setTimeout> | undefined;
  private timeKey = "";
  private volumeSession: string | null = null;
  private volumeTarget: { session: string; value: number } | null = null;
  private volumeFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
  private volumeDragging = false;
  private volumeInFlight = false;
  private lifetime = new Lifetime();

  constructor(
    private resize: (shrinking: boolean) => void,
    private store: MediaStore = mediaStore,
  ) {
    document.addEventListener("visibilitychange", () => {
      clearTimeout(this.clock);
      this.clock = undefined;
      if (!document.hidden) {
        this.renderKey = "";
        this.render();
      }
    }, { signal: this.lifetime.signal });
    // Artwork and title open the app that is playing.
    for (const el of [this.art, this.title]) {
      el.classList.add("media-open-source");
      el.addEventListener("click", () => {
        const id = this.store.snapshot().state.sourceAppId;
        if (id) void Bridge.openMediaSource(id);
      }, { signal: this.lifetime.signal });
    }
    this.progress.append(this.seek);
    this.seek.addEventListener("pointerdown", (event) => {
      this.seeking = true;
      Visibility.setDragging(true);
      this.seek.setPointerCapture(event.pointerId);
    });
    this.seek.addEventListener("input", () => {
      const value = Number(this.seek.value),
        max = Number(this.seek.max);
      this.progressFill.style.width = `${max ? (value / max) * 100 : 0}%`;
      this.elapsed.textContent = mediaTime(value);
    });
    this.seek.addEventListener("change", () => {
      const seekMs = Number(this.seek.value);
      this.seeking = false;
      Visibility.setDragging(false);
      void this.perform({ seekMs }).finally(() => this.updateTime());
    });
    for (const event of ["pointercancel", "blur"])
      this.seek.addEventListener(event, () => {
        this.seeking = false;
        Visibility.setDragging(false);
        this.updateTime();
      });
    for (const event of ["pointerup", "lostpointercapture"])
      this.seek.addEventListener(event, () => Visibility.setDragging(false));
    this.audio = new MasterAudioController(store, (shrinking) =>
      this.resize(shrinking),
    );

    for (const [button, size] of [
      [this.primary, 24],
      [this.ambientPrimary, 20],
    ] as const) {
      const play = icon(ICONS.play, size);
      const pause = icon(ICONS.pause, size);
      play.classList.add("media-play-glyph");
      pause.classList.add("media-pause-glyph");
      button.replaceChildren(play, pause);
    }
    for (const [button, x] of [
      [this.previous, -1],
      [this.next, 1],
      [this.ambientPrevious, -1],
      [this.ambientNext, 1],
      [this.primary, 0],
      [this.ambientPrimary, 0],
      [this.shuffle, 0],
      [this.repeat, 0],
    ] as const) {
      button.addEventListener("click", () => {
        if (button.getAttribute("aria-disabled") !== "true")
          pressFeedback(button, x);
      });
    }
    const repeatAll = icon(ICONS.repeat, 17), repeatOne = icon(ICONS.repeatOne, 17);
    repeatAll.classList.add("media-repeat-all-glyph");
    repeatOne.classList.add("media-repeat-one-glyph");
    this.repeat.replaceChildren(repeatAll, repeatOne);
    this.unsubscribe = store.subscribe(() => this.render());
    this.image.addEventListener("load", () => {
      if (this.image.getAttribute("src") === this.renderedArt)
        this.art.classList.add("has-art");
    });
    this.image.addEventListener("error", () =>
      this.art.classList.remove("has-art"),
    );
    for (const image of [this.ambientImage]) {
      image.addEventListener("load", () => {
        if (image.getAttribute("src") === this.renderedArt)
          image.classList.add("is-loaded");
      });
      image.addEventListener("error", () =>
        image.classList.remove("is-loaded"),
      );
    }
    this.previous.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.perform("previous");
    });
    this.next.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.perform("next");
    });
    this.primary.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.perform(
        this.store.snapshot().state.playbackState === "playing"
          ? "pause"
          : "play",
      );
    });
    this.shuffle.addEventListener("click", (event) => {
      event.stopPropagation();
      const player = this.store.snapshot().player;
      const shuffle = this.modeTarget?.session === player.sessionId ? this.modeTarget.shuffle ?? player.shuffle : player.shuffle;
      if (this.shuffle.disabled || shuffle == null || !player.sessionId) return;
      this.modeTarget = { ...(this.modeTarget?.session === player.sessionId ? this.modeTarget : {}), session: player.sessionId, shuffle: !shuffle };
      this.render();
      this.flushModes();
    });
    this.repeat.addEventListener("click", (event) => {
      event.stopPropagation();
      const player = this.store.snapshot().player;
      const mode = this.modeTarget?.session === player.sessionId ? this.modeTarget.repeatMode ?? player.repeatMode : player.repeatMode;
      if (this.repeat.disabled || mode == null || !player.sessionId) return;
      this.modeTarget = { ...(this.modeTarget?.session === player.sessionId ? this.modeTarget : {}), session: player.sessionId,
        repeatMode: mode === "off" ? "list" : mode === "list" ? "track" : "off" };
      this.render();
      this.flushModes();
    });
    this.volumeSlider.addEventListener("pointerdown", (event) => {
      this.volumeDragging = true;
      this.sessionVolume.classList.add("is-adjusting");
      clearTimeout(this.volumeFeedbackTimer);
      Visibility.setDragging(true);
      this.volumeSlider.setPointerCapture(event.pointerId);
    });
    this.volumeSlider.addEventListener("input", () => this.queueVolume());
    this.volumeSlider.addEventListener("change", () => {
      this.queueVolume(); this.endVolumeDrag(); this.flushVolume();
    });
    for (const event of ["pointerup", "pointercancel", "lostpointercapture", "blur"])
      this.volumeSlider.addEventListener(event, () => this.endVolumeDrag());
    for (const [button, action] of [
      [this.ambientPrevious, "previous"],
      [this.ambientPrimary, "pause"],
      [this.ambientNext, "next"],
    ] as const) {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.perform(
          button === this.ambientPrimary
            ? this.store.snapshot().state.playbackState === "playing"
              ? "pause"
              : "play"
            : action,
        );
      });
    }
    this.render();
  }

  heightFor(mode: IslandVisibility, view: IslandViewName): number {
    return this.enabled &&
      mode === "expanded" &&
      mediaPresentation(mode, view) === "player" &&
      hasSession(this.store.snapshot().state)
      ? MEDIA_SPACE
      : 0;
  }

  get available(): boolean {
    return this.enabled && hasSession(this.store.snapshot().state);
  }

  get viewHeight(): number {
    if (!this.available)
      return this.audio.expanded ? MEDIA_EMPTY_CARD_HEIGHT : MEDIA_EMPTY_COLLAPSED_HEIGHT;
    return this.audio.expanded
      ? MEDIA_VIEW_CARD_HEIGHT
      : MEDIA_VIEW_COLLAPSED_HEIGHT;
  }

  placeAudio(host?: HTMLElement): void {
    const parent = host ?? this.rowEl;
    if (this.audio.el.parentElement !== parent) parent.append(this.audio.el);
  }

  setCompactControlsHeld(value: boolean): void {
    if (this.compactControlsHeld === value) return;
    this.compactControlsHeld = value;
    this.render();
  }

  private compactSuppressed = false;

  compactControlHit(x: number, y: number, margin = 0): boolean {
    if (!this.ambientVisible || this.coreMode !== null) return false;
    const rect = this.ambientEl.querySelector(".media-ambient-controls")!.getBoundingClientRect();
    const shell = this.ambientEl.closest("#island")!.getBoundingClientRect();
    // Match the native approach margin across the full height and right edge,
    // including the padding between the physical bar and its buttons.
    return x >= rect.left - margin && x <= shell.right + margin &&
      y >= shell.top - margin && y <= shell.bottom + margin;
  }

  get compactVisible(): boolean {
    return this.ambientVisible;
  }

  get emptyLabel(): string {
    const state = this.store.snapshot().state;
    return state.providerStatus !== "ready"
      ? "Media is unavailable"
      : state.playbackState === "none"
        ? "Nothing playing"
        : "Playback unavailable";
  }

  place(dock: HTMLElement, view: IslandViewName): void {
    const dedicated = view === "media";
    this.rowEl.classList.toggle("is-module", dedicated);
    this.rowEl.classList.toggle("is-dedicated", dedicated);
    if (!this.enabled || view !== "media") this.rowEl.remove();
    else if (!dedicated && this.rowEl.parentElement !== dock)
      dock.append(this.rowEl);
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.unsubscribe();
    this.unsubscribe = enabled
      ? this.store.subscribe(() => this.render())
      : () => {};
    this.renderKey = "";
    this.render();
    if (!enabled) {
      this.rowEl.remove();
      this.ambientEl.remove();
    }
    this.resize(!enabled);
  }

  sync(
    mode: IslandVisibility,
    view: IslandViewName,
    compactFullControls = false,
    coreMode: CoreMediaMode = null,
    compactSuppressed = false,
  ): void {
    this.mode = mode;
    this.view = view;
    this.compactFullControls = compactFullControls;
    this.coreMode = coreMode;
    this.compactSuppressed = compactSuppressed;
    this.render();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.volumeFeedbackTimer);
    this.volumeTarget = null;
    this.modeTarget = null;
    this.endVolumeDrag();
    this.lifetime.destroy();
    this.audio.destroy();
    this.equalizer.destroy();
    this.unsubscribe();
    clearTimeout(this.clock);
    this.image.removeAttribute("src");
    this.ambientImage.removeAttribute("src");
    this.renderedArt = null;
  }

  private async perform(action: MediaAction): Promise<void> {
    const session = this.store.snapshot().player.sessionId;
    if (!session || this.pendingSession === session) return;
    this.pendingSession = session;
    this.pendingTransport = typeof action === "string" || "seekMs" in action;
    this.errorSession = null;
    this.render();
    try {
      await this.store.control(action);
    } catch {
      if (this.store.snapshot().player.sessionId === session)
        this.errorSession = session;
    } finally {
      if (this.pendingSession === session) {
        this.pendingSession = null;
        this.pendingTransport = false;
      }
      this.render();
      this.flushModes();
      this.flushVolume();
    }
  }

  private flushModes(): void {
    if (this.destroyed || !this.modeTarget || this.modeInFlight || this.pendingSession) return;
    const target = this.modeTarget;
    if (target.session !== this.store.snapshot().player.sessionId) {
      this.modeTarget = null;
      return;
    }
    const field = target.shuffle !== undefined ? "shuffle" : "repeatMode";
    const value = target[field];
    if (value === undefined) return;
    this.modeInFlight = true;
    void this.perform(field === "shuffle" ? { shuffle: value as boolean } : { repeatMode: value as "off" | "list" | "track" }).finally(() => {
      this.modeInFlight = false;
      if (this.modeTarget?.session === target.session && this.modeTarget[field] === value) {
        delete this.modeTarget[field];
        if (this.modeTarget.shuffle === undefined && this.modeTarget.repeatMode === undefined) this.modeTarget = null;
      }
      this.render();
      this.flushModes();
      this.flushVolume();
    });
  }

  private endVolumeDrag(): void {
    if (this.volumeDragging) {
      this.volumeDragging = false;
      Visibility.setDragging(false);
    }
    clearTimeout(this.volumeFeedbackTimer);
    if (!this.destroyed) this.volumeFeedbackTimer = setTimeout(() => this.sessionVolume.classList.remove("is-adjusting"), 1100);
  }

  private queueVolume(): void {
    const session = this.store.snapshot().player.sessionId;
    if (!session || this.volumeSlider.disabled) return;
    this.volumeTarget = { session, value: Number(this.volumeSlider.value) };
    this.sessionVolume.classList.add("is-adjusting");
    clearTimeout(this.volumeFeedbackTimer);
    this.volumeFeedbackTimer = setTimeout(() => {
      if (!this.volumeDragging) this.sessionVolume.classList.remove("is-adjusting");
    }, 1100);
    this.sessionVolume.style.setProperty("--volume-fill", `${this.volumeSlider.value}%`);
    this.volumeSlider.setAttribute("aria-valuetext", `${this.volumeSlider.value}%`);
    this.volumeValue.textContent = `${this.volumeSlider.value}%`;
    // Start on the leading edge, then send only the newest value while native
    // confirmation is in flight. Dragging never waits for a quiet debounce gap.
    this.flushVolume();
  }

  private flushVolume(): void {
    if (this.destroyed || !this.volumeTarget || this.volumeInFlight || this.pendingSession) return;
    const target = this.volumeTarget;
    this.volumeTarget = null;
    if (target.session !== this.store.snapshot().player.sessionId) return;
    this.volumeInFlight = true;
    void this.perform({ volume: target.value }).finally(() => {
      this.volumeInFlight = false;
      this.renderKey = "";
      this.render();
      this.flushVolume();
    });
  }

  private render(): void {
    if (this.destroyed) return;
    this.audio.setVisible(
      this.enabled && this.mode === "expanded" && this.view === "media" && !this.coreMode,
    );
    const { state, player } = this.store.snapshot();
    if (this.modeTarget && this.modeTarget.session !== player.sessionId) this.modeTarget = null;
    const shuffle = this.modeTarget?.shuffle ?? player.shuffle;
    const repeatMode = this.modeTarget?.repeatMode ?? player.repeatMode;
    const ambient =
      this.enabled &&
      !this.compactSuppressed &&
      (this.coreMode === "hover" ||
        (mediaPresentation(this.mode, this.view) === "compact" &&
          (state.playbackState === "paused" || this.compactControlsHeld))) &&
      state.providerStatus === "ready" &&
      ["playing", "paused"].includes(state.playbackState);
    const row = !this.coreMode && this.heightFor(this.mode, this.view) > 0;
    const visible = ambient || row;
    const busy =
      visible &&
      this.pendingTransport &&
      this.pendingSession !== null &&
      this.pendingSession === player.sessionId;
    const error =
      visible &&
      this.errorSession !== null &&
      this.errorSession === player.sessionId;
    const art =
      visible &&
      /^blob:/.test(
        player.artwork?.dataUrl ?? "",
      )
        ? player.artwork!.dataUrl
        : null;
    // Hidden updates and duplicate revisions never wake the island render loop.
    const key = JSON.stringify([
      ambient,
      row,
      visible && state.title,
      visible && state.artist,
      visible && state.playbackState,
      visible && player.sessionId,
      visible && player.controls,
      visible && shuffle,
      visible && repeatMode,
      row && player.volume,
      row && player.volumeStep,
      row && state.sourceAppId,
      row && player.sessions,
      row && this.view === "media" && player.timeline,
      ambient && this.compactFullControls,
      this.coreMode,
      this.compactControlsHeld,
      this.coreMode === "hover" && player.timeline,
      busy,
      error,
    ]);
    if (key === this.renderKey && art === this.renderedArt) return;
    this.renderKey = key;
    clearTimeout(this.clock);
    this.clock = undefined;

    const changedHeight = row !== this.rowVisible;
    const changedAmbient = ambient !== this.ambientVisible;
    this.ambientVisible = ambient;
    this.rowVisible = row;
    this.ambientEl.classList.toggle("is-visible", ambient);
    this.ambientEl.classList.toggle("is-core-hover", this.coreMode === "hover");
    this.ambientEl.classList.toggle("is-compact-transport", ambient && this.coreMode === null);
    this.ambientEl.setAttribute("aria-hidden", String(!ambient));
    this.ambientEl.classList.toggle(
      "has-full-controls",
      this.compactFullControls,
    );
    this.rowEl.classList.toggle("is-visible", row);
    this.rowEl.setAttribute("aria-hidden", String(!row));
    this.rowEl.classList.toggle("is-quiet", state.playbackState !== "playing");
    this.equalizer.setVisible(visible && this.coreMode !== null);

    const title = visible ? (state.title ?? "Title unavailable") : "";
    const artist = visible ? (state.artist ?? "") : "";
    const status = error
      ? "Try again"
      : row && state.playbackState === "playing"
        ? "Playing"
        : row && state.playbackState === "paused"
          ? "Paused"
          : "";
    this.title.textContent = title;
    this.title.title = title;
    this.ambientTitle.textContent = title;
    this.ambientTitle.title = title;
    this.ambientArtist.textContent = artist;
    this.ambientArtist.title = artist;
    this.ambientArtist.hidden = !artist;
    this.artist.textContent = artist;
    this.artist.title = artist;
    this.artist.hidden = artist.length === 0;
    this.status.textContent = status;
    this.status.hidden = status.length === 0;
    const sessions = row ? player.sessions ?? [] : [];
    this.apps.el.hidden = sessions.length < 2;
    if (sessions.length >= 2) this.apps.update(sessions.map(session => ({
      id: session.id,
      name: mediaSource(session.sourceAppId).name || "App",
      detail: session.playing ? "Playing" : "Paused",
    })), sessions.find(session => session.sourceAppId === state.sourceAppId)?.id, true, "Choose app");
    const sourceId = row ? state.sourceAppId : null;
    if (sourceId !== this.renderedSource) {
      this.renderedSource = sourceId;
      const source = mediaSource(sourceId);
      this.source.replaceChildren(
        source.logo,
        h("span", { text: source.name }),
      );
      this.source.dataset.source = source.id;
    }
    // The app switcher replaces the source line when several apps have media.
    this.source.hidden = sessions.length >= 2 || !this.source.textContent;
    this.announcement.textContent = error
      ? "Could not update playback. Try again."
      : "";
    this.ambientEl.setAttribute(
      "aria-label",
      ambient ? [title, artist].filter(Boolean).join(" — ") : "",
    );
    const known = !["none", "unknown", "closed", "changing"].includes(
      state.playbackState,
    );
    const canControl =
      visible &&
      state.providerStatus === "ready" &&
      !!player.sessionId &&
      known;
    const canVolume = row && canControl && !!player.controls.volume && player.volume != null;
    if (this.volumeSession !== player.sessionId || !canVolume) {
      this.volumeSession = player.sessionId;
      this.volumeTarget = null;
      this.endVolumeDrag();
    }
    const volumeName = `${this.source.textContent || "Player"} volume`;
    this.sessionVolume.classList.toggle("is-unavailable", !canVolume);
    this.volumeValue.textContent = canVolume ? `${this.volumeDragging || this.volumeTarget || this.volumeInFlight ? this.volumeSlider.value : player.volume}%` : "—";
    this.sessionVolume.setAttribute("aria-label", volumeName);
    this.sessionVolume.title = canVolume ? volumeName : this.source.dataset.source === "spotify"
      ? "Open Spotify to make its volume slider available" : "App volume is unavailable from this player";
    this.volumeSlider.setAttribute("aria-label", volumeName);
    this.volumeSlider.disabled = !canVolume;
    this.volumeSlider.step = String(player.volumeStep ?? 1);
    if (!this.volumeDragging && !this.volumeTarget && !this.volumeInFlight) {
      this.volumeSlider.value = String(player.volume ?? 0);
      this.sessionVolume.style.setProperty("--volume-fill", `${player.volume ?? 0}%`);
    }
    this.volumeSlider.setAttribute("aria-valuetext", canVolume ? `${this.volumeSlider.value}%` : "Unavailable");
    const action = state.playbackState === "playing" ? "pause" : "play";
    const label = known
      ? action === "pause"
        ? "Pause"
        : "Play"
      : "Playback unavailable";
    if (label !== this.primaryLabel) {
      this.primaryLabel = label;
      this.primary.setAttribute("aria-label", label);
      this.primary.title = label;
      this.primary.dataset.action = action;
      this.ambientPrimary.setAttribute("aria-label", label);
      this.ambientPrimary.title = label;
      this.ambientPrimary.dataset.action = action;
    }
    this.previous.disabled = !canControl || !player.controls.previous;
    this.primary.disabled = !canControl || !player.controls[action];
    this.next.disabled = !canControl || !player.controls.next;
    this.shuffle.disabled = !canControl || !player.controls.shuffle || player.shuffle == null;
    this.repeat.disabled = !canControl || !player.controls.repeat || player.repeatMode == null;
    const spotify = this.source.dataset.source === "spotify";
    this.shuffle.hidden = this.repeat.hidden = !spotify;
    this.shuffle.setAttribute("aria-pressed", String(shuffle === true));
    this.repeat.setAttribute("aria-pressed", String(repeatMode != null && repeatMode !== "off"));
    if (this.repeat.dataset.mode !== (repeatMode ?? "")) {
      this.repeat.dataset.mode = repeatMode ?? "";
    }
    const shuffleLabel = shuffle === true ? "Shuffle on" : "Shuffle off";
    const repeatLabel = repeatMode === "track" ? "Repeat one" : repeatMode === "list" ? "Repeat all" : "Repeat off";
    this.shuffle.setAttribute("aria-label", shuffleLabel); this.shuffle.title = this.shuffle.disabled ? "Shuffle is not available from this player" : shuffleLabel;
    this.repeat.setAttribute("aria-label", repeatLabel); this.repeat.title = this.repeat.disabled ? "Repeat is not available from this player" : repeatLabel;
    this.ambientPrevious.disabled =
      !ambient || !canControl || !player.controls.previous;
    this.ambientPrimary.disabled =
      !ambient || !canControl || !player.controls[action];
    this.ambientNext.disabled =
      !ambient || !canControl || !player.controls.next;
    this.ambientPrevious.tabIndex = this.ambientNext.tabIndex = ambient
      ? 0
      : -1;
    this.ambientPrimary.tabIndex = ambient ? 0 : -1;
    this.controls.setAttribute("aria-busy", String(busy));
    this.ambientEl.setAttribute("aria-busy", String(busy));
    for (const button of [
      this.shuffle,
      this.repeat,
      this.previous,
      this.primary,
      this.next,
      this.ambientPrevious,
      this.ambientPrimary,
      this.ambientNext,
    ]) {
      button.setAttribute("aria-disabled", String(button.disabled || busy));
      button.classList.toggle("is-pending", busy && !button.disabled);
    }
    if (art !== this.renderedArt) {
      this.renderedArt = art;
      this.art.classList.remove("has-art");
      this.ambientImage.classList.remove("is-loaded");
      if (art) {
        this.image.src = art;
        this.ambientImage.src = art;
        this.backdrop.src = art;
      } else {
        this.image.removeAttribute("src");
        this.backdrop.removeAttribute("src");
        this.ambientImage.removeAttribute("src");
      }
    }
    if ((row && this.view === "media") || this.coreMode === "hover") this.updateTime();
    if (changedHeight || changedAmbient) this.resize(!row);
  }

  private updateTime(): void {
    // User input and command confirmations can arrive before the next tick.
    // Replace the pending tick rather than starting another timer chain.
    clearTimeout(this.clock);
    this.clock = undefined;
    if (this.destroyed || document.hidden || !this.enabled ||
      !((this.rowVisible && this.view === "media") || this.coreMode === "hover")) return;
    const { state, player } = this.store.snapshot();
    const known = ["playing", "paused", "stopped"].includes(
      state.playbackState,
    );
    const position = known
      ? timelinePosition(player.timeline, state.playbackState === "playing")
      : null;
    const duration = position !== null ? player.timeline!.durationMs : null;
    this.seek.hidden = !player.controls.seek || position === null;
    this.seek.disabled = this.pendingSession !== null;
    this.seek.max = String(duration ?? 0);
    if (!this.seeking) this.seek.value = String(position ?? 0);
    this.seek.setAttribute(
      "aria-valuetext",
      `${mediaTime(position)} of ${mediaTime(duration)}`,
    );
    if (this.seeking) return;
    const key = `${mediaTime(position)}|${mediaTime(duration)}`;
    if (this.timeKey !== key) {
      this.timeKey = key;
      this.elapsed.textContent = mediaTime(position);
      this.duration.textContent = mediaTime(duration);
      this.progress.classList.toggle("is-unavailable", position === null);
      if (position === null) {
        this.progress.removeAttribute("aria-valuenow");
        this.progress.removeAttribute("aria-valuemax");
        this.progress.setAttribute(
          "aria-valuetext",
          "Playback time unavailable",
        );
      } else {
        this.progress.setAttribute(
          "aria-valuenow",
          String(Math.floor(position / 1000)),
        );
        this.progress.setAttribute(
          "aria-valuemax",
          String(Math.floor(duration! / 1000)),
        );
        this.progress.setAttribute(
          "aria-valuetext",
          `${mediaTime(position)} of ${mediaTime(duration)}`,
        );
      }
      this.progressFill.style.width = `${duration ? (position! / duration) * 100 : 0}%`;
      this.ambientProgressFill.style.width = this.progressFill.style.width;
      this.ambientProgress.hidden = position === null;
    }
    // A presentation clock, not a media poll. It lives only on the visible Media
    // player; no IPC, store mutation, island frames, or work in compact/peek.
    if (
      this.enabled &&
      this.mode === "expanded" &&
      ((this.view === "media" && this.rowVisible) || this.coreMode === "hover") &&
      state.playbackState === "playing" &&
      position !== null &&
      player.timeline?.playbackRateMilli !== 0
    ) {
      this.clock = setTimeout(() => {
        this.clock = undefined;
        this.updateTime();
      }, 1000);
    }
  }
}
