# Coding tips — exact syntax, one line per mistake

Read this whole file before your first read, search, edit, write, command, commit or test of a turn — once per turn, not per call. `FORGE.md` points here, and adds: record a mistake the moment you fix one, then resume the work.

**Not a second copy of the rules.** General behaviour belongs in `config/templates/builtin/execute.njk` (injected every turn, for every user); facts about this machine or repo belong in `FORGE.md` (injected every turn, here). A line that reads like advice rather than syntax is in the wrong file. **Delete a line once the code refuses the mistake** — name the gate in the commit message instead.

## READ
1. `read_file` with a guessed `end_line` → refused: start_line is past end_line. read whole, or take the range from a search hit, never from memory

## SEARCH
1. `rg -l "a string" <folder>` → proves it exists somewhere, not whose file it is. read the record that names the file before attributing the hit
2. counting rows in a session log → one audited log was 65% duplicate rows. dedupe by row hash minus `timestamp_ms` and keep first occurrences, before counting
3. a lifetime failure rate → may describe a retired tool or an old build. date it by build and quant (`session_start.forge_version`) before quoting it

## RUN
1. `cd "C:/Users/…/sessions" && python -c "…"` → refused: the write is judged from the folder the command started in. pass `cwd: "C:/Users/…/sessions"` and the command alone
2. `node -e '… /regex/ …'` under bash → quoting dies through bash → node → regex. use plain string comparisons, or a script file
3. `monitor_execution wait_ms: 90000` → refused: 60000 is the ceiling. reuse the returned `stdout_cursor` instead of waiting longer
4. `git push … 2>&1 | tail -3; echo "exit: $?"` → `$?` is `tail`'s code, not git's, so a refused push reads as a pass. run the command unwrapped and read its own error line

## GIT
1. `.forge/ci-pass/<tree>.json` → certifies only the tree it was written for. run the suite *after* the commit it is meant to certify, or the tip has no proof
2. `git commit -- <file> -m "msg"` → git reads `-m` and the message as pathspecs after `--`. put every flag before `--`, the files last

## EDIT
1. an `edit_file` whose `old_str` is a heading → the heading disappears when `new_str` omits it, orphaning the text under it. re-include the heading in `new_str`
2. `apply_line_edits` against a range read earlier in the turn → refused: operation is stale, expected_lines do not match. re-read the range and edit in the same round

## TEST
1. a harness that emits tool calls but never dispatches them → proves schema compatibility only. dispatch writes, deletes and commits before claiming behaviour is verified
2. a flaky test → do not raise the timeout. await the promise that ends the work, then assert: fix it at the lifecycle boundary
3. comparing objects by serialized source order → false failures on property order. compare by value; array order is meaningful
4. `expect(x).toHaveLengthLessThanOrEqual(n)` → no such matcher, so the assertion itself throws. `expect(x.length).toBeLessThanOrEqual(n)`

## PATHS
1. `~/.forge/sessions/<short-id>.jsonl` → no such file: logs carry the full 8-4-4-4-12 chat id. resolve a short id with a prefix glob
2. `ls ~/.forge/logs/*` in `shell` → refused: a glob under `~/.forge/` counts as changing Forge's files. read them with `read_file`, `list_directory` or `find_files`

## FORENSICS
1. pairing calls with results → pair the `tool_calls` row with the `tool` rows that follow it, positionally; the rendered chat hides tool failures entirely
2. `read_tool_result message_index` to reread a tool result → refused: that index is a tool result, use its tool_call_id. results take tool_call_id, prompts take message_index
3. reading the newest row of a session log → the newest rows are metadata (`type: request`, `written_count`) with no `role`. judge the newest row that has a `role`
4. scripting over `tool_calls` rows → the keys are `name`, `input`, `raw_arguments`. guessing `args` returns null — print one row's keys first
