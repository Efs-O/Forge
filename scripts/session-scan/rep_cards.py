#!/usr/bin/env python3
"""Approval cards a lab session raised, and how long each waited.

The session log writes one `gate` row per card, but only AFTER it is answered,
with raised_ms / answered_ms / wait_ms / answered_by. Counting refusals alone
misses these: a card is not a refusal, it is a stall on a human.

usage: python scripts/session-scan/rep_cards.py <session-id-prefix>
"""
import json
import os
import sys
import glob

sys.stdout.reconfigure(encoding="utf-8")

prefix = sys.argv[1]
home = os.path.expanduser("~")
matches = glob.glob(os.path.join(home, ".forge", "sessions", prefix + "*.jsonl"))
if not matches:
    print(f"no session log matching {prefix}")
    sys.exit(1)
path = matches[0]

rows = []
with open(path, encoding="utf-8") as fh:
    for line in fh:
        line = line.strip()
        if line:
            rows.append(json.loads(line))

cards = [r for r in rows if r.get("type") == "gate"]
print(f"log={os.path.basename(path)}  rows={len(rows)}  cards={len(cards)}")
total_ms = 0
for r in cards:
    wait = int(r.get("wait_ms") or 0)
    total_ms += wait
    waited = "auto" if r.get("wait_ms") is None else f"{wait // 60000}m{wait % 60000 // 1000:02d}s"
    print(
        f"  {r.get('tool')} | waited {waited}"
        f" | by {r.get('answered_by')}"
        f" | allowed_for_project={r.get('allowed_for_project')}"
        f" | {str(r.get('reason'))[:90]}"
    )
print(f"total human wait: {total_ms // 60000}m{total_ms % 60000 // 1000:02d}s")
