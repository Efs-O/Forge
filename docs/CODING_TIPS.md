# Coding tips — exact syntax, one line per mistake

Read this whole file before your first read, search, edit, write, command, commit or test of a turn — once per turn, not per call. `FORGE.md` points here, and adds: record a mistake the moment you fix one, then resume the work.

**Not a second copy of the rules.** General behaviour belongs in `config/templates/builtin/execute.njk` (injected every turn, for every user); facts about this machine or repo belong in `FORGE.md` (injected every turn, here). A line that reads like advice rather than syntax is in the wrong file. **Delete a line once the code refuses the mistake** — name the gate in the commit message instead.

## SEARCH
1. `rg -l "a string" <folder>` → proves it exists somewhere, not whose file it is. read the record that names the file before attributing the hit
2. counting rows in a session log → one audited log was 65% duplicate rows. dedupe by row hash minus `timestamp_ms` and keep first occurrences, before counting
3. a lifetime failure rate → may describe a retired tool or an old build. date it by build and quant (`session_start.forge_version`) before quoting it

## RUN
1. `cd "C:/Users/…/sessions" && python -c "…"` → refused: the write is judged from the folder the command started in. pass `cwd: "C:/Users/…/sessions"` and the command alone
2. `node -e '… /regex/ …'` under bash → quoting dies through bash → node → regex. use plain string comparisons, or a script file
3. `monitor_execution wait_ms: 90000` → refused: 60000 is the ceiling. reuse the returned `stdout_cursor` instead of waiting longer

## GIT
1. `.forge/ci-pass/<tree>.json` → certifies only the tree it was written for. run the suite *after* the commit it is meant to certify, or the tip has no proof

## TEST
1. a harness that emits tool calls but never dispatches them → proves schema compatibility only. dispatch writes, deletes and commits before claiming behaviour is verified
2. a flaky test → do not raise the timeout. await the promise that ends the work, then assert: fix it at the lifecycle boundary
3. comparing objects by serialized source order → false failures on property order. compare by value; array order is meaningful

## PATHS
1. `~/.forge/sessions/<short-id>.jsonl` → no such file: logs carry the full 8-4-4-4-12 chat id. resolve a short id with a prefix glob

## FORENSICS
1. pairing calls with results → pair the `tool_calls` row with the `tool` rows that follow it, positionally; the rendered chat hides tool failures entirely
