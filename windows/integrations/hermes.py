# SPDX-License-Identifier: MIT
# Mimo companion: local activity observer. No network, credentials, or permission decisions.
import json
import os
import subprocess

RELAY = __MIMO_RELAY__
FIELDS = {"file_path", "path", "command", "cmd", "old_string", "new_string", "content", "offset", "limit", "description", "pattern", "query"}

def _text(value, limit=2000):
    return value[:limit] if isinstance(value, str) else ""

def _send(event, data):
    payload = {
        "hook_event_name": event,
        "session_id": _text(data.get("session_id")),
        "cwd": _text(data.get("cwd")) or os.getcwd(),
        "tool_use_id": _text(data.get("tool_call_id")),
        "tool_name": _text(data.get("tool_name")),
        "prompt": _text(data.get("user_message")),
    }
    args = data.get("args")
    if isinstance(args, dict):
        payload["tool_input"] = {key: _text(value, 64000) if isinstance(value, str) else value
            for key, value in args.items() if key in FIELDS and isinstance(value, (str, int, float))}
    result = data.get("result")
    if isinstance(result, str):
        payload["tool_response"] = _text(result, 64000)
    elif isinstance(result, dict):
        payload["tool_response"] = {key: _text(result.get(key), 64000) for key in ("output", "stdout", "content") if isinstance(result.get(key), str)}
    if event == "Stop":
        payload["last_assistant_message"] = _text(data.get("assistant_response"))
    try:
        encoded = json.dumps(payload)
        if len(encoded.encode("utf-8")) > 900000:
            return
        subprocess.run([RELAY, "--provider", "hermes", event], input=encoded.encode("utf-8"),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1.8,
            shell=False, creationflags=0x08000000 if os.name == "nt" else 0)
    except (OSError, subprocess.SubprocessError, TypeError, ValueError):
        pass

def _before_turn(**kwargs):
    _send("UserPromptSubmit", kwargs)

def _after_turn(**kwargs):
    _send("Stop", kwargs)

def _before_tool(**kwargs):
    _send("PreToolUse", kwargs)

def _after_tool(**kwargs):
    _send("PostToolUse" if kwargs.get("status", "ok") == "ok" else "PostToolUseFailure", kwargs)

def register(ctx):
    ctx.register_hook("pre_llm_call", _before_turn)
    ctx.register_hook("post_llm_call", _after_turn)
    ctx.register_hook("pre_tool_call", _before_tool)
    ctx.register_hook("post_tool_call", _after_tool)
