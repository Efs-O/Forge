# Shell tool and core tool group

Status: approved 2026-10-07 (user: "write the plan and go full auto"). Supersedes
the exec parts of `TOOL_SURFACE_AND_SHELL_ACCESS_PLAN.md` (phases 1–2) and
extends its phase 3 (native lazy groups). Target release: 0.17.0.

## Why

The 2026-10-06 harness pilot (`docs/plans/HARNESS_COMPARISON_PLAN.md`,
`N:\vs code apps\harness-bench\results\results.md`) ran Forge and OpenCode on the
same Strata Qwen and the same 5 tasks. Both passed all 5. Forge used 2.7× the
wall time (1,392 s vs 510 s), 2.2× the requests (85 vs 39), 2.9× the prompt
tokens (1.83M vs 0.64M) and had 7 tool errors to OpenCode's 0.

The causes were ours, not the model's:

1. **`exec_command` has no shell.** It spawns with `shell: false`: no pipes, no
   globs, no `&&`. Task 4 took 43 `rg` calls, one file at a time; OpenCode did
   the same work in 6 PowerShell pipelines. OpenCode's "bash" tool runs
   PowerShell on Windows.
2. **41 eager tool schemas** against OpenCode's ~9. Forge's first request was
   about 11.0K tokens to OpenCode's 7.7K.
3. **Inconsistent schemas.** `edit_file` takes `filepath`; 22 other tools take
   `path`. Qwen sent `exec_command.args` as a string.
4. **`/init` wrote a transient fact** ("test failing at HEAD") into FORGE.md,
   where every later turn paid for it.
5. **About 20% of the Forge repo's own FORGE.md (5.2 KB) is workarounds for our
   tool restrictions:** the `-File` guard bypass, never quoting spaced paths,
   `query_powershell` + `taskkill`, a 22-line VSIX install recipe through
   `Code.exe` + `ELECTRON_RUN_AS_NODE`.

The 2026-09-30 audit of 15,676 Qwen calls found **0 destructive-intent
commands**. The shell ban bought no safety. It cost rounds, tokens and the
prompt rules written to route around it.

Tool calls in the last 30 days (205 session files, deduplicated, 2026-10-07):
read_file 7,630 · exec_command 6,437 · search_code 4,132 · edit_file 2,953 ·
write_file 886 · monitor_execution 739 · list_directory 607 · update_plan 436 ·
find_files 410 · web_fetch 308 · ask_live_session 264 · git tools ~800 combined ·
delete_file 184 · wait 160 · query_powershell 138 · read_tool_result 113 ·
manage_jobs 100 · notify_user 95 · web_search 84 · append_file 83 · ask_user 65.
Everything else is under 65.

## Decisions (user, 2026-10-07)

- A real shell tool replaces `exec_command`. On Windows the default is **pwsh 7**.
  **Git Bash** is available, and **WSL is never used**. Elsewhere the default is
  `bash`.
- A small **core** tool set is always advertised. Everything else moves to lazy
  groups.
- The **approval window stays.** The prompt still tells the agent not to run
  destructive commands. Read-only commands are auto-approved. Destructive
  commands always confirm, even in `/clanker` mode.
- **No checkpoint or Undo for shell changes.** The user does not want them now
  ("maybe later"). Keep/Undo for Forge's file tools is unchanged. README says
  plainly that shell changes are not captured, and git is the way back.
- FORGE.md and the system prompt lose the tool workarounds the shell makes
  unnecessary.
- `/init` records lasting facts only.
- **CLAUDE.md hard-stop amendment.** "No tools with free-form `string` blob args"
  gets one named exception: the `shell` tool's `command`. The control is the
  approval gate and the destructive classifier, not the schema. The user
  approved this on 2026-10-07.

## Phase A — `shell` tool (owner: Codex agent A)

New `src/tools/shellTool.ts`, with `src/tools/shellPolicy.ts` (classifier) and
`src/tools/shellOutput.ts` (cap and spill).

**Schema** (strict, `additionalProperties: false`):

| Field | Type | Notes |
|---|---|---|
| `command` | string, required | One command line for the configured shell. Pipes, `&&`, globs, redirection all work. |
| `cwd` | string | Workspace-relative or absolute; same resolution as today (`resolveExecCwd`). The description says the workspace root is not the project root. |
| `timeout_ms` | integer, 1000–600000 | Foreground default 120,000. Past the deadline the process tree is killed and the partial output returned with `timed out`. |
| `background` | boolean | Start and return an `execution_id` (existing `BackgroundExecutionManager`). |
| `notify_on_exit` | boolean | Requires `background`; same semantics and text as today (`NOTIFY_ON_EXIT_DESCRIPTION`). |
| `shell` | enum `pwsh` \| `bash` | **Windows only**: the field is added by the registry's per-call definition builder on win32 only, not via `advertise`, which is a boolean predicate. Overrides the configured default for one call. |

The tool has no `args` array, no `env`, no `show_window` and no output-shaping
options. `Start-Process` covers a visible GUI launch. `Select-Object -Last`,
`tail` and `Select-String` cover output shaping.

**Invocation.** `spawn(shellExe, argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })`:

- **pwsh:** `pwsh.exe -NoLogo -NoProfile -NonInteractive -Command <prefix><command>`.
  The prefix is `[Console]::OutputEncoding=[Text.Encoding]::UTF8;` so native tools'
  UTF-8 survives. The exit code is pwsh's own, which follows `$LASTEXITCODE` when
  the last statement is a native program.
  - Resolve `pwsh.exe` on PATH, then `%ProgramFiles%\PowerShell\7\pwsh.exe`.
  - **If it is missing, refuse and name the fix:** install PowerShell 7 (the MSI,
    not the Store package, see CLAUDE.md § CLI Agent Delegation) or set
    `permissions.exec.shell: powershell`. Never fall back silently.
- **powershell** (config only): Windows PowerShell 5.1, same argv.
- **bash on Windows:** Git Bash via the existing `resolveGitBash()`, as
  `bash.exe --noprofile --norc -c <command>`. When Git Bash is absent, refuse
  with the fix. **Never** bare `bash`, which is WSL (CLAUDE.md § Code Quality
  Gates).
- **bash elsewhere:** `/bin/bash`, or `bash` on PATH; `-c <command>`.

The environment is the extension host's, plus `FORGE_CONVERSATION_ID` (as today)
and `GIT_TERMINAL_PROMPT=0` so a credential prompt fails instead of hanging. The
README documents both variables.

On abort or timeout, kill the **process tree of the child Forge spawned**:
`taskkill /PID <pid> /T /F` on Windows, a process-group kill elsewhere. Reuse the
existing helper in `execHelpers.ts`/`BackgroundExecutionManager` if one exists.
Never kill by name.

**Output** (`shellOutput.ts`). The result is plain text, not JSON:
`exit <code> · <secs> s[ · timed out]` on the first line, then stdout and stderr
interleaved in arrival order (approximate across the two pipes).

- **Cap: 30,000 characters.** Over the cap, keep the first 10,000 and the last
  20,000 and write `[… N characters omitted. Full output: <path> — search it with
  the shell (Select-String / rg / tail) instead of rerunning the command]`.
- The full output is written to
  `~/.forge/shell-output/<conversationId>/<toolCallId>.log`. Writing it to the
  workspace would leave litter in the repo.
- **Sweep:** on activation, delete files and empty dirs under
  `~/.forge/shell-output/` older than 24 h.
- Reading a spill file with the shell is classified read-only, so it never
  prompts.
- A spill write failure is reported in the result line ("full output could not be
  saved: <error>"), never swallowed.

**Approval** (`shellPolicy.ts` + one hook in `ToolDispatch.ts`). Add
`autoApproveIf?: (args) => boolean` to `RegisteredTool` and check it in
`needsConfirm` beside `autoApprove`. `classifyShellCommand(command, shell)`
returns `'read_only' | 'normal' | 'dangerous' | 'refused'`:

- **Tokenizer:** a small quote-aware splitter for the target shell's syntax
  (single/double quotes, backtick escape in pwsh, backslash in bash). It splits
  statements on `;`, `&&`, `||`, `|` and newline, and records redirections (`>`,
  `>>`, `2>`, `*>`, `| Out-File`, `| Set-Content`, `| tee`). **Matching is on
  whole tokens, never substrings.** This is CLAUDE.md § Agent-Ergonomics Traps:
  `git rm -f README.md` must not match `rm -rf`, and `-replace ';'` must not
  split a statement.
- **`read_only`** applies only when every statement's program is on a read-only
  list, there is no redirection to a file, no background `&` (bash), and no
  subexpression (`$(…)`, backticks, `& {…}`, `Invoke-Command`, `Start-Process`, `-EncodedCommand`).
  - **pwsh:** `Get-ChildItem`, `Get-Content`, `Get-Item`, `Get-Location`,
    `Select-String`, `Select-Object`, `Sort-Object`, `Group-Object`,
    `Measure-Object`, `Format-Table`/`List`, `Out-String`, `Test-Path`,
    `Resolve-Path`, `Split-Path`, `Join-Path`, `Get-Command`, `Get-Process`,
    `Get-Date`, `ConvertFrom-Json`, `Write-Output`, plus aliases `ls`, `dir`,
    `cat`, `type`, `gci`, `gc`, `sls`, `select`, `where`, `sort`, `measure`, `echo`.
    `ForEach-Object` and `Where-Object` count only under the scriptblock rule
    below.
  - **bash:** `ls`, `cat`, `head`, `tail`, `grep`, `rg`, `find` (refused as
    read-only if `-delete`/`-exec`/`-execdir`/`-ok` appear), `wc`, `sort`,
    `uniq`, `cut`, `tr`, `awk`/`sed` (`sed` without `-i`), `echo`, `pwd`, `which`,
    `file`, `stat`, `diff`, `jq`, `realpath`, `dirname`, `basename`, `date`.
  - **Both:** `rg`, `git` with subcommand `status`, `diff`, `log`, `show`,
    `blame`, `grep`, `ls-files`, `rev-parse`, `describe`, `branch` (no flags
    other than `-a`/`-r`/`-v`/`--list`/`--show-current`), `remote -v`,
    `config --get`. `node --version` / `npm --version` style version probes are
    included too.
- **`dangerous`** always confirms, even in `/clanker`. In unattended jobs it is
  denied by the existing `ToolApprovalPolicyDenied` path. It covers recursive
  deletion (`rm -r*`, `Remove-Item -Recurse`, `rd /s`, `rmdir /s`, `del /s`), the
  history- and work-destroying git family already in `DenyList.ts` (`reset
  --hard`, `clean -f`, destructive `checkout`/`restore`, force/delete/mirror
  push, `rebase`, `branch -d/-D`, `stash drop/clear`, `filter-branch`, `reflog
  expire`), `Invoke-Expression`/`iex`, SQL `DROP`, and process killing
  (`Stop-Process`, `taskkill`, `kill`, `pkill`). The approval detail names the
  matched rule.
- **`refused`** never runs. It covers disk format, `diskpart`, power commands
  (`shutdown`, `Restart-Computer`, `Stop-Computer`; the `system` group has
  `sleep_computer`), `-EncodedCommand`/`-enc`, and download-piped-to-shell
  (`curl … | sh`, `iwr … | iex`). Every refusal names its alternative
  (`DenyListEntry.alternative`).
- **`normal`** is everything else. It confirms unless `/clanker` is on.

**Wiring to `ToolDispatch`.** Approval is asked *before* the handler runs.
`needsConfirm` is `approval(args) !== undefined || (!autoApprove && …)`, so the
shell tool sets the hooks per class:

| Class | `approval(args)` | `autoApproveIf(args)` | Handler |
|---|---|---|---|
| `read_only` | `undefined` | `true` | runs |
| `normal` | `{ detail: <command + cwd + shell>, dangerous: false }` | `false` | runs |
| `dangerous` | `{ detail: <command + matched rule>, dangerous: true }` | `false` | runs |
| `refused` | `undefined` | `true` | throws the refusal before any spawn |

`refused` skips the prompt on purpose: the user is never asked to approve a
command that cannot run. Classify once per call, and memoise on the args object
so the hooks and the handler agree.

**Scriptblocks.** Classify the contents of `{…}` passed to `ForEach-Object` and
`Where-Object` as statements, recursively. Any other scriptblock, any
`$(…)`/backtick subexpression, and `& …` disqualify `read_only` and make the
command `normal` at most. Dangerous and refused rules still apply inside them.

`DenyList.ts` becomes the rule table behind `dangerous`/`refused`. Rewrite its
regexes as token rules, and keep `isRecursiveForceDelete`,
`isDestructiveGitCheckout` and `isDestructiveGitPush` as the token predicates.
Its other callers (grep `checkDenyList`) move to the classifier or are deleted
with their tool.

**Remove** (grep every reference first, update or delete each). Delete
`execTools.ts` and `safePowerShellTool.ts` (`query_powershell`). Delete
`execScriptScanner.ts`, `execEnvPolicy.ts`, `execHints.ts` and the
operator/PowerShell-ban half of `execHelpers.ts`. From `execProgramResolver.ts`,
keep `resolveGitBash` and the npm/npx/rg resolution only if the shell still needs
it; it should not, because the shell resolves PATH itself. Delete the
corresponding tests.

Do not touch `src/agents/adapters/codexAdapter.ts` or
`test/fixtures/fake-codex-cli.mjs`. Their `exec_command` is **Codex CLI's own
event name**, not our tool.

`get_system_status` uses `src/system/systemProbes.ts`. If that imports from
`safePowerShellTool.ts`, move the probe helper into `systemProbes.ts` (its
owner); do not delete the capability.

**Config** (`src/config/schema.ts`): the existing `permissions.exec` block.

- `headless` keeps its meaning: it grants the `shell` tool.
- `terminal` is unchanged in config and in `resolveToolPermissions`. No native
  tool uses it after `run_terminal` goes, but MCP servers may declare
  `tool_permissions: terminal`, and dropping the capability would silently hide
  their tools.
- New `shell: z.enum(['pwsh','powershell','bash']).optional()`. Unset means
  `pwsh` on win32 and `bash` elsewhere, decided at the call site and documented.
  An explicit choice, not a hidden fallback.
- `shell_scripts` is still accepted, so existing configs boot, but it grants
  nothing. Delete the `shell_scripts requires headless` refinement. A one-line
  warning on config load names the key.
- `StarterConfig.ts` writes `exec: { headless: true }`.

**Background.** `shell` with `background: true` calls
`BackgroundExecutionManager.start` with the shell invocation. `monitor_execution`,
`stop_execution` and `list_executions` keep working unchanged. Background output
is capped by the manager's existing store. The spill file applies to foreground
results only.

**Tests (A).** Cover:

- classifier tables: at least 40 cases across the four classes, including the
  substring traps above, quoted operators, `find -delete`, `sed -i`, `git branch
  -D`, `Remove-Item -Force` (normal, not recursive), `rm -rf` (dangerous) and
  `iwr | iex` (refused)
- `autoApproveIf` in `ToolDispatch`: read-only skips the prompt, normal prompts,
  dangerous prompts under clanker
- pwsh pipeline and exit code (skip without pwsh)
- Git Bash `-c` via `TEST_BASH` from `test/support/bash.ts`, never bare `bash`
- timeout kills the tree
- abort kills the tree
- cap and spill: exact head and tail sizes, the spill file holds the full
  output, and the sweep deletes a 25 h file and keeps a 1 h one
- missing pwsh refuses with the fix text
- background start and `notify_on_exit` validation

## Phase B — Core set and lazy groups (owner: Codex agent B)

**Core**, always advertised when its permission allows it:

| Tool | Why core |
|---|---|
| `read_file`, `edit_file`, `write_file` | 7.6K / 3.0K / 0.9K calls |
| `search_code`, `find_files`, `list_directory` | 4.1K / 0.4K / 0.6K. Structured results, workspace-relative paths, no approval. |
| `shell` | replaces 6.4K `exec_command` + 138 `query_powershell` + ~800 git-tool calls |
| `monitor_execution` | 739 calls; background jobs need it without a re-prefill |
| `update_plan` | 436 |
| `read_tool_result` | 113; recovery after compaction |
| `ask_user` | 65; small schema; the only way to ask mid-turn |
| `web_fetch`, `web_search` | only when `permissions.net` grants them (off in the bench config) |
| `load_tool_group` | advertised when any group is available |

**Lazy groups** extend `NATIVE_GROUP_BY_TOOL` in `src/tools/lazyToolGroups.ts`.
The existing groups `computer_use`, `media`, `editor_ui`, `system` and `notebook`
are unchanged. New groups:

| Group | Members |
|---|---|
| `files` | `delete_file`, `move_file`, `create_directory`, `append_file`, `apply_line_edits`, `restore_file` |
| `git` | `git_read`, `stage`, `commit`, `create_branch`, `switch_branch` |
| `code_intel` | `code_intel`, `rename_symbol`, `apply_code_action`, `format_file`, `search_codebase` |
| `memory` | `remember`, `recall`, `list_memories`, `forget` |
| `background` | `stop_execution`, `list_executions`, `wait` |
| `agents` | `ask_live_session`, `tell_live_session`, `ask_local_agent`, `list_delegation_targets`, `manage_jobs`, `notify_user` |
| `system` (existing, extended) | add `get_system_status` |

Each of these tools still self-suppresses as it does today. A group with no
advertised member is not offered.

**Eager-group config.** `ask_live_session` (264), `manage_jobs` (100) and
`notify_user` (95) are heavy in the user's own Telegram workflow and absent in
the bench. Add `tool_groups: { eager: z.array(z.string()).default([]) }` at
defaults/group/model level, resolved like `max_tool_rounds` in
`ConfigResolver.ts` (model > group > defaults). Members of an eager group are
advertised from the first request.

- `hiddenLazyToolNames(conversationId)` treats eager groups as never hidden. They
  are not added to the per-conversation active map, so compaction does not drop
  them.
- An unknown group name fails Zod at load, with the list of valid names (a
  `superRefine` against the static group list; MCP server groups are validated
  after bridging and warned about, not failed).
- The comment in the shipped example config says what each group costs.

**Removed tools.** `run_terminal` (delete `makeRunTerminalTool`, and
`TerminalCommandTracker` only if nothing else uses it — the turn context that
lists user-run terminal commands is a separate feature, so check
`terminalCommandContext`). Also `run_workspace_task` and `list_workspace_tasks`
(`taskTools.ts`), which had 4 calls in 30 days. The shell runs the same npm
scripts. Update every reference:

- `registerAllTools.ts`
- `compactionLedger.ts`
- `remoteProgressText.ts`
- `src/benchmark/terminalTools.ts` and `toolHost.ts` (keep the benchmark harness
  green)
- `toolResultView.ts` `READ_ONLY_TOOLS`
- `ToolLoopGuard`
- MCP `tool_permissions` docs
- `test/prompt-context-measurement.txt` (regenerate, don't hand-edit)
- `ToolSchemaBudget`, `RegisterAllTools` and `ToolDispatch` tests

**`edit_file` uses `path`.** Rename `filepath` to `path` in `editFileTool.ts`:
schema, `mutation.paths`, handler, error strings and tests. No alias: the schema
is strict, and a stale name fails validation with the field list.

**`load_tool_group` description.** It gives one line per available group with its
member names. Budget ≤ 450 tokens, enforced in `ToolSchemaBudget.test.ts`.

**Template** (`config/templates/builtin/execute.njk`; `src/templates/builtin/` is
dead, so delete that copy in this phase after grepping that no build step,
test or packaging rule references it). Remove the lines about `exec_command`,
shell operators, the "must press Enter" terminal rule, the user-run terminal
paragraph only if `terminalCommandContext` goes, and "Shell deletion commands
are refused". Replace them with one shell rule:

> The `shell` tool runs <pwsh|bash> — pipes, globs and `&&` work. Prefer
> search_code/find_files/read_file for reading code; use the shell for builds,
> tests, git and anything else. Never run destructive commands (recursive
> deletes, `git reset --hard`, force push, killing processes) unless the user
> asked for exactly that; they always require the user's approval. Long
> commands: `background: true` with `notify_on_exit`, or `monitor_execution`.

Keep the date paragraph but drop "do not ask the shell for the time — that is
banned". It also names `wait`, which is now lazy: say `monitor_execution`
reports the wall clock, and `wait` lives in the `background` group. Target ≤ 3,500 bytes, down from 4,503.

**Tests (B).**

- core set equality for a StarterConfig-like config
- each new group's membership
- `tool_groups.eager` resolution and its Zod failure
- `load_tool_group` budget
- `edit_file` `path`
- removed tools absent from `registry.names()`
- the existing lazy-group dispatch refusal still names the group

## Phase C — `/init` and the starter FORGE.md (owner: Qwen via OpenCode on Strata; Claude reviews)

Files: `src/sidebar/initForgeCommand.ts`, `src/llm/ForgeInstructionsLoader.ts`
and their tests.

- **`buildInitPrompt`:** replace "If one fails for a reason that is not yours to
  fix, write it with the failure noted" with: write down only facts that will
  still be true next month. Never record test results, failing tests, the current
  branch, counts, dates or anything about the current working-tree state. If a
  command fails, find out why. Write it down only with the permanent prerequisite
  it needs (e.g. "needs Docker running"). Otherwise leave it out and say so in
  your reply.
- **Starter content:**
  - Drop "or a script that does the same thing is not the fix"; there is no guard
    to bypass now.
  - Keep "A refusal is an answer".
  - Reword "Waiting on a long command" to the shell's `background` +
    `notify_on_exit`.
  - Nothing else changes.
- **Tests:** the prompt contains the "next month" rule and does not contain
  "failure noted". The starter does not mention `exec_command`.

If Qwen has not finished by the time A and B merge, Claude does it. It is under
30 lines.

## Phase D — Docs, CLAUDE.md, FORGE.md (owner: Claude)

- **CLAUDE.md:**
  - The hard-stop exception for `shell.command` (wording under Decisions).
  - Architecture Rules: tool calls use strict schemas, "except `shell.command`".
  - Code Quality Gates: "`exec_command` does the same" becomes the shell tool's
    Git Bash rule.
  - The "`src/templates/builtin/` is DEAD" note: delete it once phase B deletes
    that folder.
  - Agent-Ergonomics Traps: mark the `exec_command`-era notes historical where
    they name removed tools; keep the lessons.
- **README:**
  - Tool overview: core + groups, with the re-prefill cost number from the
    TOOL_SURFACE plan phase 0.
  - Responsibility and Risk:
    - The shell runs anything your account can.
    - The classifier is pattern matching, not a sandbox.
    - Shell changes are **not** checkpointed; git is the only way back.
    - Destructive commands always confirm.
  - Config keys `permissions.exec.shell` and `tool_groups.eager`.
  - Removed tools.
- `docs/OWNERS.md`: rows for `shellTool.ts`, `shellPolicy.ts`, `shellOutput.ts`;
  remove the deleted files.
- `docs/TOOL_COVERAGE.md`: refresh.
- `CHANGES.md`: a 0.17.0 entry listing removed tools as a breaking change.
- **The Forge repo's FORGE.md** (the user's, gitignored):
  - Back up to `~/.forge/backups/FORGE.md.<date>` first.
  - Remove the tool-workaround lines (11–19, 177–185, 192–214, 248–261, 293–314
    as of 2026-10-06; re-read before cutting, since lines move).
  - Replace the VSIX install recipe with the one-line `code --install-extension`
    form.
  - Delegation, mesh, image and remote rules stay. They are not workarounds.
  - Report bytes before and after.

## Phase E — Integrate, gate, install, live test (owner: Claude)

1. **Merge** A, B and C into `main`, one commit per phase. Resolve the expected
   overlap in `registerAllTools.ts`, `ToolDispatch.ts` and the registry and
   dispatch tests by hand.
2. **Version:** bump `package.json` to 0.17.0 (`npm version 0.17.0
   --no-git-tag-version`). No tag.
3. **Gate:** `npm run ci`, then `npm run package`. Both green, and **no
   `max-lines` disable** added.
4. **Measure:** tool-schema tokens for the bench config and for StarterConfig
   (`ToolSchemaBudget`), the first-request prompt tokens on Strata, and
   `execute.njk` bytes. Record them in § Results.
5. **Install into the bench profile:**
   `code --user-data-dir "<grader>/vscode-profile" --extensions-dir "<grader>/vscode-ext" --install-extension forge-llm-0.17.0.vsix --force`.
   Then close and relaunch only the bench window. It is ours; its endpoint is
   port 8798. Never touch the user's main window.
6. **Live test on Strata in the bench window:**
   - One turn per class: a read-only pipeline must not prompt; a normal write
     prompts once; `Remove-Item -Recurse` prompts as dangerous under `/clanker`.
   - A 2 MB output must spill.
   - A background job must use `notify_on_exit`.
   - `/init` on the bench repo must write no transient facts.
7. **Uncounted smoke:** pilot tasks 4 and 5 with the new build, Forge only, through
   a copy of `pilot.sh` that appends to `results/smoke-0.17.jsonl`. **Not**
   `pilot.jsonl`: the stock script appends there, and the smoke must never mix
   into the pilot table. Compare against the pilot numbers in § Results.
8. **Main profile:** `code --install-extension forge-llm-0.17.0.vsix --force`.
   Tell the user it takes effect on their next window reload. **No tag or push
   until the user has seen § Results.** Releases are immutable.

## Parallel run

- **Before the run:** commit this plan and the pending `HARNESS_COMPARISON_PLAN.md`
  edit to `main`.
- **Worktrees:** `git worktree add ../forge-wt-a` and `../forge-wt-b` (and
  `../forge-wt-c` for Qwen), each on its own branch from that commit. The
  branches are local integration branches, merged by Claude and deleted after.
  - Copy CLAUDE.md into each worktree.
  - Run `npm ci` in each. **Never junction node_modules.**
- **Codex:** `codex exec -m gpt-6-luna -c model_reasoning_effort=high
  --skip-git-repo-check`, one per worktree, with this plan's phase section as the
  task and `npm run ci` green as the stop condition.
- **File ownership:**
  - A owns `src/tools/{shell*,exec*,DenyList,safePowerShellTool,BackgroundExecutionManager}.ts`,
    `ToolRegistry.ts` (`autoApproveIf` only), `ToolDispatch.ts` (`needsConfirm`
    only), and `src/config/schema.ts` `permissions.exec`.
  - B owns everything else in its list, including the `tool_groups` config.
  - Both may edit `registerAllTools.ts`: A the exec block, B the rest.
  - **Neither edits `execute.njk` except B.**
- **Qwen (C):** `oc-run.sh` from the harness grader, on Strata, in
  `../forge-wt-c`. Run C after the Codex runs start, once Strata's `/slots` reports idle.
  The Codex agents use OpenAI, not Strata; the user's own window may not.

## Not in scope

- Checkpoint or Undo for shell changes (user decision; maybe later).
- Removing Keep/Undo for file tools.
- Merging `monitor_execution`, `stop_execution` and `list_executions` into one
  tool.
- Round 2 of the harness benchmark. It is a separate run on a frozen 0.17.0
  build, after this plan's results.
- MCP tool groups (unchanged).

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| Spill files `~/.forge/shell-output/<conv>/<call>.log` | `shell` foreground result over 30,000 chars | activation sweep removes files and empty dirs older than 24 h; user may delete any time (nothing references them after the turn) | none needed — only created on overflow; no setting | streamed write; a torn file is still a readable prefix, and the result line says the write failed if the stream errored | file stays; next activation's sweep removes it after 24 h | 24 h, enforced by the sweep (CI test) |
| `permissions.exec.shell` (config.yaml) | user edits config.yaml | user removes the key → per-platform default (pwsh on Windows, bash elsewhere) | n/a — choosing a shell is not a capability; `exec.headless: false` disables the tool | half-written config fails Zod at load and Forge surfaces the error | none — config outlives Forge | none |
| `tool_groups.eager` (defaults/group/model) | user edits config.yaml | user removes the key → `[]` | set `[]` | half-written config fails Zod; unknown group name fails Zod with the valid names | none | none |
| Deprecated key `exec.shell_scripts` | already in old configs | user removes it | grants nothing; a load warning names it | n/a | n/a | none — accepted until a later major version removes it, with a CHANGES.md note |
| Background shell processes | `shell` with `background: true` | `stop_execution`, process exit, or window close (existing `BackgroundExecutionManager` disposal) | n/a | n/a — not a file | existing behaviour: children are killed on extension deactivate | the job's own `timeout_ms` when set; otherwise none (unchanged) |
| Active lazy groups per conversation (in-memory) | `load_tool_group` (eager groups are never in this map; they are simply not hidden) | compaction, conversation delete, window reload | removing a group from `tool_groups.eager` hides it from the next turn unless it was loaded | not durable | lost on reload; the model reloads (one round + one re-prefill) | cleared at each compaction |
| FORGE.md backup `~/.forge/backups/FORGE.md.<date>` | Claude, phase D, before trimming | user | n/a | copy, not move: the original stays until the copy is verified | n/a | none — the user deletes it |
| Integration worktrees `../forge-wt-{a,b,c}` + branches | phase E setup | `git worktree remove` + `git branch -d` after merge (not `--force`; never with a junctioned node_modules) | n/a | a crashed agent leaves its worktree; Claude inspects before removing | the worktree outlives the agent; Claude removes it after merging | removed in phase E; `git worktree list` is checked at the end |

**CI-enforced rows:**

- A unit test runs the spill sweep against a temp dir with a 25 h-old and a 1 h-old
  file and asserts that only the old one is deleted.
- A config test asserts `ForgeConfigSchema.parse({})` yields no `exec.shell`
  (per-platform default at the call site), `tool_groups.eager` `[]`, and that
  `StarterConfig` does not set `tool_groups.eager`.

A later phase that adds a new durable artifact must add its row here, or
`PlanLedgerContract.test.ts` will not see it. Its reviewer checks the table.

## Acceptance criteria

- `exec_command`, `query_powershell`, `run_terminal`, `run_workspace_task` and
  `list_workspace_tasks` are absent from the registry. A grep of `src/` and `config/`
  for each name hits only `codexAdapter.ts` (Codex's own event name) and
  `compactionLedger.ts` if it must still read pre-0.17 transcripts. The last is
  a commented legacy list, never advertised.
- The classifier tests pass, including every substring trap listed in phase A.
  Read-only commands run with no prompt. A `dangerous` command prompts under
  `/clanker` and is denied unattended. A `refused` command never spawns.
- On Windows the shell runs pwsh 7 by default, and Git Bash with `shell: bash`.
  No code path can start `C:\Windows\System32\bash.exe` (test).
- Over 30,000 characters, the result shows head + tail + spill path, and the
  spill holds the full output.
- Tool schemas for the bench config are **≤ 4,000 tokens**, measured with
  `ToolSchemaBudget`. `execute.njk` is **≤ 3,500 bytes**. The bench first request
  is measured on Strata and recorded next to OpenCode's 7.7K.
- `edit_file` takes `path`, and no core tool takes `filepath`.
- `/init` on the bench repo writes no test result, branch, count or date into
  FORGE.md (live check).
- README, CLAUDE.md, OWNERS.md, TOOL_COVERAGE.md and CHANGES.md are updated as
  in phase D. The Forge FORGE.md trim is reported in bytes, with a backup.
- `npm run ci` and `npm run package` are green. The VSIX is live-tested in the
  bench profile on Strata (phase E step 6) before anything is tagged.
- The uncounted smoke of pilot tasks 4 and 5 is recorded. **No benchmark claim
  is made from it.** Round 2 runs on the frozen build.

## Results

(filled in phase E)
