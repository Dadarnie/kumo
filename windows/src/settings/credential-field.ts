// SPDX-License-Identifier: MIT
import { Bridge } from "../core/bridge";
import { Lifetime } from "../core/lifetime";
import { h } from "../views/dom";

const VALIDATION_ERRORS = new Set([
  "Credential contains unsupported characters or is too long.",
  "Enter a valid n8n URL.",
  "Use an n8n base URL without credentials, a query, or a fragment.",
  "Use HTTPS for n8n, or HTTP on localhost.",
]);
/** Saved credentials are represented only by a boolean, never read back. */
export class CredentialField {
  readonly el: HTMLElement;
  private lifetime = new Lifetime();
  private input: HTMLInputElement;
  private save: HTMLButtonElement;
  private remove: HTMLButtonElement;
  private removalPanel: HTMLElement;
  private confirmRemoval: HTMLButtonElement;
  private dot = h("i", { class: "dot" });
  private feedback = h("span", { class: "credential-feedback", role: "status" });

  constructor(
    private key: string,
    label: string,
    private placeholder: string,
    secret: boolean,
    saved: boolean,
    private changed: (saved: boolean) => void = () => {},
    saveLabel = "Save",
  ) {
    const id = "credential-" + key;
    this.input = h("input", {
      id, type: secret ? "password" : "text", autocomplete: "off",
      spellcheck: "false", autocapitalize: "none", "aria-label": label,
    });
    this.save = h("button", { type: "button", text: saveLabel, "aria-label": "Save " + label });
    this.remove = h("button", { class: "danger", type: "button", text: "Remove", "aria-label": "Remove " + label });
    this.confirmRemoval = h("button", { class: "danger confirm-credential-removal", type: "button", text: "Remove key", "aria-label": "Confirm removal of " + label });
    const cancelRemoval = h("button", { type: "button", text: "Cancel", onclick: () => {
      this.closeRemoval();
      this.remove.focus();
    } });
    this.removalPanel = h("div", { class: "danger-zone credential-removal", hidden: true, inert: true, role: "group", "aria-labelledby": id + "-removal" },
      h("h3", { id: id + "-removal", text: "Danger zone" }),
      h("p", { class: "hint", text: `Remove ${label} from Windows Credential Manager? You can add it again later.` }),
      h("div", { class: "row" }, cancelRemoval, this.confirmRemoval));
    this.el = h("div", { class: "credential-field", "data-credential": key },
      h("div", { class: "row" }, h("label", { for: id, text: label }),
        this.input, this.save, this.remove, this.dot), this.feedback, this.removalPanel);
    this.update(saved);
    this.save.addEventListener("click", () => void this.write(false), { signal: this.lifetime.signal });
    this.remove.addEventListener("click", () => {
      this.clearInput();
      this.removalPanel.hidden = false;
      this.removalPanel.inert = false;
      cancelRemoval.focus();
    }, { signal: this.lifetime.signal });
    this.confirmRemoval.addEventListener("click", () => void this.write(true), { signal: this.lifetime.signal });
    this.removalPanel.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.closeRemoval();
      this.remove.focus();
    }, { signal: this.lifetime.signal });
  }

  update(saved: boolean): void {
    this.remove.hidden = !saved;
    this.input.placeholder = saved ? "••••••••  (stored)" : this.placeholder;
    this.dot.style.background = saved ? "#22c55e" : "#f4505e";
    if (!saved) this.closeRemoval();
    this.changed(saved);
  }

  clearInput(): void { this.input.value = ""; }

  private closeRemoval(): void {
    this.removalPanel.hidden = true;
    this.removalPanel.inert = true;
  }

  private async write(remove: boolean): Promise<void> {
    if (this.save.disabled || !this.lifetime.active) return;
    const value = this.input.value.trim();
    if (!remove && !value) return;
    // Clear before IPC so failed writes cannot leave keys in hidden form fields.
    this.clearInput();
    this.save.disabled = this.remove.disabled = this.confirmRemoval.disabled = this.input.disabled = true;
    this.feedback.textContent = "";
    try {
      if (remove) await Bridge.secretClear(this.key);
      else await Bridge.secretSet(this.key, value);
      if (!this.lifetime.active) return;
      this.update(!remove);
      this.feedback.textContent = remove ? "Removed from Windows Credential Manager." : "Saved in Windows Credential Manager.";
    } catch (error) {
      if (this.lifetime.active) {
        const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
        this.feedback.textContent = !remove && VALIDATION_ERRORS.has(message) ? message
          : remove ? "Could not remove this credential. Try again." : "Could not save. Check the value and try again.";
      }
    } finally {
      if (this.lifetime.active) {
        this.save.disabled = this.remove.disabled = this.confirmRemoval.disabled = this.input.disabled = false;
        if (remove && this.remove.hidden) this.save.focus();
      }
    }
  }

  destroy(): void {
    this.clearInput();
    this.closeRemoval();
    this.lifetime.destroy();
  }
}
