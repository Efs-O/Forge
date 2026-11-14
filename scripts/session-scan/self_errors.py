#!/usr/bin/env python3
"""Self-error scan: what the LAB's own chats got wrong, from the raw session logs.

The nightly scan counts production chats. The teacher chat and the job chat are lab
infrastructure, so their own mistakes were never counted anywhere -- yet they are the
same model and the same tools, so they are free evidence. This prints normalized
signatures (digits masked, so 12 and 340 collapse to one row) with counts, per chat.

Usage: python scripts/session-scan/self_errors.py <chat-id-prefix> [prefix...]
       python scripts/session-scan/self_errors.py --all-lab     (every chat in lab-state.json)
"""
import io
import json
import os
import re
import sys
from collections import Counter

SESS = os.path.expanduser("~/.forge/sessions")
STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lab-state.json")
MASK = [(re.compile(r"call_[0-9a-f]+", re.I), "call_ID"),
        (re.compile(r"\b\d[\d.,]*\b"), "N")]


def normalize(text):
    out = text.strip().replace("\n", " ")
    for pattern, sub in MASK:
        out = pattern.sub(sub, out)
    return out[:200]


def tool_errors(prefix):
    paths = [os.path.join(SESS, n) for n in sorted(os.listdir(SESS))
             if n.lower().startswith(prefix.lower())]
    if not paths:
        print(f"!! no log for {prefix}")
        return Counter(), 0
    sigs, rows = Counter(), 0
    for path in paths:
        with io.open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if not isinstance(rec, dict):
                    continue
                rows += 1
                if rec.get("role") != "tool":
                    continue
                content = rec.get("content")
                if isinstance(content, list):
                    content = " ".join(x.get("text", "") for x in content if isinstance(x, dict))
                text = "" if content is None else str(content)
                if text.lstrip().startswith("Error"):
                    sigs[f"{rec.get('name')}: {normalize(text)}"] += 1
    return sigs, rows


def main():
    args = sys.argv[1:]
    if args == ["--all-lab"]:
        with open(STATE, encoding="utf-8") as handle:
            state = json.load(handle)
        args = sorted({(s.get("chat_id") or "")[:8] for s in state["students"]} - {""})
    if not args:
        print(__doc__)
        return 1
    grand = Counter()
    for prefix in args:
        sigs, rows = tool_errors(prefix)
        print(f"=== {prefix}: {rows} log rows, {sum(sigs.values())} tool errors")
        for sig, count in sigs.most_common():
            print(f"  {count:2d}  {sig}")
            grand[sig] += count
        if not sigs:
            print("   (clean)")
    print(f"=== TOTAL across {len(args)} chat(s): {sum(grand.values())} tool errors, "
          f"{len(grand)} distinct signatures")
    for sig, count in grand.most_common(15):
        print(f"  {count:2d}  {sig}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
