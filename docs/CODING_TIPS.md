# Coding tips — exact syntax, one line per mistake

**Recording a mistake.** This table is injected into your system prompt, so there is nothing to open. Before adding a line, search it for the tool name and for a phrase from the error — the mistake is usually here already in other words. If a line covers it, sharpen that line with the syntax you actually hit instead of adding a second: a copy costs the prompt twice, CI refuses two near-duplicate rows, and the write tool refuses a line the table already has. Record in the project's `docs/CODING_TIPS.md`, never in the shipped table, which arrives read-only.

**Not a second copy of the rules.** General behaviour belongs in `config/templates/builtin/execute.njk` (injected for every user); facts about this machine or repo belong in `FORGE.md` (injected here). A line that reads like advice rather than syntax is in the wrong file. **Delete a line once the code refuses the mistake** — name the gate in the commit message instead.

## SEARCH
1. `rg -n "x" .` over the repo → `dist/`, `coverage/`, `.forge/tmp/`, `docs/local/**` corpora and one-line `test/fixtures/*.json` drown the answer (42 MB once). exclude each with `-g`

## RUN
1. `stop_execution` on a background `npm run ci` → the wrapper dies, the child tree lives and holds the ci-lock, so the next run waits forever: `MSYS_NO_PATHCONV=1 taskkill /PID <top> /T /F`
2. `npx eslint test/unit/x.test.ts` → "none of those TSConfigs include this file": the lint script is `eslint src webview-ui`, so tests have no typed-lint config. lint `src` only
3. `npx prettier --check .forge/x.ts` → "All matched files use Prettier code style!" while nothing was checked: prettier matches no file in a dot-folder. copy it into `test/unit/`
4. `grep_search` with `output_mode: "content"` → refused: unknown argument, the field is `output` (content/files/count). never invent an argument name from another tool

## GIT
1. `.forge/ci-pass/<tree>.json` → certifies that tree only, and only if green and the tree stood still: never run `record-ci-pass.mjs` by hand — the `ci:steps` chain writes it

## EDIT
1. a rename lengthens an identifier, or a new call takes several arguments on one line → the `prettier/prettier` gate fails at printWidth 100. fix: `npx prettier --write <file>`
2. `apply_line_edits` on `docs/TOOL_COVERAGE.md` → `ToolHarness.test.ts` diffs it against a fresh generation and normalises only `Generated:`. restore_file it after a demo
3. `npx prettier --write` on a test file → it rewrites lines nobody touched: `test/` is not prettier-clean (lint is `eslint src webview-ui`). --write only the src files the gate lints
4. an edit that grows a src file past 500 lines → eslint `max-lines` errors, same limit as the tool's warning. check `wc -l <file>` first; move the code into a leaf module
5. an `edit_file` batch carrying a no-op edit (`old_str` already equals `new_str`) → refused: not found, an earlier edit in that same batch moved the anchor. drop the no-op edit
6. a delegate method written to fit one line under a `max-lines` cap → prettier expands `{ return x; }` into three lines. keep it one line as an arrow class property: `undo = (): Promise<string[]> => this.actions.undo();`

## TEST
1. `fs.rmSync` on a killed child's cwd → EPERM is not in `maxRetries`' retried set, so the retries do nothing. use `removeTreeWhenFree` (test/support/removeTempTree.ts): polls until removable
2. a `ToolApprovalService` card asserted on the posted `confirmRequest` → none arrives: `pump()` posts it only when `getView()` answers truthy. pass a fake view, mock `commands.executeCommand`
3. vitest fake timers do not patch `node:timers/promises` → that sleep waits real time, so a fake-timer test times out at 5 s. use `sleepOrThrow` from `src/util/abortableSleep`

## PATHS
1. comparing a tool's resolved path with the workspace root in a test → `fs.realpathSync` keeps the 8.3 short form `EFSOOF~1`, `fs/promises` `realpath` expands it: use the tool's resolver
2. `zipfile.ZipFile('test/fixtures/sample.xlsx')` in a scan → FileNotFoundError: that is not where the fixture lives. read the test's `fixture()` helper for the real path first
3. `npx tsc --noEmit` → checks `src` only: the root tsconfig excludes `webview-ui` and `test`. a webview-ui change needs `npx tsc --noEmit -p webview-ui/tsconfig.json`
4. `wc -l test/unit/BusContent.test.ts` → no such file: busContent's tests live in `test/unit/AgentBus.test.ts`. `ls test/unit | grep -i <topic>` before naming a test file

## FORENSICS
1. a print job parked in `JobStatus Printing` with `PrinterStatus 4` for minutes → the driver is waiting in its own preview window (Canon IJ Preview: Start Printing). screenshot the screen; the queue proves nothing
2. `Get-PrintQueue`/`Get-PrintJob` → not recognized here (no PrintQueue module). job state: `Get-CimInstance Win32_PrintJob`; printer state: `Win32_Printer` `PrinterStatus` (3=idle 4=processing)
