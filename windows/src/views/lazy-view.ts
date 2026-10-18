// SPDX-License-Identifier: MIT
import { prefersReducedMotion } from "../core/motion";
import type { ViewLayout } from "../core/layout";
import { h } from "./dom";
import type { ViewHost } from "./views";

/** Keep an empty slot until first use, then retain the original view and its state. */
export function lazyView(build: () => ViewHost, fallback?: ViewLayout): ViewHost {
  const slot = h("div", { class: "view" });
  let view: ViewHost | null = null;
  let entrance: Animation | null = null;
  let disposed = false;
  const stopEntrance = () => { entrance?.cancel(); entrance = null; };
  return {
    get el() { return view?.el ?? slot; },
    get voice() { return view?.voice; },
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
        const reduced = prefersReducedMotion();
        entrance = view.el.animate([
          { opacity: 0, transform: reduced ? "none" : "translateY(2px)" },
          { opacity: 1, transform: "none" },
        ], { duration: reduced ? 80 : 180, easing: "cubic-bezier(.22, 1, .36, 1)" });
        const current = entrance;
        void current.finished.catch(() => {}).finally(() => { if (entrance === current) entrance = null; });
      }
      if (!visible) stopEntrance();
      view?.setVisible?.(visible);
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      stopEntrance();
      view?.destroy?.();
      view?.el.remove();
      view = null;
      slot.remove();
    },
  };
}
