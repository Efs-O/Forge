#!/usr/bin/env python3
"""Archive mining: the mistake kinds every chat on this machine has already produced.

`self_errors.py` reads the lab's own chats. This reads the whole archive — every
`~/.forge/sessions/*.jsonl` — and answers one question: which refusals and tool errors
recur, across how many chats, and how often. That is the breadth the frozen tasks are
too expensive to buy: the archive is free, a rep is not.

Rows are deduped before counting: inside one file, a tool row is counted once per
(tool_call_id, name, content) triple. Signatures are normalized — call ids, numbers,
paths and long hex strings masked — so `12` and `340` collapse to one row.

Usage: python scripts/session-scan/archive_kinds.py [--top 30] [--out FILE]
"""
import argparse
import hashlib
import io
import json
import os
import re
import sys
from collections import Counter

SESS = os.path.expanduser("~/.forge/sessions")
MASK = [
    (re.compile(r"call_[0-9a-f]+", re.I), "ID"),
    (re.compile(r"\b[0-9a-f]{16,}\b"), "ID"),
    (re.compile(r"[A-Za-z]:[\\/][^\s'\"]*"), "PATH"),
    (re.compile(r"(?:/{1|\\}{1,})(?:[^\s'\"]+[\\/])+[^\s'\"]*"), "PATH"),
    (re.compile(r"\b\d[\d.,]*\b"), "N"),
]


def normalize(text):
    out = " ".join(text.strip().split())
    for pattern, sub in MASK:
        out = pattern.sub(sub, out)
    return out[:180]


def is_error(text):
    head = text.lstrip()[:40].lower()
    return head.startswith("error") or head.startswith("refused") or "exceeded" in head


# 1,620 archived error rows carry no `name`, and they are ordinary tools — the tool is still in the
# first words of the refusal ("Error: edit_file: old_str not found") or in the policy JSON
# ({"program":"powershell"}). Without this, the per-tool table silently drops them.
INFER = re.compile(r"^\s*(?:Error:\s*)?([a-z][a-z0-9_]{2,20})(?::| is missing| is refused)")
PROGRAM = re.compile(r'"program"\s*:\s*"([a-z][a-z0-9_]{2,20})"')


def infer_tool(text):
    m = INFER.match(text or "") or PROGRAM.search((text or "")[:200])
    return m.group(1) if m else "unknown"


def scan(path):
    """Return (signature counter, rows read, tool rows, error rows, deduped dupes)."""
    sigs = Counter()
    seen = set()
    rows = tool_rows = err_rows = dupes = 0
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
            tool_rows += 1
            if not is_error(text):
                continue
            key = (rec.get("tool_call_id") or hashlib.sha1(text.encode("utf-8", "replace")).hexdigest(),
                   rec.get("name"), text[:200])
            if key in seen:
                dupes += 1
                continue
            seen.add(key)
            err_rows += 1
            tool = rec.get("name") or infer_tool(text)
            sigs[f"{tool}: {normalize(text)}"] += 1
    return sigs, rows, tool_rows, err_rows, dupes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=30)
    ap.add_argument("--out", default="docs/reports/ARCHIVE_ERROR_KINDS.md")
    args = ap.parse_args()

    names = sorted(n for n in os.listdir(SESS) if n.endswith(".jsonl"))
    grand = Counter()
    chats = Counter()
    files = rows = tool_rows = err_rows = dupes = 0
    for name in names:
        sigs, r, tr, er, d = scan(os.path.join(SESS, name))
        files += 1
        rows += r
        tool_rows += tr
        err_rows += er
        dupes += d
        for sig, count in sigs.items():
            grand[sig] += count
            chats[sig] += 1

    lines = [
        "# Mistake kinds already in the archive",
        "",
        f"Scanned {files} session logs: {rows:,} rows, {tool_rows:,} tool rows, "
        f"{err_rows:,} error rows ({dupes:,} duplicate rows dropped). "
        f"{len(grand)} distinct signatures.",
        "",
        "## By tool — which tool costs the most refused calls",
        "",
        "| Count | Chats | Tool |",
        "| --- | --- | --- |",
    ]
    by_tool = Counter()
    tool_chats = Counter()
    for sig, count in grand.items():
        tool = sig.split(":", 1)[0]
        by_tool[tool] += count
        tool_chats[tool] += 1
    for tool, count in by_tool.most_common(12):
        lines.append(f"| {count} | {tool_chats[tool]} signatures | {tool} |")
    lines += [
        "",
        "## Top signatures",
        "",
        "| Count | Chats | Signature |",
        "| --- | --- | --- |",
    ]
    for sig, count in grand.most_common(args.top):
        safe = sig.replace("|", "\\|")
        lines.append(f"| {count} | {chats[sig]} | {safe} |")
    body = "\n".join(lines) + "\n"

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with io.open(args.out, "w", encoding="utf-8") as fh:
        fh.write(body)

    # Windows stdout is cp1253: print only ascii-safe lines here.
    print(f"scanned={files} rows={rows} tool_rows={tool_rows} errors={err_rows} "
          f"dupes={dupes} signatures={len(grand)}")
    print(f"wrote {args.out}")
    print("--- by tool ---")
    for tool, count in by_tool.most_common(12):
        safe = tool.encode("ascii", "replace").decode("ascii")
        print(f"{count:5d} {safe}")
    print("--- top signatures ---")
    for sig, count in grand.most_common(args.top):
        safe = sig.encode("ascii", "replace").decode("ascii")
        print(f"{count:5d} {chats[sig]:4d}  {safe}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
