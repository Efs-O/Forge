# Coding tips — exact syntax, one line per mistake

**Recording a mistake.** This table is injected into your system prompt, so there is nothing to open. Before adding a line, search it for the tool name and for a phrase from the error — the mistake is usually here already in other words. If a line covers it, sharpen that line with the syntax you actually hit instead of adding a second: a copy costs the prompt twice, CI refuses two near-duplicate rows, and the write tool refuses a line the table already has. Record in the project's `docs/CODING_TIPS.md`, never in the shipped table, which arrives read-only. A mistake with a Forge tool goes in the `## FORGE_TOOLS` section, starting with the tool's name: Forge shows those lines inside that tool's description.

**Not a second copy of the rules.** General behaviour belongs in `config/templates/builtin/execute.njk` (injected for every user); facts about this machine or repo belong in `FORGE.md` (injected here). A line that reads like advice rather than syntax is in the wrong file. **Delete a line once the code refuses the mistake** — name the gate in the commit message instead.

## SEARCH
1. `rg -l "a string" <folder>` → proves it exists somewhere, not whose file it is. read the record that names the file before attributing the hit
2. counting rows in a session log → many rows are duplicates. dedupe by row hash minus `timestamp_ms` and keep first occurrences, before counting
3. a lifetime failure rate → may describe a retired tool or an old build. date it by build and quant (`session_start.forge_version`) before quoting it
4. `rg -c`/`grep -rc` to rank files by mentions → counts matching LINES, not mentions. for mentions: `grep -o -e PATTERN | sort | uniq -c`
5. a control run that reuses the flag it contrasts (`rg -il` where the control needed `rg -l`) → both print the same number and read as agreement. check the control can differ before trusting it
6. `rg -rn PATTERN src` → `-r` eats the `n` as its replacement, so every match prints as the letter `n`. for line numbers use `rg -n`
7. `rg -F "phrase"` as the proof nothing was missed → it skips gitignored files silently. pass `--no-ignore` (`include_ignored: true`) or name the file
8. `search_sessions` returning `total_matches: 0` → not proof the archive lacks the topic. probe with a term you expect to hit and check `date_from` before reporting a gap
9. a follow-up search that drops one alternative from the `rg -l "a|b"` that listed the file → it matched the other one, so the narrow search is empty. repeat the whole pattern
10. `rg --include='*.ts'` or `grep --no-ignore` → unrecognized flag: each is the other tool's spelling. rg filters with `-g '*.ts'`; GNU grep has no ignore flag
11. an `rg` pattern with a look-around (`(?=`, `(?!`, `(?<=`) → `look-around ... is not supported`. add `--pcre2`
12. `grep --include` to skip a folder, or `grep -g` → `--include` filters names not dirs; `-g` is rg-only (`unknown option -- g`). exclude folders with rg `--glob '!dir/**'`

## RUN
1. `node -e '… /regex/ …'` under bash → quoting dies through bash → node → regex. use plain string comparisons, or a script file
2. `… | tail -3; echo "exit: $?"` → `$?` is tail's code, not the command's; a background job ending `echo "exit: $?"` says 0 whatever ran. read the line the command wrote
3. an f-string containing `\|` or `\n` inside `{…}` on Python 3.10 → SyntaxError: f-string expression part cannot include a backslash. build the escaped text into a variable first
4. a Python scan printing `→` or `×` → UnicodeEncodeError: 'charmap' codec can't encode. first line of the scan: `sys.stdout.reconfigure(encoding="utf-8")`
5. `json.loads` on every line of a session log → one bad line kills the scan halfway. guard each line with `try/except` and keep going
6. `cd ../other && { … ; } > rel/file.txt; tail rel/file.txt` → the `cd` moves the cwd for every later command, so `tail` reads the wrong folder. give later commands absolute paths
7. a bash double-quoted string holding backticks → bash runs them as command substitution. wrap the body in single quotes or a quoted heredoc
8. `probe && next && next` where the probe is meant to fail → the chain stops and the later commands never run. join probes with `;`
9. a 2nd gated call after one card expired → `... needs the approval that went unanswered earlier in this turn, so no new card was shown` → only the first card waits
10. a gated call batched with later gated calls → each raises its own card and waits the full `approval_timeout_minutes`. send one gated call, then the next
11. a heredoc terminator with a command after it (`MSG; echo ok`) → not seen as a terminator: the command text lands in the file and never runs. keep it alone on its line
12. a field the tool does not declare (a result's field resent as input, a stray `=`, every arg nested in `arguments`) → refused: unknown arguments; one refusal names them all. re-read the field list
13. `npm test 2>&1 > run.log` → vitest writes failures to stderr, so the file holds only the summary. write `> run.log 2>&1`
14. an approval-gated command inside `A && B && C` → the card can expire with the owner away and B/C never run. restore a tracked file with `git show HEAD:path > path`: no card
15. a pid taken in Git Bash (`$$`, `$!`) → an MSYS pid, so Win32 `OpenProcess` answers 87. take it from the Windows side (PowerShell `$PID`) or a Win32 tool
16. `"$Config:"` in a PowerShell double-quoted string → `ParserError: ':' was not followed by a valid variable name character`. write `${Config}:`
17. `node -e "import('C:/x/y.mjs')"` on Windows → `ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'c:'`. pass a file URL: `import('file:///C:/x/y.mjs')`
18. `sed -n '140,185'` → `missing command`: the range alone prints nothing. write `sed -n '140,185p'`
19. `npx prettier --check .dir/x.ts` → "All matched files use Prettier code style!" while nothing was checked: prettier skips dot-folders. copy the file out of the dot-folder first
20. `grep -P "(^|[^-])word" f` in Git Bash → "grep: -P supports only unibyte and UTF-8 locales"; adding `-E` → "conflicting matchers specified". use `rg -n` instead
21. `python -c "…split('\\\\')…"` under bash → bash eats the backslashes first → `SyntaxError: unterminated string literal`. keep backslashes out of a double-quoted `-c` body
22. a pwsh log name with a space (`> logs/run 1.log`) → a later `Select-String -Path` says the path does not exist. no spaces in log file names

## GIT
1. `git commit -- <file> -m "msg"` → git reads `-m` and the message as pathspecs after `--`. put every flag before `--`, the files last; a new file needs `git add` first
2. `git commit -m '…the cell's body…'` → the apostrophe closes the bash quote (`pathspec 'body' did not match`). write the message to a file and `git commit -F` it
3. `git log --since/--until` after a rebase → committer dates were rewritten, so the window matches old commits. filter `%ad` (author date) instead

## EDIT
1. a multi-line string edit that drops the `+` between two literals → the parse error names a later line, not the missing one. after editing a joined description, re-read the block
2. deleting entries from a numbered list by replacing a block → the renumbering duplicated one entry and dropped another. rewrite the section's whole tail, then read it back
3. new text inside a `String.raw` template literal containing a backtick → the template ends early and the parse error names a later line. no backticks in prose inside a template literal
4. repairing a mangled line from memory instead of rereading it → the fix re-adds what survived: `describe('x', () => { () => {`. read the line back, then fix it once
5. budgeting the net lines of a 500-line file → the tool warns "now 501 lines": an inserted documented method is doc+body+blank = 5 lines, not 4. `wc -l` after the edit
6. `SKILL.md` `description:` → the catalog carries only 240 chars (`MAX_SKILL_DESCRIPTION_CHARS`), so the trigger words must fit there; a wrapped description, or a `name` that is not the folder name, is refused
7. a one-line method `{ return x; }` written to fit a line cap → prettier expands it into three lines. keep it one line as an arrow property: `undo = (): Promise<string[]> => this.actions.undo();`
8. a maybe-undefined value passed into an optional interface field → TS2379 with `exactOptionalPropertyTypes`. declare the field `?: T | undefined`, not just `?: T`
9. `sed -i 'A,Bd'` with B on a block's closing brace → the blank line after the block stays, so its neighbours end up two blank lines apart. delete through B+1, or re-read the seam after the delete

## TEST
1. a harness that only emits calls, or a threshold measured by a script whose pair list differs from the gate's → the number certifies neither. dispatch the calls; measure with the gate's own list
2. a flaky test → do not raise the timeout: `child.once('exit')` attached after an `await` misses the event, so that await never settles. await the promise that ends the work
3. comparing objects by serialized source order → false failures on property order. compare by value; array order is meaningful
4. `expect(x).toHaveLengthLessThanOrEqual(n)` → no such matcher, so the assertion itself throws. `expect(x.length).toBeLessThanOrEqual(n)`
5. a tool rename swept only src+test → a bench script and its JSON fixture still name the old tool. sweep scripts/ and benchmarks/ in the same pass
6. a describe-level `path.join(dir, 'x')`, dir set in beforeEach → runs at collection while dir is '': a RELATIVE path that can overwrite a real repo file. build temp paths in the test
7. `vi.spyOn(fs, 'stat')` → Cannot spy on export: Module namespace is not configurable in ESM. wrap it in a `vi.mock('fs', async (orig) => ({...await orig(), stat: wrapped}))` factory, then `await import` the module
8. `arr.sort(stringComparator)` on an array of objects → both coerce to `[object Object]`, the comparator returns 0, the order stays. write a comparator that takes the objects
9. `fc.oneOf(...)` under fast-check v4 → `oneOf is not a function`: v4 dropped the camelCase combinators. use `fc.oneof`
10. vitest fake timers with a `node:timers/promises` sleep → not patched, so it waits real time and the test times out. use an abortable sleep built on `setTimeout`
11. a `vi.fn()` stand-in for an async dependency → returns `undefined`, so `.catch()` throws `Cannot read properties of undefined (reading 'catch')`. use `vi.fn(async () => undefined)`
12. a fake loopback `http` server closed with `server.close()` alone → the test hangs to its timeout: fetch keeps the connection alive. call `server.closeAllConnections()` first
13. an expected message built from fragments joined with `cond ? 'x' : ''` and no `+` before the next fragment → the assertion compares a mangled string. join with ` +`, wrap each conditional in parentheses
14. a new method on a class tests fake with `{ … } as unknown as X` → `TypeError: x.method is not a function` in other files' tests. `grep -rn "as unknown as X" test scripts` and add it to every fake
15. a python heredoc writing a file that holds `'\n'` escapes → Python turns them into real newlines (vitest: `PARSE_ERROR`). write the escape as `chr(92)+"n"`, or use the edit tool
16. a "the stale read must not publish" test asserting a snapshot count → fails on macOS: `fs.watch` reports the fixture's own writes. make the stale result distinguishable (`[]`) and assert none is it
17. a fake that picks "the first call is the slow one" after `await super.x()` → two concurrent calls race to that check and the wrong one goes slow. read and clear the flag before the first await
18. `gh api` or `web_fetch` inside a scheduled job → `approval key denied by policy`: a job holds only the keys in `approvals.jobs.<name>.allow` in `~/.forge/policy.yaml`. add them, or judge from the job's own snippets and name what was cut

## PATHS
1. `~/.forge/sessions/<short-id>.jsonl` → no such file: logs carry the full 8-4-4-4-12 chat id. resolve a short id with a prefix glob
2. comparing a resolved path with a root in a test on Windows → `fs.realpathSync` keeps the 8.3 short form (`ABCDEF~1`), `fs/promises` `realpath` expands it. use one resolver for both

## FORENSICS
1. pairing calls with results → pair the `tool_calls` row with the `tool` rows that follow it, positionally; the rendered chat hides tool failures entirely
2. reading the newest row of a session log → the newest rows are metadata (`type: request`, `written_count`) with no `role`. judge the newest row that has a `role`
3. scripting over `tool_calls` rows → the keys are `name`, `input`, `raw_arguments`. guessing `args` returns null — print one row's keys first
4. attributing a log row or a file write to one chat → other chats share the workspace and the files. attribute by session id, read from the row, before counting
5. reading a `tool_calls` row printed via `json.dumps` → `\n` there is a real newline in the argument. read the raw value before calling a call malformed
6. a session-log pattern that matches nothing → a backtick-anchored one hits only the template (agents write `- tool:`); `"tool": "x"` misses: rows are compact JSON. anchor on `tool:`
7. blaming a mistake on a filtered log window from memory → the rows I "remember" may be hours older. print each hit's wall-clock time before attributing it
8. a Fisher p quoted without its variant → the same 2×2 gives 0.21 strict vs 1.0 standard two-sided. name the variant; re-run the same function, never a library default
9. a tool call with no result row for minutes → not a hang: an unanswered approval card writes its `gate` row only when answered or expired. read the `gate` rows first
10. a tool-result string quoted from a staging file → it is the build that run used, not the current one. read the source before filing it as a live defect
11. `gh run view <number>` → HTTP 404: view wants the `databaseId` from `gh run list --json databaseId`; `elapsed`/`title` are not fields — duration is startedAt minus createdAt
12. a session-log call with arguments `{}` whose result says "was cut off after 47 bytes of arguments" → Forge logs `{}` in place of cut-off arguments. read the byte count, not the arguments

## FORGE_TOOLS
1. `read_file` · a guessed `end_line` → refused: start_line is past end_line. read whole, or take the range from a search hit, never from memory
2. `read_file` · only `start_line`/`end_line` → refused: `neither path nor reads was given`. `path` is required on every call
3. `read_file` · a guessed module path → `nothing exists there`: the refusal names the real folder. `find_files "**/<name>.ts"` before the first read
4. `web_fetch` · `find=` on a large file → it searches only the window it returns, so "No match" proves nothing. download the raw URL to a file and `rg` it
5. `web_fetch` · a URL slug I guessed from a title → HTTP 404: posts truncate their own links. web_search the exact title, take the real URL, then fetch
6. `code_intel` · first call of a session → `No symbol provider answered ... may still be starting`: the file has symbols. retry once; do not fall back to whole-file reads
7. `grep_search` · a query holding a newline or `\n` → refused before the search: a regex cannot span lines. match one line, or list the alternatives without the newline
8. `grep_search` · `path`, `glob` or `output_mode` → refused as unknown arguments. it takes `include` (a folder or glob goes inside it) and `output`
9. `grep_search` · query `constructor(` → `rg: regex parse error: ... unclosed group`: the query is ripgrep regex. escape every paren (`constructor\(\)`) or set `literal: true`
10. `find_files` · `path:` or an absolute, `~` or `..` pattern → refused, or opens nothing outside the workspace. put the folder in the pattern: `{"pattern":"src/**/*.ts"}`; outside it, `list_directory` the absolute path
11. `shell` · `cd "<dir>" && …`, or `cwd` inside `~/.forge/sessions` → refused: writes are judged from the start folder. pass `cwd:` and the command alone; scan sessions from the workspace
12. `shell` · `wc`/`sed`/`grep -o` in a `shell: pwsh` call → "The term 'wc' is not recognized"; `2>/dev/null` → `Out-File: Could not find a part of the path`. rerun with `shell: "bash"`, or write `2>$null`
13. `shell` · `ls ~/.forge/jobs/*` lists fine, `rm -f ~/.forge/x` → "refuses to change Forge's own files"; `Get-ItemProperty` on a file there counts as a change. read the text with `grep_search`
14. `shell` · `query:`/`include:` or another tool's field → refused: unknown argument. fields are `command`/`cwd`/`timeout_ms`/`background`/…
15. `stop_execution` · on a background `npm run ci` → the wrapper dies, the child tree may live and hold its lock: `MSYS_NO_PATHCONV=1 taskkill /PID <top> /T /F`; with NO_PATHCONV `//PID` → `Invalid argument/option - '//PID'`
16. `monitor_execution` · `wait_ms: 90000` remembered from `wait`'s 900 s → refused: must be within 0 to 60000. re-read the advertised bounds instead of recalling them
17. `monitor_execution` · `suggested_next_wait_ms` echoed back as an argument, or `output_stream: "none"` → `unknown argument "suggested_next_wait_ms"` / `output_stream must be "both", "stdout", or "stderr"`: the first is a returned field — pass its value as `wait_ms`; never invent an enum value
18. `edit_file` · `old_str` rebuilt from wrapped prose, retyped (`diver` for `diverge`), or read before a formatter pass → refused: not found. copy the physical lines verbatim from the newest read
19. `edit_file` · `new_str` that leaves out part of what `old_str` covers (a heading, a trailing line) → that text is deleted or the next line glues on. end both at the same point; re-include anchored lines
20. `edit_file` · `new_str` equal to the current text → alone it reports Applied and changes nothing; in a batch → refused: not found. diff the file, not the reply; drop the no-op edit
21. `edit_file` · a typed `\n` in `new_str` lands as two characters; a `\` before a raw newline → refused: `arrived as a string, not an array and is not valid JSON`. type real newlines, no stray backslash
22. `edit_file` · a new function inserted just above `export async function f` → f's doc comment ends up describing the new function. anchor above that doc comment, not below it
23. `apply_line_edits` · `expected_lines` invented rather than copied → refused: has N lines but the range is M. copy the current lines the refusal prints
24. `apply_line_edits` · a range counted from an unnumbered `read_file`, or from before a formatter pass → refused: `operation 1 is stale ... they DO match lines 276-279`. read with `numbered: true` in the same round
25. `write_file` · a backtick I thought it had escaped → it writes exactly what I typed, so a later `old_str` misses. read_file it back before blaming the write
26. `desktop_click` · on a field may not move the caret → text runs on behind it. move with `tab`, clear with `ctrl+a`+`delete`; a new capture drops the old `capture_id`
27. `read_tool_result` · `message_index` of a tool result → refused: that index is a tool result, use its tool_call_id. results take tool_call_id, prompts take message_index
28. `update_plan` · `items` → refused: `"items" must be a JSON array, not a string`, for a bare-string entry or one missing `"text"`. every entry is exactly `{"text":…,"status":…}`; resend the whole array
29. `remember` · `title:`, `path:`, `name:` or `content:` → refused: unknown argument. name the memory with `key`, put its text in `value`
30. `recall` · the fields `remember` takes → refused. send the memory's name alone: `{"key": …}`
31. `ask_user` · a top-level `header` → refused: unknown argument. `header` belongs to each question
32. `image_search` · `query:"red fox"` → refused: unknown argument "query"; it takes `image_url`/`attachment_index`. it is a reverse search of an image you have; for pictures by words use `web_search`
33. `render_html_to_image` · `html` plus `path:"out/x.png"` → refused: exactly one of html or path. `path` is an HTML file to render, not the output; send html alone, then `move_file` the PNG it names
34. `notify_user` · with no remote chat bound → `Shown in the VS Code window only`: a local toast, never a phone ping. do not report that the user was notified remotely
35. `manage_jobs` · check `{kind: "none"}` → `get` says `runs every tick; on_change delivers nothing`: the job is inert. mute or restore with `on_change`, never a new check
36. `manage_jobs` · `run_now` → runs in whichever window holds the scheduler lease, ~40 s later. verify in `jobs/runs/<name>.jsonl`; do not re-call `run_now`
37. `ask_agent` · with a `target_id` → `existing_session` is that live session, `new_task` a new background one; without it → the linked session (`/link`)
38. `list_delegation_targets` · lists local models beside cloud ones → a local one loads weights and fights the chat model for VRAM. prefer cloud
39. `shell` · a `timeout_ms` recalled from memory → refused: `timeout_ms must be within N to N`. take the bounds from the schema; a run longer than that goes `background: true`
40. `desktop_focus_window` · a VS Code window → `refusing to control a VS Code window`: Forge never drives an editor. pick another window from `desktop_windows`
41. `desktop_focus_window` · `window_id: 123` → `window_id must be a JSON string, not a number`; `window:` → unknown argument. send the id as a string, or `window_title`
42. `desktop_focus_window` · a window under a dialog → `is disabled because Open (HWND N) is open over it`; `focus lock` → ask the user to click it once. focus or close the dialog first
43. `apply_code_action` · a refactor or command action → `this action is not a workspace-edit-only action`: only plain-edit actions run. make the change with `edit_file`
44. `ask_agent` · a `target_id` from an earlier `list_agent_targets` → `CLI target is unknown or expired`: ids expire. call `list_agent_targets` again, then send
45. `desktop_drag` · retried with the same `capture_id` after `foreground window is not the approved target` → every drag refused alike. `desktop_focus_window` the target, `desktop_capture`, then drag with the new id
46. `desktop_press` · after focus moved to another window → `target lost focus (foreground is '<window>')`. call `desktop_capture` to re-capture and re-approve, then press again
47. `desktop_press` · `consequential: true` → `unknown argument "consequential"`: it takes only `keys`. send `{"keys": ["enter"]}` alone
48. `shell` · a script given a file under `~/.forge/` (a screenshot) → `refuses to change Forge's own files`, even when it only reads it. sample the live screen region instead
49. `desktop_click` · a stale `capture_id` once the app lost focus → refused again on each retry. re-focus it (`desktop_focus_window`), capture anew, click by that id
50. `find_files` · `include_ignored: "True"` → `"include_ignored" must be a JSON boolean, not a string`. send the bare `true`, no quotes
51. `desktop_capture` · a window title from before the app renamed it (`Untitled*` once edited) → `window not found`; a bare `Paint 3D` matches another window of that name. `desktop_focus_window` with the `window_id` from `desktop_windows`, then capture with the exact title its reply prints
52. `desktop_capture` · the last `capture_id` sent back to refresh it → `unknown argument "capture_id"`: a capture always starts new and returns its own id. send only `window_title` (or `monitor`) and `kind`
53. `shell` · a background script that drives the mouse for minutes and checks the foreground once at the start → a dialog that pops up meanwhile takes the clicks. check the foreground before every stroke and stop when it changes
54. `shell` · `cd "C:/Users/<name>/.forge/jobs" && python -c '…'` → refused: after a `cd` into Forge's own files only a classed read may follow, so a read-only scan dies too. run from the workspace and pass absolute paths
55. `edit_file` · an import block whose `old_str` held one name → the name was replaced, not added, and the file lost a symbol it still used: `ReferenceError: OUTBOX_STALE_MS is not defined` at the use line, not the import. anchor the edit on the neighbouring line and keep ASCII sort
56. `shell` · `ls test/unit | grep -i -e a -e b` → `exit 134` with `Aborted` and no listing, so the answer is lost not just failed: MSYS job control kills the pipeline. use `find_files` / `grep_search` instead of piping `ls`
