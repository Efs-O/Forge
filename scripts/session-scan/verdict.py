#!/usr/bin/env python3
"""Lab verdict helper: print the raw facts a TEST-lab verdict is computed from.

The session JSONL log is the single point of truth (owner rule 2026-11-08 21:41):
a verdict is computed from these rows, never from the student's own report.

Log schema (verified on a real student log, 2026-11-09 00:17):
  {"role":"assistant","content":null|text,"tool_calls":[{"id","name","input"}],"reasoning"}
  {"role":"tool","content":"<result text>","name":"<tool>","tool_call_id":"call_..."}
  {"role":"user","content":"<prompt>"}   plus cursor/usage/tools_offered/turn_end rows

Usage:  python scripts/session-scan/verdict.py <chat-id-prefix> [prefix...]
Logs live in ~/.forge/sessions/<full-chat-id>.jsonl.
A TOOL_ERROR row is a tool row whose content starts with "Error".
"""
import io
import json
import os
import sys

SESS = os.path.expanduser("~/.forge/sessions")


def load(prefix):
    paths = [os.path.join(SESS, n) for n in sorted(os.listdir(SESS))
             if n.lower().startswith(prefix.lower())]
    if not paths:
        print(f"=== {prefix} !! no session log")
        return []
    recs = []
    for path in paths:
        with io.open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if isinstance(rec, dict):
                    recs.append(rec)
    return recs


def report(prefix):
    recs = load(prefix)
    if not recs:
        return
    calls, errors, finals = [], [], []
    for rec in recs:
        role = rec.get("role")
        for c in (rec.get("tool_calls") or []):
            if isinstance(c, dict):
                calls.append((c.get("name"), json.dumps(c.get("input"), ensure_ascii=False)))
        if role == "tool":
            text = rec.get("content")
            if isinstance(text, list):
                text = " ".join(x.get("text", "") for x in text if isinstance(x, dict))
            text = "" if text is None else str(text)
            if text.lstrip().startswith("Error"):
                errors.append((rec.get("name"), text.strip().replace("\n", " ")[:300]))
        elif role == "assistant":
            text = rec.get("content")
            if isinstance(text, str) and text.strip():
                finals.append(text.strip())
    by_tool = {}
    for name, _ in calls:
        by_tool[name] = by_tool.get(name, 0) + 1
    print(f"=== {prefix} | rows {len(recs)} | tool calls {len(calls)} | "
          f"TOOL_ERROR rows {len(errors)}")
    print("calls:", json.dumps(by_tool, ensure_ascii=False))
    for name, inp in calls:
        print(f"  CALL {name} {inp[:240]}")
    for name, text in errors:
        print(f"  TOOL_ERROR [{name}] {text}")
    for name, text in errors:
        pass
    if finals:
        print("  FINAL:", finals[-1].replace("\n", " ")[:1200])


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 1
    for prefix in args:
        report(prefix)
    return 0


if __name__ == "__main__":
    sys.exit(main())
