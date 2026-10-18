# SPDX-License-Identifier: MIT
"""Read-only check of commit candidates. Never prints matched credential values."""
import json
import pathlib
import re
import subprocess

root = pathlib.Path(subprocess.check_output(
    ["git", "rev-parse", "--show-toplevel"], text=True).strip())
patterns = {
    "OpenAI/Anthropic key": rb"\bsk-(?:ant-(?:api\d+-)?|proj-)?[A-Za-z0-9_-]{40,}\b",
    "GitHub token": rb"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b",
    "AWS access key": rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
    "Private key": rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
    "Slack token": rb"\bxox[baprs]-[A-Za-z0-9-]{30,}\b",
}
patterns = {name: re.compile(pattern) for name, pattern in patterns.items()}
paths = subprocess.check_output(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root
).decode("utf-8").split("\0")
findings = []
checked = 0
for name in sorted(set(paths)):
    if not name:
        continue
    path = root / name
    if not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
        continue
    data = path.read_bytes()
    if b"\0" in data[:4096]:
        continue
    checked += 1
    for kind, pattern in patterns.items():
        for match in pattern.finditer(data):
            findings.append({"file": name, "line": data.count(b"\n", 0, match.start()) + 1, "kind": kind})

# Check exactly what is staged, including files whose working copy changed later.
staged = subprocess.check_output(
    ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], cwd=root
).decode("utf-8").split("\0")
for name in filter(None, staged):
    result = subprocess.run(["git", "show", ":" + name], cwd=root, capture_output=True)
    if result.returncode or b"\0" in result.stdout[:4096]:
        continue
    for kind, pattern in patterns.items():
        for match in pattern.finditer(result.stdout):
            findings.append({"file": name, "line": result.stdout.count(b"\n", 0, match.start()) + 1,
                             "kind": kind, "staged": True})
print(json.dumps({"checkedTextFiles": checked, "findings": findings}))
raise SystemExit(1 if findings else 0)
