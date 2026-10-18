// SPDX-License-Identifier: MIT
// Mimo companion: local activity observer. No network, credentials, or permission decisions.
import { spawn } from "node:child_process";
const relay = __MIMO_RELAY__;
const fields = new Set(["filePath", "file_path", "path", "command", "cmd", "oldString", "newString", "content", "offset", "limit", "description", "pattern", "query"]);
const inputFor = value => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => fields.has(key))
  .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 64_000) : typeof value === "number" ? value : null]));
const send = (event, payload) => new Promise(resolve => {
  const json = JSON.stringify({ ...payload, hook_event_name: event });
  if (Buffer.byteLength(json) > 900_000) return resolve();
  try {
    const child = spawn(relay, ["--provider", "opencode", event], {
      shell: false, windowsHide: true, timeout: 1800, stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", resolve); child.on("close", resolve); child.stdin.on("error", () => {});
    child.stdin.end(json);
  } catch { resolve(); }
});
export const MimoCompanion = async ({ directory }) => ({
  "chat.message": async (input, output) => {
    const prompt = (output.parts ?? []).filter(p => p.type === "text").map(p => String(p.text ?? "").slice(0, 2000)).join("\n").slice(0, 2000);
    await send("UserPromptSubmit", { session_id: input.sessionID, cwd: directory, prompt });
  },
  "tool.execute.before": async (input, output) => {
    await send("PreToolUse", { session_id: input.sessionID, cwd: directory,
      tool_use_id: input.callID, tool_name: input.tool, tool_input: inputFor(output.args) });
  },
  "tool.execute.after": async (input, output) => {
    await send("PostToolUse", { session_id: input.sessionID, cwd: directory,
      tool_use_id: input.callID, tool_name: input.tool, tool_input: inputFor(input.args),
      tool_response: String(output.output ?? "").slice(0, 64_000) });
  },
  event: async ({ event }) => {
    const properties = event.properties ?? {};
    const session_id = properties.sessionID ?? properties.info?.id;
    if (!session_id) return;
    const names = { "session.created": "SessionStart", "session.deleted": "SessionEnd", "session.idle": "Stop", "session.error": "StopFailure" };
    if (names[event.type]) await send(names[event.type], { session_id, cwd: directory });
    else if (event.type === "session.status" && properties.status?.type === "busy")
      await send("BeforeModel", { session_id, cwd: directory });
    else if (event.type === "permission.asked")
      await send("Notification", { session_id, cwd: directory, message: "Approval waiting in OpenCode?" });
  },
});
