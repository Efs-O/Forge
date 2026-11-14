#!/usr/bin/env python
"""Decision-point replay: does ONE tips line change ONE decision?

Built for Phase 4 of docs/plans/AGENT_ERROR_TUNING_ROADMAP.md ("Decision-point replay").
Repeating a whole task is the expensive way to ask that question; this samples the single
logged decision instead: N calls with the line absent, N with it present, everything else
byte-identical, scored by this script and never by the model.

Three decision points, one per tips line the archive pass produced (commit 33c146f0):
  DP1 read_file with a guessed range      -- 86 refusals in 18 chats  (tips READ 1)
  DP2 apply_line_edits against a stale range -- 50 in 31 chats        (tips EDIT 2)
  DP3 read_tool_result pointed at a tool result by message_index -- 19 in 7 chats (FORENSICS 2)

Fidelity, stated up front (see the report): session logs record the request as a fingerprint
(`request_prefix`: system_hash, tools_hash, message COUNT), not the whole prompt, so the logged
request cannot be replayed byte for byte. What is replayed here is the decision point rebuilt
from the real logged messages and tool results: a short fixed system block, real tool
parameter names, and the conversation state as it stood immediately before the wrong call.
The two arms differ by exactly one line in the system block; the script asserts that.

Usage:
  python scripts/replay/replay_decision.py --samples 1            # smoke test, 6 calls
  python scripts/replay/replay_decision.py --samples 10           # the measurement, 60 calls
  python scripts/replay/replay_decision.py --kinds dp2 --samples 5
"""

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request
from datetime import datetime

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ENDPOINT = "http://127.0.0.1:8091/v1/chat/completions"
MODEL = "qwen3.8-flash-next-unsloth-v3.1-ud-iq3_xxs"
# The production sampling for this model, read from .forge/config.yaml -> engine block,
# so the spread measured here is the spread the real agent runs with.
SAMPLING = {"temperature": 0.6, "top_p": 0.95, "top_k": 20}
MAX_TOKENS = 400

BASE_SYSTEM = """You are a coding agent in a VS Code workspace, deciding your next single tool call.
Call exactly one tool. Do not explain.

Worked in this session so far:
- The user asked you to add a mistake record to `docs/CODING_STAGING.md`.
- You searched the workspace and found the file; the search printed hits at lines 1-6.
"""

TIPS_LINE = {
    "dp1": "1. `read_file` with a guessed `end_line` -> refused: start_line is past end_line. read whole, or take the range from a search hit, never from memory",
    "dp2": "2. `apply_line_edits` against a range read earlier in the turn -> refused: operation is stale, expected_lines do not match. re-read the range and edit in the same round",
    "dp3": "2. `read_tool_result message_index` to reread a tool result -> refused: that index is a tool result, use its tool_call_id. results take tool_call_id, prompts take message_index",
}

# Real parameter names and shapes, condensed (the shipped descriptions are long; the fields are
# the shipped ones). Recorded as a deviation in the report.
TOOLS = {
    "read_file": {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file's contents, optionally a line range.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "start_line": {"type": "integer"},
                    "end_line": {"type": "integer"},
                },
                "required": ["path"],
            },
        },
    },
    "apply_line_edits": {
        "type": "function",
        "function": {
            "name": "apply_line_edits",
            "description": "Replace one-based line ranges in one file atomically.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "operations": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "start_line": {"type": "integer"},
                                "end_line": {"type": "integer"},
                                "expected_lines": {"type": "array", "items": {"type": "string"}},
                                "replacement_lines": {"type": "array", "items": {"type": "string"}},
                            },
                            "required": ["expected_lines", "replacement_lines"],
                        },
                    },
                },
                "required": ["path", "operations"],
            },
        },
    },
    "edit_file": {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Replace the first occurrence of old_str with new_str.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_str": {"type": "string"},
                    "new_str": {"type": "string"},
                },
                "required": ["path", "old_str", "new_str"],
            },
        },
    },
    "read_tool_result": {
        "type": "function",
        "function": {
            "name": "read_tool_result",
            "description": "Search and read earlier text in this conversation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "tool_call_id": {"type": "string"},
                    "query": {"type": "string"},
                    "message_index": {"type": "integer"},
                },
            },
        },
    },
}


def system_for(kind: str, arm: str) -> str:
    """The only difference between the arms is one line inside the tips block."""
    if arm == "B":
        return BASE_SYSTEM + "\n## Coding tips (read before acting)\n" + TIPS_LINE[kind] + "\n"
    return BASE_SYSTEM


def dp1_messages():
    return [
        {
            "role": "user",
            "content": "Append a mistake record to `docs/CODING_STAGING.md`. It is a long file; "
            "work from the part that holds the records.",
        },
        {
            "role": "assistant",
            "content": "I will look at the file first.",
            "tool_calls": [
                {
                    "id": "call_s1",
                    "type": "function",
                    "function": {
                        "name": "search_code",
                        "arguments": json.dumps({"query": "tool:", "include": "docs/CODING_STAGING.md"}),
                    },
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_s1",
            "content": "docs/CODING_STAGING.md\n1:# Coding staging - one line per mistake\n2:\n3:tool: shell | error: ...\n"
            "4:tool: edit_file | error: ...\n5:tool: read_file | error: ...\n6:tool: none | error: \"none\"\n"
            "(file has 6 lines in total)",
        },
        {"role": "user", "content": "Now read the records part of that file and add yours."},
    ]


def dp2_messages():
    return [
        {
            "role": "user",
            "content": "Append a mistake record to `docs/CODING_STAGING.md`.",
        },
        {
            "role": "assistant",
            "content": "Reading the tail first.",
            "tool_calls": [
                {
                    "id": "call_r1",
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "arguments": json.dumps({"path": "docs/CODING_STAGING.md", "start_line": 1, "end_line": 6}),
                    },
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_r1",
            "content": "  1|# Coding staging - one line per mistake\n  2|\n  3:tool: shell | error: ...\n"
            "  4:tool: edit_file | error: ...\n  5|tool: read_file | error: ...\n  6|tool: none | error: \"none\"",
        },
        {
            "role": "assistant",
            "content": "Checking the file is still mine.",
            "tool_calls": [
                {
                    "id": "call_w1",
                    "type": "function",
                    "function": {
                        "name": "shell",
                        "arguments": json.dumps({"command": "wc -l docs/CODING_STAGING.md"}),
                    },
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_w1",
            "content": "exit 0\n8 docs/CODING_STAGING.md\n(note: a sibling chat appended two records since you read it)",
        },
        {"role": "user", "content": "Add my record now: the search that skipped a gitignored file."},
    ]


def dp3_messages():
    return [
        {
            "role": "user",
            "content": "Run the checker again.",
        },
        {
            "role": "assistant",
            "content": "Running it.",
            "tool_calls": [
                {
                    "id": "call_c7",
                    "type": "function",
                    "function": {"name": "shell", "arguments": json.dumps({"command": "python checker.py"})},
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_c7",
            "content": "exit 0\nPASS 12 checks\nbase was c782cdbd\nstaging lines: 3",
        },
        {
            "role": "assistant",
            "content": "It passed; I will note the base commit.",
            "tool_calls": [
                {
                    "id": "call_n2",
                    "type": "function",
                    "function": {"name": "shell", "arguments": json.dumps({"command": "git log --oneline -1"})},
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_n2",
            "content": "ca20b741 docs(owners): reword the permissions row",
        },
        {"role": "user", "content": "Show me that checker output again - the full one."},
    ]


MESSAGES = {"dp1": dp1_messages, "dp2": dp2_messages, "dp3": dp3_messages}
OFFERED = {"dp1": ["read_file"], "dp2": ["apply_line_edits", "edit_file", "read_file"], "dp3": ["read_tool_result"]}


def score(kind: str, call) -> str:
    """good / bad / other, by the rule the tips line states. Never by the model."""
    if not call:
        return "other:no_tool_call"
    name = call["name"]
    try:
        args = json.loads(call["arguments"] or "{}")
    except Exception:
        args = {}
    if kind == "dp1":
        if name != "read_file":
            return "other:" + name
        s, e = args.get("start_line"), args.get("end_line")
        if s is None and e is None:
            return "good:whole_file"
        if isinstance(s, int) and s <= 6 and (e is None or e <= 6):
            return "good:range_from_hit"
        return "bad:guessed_range"
    if kind == "dp2":
        if name == "read_file":
            return "good:reread_first"
        if name == "edit_file":
            return "good:edit_file"
        if name == "apply_line_edits":
            ops = args.get("operations") or []
            exp = ops[0].get("expected_lines") if ops and isinstance(ops[0], dict) else None
            return "bad:stale_apply" if exp else "bad:apply_without_expected"
        return "other:" + name
    if kind == "dp3":
        if name != "read_tool_result":
            return "other:" + name
        if args.get("tool_call_id"):
            return "good:tool_call_id"
        if args.get("message_index") is not None:
            return "bad:message_index"
        if args.get("query"):
            return "good:query"
        return "other:no_selector"
    raise ValueError(kind)


def one(kind: str, arm: str):
    sys_txt = system_for(kind, arm)
    payload = {
        "model": MODEL,
        "messages": [{"role": "system", "content": sys_txt}] + MESSAGES[kind](),
        "tools": [TOOLS[t] for t in OFFERED[kind]],
        "tool_choice": "auto",
        "max_tokens": MAX_TOKENS,
        **SAMPLING,
    }
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=300) as r:
        body = json.loads(r.read().decode("utf-8"))
    msg = (body.get("choices") or [{}])[0]
    calls = (msg.get("message") or {}).get("tool_calls") or []
    call = None
    if calls:
        fn = calls[0].get("function") or {}
        call = {"name": fn.get("name"), "arguments": fn.get("arguments")}
    return {
        "ms": int((time.time() - t0) * 1000),
        "finish": msg.get("finish_reason"),
        "call": call,
        "content": ((msg.get("message") or {}).get("content") or "")[:200],
        "verdict": score(kind, call),
        "system_sha": hashlib.sha256(sys_txt.encode("utf-8")).hexdigest()[:12],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=int, default=10)
    ap.add_argument("--kinds", default="dp1,dp2,dp3")
    ap.add_argument("--out", default="docs/reports/replay-results.json")
    a = ap.parse_args()
    kinds = [k.strip() for k in a.kinds.split(",") if k.strip()]

    # assert the arms differ by exactly the one line, before spending any call
    for k in kinds:
        a_txt, b_txt = system_for(k, "A"), system_for(k, "B")
        line = TIPS_LINE[k]
        assert line in b_txt and line not in a_txt, k
        assert b_txt.replace("\n## Coding tips (read before acting)\n" + line + "\n", "") == a_txt, k
    print("arms verified: each pair differs by exactly its one tips line")

    results = []
    for k in kinds:
        for arm in ("A", "B"):
            for i in range(a.samples):
                try:
                    r = one(k, arm)
                except Exception as e:  # a failed sample is recorded, not silently dropped
                    r = {"error": f"{type(e).__name__}: {e}"[:200], "verdict": "error"}
                r.update({"kind": k, "arm": arm, "sample": i})
                results.append(r)
                print(f"{k} arm={arm} #{i:02d} {r['verdict']:24s} "
                      f"{(r.get('call') or {}).get('name','')} "
                      f"{str((r.get('call') or {}).get('arguments',''))[:90]}")
                time.sleep(0.3)

    out = a.out
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"model": MODEL, "sampling": SAMPLING, "results": results}, f, indent=1)
    print("\n=== summary ===")
    for k in kinds:
        for arm in ("A", "B"):
            rows = [r for r in results if r["kind"] == k and r["arm"] == arm]
            good = sum(1 for r in rows if r["verdict"].startswith("good"))
            bad = sum(1 for r in rows if r["verdict"].startswith("bad"))
            other = len(rows) - good - bad
            print(f"{k} arm={arm} (tips line {'PRESENT' if arm == 'B' else 'absent'}) "
                  f"n={len(rows)} good={good} bad={bad} other={other}")
    print("raw results:", out)


if __name__ == "__main__":
    main()
