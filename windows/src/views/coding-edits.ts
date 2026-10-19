// SPDX-License-Identifier: MIT
import { h } from "./dom";
import { icon, ICONS } from "./icons";
import { codingTarget, type CodingFileChange } from "../core/coding-activity";
import { codeRow, syncCodeRows } from "./coding-lines";
import { setCodingIdentity } from "./coding-icons";

function fileRow() {
  const path = h("span", { class: "coding-edit-path" });
  const added = h("span", { class: "coding-added" });
  const removed = h("span", { class: "coding-removed" });
  const changes = h("span", { class: "coding-edit-counts" }, added, removed);
  const state = icon(ICONS.edit, 12);
  const status = h("span", { class: "coding-edit-status" }, state);
  const rows: ReturnType<typeof codeRow>[] = [];
  const preview = h("div", { class: "coding-edit-preview" });
  const glyph = icon(ICONS.plus, 10);
  const label = h("span", { text: "Show details" });
  const details = h("button", { class: "coding-edit-details", type: "button", "aria-expanded": "false" }, glyph, label);
  const fileIcon = h("span", { class: "coding-file-icon", "aria-hidden": "true" });
  const el = h("div", { class: "coding-edit", role: "listitem", "data-expanded": "false" },
    h("div", { class: "coding-edit-heading" }, fileIcon, path, changes, status), preview, details);
  details.addEventListener("click", () => {
    const expanded = el.dataset.expanded !== "true";
    el.dataset.expanded = String(expanded);
    details.setAttribute("aria-expanded", String(expanded));
    label.textContent = expanded ? "Hide details" : "Show details";
    glyph.querySelector("path")?.setAttribute("d", expanded ? ICONS.minus : ICONS.plus);
  });
  return { el, path, fileIcon, added, removed, changes, state, status, preview, rows, details };
}

/** Latest edit per file in this turn, retained as new hook events arrive. */
export class CodingEdits {
  private description = h("div", { class: "coding-edits-description" });
  private list = h("div", { class: "coding-edits-files", role: "list" });
  private files = new Map<string, ReturnType<typeof fileRow>>();
  readonly el = h("div", { class: "coding-edits", tabindex: "0", role: "region", "aria-label": "File edits", hidden: true },
    this.description, this.list);

  reveal(): void {
    for (const row of this.files.values()) {
      row.el.dataset.expanded = "true";
      row.details.setAttribute("aria-expanded", "true");
      row.details.querySelector("span")!.textContent = "Hide details";
    }
  }

  sync(changes: CodingFileChange[], intent: string, cwd?: string | null): void {
    this.description.textContent = intent;
    this.description.hidden = !intent;
    const keys = new Set(changes.map(file => file.target));
    for (const [key, row] of this.files) if (!keys.has(key)) { row.el.remove(); this.files.delete(key); }
    for (const file of changes) {
      let row = this.files.get(file.target);
      if (!row) { row = fileRow(); this.files.set(file.target, row); this.list.append(row.el); }
      row.el.dataset.target = file.target;
      row.el.dataset.phase = file.phase;
      row.path.textContent = codingTarget({ ...file, action: "Edit" }, cwd);
      row.path.title = file.target;
      setCodingIdentity(row.fileIcon, file.target, ICONS.doc, 12);
      row.changes.hidden = !file.changes;
      row.added.textContent = "+" + (file.changes?.added ?? 0);
      row.removed.textContent = "−" + (file.changes?.removed ?? 0);
      row.changes.title = `Latest edit: ${file.changes?.added ?? 0} lines added, ${file.changes?.removed ?? 0} lines removed`;
      const status = file.phase === "complete" ? "Applied" : file.phase === "failed" ? "Action failed" : "Pending edit";
      row.status.title = status;
      row.status.setAttribute("aria-label", status);
      row.state.querySelector("path")?.setAttribute("d", file.phase === "complete" ? ICONS.check : file.phase === "failed" ? ICONS.bang : ICONS.edit);
      const preview = file.preview ?? { lines: ["Edit details are available in VS Code."] };
      syncCodeRows(row.preview, row.rows, preview, { message: !file.preview });
      row.details.hidden = preview.lines.length <= 4;
    }
  }
}
