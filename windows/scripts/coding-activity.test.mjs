// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSource } from "./ts-test-loader.mjs";
const { codingActivity, codingPreview, codingTarget } = await import(await loadSource("../src/core/coding-activity.ts"));
const { codeTokens } = await import(await loadSource("../src/core/code-tokens.ts"));
const { codingProgress, compactCodingProgress } = await import(await loadSource("../src/core/coding-progress.ts"));

test("Upcoming work uses only the agent's reported pending plan and clears for a new turn", () => {
  const planned = codingActivity({ hook_event_name: "PreToolUse", tool_name: "update_plan", tool_input: { plan: [
    { step: "Read the billing files", status: "completed" },
    { step: "Update totals", status: "in_progress" },
    { step: "Run billing tests", status: "pending" },
    { step: "Review the diff", status: "pending" },
  ] } });
  assert.equal(planned.action, "Plan");
  assert.deepEqual(planned.nextActions, ["Run billing tests", "Review the diff"]);
  const editing = codingActivity({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "billing.ts" } }, planned);
  assert.deepEqual(editing.nextActions, planned.nextActions);
  const updated = codingActivity({ hook_event_name: "PreToolUse", tool_name: "TodoWrite", tool_input: { todos: [
    { content: "Run billing tests", status: "completed" }, { content: "Review the diff", status: "in_progress" },
  ] } }, editing);
  assert.deepEqual(updated.nextActions, []);
  const relayed = codingActivity({ hook_event_name: "PreToolUse", tool_name: "update_plan",
    tool_input: {}, mimo_next_actions: ["Run billing tests", "Review the diff"] }, editing);
  assert.deepEqual(relayed.nextActions, ["Run billing tests", "Review the diff"]);
  assert.equal(codingActivity({ hook_event_name: "UserPromptSubmit", prompt: "Another change" }, editing).nextActions, undefined);
  assert.equal(codingActivity({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "app.ts" } }).nextActions, undefined);
});

test("Reported upcoming steps are bounded and malformed plans cannot invent work", () => {
  const plan = [...Array.from({ length: 40 }, (_, index) => ({ step: "Task " + index, status: "pending" })), null];
  const event = { hook_event_name: "PreToolUse", tool_name: "update_plan", tool_input: { plan } };
  assert.deepEqual(codingActivity(event).nextActions, ["Task 0", "Task 1", "Task 2"]);
  event.tool_input.plan = [null, { step: 42, status: "pending" }, { step: "Unknown status", status: "maybe" }];
  assert.deepEqual(codingActivity(event).nextActions, []);
});

test("model invocations retain real progress and background commands do not complete the turn", () => {
  const read = codingActivity({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "src/app.ts" } });
  const result = codingActivity({ hook_event_name: "PostToolUse", tool_name: "Read" }, read);
  const thinking = codingActivity({ hook_event_name: "BeforeModel" }, result);
  assert.equal(thinking.action, "Thinking");
  assert.equal(thinking.completedCount, 1);
  assert.equal(thinking.stageCounts.Read, 1);
  const background = codingActivity({ hook_event_name: "BackgroundWork" }, thinking);
  assert.equal(background.action, "Run");
  assert.equal(background.completed, false);
  assert.equal(background.phase, "running");
  const done = codingActivity({ hook_event_name: "Stop" }, background);
  assert.equal(done.completed, true);
  const next = codingActivity({ hook_event_name: "BeforeModel" }, done);
  assert.equal(next.completedCount, undefined);
  assert.equal(next.stageCounts, undefined);
});

test("Both coding providers show real actions and bounded previews", () => {
  const read = codingActivity({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "read-1",
    tool_input: { file_path: "C:\\projects\\korus\\src\\invoice.ts" } });
  assert.equal(read.action, "Read");
  assert.equal(codingTarget(read, "C:\\projects\\korus"), "src/invoice.ts");
  assert.equal(codingTarget({ ...read, target: "C:/projects/korus/src/invoice.ts" }, "C:\\projects\\korus"), "src/invoice.ts");
  const result = codingActivity({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "read-1",
    mimo_preview: { text: "export function total() {\n  return 42;\n}\nprivate fourth line", start_line: 12 } }, read);
  assert.equal(result.target, read.target);
  assert.deepEqual(result.preview, { lines: ["export function total() {", "  return 42;", "}", "private fourth line"], startLine: 12 });
  const command = codingActivity({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } });
  assert.equal(command.action, "Run");
  assert.equal(command.target, "npm test");
});

test("A stale tool result cannot overwrite a newer action or leak into a fresh prompt", () => {
  const current = codingActivity({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "new",
    tool_input: { file_path: "new.ts" } });
  assert.equal(codingActivity({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "old",
    mimo_preview: { text: "old result" } }, current), current);
  assert.equal(codingActivity({ hook_event_name: "PostToolUse", tool_name: "Bash",
    mimo_preview: { text: "old command" } }, current), current);
  assert.equal(codingActivity({ hook_event_name: "PostToolUse", tool_name: "Read",
    mimo_preview: { text: "current result" } }, current).toolUseId, "new");
  assert.deepEqual(codingActivity({ hook_event_name: "UserPromptSubmit", prompt: "New work" }, current),
    { tool: "", action: "Thinking", target: "New work", intent: "New work" });
});

test("Completion preserves the real preview and a new turn clears it", () => {
  const thinking = codingActivity({ hook_event_name: "UserPromptSubmit", prompt: "Verify the invoice total" });
  const running = codingActivity({ hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command: "npm test" } }, thinking);
  assert.equal(running.intent, "Verify the invoice total");
  const output = codingActivity({ hook_event_name: "PostToolUse", tool_name: "Bash",
    mimo_preview: { text: "PASS invoice.test.ts" } }, running);
  const completed = codingActivity({ hook_event_name: "Stop", message: "Tests passed" }, output);
  assert.equal(completed.completed, true);
  assert.equal(completed.summary, "Tests passed");
  assert.equal(completed.preview, output.preview);
  assert.equal(codingActivity({ hook_event_name: "Stop" }, output).completed, true);
  assert.equal(codingActivity({ hook_event_name: "UserPromptSubmit", prompt: "Next task" }, completed).completed, undefined);
});

test("Preview normalization strips terminal escapes and caps lines without splitting Unicode", () => {
  const preview = codingPreview({ text: "\u001b[32mPASS\u001b[0m\r\n" + "😀".repeat(300) + "\nlast\nignored", start_line: -1 });
  assert.equal(preview.lines[0], "PASS");
  assert.equal(Array.from(preview.lines[1]).length, 160);
  assert.ok(preview.lines[1].endsWith("…"));
  assert.equal(preview.lines.length, 4);
  assert.equal(codingPreview({text:Array.from({length:30},(_,i)=>`line ${i}`).join('\n')}).lines.length,12);
  assert.equal(preview.startLine, undefined);
  assert.equal(codingPreview({ text: "\n\n" }), undefined);
  assert.equal(codingPreview({ text: { access_token: "private" } }), undefined);
});

test("Live edits show only actual change counts and a bounded current diff", () => {
  const edit = codingActivity({hook_event_name:"PreToolUse",tool_name:"Edit",tool_use_id:"edit-1",
    tool_input:{file_path:"src/total.ts",old_string:"return 0;",new_string:"const total = 42;\nreturn total;"}});
  assert.deepEqual(edit.changes,{added:2,removed:1});
  assert.deepEqual(edit.preview,{lines:["return 0;","const total = 42;","return total;"],
    kinds:["removed","added","added"]});
  assert.equal(edit.phase,"running");
  const complete=codingActivity({hook_event_name:"PostToolUse",tool_name:"Edit",tool_use_id:"edit-1"},edit);
  assert.equal(complete.phase,"complete");
  assert.deepEqual(complete.preview,edit.preview);
  assert.deepEqual(complete.changes,edit.changes);
  const failed=codingActivity({hook_event_name:"PostToolUseFailure",tool_name:"Edit",tool_use_id:"edit-1"},edit);
  assert.equal(failed.phase,"failed");
  assert.equal(codingActivity({hook_event_name:"PostToolUseFailure",tool_name:"Edit",tool_use_id:"old"},edit),edit);
  assert.equal(codingActivity({hook_event_name:"UserPromptSubmit",prompt:"Next turn"},edit).changes,undefined);
  const write=codingActivity({hook_event_name:"PreToolUse",tool_name:"Write",
    tool_input:{file_path:"new.ts",content:Array.from({length:20},(_,i)=>`const n${i} = ${i};`).join("\n")}});
  assert.equal(write.changes,undefined,"Writing content does not claim a net diff without the previous file");
  assert.equal(write.preview.lines.length,12);
  const patch=codingActivity({hook_event_name:"PreToolUse",tool_name:"apply_patch",
    tool_input:{input:"*** Begin Patch\n*** Update File: src/total.ts\n-return 0;\n+return 42;\n*** End Patch"}});
  assert.equal(patch.target,"src/total.ts");
  assert.deepEqual(patch.changes,{added:1,removed:1});
  assert.equal(codingActivity({hook_event_name:"PreToolUse",tool_name:"Read",tool_input:{file_path:"total.ts"}}).changes,undefined);
});

test("Code coloring preserves every character and separates code from terminal output", () => {
  const source='export function total(items) { return 42 + "<script>"; } // total';
  const tokens=codeTokens(source);
  assert.equal(tokens.map(token=>token.text).join(""),source);
  for(const kind of ["keyword","function","number","string","comment"])
    assert.ok(tokens.some(token=>token.kind===kind),kind);
  assert.deepEqual(codeTokens("items"),[{text:"items"}]);
  assert.equal(codeTokens("PASS tests.ts: 48 passed",true).filter(token=>token.kind==="success").length,2);
  assert.ok(codeTokens("FAIL: error",true).every(token=>!token.kind||token.kind==="error"));
});

test("Reported edit hunks retain exact changed file positions without inventing them for snippets", () => {
  const edit = codingActivity({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "edit-lines",
    tool_input: { file_path: "src/invoice.ts", old_string: "return sum;", new_string: "const tax = sum * 0.196;\nreturn sum + tax;" } });
  assert.equal(edit.preview.lineNumbers, undefined);
  const applied = codingActivity({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "edit-lines",
    tool_response: { structuredPatch: [{ oldStart: 14, newStart: 14,
      lines: [" const sum = 42;", "-return sum;", "+const tax = sum * 0.196;", "+return sum + tax;", " }"] }] } }, edit);
  assert.deepEqual(applied.preview.lineNumbers, [14, 15, 15, 16, 17]);
  assert.deepEqual(applied.preview.kinds, ["context", "removed", "added", "added", "context"]);
  assert.deepEqual(applied.changes, { added: 2, removed: 1 });
  assert.deepEqual(applied.files[0].preview.lineNumbers, applied.preview.lineNumbers,
    "The per-file summary receives the same actual source positions as the live editor");
  const invalid = codingActivity({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "edit-lines",
    tool_response: { structuredPatch: [{ oldStart: -1, newStart: "15", lines: ["+private"] }] } }, edit);
  assert.deepEqual(invalid.preview, edit.preview);
  const patch = codingActivity({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: {
    input: "*** Begin Patch\n*** Update File: src/invoice.ts\n@@ -14,2 +14,3 @@\n const sum = 42;\n-return sum;\n+const tax = sum * 0.196;\n+return sum + tax;\n*** End Patch" } });
  assert.deepEqual(patch.preview.lineNumbers, [14, 15, 15, 16]);
  assert.deepEqual(patch.changes, { added: 2, removed: 1 });
});

test("Reported code results feed the preview and only observed actions complete the session stages", () => {
  const read=codingActivity({hook_event_name:"PreToolUse",tool_name:"Read",tool_use_id:"read",
    tool_input:{file_path:"src/invoice.ts"}});
  const result=codingActivity({hook_event_name:"PostToolUse",tool_name:"Read",tool_use_id:"read",
    tool_response:{file:{content:"const total = 42;\nreturn total;",startLine:10}}},read);
  assert.deepEqual(result.preview,{lines:["const total = 42;","return total;"],startLine:10});
  assert.deepEqual(result.completedActions,["Read"]);
  const edit=codingActivity({hook_event_name:"PreToolUse",tool_name:"Edit",tool_use_id:"edit",
    tool_input:{file_path:"src/invoice.ts",old_string:"return total;",new_string:"return total * 1.196;"}},result);
  assert.deepEqual(edit.completedActions,["Read"]);
  const failed=codingActivity({hook_event_name:"PostToolUseFailure",tool_name:"Edit",tool_use_id:"edit"},edit);
  assert.deepEqual(failed.completedActions,["Read"],"A failed edit never receives a completion checkmark");
  const complete=codingActivity({hook_event_name:"PostToolUse",tool_name:"Edit",tool_use_id:"edit"},edit);
  assert.deepEqual(complete.completedActions,["Read","Edit"]);
  assert.equal(codingActivity({hook_event_name:"UserPromptSubmit",prompt:"A new task"},complete).completedActions,undefined);
  const terminal=codingActivity({hook_event_name:"PostToolUse",tool_name:"Bash",
    tool_response:{stdout:"PASS invoice.test.ts"}});
  assert.deepEqual(terminal.preview.lines,["PASS invoice.test.ts"]);
  assert.equal(codingActivity({hook_event_name:"PostToolUse",tool_name:"Read",
    tool_response:{private_metadata:"never render arbitrary result JSON"}}).preview,undefined);
});

test("A turn retains per-file edits across other actions without counting relay results twice", () => {
  const patch = codingActivity({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_use_id: "patch-1",
    tool_input: { input: "*** Begin Patch\n*** Update File: src/a.ts\n@@ -17,1 +17,1 @@\n-before\n+after\n*** Update File: src/b.ts\n@@ -71,1 +71,2 @@\n-old\n+new\n+more\n*** End Patch" } });
  assert.equal(patch.files.length, 2);
  assert.deepEqual(patch.files.map(file => [file.target, file.changes]), [
    ["src/a.ts", { added: 1, removed: 1 }], ["src/b.ts", { added: 2, removed: 1 }],
  ]);
  assert.deepEqual(patch.preview.lineNumbers, [17,17]);
  assert.deepEqual(patch.changes, { added: 1, removed: 1 }, "The current file never claims another file's changes");
  const result = codingActivity({ hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_use_id: "patch-1" }, patch);
  assert.ok(result.files.every(file => file.phase === "complete"));
  assert.deepEqual(result.files.map(file => file.changes), patch.files.map(file => file.changes));
  const command = codingActivity({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }, result);
  assert.equal(command.files.length, 2);
  const latest = codingActivity({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "edit-2",
    tool_input: { file_path: "src/a.ts", old_string: "after", new_string: "final" } }, command);
  assert.equal(latest.files.length, 2);
  assert.equal(latest.files[0].toolUseId, "edit-2");
  assert.equal(latest.files[1].toolUseId, "patch-1");
  assert.equal(codingActivity({ hook_event_name: "UserPromptSubmit", prompt: "New turn" }, latest).files, undefined);
});

test("Native relay metadata feeds visible source gutters without raw tool_response or patch input", () => {
  const relay = codingActivity({ hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_use_id: "native-edit",
    tool_input: { file_path: "src/invoice.ts" }, mimo_edits: [{ target: "src/invoice.ts",
      preview: { lines: ["return 0;", "return 42;"], kinds: ["removed","added"], lineNumbers: [71,71] },
      changes: { added: 1, removed: 1 } }] });
  assert.deepEqual(relay.preview.lineNumbers, [71,71]);
  assert.deepEqual(relay.changes, { added: 1, removed: 1 });
  assert.equal(relay.files[0].phase, "complete");
  const invalid = codingActivity({ hook_event_name: "PreToolUse", tool_name: "Edit", mimo_edits: [{ target: "test.ts",
    preview: { lines: ["<script>"], lineNumbers: [-1], kinds: ["unknown"] }, changes: { added: -1, removed: 1 } }] });
  assert.deepEqual(invalid.preview.lineNumbers, [null]);
  assert.equal(invalid.changes, undefined);
  assert.deepEqual(invalid.preview.kinds, ["context"]);
});

test("Codex's command-wrapped patch renders file edits instead of the literal patch and tool status", () => {
  const patch = "*** Begin Patch\n*** Update File: src/invoice.ts\n@@ -71,1 +71,1 @@\n-return 0;\n+return 42;\n*** End Patch";
  const edit = codingActivity({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_use_id: "wrapped",
    tool_input: { command: patch } });
  assert.equal(edit.target, "src/invoice.ts");
  assert.deepEqual(edit.preview.lineNumbers, [71,71]);
  assert.deepEqual(edit.preview.kinds, ["removed","added"]);
  const complete = codingActivity({ hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_use_id: "wrapped",
    mimo_preview: { text: "Exit code: 0\nWall time: 4.4 seconds\nOutput:" } }, edit);
  assert.deepEqual(complete.preview, edit.preview);
  assert.equal(complete.files[0].target, "src/invoice.ts");
});

test("Preview progress counts confirmed tool results once and resets with a new turn", () => {
  const start = (tool, id, previous) => codingActivity({ hook_event_name: "PreToolUse",
    tool_name: tool, tool_use_id: id, tool_input: { file_path: "src/invoice.ts" } }, previous);
  const finish = (tool, id, previous) => codingActivity({ hook_event_name: "PostToolUse",
    tool_name: tool, tool_use_id: id }, previous);
  const first = finish("Read", "read-1", start("Read", "read-1"));
  assert.equal(first.completedCount, 1);
  assert.deepEqual(first.stageCounts, { Read: 1 });
  const refined = codingActivity({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "read-1",
    mimo_preview: { text: "const total = 42;", start_line: 71 } }, first);
  assert.equal(refined.completedCount, 1, "A richer repeat result updates the preview without claiming more progress");
  assert.equal(refined.preview.startLine, 71);
  const second = finish("Read", "read-2", start("Read", "read-2", refined));
  assert.equal(second.completedCount, 2);
  assert.deepEqual(second.stageCounts, { Read: 2 });
  assert.equal(finish("Read", "read-1", second), second, "A stale result does not count");
  const edit = start("Edit", "edit-1", second);
  const failed = codingActivity({ hook_event_name: "PostToolUseFailure", tool_name: "Edit", tool_use_id: "edit-1" }, edit);
  assert.equal(failed.completedCount, 2);
  assert.deepEqual(failed.stageCounts, { Read: 2 });
  const applied = finish("Edit", "edit-2", start("Edit", "edit-2", failed));
  const run = finish("Bash", "run-1", start("Bash", "run-1", applied));
  const search = finish("Grep", "search-1", start("Grep", "search-1", run));
  assert.equal(search.completedCount, 5);
  assert.deepEqual(search.stageCounts, { Read: 2, Edit: 1, Run: 1 });
  const done = codingActivity({ hook_event_name: "Stop" }, search);
  assert.equal(done.completedCount, 5);
  const next = codingActivity({ hook_event_name: "UserPromptSubmit", prompt: "Next turn" }, done);
  assert.equal(next.completedCount, undefined);
  assert.equal(next.stageCounts, undefined);
});

test("Preview names the current operation while completed and skipped stages stay truthful", () => {
  const task = { state: "working", sessionCwd: "C:/work", activity: codingActivity({ hook_event_name: "PreToolUse",
    tool_name: "Read", tool_use_id: "read", tool_input: { file_path: "C:/work/src/invoice.ts" } }) };
  const reading = codingProgress(task);
  assert.equal(reading.label, "Read");
  assert.equal(reading.target, "src/invoice.ts");
  assert.equal(reading.active, true);
  assert.deepEqual(reading.stages.map(stage => stage.state), ["active", "inactive", "inactive", "inactive"]);
  task.activity = codingActivity({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "read" }, task.activity);
  const complete = codingProgress(task);
  assert.equal(complete.label, "Read complete");
  assert.equal(complete.hint, "Waiting for next action");
  assert.equal(complete.active, true);
  assert.equal(complete.operationActive, false);
  assert.equal(complete.state, "active");
  assert.equal(complete.done, false);
  assert.equal(complete.countLabel, "1 action completed");
  task.activity = codingActivity({ hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "write",
    tool_input: { file_path: "C:/work/src/new.ts", content: "export const total = 42;" } }, task.activity);
  const writing = codingProgress(task);
  assert.equal(writing.label, "Edit");
  assert.deepEqual(writing.stages.map(stage => stage.state), ["complete", "active", "inactive", "inactive"]);
  task.activity = codingActivity({ hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: "write" }, task.activity);
  task.activity = codingActivity({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "read-again",
    tool_input: { file_path: "C:/work/src/new.ts" } }, task.activity);
  const revisited = codingProgress(task);
  assert.equal(revisited.stages[0].current, true);
  assert.equal(revisited.stages[0].count, 1);
  assert.equal(revisited.stages[1].state, "complete");
  task.activity = codingActivity({ hook_event_name: "Stop", message: "Created the file" }, task.activity);
  task.state = "finished";
  const done = codingProgress(task);
  assert.equal(done.label, "Done");
  assert.equal(done.hint, "Created the file");
  assert.equal(done.stages[2].state, "inactive", "Finishing a turn never claims that a command ran");
  assert.equal(done.stages[3].current, true);
  assert.equal(done.completedCount, 2, "Stopping during a read does not invent its successful result");
  assert.equal(codingProgress({ ...task, state: "idle" }).done, true);
});

test("Preview separates waiting, failure, and paused updates from active execution", () => {
  const activity = codingActivity({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "run",
    tool_input: { command: "npm test -- --runInBand" } });
  const task = { state: "working", activity };
  assert.equal(codingProgress(task).label, "Bash");
  for (const [state, label] of [["approval", "Needs approval"], ["question", "Needs your answer"], ["ratelimit", "Rate limited"]]) {
    const waiting = codingProgress({ ...task, state });
    assert.equal(waiting.label, label);
    assert.equal(waiting.active, false);
    assert.equal(waiting.stages[2].state, "waiting");
    assert.equal(waiting.stages[3].state, "inactive");
  }
  const paused = codingProgress(task, true);
  assert.equal(paused.label, "Updates paused");
  assert.equal(paused.active, false);
  assert.equal(paused.stages[2].state, "waiting");
  assert.equal(codingProgress(task).stages[2].state, "active");
  const failed = codingProgress({ ...task, activity: codingActivity({ hook_event_name: "PostToolUseFailure",
    tool_name: "Bash", tool_use_id: "run" }, activity) });
  assert.equal(failed.label, "Run failed");
  assert.equal(failed.state, "failed");
  assert.equal(failed.stages[2].state, "failed");
  assert.equal(failed.completedCount, 0);
});

test("The agent loader continues between confirmed tools while completed stages keep their checks", () => {
  const read = codingActivity({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "read-gap" });
  const activity = codingActivity({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "read-gap" }, read);
  for (const state of ["working", "thinking", "searching"]) {
    const task = { state, activity };
    const progress = codingProgress(task);
    assert.equal(progress.active, true);
    assert.equal(progress.operationActive, false);
    assert.equal(progress.state, "active");
    assert.equal(progress.stages[0].state, "complete");
    const paused = codingProgress(task, true);
    assert.equal(paused.state, "waiting");
    assert.equal(paused.label, "Updates paused");
    assert.equal(paused.active, false);
    assert.equal(paused.stages[0].state, "complete");
  }
  for (const state of ["approval", "question", "ratelimit", "idle", "error", "finished"]) {
    assert.equal(codingProgress({ state, activity }).active, false);
  }
});

test("The working-island reference uses two truthful lines and compact state-specific feedback", () => {
  const task = { id: "session_codex_compact", source: "codexCode", name: "Mimo", state: "thinking", steps: [],
    activity: { action: "Thinking", tool: "", target: "", intent: "Planning the change" } };
  assert.equal(compactCodingProgress(task).title, "Thinking");
  assert.equal(compactCodingProgress(task).indicator, "dots");
  task.state = "working";
  task.activity = { tool: "Read", action: "Read", target: "src-tauri/src/media.rs", phase: "running", stageCounts: { Read: 2 } };
  const read = compactCodingProgress(task);
  assert.equal(read.title, "Reading files");
  assert.equal(read.detail, "src-tauri/src/media.rs");
  assert.equal(read.metric, "2 read", "Only reported completed reads are counted; no total is invented");
  assert.equal(read.indicator, "ring");
  task.activity = { tool: "Edit", action: "Edit", target: "media.rs", phase: "running", changes: { added: 42, removed: 8 } };
  const edit = compactCodingProgress(task);
  assert.equal(edit.title, "Codex");
  assert.equal(edit.detail, "Editing media.rs");
  assert.deepEqual(edit.changes, { added: 42, removed: 8 });
  assert.equal(edit.indicator, "dots");
  task.activity = { tool: "Bash", action: "Run", target: "npm test", phase: "running" };
  assert.equal(compactCodingProgress(task).title, "Running tests");
  assert.equal(compactCodingProgress(task).timed, true);
  task.activity.target = "npm install sharp";
  assert.equal(compactCodingProgress(task).title, "Running command");
  task.state = "approval";
  assert.equal(compactCodingProgress(task).title, "Needs your approval");
  assert.equal(compactCodingProgress(task).review, true);
  assert.equal(compactCodingProgress(task).indicator, "none");
  task.state = "working";task.activity.phase = "complete";
  assert.equal(compactCodingProgress(task).title, "Working");
  assert.equal(compactCodingProgress(task).detail, "Waiting for next action");
  assert.equal(compactCodingProgress(task).timed, false);
  const paused = compactCodingProgress(task, true);
  assert.equal(paused.title, "Updates paused");
  assert.equal(paused.indicator, "none");
  task.state = "finished";
  task.activity.files = [{ target: "media.rs", phase: "complete", changes: { added: 42, removed: 8 } }];
  const done = compactCodingProgress(task);
  assert.equal(done.title, "Finished");
  assert.equal(done.detail, "1 file · +42 −8");
  assert.equal(done.review, true);
  assert.equal(done.indicator, "none");
});

test("Stopping retains observed work without claiming the turn finished successfully", () => {
  const activity = codingActivity({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } });
  for (const [event, title] of [["Interrupt", "Stopped"], ["SessionEnd", "Session ended"]]) {
    const stopped = codingActivity({ hook_event_name: event }, activity);
    const task = { id: "coding_codex", source: "codexCode", state: "idle", activity: stopped };
    const progress = codingProgress(task);
    assert.equal(progress.state, "stopped");
    assert.equal(progress.done, false);
    assert.equal(progress.active, false);
    assert.equal(progress.stages[3].state, "inactive");
    assert.equal(compactCodingProgress(task).title, title);
    assert.equal(compactCodingProgress(task).indicator, "none");
    assert.equal(compactCodingProgress(task).review, true);
  }
  const done = codingActivity({ hook_event_name: "Stop" }, activity);
  assert.equal(codingActivity({ hook_event_name: "SessionEnd" }, done), done, "Closing a completed session retains its confirmed result");
});

test("Silent agents get a quiet status rather than an invented completion or stopped claim", () => {
  const now = 1000000;
  const task = { id: "coding_codex", source: "codexCode", state: "thinking", lastEventAt: now - 90000,
    activity: { tool: "", action: "Thinking", target: "" } };
  const quiet = compactCodingProgress(task, false, now);
  assert.equal(quiet.title, "No recent activity");
  assert.equal(quiet.state, "quiet");
  assert.equal(quiet.indicator, "none");
  assert.equal(quiet.timed, false);
  assert.equal(quiet.review, true);
  assert.equal(task.state, "thinking", "Silence never rewrites agent state");
  assert.equal(compactCodingProgress({ ...task, lastEventAt: now }, false, now).title, "Thinking");
  assert.equal(compactCodingProgress({ ...task, state: "approval" }, false, now).title, "Needs your approval");
  assert.equal(compactCodingProgress(task, true, now).title, "Updates paused");
});

test("Thinking and other tools have their own activity without inventing a Reading stage", () => {
  const thought = codingProgress({ state: "thinking", activity: codingActivity({ hook_event_name: "UserPromptSubmit",
    prompt: "Find the regression in invoice totals" }) });
  assert.equal(thought.label, "Thinking");
  assert.equal(thought.active, true);
  assert.ok(thought.stages.every(stage => stage.state === "inactive"));
  const search = codingActivity({ hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "search",
    tool_input: { pattern: "invoiceTotal" } });
  const searching = codingProgress({ state: "working", activity: search });
  assert.equal(searching.label, "Searching");
  assert.equal(searching.target, "invoiceTotal");
  assert.ok(searching.stages.every(stage => stage.state === "inactive"));
  const result = codingActivity({ hook_event_name: "PostToolUse", tool_name: "Grep", tool_use_id: "search" }, search);
  assert.equal(codingProgress({ state: "working", activity: result }).countLabel, "1 action completed");
  assert.equal(codingProgress({ state: "idle" }).label, "Ready");
});
