# Coding tips — exact syntax, one line per mistake

**Recording a mistake.** This table is injected into your system prompt, so there is nothing to open. Before adding a line, search it for the tool name and for a phrase from the error — the mistake is usually here already in other words. If a line covers it, sharpen that line with the syntax you actually hit instead of adding a second: a copy costs the prompt twice, CI refuses two near-duplicate rows, and the write tool refuses a line the table already has. Record in the project's `docs/CODING_TIPS.md`, never in the shipped table, which arrives read-only.

**Not a second copy of the rules.** General behaviour belongs in `config/templates/builtin/execute.njk` (injected for every user); facts about this machine or repo belong in `FORGE.md` (injected here). A line that reads like advice rather than syntax is in the wrong file. **Delete a line once the code refuses the mistake** — name the gate in the commit message instead.

## SEARCH
1. `web_fetch` on a URL slug I guessed (`huggingface.co/blog/harness-hub/pi-adapted`) → HTTP 404, twice: a post truncates its own link. web_search the exact title, take the real slug, then fetch
2. `rg -n x .` → `dist/`, `coverage/`, `docs/reports/**`, one-line `test/fixtures/*.json` drown the answer (42 MB once); grep's `--include` filters names not dirs, `-g` is rg-only (GNU grep: `unknown option -- g`). exclude dirs with rg `--glob`

## RUN
1. `stop_execution` on a background `npm run ci` → the wrapper dies, the child tree lives and holds the ci-lock, so the next run waits forever: `MSYS_NO_PATHCONV=1 taskkill /PID <top> /T /F`
2. `npx eslint test/unit/x.test.ts` → "none of those TSConfigs include this file": the lint script is `eslint src webview-ui`, so tests have no typed-lint config. lint `src` only
3. `npx prettier --check .forge/x.ts` → "All matched files use Prettier code style!" while nothing was checked: prettier matches no file in a dot-folder. copy it into `test/unit/`
4. `grep_search` with `output_mode:`/`glob:`, `shell` with `query:`/`include:`, `remember` with `title:` → refused: unknown argument; real fields are `output`/`include`, `command`, `key`/`value`/`description`. never send one tool's field to another
5. `grep -P "(^|[^-])word" f` in Git Bash → "grep: -P supports only unibyte and UTF-8 locales"; adding `-E` → "conflicting matchers specified". use `rg -n --no-unicode` with an explicit char class instead
6. `update_plan` `items` where one entry is typed as a bare string → refused: `"items" entries must be objects, not entry 5 (string)`. every entry is `{"text":…, "status":…}`, none bare
7. a PowerShell double-quoted string holding `$Config:` → `ParserError: ':' was not followed by a valid variable name character` — a colon after a variable starts a drive-qualified name. write `${Config}:`, or no colon straight after a variable
8. `python -c "…c['exe'].split('\\\\')…"` under bash → bash eats the backslashes first, so Python sees `'\'` → `SyntaxError: unterminated string literal`. keep backslashes out of a double-quoted `-c` body; print the value whole
9. `wc -l src/x.ts` in a `shell: pwsh` call → "The term 'wc' is not recognized"; the refusal says rerun with `shell: "bash"`. POSIX text tools (`wc`, `sed`, `grep -o`) exist only in the bash shell
10. a pwsh log name with a space (`> .forge/jcn- flakes-1.log`) → the later `Select-String -Path ".forge/jcn- flakes-1.log"` says the path does not exist. no spaces in log file names
11. `git log … 2>/dev/null` in a `shell: pwsh` call → `Out-File: Could not find a part of the path 'N:\dev\null'`. in pwsh write `2>$null`; `/dev/null` only means something in bash
12. `find_files` with `path:"."` or `path:"src"` → refused: unknown argument "path" on older builds; an absolute or `..` path is always refused. put the folder in the pattern: `{"pattern":"src/**/*.ts"}`
13. `image_search` with `query:"red fox"` → refused: unknown argument "query"; it takes `image_url`/`attachment_index`. it is a reverse search of an image you have, not a text search; for pictures by words use `web_search`
14. `render_html_to_image` with `html` plus `path:"out/x.png"` → refused: exactly one of html or path. `path` is an HTML file to render, not the output; send html alone, then `move_file` the PNG the result names

## GIT
1. `.forge/ci-pass/<tree>.json` → certifies that tree only, and only if green and the tree stood still: never run `record-ci-pass.mjs` by hand — the `ci:steps` chain writes it
2. `git add AI SETUP.md` → `fatal: pathspec 'AI' did not match any files` (read_file of the same typo says `nothing exists there`): the underscore became a space. the file is `AI_SETUP.md`

## EDIT
1. a rename lengthens an identifier, or a new call takes several arguments on one line → the `prettier/prettier` gate fails at printWidth 100. fix: `npx prettier --write <file>`
2. `apply_line_edits` on `docs/TOOL_COVERAGE.md` → `ToolHarness.test.ts` diffs it against a fresh generation and normalises only `Generated:`. restore_file it after a demo
3. `npx prettier --write` on a test file → it rewrites lines nobody touched: `test/` is not prettier-clean (lint is `eslint src webview-ui`). --write only the src files the gate lints
4. an edit that grows a src file past 500 lines → eslint `max-lines` errors, same limit as the tool's warning. check `wc -l <file>` first; move the code into a leaf module
5. an `edit_file` batch carrying a no-op edit (`old_str` already equals `new_str`) → refused: not found, an earlier edit in that same batch moved the anchor. drop the no-op edit
6. a delegate method written to fit one line under a `max-lines` cap → prettier expands `{ return x; }` into three lines. keep it one line as an arrow class property: `undo = (): Promise<string[]> => this.actions.undo();`
7. threading a maybe-undefined value into an optional interface field (`postToJobChat: deps.postToJobChat`) → TS2379 with `exactOptionalPropertyTypes`. declare the field `?: T | undefined` (as `JobDeliveryDeps.summarize`), not just `?: T`

## TEST
1. `fs.rmSync` on a killed child's cwd → EPERM is not in `maxRetries`' retried set, so the retries do nothing. use `removeTreeWhenFree` (test/support/removeTempTree.ts): polls until removable
2. a `ToolApprovalService` card asserted on the posted `confirmRequest` → none arrives: `pump()` posts it only when `getView()` answers truthy. pass a fake view, mock `commands.executeCommand`
3. vitest fake timers do not patch `node:timers/promises` → that sleep waits real time, so a fake-timer test times out at 5 s. use `sleepOrThrow` from `src/util/abortableSleep`
4. a fact value for `src/agentBus/agentNote.md` written with its own backticks → the template already wraps `__FORGE_CONFIG__` in backticks, so the line renders doubled ones (`` ``x`` ``). pass the bare value, no enclosing backticks
5. a `vi.hoisted` `fs.mkdtempSync(os.tmpdir())` (fake home) in a test file → teardown fails: `temp leak: <file> left 1 entry in os.tmpdir()`. `tempGuard.setup.ts` narrows tmpdir per file, so rm it in an `afterAll`
6. a `toContain` pin of AI_SETUP.md prose retyped from the brief with a `\u2019` apostrophe → fails: the doc uses ASCII `'`; only its dashes are `\u2014`. copy the sentence from the doc, not the brief
7. a `vi.fn()` stand-in for an async dependency → returns `undefined`, so the caller's `.catch()` throws `Cannot read properties of undefined (reading 'catch')`. use `vi.fn(async () => undefined)` for a dep the code chains on
8. a fake loopback `http` server closed with `server.close()` alone → the test hangs to its timeout: fetch keeps the connection alive. call `server.closeAllConnections()` first
9. a new top-level `config.yaml` key → `ModelReferences.test.ts` fails until it is in `NON_MODEL_REF_FIELDS`, and `config.example.yaml` needs a commented block for it
10. an expected message built from fragments joined with `cond ? 'x' : ''` and no `+` before the next fragment → the assertion compares a mangled string. join every fragment with ` +`, and wrap each conditional in parentheses
11. a test reading a media job's `job.json` after `status()` answers `done` → the file still holds the `running` record: `finish()` fires the terminal write without awaiting it. poll the file until the field lands

## PATHS
1. comparing a tool's resolved path with the workspace root in a test → `fs.realpathSync` keeps the 8.3 short form `EFSOOF~1`, `fs/promises` `realpath` expands it: use the tool's resolver
2. `zipfile.ZipFile('test/fixtures/sample.xlsx')` in a scan → FileNotFoundError: that is not where the fixture lives. read the test's `fixture()` helper for the real path first
3. `npx tsc --noEmit` → checks `src` only: the root tsconfig excludes `webview-ui` and `test`. a webview-ui change needs `npx tsc --noEmit -p webview-ui/tsconfig.json`
4. `wc -l test/unit/BusContent.test.ts` → no such file: busContent's tests live in `test/unit/AgentBus.test.ts`. `ls test/unit | grep -i <topic>` before naming a test file
5. `read_file`/`grep_search` on a guessed module path (`src/tools/generateImageTool.ts`) → `nothing exists there`, `opened no file`: the refusal names the real folder → `find_files "**/<name>.ts"` before the first read

## FORENSICS
1. a print job parked in `JobStatus Printing` with `PrinterStatus 4` for minutes → the driver is waiting in its own preview window (Canon IJ Preview: Start Printing). screenshot the screen; the queue proves nothing
2. `Get-PrintQueue`/`Get-PrintJob` → not recognized here (no PrintQueue module). job state: `Get-CimInstance Win32_PrintJob`; printer state: `Win32_Printer` `PrinterStatus` (3=idle 4=processing)
