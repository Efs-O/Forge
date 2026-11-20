# Coding tips — exact syntax, one line per mistake

**Recording a mistake.** This table is injected into your system prompt, so there is nothing to open. Before adding a line, search it for the tool name and for a phrase from the error — the mistake is usually here already in other words. If a line covers it, sharpen that line with the syntax you actually hit instead of adding a second: a copy costs the prompt twice, CI refuses two near-duplicate rows, and the write tool refuses a line the table already has. This file holds only what is true of this repo or this PC: every line names a path here or a fact about this machine. A general tip goes in `resources/tips/CODING_TIPS.md`; a mistake with a Forge tool goes there under `## FORGE_TOOLS`, starting with the tool's name.

**Not a second copy of the rules.** General behaviour belongs in `config/templates/builtin/execute.njk` (injected for every user); facts about this machine or repo belong in `FORGE.md` (injected here). A line that reads like advice rather than syntax is in the wrong file. **Delete a line once the code refuses the mistake** — name the gate in the commit message instead.

## SEARCH
1. `rg -n x .` → `dist/`, `coverage/`, `docs/reports/**` and one-line `test/fixtures/*.json` drown the answer. exclude them: `rg -n x --glob '!dist/**' --glob '!coverage/**' --glob '!docs/reports/**'`
2. `grep_search` query `toolName:` over `test/**/*.ts` → 30 files of unrelated AppMessage fixtures bury the answer. "does any test pin this text?" greps the exact phrase the code emits
3. `grep_search` `include:"eslint.config.*"` → no matches: this repo's ESLint config is the dotfile `.eslintrc.json` (prettier: `.prettierrc`). glob the dotfile's real name
4. `grep_search` for a phrase copied from a lane brief → hits the brief itself in `.forge/tmp/lanes/*.md` plus all of `coverage/`. anchor it: `include: "src/**"`

## RUN
1. `npx eslint test/unit/x.test.ts` → "none of those TSConfigs include this file": the lint script is `eslint src webview-ui`, so tests have no typed-lint config. lint `src` only
2. `npx tsc --noEmit` → checks `src` only: the root tsconfig excludes `webview-ui` and `test`. a webview-ui change needs `npx tsc --noEmit -p webview-ui/tsconfig.json`
3. `npm run check:changed -- src/tools/webFetchSsrf.ts test/unit/WebFetchSsrf.test.ts` → imports cannot lead to the affected tests, so it runs the FULL suite and the known load class goes red on an unrelated commit. rerun those files alone and report it as contention
4. `cwd: "n:/vs code/apps/Forge"` → `does not exist`: this workspace root has a space, `N:/vs code apps/Forge`. a typo'd cwd refuses the whole call, and a background one loses the job it was starting
5. editing `src/` while `npm run ci` runs → its `build` step bundles the half-edited tree: `No matching export in "src/util/powershellScratchDir.ts" for import "powershellScratchEnv"` and `ci exit: 1` on a tree that is fine. finish the edits, then run the gate
6. `npm run type-check` in a shared tree → dies on the other lane's half-edited file (`undeliveredTells.ts(77,30): error TS6133`) and its chained `&&` skips the webview pass. grep the log for your own paths, then run `npx tsc -p webview-ui/tsconfig.json --noEmit` yourself
7. `test/unit/ToolSchemaBudget.test.ts` red mid-run (`expected 68161 to be 68029`) → another lane's tool-description edit landed while my `npm run ci` was reading the schema, so that number is theirs: rerun the file alone, green, and report it as theirs
8. `tail -5 a.log b.log` in Git Bash → `tail: option used in invalid context -- 5`: the old `-N` form takes one file only. write `tail -n 5`

## GIT
1. `.forge/ci-pass/<tree>.json` → certifies that tree only, and only if green and the tree stood still: never run `record-ci-pass.mjs` by hand — the `ci:steps` chain writes it
2. `git add AI SETUP.md` or `read_file "AI SETUP.md"` → `fatal: pathspec 'AI' did not match any files` / `nothing exists there`: the underscore I typed arrived as a space. the file is `AI_SETUP.md`
3. `git status` showing `M docs/CODING_TIPS.md` after a tips edit → it is tracked (re-admitted in .gitignore), not a local file: only docs/plans and docs/reports are untracked. Name it in the report or it rides along uncommitted
4. another lane has package.json dirty and you edit the same file → their `git commit -- package.json` commits the worktree copy, so your line lands in THEIR commit (f994b9d4). Check `git status` before editing a shared manifest, or land yours first

## EDIT
1. a rename lengthens an identifier, a call takes several arguments on one line, or I hand-split a `.then()` chain → the `prettier/prettier` gate fails at `.prettierrc` printWidth 100. fix: `npx prettier --write <src file>` before the gate
2. `apply_line_edits` on `docs/TOOL_COVERAGE.md` → `ToolHarness.test.ts` diffs it against a fresh generation and normalises only `Generated:`. restore_file it after a demo
3. `npx prettier --write` on a test file → it rewrites lines nobody touched: `test/` is not prettier-clean. --write only the src files the gate lints
4. an edit that grows a src file past 500 lines → eslint `max-lines` (`.eslintrc.json`) errors. check `wc -l <file>` first; move the code into a leaf module

## TEST
1. `fs.rmSync` on a killed child's cwd → EPERM is not in `maxRetries`' retried set, so the retries do nothing. use `removeTreeWhenFree` (test/support/removeTempTree.ts): polls until removable
2. a `ToolApprovalService` card asserted on the posted `confirmRequest` → none arrives: `pump()` posts it only when `getView()` answers truthy. pass a fake view, mock `commands.executeCommand`
3. a fake-timer test around a sleep → use `sleepOrThrow` from `src/util/abortableSleep.ts`: fake timers patch it
4. a fact value for `src/agentBus/agentNote.md` written with its own backticks → the template already wraps `__FORGE_CONFIG__` in backticks, so the line renders doubled ones. pass the bare value
5. a `vi.hoisted` `fs.mkdtempSync(os.tmpdir())` in a test file → teardown fails: `temp leak: <file> left 1 entry in os.tmpdir()`. `test/support/tempGuard.setup.ts` narrows tmpdir per file, so rm it in an `afterAll`
6. a `toContain` pin of `AI_SETUP.md` prose retyped from the brief with a `’` apostrophe → fails: the doc uses ASCII `'`; only its dashes are `—`. copy the sentence from the doc
7. a new top-level `config.yaml` key → `test/unit/ModelReferences.test.ts` fails until it is in `NON_MODEL_REF_FIELDS`, and `config.example.yaml` needs a commented block for it
8. a test reading a media job's `job.json` after `status()` answers `done` → the file still holds `running`: `finish()` in `src/media/remoteMediaJobs.ts` writes without awaiting. poll the file until the field lands
9. a gate setting added to `.github/workflows/ci.yml` only → `publish.yml` runs the same `npm run ci` without it and fails on a tree CI passed. grep every workflow that runs the gate and copy the env
10. a promotion test that guards the `resources/tips/CODING_TIPS.md` add right after guarding the `docs/CODING_TIPS.md` delete → still refused: `src/tools/tipsWriteGuard.ts` only checks, and reads the project file from disk. write the delete to disk first
11. a file-age gate tested as `now = Date.now() + STALE + 1` in `test/unit/JobOutbox.test.ts` → flaky: Windows stamps a file's mtime ahead of `Date.now()`, so the age lands under the threshold and `reclaimOutboxClaims` skips it. pass a whole threshold of margin, never 1 ms
12. a `test/unit/agentTask.test.ts` assertion that the `task_run` marker survived `stopHeartbeat()` → it passes with the fix reverted: that stop clears through a promise chain, so the read lands first. sleep 50 ms before the assertion, then prove it with the revert control
13. a timing probe in `.forge/tmp/` → `npx vitest run` runs nothing: both projects include `test/**/*.test.ts`. give the probe its own config with `resolve.alias` vscode → `test/support/vscode.ts` and `setupFiles: ['test/support/tempGuard.setup.ts']`
14. a `test/unit/ControlServer.test.ts` assertion that `status().listening` is false right after `start()` on a busy port → it is true: `listenOn` assigns `this.server` before the async EADDRINUSE error lands. `vi.waitFor` it
15. any text inside a tool schema (a provider name in `test/unit/ToolSchemaBudget.test.ts`'s own fixture) → that file goes red at `expected 68164 to be 68161`: set `MEASURED_CHARS` to the number the failure prints

## PATHS
1. `zipfile.ZipFile('test/fixtures/sample.xlsx')` in a scan → FileNotFoundError: that is not where the fixture lives. read the test's `fixture()` helper for the real path first
2. `wc -l test/unit/BusContent.test.ts` → no such file: busContent's tests live in `test/unit/AgentBus.test.ts`. `ls test/unit | grep -i <topic>` before naming a test file

## FORENSICS
1. a Canon print job parked in `Printing`, `PrinterStatus 4` → it waits in Canon IJ Preview (Start Printing); `Get-PrintJob` is not installed here: use `Get-CimInstance Win32_PrintJob` / `Win32_Printer`
2. `rg -c "Status: open" docs/FORGE_TOOL_BUGS.md` → the count includes the template line `- Status: open | by design | wont fix | fixed in …`. subtract it, or count per `## ` block with `^- Status: open\s*$`
3. counting shell failures by hand with `^exit \d+` → it matches `exit 0 · 0.6 s` too, so 5,000 instead of 168. mirror `bucket()` in `scripts/session-scan/scan_logs.py`, which only counts a non-zero exit
