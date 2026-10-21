// SPDX-License-Identifier: MIT
import type { ViewLayout } from "../core/layout";
import { h } from "./dom";
import type { ViewHost } from "./views";

/** Keep an empty slot until first use, then retain the original view and its state. */
export function lazyView(build: () => ViewHost, fallback?: ViewLayout): ViewHost {
  const slot = h("div", { class: "view" });
  let view: ViewHost | null = null;
  let disposed = false;
  return {
    get el() { return view?.el ?? slot; },
    sync() { view?.sync(); },
    tick(now) { view?.tick?.(now); },
    focus() { view?.focus?.(); },
    ...(fallback ? { layout: () => view?.layout?.() ?? fallback } : {}),
    setVisible(visible) {
      if (disposed) return;
      if (visible && !view) {
        view = build();
        view.el.classList.toggle("on", slot.classList.contains("on"));
        view.el.inert = slot.inert;
        slot.replaceWith(view.el);
        // The island already owns the panel transition. Populate this view in
        // the same turn so its first painted frame has content and correct size.
        view.sync();
      }
      view?.setVisible?.(visible);
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      view?.destroy?.();
      view?.el.remove();
      view = null;
      slot.remove();
    },
  };
}
