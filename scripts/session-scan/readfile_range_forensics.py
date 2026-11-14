"""Forensics on the biggest call-burner in the corpus: read_file asked to start past the end.

WHY THIS EXISTS
  T30 (recovery_cost.py) measured `read_file: start_line N is past end_line N` as 90 failures and
  394 tool calls burned - the single largest total waste in every session log on the machine. The
  lab (T32, 5 reps) showed the naive shape cannot even produce it (an over-long end_line is clamped
  silently) and that one rep recovered by asking for line 13 of a 12-line file, i.e. it misread the
  length the refusal prints. That produced a recommendation: reword "(N lines)" to "the last line
  is N". A recommendation is only worth landing if the PRODUCTION failures are actually off-by-one
  mistranslations and not "chunk starts far past the end" - and this script is the cheap way to tell,
  straight from the logs, with no model in the loop.

WHAT IT READS
  ~/.forge/sessions/*.jsonl. A failure is a role:"tool" row whose content matches one of the two
  refusal texts. The start_line the model actually sent is taken from the assistant row that carries
  the matching tool_call_id (the tool row itself does not echo arguments). Test chats listed in
  docs/reports/session-scan/test-chats.exclude are skipped, so the lab's own probes do not pollute
  the population they are meant to describe.

WHAT IT PRINTS
  The distribution of `start_line - real_length`. A cluster at +1 means the model cannot read the
  refusal's "(N lines)" as "the last line is N" and the reword is justified. A long tail at +hundreds
  means the model is guessing chunk boundaries and no wording change will help.

Usage:  python scripts/session-scan/readfile_range_forensics.py
"""

import collections
import glob
import io
import json
import os
import re
import sys

SESS = os.path.expanduser("~/.forge/sessions")
FORGE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXCLUDE = os.path.join(FORGE, "docs", "reports", "session-scan", "test-chats.exclude")

# Both refusal texts the tool can throw (src/tools/readFileRange.ts).
REFUSAL = re.compile(
    r"start_line (\d+) is past (?:the end of the file|end_line \d+) \((\d+) lines?\)"
)
# The argument the model sent, as it appears in the assistant row's tool-call arguments.
START_ARG = re.compile(r'"start_line":\s*(\d+)')


def excluded_prefixes():
    out = set()
    if not os.path.exists(EXCLUDE):
        return out
    for line in io.open(EXCLUDE, encoding="utf-8", errors="replace"):
        line = line.strip()
        if line and not line.startswith("#"):
            out.add(line.split()[0].lower())
    return out


def rows(path):
    with io.open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                yield json.loads(line)
            except Exception:
                continue


def analyse(path, skip):
    """Yield (start_line_sent, real_length, start_line_argument) per refusal in this chat."""
    name = os.path.basename(path).split(".")[0][:8].lower()
    if name in skip:
        return
    # tool_call_id -> the start_line the model asked for, from the assistant row that called it.
    sent = {}
    pending = []
    for rec in rows(path):
        if not isinstance(rec, dict):
            continue
        if rec.get("role") == "assistant":
            for call in rec.get("tool_calls") or []:
                cid = call.get("id")
                args = call.get("arguments") or call.get("input") or {}
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        args = {}
                if cid and isinstance(args, dict) and "start_line" in args:
                    sent[cid] = args.get("start_line")
                if cid and call.get("name") == "read_file":
                    raw = json.dumps(args, ensure_ascii=False)
                    m = START_ARG.search(raw)
                    if m:
                        sent[cid] = int(m.group(1))
        if rec.get("role") == "tool":
            text = rec.get("content")
            if isinstance(text, list):
                text = " ".join(x.get("text", "") for x in text if isinstance(x, dict))
            m = REFUSAL.search(str(text or ""))
            if m:
                pending.append((rec.get("tool_call_id"), int(m.group(1)), int(m.group(2))))
    for cid, start_in_text, real in pending:
        yield (start_in_text, real, sent.get(cid))


def main():
    skip = excluded_prefixes()
    hits = []
    chats = set()
    for path in sorted(glob.glob(os.path.join(SESS, "*.jsonl"))):
        found = list(analyse(path, skip))
        if found:
            chats.add(os.path.basename(path)[:8])
            hits.extend(found)
    print(f"chats: {len(chats)} | refusals parsed: {len(hits)} | test chats skipped: {len(skip)}")
    if not hits:
        print("No production refusals found; nothing to conclude.")
        return 0
    off = collections.Counter(start - real for start, real, _ in hits)
    print("start_line minus the real length the refusal printed:")
    for delta, count in off.most_common(15):
        print(f"  +{delta}: {count}")
    one = off.get(1, 0)
    far = sum(c for d, c in off.items() if d > 1)
    print(f"off-by-exactly-one: {one} ({100 * one // len(hits)}%) | further past the end: {far}")
    paired = [h for h in hits if h[2] is not None]
    if paired:
        agree = sum(1 for start, real, arg in paired if int(arg) == start)
        print(f"argument-vs-message agreement: {agree}/{len(paired)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
