// SPDX-License-Identifier: MIT
import { State, type ApprovalInfo, type MissedApproval } from "../core/state";
import { codingDefinition } from "../core/coding";
import { backAction } from "../core/navigation-sound";
import { PANEL_H, VIEW_LAYOUTS } from "../core/layout";
import { h } from "./dom";
import { icon, ICONS } from "./icons";
import type { ViewActions, ViewHost } from "./views";
import "./approval-inbox.css";

/** Unanswered requests remain reviewable after their live relay returns to the editor. */
export function buildApprovalInbox(actions: ViewActions): ViewHost {
  const list = h("div", { class: "approval-inbox-list", role: "list", tabindex: "0",
    "aria-label": "Questions, approvals and permissions" });
  const clear = h("button", { class: "approval-inbox-clear", type: "button", text: "Clear past requests",
    onclick: () => { State.missedApprovals = []; State.notify(); } });
  const back = h("button", { class: "approval-inbox-back", type: "button",
    onclick: backAction(() => actions.setView(State.defaultView())) }, icon(ICONS.chevronLeft, 12), "Back");
  const body = h("div", { class: "approval-inbox" },
    h("div", { class: "approval-inbox-heading" }, h("b", { text: "Approval" }), clear, back), list);
  const el = h("div", { class: "view approval-inbox-view" }, h("div", { class: "card" }, body));
  let key = "";
  const dateTime = (time: number) => new Date(time).toLocaleString([], {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  function item(request: ApprovalInfo | MissedApproval, active: boolean): HTMLElement {
    const provider = request.provider ? codingDefinition(request.provider).name : "Coding assistant";
    const status = active ? "Waiting for you" : (request as MissedApproval).status;
    const resolved = !active && !!(request as MissedApproval).resolvedAt;
    const review = h("button", { class: "approval-inbox-review", type: "button",
      "data-review": active ? "active" : "editor", text: active ? "Open request" : request.returnTarget ? "Return to window" : request.cwd ? "Open project" : "Open tool",
      onclick: () => {
        if (active) {
          if (!State.pendingApprovals.some(r=>r.requestId===request.requestId)) return;
          State.selectApproval(request.requestId);
          if (request.taskId) actions.setFocus(request.taskId);
          actions.setView(request.questions ? "question" : "approval");
        } else actions.returnToWork(request.cwd ?? null,request.returnTarget);
      } });
    const row = h("div", { class: "approval-inbox-row", role: "listitem",
      "data-active": String(active), "data-request": request.requestId,
      "data-resolved": String(resolved), "data-failed": String(!!(request as MissedApproval).failed) },
      h("div", { class: "approval-inbox-copy" },
        h("div", { class: "approval-inbox-meta" }, h("b", { text: provider }),
          h("span", { class: "approval-inbox-status", text: active || resolved ? status : "Missed · " + status })),
        h("span", { class: "sub", text: `${request.project ?? "Session"} · ${dateTime(request.receivedAt ?? (request as MissedApproval).missedAt ?? Date.now())}` }),
        h("div", { class: "approval-inbox-command", text: request.command || request.tool,
          title: request.command || request.tool })), review);
    if (!active) row.append(h("button", { class: "approval-inbox-dismiss", type: "button",
      "aria-label": "Dismiss approval from " + provider, title: "Dismiss",
      onclick: () => State.dismissApproval(request.requestId) }, icon(ICONS.xmark, 12)));
    return row;
  }
  return {
    el,
    layout: () => ({ ...VIEW_LAYOUTS.approvals,
      height: Math.min(PANEL_H, Math.max(218, 112 + State.approvalInboxCount * 96)) }),
    sync() {
      clear.hidden = State.missedApprovals.length === 0;
      const pending = State.pendingApprovals, missed = State.missedApprovals;
      const next = JSON.stringify([pending, missed]);
      if (next === key) return;
      key = next;
      const focused = document.activeElement as HTMLElement | null;
      const restore = !!focused && list.contains(focused);
      const requestId = focused?.closest<HTMLElement>("[data-request]")?.dataset.request;
      const control = focused?.classList.contains("approval-inbox-review") ? ".approval-inbox-review" : ".approval-inbox-dismiss";
      list.replaceChildren(...pending.map(request => item(request, true)), ...missed.map(request => item(request, false)));
      if (!list.children.length) list.append(h("div", { class: "approval-inbox-empty", text: "No approvals or permissions to review." }));
      if (restore) {
        const row = [...list.children].find(row => (row as HTMLElement).dataset.request === requestId);
        (row?.querySelector<HTMLElement>(control) ?? list).focus({ preventScroll: true });
      }
    },
  };
}
