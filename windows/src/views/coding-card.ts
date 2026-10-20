// SPDX-License-Identifier: MIT
import { h } from "./dom";
import { backAction } from "../core/navigation-sound";
import { Sound } from "../core/sound";
import { prefersReducedMotion } from "../core/motion";
import { icon, ICONS } from "./icons";
import { codingLabel, codingProvider } from "../core/coding";
import { codingTarget, PREVIEW_LINES, type CodingPreview, type CodingActivity } from "../core/coding-activity";
import { codingProgress, codingQuiet, compactCodingProgress } from "../core/coding-progress";
import { codeRow, syncCodeRows } from "./coding-lines";
import { CodingEdits } from "./coding-edits";
import { CODING_ICONS, setCodingIdentity } from "./coding-icons";
import { testResultsFromLines } from "../core/test-results";
import { HOME_WORKSPACE_HEIGHT, CODING_PREVIEW_CARD_HEIGHT } from "../core/design";
import { EXPANDED_W, WIDE_W } from "../core/layout";
import type { AgentTask } from "../core/state";
import "./coding-card.css";

/** White activity arcs settle into the reference's filled green check badges. */
function activityIndicator(path: string, size: number) {
  const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ring.setAttribute("viewBox", "0 0 24 24");
  ring.setAttribute("class", "coding-ring");
  ring.setAttribute("fill", "none");
  ring.setAttribute("aria-hidden", "true");
  ring.setAttribute("focusable", "false");
  for (const className of ["coding-ring-track", "coding-ring-arc"]) {
    const circle = document.createElementNS(ring.namespaceURI, "circle");
    for (const [key, value] of Object.entries({ cx: "12", cy: "12", r: "8.7", stroke: "currentColor",
      "stroke-width": "2.4", "stroke-linecap": "round", class: className })) circle.setAttribute(key, value);
    ring.append(circle);
  }
  const check = document.createElementNS(ring.namespaceURI, "path");
  for (const [key, value] of Object.entries({ d: "M7.8 12.2 10.7 15.1 16.4 9.1", class: "coding-ring-check",
    fill: "none", "stroke-width": "2.8", "stroke-linecap": "round", "stroke-linejoin": "round" })) check.setAttribute(key, value);
  ring.append(check);
  const glyph = icon(path, Math.max(14, size - 2));
  const el = h("span", { class: "coding-indicator", "data-state": "inactive", "aria-hidden": "true" }, ring, glyph);
  el.style.setProperty("--coding-ring-size", size + "px");
  return { el, glyph };
}

/** Three compact work lines open the retained, bounded live terminal. */
export class CodingCard {
  readonly context = h("div", { class: "coding-home-context", hidden: true });
  private project = h("span", { class: "coding-project" });
  private workspace = h("span", { class: "coding-workspace" });
  private counter = h("span", { class: "coding-count", title: "Recorded activity" });
  private provider = h("span", { class: "coding-provider" });
  private providerSlot = h("div", { class: "coding-provider-slot" }, this.provider);
  private added = h("span", { class: "coding-added" });
  private removed = h("span", { class: "coding-removed" });
  private changes = h("span", { class: "coding-changes", hidden: true }, this.added, this.removed);
  private expandIcon = icon(ICONS.chevronLeft, 12);
  private expand = h("button", { class: "coding-expand", type: "button",
    "aria-label": "Back to Home", "aria-expanded": "true",
    onclick: backAction(() => this.togglePreview()) }, this.expandIcon);
  private actionIcon = icon(ICONS.doc, 16);
  private action = h("span", { class: "coding-action" });
  private target = h("span", { class: "coding-target" });
  private actionCopy = h("span", { class: "coding-action-copy" }, this.action, this.target);
  private startIcon = icon(ICONS.monitor, 16);
  private startLabel = h("span", { class: "coding-start-label", text: "Start working…" });
  private startRow = h("div", { class: "coding-start-row" }, this.startIcon, this.startLabel);
  private summary = h("span", { class: "coding-summary" });
  private summaryIcon = icon(ICONS.stack, 16);
  private actionViewport = h("div", { class: "coding-action-viewport" });
  private trigger = h("div", { class: "coding-preview-trigger", role: "button", tabindex: "0",
    "aria-label": "Open coding activity", "aria-expanded": "false" }, this.actionViewport);
  private compactControls = h("div", { class: "coding-compact-controls" }, this.summaryIcon, this.summary);
  private rows = Array.from({ length: 3 }, codeRow);
  private preview = h("div", { class: "coding-preview coding-live-preview", tabindex: "0", role: "region",
    "aria-label": "Live code preview", hidden: true },
    ...this.rows.map(row => row.el));
  private heading: HTMLElement;
  private actionRow: HTMLElement;
  private sidebar = h("div", { class: "coding-sidebar" });
  private fileName = h("span", { class: "coding-file-name" });
  private liveMark = h("span", { class: "coding-live-mark", "aria-hidden": "true" });
  private fileIcon = h("span", { class: "coding-file-icon", "aria-hidden": "true" });
  private filePath = h("span", { class: "coding-file-path" });
  private fileTab = h("div", { class: "coding-file-tab" }, this.fileIcon, this.fileName, this.liveMark);
  private editorTitle = h("div", { class: "coding-editor-title" }, this.fileTab);
  private editorDetails = h("div", { class: "coding-editor-details" }, this.editorTitle, this.filePath);
  private editorActions = h("div", { class: "coding-editor-actions" });
  private copyIcon = icon(ICONS.copy, 14);
  private copyOutput = h("button", { class: "coding-output-button coding-output-copy", type: "button",
    title: "Copy output", "aria-label": "Copy output", onclick: () => { void this.copyRenderedOutput(); } }, this.copyIcon);
  private editorHeader = h("div", { class: "coding-editor-header" }, this.editorDetails);
  private footerCount = h("span", { class: "coding-footer-count", role: "status", "aria-live": "polite", hidden: true });
  private footerMeta = h("div", { class: "coding-footer-meta" }, this.footerCount);
  private editorFooter = h("div", { class: "coding-editor-footer" }, this.footerMeta, this.editorActions);
  private editorContent = h("div", { class: "coding-editor-content" });
  private runRows: ReturnType<typeof codeRow>[] = [];
  private runOutput = h("div", { class: "coding-preview coding-run-output", tabindex: "0", role: "region", "aria-label": "Command output", "data-kind": "terminal" });
  private testCases = h("div", { class: "coding-test-cases", role: "region", "aria-label": "Reported test results", hidden: true });
  private tokenUsage = h("div", { class: "coding-test-metric coding-test-usage", hidden: true });
  private runRegion = h("section", { class: "coding-run-region", "aria-label": "Terminal", hidden: true }, this.runOutput, this.testCases);
  private editsSummary = h("button", { class: "coding-result-button", type: "button", hidden: true,
    onclick: () => { this.edits.reveal(); this.edits.el.focus({ preventScroll: true }); } });
  private editor = h("div", { class: "coding-editor" });
  private currentIndicator = activityIndicator(ICONS.doc, 20);
  private currentLabel = h("span", { class: "coding-current-label" });
  private currentTarget = h("span", { class: "coding-current-target" });
  private currentHint = h("span", { class: "coding-current-hint" });
  private currentCount = h("span", { class: "coding-current-count", hidden: true });
  private currentCopy = h("div", { class: "coding-current-copy" },
    h("div", { class: "coding-current-heading" }, this.currentLabel, this.currentTarget),
    h("div", { class: "coding-current-meta" }, this.currentHint, this.currentCount));
  private current = h("div", { class: "coding-current", role: "status", "aria-live": "polite", "aria-atomic": "true" },
    this.currentIndicator.el, this.currentCopy);
  private stages = [
    ["Read", CODING_ICONS.read], ["Edit", CODING_ICONS.edit], ["Run", CODING_ICONS.bash], ["Done", CODING_ICONS.done],
  ].map(([name, path]) => {
    const indicator = activityIndicator(path, 20);
    const label = h("span", { text: name === "Run" ? "Bash" : name });
    const count = h("span", { class: "coding-stage-count", hidden: true });
    const el = h("div", { class: "coding-stage", role: "listitem", "data-stage": name, "data-state": "inactive" },
      indicator.el, label, count);
    return { name, path, indicator, label, count, el };
  });
  private stageList = h("div", { class: "coding-stages", role: "list", "aria-label": "Session activity" },
    ...this.stages.map(stage => stage.el));
  private expanded = false;
  private edits = new CodingEdits();
  private editCount = 0;
  private hasChanges = false;
  private liveFile = { name: "", path: "", title: "", icon: ICONS.doc as string };
  private lineCount = 0;
  private outputText = "";
  private latestOutput: { preview: CodingPreview; message: boolean; terminal: boolean } | null = null;
  private sourceOutput: typeof this.latestOutput = null;
  private sourceFile: typeof this.liveFile | null = null;
  private lastRun: CodingActivity["lastRun"];
  private resultKey = "";
  private sourceTask = "";
  private actionKey = "";
  private lastOperation: { task: string; label: string; icon: string; identity: string } | null = null;
  private previousOperation: { label: string; icon: string } | null = null;
  private outgoing: HTMLElement | null = null;
  readonly el: HTMLElement;

  constructor(_open: () => void, private reflow: () => void = () => {}, private returnHome: () => void = () => {}) {
    this.heading = h("div", { class: "coding-heading" }, this.project, this.providerSlot, this.workspace, this.counter);
    this.actionRow = h("div", { class: "coding-action-row", role: "status", "aria-live": "polite" },
      this.actionIcon, this.actionCopy, this.changes);
    this.actionViewport.append(this.actionRow);
    this.trigger.prepend(this.startRow);
    this.trigger.append(this.compactControls);
    this.context.append(this.heading);
    this.el = h("div", { class: "coding-card" },
      this.trigger, this.preview);
    this.trigger.addEventListener("click", () => { Sound.play("open"); this.togglePreview(); });
    this.el.addEventListener("keydown", event => {
      if (event.target === this.trigger && !this.expanded && ["Enter", " "].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); Sound.play("open"); this.togglePreview();
      } else if (event.key === "Escape" && this.expanded) {
        event.preventDefault(); event.stopPropagation(); this.togglePreview(); this.trigger.focus();
      }
    });
  }

  get previewExpanded(): boolean { return this.expanded; }
  showPreview(): void { if (!this.expanded) this.togglePreview(); }
  setDocumentHidden(hidden: boolean): void {
    this.el.dataset.pageHidden = String(hidden);
    if (hidden) this.clearTransition();
  }

  /** Both modes have deliberate bounds; incoming hook content never resizes them. */
  requiredHeight(): number {
    // The big panel fits its lines (18px each plus header and footer chrome), up to its maximum.
    return this.expanded
      ? Math.min(CODING_PREVIEW_CARD_HEIGHT, Math.max(290, 104 + this.lineCount * 18))
      : HOME_WORKSPACE_HEIGHT;
  }

  /** Wide enough for the longest line (sidebar + gutter + ~6.7px per mono character). */
  requiredWidth(): number {
    if (!this.expanded) return EXPANDED_W;
    const longest = Math.max(0, ...this.outputText.split("\n").map(line => line.length));
    return Math.round(Math.min(WIDE_W, Math.max(EXPANDED_W, 190 + longest * 6.7)));
  }

  destroy(): void { this.el.dataset.visible = "false"; this.clearTransition(); }

  setVisible(visible: boolean): void {
    this.el.dataset.visible = String(visible);
    this.context.hidden = !visible || this.expanded || !this.providerSlot.querySelector(".coding-session-picker");
    if (!visible) this.clearTransition();
    if (!visible && this.expanded) { this.expanded = false; this.syncExpansion(); }
  }

  private togglePreview(): void {
    this.clearTransition();
    const returningHome = this.expanded;
    const returnFocus = this.expanded && this.el.contains(document.activeElement);
    const enterWithFocus = !this.expanded && this.trigger === document.activeElement;
    this.expanded = !this.expanded;
    this.preview.scrollTop = 0;
    this.edits.el.scrollTop = 0;
    this.syncExpansion();
    if (returnFocus) this.trigger.focus({ preventScroll: true });
    else if (enterWithFocus) (this.editCount ? this.edits.el : this.preview).focus({ preventScroll: true });
    if (returningHome) this.returnHome();
    this.reflow();
  }

  private syncExpansion(): void {
    if (this.el.dataset.expanded !== String(this.expanded)) {
      const focused = document.activeElement as HTMLElement | null;
      const restoreFocus = !!focused && this.el.contains(focused);
      if (this.expanded) {
        this.sidebar.replaceChildren(this.heading, this.stageList);
        this.footerMeta.prepend(this.changes);
        this.editorHeader.prepend(this.expand);
        this.editorActions.append(this.editsSummary, this.copyOutput);
        this.editorContent.append(this.edits.el, this.preview, this.runRegion);
        this.editor.append(this.editorHeader, this.current, this.editorContent, this.editorFooter);
        this.el.replaceChildren(this.sidebar, this.editor);
      } else {
        this.context.append(this.heading);
        this.actionRow.append(this.changes);
        this.renderOutput();
        this.el.replaceChildren(this.trigger, this.preview);
      }
      if (restoreFocus) focused?.focus({ preventScroll: true });
    }
    this.el.dataset.expanded = String(this.expanded);
    this.context.hidden = this.expanded || this.el.dataset.visible !== "true" || !this.providerSlot.querySelector(".coding-session-picker");
    this.expand.title = "Back to Home";
    this.expand.setAttribute("aria-label", this.expand.title);
    this.expand.setAttribute("aria-expanded", String(this.expanded));
    this.syncEditorView();
    this.trigger.setAttribute("aria-expanded", String(this.expanded));
    this.rows.forEach((row, i) => { row.el.hidden = i >= this.lineCount; });
  }

  private syncEditorView(): void {
    const edits = this.editCount > 0;
    this.preview.hidden = !this.expanded || edits || (!!this.lastRun && !this.sourceOutput);
    this.edits.el.hidden = !this.expanded || !edits;
    const showRun = !!this.lastRun;
    this.runRegion.hidden = !this.expanded || !showRun;
    this.editorContent.dataset.combined = String(showRun && (edits || !!this.sourceOutput));
    this.current.hidden = true;
    this.changes.hidden = !this.hasChanges;
    this.copyOutput.hidden = !this.expanded;
    this.liveMark.hidden = !this.lastRun || this.lastRun.phase !== "running";
    const source = this.sourceFile ?? this.liveFile;
    this.fileName.textContent = source.name;
    this.filePath.textContent = edits ? "Edits" : source.path;
    this.filePath.title = source.title;
    setCodingIdentity(this.fileIcon, source.title, source.icon, 14, source.icon === ICONS.terminal);
    this.renderOutput();
  }

  private renderOutput(): void {
    const output = this.expanded ? this.sourceOutput ?? this.latestOutput : this.latestOutput;
    if (!output) return;
    const { preview, message, terminal } = output;
    this.preview.dataset.kind = message ? "message" : terminal ? "terminal" : "code";
    const nextText = preview.lines.join("\n");
    if (nextText !== this.outputText) {
      this.copyOutput.title = "Copy output";
      this.copyOutput.setAttribute("aria-label", "Copy output");
      this.copyIcon.querySelector("path")?.setAttribute("d", ICONS.copy);
    }
    this.outputText = nextText;
    this.lineCount = syncCodeRows(this.preview, this.rows, preview, { message, terminal });
  }

  private async copyRenderedOutput(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.lastRun && !this.runRegion.hidden && this.expanded
        ? [`$ ${this.lastRun.target}`, ...(this.lastRun.preview?.lines ?? [])].join("\n")
        : this.editCount && this.expanded ? this.edits.el.innerText : this.outputText);
      this.copyOutput.title = "Copied";
      this.copyOutput.setAttribute("aria-label", "Output copied");
      this.copyIcon.querySelector("path")?.setAttribute("d", ICONS.check);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(this.preview);
      const selection = window.getSelection();
      selection?.removeAllRanges(); selection?.addRange(range);
      this.copyOutput.title = "Select output to copy";
      this.copyOutput.setAttribute("aria-label", this.copyOutput.title);
    }
  }

  private clearTransition(): void {
    this.actionRow.getAnimations().forEach(animation => animation.cancel());
    this.compactControls.getAnimations().forEach(animation => animation.cancel());
    this.startRow.getAnimations().forEach(animation => animation.cancel());
    this.outgoing?.getAnimations().forEach(animation => animation.cancel());
    this.outgoing?.remove();
    this.outgoing = null;
  }

  sync(task: AgentTask, picker?: HTMLElement, animated = true): void {
    const activity = task.activity;
    if (this.sourceTask !== task.id || activity?.action === "Thinking" && !activity.completedCount && !activity.files?.length && !activity.lastRun) {
      this.sourceOutput = null; this.sourceFile = null;
      this.sourceTask = task.id;
    }
    this.lastRun = activity?.lastRun ?? (activity?.action === "Run" ? { target: activity.target,
      phase: activity.phase ?? "running", toolUseId: activity.toolUseId, preview: activity.preview } : undefined);
    const tests = this.lastRun?.tests;
    if (this.lastRun) syncCodeRows(this.runOutput, this.runRows, {
      lines: [`$ ${this.lastRun.target}`, ...(this.lastRun.preview?.lines ?? []).filter(line=>!tests || !testResultsFromLines([line]) && !/^[#ℹ]\s*duration_ms\b/i.test(line.trim()))].slice(0, PREVIEW_LINES),
    }, { terminal: true });
    const resultKey = JSON.stringify([task.id, this.lastRun?.toolUseId, this.lastRun?.target, tests]);
    if (resultKey !== this.resultKey) {
      this.resultKey = resultKey;
      const totals = h('span', {class:'coding-test-totals'});
      if (tests?.passed !== undefined) totals.append('Tests: ', h('span', {class:'coding-test-passed',text:String(tests.passed)}), ' passed');
      for (const [label, count] of [['Failed', tests?.failed], ['Skipped', tests?.skipped], ['Total', tests?.total]] as const) {
        if (count === undefined || label !== 'Total' && !count) continue;
        if (totals.childNodes.length) totals.append(', ');
        totals.append(`${label}: ${count}`);
      }
      if (!totals.childNodes.length) totals.textContent = 'Counts not reported';
      const outcome = tests?.failed ? 'failed' : tests?.passed && tests.failed === 0 ? 'passed' : 'reported';
      this.testCases.dataset.result = outcome;
      this.testCases.dataset.expanded = 'false';
      const duration = tests?.durationMs === undefined ? undefined
        : tests.durationMs < 1000 ? `${Math.round(tests.durationMs)} ms` : `${(tests.durationMs/1000).toFixed(2)} s`;
      const more = h('button', {class:'coding-test-more',type:'button',hidden:!tests?.cases.length,
        text:'Details', 'aria-expanded':'false',title:'Show all reported test names',onclick:()=>{
          const expanded=this.testCases.dataset.expanded!=='true';this.testCases.dataset.expanded=String(expanded);
          more.setAttribute('aria-expanded',String(expanded));more.textContent=expanded?'Less':'Details';
        }});
      this.testCases.replaceChildren(...(tests ? [
        h('div', {class:'coding-test-report-heading'},
          h('span', {class:'coding-test-label',text:outcome === 'passed' ? 'PASS' : outcome === 'failed' ? 'FAIL' : 'TESTS'}),
          more),
        h('div', {class:'coding-test-metric'}, totals),
        h('div', {class:'coding-test-metadata'},
          duration === undefined ? null : h('div', {class:'coding-test-metric coding-test-duration'},icon(ICONS.check,11),
            h('span', {text:`Duration: ${duration}`})), this.tokenUsage),
        ...[...tests.cases].sort((a,b)=>Number(b.status==='failed')-Number(a.status==='failed')).map(test => h("div", { class: "coding-test-case", "data-result": test.status, title:test.name },
          h("span", { class: 'coding-test-check', 'aria-label':test.status }, icon(test.status === 'passed' ? ICONS.check : ICONS.xmark, 12)),
          h("span", {class:'coding-test-name', text: `${test.kind === "suite" ? "Suite · " : ""}${test.name}` }))),
      ] : []));
      this.testCases.hidden = !tests;
    }
    const usage = task.usage;
    const tokens = usage?.promptTokens ?? usage?.responseTokens ?? usage?.sessionTokens;
    const tokenLabel = usage?.promptTokens !== undefined ? 'Prompt tokens'
      : usage?.responseTokens !== undefined ? 'Response tokens' : 'Session tokens';
    this.tokenUsage.hidden = tokens === undefined;
    this.tokenUsage.textContent = tokens === undefined ? '' : `${tokenLabel}: ${tokens.toLocaleString()}`;
    this.tokenUsage.title = 'Reported input and output tokens for the selected agent.';
    const editOperations = activity?.stageCounts?.Edit;
    this.editsSummary.hidden = !activity?.files?.length;
    this.editsSummary.textContent = editOperations ? `${editOperations} ${editOperations === 1 ? "edit" : "edits"}`
      : `${activity?.files?.length ?? 0} files`;
    this.editsSummary.title = `${activity?.files?.length ?? 0} changed files · Show edits`;
    const progress = codingProgress(task, !animated);
    const quiet = codingQuiet(task, !animated);
    const compact = compactCodingProgress(task, !animated);
    const done = progress.done;
    this.editCount = activity?.files?.length ?? 0;
    const changes = this.expanded && activity?.files?.some(file => file.changes)
      ? activity.files.reduce((sum, file) => ({ added: sum.added + (file.changes?.added ?? 0),
        removed: sum.removed + (file.changes?.removed ?? 0) }), { added: 0, removed: 0 }) : activity?.changes;
    this.hasChanges = !!changes;
    this.edits.sync(activity?.files ?? [], activity?.summary || activity?.intent || "", task.sessionCwd);
    const target = done ? activity ? codingTarget(activity, task.sessionCwd) : ""
      : activity ? codingTarget(activity, task.sessionCwd) : task.steps.at(-1) ?? "";
    const nextKey = JSON.stringify([task.id, task.state, activity?.action, activity?.toolUseId,
      target, activity?.changes, activity?.phase, quiet, activity?.stopped]);
    const transition = this.actionKey && this.actionKey !== nextKey && !this.expanded && animated
      && this.el.dataset.visible === "true" && this.el.isConnected
      && !prefersReducedMotion();
    if (this.actionKey !== nextKey) {
      this.clearTransition();
      if (transition) {
        this.outgoing = this.actionRow.cloneNode(true) as HTMLElement;
        this.outgoing.classList.add("coding-action-outgoing");
        this.outgoing.setAttribute("aria-hidden", "true");
        this.outgoing.removeAttribute("role");
        this.outgoing.removeAttribute("aria-live");
        this.outgoing.inert = true;
        this.actionViewport.append(this.outgoing);
      }
      this.actionKey = nextKey;
    }
    this.el.dataset.state = quiet ? "quiet" : progress.state === "stopped" ? "stopped" : done ? "finished" : task.state;
    this.el.dataset.animated = String(animated);
    if (!animated || prefersReducedMotion()) this.clearTransition();
    this.el.dataset.provider = codingProvider(task) ?? "claude";
    this.el.dataset.phase = activity?.phase ?? "running";
    this.el.dataset.live = String(progress.operationActive && !quiet);
    this.el.dataset.current = String(animated && ["working", "thinking", "searching"].includes(task.state)
      && activity?.phase !== "failed" && !done && !activity?.stopped);
    this.project.textContent = codingLabel(task);
    this.project.title = task.sessionCwd || task.name;
    this.workspace.textContent = task.sessionCwd?.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1)
      || (["VSCodium", "Codex", "Claude"].includes(task.name) ? "" : task.name);
    this.workspace.title = task.sessionCwd || task.name;
    this.workspace.hidden = !this.workspace.textContent || this.workspace.textContent.toLowerCase() === codingLabel(task).toLowerCase();
    this.counter.textContent = task.steps.length ? String(task.steps.length) : "";
    this.counter.title = `${task.steps.length} session updates`;
    this.counter.setAttribute("aria-label", this.counter.title);
    this.counter.hidden = !!changes;
    this.changes.hidden = !changes;
    this.added.textContent = "+" + (changes?.added ?? 0);
    this.removed.textContent = "−" + (changes?.removed ?? 0);
    this.changes.setAttribute("aria-label", `${changes?.added ?? 0} lines added, ${changes?.removed ?? 0} lines removed`);
    this.provider.textContent = done ? "Session finished" : task.state === "approval" ? "Needs you"
      : task.state === "thinking" ? "Thinking" : "Live session";
    const provider = picker ?? this.provider;
    if (this.providerSlot.firstElementChild !== provider) this.providerSlot.replaceChildren(provider);
    this.context.hidden=this.expanded||this.el.dataset.visible!=="true"||!picker;
    const failed = activity?.phase === "failed" || task.state === "error";
    const path = progress.state === "stopped" || quiet ? ICONS.pause : done || activity?.phase === "complete" ? ICONS.check : failed || task.state === "approval" ? ICONS.bang
      : activity?.action === "Run" ? ICONS.terminal : task.state === "thinking" ? ICONS.ellipsis : ICONS.doc;
    this.actionIcon.querySelector("path")?.setAttribute("d", path);
    this.action.textContent = progress.state === "stopped" ? progress.label : done ? "Done" : failed ? "Failed" : task.state === "approval" ? "Approval"
      : activity?.action || (task.state === "thinking" ? "Thinking" : "Working");
    this.target.textContent = task.state === "thinking" ? "" : target;
    this.target.title = activity?.target || target;
    const running = progress.operationActive;
    this.actionRow.dataset.running = String(running);
    const operationIdentity = JSON.stringify([task.id, activity?.action, activity?.toolUseId, target]);
    if (this.lastOperation?.task !== task.id || activity?.action === "Thinking" && !activity.completedCount) {
      this.previousOperation = this.lastOperation = null;
    }
    const observedAction = activity?.action && activity.action !== "Thinking";
    const moveBetweenRows = !!transition && !!observedAction && this.lastOperation?.task === task.id
      && this.lastOperation.identity !== operationIdentity;
    if (observedAction) {
      if (this.lastOperation && this.lastOperation.identity !== operationIdentity)
        this.previousOperation = { label: this.lastOperation.label, icon: this.lastOperation.icon };
      this.lastOperation = { task: task.id, identity: operationIdentity,
        icon: activity.action === "Run" ? ICONS.terminal : activity.action === "Edit" || activity.action === "Write" ? ICONS.edit : ICONS.doc,
        label: [activity.action, target].filter(Boolean).join(" ") };
    }
    const previous = task.state === "thinking" ? this.lastOperation : this.previousOperation;
    this.startLabel.textContent = previous?.label || "Start working…";
    this.startLabel.title = this.startLabel.textContent;
    this.startIcon.querySelector("path")?.setAttribute("d", previous?.icon || ICONS.monitor);
    this.summary.textContent = quiet ? "No recent activity · " + compact.detail : done ? activity?.summary || activity?.intent || "Session finished"
      : progress.state === "stopped" ? progress.hint : activity?.nextActions?.[0] || "Waiting for next action";
    this.summaryIcon.querySelector("path")?.setAttribute("d", done ? ICONS.check : ICONS.terminal);
    this.summary.title = this.summary.textContent;
    this.summary.hidden = !this.summary.textContent;
    this.current.dataset.state = quiet ? "quiet" : progress.state;
    this.currentIndicator.el.dataset.state = quiet ? "quiet" : progress.state;
    this.currentLabel.textContent = quiet ? compact.title : progress.label;
    this.currentTarget.textContent = progress.target;
    this.currentTarget.title = activity?.target || progress.target;
    this.currentHint.textContent = quiet ? compact.detail : progress.hint;
    this.currentHint.title = progress.hint;
    this.currentCount.textContent = progress.countLabel;
    this.currentCount.hidden = !progress.countLabel;
    this.footerCount.textContent = progress.countLabel;
    this.footerCount.hidden = !progress.countLabel;
    const currentPath = progress.state === "stopped" ? ICONS.pause : progress.state === "complete" ? ICONS.check : progress.state === "failed" ? ICONS.xmark
      : progress.state === "waiting" ? task.state === "approval" ? ICONS.bang : task.state === "ratelimit" ? ICONS.timer : ICONS.pause
      : task.state === "thinking" ? ICONS.ellipsis : progress.stage === "Edit" ? ICONS.edit
      : progress.stage === "Run" ? ICONS.terminal : ICONS.doc;
    this.currentIndicator.glyph.querySelector("path")?.setAttribute("d", currentPath);
    this.stages.forEach(stage => {
      const status = progress.stages.find(status => status.name === stage.name)!;
      stage.el.dataset.state = quiet && status.current ? "quiet" : status.state;
      stage.indicator.el.dataset.state = quiet && status.current ? "quiet" : status.state;
      stage.label.textContent = status.label;
      stage.count.textContent = String(status.count);
      stage.count.hidden = !status.count;
      stage.el.title = status.current ? `${progress.label}: ${progress.target}` : status.description;
      stage.el.setAttribute("aria-label", status.description);
      if (status.current) stage.el.setAttribute("aria-current", "step");
      else stage.el.removeAttribute("aria-current");
      stage.indicator.glyph.querySelector("path")?.setAttribute("d", status.state === "complete" ? ICONS.check
        : status.state === "failed" ? ICONS.xmark : status.state === "waiting" ? ICONS.pause : stage.path);
    });
    this.preview.setAttribute("aria-busy", String(running));
    const fileAction = ["Read", "Write", "Edit"].includes(activity?.action ?? "");
    const sessionMessage = !activity?.preview && !fileAction && activity?.action !== "Run";
    const filePlaceholder = progress.state === "waiting" ? progress.hint
      : progress.state === "failed" ? "Open VSCodium to review this action."
      : progress.active ? activity?.action === "Read" ? "Reading file…" : activity?.action === "Write" ? "Writing file…" : "Applying changes…"
      : "Open VSCodium to review this file.";
    const lines = activity?.action === "Run" && activity.target
      ? [`$ ${activity.target}`, ...(activity.preview?.lines ?? [])].slice(0, PREVIEW_LINES)
      : activity?.preview?.lines ?? [fileAction ? filePlaceholder : target];
    const message = !activity?.preview && activity?.action !== "Run";
    this.preview.dataset.kind = message ? "message" : activity?.action === "Run" ? "terminal" : "code";
    this.preview.setAttribute("aria-label", activity?.action === "Run" ? "Live terminal output" : "Live code preview");
    this.trigger.setAttribute("aria-label", activity?.action === "Run" ? "Open terminal" : "Open coding activity");
    this.liveFile = {
      name: activity?.action === "Run" ? "Terminal" : sessionMessage ? "Session" : activity?.target.split(/[\\/]/).at(-1) || "Preview",
      path: activity?.action === "Run" && activity.files?.length
        ? codingTarget({ ...activity.files.at(-1)!, action: "Edit" }, task.sessionCwd)
        : sessionMessage || activity?.action === "Run" || !activity ? "" : codingTarget(activity, task.sessionCwd),
      title: activity?.target ?? "", icon: activity?.action === "Run" ? ICONS.terminal : sessionMessage ? ICONS.bubble : ICONS.doc,
    };
    this.latestOutput = { preview: { ...activity?.preview, lines: lines.slice(0, PREVIEW_LINES) },
      message, terminal: activity?.action === "Run" };
    if (fileAction && activity?.preview) {
      this.sourceOutput = this.latestOutput;
      this.sourceFile = { ...this.liveFile };
    } else if (!this.sourceFile && activity?.files?.length) {
      const file = activity.files.at(-1)!;
      this.sourceFile = { name: file.target.split(/[\\/]/).at(-1) ?? "Edits", path: codingTarget({ ...file, action: "Edit" }, task.sessionCwd),
        title: file.target, icon: ICONS.doc };
    }
    this.renderOutput();
    this.syncExpansion();
    if (transition) {
      const options = { duration: 180, easing: "cubic-bezier(.16, 1, .3, 1)" };
      this.actionRow.animate([
        { opacity: .55, transform: "translateY(2px)" },
        { opacity: 1, transform: "none" },
      ], options);
      const outgoing = this.outgoing;
      outgoing?.animate([
        { opacity: .7, transform: "none" },
        { opacity: 0, transform: "translateY(-2px)" },
      ], options).finished.then(() => {
        outgoing.remove();
        if (this.outgoing === outgoing) this.outgoing = null;
      }).catch(() => {});
      if (moveBetweenRows) {
        this.compactControls.animate([{ opacity: .55 }, { opacity: 1 }], options);
        this.startRow.animate([{ opacity: .55 }, { opacity: 1 }], options);
      }
    }
  }
}
