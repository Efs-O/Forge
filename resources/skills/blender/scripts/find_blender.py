#!/usr/bin/env python3
"""Print the path of a Blender executable, or exit 1. Run OUTSIDE Blender.

    blender="$(python scripts/find_blender.py)"
    "$blender" -b -P scripts/01_build.py -- --out scene/build.blend

Order tried, first hit wins, and never a whole-drive search:

1. the ``BLENDER`` environment variable (a portable install lives here);
2. ``PATH`` (``shutil.which``);
3. the standard install folders for this OS.

stdout carries exactly one line - the executable path - so a shell can capture
it. Anything worth warning about goes to stderr, and a failure prints its reason
to stderr and exits 1. On this machine Blender may be portable and on no search
path at all, which is why ``BLENDER`` is checked first.

Standard library only; it imports nothing that a Blender install provides.
"""
import glob
import os
import re
import shutil
import sys

NOT_FOUND = "Blender not found. Set BLENDER to the blender executable, or add it to PATH."


def _clean(value):
    """Trim whitespace and a pair of quotes: a value pasted from a shell line
    arrives as "V:...blender.exe" and os.path.isfile rejects the quotes."""
    value = (value or "").strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1].strip()
    return value


def _version_key(path):
    """The version numbers of an install folder, as numbers.

    Numeric on purpose: as text "Blender 4.10" sorts below "Blender 4.2", and a
    future "Blender 10.0" below "Blender 5.0", so a plain sort hands an older
    major to the scripts."""
    return tuple(int(x) for x in re.findall(r"\d+", os.path.basename(os.path.dirname(path))))


def standard_paths():
    """The install folders Blender's own installer uses, per operating system."""
    if os.name == "nt":
        base = os.environ.get("ProgramFiles")
        if base:
            # Newest install first: upgrading in place leaves the older major
            # side by side, and the skill's scripts target the newer one.
            yield from sorted(
                glob.glob(os.path.join(base, "Blender Foundation", "Blender*", "blender.exe")),
                key=_version_key,
                reverse=True,
            )
    elif sys.platform == "darwin":
        yield "/Applications/Blender.app/Contents/MacOS/Blender"
    else:
        yield "/usr/bin/blender"
        yield "/snap/bin/blender"


def candidates():
    """Every place Blender could be, in the order above, as (source, path)."""
    env = _clean(os.environ.get("BLENDER"))
    if env:
        yield "BLENDER", env
    on_path = shutil.which("blender")
    if on_path:
        yield "PATH", on_path
    for folder in standard_paths():
        yield "install folder", folder


def main():
    for source, path in candidates():
        if os.path.isfile(path):
            print(path)
            return 0
        if source == "BLENDER":
            # Named but missing: the common case is a path that moved, so say so
            # instead of falling back to a different Blender silently.
            print(f"find_blender: BLENDER points at nothing ({path})", file=sys.stderr)
    print(NOT_FOUND, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
