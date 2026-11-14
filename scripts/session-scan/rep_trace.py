#!/usr/bin/env python3
"""Per-rep trace + attribution, for the step the objective scorer cannot see.

Prints, for one student chat: every tool call in order (tool name + the first part of what it
asked for), so the supervisor can judge waste, scope obedience and recovery by hand. Then lists
every session on the machine whose `session_start` row names a given workspace and started at or
after a given time, so each staging line can be attributed to a chat BEFORE it is counted
(rep 01's lesson: one line was written by a chat nobody started).

Usage: python scripts/session-scan/rep_trace.py <chat-id-prefix> [--workspace Forge-lab2] [--since 00:25]
"""
import argparse
import glob
import json
import os
import sys
import time

SESS = os.path.expanduser("~/.forge/sessions")


def rows_of(path):
    out, seen = [], set()
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if not isinstance(rec, dict):
                continue
            # one audited log was 65% duplicate rows: dedupe on the row minus its timestamp
            key = json.dumps({k: v for k, v in rec.items() if k != "timestamp_ms"},
                             sort_keys=True, ensure_ascii=False)
            h = hash(key)
            if h in seen:
                continue
            seen.add(h)
            out.append(rec)
    return out


def brief(v, n=110):
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    return " ".join(s.split())[:n]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prefix")
    ap.add_argument("--workspace", default="Forge-lab2")
    ap.add_argument("--since", default="", help="HH:MM local; only sessions starting at/after this")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    hits = [p for p in glob.glob(os.path.join(SESS, "*.jsonl"))
            if os.path.basename(p).lower().startswith(args.prefix.lower())]
    if not hits:
        print(f"no log for {args.prefix}")
        return 1
    path = max(hits, key=os.path.getmtime)
    rows = rows_of(path)
    print(f"=== trace of {os.path.basename(path)} ===")
    n = 0
    for r in rows:
        if r.get("role") == "assistant":
            for tc in (r.get("tool_calls") or []):
                n += 1
                name = tc.get("name") or "(unnamed)"
                inp = tc.get("input")
                if inp is None:
                    inp = tc.get("raw_arguments")
                print(f"{n:3d}. {name:22s} {brief(inp)}")
    print(f"-- {n} tool calls total")

    print(f"\n=== sessions whose workspace contains '{args.workspace}' ===")
    since = None
    if args.since:
        today = time.strftime("%Y-%m-%d")
        since = time.mktime(time.strptime(f"{today} {args.since}:00", "%Y-%m-%d %H:%M:%S"))
    for p in sorted(glob.glob(os.path.join(SESS, "*.jsonl")), key=os.path.getmtime):
        for r in rows_of(p):
            if r.get("type") == "session_start" or "workspace_path" in r:
                wp = str(r.get("workspace_path") or "")
                if args.workspace.lower() in wp.lower():
                    ts = r.get("timestamp_ms")
                    hm = time.strftime("%H:%M:%S", time.localtime(ts / 1000)) if ts else "?"
                    keep = since is None or (ts and ts / 1000 >= since)
                    print(f"{'KEEP' if keep else 'old '} {os.path.basename(p)[:36]:36s} "
                          f"start={hm} ws={wp}")
                    break
    return 0


if __name__ == "__main__":
    sys.exit(main())
