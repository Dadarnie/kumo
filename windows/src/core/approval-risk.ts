// SPDX-License-Identifier: MIT
import type { ApprovalInfo } from "./state";

export interface ApprovalRisk { level: "caution" | "danger"; label: string; detail: string }

/** A local advisory. Only the agent's own permission decision authorizes work. */
export function approvalRisk(request: Pick<ApprovalInfo, "tool" | "command" | "reason" | "danger"> | null): ApprovalRisk {
  if (request?.danger) return { level: "danger", label: "Danger zone · flagged by the assistant", detail: "The assistant marks this as able to change, delete or send something. Read it before allowing." };
  const command = (request?.command ?? "").replace(/^[\w.-]+\s*·\s*/, "").trim();
  const tool = request?.tool ?? "";
  const description = `${tool} ${command} ${request?.reason ?? ""}`;
  const broad = /\b(full[- ]access|unrestricted|bypass[- ]permissions|dangerously[- ]skip[- ]permissions|no[- ]sandbox|disable[- ]sandbox|sandbox\s*[=:]\s*["']?danger-full-access|grant\s+(?:all|full)|administrator\s+access)\b/i;
  const destructive = /(?:^|[;&|\n]\s*|\b(?:sudo|cmd\s+\/c|powershell\s+(?:-command|-c))\s+)(?:rm|rmdir|rd|del|erase|remove-item|clear-content|format|diskpart|shred|mkfs(?:\.\w+)?|dd|takeown|icacls)\b/i;
  const history = /\bgit\s+(?:reset\s+[^\n;&|]*--hard|clean\s+[^\n;&|]*-[a-z]*[fd]|push\s+[^\n;&|]*(?:--force|-f\b))/i;
  const data = /\b(?:drop\s+(?:table|database|schema)|truncate\s+table|delete\s+from)\b/i;
  const access = /\b(?:chmod\s+[^\n;&|]*(?:777|\+s)|chown\s+[^\n;&|]*-R|set-executionpolicy\s+(?:unrestricted|bypass)|reg\s+delete|net\s+user)\b/i;
  const removalTool = /^(?:delete|remove|destroy|drop|refund|terminate)(?:[_-]|$)/i.test(tool);
  if (broad.test(description)) return { level: "danger", label: "Danger zone · broad access", detail: "This request may remove permission or sandbox limits. Review the scope before allowing it." };
  if (destructive.test(command) || history.test(command) || data.test(command) || access.test(command) || removalTool)
    return { level: "danger", label: "Danger zone · destructive action", detail: "This request may delete data, overwrite history, or change access. Check the exact target and command." };
  return { level: "caution", label: "Review permission", detail: "No destructive pattern was detected. Check the action and target before allowing it." };
}
