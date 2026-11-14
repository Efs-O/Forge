"""Measure how much the injected instruction sources say the same thing twice.

Phase 3 of docs/plans/INSTRUCTION_AND_TOOL_TEXT_STREAMLINE_PLAN.md wants a guard
that fails when one operational rule lives in two injected sources, and a
near-duplicate detector over tips entries. Before picking a threshold, measure
what today's text actually scores: set the gate below the worst existing pair and
the tree fails on day one; set it above the real duplicates and it guards nothing.

Sources compared: the shipped prompt (execute.njk), the starter project file
(ForgeInstructionsLoader.ts), the tips table (docs/CODING_TIPS.md), and FORGE.md
prose (its marked inline tips copy is excluded -- that copy is a copy by design).

Usage: python scripts/session-scan/text_overlap.py
"""

import io
import re
import sys
from itertools import combinations

sys.stdout.reconfigure(encoding="utf-8")

SOURCES = {
    "prompt": "config/templates/builtin/execute.njk",
    "starter": "src/llm/ForgeInstructionsLoader.ts",
    "tips": "docs/CODING_TIPS.md",
    "project": "FORGE.md",
}

MARK = "## Coding tips — inline copy"


def norm(text: str) -> str:
    """Lowercase, drop markup, collapse whitespace: what remains is the claim."""
    text = text.replace("`", "").replace("**", "")
    text = re.sub(r"[-–—\"“”’'()⟨⟩\[\]{}|,;:.!?/\\]", " ", text.lower())
    return re.sub(r"\s+", " ", text).strip()


def tokens(text: str) -> set:
    return {w for w in norm(text).split() if len(w) > 3}


def lines_of(name: str, raw: str) -> list:
    """One claim per bullet / tips entry / starter rule line."""
    out = []
    if name == "starter":
        m = re.search(r"const STARTER_CONTENT = `(.*?)`;", raw, re.S)
        if not m:
            return out
        raw = m.group(1)
    if name == "project":
        raw = raw.split(MARK)[0]
    for line in raw.splitlines():
        s = line.strip()
        s = re.sub(r"^\d+\.\s+", "", s)
        if not (s.startswith("- ") or re.match(r"^\d+\.\s", line.strip())):
            continue
        s = s[2:] if s.startswith("- ") else s
        if len(tokens(s)) < 8:
            continue
        out.append(s)
    return out


def jaccard(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def main() -> int:
    claims = {}
    for name, path in SOURCES.items():
        try:
            raw = io.open(path, encoding="utf-8").read()
        except OSError:
            print(f"{name}: missing, skipped")
            continue
        claims[name] = lines_of(name, raw)
        print(f"{name}: {len(claims[name])} claims")

    print("\n=== best pair per source pairing (co-injected pairs only) ===")
    # The starter is the auto-created project file, so a repo that has FORGE.md never
    # injects both: starter <-> project is drift, not a per-turn cost. Everything else
    # can land in one prompt, so those pairs are the ones the guard must fail on.
    skip = {("project", "starter"), ("starter", "project")}
    cross = []
    for (n1, c1), (n2, c2) in combinations(claims.items(), 2):
        if (n1, n2) in skip:
            print(f"{n1} vs {n2}: skipped (never co-injected)")
            continue
        best = []
        for a in c1:
            ta = tokens(a)
            for b in c2:
                s = jaccard(ta, tokens(b))
                if s >= 0.40:
                    best.append((s, a, b))
        best.sort(reverse=True)
        print(f"{n1} vs {n2}: {len(best)} pairs at or above 0.40")
        for s, a, b in best[:3]:
            print(f"   {s:.2f}\n     A: {a[:100]}\n     B: {b[:100]}")
        cross.extend((s, n1, n2) for s, _, _ in best)
    print(f"({len(cross)} co-injected pairs at or above 0.40)")

    print("\n=== tips-internal near-duplicates ===")
    tips = claims.get("tips", [])
    pairs = []
    for i, a in enumerate(tips):
        ta = tokens(a)
        for b in tips[i + 1 :]:
            s = jaccard(ta, tokens(b))
            if s >= 0.35:
                pairs.append((s, a, b))
    for s, a, b in sorted(pairs, reverse=True)[:12]:
        print(f"{s:.2f}\n   A: {a[:110]}\n   B: {b[:110]}")
    print(f"({len(pairs)} tips pairs at or above 0.35)")

    print("\n=== exact normalized sentence shared by two sources ===")
    for (n1, c1), (n2, c2) in combinations(claims.items(), 2):
        shared = {norm(c) for c in c1} & {norm(c) for c in c2}
        for s in shared:
            if len(s.split()) >= 6:
                print(f"{n1} == {n2}: {s[:120]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
