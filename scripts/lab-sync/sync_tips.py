"""Re-inject docs/CODING_TIPS.md into the FORGE.md copies, between the two markers.

The instruction files carry the tips table inline so an agent that forgets to read
the file still gets the syntax rules (owner, 2026-11-13). The FILE stays the thing
to edit; this script is how the copies keep up. It rewrites the whole marked
section, so a marker or preamble line that a hand edit mangled is restored rather
than silently lost — which is how the 2026-11-13 sync ended up deleting the opening
comment and the "you do not need to read the file" line.

Usage: python scripts/lab-sync/sync_tips.py [extra FORGE.md paths...]
"""

import io
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

TIPS = "docs/CODING_TIPS.md"
HEAD = "## Coding tips — inline copy (temporary, owner 2026-11-13)"
OPEN = (
    "<!-- TIPS-INJECT-START — delete from this marker to TIPS-INJECT-END to revert.\n"
    "This is a copy of `docs/CODING_TIPS.md`, injected into the instructions so the table is in the\n"
    "prompt even when an agent forgets to read the file. The file stays the thing to edit; re-copy\n"
    "after every tips commit. -->\n"
    "\n"
    "You do **not** need to read `docs/CODING_TIPS.md` — the whole table is below, and it is the same\n"
    "rules the file holds. Record a new mistake in the **file**, then re-copy it here.\n"
)
CLOSE = "TIPS-INJECT-END -->"

TARGETS = ["FORGE.md", "../Forge-lab2/FORGE.md"] + sys.argv[1:]


def section(tips: str) -> str:
    return f"{HEAD}\n\n{OPEN}\n{tips.rstrip()}\n{CLOSE}\n"


def main() -> int:
    tips = io.open(TIPS, encoding="utf-8").read()
    for target in TARGETS:
        text = io.open(target, encoding="utf-8").read()
        if HEAD not in text or CLOSE not in text:
            print(f"{target}: SKIP (no marked section)")
            continue
        start = text.index(HEAD)
        end = text.index(CLOSE) + len(CLOSE)
        rewritten = text[:start] + section(tips) + text[end:]
        io.open(target, "w", encoding="utf-8", newline="").write(rewritten)
        print(f"{target}: {os.path.getsize(target)} bytes, {len(tips.splitlines())} tips lines")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
