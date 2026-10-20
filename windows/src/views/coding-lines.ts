// SPDX-License-Identifier: MIT
import { h } from "./dom";
import { codeTokens } from "../core/code-tokens";
import { PREVIEW_LINES, type CodingPreview } from "../core/coding-activity";

export function codeRow() {
  const number = h("span", { class: "coding-line-number", "aria-hidden": "true" });
  const sign = h("span", { class: "coding-line-sign", "aria-hidden": "true", hidden: true });
  const text = h("span", { class: "coding-line-text" });
  return { number, sign, text, key: "", el: h("div", { class: "coding-line" }, number, sign, text) };
}

/** The live editor and edit summary share the same source gutter and syntax renderer. */
export function syncCodeRows(host: HTMLElement, rows: ReturnType<typeof codeRow>[], preview: CodingPreview,
  options: { message?: boolean; terminal?: boolean } = {}): number {
  const numbered = !options.message && !options.terminal;
  const sourceNumbers = !!preview.startLine || !!preview.lineNumbers?.some(number => number != null);
  host.dataset.numbered = String(numbered);
  host.dataset.numbering = sourceNumbers ? "source" : "preview";
  host.dataset.diff = String(!!preview.kinds?.some(kind => kind !== "context"));
  const count = Math.min(PREVIEW_LINES, preview.lines.length);
  const numbers = preview.lines.slice(0, count).map((_, index) => preview.lineNumbers?.[index]
    ?? (preview.startLine ? preview.startLine + index : index + 1));
  host.style.setProperty("--code-gutter", `${Math.max(sourceNumbers ? 3 : 2, ...numbers.map(number => String(number).length))}ch`);
  while (rows.length < count) { const row = codeRow(); rows.push(row); host.append(row.el); }
  let fresh = 0;
  let latest: HTMLElement | null = null;
  rows.forEach((row, index) => {
    row.el.hidden = index >= count;
    const source = preview.lineNumbers ? preview.lineNumbers[index] : preview.startLine ? preview.startLine + index : null;
    row.number.textContent = numbered && source != null ? String(source) : "";
    row.number.title = source != null ? "File line " + row.number.textContent : "Source line not reported";
    row.number.hidden = !numbered;
    const text = preview.lines[index] ?? "";
    row.el.dataset.command = String(!!options.terminal && index === 0 && text.startsWith("$ "));
    const kind = preview.kinds?.[index] ?? "context";
    row.el.dataset.kind = kind;
    row.sign.hidden = kind === "context";
    row.sign.textContent = kind === "added" ? "+" : kind === "removed" ? "−" : "";
    const key = JSON.stringify([text, options.terminal, options.message]);
    if (row.key !== key) {
      row.key = key;
      const tokens = options.message ? [{ text, kind: undefined }] : codeTokens(text, options.terminal);
      // Only an actual leading PASS/FAIL from command output earns a result badge.
      const result = options.terminal && /^\s*(?:PASS|FAIL)(?=\s|$)/.test(text)
        ? tokens.find(token => token.text.trim()) : undefined;
      row.text.replaceChildren(...tokens.map(token => token.kind
        ? h("span", { class: "code-token", "data-token": token.kind,
          ...(token === result ? { "data-result": token.text.toLowerCase() } : {}), text: token.text })
        : document.createTextNode(token.text)));
      if (index < count) {
        // Changed lines type out one after another; alternating names restart the CSS animation.
        row.el.style.setProperty("--chars", String(Math.max(1, Math.min(text.length, 120))));
        row.el.style.setProperty("--type-delay", Math.min(fresh++ * 70, 1400) + "ms");
        row.el.dataset.type = row.el.dataset.type === "a" ? "b" : "a";
        latest = row.el;
      }
    }
    row.text.title = text;
  });
  // Follow the newest line like a terminal tail.
  if (latest) {
    const below = (latest as HTMLElement).getBoundingClientRect().bottom - host.getBoundingClientRect().bottom;
    if (below > 0) host.scrollBy({ top: below + 8, behavior: "smooth" });
  }
  return count;
}
