// SPDX-License-Identifier: MIT
/** One bounded, current activity per assistant. No file reads or activity cache. */
export interface CodingPreview {
  lines: string[];
  startLine?: number;
  kinds?: ("added" | "removed" | "context")[];
  lineNumbers?: (number | null)[];
}

export interface CodingFileChange {
  target: string;
  tool: string;
  toolUseId?: string;
  preview?: CodingPreview;
  changes?: { added: number; removed: number };
  phase: "running" | "complete" | "failed";
}

export type CodingStage = "Read" | "Edit" | "Run";

export interface CodingActivity {
  tool: string;
  action: string;
  target: string;
  toolUseId?: string;
  preview?: CodingPreview;
  intent?: string;
  summary?: string;
  completed?: boolean;
  stopped?: "interrupted" | "session-ended";
  /** Local observation time of the current action; never persisted as history. */
  startedAt?: number;
  phase?: "running" | "complete" | "failed";
  changes?: { added: number; removed: number };
  completedActions?: string[];
  completedCount?: number;
  stageCounts?: Partial<Record<CodingStage, number>>;
  files?: CodingFileChange[];
  /** At most three upcoming steps explicitly supplied by the agent's plan. */
  nextActions?: string[];
}

export interface CodingActivityEvent {
  hook_event_name?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  mimo_preview?: { text?: unknown; start_line?: unknown };
  prompt?: string;
  message?: string;
  tool_response?: unknown;
  tool_result?: unknown;
  mimo_edits?: unknown;
  mimo_next_actions?: unknown;
}

const ACTIONS: Record<string, string> = {
  Read: "Read", Write: "Write", Edit: "Edit", MultiEdit: "Edit",
  NotebookEdit: "Edit", apply_patch: "Edit", Bash: "Run",
  PowerShell: "Run", exec_command: "Run", run_command: "Run",
  Glob: "Find", Grep: "Search", WebSearch: "Search", WebFetch: "Fetch",
  LS: "List", Task: "Delegate", TodoWrite: "Plan", update_plan: "Plan",
};

export function activityText(value: unknown, limit = 160): string {
  if (typeof value !== "string") return "";
  const text = value.slice(0, 2_000)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit - 1).join("") + "…" : text;
}

export function codingPreview(value: CodingActivityEvent["mimo_preview"]): CodingPreview | undefined {
  if (typeof value?.text !== "string") return;
  const lines = value.text.slice(0, 2_000).replace(/\r\n?/g, "\n")
    .split("\n").slice(0, 12).map(line => activityText(line));
  if (!lines.some(line => line.trim())) return;
  const start = value.start_line;
  const startLine = typeof start === "number" && Number.isSafeInteger(start) && start > 0
    ? Math.min(start, 1_000_000) : undefined;
  return { lines, ...(startLine ? { startLine } : {}) };
}

/** Read only the text fields supplied by a tool result, with the same preview limits. */
function resultPreview(value: unknown): CodingPreview | undefined {
  if (typeof value === "string") return codingPreview({ text: value });
  if (!value || typeof value !== "object") return;
  const result = value as Record<string, unknown>;
  const file = result.file && typeof result.file === "object" ? result.file as Record<string, unknown> : null;
  const text = file?.content ?? result.stdout ?? result.output ?? result.content;
  if (typeof text === "string") return codingPreview({ text, start_line: file?.startLine ?? result.start_line });
  if (Array.isArray(text)) {
    const parts = text.filter(part => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
      .slice(0, 3).map(part => part.text.slice(0, 2_000));
    return codingPreview({ text: parts.join("\n") });
  }
}

/** Use source positions only when a tool reports them in a real diff hunk. */
function resultDiff(value: unknown): Pick<CodingActivity, "preview" | "changes"> | undefined {
  if (!value || typeof value !== "object") return;
  const hunks = (value as Record<string, unknown>).structuredPatch;
  if (!Array.isArray(hunks) || !hunks.length || hunks.length > 64) return;
  const preview: Required<Pick<CodingPreview, "lines" | "kinds" | "lineNumbers">> = { lines: [], kinds: [], lineNumbers: [] };
  let added = 0, removed = 0;
  for (const hunk of hunks) {
    if (!hunk || typeof hunk !== "object") return;
    const { oldStart, newStart, lines } = hunk;
    if (!Number.isSafeInteger(oldStart) || !Number.isSafeInteger(newStart) || oldStart < 0 || newStart < 0
      || oldStart > 1_000_000 || newStart > 1_000_000 || !Array.isArray(lines) || lines.length > 2_000) return;
    let oldLine = oldStart, newLine = newStart;
    for (const line of lines) {
      if (typeof line !== "string" || line.length > 64_000) return;
      if (line.startsWith("\\")) continue;
      const kind = line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : line.startsWith(" ") ? "context" : null;
      if (!kind) return;
      const number = kind === "removed" ? oldLine : newLine;
      if (kind === "added") { added++; newLine++; }
      else if (kind === "removed") { removed++; oldLine++; }
      else { oldLine++; newLine++; }
      if (preview.lines.length < 12) {
        preview.lines.push(activityText(line.slice(1)));
        preview.kinds.push(kind);
        preview.lineNumbers.push(number > 0 ? number : null);
      }
    }
  }
  return added || removed ? { preview, changes: { added, removed } } : undefined;
}

function patchDiff(value: unknown): Pick<CodingActivity, "preview" | "changes"> | undefined {
  if (typeof value !== "string" || value.length > 64_000) return;
  // A multi-file patch cannot assign all its source lines to the first file tab.
  if ((value.match(/^\*\*\* (?:Update|Add|Delete) File: |^diff --git /gm) ?? []).length > 1) return;
  const hunks: { oldStart: number; newStart: number; lines: string[] }[] = [];
  let current: (typeof hunks)[number] | undefined;
  for (const line of value.split(/\r?\n/)) {
    const start = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (start) {
      current = { oldStart: Number(start[1]), newStart: Number(start[2]), lines: [] };
      hunks.push(current);
    } else if (line.startsWith("@@") || line.startsWith("***") || line.startsWith("diff --git")) current = undefined;
    else if (current && /^[ +\\-]/.test(line)) current.lines.push(line);
  }
  return resultDiff({ structuredPatch: hunks });
}

/** A small diff from the current hook input, never from reading a user's files. */
function editPreview(tool: string, input: Record<string, unknown>): Pick<CodingActivity, "preview" | "changes"> {
  const edits = tool === "MultiEdit" && Array.isArray(input.edits) ? input.edits : [input];
  const added: string[] = [], removed: string[] = [];
  const lines = (value: unknown) => typeof value === "string" && value.length <= 64_000 && value
    ? value.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n") : [];
  if (tool === "Write") {
    const content = lines(input.content);
    return content.length ? { preview: { lines: content.slice(0, 12).map(line => activityText(line)) } } : {};
  }
  if (["Edit", "MultiEdit"].includes(tool)) {
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") continue;
      const values = edit as Record<string, unknown>;
      removed.push(...lines(values.old_string));
      added.push(...lines(values.new_string));
    }
  } else if (tool === "apply_patch") {
    const patch = input.patch ?? input.input ?? input.command;
    const diff = patchDiff(patch);
    if (diff) return diff;
    if (typeof patch === "string" && patch.length <= 64_000)
      for (const line of patch.split(/\r?\n/)) {
        if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
        else if (line.startsWith("-") && !line.startsWith("---")) removed.push(line.slice(1));
      }
  }
  if (!added.length && !removed.length) return {};
  const before = removed.slice(0, 3), after = added.slice(0, 3);
  return {
    changes: { added: added.length, removed: removed.length },
    preview: { lines: [...before, ...after].map(line => activityText(line)),
      kinds: [...before.map(() => "removed" as const), ...after.map(() => "added" as const)] },
  };
}

/** The native relay publishes just these bounded fields, never complete tool responses. */
function relayEdits(value: unknown): Omit<CodingFileChange, "tool" | "phase">[] {
  if (!Array.isArray(value) || value.length > 32) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== "object" || typeof item.target !== "string" || !item.target) return [];
    const preview = item.preview;
    const lines = Array.isArray(preview?.lines) ? preview.lines.slice(0, 12).map((line: unknown) => activityText(line)) : [];
    const kinds = lines.map((_: string, i: number) => ["added", "removed"].includes(preview.kinds?.[i]) ? preview.kinds[i] : "context") as CodingPreview["kinds"];
    const numbers = lines.map((_: string, i: number) => {
      const number = preview.lineNumbers?.[i];
      return Number.isSafeInteger(number) && number > 0 && number <= 1_000_000 ? number : null;
    });
    const counts = item.changes;
    const changes = counts && [counts.added, counts.removed].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000)
      ? { added: counts.added, removed: counts.removed } : undefined;
    return [{ target: activityText(item.target, 1_000), ...(changes ? { changes } : {}),
      ...(lines.length ? { preview: { lines, kinds, lineNumbers: numbers } } : {}) }];
  });
}

function inputEdits(tool: string, input: Record<string, unknown>): Omit<CodingFileChange, "tool" | "phase">[] {
  const patch = input.patch ?? input.input ?? (tool === "apply_patch" ? input.command : undefined);
  if (tool !== "apply_patch" || typeof patch !== "string" || patch.length > 64_000) return [];
  // Keep per-file counts separate even when a single tool call changes several files.
  const parts = patch.split(/(?=^\*\*\* (?:Update|Add|Delete) File: |^diff --git )/m);
  return parts.flatMap(part => {
    const target = part.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)/m)?.[1]
      ?? part.match(/^\+\+\+ b\/(.+)/m)?.[1] ?? part.match(/^diff --git a\/.+ b\/(.+)/m)?.[1];
    return target ? [{ target: activityText(target, 1_000), ...editPreview(tool, { input: part }) }] : [];
  }).slice(0, 32);
}

export function codingActivity(event: CodingActivityEvent, previous?: CodingActivity): CodingActivity | undefined {
  const name = event.hook_event_name;
  if (name === "BackgroundWork")
    return { ...(previous ?? {}), tool: "run_command", action: "Run", target: "Background commands",
      phase: "running", completed: false, stopped: undefined, toolUseId: undefined, preview: undefined, changes: undefined, summary: undefined };
  if (name === "BeforeModel")
    return { ...(previous?.completed ? {} : previous), tool: "", action: "Thinking",
      target: previous?.completed ? "" : previous?.intent ?? "", phase: "running", completed: false, stopped: undefined,
      toolUseId: undefined, preview: undefined, changes: undefined, summary: undefined };
  if (name === "UserPromptSubmit")
    return { tool: "", action: "Thinking", target: activityText(event.prompt ?? event.message),
      intent: activityText(event.prompt ?? event.message) || undefined };
  if (name === "Stop")
    return { ...(previous ?? { tool: "", action: "Done", target: "" }), completed: true,
      stopped: undefined, phase: "complete", summary: activityText(event.message) || undefined };
  if (name === "StopFailure")
    return { ...(previous ?? { tool: "", action: "", target: "" }), completed: false,
      stopped: undefined, phase: "failed", summary: activityText(event.message) || undefined };
  if (name === "Interrupt" || name === "SessionEnd")
    return previous?.completed ? previous : { ...(previous ?? { tool: "", action: "", target: "" }),
      stopped: name === "Interrupt" ? "interrupted" : "session-ended", completed: false };
  if (!["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"].includes(name ?? "")) return previous;
  const tool = activityText(event.tool_name, 80) || "Tool";
  const toolUseId = activityText(event.tool_use_id, 120) || undefined;
  const result = name === "PostToolUse" || name === "PostToolUseFailure";
  if (result && previous &&
      ((previous.toolUseId && toolUseId && previous.toolUseId !== toolUseId) ||
       (previous.tool && previous.tool !== tool))) return previous;
  const input = event.tool_input ?? {};
  const plan = tool === "TodoWrite" ? input.todos : tool === "update_plan" ? input.plan : undefined;
  const nextActions = ACTIONS[tool] === "Plan" && Array.isArray(event.mimo_next_actions)
    ? event.mimo_next_actions.slice(0, 3).map(step => activityText(step, 120).trim()).filter(Boolean)
    : Array.isArray(plan) ? plan.slice(0, 64).flatMap(step => {
    if (!step || typeof step !== "object" || step.status !== "pending") return [];
    const label = activityText(step.step ?? step.content, 120).trim();
    return label ? [label] : [];
  }).slice(0, 3) : previous?.nextActions;
  const intent = activityText(input.description ?? input.justification) || previous?.intent;
  const edit = editPreview(tool, input);
  const suppliedFiles = relayEdits(event.mimo_edits);
  const patchFiles = suppliedFiles.length ? suppliedFiles : inputEdits(tool, input);
  const diff = name === "PostToolUse" && ["Edit", "MultiEdit", "apply_patch"].includes(tool)
    ? resultDiff(event.tool_response ?? event.tool_result) : undefined;
  const patch = input.patch ?? input.input ?? (tool === "apply_patch" ? input.command : undefined);
  const patchTarget = tool === "apply_patch" && typeof patch === "string"
    ? patch.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/)?.[1] : "";
  const target = ["file_path", "path", "command", "cmd", "url", "query", "pattern", "prompt"]
    .map(key => activityText(input[key], 1_000)).find(Boolean) ?? activityText(patchTarget, 1_000);
  const previousEdit = result && ["Edit", "MultiEdit", "Write", "apply_patch"].includes(tool) ? previous?.preview : undefined;
  const preview = suppliedFiles[0]?.preview ?? diff?.preview ?? patchFiles[0]?.preview ?? edit.preview ?? previousEdit ?? codingPreview(event.mimo_preview)
    ?? (result ? resultPreview(event.tool_response ?? event.tool_result) ?? previous?.preview : undefined);
  const changes = suppliedFiles[0]?.changes ?? diff?.changes ?? patchFiles[0]?.changes ?? edit.changes ?? (result ? previous?.changes : undefined);
  const action = ACTIONS[tool] ?? tool;
  const stage = ["Edit", "Write"].includes(action) ? "Edit" : action;
  const completedActions = [...new Set([...(previous?.completedActions ?? []),
    ...(name === "PostToolUse" && ["Read", "Edit", "Run"].includes(stage) ? [stage] : [])])].slice(0, 3);
  // Repeated result metadata may refine a preview, but it is still the same action.
  const confirmed = name === "PostToolUse" && previous?.phase !== "complete";
  const completedCount = Math.min(1_000_000, (previous?.completedCount ?? previous?.completedActions?.length ?? 0)
    + (confirmed ? 1 : 0));
  const stageCounts = { ...(previous?.stageCounts ?? Object.fromEntries(
    (previous?.completedActions ?? []).map(name => [name, 1]))) };
  if (confirmed && ["Read", "Edit", "Run"].includes(stage))
    stageCounts[stage as CodingStage] = Math.min(1_000_000, (stageCounts[stage as CodingStage] ?? 0) + 1);
  const phase = name === "PostToolUseFailure" ? "failed" : result ? "complete" : "running";
  const currentTarget = patchFiles[0]?.target || target || (result ? previous?.target ?? "" : "");
  const matchedFiles = result && (toolUseId || previous?.toolUseId)
    ? previous?.files?.filter(file => file.tool === tool && file.toolUseId === (toolUseId || previous?.toolUseId))
      .map(file => file.target === currentTarget ? { ...file, ...(preview ? { preview } : {}), ...(changes ? { changes } : {}) } : file) ?? [] : [];
  const updates = patchFiles.length ? patchFiles : matchedFiles.length ? matchedFiles : ["Edit", "Write"].includes(action) && currentTarget
    ? [{ target: currentTarget, ...(preview ? { preview } : {}), ...(changes ? { changes } : {}) }] : [];
  const files = [...(previous?.files ?? [])];
  for (const update of updates) {
    const key = update.target.replace(/\\/g, "/");
    const index = files.findIndex(file => file.target.replace(/\\/g, "/") === key);
    const previousFile = index < 0 ? undefined : files[index];
    const file: CodingFileChange = { ...((result && previousFile?.toolUseId === (toolUseId || previous?.toolUseId)) ? previousFile : {}),
      ...update, tool, phase, ...((toolUseId || (result && previous?.toolUseId)) ? { toolUseId: toolUseId || previous?.toolUseId } : {}) };
    if (index < 0) files.push(file); else files[index] = file;
  }
  return {
    tool, action, target: currentTarget, phase,
    ...((toolUseId || (result && previous?.toolUseId))
      ? { toolUseId: toolUseId || previous?.toolUseId } : {}),
    ...(preview ? { preview } : {}), ...(changes ? { changes } : {}),
    ...(intent ? { intent } : {}),
    ...(completedActions.length ? { completedActions } : {}),
    ...(completedCount ? { completedCount } : {}),
    ...(Object.keys(stageCounts).length ? { stageCounts } : {}),
    ...(files.length ? { files: files.slice(-32) } : {}),
    ...(nextActions ? { nextActions } : {}),
  };
}

export function codingTarget(activity: CodingActivity, cwd?: string | null): string {
  const target = activity.target.replace(/\\/g, "/");
  if (!["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch", "LS"].includes(activity.tool)) return target;
  const base = cwd?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (base && target.slice(0, base.length).toLowerCase() === base.toLowerCase() &&
      /^[\\/]/.test(target.slice(base.length))) return target.slice(base.length + 1).replace(/\\/g, "/");
  return target.replace(/\\/g, "/");
}
