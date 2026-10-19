# Mimo — Windows agent integration

Tools can send hook events through the bundled `mimo-hook.exe` relay. It connects
to `\\.\pipe\mimo-<sid>`, where the SID isolates users on the machine. Both the
Windows transport and its server preserve the existing authentication checks.

Configure a hook command as `"C:/path/to/mimo-hook.exe" --agent my-tool UserPromptSubmit`
and write a hook JSON object on stdin. `--agent` sets `mimo_agent`; an absent or
invalid agent falls back to the Claude Code pill. Names must match
`^[a-z0-9-]{1,24}$`; `claude` is reserved. Existing commands without `--agent` still work.

```json
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "my-session",
  "cwd": "C:/projects/example",
  "mimo_agent": "my-tool",
  "prompt": "Build the project"
}
```

The relay preserves terminal context, removes oversized response/transcript fields,
truncates long strings and forwards newline-delimited JSON. Supported installed
events are defined in `windows/src-tauri/src/hooks.rs`; frontend routing and agent
validation live in `windows/src/island/hooks.ts`.

For command results, the relay extracts a bounded `mimo_tests` summary before
shortening output. It recognizes reported Node, Jest/Vitest, Cargo and pytest
totals and keeps at most 32 available test/suite names. A PASS suite is not an
individual test count. The Terminal workspace shows edits above command output.
Its compact result card shows reported totals and duration, with available
test names under Details. Missing results and durations stay unknown.

When an agent reports tokens, the result card labels the scope: prompt tokens
when a session counter was observed before that prompt, response tokens for an
individual model response, or session tokens for a cumulative reading. New prompts
clear the previous prompt result. Quota percentages remain in Limits.

`PermissionRequest` waits for the existing island acknowledgement and allow/deny
decision; other events finish promptly. The relay turns a confirmed decision into
Claude Code's existing `hookSpecificOutput`. If Mimo is closed, unavailable, paused
or cannot show the request, the terminal takes over. Connection, acknowledgement
and decision deadlines are unchanged; do not implement a second transport.

The permission panel keeps the command and its supplied workflow description
together. Deny, Allow and Always appear in that order, with N, Y and A shortcuts.
Always remembers the exact tool input for the current provider, session and
workspace in memory. A different command, session or workspace still needs a
decision. Ending the session or restarting Mimo clears the remembered choice;
the provider's saved permission policy is unchanged.

Use the app's Settings hook preview/install/uninstall flow. It merges only Mimo's
entries, backs up the original file and rejects concurrent changes in
`%USERPROFILE%\.claude\settings.json`.

## Follow-up questions from other agents

The bundled relay also runs as a local MCP stdio server:

```text
mimo-hook.exe --mcp --provider codex
```

Use the installed relay path shown in **Settings → Coding connection → Follow-up
questions**. The provider must be one of `claude`, `codex`, `cursor`, `gemini`,
`antigravity`, `muse`, `opencode`, `copilot`, or `hermes`. An agent must support
local MCP tools and explicitly use `ask_user`; its ordinary activity hooks do
not become a response channel. Claude's native `AskUserQuestion` hook continues
to work independently.

For Codex, add the connection to `~/.codex/config.toml`, substituting the actual
installed helper path, then restart Codex:

```toml
[mcp_servers.mimo]
command = "C:/Users/your-name/AppData/Local/Mimo/bin/mimo-hook.exe"
args = ["--mcp", "--provider", "codex"]
tool_timeout_sec = 120
```

For another local MCP client, create a server named `mimo` with the same command
and `args`, replacing `codex` with its provider ID. Settings provides a copyable
connection. Use a timeout of at least 120 seconds. The app does not silently edit
MCP configuration or keys. See [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

`ask_user` takes `questions` (1–4) and an optional absolute `cwd`. Each question
has `question`, optional `header`, `options` (0–8 label/description objects), and
optional `multiSelect`. Use an empty options array for a typed answer. Choices
are never preselected; the user can also write a custom answer. A successful
result has `answers` keyed by the exact question text. Do not fabricate an answer
after an error or cancellation; ask through the agent's normal interface.

Mimo recognizes 9 coding providers. Questions and permissions have equal priority:
every incoming request expands and pins the island, including in Working mode
or over an open panel. The selected request and unfinished answers remain intact.

Calls share the existing Review queue with native questions and permissions.
Every call has an isolated session and can only answer its own pending request.
Cancellation or disconnect releases that call's card. The server bounds active
calls to eight per connection and the decision wait to 110 seconds. Closed or
paused Mimo returns an error promptly. No question text or answers are stored in
agent configuration, and no API key or network server is needed.

The adapter implements [MCP stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
and [tool calls](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
over the existing authenticated Mimo pipe. Standard output contains JSON-RPC
only; local activity hooks keep their provider's documented response contracts.
