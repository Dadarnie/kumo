// SPDX-License-Identifier: MIT
import { h } from "./dom";
import { icon, ICONS } from "./icons";

export interface DeviceOption {
  readonly id: string;
  readonly name: string;
  readonly shortName?: string;
  readonly color?: string;
  readonly detail?: string;
}
let sequence = 0;

/** A compact listbox in the top layer, so native island clipping cannot cut it off. */
export class CompactDropdown {
  private text = h("span", { class: "audio-device-name" });
  readonly button: HTMLButtonElement;
  private menu: HTMLDivElement;
  readonly el: HTMLDivElement;
  private options: readonly DeviceOption[] = [];
  private selected: string | null = null;
  private inventory = "";
  private search = "";
  private searchAt = 0;

  constructor(
    label: string,
    className: string,
    private choose: (id: string) => void | Promise<void>,
    private device = false,
  ) {
    const id = `audio-devices-${++sequence}`;
    this.button = h(
      "button",
      {
        class: `audio-device-button ${className}`,
        type: "button",
        "aria-label": device ? `Windows ${label.toLowerCase()} device` : label,
        "aria-haspopup": "listbox",
        "aria-expanded": "false",
        "aria-controls": id,
        popovertarget: id,
      },
      this.text,
      icon(ICONS.chevronDown, 14),
    );
    this.menu = h("div", {
      id,
      class: "audio-device-menu",
      popover: "auto",
      role: "listbox",
      "aria-label": device ? `${label} device` : label,
    });
    this.el = h(
      "div",
      { class: "audio-device-picker" },
      h("span", { class: "audio-device-label", text: label, hidden: !device }),
      this.button,
      this.menu,
    );
    this.button.addEventListener("click", (event) => {
      // Keep the native invoker relationship for light dismissal, while our
      // handler supplies placement and keyboard focus.
      event.preventDefault();
      event.stopPropagation();
      this.toggle();
    });
    this.button.addEventListener("keydown", (event) => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        this.open();
        if (event.key === "Home") this.focus(0);
        if (event.key === "End" || event.key === "ArrowUp")
          this.focus(this.options.length - 1);
      }
    });
    this.menu.addEventListener("toggle", () =>
      this.button.setAttribute(
        "aria-expanded",
        String(this.menu.matches(":popover-open")),
      ),
    );
    this.menu.addEventListener("click", (event) => event.stopPropagation());
    this.menu.addEventListener("keydown", (event) => {
      const current = [...this.menu.querySelectorAll("button")].indexOf(
        document.activeElement as HTMLButtonElement,
      );
      if (
        ["ArrowDown", "ArrowUp", "Home", "End", "Escape"].includes(event.key)
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") {
          this.close();
          this.button.focus();
        } else
          this.focus(
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? this.options.length - 1
                : current + (event.key === "ArrowDown" ? 1 : -1),
          );
      } else if (event.key === "Tab") this.close();
      else if (
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.key !== " "
      ) {
        event.preventDefault();
        this.search =
          Date.now() - this.searchAt < 650
            ? this.search + event.key.toLowerCase()
            : event.key.toLowerCase();
        this.searchAt = Date.now();
        const index = this.options.findIndex((option) =>
          option.name.toLowerCase().startsWith(this.search),
        );
        if (index >= 0) this.focus(index);
      }
    });
    this.el.addEventListener("focusout", (event) => {
      // Pointer focus can dispatch focusout before activeElement is updated.
      // Use its destination so choosing another option cannot close the menu
      // between pointerdown and click.
      if (!this.el.contains(event.relatedTarget as Node | null)) this.close();
    });
  }
  update(
    options: readonly DeviceOption[],
    selected: string | null | undefined,
    enabled: boolean,
    placeholder = "Unavailable",
  ): void {
    this.options = options;
    this.selected = selected ?? null;
    const option = options.find((option) => option.id === selected);
    const name = option?.name ?? placeholder;
    const label = option?.shortName ?? name;
    const presentation = JSON.stringify([selected, label, option?.color]);
    if (this.text.dataset.presentation !== presentation) {
      this.text.dataset.presentation = presentation;
      this.text.textContent = label;
      if (option?.color) this.text.prepend(h("span", { class: "audio-device-dot", "aria-hidden": "true", style: "background:" + option.color }));
    }
    this.button.title = name;
    this.button.disabled = !enabled || !options.length;
    if (this.button.disabled) this.close();
    const key = JSON.stringify(options);
    if (key !== this.inventory) {
      this.inventory = key;
      const focused = (document.activeElement as HTMLElement)?.dataset.device;
      const retained = new Map([...this.menu.querySelectorAll<HTMLButtonElement>("button")]
        .map(button => [button.dataset.device!, button]));
      options.forEach((option, index) => {
        let button = retained.get(option.id);
        if (!button) {
          button = h(
            "button",
            {
              class: "audio-device-option",
              type: "button",
              role: "option",
              tabindex: "-1",
              "data-device": option.id,
            },
            icon(ICONS.check, 16),
            h("span", { class: "audio-device-option-name", dir: "auto" },
              h("span", { class: "audio-device-dot", "aria-hidden": "true" }),
              h("span", { class: "audio-device-option-copy" },
                h("span", { class: "audio-device-option-title" }),
                h("small", { class: "audio-device-option-detail" }))),
          );
          button.addEventListener("click", () => {
            this.close();
            this.button.focus();
            void Promise.resolve(this.choose(option.id))
              .catch(() => {})
              .finally(() => {
                // Disabling the trigger while Windows confirms a switch releases
                // focus. Restore it unless the user has moved to another control.
                if (
                  document.activeElement === document.body ||
                  document.activeElement === this.button
                )
                  this.button.focus();
              });
          });
        }
        retained.delete(option.id);
        const title = button.querySelector<HTMLElement>(".audio-device-option-title")!;
        const detail = button.querySelector<HTMLElement>(".audio-device-option-detail")!;
        const dot = button.querySelector<HTMLElement>(".audio-device-dot")!;
        if (title.textContent !== option.name) title.textContent = option.name;
        if (detail.textContent !== (option.detail ?? "")) detail.textContent = option.detail ?? "";
        detail.hidden = !option.detail;
        dot.hidden = !option.color;
        dot.style.background = option.color ?? "";
        // Live hook updates can arrive between pointerdown and click. Retain
        // each option and its children so that pending click keeps its target.
        if (this.menu.children[index] !== button)
          this.menu.insertBefore(button, this.menu.children[index] ?? null);
      });
      for (const button of retained.values()) button.remove();
      if (focused && this.menu.matches(":popover-open") && !this.menu.contains(document.activeElement))
        this.focus(options.findIndex((option) => option.id === focused));
    }
    for (const option of this.menu.querySelectorAll<HTMLElement>(
      "[role=option]",
    ))
      option.setAttribute(
        "aria-selected",
        String(option.dataset.device === this.selected),
      );
  }
  close(): void {
    if (this.menu.matches(":popover-open")) this.menu.hidePopover();
    this.button.setAttribute("aria-expanded", "false");
  }
  private toggle(): void {
    if (this.menu.matches(":popover-open")) this.close();
    else this.open();
  }
  private open(): void {
    if (this.button.disabled) return;
    const island = this.button.closest("#island")?.getBoundingClientRect();
    const ceiling = island ? Math.min(window.innerHeight, island.bottom) - 8 : window.innerHeight - 8;
    const floor = Math.max(
      island ? island.top + 8 : 8,
      (this.button.closest(".audio-panel")?.getBoundingClientRect().top ??
        -22) + 30,
    );
    this.menu.style.maxHeight = `${Math.max(48, Math.min(210, ceiling - floor))}px`;
    this.menu.showPopover();
    this.button.setAttribute("aria-expanded", "true");
    const rect = this.button.getBoundingClientRect();
    const anchor = this.el.getBoundingClientRect();
    const preferredWidth = this.device ? Math.max(anchor.width, 240)
      : Math.max(anchor.width, this.options.some(option => option.detail) ? 224 : 160);
    this.menu.style.width = `${Math.min(preferredWidth, window.innerWidth - 24)}px`;
    // Placement uses layout dimensions, independent of the entrance transform.
    const width = this.menu.offsetWidth,
      height = this.menu.offsetHeight;
    this.menu.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`;
    const below = rect.bottom + 6;
    const top = below + height <= ceiling ? below : rect.top - height - 6;
    const placedTop = Math.max(floor, Math.min(top, ceiling - height));
    this.menu.style.top = `${placedTop}px`;
    this.menu.dataset.side = placedTop < rect.top ? "above" : "below";
    this.focus(
      Math.max(
        0,
        this.options.findIndex((option) => option.id === this.selected),
      ),
    );
  }
  private focus(index: number): void {
    const options = [
      ...this.menu.querySelectorAll<HTMLButtonElement>("button"),
    ];
    options[(index + options.length) % options.length]?.focus({ preventScroll: true });
  }
}

/** Audio selectors share the same accessible picker as Settings. */
export class DevicePicker extends CompactDropdown {
  constructor(
    label: string,
    className: string,
    choose: (id: string) => void | Promise<void>,
  ) {
    super(label, className, choose, true);
  }
}
