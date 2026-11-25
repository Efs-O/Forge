# session-scan

Four scripts that read the Forge session logs (`~/.forge/sessions/*.jsonl`) and
write a small report of failed tool calls: which tool, which model, which Forge
version, whether the agent retried it and worked, and examples of each recurring
error.

They came out of `scratch/`, where the sessions folder, the output folder, the
window start and the set of probe chats were hard-coded to one machine and one
week, so the whole thing was lost whenever `scratch/` was cleaned. They now take
arguments so a twice-weekly job can run them. `scratch/` keeps its copies —
the owner's one-off report still builds from those.

## Arguments (the core scan scripts)

| Flag | Meaning |
| --- | --- |
| `--out DIR` | **Required.** Where every output file goes; created if missing. |
| `--sessions DIR` | Folder of `*.jsonl` logs. Default: `~/.forge/sessions`. |
| `--since YYYY-MM-DD` | Window start, local midnight. Default: 7 days before now. |
| `--since-cutoff FILE` | Window start instead of `--since`: the epoch seconds stored in a file, normally the previous run's `scan_cutoff.txt`. Two runs then neither overlap nor leave a gap between them. Cannot be combined with `--since` (the run exits `use --since or --since-cutoff, not both`); an unreadable file exits `--since-cutoff: cannot read <path>`. |
| `--min-version X.Y.Z` | Leave out every tool row that ran on an older Forge build, so the numbers measure one build instead of a mix. Compared as dotted integers (`0.17.204` passes, `0.17.196` does not); a row whose version is `?` or unparseable counts as older. Default: count every build. |
| `--exclude FILE` | Chat-id prefixes to leave out of the production counts, one per line (`#` comments and blank lines allowed). No flag excludes nothing. |

## What each script reads and writes

Run the scan scripts in this order, with the **same** `--sessions`, `--out` and
window arguments — they share the raw rows and the frozen cutoff.

1. `scan_logs.py` — reads the logs. Writes `failed_tools_raw.txt` (one tab-separated
   row per failed call), `failed_tools_sig.txt` (failure signatures, most common
   first), `failed_tools_sig_outside.txt`, `failed_tools_rate.txt` (per tool: `tool`, `calls`, `failures`, `rate%`,
   tab-separated — the tools with at least 10 calls first, worst rate on top, ties
   broken by name, then the rare ones in the same order; this is what answers "which
   tool fails more than a third of its calls"),
   `failed_tools_rate_by_model.txt` (tab-separated `model`, `tool`, `calls`,
   `failures`, `rate%`; sorted by full model name and then the same call-count/rate/name
   order as the all-model file), `scan_summary.txt` (the counts, plus
   `WINDOW_START` so the next run can start where this one ended and `MIN_VERSION`
   so the build the numbers measure is on the record), and `scan_cutoff.txt`.
   `failed_tools_raw.txt` columns, tab-separated: `time`, `kind`, `tool`, `model`,
   `chat id`, `workspace` (the chat's `workspace_name`, `?` when the log has none),
   `title`, `ARGS: …`, `ERR: …`, `call id`. `failed_tools_sig_outside.txt` — the
   same signatures, counting only chats whose workspace is not Forge (`forge` or
   `forge-*`, any case).
2. `recovery_check.py` — reads `failed_tools_raw.txt`, `scan_summary.txt`,
   `scan_cutoff.txt` and the logs. Writes `recovery.txt`: of the failures that are
   not a non-zero shell exit, how many were followed by the same tool succeeding
   later in the same chat, retried and failed again, succeeded inside the same
   minute (the log stamps only to the minute, so that cannot be ordered), or were
   never followed by a call at all.
3. `version_join.py` — reads `failed_tools_raw.txt` and the logs (for the
   `forge_version` on each `session_start`). Writes `failed_tools_versions.txt`:
   failure class × Forge version, and per-session counts.
4. `spot.py` — reads the logs only. Writes `failed_tools_spot.txt`: up to three
   full examples (arguments and error text) for each recurring error string.

5. `rate_history.py` — run after `scan_logs.py`. It appends each row of
   `failed_tools_rate.txt` to a durable TSV history, using the scan's
   `WINDOW_START`, `CUTOFF`, and `MIN_VERSION`. Pass `--out` once for each folder
   being added or backfilled; folders are processed by cutoff. Re-running is safe:
   a cutoff already in the history prints `ALREADY` and adds no rows. A folder with
   no `MIN_VERSION` line is skipped. Keep the history file outside the dated scan
   folders so cleanup of old folders does not delete it.
6. `fix_levels.py` — run after updating rate history. It reads commits with
   `Fix-level:` lines since the requested date, matches tool names as whole words
   in commit subjects and bodies, and writes `fix_levels.txt` beside the history.
   Each commit × tool compares the last history window ending before the commit
   date with the first window starting the day after it, then summarizes outcomes
   by fix level. Commits with no history tool name appear under `# no tool named`.

The session logs record a model name that includes the **weight quant** (such as
`...-iq3_xxs`), which is retained in the per-model rate file. They do not record
the KV-cache quant, so these reports cannot attribute rates to a KV quant.

## tips_repeats.py

`tips_repeats.py` — reads `docs/CODING_TIPS.md` and `resources/tips/CODING_TIPS.md`,
the git history that first added each of their rows, and `failed_tools_raw.txt` (plus
the logs, for the Forge version under each repeat). Writes `tips_repeats.txt`: one
line per measurable tip row — repeats, chats, the row's date, its id, tool, what it
matches on, Forge versions, models — sorted by repeats, then the rows it cannot
measure and why.

A failed call counts as a repeat of a tip row when all three hold:

* the tool matches (or the row is in a non-`FORGE_TOOLS` section, so any tool does);
* the call happened on or after the day after the day `git log -S` says the row was
  added — a row it cannot date counts from the window start, and the line says
  `undated`;
* the error text contains the row's quoted error words, or, for a `FORGE_TOOLS` row
  that quotes no error, its `ARGS` field contains the wrong argument it names.

A row with repeats is a tip that is not stopping the mistake: it should become a
tool fix — the refusal or the tool description names the right call — and then the
row is deleted, which is what keeps the tables short.

```
python scripts/session-scan/scan_logs.py    --out .forge/tmp/scan-p4-lane --since 2026-11-01
python scripts/session-scan/tips_repeats.py --out .forge/tmp/scan-p4-lane --since 2026-11-01
```

For a new scan folder, run `rate_history.py` after the scanner, then run
`fix_levels.py` against the durable history after adding the scan window:

```text
python scripts/session-scan/rate_history.py --out .forge/tmp/scan-p4-lane --history .forge/tmp/rate_history.tsv
python scripts/session-scan/fix_levels.py --history .forge/tmp/rate_history.tsv --since 2026-11-09
```

## The frozen cutoff

`scan_logs.py` fixes the end of the window the first time it runs and saves it in
`<out>/scan_cutoff.txt`; every later run reuses that value instead of drifting
forward, so one number means one thing across re-runs. Nothing outside
`[--since, cutoff]` is counted.

A run twice a week starts its window at the previous run's end instead of guessing
a week back: `--since-cutoff <previous folder>/scan_cutoff.txt`.

**That means a weekly job must use a new `--out` folder each week.** Reusing one
folder reports the week it first ran, not the current one. A dated folder does
both jobs at once:

```
python scripts/session-scan/scan_logs.py --out .forge/tmp/scan-check/2026-11-12 --since 2026-11-05
```

## Example command line

From the repository root, `python` on PATH, one week's worth of logs into a fresh
folder:

```
python scripts/session-scan/scan_logs.py    --out .forge/tmp/scan-check/2026-11-12 --since 2026-11-05
python scripts/session-scan/recovery_check.py --out .forge/tmp/scan-check/2026-11-12 --since 2026-11-05
python scripts/session-scan/version_join.py   --out .forge/tmp/scan-check/2026-11-12 --since 2026-11-05
python scripts/session-scan/spot.py           --out .forge/tmp/scan-check/2026-11-12 --since 2026-11-05
```

`--since` can be left out (7 days before now), and `--sessions` can be left out
on the machine that runs Forge.

## Notes that used to be a bug

* A failure row is stamped `'Wed 04 15:30'` — no year, no month. `scratch/`
  hard-coded 2026-11, which silently put every failure in November the moment a
  job ran in another month. `recovery_check.py` and `version_join.py` now recover
  the date from the scan window (the day in it whose weekday and day-of-month
  match the stamp). A row whose stamp matches no day in the window is counted as
  `NO_DATE_MATCH` rather than placed on a guessed date — that happens when the
  raw file was written with a different `--since`.
* `version_join.py` read `package.json` relative to the current directory; it now
  reads the repository root found from its own location, so the job's working
  directory does not matter for that line.
* `spot.py` still has no upper time bound, as it did in `scratch/`: it quotes
  examples rather than counting them, so it also shows calls that arrived after
  the frozen cutoff.
