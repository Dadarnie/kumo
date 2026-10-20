// SPDX-License-Identifier: MIT
import { State, type AgentTask } from "../core/state";
import { codingLabel, codingProvider } from "../core/coding";
import { compactCodingProgress, CODING_QUIET_AFTER_MS } from "../core/coding-progress";
import { mediaStore } from "../core/media-store";
import { ownsContent } from "../core/sections";
import { h } from "../views/dom";
import { icon, ICONS } from "../views/icons";
import { MediaEqualizer } from "./equalizer";
import { createMiniBot, pruneMiniBots } from "../mimo/minibots";
import { Lifetime } from "../core/lifetime";
import { prefersReducedMotion } from "../core/motion";

/** Music, real activity and idle status share one intentional compact region. */
export class ActivityStrip {
  private equalizer = new MediaEqualizer();
  private label = h("span", { class: "activity-label" });
  private time = h("time", { class: "activity-time" });
  private integrations = h("span", {
    class: "activity-integrations",
    role: "group",
  });
  private integrationKey = "";
  private art = h("img", {
    class: "activity-art",
    alt: "",
    draggable: "false",
  });
  private notice = icon(ICONS.bubble, 16);
  private progress = h("span", { class: "activity-progress" });
  private workTitle = h("strong", { class: "activity-work-title", role: "status", "aria-live": "polite" });
  private workDetail = h("span", { class: "activity-work-detail" });
  private workCopy = h("span", { class: "activity-work-copy", hidden: true }, this.workTitle, this.workDetail);
  private workMetric = h("span", { class: "activity-work-metric" });
  private added = h("span", { class: "activity-work-added" });
  private removed = h("span", { class: "activity-work-removed" });
  private changes = h("span", { class: "activity-work-changes" }, this.added, this.removed);
  private indicator = h("span", { class: "activity-work-indicator", "aria-hidden": "true" },
    ...[0, 1, 2].map(() => h("i")));
  private review = h("button", { class: "activity-review", type: "button", text: "Review", hidden: true });
  /** Approvals are answered right in the pill; questions still open the full view. */
  private deny = h("button", { class: "activity-decide activity-deny", type: "button", text: "Deny", hidden: true });
  private allow = h("button", { class: "activity-decide activity-allow", type: "button", text: "Allow", hidden: true });
  /** Fills as the agent moves through its steps; colored by state. */
  private ring = h("span", { class: "activity-work-ring", "aria-hidden": "true" });
  private stopped = h("span", { class: "activity-work-stopped", hidden: true, "aria-hidden": "true" }, icon(ICONS.pause, 12));
  private workStatus = h("span", { class: "activity-work-status", hidden: true },
    this.workMetric, this.changes, this.ring, this.indicator, this.stopped, this.review, this.deny, this.allow);
  readonly el = h(
    "div",
    { class: "activity-strip", "aria-hidden": "true" },
    this.equalizer.el,
    this.notice,
    this.label,
    this.time,
    this.art,
    this.integrations,
    this.progress,
    this.workCopy,
    this.workStatus,
  );
  private clock: ReturnType<typeof setTimeout> | undefined;
  private key = "";
  private lifetime = new Lifetime();
  private controlsHeld = false;
  constructor(onReview: (task: AgentTask) => void, onDecide: (decision: "allow" | "deny") => void) {
    for (const [button, decision] of [[this.allow, "allow"], [this.deny, "deny"]] as const)
      button.addEventListener("click", event => { event.stopPropagation(); onDecide(decision); }, { signal: this.lifetime.signal });
    document.addEventListener("visibilitychange", () => this.sync(this.controlsHeld),
      { signal: this.lifetime.signal });
    this.review.addEventListener("click", event => {
      event.stopPropagation();
      const task = this.codingTask;
      if (task) onReview(task);
    }, { signal: this.lifetime.signal });
  }
  get visible(): boolean {
    return this.el.classList.contains("is-visible");
  }
  get clickOnly(): boolean {
    // Quiet work and in-pill approvals open only on click, so reaching for Allow never expands.
    return this.visible && this.el.dataset.kind === "coding" && (this.el.dataset.state === "quiet" || !this.allow.hidden);
  }
  get codingTask(): AgentTask | null {
    if (!State.settings.modules.vscode) return null;
    const approval = State.pendingApproval;
    const task = approval?.taskId ? State.tasks.find(task => task.id === approval.taskId) : State.codingTask;
    return task && codingProvider(task) && (["working", "thinking", "searching", "approval", "question", "ratelimit", "error", "finished"].includes(task.state)
      || task.state === "idle" && !!task.pillBadge && !!(task.activity?.completed || task.activity?.stopped || task.activity?.phase === "failed"))
      ? task : null;
  }
  reviewHit(x: number, y: number, margin = 0): boolean {
    if (!this.visible || this.el.dataset.kind !== "coding") return false;
    return [this.review, this.deny, this.allow].some(button => {
      if (button.hidden) return false;
      const rect = button.getBoundingClientRect();
      return x >= rect.left - margin && x <= rect.right + margin && y >= rect.top - margin && y <= rect.bottom + margin;
    });
  }

  sync(controlsHeld = this.controlsHeld): void {
    if (!this.lifetime.active) return;
    this.controlsHeld = controlsHeld;
    if (document.hidden) {
      clearTimeout(this.clock);
      this.clock = undefined;
      this.equalizer.setVisible(false);
      return;
    }
    // The lip shows only the time (CSS); the island shows the full strip.
    const baseline = (State.visibility === "island" || State.visibility === "peek") && !ownsContent(State.view);
    const media = mediaStore.snapshot();
    const hasMedia =
      State.settings.modules.media &&
      media.state.providerStatus === "ready" &&
      ["playing", "paused"].includes(media.state.playbackState);
    const task = State.tasks.find(
      (task) =>
        task.pillBadge ||
        [
          "working",
          "thinking",
          "searching",
          "approval",
          "question",
          "error",
        ].includes(task.state),
    );
    const coding = this.codingTask;
    const upload = State.view === "uploading" && State.uploadProgress < 1;
    const activity = State.pendingApproval
      ? "Approval needed"
      : upload
        ? "Uploading"
        : coding
          ? compactCodingProgress(coding, State.paused).title
          : task
          ? `${task.name} · ${task.pillBadge ?? task.state}`
          : "";
    // One thing at a time, by priority: agent work (incl. approvals) > other
    // agent notices > music > clock. No rotation between them.
    const music = baseline && hasMedia && !controlsHeld;
    const idle = baseline && !hasMedia;
    const notice = !coding && !!task && !upload ? activity : "";
    const shown = coding || upload ? activity : notice && !hasMedia ? notice : "";
    const visible = baseline;
    const kind = coding ? "coding"
      : shown ? "notice"
      : music ? media.state.playbackState === "playing" ? "music" : "transport"
      : idle ? "idle" : "transport";
    this.el.classList.toggle("is-visible", visible);
    this.el.setAttribute("aria-hidden", String(!visible));
    const presentationChanged = this.el.dataset.kind !== kind;
    this.el.dataset.kind = kind;
    this.el.dataset.activity = shown ? "active" : "clock";
    clearTimeout(this.clock);
    const key = `${visible}|${shown}|${kind}`;
    if (
      key !== this.key &&
      visible &&
      !prefersReducedMotion()
    )
      this.el.animate(
        [
          { opacity: 0, transform: "translateY(-4px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 180, easing: "ease-out" },
      );
    this.key = key;
    if (this.el.parentElement) {
      this.el.parentElement.dataset.notification = String(kind === "notice");
      this.el.parentElement.dataset.activityKind = kind;
    }
    this.notice.style.display = shown && kind !== "coding" ? "" : "none";
    this.label.textContent = kind === "coding" ? "" : shown;
    this.label.hidden = !shown || kind === "coding";
    // The lip always shows the clock; the island swaps it for coding status.
    const lip = State.visibility === "peek";
    // Clock only when nothing else needs the space (always in the lip).
    this.time.hidden = (!lip && kind !== "idle") || !State.settings.clockEnabled;
    this.syncWork(kind === "coding" ? coding : null);
    this.progress.hidden = !upload || !visible;
    this.progress.style.setProperty(
      "--activity-progress",
      `${Math.max(0, Math.min(1, State.uploadProgress)) * 100}%`,
    );
    this.equalizer.el.hidden = kind !== "music";
    this.equalizer.setVisible(kind === "music");
    const art = kind === "music" && /^blob:/.test(media.player.artwork?.dataUrl ?? "")
      ? media.player.artwork!.dataUrl : null;
    this.art.hidden = !art;
    if (art && this.art.getAttribute("src") !== art) this.art.src = art;
    if (!art) this.art.removeAttribute("src");
    // Rotation changes the mascot and media presentation as well as this strip.
    if (presentationChanged) State.notify();
    // Mini Mimos live in the expanded Home; the compact island stays calm.
    this.syncIntegrations(false);
    if (visible) this.tick();
    else if (State.visibility === "expanded" && ["overview", "integrations"].includes(State.view) && !State.paused) {
      // Reuse the strip clock for one silence deadline while Home's mini Mimos are visible.
      const now = Date.now();
      let deadline = Infinity;
      for (const task of State.tasks) if (codingProvider(task) && Number.isFinite(task.lastEventAt)
        && ["working", "thinking", "searching"].includes(task.state) && task.activity?.phase !== "failed") {
        const next = task.lastEventAt! + CODING_QUIET_AFTER_MS;
        if (next > now) deadline = Math.min(deadline, next);
      }
      if (Number.isFinite(deadline)) this.clock = setTimeout(() => State.notify(), deadline - now);
    }
  }

  private syncWork(task: AgentTask | null): void {
    this.workCopy.hidden = this.workStatus.hidden = !task;
    this.review.hidden = !task;
    if (!task) { this.deny.hidden = this.allow.hidden = true; return; }
    const work = compactCodingProgress(task, State.paused);
    this.el.dataset.state = work.state;
    if (this.workTitle.textContent !== work.title) this.workTitle.textContent = work.title;
    this.workDetail.textContent = work.detail;
    this.workDetail.title = work.detail;
    this.workDetail.dataset.code = String(work.code);
    this.workMetric.textContent = work.metric;
    this.workMetric.hidden = !work.metric && !work.timed;
    this.changes.hidden = !work.changes;
    this.added.textContent = work.changes ? "+" + work.changes.added : "";
    this.removed.textContent = work.changes ? "−" + work.changes.removed : "";
    this.indicator.dataset.kind = work.indicator;
    this.indicator.hidden = work.indicator === "none";
    this.stopped.hidden = work.state !== "stopped";
    const steps = task.steps.length;
    const progress = work.state === "complete" ? 1 : steps ? Math.min(0.9, (task.stepIndex + 1) / (steps + 1)) : 0.25;
    this.ring.style.setProperty("--p", String(progress));
    this.ring.dataset.state = task.state === "approval" || task.state === "question" ? "attention" : work.state;
    this.ring.hidden = work.state === "stopped" || work.state === "idle" || (task.state === "approval" && !!State.pendingApproval && !State.pendingApproval.questions);
    const deciding = task.state === "approval" && !!State.pendingApproval && !State.pendingApproval.questions;
    this.deny.hidden = this.allow.hidden = !deciding;
    this.review.hidden = !work.review || deciding;
    this.review.dataset.urgent = String(task.state === "approval" || task.state === "question");
    this.review.setAttribute("aria-label", `Review ${work.title.toLowerCase()} · ${codingLabel(task)}`);
  }

  private syncIntegrations(show: boolean): void {
    if (!show) {
      this.integrations.hidden = true;
      this.integrations.replaceChildren();
      this.integrationKey = "";
      pruneMiniBots();
      return;
    }
    const enabled = State.tasks.filter(
      (task) =>
        task.isIntegration &&
        (task.id === "integration_claude"
          ? State.settings.modules.vscode
          : State.settings.modules.developerIntegrations &&
            State.settings.activeIntegrations.includes(task.id)),
    );
    const key = enabled.map((task) => task.id).join("|");
    if (key !== this.integrationKey) {
      this.integrationKey = key;
      this.integrations.setAttribute(
        "aria-label",
        `Enabled integrations: ${enabled.map((task) => task.name).join(", ")}`,
      );
      this.integrations.replaceChildren(
        ...enabled.slice(0, 4).map((task) => {
          const mark = createMiniBot(task, 13, true);
          mark.dataset.integration = task.id;
          mark.setAttribute("role", "img");
          mark.setAttribute("aria-label", task.name);
          mark.title = task.name;
          return mark;
        }),
      );
      pruneMiniBots();
    }
    this.integrations.hidden = !show || !enabled.length;
  }

  private tick(): void {
    if (!this.lifetime.active || document.hidden || !this.visible) return;
    if (this.el.dataset.kind === "coding" && State.visibility !== "peek") {
      const task = this.codingTask;
      const work = task && compactCodingProgress(task, State.paused);
      if (work && this.el.dataset.state !== work.state) { this.sync(); State.notify(); return; }
      if (task && work?.timed && Number.isFinite(task.activity?.startedAt)) {
        const seconds = Math.max(0, Math.floor((Date.now() - task.activity!.startedAt!) / 1000));
        this.workMetric.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
        this.clock = setTimeout(() => this.tick(), 1000 - Date.now() % 1000);
      } else {
        this.workMetric.hidden = !work?.metric;
        if (task && work?.state === "active" && Number.isFinite(task.lastEventAt))
          this.clock = setTimeout(() => { this.sync(); State.notify(); }, Math.max(1, task.lastEventAt! + CODING_QUIET_AFTER_MS - Date.now()));
      }
      return;
    }
    if (this.time.hidden) return;
    const now = new Date();
    this.time.dateTime = now.toISOString();
    const parts = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).formatToParts(now);
    this.time.replaceChildren(
      h("span", { text: parts.filter(part => part.type !== "dayPeriod").map(part => part.value).join("").trim() }),
      ...parts.filter(part => part.type === "dayPeriod").map(part => h("small", { text: part.value })),
    );
    this.time.title = now.toLocaleDateString(undefined, { dateStyle: "full" });
    this.clock = setTimeout(
      () => this.tick(),
      60000 - now.getSeconds() * 1000 - now.getMilliseconds(),
    );
  }
  destroy(): void {
    this.lifetime.destroy();
    clearTimeout(this.clock);
    this.equalizer.destroy();
    this.art.removeAttribute("src");
  }
}
