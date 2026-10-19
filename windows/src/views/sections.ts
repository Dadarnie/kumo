// SPDX-License-Identifier: MIT
import { VIEW_LAYOUTS, EXPANDED_W } from "../core/layout";
import { h } from "./dom";
import type { ViewActions, ViewHost } from "./views";
import type { ModuleOverview } from "./overview";
import type { IslandMedia } from "../island/media";
import "./sections.css";

/** Home reuses the existing integration workspace and its retained components. */
export function buildHome(_actions: ViewActions, workspace: ModuleOverview): ViewHost {
  const el = workspace.el;
  el.classList.add("home-view");
  return {
    el,
    layout() {
      return workspace.layout();
    },
    sync() {
      workspace.sync();
    },
    setVisible: visible => workspace.setVisible(visible),
    destroy: () => workspace.destroy(),
  };
}

/** The same retained player is moved here; actions and subscriptions stay in IslandMedia. */
export function buildMediaPage(media: IslandMedia): ViewHost {
  const empty = h(
    "section",
    { class: "card section-empty media-empty" },
    h("div", { class: "media-empty-mimo", "aria-hidden": "true" }),
    h("h1", { text: "Nothing playing" }),
    h("p", {
      class: "sub",
      text: "Play something in your favorite app.",
    }),
  );
  const el = h("div", { class: "view section-view media-page" });
  return {
    el,
    layout: () => ({
      ...VIEW_LAYOUTS.media,
      ...(media.available ? {} : { botX: EXPANDED_W / 2, botY: 80, botDiameter: 44 }),
      height: 52 + media.viewHeight,
    }),
    sync() {
      el.style.setProperty("--media-view-height", `${media.viewHeight}px`);
      if (media.available) {
        empty.remove();
        media.placeAudio();
        media.rowEl.classList.add("is-module", "is-dedicated");
        if (media.rowEl.parentElement !== el) el.append(media.rowEl);
      } else {
        media.rowEl.remove();
        media.placeAudio(empty);
        empty.querySelector("h1")!.textContent = media.emptyLabel;
        if (empty.parentElement !== el) el.append(empty);
      }
    },
  };
}
