#!/usr/bin/env python3
"""Watch one chat's session log and exit when its turn has ended.

The supervisor starts this instead of holding a turn open with sleeps. A chat's turn is
over when its log stops growing and the last row is the assistant's own message with no
tool calls attached — that is the student's final report, which is exactly where a rep
must end (the roadmap's acceptance criterion "the run is never terminated early").

Usage: python scripts/session-scan/watch_chat.py <chat-id-prefix> [--timeout MIN] [--idle SEC]
Exit 0 = the turn ended. Exit 1 = timeout, the student is still working or stalled.
"""
import argparse
import json
import os
import sys
import time

SESS = os.path.expanduser("~/.forge/sessions")


def find_log(prefix):
    hits = [os.path.join(SESS, n) for n in os.listdir(SESS)
            if n.lower().startswith(prefix.lower()) and n.endswith(".jsonl")]
    if not hits:
        return None
    return max(hits, key=os.path.getmtime)


def rows_of(path):
    out = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if isinstance(rec, dict):
                out.append(rec)
    return out


def turn_over(rows):
    """True when the newest row that carries a role is the assistant's own closing message.

    The log also writes metadata rows (`type: request`, `written_count`, …) with no `role`, and
    those land after the model's message, so the newest row of the file is almost never the
    assistant's. Judge the newest row that has a role, and use the file's mtime for quietness.
    """
    said = [r for r in rows if r.get("role")]
    if len(said) < 5:
        return False, f"only {len(said)} role rows"
    last = said[-1]
    role = str(last.get("role") or "")
    calls = last.get("tool_calls") or []
    if role != "assistant":
        return False, f"last role row is {role or 'unknown'}"
    if calls:
        return False, "assistant row still carries tool calls"
    content = last.get("content")
    if isinstance(content, list):
        content = " ".join(x.get("text", "") for x in content if isinstance(x, dict))
    text = (content or "").strip()
    if not text:
        return False, "assistant row is empty"
    return True, f"final message {len(text)} chars, {len(rows)} rows"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prefix")
    ap.add_argument("--timeout", type=float, default=45.0, help="minutes")
    ap.add_argument("--idle", type=float, default=90.0, help="seconds the log must be still")
    args = ap.parse_args()

    deadline = time.time() + args.timeout * 60
    path = None
    while time.time() < deadline:
        path = find_log(args.prefix)
        if not path:
            print(f"no log yet for {args.prefix}", flush=True)
            time.sleep(10)
            continue
        rows = rows_of(path)
        done, why = turn_over(rows)
        quiet = time.time() - os.path.getmtime(path)
        if done and quiet >= args.idle:
            print(f"DONE {os.path.basename(path)} rows={len(rows)} quiet={int(quiet)}s {why}",
                  flush=True)
            return 0
        print(f"working rows={len(rows)} quiet={int(quiet)}s ({why})", flush=True)
        time.sleep(10)

    print(f"TIMEOUT after {args.timeout} min: {os.path.basename(path) if path else 'no log'}",
          flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main())
