"""Verdict helper for the tool-test lab: raw tool rows and errors per student chat.

The lab's proof rule says a verdict comes from the session JSONL, never from the
student's own report, so this prints exactly what the log holds: the tool-call
sequence per chat and every tool row whose content starts with `Error`.

Usage: python scripts/lab-sync/logscan.py <id-prefix> [<id-prefix> ...]

Rows are `{"role":"tool","name":...,"content":...}` in Forge's session logs, one
JSON object per line. Content is sometimes a list of blocks, so both shapes are
handled. Written 2026-11-08 for the teacher chat; the overnight job uses it too.
"""

import glob
import json
import os
import sys
import time
from pathlib import Path

SESSIONS = Path.home() / ".forge" / "sessions"


def rows_for(prefix):
    files = sorted(glob.glob(str(SESSIONS / (prefix + "*.jsonl"))))
    if not files:
        print(f"{prefix}: NO LOG")
        return
    for path in files:
        tools, errs = [], []
        for line in open(path, encoding="utf-8", errors="replace"):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("role") != "tool":
                continue
            tools.append(r.get("name") or "?")
            content = r.get("content")
            parts = content if isinstance(content, list) else [content]
            for part in parts:
                text = part.get("text", "") if isinstance(part, dict) else (part or "")
                if isinstance(text, str) and text.lstrip().startswith("Error"):
                    errs.append((r.get("name") or "?", " ".join(text.split())[:200]))
        print(f"=== {os.path.basename(path)[:8]} rows={len(tools)} {tools}")
        print(f"    errors={len(errs)} | log mtime "
              f"{time.strftime('%H:%M:%S', time.localtime(os.path.getmtime(path)))}")
        for name, text in errs:
            print(f"    - {name}: {text}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    rows_for(sys.argv[1]) if len(sys.argv) == 2 else [rows_for(p) for p in sys.argv[1:]]
