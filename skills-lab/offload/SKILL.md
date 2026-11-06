---
name: offload
description: Copy folders to another volume, verify every file, and purge sources only after a clean same-call verification.
---

# Offload

Use this skill to copy folders to another volume with Windows `robocopy`, compare every relative file path and size, and optionally empty the source only after a clean verification in that same invocation.

Run `scripts/offload.py --help` for the full interface. Start with the default `--dry` inventory and free-space check, then use `--copy --log-dir DIR` and `--verify` as separate reviewable steps. `--purge` requires both `--yes-purge` and a successful verification performed in the same call; it deletes only files verified in that call, keeps files that appeared or changed afterward, and leaves each source folder itself in place. Purge refuses sources containing symlinks or junctions. Keep logs outside the source and destination trees.

The script uses Python's standard library and Windows `robocopy`. `scripts/selftest.py` exercises copy, verification failure and refusal, successful verification, and purge in a temporary directory.
