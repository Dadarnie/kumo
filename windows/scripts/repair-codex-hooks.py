# SPDX-License-Identifier: MIT
"""Preview or apply the narrow Windows hook repair. Never changes hook trust.

Removes original Coucou --agent duplicates only when the working Mimo entry
already exists, and gives the project design hook a git-root-based invocation.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import time

ROOT = Path(__file__).resolve().parents[2]


def legacy(handler):
    return handler.get("type") == "command" and bool(re.fullmatch(
        r'"[A-Za-z]:[\\/][^"\r\n]+[\\/]coucou-hook\.exe" --agent codex',
        handler.get("command", ""), re.I))


def working(handler, event):
    prefix = "powershell.exe -NoProfile -NonInteractive -EncodedCommand "
    command = handler.get("command", "")
    if handler.get("statusMessage") != "Mimo Codex companion" or not command.startswith(prefix):
        return False
    try:
        script = base64.b64decode(command[len(prefix):], validate=True).decode("utf-16-le")
    except (ValueError, UnicodeError):
        return False
    match = re.fullmatch(r"& '([^']+mimo-hook\.exe)' --provider codex " + re.escape(event), script)
    return bool(match and Path(match[1]).is_file())


def plan(path, project=False):
    before = path.read_bytes()
    data = json.loads(before.decode("utf-8-sig"))
    changes = 0
    for event, groups in data.get("hooks", {}).items():
        if not project and any(legacy(h) for g in groups for h in g.get("hooks", [])):
            if not any(working(h, event) for g in groups for h in g.get("hooks", [])):
                raise RuntimeError(f"No verified Mimo replacement for {event}; nothing was written.")
        for group in groups:
            handlers = group.get("hooks", [])
            if project:
                for handler in handlers:
                    if handler.get("command", "").startswith('[ ! -f ".agents/skills/impeccable/scripts/impeccable" ]'):
                        # Codex can start in product-launch/ or windows/. Resolve
                        # the existing launcher from the git root in either case.
                        script = "$mimoRoot = & git rev-parse --show-toplevel; if ($LASTEXITCODE -ne 0) { exit 0 }; $mimoHook = Join-Path $mimoRoot '.agents/skills/impeccable/scripts/impeccable.cmd'; if (Test-Path -LiteralPath $mimoHook) { & $mimoHook hook; exit $LASTEXITCODE }; exit 0"
                        command = "powershell.exe -NoProfile -NonInteractive -EncodedCommand " + base64.b64encode(script.encode("utf-16-le")).decode("ascii")
                        handler["command"] = handler["commandWindows"] = command
                        changes += 1
            else:
                group["hooks"] = [h for h in handlers if not legacy(h)]
                changes += len(handlers) - len(group["hooks"])
        # Keep preexisting empty groups; remove only newly emptied owned groups.
        if not project:
            data["hooks"][event] = [g for g, old in zip(groups, json.loads(before.decode("utf-8-sig"))["hooks"][event])
                                    if g.get("hooks") or not old.get("hooks")]
    return {"path": path, "before": before, "after": (json.dumps(data, indent=2) + "\n").encode(), "changes": changes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    codex = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    plans = [plan(codex / "hooks.json"), plan(ROOT / ".codex/hooks.json", project=True)]
    report = [{"file": str(p["path"]), "changes": p["changes"], "sha256_before": hashlib.sha256(p["before"]).hexdigest()} for p in plans]
    if args.apply:
        # Check both inputs before changing either file, then back up exact bytes.
        for p in plans:
            if p["path"].read_bytes() != p["before"]:
                raise RuntimeError("Hook configuration changed since the preview; run again.")
        for p, record in zip(plans, report):
            if not p["changes"]:
                continue
            backup = p["path"].with_name(p["path"].name + f".bak-repair-{time.time_ns()}")
            backup.write_bytes(p["before"])
            temporary = p["path"].with_name(p["path"].name + f".repair-{os.getpid()}.tmp")
            temporary.write_bytes(p["after"])
            os.replace(temporary, p["path"])
            record["backup"] = str(backup)
    print(json.dumps({"applied": args.apply, "files": report, "hook_trust_changed": False}, indent=2))


if __name__ == "__main__":
    main()
