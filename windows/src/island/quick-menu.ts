// SPDX-License-Identifier: MIT
import { h } from "../views/dom";

export interface QuickAction { id: string; label: string; checked?: boolean }

/** Browser preview of the native menu, using the existing picker material and keys. */
export class MimoQuickMenu {
  private el = h("div", {class:"audio-device-menu mimo-quick-menu",popover:"auto",role:"menu","aria-label":"Mimo quick controls"});
  private trigger: HTMLElement | null = null;
  constructor(private choose: (id: string) => void, private active: (open: boolean) => void) {
    document.body.append(this.el);
    this.el.addEventListener("toggle", () => this.active(this.el.matches(":popover-open")));
    this.el.addEventListener("keydown", event => {
      const buttons = [...this.el.querySelectorAll<HTMLButtonElement>("button")];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault(); event.stopPropagation(); buttons[index]?.click();
      } else if (["ArrowDown","ArrowUp","Home","End"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length-1 :
          (index + (event.key === "ArrowDown" ? 1 : buttons.length-1)) % buttons.length]?.focus();
      } else if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); this.el.hidePopover(); this.trigger?.focus();
      } else if (event.key === "Tab") this.el.hidePopover();
    });
  }
  open(actions: QuickAction[], x: number, y: number, trigger: HTMLElement): void {
    this.trigger = trigger;
    this.el.replaceChildren(...actions.map(action => h("button", {
      class:"mimo-quick-action",type:"button",role:action.checked === undefined ? "menuitem" : "menuitemcheckbox",
      "data-action":action.id,...(action.checked === undefined ? {} : {"aria-checked":String(action.checked)}),
      text:action.label,onclick:()=>{this.el.hidePopover(); this.choose(action.id);},
    })));
    this.el.showPopover();
    this.el.style.left = `${Math.max(8, Math.min(x,window.innerWidth-this.el.offsetWidth-8))}px`;
    this.el.style.top = `${Math.max(8, Math.min(y,window.innerHeight-this.el.offsetHeight-8))}px`;
    this.el.querySelector<HTMLButtonElement>("button")?.focus();
  }
  destroy(): void { this.el.remove(); }
}
