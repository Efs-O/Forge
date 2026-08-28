#!/usr/bin/env python3
"""Token-efficiency analyzer for Forge session logs.

Answers one question: where do the tokens actually go in an agentic turn?

The headline number is AMPLIFICATION -- tokens sent divided by unique content
produced. A tool result created at round 3 is re-tokenized at rounds 4..N, so
the cost of a result is its size TIMES the rounds it survives, not its size.
Ranking tools by raw bytes hides this completely.

Usage:
    python scripts/analyze-session-tokens.py [--sessions DIR]

Caveat the output repeats: resumed sessions re-persist prior history, so
absolute totals over-count. The ratios and the per-tool ranking are the
reliable output. See docs/plans/TOKEN_EFFICIENCY_PLAN.md.
"""

import argparse
import glob
import json
import os
from collections import Counter

# Forge's own measured figure for this workload (src/util/contextBudget.ts).
CHARS_PER_TOKEN = 3.1
# SYSTEM_AND_TEMPLATE_OVERHEAD -- invisible to a message walk, paid every round.
SYSTEM_OVERHEAD_TOKENS = 900


def prompt_chars(row):
    """Chars this row contributes to every later round's prompt.

    Mirrors estimateTokens(): content plus tool_calls JSON. `reasoning` is
    excluded because it is never rendered back into the prompt.
    """
    content = row.get("content")
    total = 0
    if isinstance(content, str):
        total += len(content)
    elif isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                total += len(part.get("text", ""))
    if row.get("tool_calls") and not content:
        total += len(json.dumps(row["tool_calls"]))
    return total


def load(path):
    rows = []
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("type") == "session_start":
                continue
            rows.append(row)
    return rows


MAX_SNIPPET_CHARS = 400  # src/tools/searchSnippet.ts
MAX_SEARCH_RESULT_CHARS = 60_000  # src/tools/searchSnippet.ts


def capped_search_result(text, query):
    """What `search_code` would return today for a result recorded before the cap.

    Mirrors capSnippetLine + capResultText closely enough for a token count.
    Submatch offsets are not in the log, so the match is located by searching
    for the query -- that only shifts WHICH window is kept, never its size,
    and size is what this measures.
    """
    out = []
    for line in text.split("\n"):
        if len(line) <= MAX_SNIPPET_CHARS:
            out.append(line)
            continue
        found = line.find(query) if query else -1
        centre = found if found >= 0 else 0
        half = MAX_SNIPPET_CHARS // 2
        start = max(0, min(centre - half, len(line) - MAX_SNIPPET_CHARS))
        out.append(f"…{line[start:start + MAX_SNIPPET_CHARS]}… [line is {len(line)} chars]")
    joined = "\n".join(out)
    return joined[:MAX_SEARCH_RESULT_CHARS] if len(joined) > MAX_SEARCH_RESULT_CHARS else joined


def is_complete_read(content):
    """Mirrors isCompleteRead() in src/agent/staleReadSupersede.ts."""
    if not content:
        return False
    if content.startswith("Error") or content.startswith("[Forge:"):
        return False
    return "[truncated by " not in content


def counterfactual(session_dir, files):
    """Tokens the two shipped fixes remove from these very sessions.

    Immune to task mix: it re-runs each recorded turn under both rule sets and
    diffs them, rather than comparing different work to different work.
    """
    search_before = search_after = 0
    stale_before = stale_after = 0
    worst_before = worst_after = 0

    for path in files:
        rows = load(path)
        starts = [i for i, r in enumerate(rows) if r.get("role") == "user"] + [len(rows)]
        for begin, end in zip(starts, starts[1:]):
            turn = rows[begin:end]
            total_rounds = sum(1 for r in turn if r.get("tool_calls")) + 1
            round_index = 0
            pending = []
            reads = []  # (position in `reads`, path, chars, rounds_left)

            for row in turn:
                if row.get("tool_calls"):
                    round_index += 1
                    pending = [(c.get("name", "?"), c.get("input") or {}) for c in row["tool_calls"]]
                    continue
                if row.get("role") != "tool" or not pending:
                    continue
                name, args = pending.pop(0)
                content = row.get("content")
                if not isinstance(content, str):
                    continue
                weight = max(1, total_rounds - round_index)

                if name == "search_code":
                    after = capped_search_result(content, str(args.get("query", "")))
                    search_before += len(content) * weight
                    search_after += len(after) * weight
                    worst_before = max(worst_before, len(content))
                    worst_after = max(worst_after, len(after))
                elif name == "read_file" and is_complete_read(content):
                    target = args.get("path") or args.get("file_path")
                    if not isinstance(target, str):
                        continue
                    reads.append([target.replace("\\", "/"), len(content), weight])

            latest = {}
            for index, (target, _, _) in enumerate(reads):
                latest[target] = index
            for index, (target, size, weight) in enumerate(reads):
                stale_before += size * weight
                if latest[target] == index:
                    stale_after += size * weight
                else:
                    stale_after += 120 * weight  # the supersede notice

    tok = lambda chars: chars / CHARS_PER_TOKEN
    print("\n=== counterfactual: what the shipped fixes remove from THESE sessions ===")
    print(f"{'':22s} {'before kTok':>12s} {'after kTok':>11s} {'saved':>9s}")
    for label, before, after in (
        ("search_code cap", search_before, search_after),
        ("superseded read_file", stale_before, stale_after),
    ):
        pct = 100 * (before - after) / before if before else 0.0
        print(f"{label:22s} {tok(before)/1000:12.1f} {tok(after)/1000:11.1f} {pct:8.1f}%")
    total_before = search_before + stale_before
    total_after = search_after + stale_after
    if total_before:
        print(f"{'combined':22s} {tok(total_before)/1000:12.1f} {tok(total_after)/1000:11.1f} "
              f"{100*(total_before-total_after)/total_before:8.1f}%")
    print(f"\nlargest single search_code result: {tok(worst_before):,.0f} -> {tok(worst_after):,.0f} tokens")


def analyze(session_dir, files=None, show_counterfactual=False):
    if files is None:
        files = glob.glob(os.path.join(session_dir, "*.jsonl"))
    unique_chars = sent_chars = 0
    rounds_seen = []
    tool_raw = Counter()
    tool_resend = Counter()
    tool_calls = Counter()
    tool_max = Counter()
    rereads = duplicate_calls = read_file_calls = 0
    openings = {}

    for path in files:
        rows = load(path)
        for row in rows:
            if row.get("role") == "user":
                openings.setdefault(str(row.get("content"))[:80], set()).add(path)
                break

        starts = [i for i, r in enumerate(rows) if r.get("role") == "user"] + [len(rows)]
        for begin, end in zip(starts, starts[1:]):
            turn = rows[begin:end]
            total_rounds = sum(1 for r in turn if r.get("tool_calls")) + 1
            rounds_seen.append(total_rounds)

            running = turn_sent = 0
            round_index = 0
            pending = []
            seen_args = set()
            read_paths = set()

            for row in turn:
                running += prompt_chars(row)
                if row.get("tool_calls"):
                    round_index += 1
                    # Session logs drop the tool NAME from result rows, so pair
                    # positionally against the call that produced them.
                    pending = [(c.get("name", "?"), c.get("input") or {}) for c in row["tool_calls"]]
                    for name, args in pending:
                        tool_calls[name] += 1
                        key = (name, json.dumps(args, sort_keys=True))
                        if key in seen_args:
                            duplicate_calls += 1
                        seen_args.add(key)
                    turn_sent += running + SYSTEM_OVERHEAD_TOKENS * CHARS_PER_TOKEN
                elif row.get("role") == "tool" and pending:
                    name, args = pending.pop(0)
                    size = prompt_chars(row)
                    tool_raw[name] += size
                    tool_resend[name] += size * max(0, total_rounds - round_index)
                    tool_max[name] = max(tool_max[name], size)
                    if name == "read_file":
                        read_file_calls += 1
                        target = args.get("path") or args.get("file_path")
                        if target in read_paths:
                            rereads += 1
                        read_paths.add(target)

            turn_sent += running + SYSTEM_OVERHEAD_TOKENS * CHARS_PER_TOKEN
            unique_chars += running
            sent_chars += turn_sent

    tok = lambda chars: chars / CHARS_PER_TOKEN
    print(f"sessions            : {len(files)}")
    print(f"turns               : {len(rounds_seen)}")
    print(f"unique content      : {tok(unique_chars)/1e6:.2f} M tokens")
    print(f"actually sent       : {tok(sent_chars)/1e6:.2f} M tokens")
    print(f"AMPLIFICATION       : {sent_chars/max(1, unique_chars):.2f} x")
    if rounds_seen:
        ordered = sorted(rounds_seen)
        p90 = ordered[int(len(ordered) * 0.9)]
        print(f"rounds/turn         : median {ordered[len(ordered)//2]}  p90 {p90}  max {max(ordered)}")

    shared = sum(len(v) for v in openings.values() if len(v) > 1)
    if shared:
        print(f"\nNOTE: {shared} of {len(files)} sessions share an opening prompt (resume")
        print("copies). Absolute totals over-count; ratios and rankings do not.")

    print(f"\n{'tool':26s} {'calls':>6s} {'raw kTok':>9s} {'resend kTok':>12s} {'avg':>7s} {'max':>9s}")
    for name, resend in tool_resend.most_common(15):
        calls = max(1, tool_calls[name])
        print(
            f"{name:26s} {tool_calls[name]:6d} {tok(tool_raw[name])/1000:9.1f} "
            f"{tok(resend)/1000:12.1f} {tok(tool_raw[name])/calls:7.0f} {tok(tool_max[name]):9.0f}"
        )

    total_resend = sum(tool_resend.values())
    top3 = sum(w for _, w in tool_resend.most_common(3))
    print(f"\ntool-result resend cost: {tok(total_resend)/1e6:.2f} M tokens")
    print(f"top 3 tools           : {100*top3/max(1, total_resend):.0f}% of it")
    if read_file_calls:
        print(f"re-read same path/turn: {rereads}/{read_file_calls} ({100*rereads/read_file_calls:.1f}%)")
    print(f"duplicate tool calls  : {duplicate_calls}")

    if show_counterfactual:
        counterfactual(session_dir, files)


def select_files(session_dir, since=None, newest=None):
    """Session files, optionally restricted to a fresh cohort.

    `--since` takes an ISO date; `--newest N` takes the N most recently
    modified. Either one isolates post-fix sessions from the baseline so the
    two are never silently averaged together.
    """
    files = glob.glob(os.path.join(session_dir, "*.jsonl"))
    if since:
        import datetime

        cutoff = datetime.datetime.fromisoformat(since).timestamp()
        files = [f for f in files if os.path.getmtime(f) >= cutoff]
    if newest:
        files = sorted(files, key=os.path.getmtime)[-newest:]
    return files


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--sessions",
        default=os.path.expanduser("~/.forge/sessions"),
        help="Directory of Forge session JSONL logs.",
    )
    parser.add_argument("--since", help="Only sessions modified on/after this ISO date.")
    parser.add_argument("--newest", type=int, help="Only the N most recently modified sessions.")
    parser.add_argument(
        "--counterfactual",
        action="store_true",
        help="Also report what the shipped fixes remove from these same sessions.",
    )
    args = parser.parse_args()
    selected = select_files(args.sessions, args.since, args.newest)
    if not selected:
        raise SystemExit("No session files matched.")
    analyze(args.sessions, selected, args.counterfactual)
