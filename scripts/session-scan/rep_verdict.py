#!/usr/bin/env python3
"""Verdict numbers for one student rep, straight from its session log.

Prints what the log supports objectively — rounds, tool calls, refusals with their row
numbers, repeated identical calls, empty-result searches — so the supervisor's judgement of
the mistake *kinds* sits next to numbers that are not a judgement. Rows are deduped first:
a row is the same row if its content matches with `timestamp_ms` removed.

Usage: python scripts/session-scan/rep_verdict.py <chat-id-prefix>
"""
import hashlib
import io
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
from collections import Counter

SESS = os.path.expanduser("~/.forge/sessions")
MASK = [(re.compile(r"call_[0-9a-f]+", re.I), "ID"),
        (re.compile(r"\b[0-9a-f]{16,}\b"), "ID"),
        (re.compile(r"\b\d[\d.,]*\b"), "N")]

# A shell refusal is a line that *starts* with the failure word, not any line that mentions one.
SHELL_ERR = re.compile(r"(?im)^(error|fatal)\b|did not match any file|is refused|command not found")


def norm(text):
    out = " ".join((text or "").split())
    for pat, sub in MASK:
        out = pat.sub(sub, out)
    return out[:140]


def is_error(text, name=None):
    """Was this tool result a refusal or a failure?

    The first 40 characters alone are not enough, and rep 05 proved it: a `search_code` refusal arrives
    inside square brackets, and a shell refusal arrives behind the tool's own `exit 1 · 0.1 s` header, so
    both read as clean results. Match the shapes that actually occur, and keep the two kinds apart so a
    non-zero exit the model handled on purpose can be told from a refusal.
    """
    body = text or ""
    head = body.lstrip()[:40].lower()
    if head.startswith("error") or head.startswith("refused") or "is refused" in head:
        return "refusal"
    # `No symbol provider answered … may still be starting`: a language-service cold start,
    # which the model must retry. `No language service reported` is the same idea but it also
    # closes an ordinary write_file result, so only trust it when the call was `code_intel`.
    if re.search(r"no symbol provider answered", body[:200], re.I) or (
        name == "code_intel" and re.search(r"no language service reported", body[:200], re.I)
    ):
        return "failure"
    # `[offset 21 is past the end: "Schema" matched 1 file in total...]`
    if head.startswith("[") and re.search(
        r"is past the end|refus|invalid|cannot|did not match|no such file", body[:200], re.I
    ):
        return "refusal"
    # `exit 1 · 0.1 s\nerror: pathspec 'docs/CODING_STAGING.md' did not match any file(s) known to git`
    m = re.match(r"^exit (\d+)", head)
    if m and m.group(1) != "0":
        # A non-zero exit is only a *candidate*: `git config core.hooksPath` exits 1 when the key is
        # unset, and that is an answer, not a failure. Call it a refusal only when a line actually
        # starts with one — searching for the word "error" anywhere matched `--- sidebar errors: 0`.
        return "refusal(shell)" if SHELL_ERR.search(body[:400]) else "nonzero-exit"
    return None


def main():
    prefix = sys.argv[1]
    paths = [os.path.join(SESS, n) for n in os.listdir(SESS) if n.lower().startswith(prefix.lower())]
    if not paths:
        print(f"no log for {prefix}")
        return 1
    path = max(paths, key=os.path.getmtime)
    raw, seen = [], set()
    dupes = 0
    for line in io.open(path, encoding="utf-8", errors="replace"):
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if not isinstance(rec, dict):
            continue
        body = {k: v for k, v in rec.items() if k != "timestamp_ms"}
        key = hashlib.sha1(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        if key in seen:
            dupes += 1
            continue
        seen.add(key)
        raw.append(rec)

    rows = len(raw)
    tool_rows = [r for r in raw if r.get("role") == "tool"]
    rounds = sum(1 for r in raw if "params_hash" in r)
    assistant = sum(1 for r in raw if r.get("role") == "assistant")
    errors = [(i, r, is_error(r.get("content"), r.get("name"))) for i, r in enumerate(raw)
              if r.get("role") == "tool" and is_error(r.get("content"), r.get("name"))]

    calls = Counter()
    for r in raw:
        for tc in (r.get("tool_calls") or []):
            fn = tc.get("function") or {}
            # The log writes {"id","name","args"} at the top of the entry; `function.arguments`
            # is the OpenAI-shaped form. Read whichever one this row actually carries.
            name = tc.get("name") or fn.get("name")
            args = tc["input"] if "input" in tc else (tc.get("raw_arguments")
                                                      or tc.get("args") or fn.get("arguments"))
            calls[(name, norm(json.dumps(args, ensure_ascii=False)))] += 1
    repeats = {k: v for k, v in calls.items() if v > 1}

    empty = []
    for i, r in enumerate(raw):
        if r.get("role") != "tool":
            continue
        text = str(r.get("content") or "")
        if re.search(r"(^|\n)(0 matches|no matches|No matches found|0 results)", text.strip()[:200]):
            empty.append((i, r.get("name"), norm(text)))

    print(f"log={os.path.basename(path)}")
    print(f"rows={rows} (dupes dropped {dupes})  model calls (rounds)={rounds}  "
          f"assistant rows={assistant}  tool rows={len(tool_rows)}")
    kinds = Counter(k for _, _, k in errors)
    print(f"refused/error tool rows={len(errors)}  "
          f"{dict(sorted(kinds.items())) if kinds else '{}'}  "
          f"distinct repeated calls={len(repeats)}")
    print("\n--- errors, with the row number for provenance ---")
    for i, r, kind in errors:
        print(f"row {i:4d}  [{kind}] {r.get('name')}: {norm(r.get('content'))}")
    print("\n--- identical calls issued more than once ---")
    for (name, args), n in sorted(repeats.items(), key=lambda kv: -kv[1])[:10]:
        print(f"{n:3d}x  {name} {args}")
    print("\n--- tool calls that returned nothing ---")
    for i, name, text in empty[:10]:
        print(f"row {i:4d}  {name}: {text}")
    print("\n--- last assistant message (its own report) ---")
    for r in reversed(raw):
        if r.get("role") == "assistant":
            content = r.get("content")
            if isinstance(content, list):
                content = " ".join(x.get("text", "") for x in content if isinstance(x, dict))
            print((content or "")[:1200])
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
