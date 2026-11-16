"""Scan Forge session logs for approval-timeout results and report the minutes each one quotes.

Answers one question for BUG-24: is the number in "nobody answered the approval for X
within N min" ever anything other than the configured value? Rows are deduped by content
(session logs carry duplicate rows), and each hit is dated by build.
"""

import hashlib
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

SESSIONS = Path.home() / ".forge" / "sessions"
PATTERN = re.compile(r"nobody answered the approval for (\w[\w.]*) within (\d+) min")
CARRIED = re.compile(r"needs the approval that went unanswered earlier in this turn \((\d+) min\)")
EARLIER = re.compile(r"an approval earlier in this turn went unanswered for (\d+) min")

builds = {}
hits = []
seen = set()
for name in os.listdir(SESSIONS):
    if not name.endswith(".jsonl"):
        continue
    path = os.path.join(SESSIONS, name)
    build = builds.get(name, "?")
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            if row.get("session_start"):
                build = row["session_start"].get("forge_version", "?")
                builds[name] = build
            role = row.get("role")
            if role not in ("tool", "assistant"):
                continue
            content = row.get("content")
            if not isinstance(content, str):
                continue
            # Only the tool's own result row counts as evidence; an assistant quoting
            # the same sentence is a copy, not a second expiry.
            if role != "tool":
                continue
            for regex, kind, minute_group in (
                (PATTERN, "expired", 2),
                (CARRIED, "carried", 1),
                (EARLIER, "earlier", 1),
            ):
                for match in regex.finditer(content):
                    tool = match.group(1) if regex is PATTERN else "?"
                    minutes = int(match.group(minute_group))
                    key = hashlib.sha1(
                        f"{name}|{row.get('tool_call_id')}|{kind}|{tool}|{minutes}|{content[:80]}".encode()
                    ).hexdigest()
                    if key in seen:
                        continue
                    seen.add(key)
                    hits.append(
                        {
                            "chat": name[:8],
                            "build": build,
                            "kind": kind,
                            "tool": tool,
                            "minutes": minutes,
                            "ts": row.get("timestamp_ms"),
                        }
                    )

print(f"tool-result rows quoting an approval timeout: {len(hits)} (deduped)")
print("\n--- minutes quoted, by kind ---")
by_kind = defaultdict(Counter)
for hit in hits:
    by_kind[hit["kind"]][hit["minutes"]] += 1
for kind, counter in by_kind.items():
    print(f"{kind}: " + ", ".join(f"{m}min x{n}" for m, n in sorted(counter.items())))

print("\n--- minutes quoted, by build ---")
by_build = defaultdict(Counter)
for hit in hits:
    by_build[hit["build"]][hit["minutes"]] += 1
for build, counter in sorted(by_build.items()):
    print(f"{build}: " + ", ".join(f"{m}min x{n}" for m, n in sorted(counter.items())))

print("\n--- the 1-minute rows ---")
ones = [h for h in hits if h["minutes"] == 1]
for hit in ones[:25]:
    print(hit["chat"], hit["build"], hit["kind"], hit["tool"], hit["ts"])
print(f"(total 1-minute rows: {len(ones)})")
