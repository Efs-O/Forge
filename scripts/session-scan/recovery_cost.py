#!/usr/bin/env python3
"""T30 — how much does a tool failure actually COST? Written 2026-11-09 02:10.

The nightly scan says 73% of tool failures "recover". That answers *whether*, not *what it cost*.
This walks every production session log and measures, for each failure, the number of tool calls
that happen before the same tool next succeeds — i.e. the tax the model pays on a refusal. It is
the number the landing decisions need: a class that costs 1 call is not worth schema budget, a
class that costs 5 or never retries is.

Method (honest about its limits):
  * a failure = a `role:"tool"` row whose content starts with "Error"
  * recovery = the next `role:"tool"` row for the SAME tool whose content does not start with "Error"
  * cost = how many tool rows (any tool) sit between them; `none` = no later call for that tool
  * test chats are excluded via docs/reports/session-scan/test-chats.exclude
  * signatures are masked like the scan (digits -> N) so variants collapse into one class
  * this counts calls, not wall-clock or tokens; a retried call that succeeds first time is cost 1.

Usage: python scripts/session-scan/recovery_cost.py [--top N]
"""
import io
import json
import os
import re
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

SESS = os.path.expanduser("~/.forge/sessions")
FORGE = Path(__file__).resolve().parents[2]  # the repo this script lives in
EXCLUDE = FORGE / "docs" / "reports" / "session-scan" / "test-chats.exclude"
MASK = [(re.compile(r"call_[0-9a-f]+", re.I), "call_ID"), (re.compile(r"\b\d[\d.,]*\b"), "N")]


def mask(text):
    out = text.strip().replace("\n", " ")
    for pattern, sub in MASK:
        out = pattern.sub(sub, out)
    return out[:160]


def excluded_prefixes():
    out = set()
    if not os.path.exists(EXCLUDE):
        return out
    for line in io.open(EXCLUDE, encoding="utf-8", errors="replace"):
        line = line.strip()
        if line and not line.startswith("#"):
            out.add(line.split()[0].lower())
    return out


def analyse(path, skip):
    name = os.path.basename(path).split(".")[0][:8].lower()
    if name in skip:
        return []
    events = []  # (tool, is_error, content)
    try:
        with io.open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if isinstance(rec, dict) and rec.get("role") == "tool":
                    text = rec.get("content")
                    if isinstance(text, list):
                        text = " ".join(x.get("text", "") for x in text if isinstance(x, dict))
                    events.append((rec.get("name") or "?",
                                   str(text or "").lstrip().startswith("Error"),
                                   str(text or "")))
    except OSError:
        return []
    results = []
    for index, (tool, is_error, text) in enumerate(events):
        if not is_error:
            continue
        calls = 0
        recovered = False
        # Look only at the NEXT 20 tool rows. Without this cap a failure at 20:00 and an unrelated
        # success with the same tool two hours later count as "recovered", which invents a cost of
        # hundreds of calls. In-place recovery is the thing worth measuring.
        for later_tool, later_error, _ in events[index + 1:index + 21]:
            if later_tool != tool:
                calls += 1
                continue
            if not later_error:
                recovered = True
                break
            calls += 1
        results.append((tool, mask(text), calls if recovered else None))
    return results


def main():
    top = 15
    if "--top" in sys.argv:
        top = int(sys.argv[sys.argv.index("--top") + 1])
    skip = excluded_prefixes()
    per_class = defaultdict(list)
    per_tool = defaultdict(list)
    files = [os.path.join(SESS, n) for n in sorted(os.listdir(SESS)) if n.endswith(".jsonl")]
    scanned = 0
    for path in files:
        found = analyse(path, skip)
        if found:
            scanned += 1
        for tool, sig, cost in found:
            per_class[(tool, sig)].append(cost)
            per_tool[tool].append(cost)
    total = sum(len(v) for v in per_class.values())
    recovered = [c for v in per_class.values() for c in v if c is not None]
    print(f"chats with failures: {scanned} | failures: {total} | recovered: {len(recovered)} "
          f"({100 * len(recovered) // max(total, 1)}%) | never retried that tool: "
          f"{total - len(recovered)}")
    if recovered:
        print(f"calls-to-recovery: median {statistics.median(recovered)} mean "
              f"{sum(recovered)/len(recovered):.2f} max {max(recovered)}")
        buckets = Counter()
        for cost in recovered:
            buckets["1" if cost == 1 else "2" if cost == 2 else "3-5" if cost <= 5 else "6+"] += 1
        print("distribution:", dict(sorted(buckets.items())))
    print(f"\nworst classes by total calls burned (top {top}):")
    rows = []
    for (tool, sig), costs in per_class.items():
        burns = [c for c in costs if c is not None]
        rows.append((sum(burns) + 2 * (len(costs) - len(burns)), len(costs),
                     statistics.median(burns) if burns else -1, tool, sig))
    rows.sort(key=lambda row: row[0], reverse=True)
    for burn, count, med, tool, sig in rows[:top]:
        print(f"  calls={burn:4d} n={count:3d} median={med} {tool}: {sig[:100]}")
    print("\nby tool (failures, recovered, median calls):")
    for tool, costs in sorted(per_tool.items(), key=lambda kv: -len(kv[1]))[:12]:
        burns = [c for c in costs if c is not None]
        print(f"  {tool:18s} n={len(costs):3d} recovered={len(burns):3d} "
              f"median={statistics.median(burns) if burns else '-'}")

    # BASELINE TABLE (owner asked 2026-11-09): the per-class count / abandoned / calls-burned view,
    # for EVERY class of a size worth acting on, not just the worst burners. This is the table the
    # roadmap is measured against, so it must exist BEFORE the fixes land - after them it would
    # only show what is left, never what was saved. 'abandoned' here means "no later success with
    # the same tool within 20 tool rows", which also counts a model that moved on to a different
    # tool; read it as an upper bound on giving up, not a confirmed one.
    print("\nBASELINE per-class (count / recovered / abandoned / calls-burned / median calls), "
          "classes with >=3 failures:")
    print(f"  {'count':>5} {'recov':>5} {'aband':>5} {'burn':>5} {'med':>4}  tool: signature")
    for (tool, sig), costs in sorted(per_class.items(), key=lambda kv: -len(kv[1])):
        if len(costs) < 3:
            continue
        burns = [c for c in costs if c is not None]
        abandoned = len(costs) - len(burns)
        med = statistics.median(burns) if burns else -1
        print(f"  {len(costs):5d} {len(burns):5d} {abandoned:5d} {sum(burns):5d} {med:4}"
              f"  {tool}: {sig[:110]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
