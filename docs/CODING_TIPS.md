# Coding tips — exact syntax, one line per mistake

Read this whole file before your first read, search, edit, write, command, commit or test of a turn — once per turn, not per call. `FORGE.md` points here, and adds: record a mistake the moment you fix one, then resume the work.

**Not a second copy of the rules.** General behaviour belongs in `config/templates/builtin/execute.njk` (injected every turn, for every user); facts about this machine or repo belong in `FORGE.md` (injected every turn, here). A line that reads like advice rather than syntax is in the wrong file. **Delete a line once the code refuses the mistake** — name the gate in the commit message instead.

## READ
1. `read_file` with a guessed `end_line` → refused: start_line is past end_line. read whole, or take the range from a search hit, never from memory

## SEARCH
1. `rg -l "a string" <folder>` → proves it exists somewhere, not whose file it is. read the record that names the file before attributing the hit
2. counting rows in a session log → one audited log was 65% duplicate rows. dedupe by row hash minus `timestamp_ms` and keep first occurrences, before counting
3. a lifetime failure rate → may describe a retired tool or an old build. date it by build and quant (`session_start.forge_version`) before quoting it
4. `rg -c`/`grep -rc` to rank files by mentions → counts matching LINES, not mentions; two files tie at 5 that are 7 and 6 apart. for mentions: `grep -o -e PATTERN | sort | uniq -c`
5. a control run that reuses the flag it contrasts (`rg -il` where the control needed `rg -l`) → both print the same number and read as agreement. a vacuous control exits 0; no scorer sees it
6. `rg -rn PATTERN src` → `-r` eats the `n` as its replacement, so every match prints as the letter `n` and the line reads like a real hit. for line numbers use `rg -n`
7. `rg -F "phrase"` as the proof nothing was missed → it skips gitignored files silently, so the proof is hollow. pass `--no-ignore` (`include_ignored: true`) or name the file

## RUN
1. `cd "C:/Users/…/sessions" && python -c "…"` → refused: the write is judged from the folder the command started in. pass `cwd: "C:/Users/…/sessions"` and the command alone
2. `node -e '… /regex/ …'` under bash → quoting dies through bash → node → regex. use plain string comparisons, or a script file
3. `monitor_execution wait_ms: 90000` → refused: 60000 is the ceiling. reuse the returned `stdout_cursor` instead of waiting longer
4. `git push … 2>&1 | tail -3; echo "exit: $?"` → `$?` is `tail`'s code, not git's, so a refused push reads as a pass. run the command unwrapped and read its own error line
5. an f-string containing `\|` or `\n` inside `{…}` on Python 3.10 → SyntaxError: f-string expression part cannot include a backslash. build the escaped text into a variable first
6. a Python scan printing `→` or `×` → UnicodeEncodeError: 'charmap' codec can't encode, stdout is cp1253. first line of the scan: `sys.stdout.reconfigure(encoding="utf-8")`
7. `json.loads` on every line of a session log → one bad line kills the scan halfway through the file. guard each line with `try/except` and keep going
8. `cd ../other && { … ; } > rel/file.txt; tail rel/file.txt` → a `cd` inside the line moves the cwd for every command after it, so `tail` reads the wrong folder. give later commands absolute paths
9. a bash double-quoted string holding backticks → bash runs them as command substitution, so the program gets text I did not write. wrap the body in single quotes or a quoted heredoc
10. a scan run with `cwd` inside `~/.forge/sessions` → refused: any command there may write into Forge's files. run it from the workspace and pass absolute paths
11. `probe && next && next` where the probe is meant to fail → the chain stops and the later commands never run. join probes with `;`

## GIT
1. `.forge/ci-pass/<tree>.json` → certifies only the tree it was written for. run the suite *after* the commit it is meant to certify, or the tip has no proof
2. `git commit -- <file> -m "msg"` → git reads `-m` and the message as pathspecs after `--`. put every flag before `--`, the files last

## EDIT
1. an `edit_file` whose `old_str` is a heading → the heading disappears when `new_str` omits it, orphaning the text under it. re-include the heading in `new_str`
2. `apply_line_edits` against a range read earlier in the turn → refused: operation is stale, expected_lines do not match. re-read the range and edit in the same round
3. an `old_str` rebuilt from two wrapped lines of a paragraph → refused: not found. the file holds a newline where the display wrapped; anchor one line, newlines and all
4. a rename that lengthens an identifier → a line passes printWidth 100 and fails the formatter gate. after any rename: `git diff -U0 | grep '^+' | awk 'length > 101'`, re-wrap in the same pass
5. `apply_line_edits` with `expected_lines` invented rather than copied → refused: has N lines but the range is M. the refusal prints the current lines verbatim; copy them from there

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
5. attributing a log row or a file write to one chat → other chats share the workspace and the files. attribute by session id, read from the row, before counting
6. reading a `tool_calls` row printed via `json.dumps` → `\n` there is a real newline in the argument, not text the tool got. read the raw value before calling a call malformed
7. counting recorded lines by a pattern anchored on a backtick → only the template line ever matches; agents write `- tool:`. anchor on the word tool:, allow an optional dash, skip the template
8. blaming a mistake on a filtered log window from memory → the rows I "remember" may be hours older. print each hit's wall-clock time before attributing it
9. a Fisher p quoted without its variant → the same 2×2 gives 0.21 strict vs 1.0 standard two-sided. name the variant; re-run the same function, never a library default
