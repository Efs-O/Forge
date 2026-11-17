# Coding tips — exact syntax, one line per mistake

**Recording a mistake.** This table is injected into your system prompt, so there is nothing to open. Before adding a line, search it for the tool name and for a phrase from the error — the mistake is usually here already in other words. If a line covers it, sharpen that line with the syntax you actually hit instead of adding a second: a copy costs the prompt twice, CI refuses two near-duplicate rows, and the write tool refuses a line the table already has. Record in the project's `docs/CODING_TIPS.md`, never in the shipped table, which arrives read-only.

**Not a second copy of the rules.** General behaviour belongs in `config/templates/builtin/execute.njk` (injected for every user); facts about this machine or repo belong in `FORGE.md` (injected here). A line that reads like advice rather than syntax is in the wrong file. **Delete a line once the code refuses the mistake** — name the gate in the commit message instead.

## READ
1. `read_file` with a guessed `end_line` → refused: start_line is past end_line. read whole, or take the range from a search hit, never from memory
2. `web_fetch` with `find=` on a large file → it searches only the window it returns, so "No match" proves nothing. curl the raw URL to /tmp and `rg` the file locally
3. first `code_intel` call of a session → `No symbol provider answered ... may still be starting` → the file has symbols; retry it once and it answers in full → do not fall back to whole-file reads
4. `read_file` with only `start_line`/`end_line` → refused: `neither path nor reads was given`. `path` is required on every call, a range just as much

## SEARCH
1. `rg -l "a string" <folder>` → proves it exists somewhere, not whose file it is. read the record that names the file before attributing the hit
2. counting rows in a session log → one audited log was 65% duplicate rows. dedupe by row hash minus `timestamp_ms` and keep first occurrences, before counting
3. a lifetime failure rate → may describe a retired tool or an old build. date it by build and quant (`session_start.forge_version`) before quoting it
4. `rg -c`/`grep -rc` to rank files by mentions → counts matching LINES, not mentions; two files tie at 5 that are 7 and 6 apart. for mentions: `grep -o -e PATTERN | sort | uniq -c`
5. a control run that reuses the flag it contrasts (`rg -il` where the control needed `rg -l`) → both print the same number and read as agreement. a vacuous control exits 0; no scorer sees it
6. `rg -rn PATTERN src` → `-r` eats the `n` as its replacement, so every match prints as the letter `n` and the line reads like a real hit. for line numbers use `rg -n`
7. `rg -F "phrase"` as the proof nothing was missed → it skips gitignored files silently, so the proof is hollow. pass `--no-ignore` (`include_ignored: true`) or name the file
8. `search_sessions` returning `total_matches: 0` → not proof the archive lacks the topic. probe with a term you expect to hit (`project: "Forge"` → 672) and check `date_from` before reporting a gap
9. a follow-up search that drops one alternative from the `rg -l "a|b"` that listed the file → it matched the other one; the narrow search is empty and reads as a phantom. repeat the whole pattern
10. a `grep_search` query holding a newline or the escape `\n` → refused before the search: a regex cannot span lines. match one line, or list the alternatives without the newline
11. `rg --include='*.ts'` or `grep --no-ignore` → unrecognized flag: each is the other tool's spelling. rg filters with `-g '*.ts'`; GNU grep has no ignore flag
12. an `rg` pattern with a look-around (`(?=`, `(?!`, `(?<=`) → `look-around ... is not supported`. add `--pcre2`
13. `rg -n "x" .` over the repo → `dist/`, `coverage/`, `.forge/tmp/`, `docs/local/**` corpora and one-line `test/fixtures/*.json` drown the answer (42 MB once). exclude each with `-g`
14. `grep_search` with `path`/`glob` → refused as unknown arguments: it takes `include` only, and a folder or absolute glob goes inside `include`
15. `grep_search` query `constructor(` → `rg: regex parse error: ... unclosed group` (escaping one paren only gives `unopened group`): the query is ripgrep regex by default. escape every paren (`constructor\(\)`) or set `literal: true`

## RUN
1. `cd "C:/Users/…/sessions" && python -c "…"` → refused: the write is judged from the folder the command started in. pass `cwd: "C:/Users/…/sessions"` and the command alone
2. `node -e '… /regex/ …'` under bash → quoting dies through bash → node → regex. use plain string comparisons, or a script file
3. `… | tail -3; echo "exit: $?"` → `$?` is tail's code, not the command's; same for a background job ending `echo "ci exit: $?"`, whose notice says 0 whatever npm did. read the line the command wrote
4. an f-string containing `\|` or `\n` inside `{…}` on Python 3.10 → SyntaxError: f-string expression part cannot include a backslash. build the escaped text into a variable first
5. a Python scan printing `→` or `×` → UnicodeEncodeError: 'charmap' codec can't encode, stdout is cp1253. first line of the scan: `sys.stdout.reconfigure(encoding="utf-8")`
6. `json.loads` on every line of a session log → one bad line kills the scan halfway through the file. guard each line with `try/except` and keep going
7. `cd ../other && { … ; } > rel/file.txt; tail rel/file.txt` → a `cd` inside the line moves the cwd for every command after it, so `tail` reads the wrong folder. give later commands absolute paths
8. a bash double-quoted string holding backticks → bash runs them as command substitution, so the program gets text I did not write. wrap the body in single quotes or a quoted heredoc
9. a scan run with `cwd` inside `~/.forge/sessions` → refused: any command there may write into Forge's files. run it from the workspace and pass absolute paths
10. `probe && next && next` where the probe is meant to fail → the chain stops and the later commands never run. join probes with `;`
11. a 2nd gated call after one card expired → `... needs the approval that went unanswered earlier in this turn, so no new card was shown` → only the first card burns time
12. a gated call batched with later gated calls → each raises its own card and waits the full `approval_timeout_minutes`; an expired card silences only that approval key
13. a heredoc terminator with a command after it (`MSG; echo ok`) → never seen as a terminator: the command text lands in the commit message and never runs. keep it alone on its line
14. a field name from the tool's own OUTPUT resent as an input (`next_stdout_cursor`, `suggested_next_wait_ms`; a stray `=` in `=query`) → refused: unknown arguments. one refusal names them all: re-read the list, do not patch the key you guessed
15. an undeclared field → refused as unknown: `edit_file` `edits[]` take `old_str`/`new_str`/`replace_all`; `ask_user` `header` is per-question; `remember` key/value but `recall` takes only `key`; `shell` `command`/`cwd`/`timeout_ms`/`background`/…; `update_plan` items `text`/`status`
16. `stop_execution` on a background `npm run ci` → the wrapper dies, the child tree lives and holds the ci-lock, so the next run waits forever: `MSYS_NO_PATHCONV=1 taskkill /PID <top> /T /F`
17. `npm test 2>&1 > run.log` → vitest writes failures to stderr, so they print to the terminal and the file holds only the summary: grep finds no FAIL. write `> run.log 2>&1`
18. `npx eslint test/unit/x.test.ts` → "none of those TSConfigs include this file": the lint script is `eslint src webview-ui`, so tests have no typed-lint config. lint `src` only
19. an approval-gated command inside `A && B && C` → the card can expire with the owner away and B/C never run. restore a tracked file with `git show HEAD:path > path`: no card
20. a pid taken in Git Bash (`$$`, `$!`) → an MSYS pid, so Win32 `OpenProcess` answers 87 and `Get-CimInstance` finds nothing. take it from the Windows side (PowerShell `$PID`) or a Win32 tool
21. `"$Config:"` in a PowerShell double-quoted string → `ParserError`: the colon starts a drive-qualified variable name. write `${Config}:`
22. `node -e "import('N:/x/y.mjs')"` on Windows → `ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'n:'`. pass a file URL: `import('file:///N:/x/y.mjs')`
23. `sed -n '140,185'` → `missing command`: the range alone prints nothing. write `sed -n '140,185p'`
24. `npx prettier --check .forge/x.ts` → "All matched files use Prettier code style!" while nothing was checked: prettier matches no file in a dot-folder. copy it into `test/unit/`
25. a ceiling remembered from a neighbouring tool (`wait`'s 900 s sent to `monitor_execution` as `wait_ms: 90000`) → refused: must be within 0 to 60000. re-read the advertised bounds instead of recalling them

## GIT
1. `.forge/ci-pass/<tree>.json` → certifies that tree only, and only if green and the tree stood still: never run `record-ci-pass.mjs` by hand — the `ci:steps` chain writes it
2. `git commit -- <file> -m "msg"` → git reads `-m` and the message as pathspecs after `--`. put every flag before `--`, the files last; a new file needs `git add` first: untracked is not a pathspec
3. `git commit -m '…the cell's body…'` → the apostrophe closes the bash quote, so git reads the rest as pathspecs (`pathspec 'body' did not match`). write the message to a file and `git commit -F` it
4. `git log --since/--until` after a rebase → committer dates were rewritten, so the window matches hundreds of old commits. filter `%ad` (author date) instead

## EDIT
1. an `edit_file` whose `old_str` is a heading → the heading disappears when `new_str` omits it, orphaning the text under it. re-include the heading in `new_str`
2. `apply_line_edits` or `edit_file` anchored on text from before a formatter pass or earlier in the turn → refused: stale, or `old_str` not found. re-read the file, edit in the same round
3. an `old_str` rebuilt from wrapped prose, or retyped from an earlier read (`diver` for `diverge`) → refused: not found. the wrap is a real newline; copy the physical lines verbatim from the newest read
4. a rename lengthens an identifier, or a new call takes several arguments on one line → the `prettier/prettier` gate fails at printWidth 100. fix: `npx prettier --write <file>`
5. `apply_line_edits` with `expected_lines` invented rather than copied → refused: has N lines but the range is M. the refusal prints the current lines verbatim; copy them from there
6. `apply_line_edits` on `docs/TOOL_COVERAGE.md` → `ToolHarness.test.ts` diffs it against a fresh generation and normalises only `Generated:`. restore_file it after a demo
7. a multi-line string edit that drops the `+` between two literals → the parse error names a later line, not the missing one. after editing a joined description, re-read the block
8. an `edit_file` whose `new_str` turns out to be the text already there → reports Applied, nothing changes, and the fix I meant never lands. diff the file, not the reply
9. an `edit_file` where `old_str` spans more than `new_str` replaces → the extra line is deleted or the next line glues on. end both anchors at the same point; re-include an anchored body line
10. deleting entries from a numbered list by replacing a block → the renumbering duplicated one entry and silently dropped another. rewrite the section's whole tail, then read it back
11. new text inside a `String.raw` template literal containing a backtick → the template ends early and the parse error names a later line. no backticks in prose inside a template literal
12. `npx prettier --write` on a test file → it rewrites lines nobody touched: `test/` is not prettier-clean (lint is `eslint src webview-ui`). --write only the src files the gate lints
13. an `edit_file` that inserts a new function just above `export async function f` → f's doc comment ends up describing the new function. anchor above that doc comment, not below it
14. an edit that grows a src file past 500 lines → eslint `max-lines` errors, same limit as the tool's warning. check `wc -l <file>` first; move the code into a leaf module
15. an `edit_file` `new_str` with a typed `\n` between two statements → both land on one line, inside the comment above them. type real newlines; re-read a multi-line insert
16. `edit_file` `new_str` written as `\n` → the two characters land in the file, not a newline, and the next edit anchors on text that is not there. write the real newline
17. repairing a mangled line from memory instead of rereading it → the fix re-adds what survived: `describe('x', () => { () => {`. read the line back, then fix it once
18. `edit_file` on a backtick I thought `write_file` had escaped → old_str not found: the file holds exactly what I typed. read_file it back before blaming the write
19. budgeting the net lines of a 500-line file → the tool warns "now 501 lines": an inserted documented method is doc+body+blank = 5 lines, not 4 → `wc -l` after the edit
20. `SKILL.md` `description:` → the catalog carries only 240 chars (`MAX_SKILL_DESCRIPTION_CHARS`), so the trigger words must fit there; discovery also refuses a wrapped description, or a `name` that is not the folder name
21. driving a dialog to edit a file: `desktop_click` on a field can leave the caret where it was → the text runs on behind it. move with `tab`, clear with `ctrl+a`+`delete`; a new `desktop_capture` drops the old `capture_id`
22. a batched `edits` array refused: `arrived as a string, not an array and is not valid JSON` → one value held `\` before a raw newline. escape every newline, or send one old_str/new_str call per edit

## TEST
1. a harness that only emits calls, or a threshold measured by a script whose pair list differs from the gate's → the number certifies neither. dispatch the calls; measure with the gate's own list
2. a flaky test → do not raise the timeout: `child.once('exit')` attached after an `await` misses the event, so that await never settles. await the promise that ends the work
3. comparing objects by serialized source order → false failures on property order. compare by value; array order is meaningful
4. `expect(x).toHaveLengthLessThanOrEqual(n)` → no such matcher, so the assertion itself throws. `expect(x.length).toBeLessThanOrEqual(n)`
5. `fs.rmSync` on a killed child's cwd → EPERM is not in `maxRetries`' retried set, so the retries do nothing. use `removeTreeWhenFree` (test/support/removeTempTree.ts): polls until removable
6. a tool rename swept only src+test → a bench script and its JSON fixture still named the old tool, and only the full suite found it. sweep scripts/ and benchmarks/ in the same pass
7. a describe-level `path.join(dir, 'x')`, dir set in beforeEach → runs at collection while dir is '': a RELATIVE path, and the test overwrote a real repo file. build temp paths in the test
8. a `ToolApprovalService` card asserted on the posted `confirmRequest` → none arrives: `pump()` posts it only when `getView()` answers truthy. pass a fake view, mock `commands.executeCommand`
9. `vi.spyOn(fs, 'stat')` on `fs` or `fs/promises` → Cannot spy on export: Module namespace is not configurable in ESM. Count fs calls with a `vi.mock('fs', async (orig) => ({...await orig(), readFileSync: wrapped}))` factory, then `await import` the module under test
10. vitest fake timers do not patch `node:timers/promises` → that sleep waits real time, so a fake-timer test times out at 5 s. use `sleepOrThrow` from `src/util/abortableSleep`
11. `arr.sort(stringComparator)` on an array of objects → both coerce to `[object Object]`, the comparator returns 0, so the array silently keeps insertion order. write a comparator that takes the objects; only an order-pinning test catches it

## PATHS
1. `~/.forge/sessions/<short-id>.jsonl` → no such file: logs carry the full 8-4-4-4-12 chat id. resolve a short id with a prefix glob
2. `ls ~/.forge/jobs/*` in `shell` → lists fine: file reads under `~/.forge/` are allowed; only a change is refused — `rm -f ~/.forge/x` → "refuses to change Forge's own files". Same for `Get-ItemProperty policy.yaml`: an attribute read counts as a change; read the text with grep_search
3. `list_directory "~/.forge/jobs"` → resolves now (0.17.171), but `find_files "~/**"` still opens nothing outside the workspace. pass the absolute `C:/Users/<name>/.forge/jobs`
4. comparing a tool's resolved path with the workspace root in a test → `fs.realpathSync` keeps the 8.3 short form `EFSOOF~1`, `fs/promises` `realpath` expands it: use the tool's resolver
5. `zipfile.ZipFile('test/fixtures/sample.xlsx')` in a scan → FileNotFoundError: that is not where the fixture lives. read the test's `fixture()` helper for the real path first
6. `npx tsc --noEmit` → checks `src` only: the root tsconfig excludes `webview-ui` and `test`. a webview-ui change needs `npx tsc --noEmit -p webview-ui/tsconfig.json`

## FORENSICS
1. pairing calls with results → pair the `tool_calls` row with the `tool` rows that follow it, positionally; the rendered chat hides tool failures entirely
2. `read_tool_result message_index` to reread a tool result → refused: that index is a tool result, use its tool_call_id. results take tool_call_id, prompts take message_index
3. reading the newest row of a session log → the newest rows are metadata (`type: request`, `written_count`) with no `role`. judge the newest row that has a `role`
4. scripting over `tool_calls` rows → the keys are `name`, `input`, `raw_arguments`. guessing `args` returns null — print one row's keys first
5. attributing a log row or a file write to one chat → other chats share the workspace and the files. attribute by session id, read from the row, before counting
6. reading a `tool_calls` row printed via `json.dumps` → `\n` there is a real newline in the argument, not text the tool got. read the raw value before calling a call malformed
7. a session-log pattern that matches nothing → a backtick-anchored one hits only the template (agents write `- tool:`); `"tool": "x"` misses: rows are compact JSON. anchor on `tool:`
8. blaming a mistake on a filtered log window from memory → the rows I "remember" may be hours older. print each hit's wall-clock time before attributing it
9. a Fisher p quoted without its variant → the same 2×2 gives 0.21 strict vs 1.0 standard two-sided. name the variant; re-run the same function, never a library default
10. a tool call with no result row for minutes → not a hang: an unanswered approval card writes its `gate` row only when answered or expired (one timeout period). read the `gate` rows first
11. a tool-result string quoted from a rep's staging file → it is the build that rep ran, not the current one. read the source before filing it as a live defect
12. a print job parked in `JobStatus Printing` with `PrinterStatus 4` for minutes → the driver is waiting in its own preview window (Canon IJ Preview: Start Printing). screenshot the screen; the queue proves nothing
13. `Get-PrintQueue`/`Get-PrintJob` → not recognized here (no PrintQueue module). job state: `Get-CimInstance Win32_PrintJob`; printer state: `Win32_Printer` `PrinterStatus` (3=idle 4=processing)
14. `gh run view <number>` → HTTP 404: view wants the `databaseId` from `gh run list --json databaseId`, not the display `number`; `elapsed`/`title` are not fields — duration is startedAt minus createdAt

## DELEGATE
1. `notify_user` with no remote chat bound → `Shown in the VS Code window only`: a local toast, never a phone ping. do not report that the user was notified remotely
2. `manage_jobs` check `{kind: "none"}` → since 0.17.171 `get` says `runs every tick; on_change delivers nothing`: the job is inert. mute or restore with `on_change`, never a new check
3. `manage_jobs run_now` → runs in whichever window holds the scheduler lease (here the real repo's), ~40 s later. verify in `jobs/runs/<name>.jsonl`; do not re-call `run_now`
4. `ask_agent` with a `target_id` → that session: `existing_session` is live, `new_task` is a new background one; without it → the linked session. `/link` binds the owner's panel chat
5. `list_delegation_targets` → lists VRAM-loading local models beside cloud ones; picking a local one loads weights and fights the chat model for the GPU. prefer the cloud list
