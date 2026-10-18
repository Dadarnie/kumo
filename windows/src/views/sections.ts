// SPDX-License-Identifier: MIT
import { State } from "../core/state";
import { VIEW_LAYOUTS } from "../core/layout";
import { h } from "./dom";
import { ICONS, icon } from "./icons";
import { musicMode, type MimoGlyph } from "../icons/glyphs";
import { mimoIcon } from "../icons/render";
import { notchMedia } from "../icons/notch";
import type { ViewActions, ViewHost } from "./views";
import type { ModuleOverview } from "./overview";
import type { IslandMedia } from "../island/media";
import "./sections.css";
import { Sound } from "../core/sound";

function utilityAction(
  label: string,
  glyph: string | MimoGlyph,
  action: () => void,
): HTMLButtonElement {
  return h(
    "button",
    { class: "section-action", type: "button", onclick: () => { Sound.play("blip"); action(); } },
    typeof glyph === "string" ? icon(glyph, 13) : mimoIcon(glyph, 13),
    h("span", { text: label }),
  );
}

function utilityActions(actions: ViewActions) {
  const media = utilityAction("Now playing", notchMedia, () => actions.setView("media"));
  media.dataset.homeMedia = "";
  const el = h(
    "div",
    { class: "section-actions" },
    media,
    utilityAction("Drop a file", ICONS.plus, () => actions.setView("upload")),
  );
  return { el, media };
}

/** Home reuses the existing integration workspace and its retained components. */
export function buildHome(actions: ViewActions, workspace: ModuleOverview): ViewHost {
  const controls = utilityActions(actions);
  const footer = h("div", {class:"home-footer"}, controls.el);
  const el = workspace.el;
  el.classList.add("home-view");
  el.append(footer);
  return {
    el,
    layout() {
      const layout = workspace.layout();
      return {...layout, height:Math.min(432, layout.height + (footer.hidden ? 0 : 38))};
    },
    sync() {
      workspace.sync();
      controls.media.hidden = !State.settings.modules.media;
      footer.hidden = el.dataset.preview === "true";
    },
    setVisible: visible => workspace.setVisible(visible),
    destroy: () => workspace.destroy(),
  };
}

/** The same retained player is moved here; actions and subscriptions stay in IslandMedia. */
export function buildMediaPage(media: IslandMedia): ViewHost {
  const empty = h(
    "section",
    { class: "card section-empty" },
    mimoIcon(musicMode, 28),
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
