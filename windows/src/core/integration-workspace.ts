// SPDX-License-Identifier: MIT
export type IntegrationItem = Record<string, unknown>;
export type IntegrationTone = "success" | "pending" | "failure" | "neutral";
export const integrationText = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value) : "";
export const integrationList = (data: IntegrationItem, key: string): IntegrationItem[] => Array.isArray(data[key]) ? data[key].filter(item => item && typeof item === "object") as IntegrationItem[] : [];
export const integrationTimestamp = (value: unknown): number => {
  if (value == null || value === "") return NaN;
  return new Date(typeof value === "number" ? value : String(value)).getTime();
};

export function integrationStatus(value: unknown): { label: string; tone: IntegrationTone } {
  const state = integrationText(value).toLowerCase();
  if (state === "refunded") return { label: "Refunded", tone: "neutral" };
  const labels: Record<string, string> = { ready: "Ready", success: "Success", succeeded: "Paid", delivered: "Delivered", active: "Active", off: "Off", error: "Error", failed: "Failed", failure: "Failed", canceled: "Canceled", cancelled: "Canceled", bounced: "Bounced", complained: "Complaint", building: "Building", running: "Running", new: "Queued", queued: "Queued", waiting: "Waiting", pending: "Pending", sent: "Sent", accepted: "Confirmed", scheduled: "Scheduled" };
  const tone = ["ready", "success", "succeeded", "delivered", "active", "accepted"].includes(state) ? "success"
    : ["error", "failed", "failure", "bounced", "complained"].includes(state) ? "failure"
    : ["building", "running", "new", "queued", "waiting", "pending", "scheduled", "sent"].includes(state) ? "pending" : "neutral";
  return { label: labels[state] ?? (state ? state.replace(/_/g, " ") : "Not shared"), tone };
}

const moneyFormats = new Map<string, Intl.NumberFormat>();
export function integrationMoney(amount: unknown, currency: unknown): string {
  if (amount == null || amount === "" || !Number.isFinite(Number(amount))) return "Not shared";
  const code = integrationText(currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return "Not shared";
  try {
    let format = moneyFormats.get(code);
    if (!format) {
      format = new Intl.NumberFormat(undefined, { style: "currency", currency: code });
      if (moneyFormats.size >= 12) moneyFormats.delete(moneyFormats.keys().next().value!);
      moneyFormats.set(code, format);
    }
    return format.format(Number(amount) / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
  } catch { return "Not shared"; }
}

export function integrationRows(id: string, data: IntegrationItem, category: string, now = Date.now()): IntegrationItem[] {
  const source = id === "integration_stripe" && ["paid", "pending", "refunded"].includes(category) ? "payments" : category === "attention" ? id === "integration_n8n" ? "executions" : id === "integration_resend" ? "emails" : "deployments" : category === "today" ? "bookings" : category === "delivered" ? "emails" : ["ready", "building"].includes(category) ? "deployments" : category;
  let rows = integrationList(data, source);
  if (category === "attention") rows = rows.filter(item => integrationStatus(item.state ?? item.status ?? item.lastEvent).tone === "failure");
  if (category === "delivered") rows = rows.filter(item => item.lastEvent === "delivered");
  if (category === "ready") rows = rows.filter(item => item.state === "READY");
  if (id === "integration_vercel" && category === "building") rows = rows.filter(item => integrationStatus(item.state).tone === "pending");
  if (id === "integration_stripe") {
    if (category === "paid") rows = rows.filter(item => item.status === "succeeded" && !item.refunded);
    if (category === "pending") rows = rows.filter(item => item.status === "pending" && !item.refunded);
    if (category === "refunded") rows = rows.filter(item => item.refunded === true);
  }
  if (id === "integration_calcom") {
    rows = rows.filter(item => { const at = integrationTimestamp(item.start); return Number.isFinite(at) && at >= now && !["cancelled", "canceled", "rejected"].includes(integrationText(item.status).toLowerCase()); })
      .sort((a, b) => integrationTimestamp(a.start) - integrationTimestamp(b.start));
    if (category === "today") rows = rows.filter(item => new Date(integrationTimestamp(item.start)).toDateString() === new Date(now).toDateString());
  }
  return rows;
}
