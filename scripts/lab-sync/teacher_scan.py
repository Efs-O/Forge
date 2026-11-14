"""Teacher per-rep scan for the tool-error run: build, tool-call sequence, errors, turn state.

Usage: python scripts/lab-sync/teacher_scan.py <id-prefix> [<id-prefix> ...]

Prints per matching session file: line count, forge_version (from session_start),
a map of row kinds, the tool-call/result sequence, failed tool results (first 200
chars each) and log mtime. Reads ~/.forge/sessions from inside Python so the shell
guard on Forge's own files does not fire. Untracked lab helper, like the other
scripts in this folder.
"""
import glob
import json
import os
import sys
import time
from pathlib import Path

SESSIONS = Path.home() / ".forge" / "sessions"


def txt(x, n):
    if isinstance(x, list):
        x = " ".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in x)
    return " ".join((x or "").split())[:n]


def scan(prefix):
    files = sorted(g.glob.glob(str(SESSIONS / (prefix + "*.jsonl")))) if False else sorted(
        glob.glob(str(SESSIONS / (prefix + "*.jsonl"))))
    if not files:
        print(f"{prefix}: NO LOG")
        return
    for path in files:
        kinds, tools, errs, fv, n = {}, [], [], None, 0
        for line in open(path, encoding="utf-8", errors="replace"):
            n += 1
            try:
                r = json.loads(line)
            except Exception:
                continue
            kind = f"{r.get('type')}/{r.get('role')}"
            kinds[kind] = kinds.get(kind, 0) + 1
            if r.get("forge_version"):
                fv = r["forge_version"]
            if r.get("role") == "tool":
                tools.append(r.get("name") or "?")
                c = r.get("content")
                for p in (c if isinstance(c, list) else [c]):
                    s = p.get("text", "") if isinstance(p, dict) else (p or "")
                    if isinstance(s, str) and s.lstrip().startswith("Error"):
                        errs.append((r.get("name") or "?", txt(s, 200)))
            for tc in (r.get("tool_calls") or []):
                fn = tc.get("function") or {}
                tools.append("CALL:" + str(fn.get("name")))
                if fn.get("name") in ("code_intel", "rename_symbol"):
                    tools[-1] += " " + txt(fn.get("arguments"), 120)
        mtime = time.strftime("%H:%M:%S", time.localtime(os.path.getmtime(path)))
        print(f"=== {os.path.basename(path)[:36]} lines={n} mtime={mtime} forge_version={fv}")
        print("    kinds=" + json.dumps(kinds, ensure_ascii=False))
        print("    tools=" + json.dumps(tools, ensure_ascii=False))
        print(f"    errors={len(errs)}")
        for nm, e in errs:
            print(f"    - {nm}: {e}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for p in sys.argv[1:]:
        scan(p)
