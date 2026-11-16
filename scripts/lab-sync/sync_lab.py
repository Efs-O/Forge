"""Mirror the tool-test lab from Forge into the test repo (one-way, Forge -> Qwen_fine_tuning).

Run after every ledger update and every fix. Copies:
  scripts/session-scan/**        -> <target>/lab/session-scan/   (the scan tooling)
  docs/reports/**                -> <target>/lab/reports/        (ledger, scan reports, scan folders, exclude file)
Never deletes anything in the target. Files already in the target that are NOT part
of the lab are left untouched. Print-only on error, exit 0 unless nothing copied at all.
"""

import os
import shutil
import sys
from pathlib import Path

FORGE = Path(__file__).resolve().parents[2]  # the repo this script lives in
_target = os.environ.get("FORGE_LAB_TARGET")
if not _target:
    print("Set FORGE_LAB_TARGET to the lab checkout to sync into.", file=sys.stderr)
    sys.exit(1)
TARGET = Path(_target)
MIRROR = TARGET / "lab"

# Only lab files are mirrored (the owner's old report folders stay out).
# Top-level docs/reports entries allowed by name, plus the SESSION_SCAN_*.md family.
REPORT_DIRS = {"session-scan", "tool-tests"}
REPORT_FILES = {"TOOL_TEST_LEDGER.md"}
REPORT_PREFIXES = ("SESSION_SCAN_",)
MAX_FILE_BYTES = 5_000_000
# Never walked: junk, and the junk that lives inside a leftover CI worktree.
PRUNE_DIRS = {"node_modules", "__pycache__", ".git", ".venv", "venv"}


def _walk(root: Path):
    """Yield files under root, pruning junk dirs and surviving an unreadable one.

    rglob was replaced (2026-11-09 00:50) because a leftover CI worktree under
    docs/reports holds a node_modules/.cache chain past the Windows path limit:
    the walk itself raised OSError [WinError 1921] and killed the whole sync, so
    nothing mirrored. A walk error on one directory must cost that directory only.
    """
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as handle:
                entries = list(handle)
        except OSError as exc:
            print(f"skip (unreadable dir): {current}: {exc}")
            continue
        for entry in entries:
            path = Path(entry.path)
            if entry.is_dir():
                if entry.name not in PRUNE_DIRS:
                    stack.append(path)
            elif entry.is_file():
                yield path


def _allowed_reports(rel: Path) -> bool:
    if rel.parts[0] in REPORT_DIRS:
        return True
    if len(rel.parts) == 1 and rel.name in REPORT_FILES:
        return True
    if len(rel.parts) == 1 and rel.name.startswith(REPORT_PREFIXES):
        return True
    return False

PAIRS = [
    (FORGE / "scripts" / "session-scan", MIRROR / "session-scan"),
    (FORGE / "docs" / "reports", MIRROR / "reports"),
]


def main() -> int:
    if not TARGET.is_dir():
        print(f"target missing: {TARGET}")
        return 1
    copied = skipped = 0
    for src_root, dst_root in PAIRS:
        if not src_root.is_dir():
            print(f"source missing, skipping: {src_root}")
            continue
        for src in sorted(_walk(src_root)):
            if not src.is_file():
                continue
            if src.suffix.lower() in {".pyc"} or "__pycache__" in src.parts:
                continue
            rel = src.relative_to(src_root)
            if src_root.name == "reports" and not _allowed_reports(rel):
                continue
            if src.stat().st_size > MAX_FILE_BYTES:
                skipped += 1
                print(f"skip (too large): {src}")
                continue
            dst = dst_root / rel
            try:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                copied += 1
            except OSError as exc:
                skipped += 1
                print(f"skip {src}: {exc}")
    print(f"mirrored {copied} file(s) into {MIRROR} ({skipped} skipped)")
    return 0 if copied else 1


if __name__ == "__main__":
    sys.exit(main())
