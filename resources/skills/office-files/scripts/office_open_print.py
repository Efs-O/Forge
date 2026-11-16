"""Open or print a file the way Windows would, with paths that survive Git Bash.

usage: python office_open_print.py <resolve|open|print> <file-or-glob>

resolve : print the one file the glob picked, and how many it matched
open    : hand it to the default app (Word, Excel, a reader)
print   : the shell "print" verb -> the DEFAULT PRINTER, no dialog

`print` still lands in the printer driver's own preview if that driver has one
(this machine's Canon MB2700 does): screenshot the screen afterwards, and check
the queue with print_status.ps1. Greek and spaced paths go through Python because
`cmd //c start` and `explorer.exe` mangle them from Git Bash.
"""

import sys
import os
import glob

sys.stdout.reconfigure(encoding="utf-8")


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 1
    mode, pattern = sys.argv[1], sys.argv[2]
    if mode not in ("resolve", "open", "print"):
        print(__doc__)
        return 1
    hits = sorted(glob.glob(pattern))
    if not hits:
        print("NO MATCH for " + pattern)
        return 1
    if len(hits) > 1:
        print("%d files match — narrow the pattern. Candidates:" % len(hits))
        for h in hits:
            print("  " + h)
        return 1
    path = os.path.abspath(hits[0])
    print("FILE: " + path)
    if mode == "resolve":
        return 0
    verb = None if mode == "open" else "print"
    try:
        os.startfile(path, verb) if verb else os.startfile(path)
    except OSError as exc:
        print("FAILED: %r" % (exc,))
        return 1
    print("opened with the default app" if mode == "open" else "sent to the default printer")
    return 0


if __name__ == "__main__":
    sys.exit(main())
