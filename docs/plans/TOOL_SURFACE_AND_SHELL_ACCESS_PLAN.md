# Tool Surface & Shell Access Plan

Status: **implemented 2026-09-30** — phase 0 measured; phase 1 `2d3bd56`, phase 2 `6aa8732`, phase 3 `8b18a5b` + `a6e9328`.

Opt-in shell scripts for the agent, a smaller always-on tool list, and README
warnings that tell a new user what each switch really hands over.

## Why this exists — the 2026-09-30 audit

Source: `~/.forge/sessions`, 2026-09-10 → 09-30, 107 sessions, **15,676 Qwen tool
calls**, rows deduplicated by whole-line hash (every file postdates the 0.13.20
re-append fix), calls paired to results positionally. Split at 0.16.51 (`e25eacd`,
the last tool-description trim).

**Destructive intent is absent.** 0 × `rm -rf`, 0 × `sudo`, 0 × `Remove-Item
-Recurse`, 0 × `del /s`. The only destructive shapes: `git push` ×8 (6 refused —
publishing is the user's call), `taskkill /F` ×3 (allowed), `git restore`/`checkout
--` discarding changes ×2 (refused, correctly), `git reset --mixed` ×1 (refused —
a false positive: `--mixed`/`--soft` are reflog-recoverable).

**The shell ban does not protect anything; it costs rounds and litters the repo.**

| | before 0.16.51 | after |
|---|---|---|
| refusals / all calls | 67 / 11,470 (0.58%) | 26 / 4,206 (0.62%) |
| `pwsh -Command` refused | 26 | 15 |
| `cmd /c`, `bash -c` refused | 11 | 4 |
| builtin / Unix util missing (`dir`, `grep`, `type`, `wc`, `echo`) | 20 | 5 |

`-Command` is banned but `-File` is not: 76 `pwsh -File` runs of **39 distinct
model-written scripts** against 44 refused `-Command` attempts. After a refused
`-Command`, the next call was `write_file` 9 times — the model writes the same
script to disk and runs it. That is the source of the untracked
`scripts/test-*.ps1`, `demo-*.ps1`, `diag-*.ps1` files in the tree today. The
denylist never sees those scripts' contents, so the ban buys no safety, only
extra rounds. The description trim did not move the rate either (0.58% → 0.62%):
this is a policy problem, not a wording one.

**Two tools are mostly bypassed.** `exec_command npm test|vitest` 350 vs `run_tests`
52; `exec_command npm run build|ci|lint|type-check` 367 vs `run_build` 23.

**Tool schemas: 103 tools = 23,255 tokens** (Qwen3.8 tokenizer, `llama-tokenize`
b11243 on `Qwen3.8-27B-UD-Q6_K.gguf`; 79 built-in = 18,621, browser + desktop =
4,634). About **11.7K** of that is tools called ≤3 times in 20 days:

| Candidate group | Tools | Tokens | Calls / 20 days |
|---|---|---|---|
| computer_use (`browser_*`, `desktop_*`) | 24 | 4,634 | 0–3 each (new — shipped this week) |
| code intelligence (LSP) | 9 | 1,788 | 1–2 each; 27% of sessions over 30 days |
| media (`view_video`, `image_search`, `generate_image`) | 3 | 1,267 | 6 |
| editor_ui (clipboard, `show_diff`, `insert_code`, `replace_selection`, `show_notification`, workspace tasks) | 8 | 1,178 | 0–2 each |
| admin (`install_llamacpp`, `create_branch`, `switch_branch`, `restore_file`) | 4 | 831 | 7 |
| power (`sleep_computer`, `schedule_wake`, `get_power_info`) | 3 | 702 | 8 |
| memory (`remember`, `recall`, `list_memories`) | 3 | 430 | 8 |
| notebook | 2 | 386 | 2 |

## Constraints this plan inherits (do not re-derive)

From `TOOL_SCHEMA_GROWTH_PLAN.md` and `docs/proposed/FULL_LAZY_MEASUREMENT.md`
(llama-server b10894, Qwen3.8-27B):

1. **Any change to the `tools` array = full cold re-prefill from token 0** — 95 s at
   70K context. Tools render in the system block; the hybrid model cannot resume
   mid-prompt; appending at the end does not help.
2. **Tool calls are grammar-constrained to the advertised array.** A hidden tool
   cannot be called blind; the model is coerced into another tool.
3. Hence the growth plan's rule: vary the list between conversations or models,
   never within one — except for **rare** groups, where one stall per conversation
   is cheaper than their tokens on every request. HalluScribe is the precedent
   (`lazyToolGroups.ts`), and the growth plan puts only *frequently used* groups
   out of bounds. Code intelligence (27%) and git (41%) are frequent: they get
   **merged** (phase 5), never lazy.

The savings are **context room**, not prefill speed — the tool block is a cached
prefix on every request that does not change it. 11.7K is ~9% of a 131K slot:
fewer compactions, more room per round.

## Precondition — the source-split refactor must land first

Forge is mid-refactor (the max-lines splits: `5e3e548`, `a66fb16`, …). Before
phase 1, re-read every file in "Files touched" and re-measure its line count.
The headroom figures in this plan (`execTools.ts` 456, `CompactionService.ts` 489)
date from 2026-09-30 and may have moved.

**Done 2026-09-30 (after `4c21e1a`).** Every path in "Files touched" still exists;
since the plan was drafted, the only refactor commit touching one is `058b25d`
(schema.ts 499→327, `exec` permission object now at `schema.ts:121`). Line counts:
`execTools.ts` 456, `execHelpers.ts` 374, `DenyList.ts` 193, `schema.ts` 327,
`ModelTurn.ts` 446, `CompactionService.ts` **489**, `ToolRegistry.ts` 196,
`lazyToolGroups.ts` 76, `toolGroupTools.ts` 69, `ownedSessionFactory.ts` 332.
**Phase 3 constraint:** `CompactionService.ts` has 11 lines of headroom — the
unload-at-compaction hook must be a call into `lazyToolGroups.ts`, not logic in
CompactionService; a phase that pushes it over 500 fails CI. Phase 1 may grow
`execHelpers.ts`; if it passes ~450, the `-File` scanner goes in its own module.
The phase-0 procedure doc `docs/proposed/FULL_LAZY_MEASUREMENT.md` is local-only
(gitignored `docs/*`), present on this machine.

## Phase 0 — Re-measure the stall on today's build (gate for phase 3)

The 95 s figure is b10894 on a layer split. Today is b11243, tensor split, MTP.

- Re-run the `FULL_LAZY_MEASUREMENT.md` procedure: same conversation at ~20K, ~70K,
  ~120K; request N with tool list A, request N+1 with A + one group. Record
  `cache_n`, `prompt_n`, prompt ms.
- **Outcome decides phase 3's shape:** if a load still costs a full prefill, phase 3
  ships as designed (rare groups only). If partial reuse now works, record it here
  and reopen the growth plan's "out of bounds" list — do not silently widen phase 3.
- No code ships. Numbers go into this file under "Phase 0 results".

## Phase 1 — Opt-in shell scripts, and close the `-File` hole

### 1a. New permission `permissions.exec.shell_scripts` (default `false`)

`src/config/schema.ts:121` — `exec: { terminal, headless, shell_scripts }`, default
false. Requires `exec.headless` (same object; a `superRefine` refuses
`shell_scripts: true` with `headless: false`, naming both keys).

- **Legacy configs do not get it.** A config with no `permissions` block receives
  `LEGACY_PERMISSIONS` (`PermissionResolver.ts:7`), which includes `headless`.
  `shell_scripts` is excluded from that list the way `delegate` is: opt-in even for
  legacy configs, granted only by an explicit `true`.
- **How the tool reads it.** `makeExecCommandTool()` takes no arguments today and
  `ToolHandlerContext` carries no config. Pass a getter from `registerAllTools`
  (which already has an optional `getConfig`, the same way `makeViewVideoTool` gets
  one): `makeExecCommandTool(() => getConfig?.().permissions?.exec?.shell_scripts === true)`.
  With no `getConfig` (benchmark host, tests), the flag is off. The getter runs per
  call, so a config edit applies on the next dispatch without a reload.

`src/tools/execHelpers.ts` `checkPowerShellBan` — gains the flag:

- **Off (default, unchanged behaviour):** `-Command`/`-c` on PowerShell and `-c`/`/c`
  on `bash|sh|cmd|…` refused as today. The refusal adds one sentence: the user can
  enable `permissions.exec.shell_scripts` in `config.yaml`. (Refusals name the
  sanctioned alternative — CLAUDE.md "Agent-Ergonomics Traps".)
- **On:** `pwsh|powershell -Command <script>`, `cmd /c <line>`, `bash|sh -c <script>`
  run. The **denylist runs over the script text** — it already matches the joined
  command line, so this is a test, not new code; add cases proving
  `pwsh -Command "Remove-Item x -Recurse -Force"` and `cmd /c rd /s x` are still
  refused under the flag.
- **Always banned, flag or not:** `-EncodedCommand`, `-enc`, `-ec`, `-e` — the text is
  base64 and no pattern can inspect it.
- `checkShellOperators` already matches whole tokens only, so a script passed as
  one quoted argument (`-Command "a | b"`) is not refused today. The only change:
  with the flag on and a shell launcher, tokens **after** `-Command`/`-c`/`/c` are
  exempt, because the model sometimes splits a script across args
  (`["-Command","Get-X","|","Select"]`) and the shell rejoins them.

### 1b. Scan `-File` scripts in both modes

`pwsh|powershell -File x.ps1`, `pwsh x.ps1` (bare path), `bash|sh x.sh`, and a
directly run `x.bat`/`x.cmd` today run model-written files the denylist never reads
(`cmd /c x.bat` is already refused while the flag is off). Before spawning, read the script (cap 256 KB; bigger ⇒ refuse
with the reason) and run `checkDenyList` over each line. Applies **whether or not**
`shell_scripts` is on — this is the hole the audit found, and closing it is safer
than today for every user. Scripts outside the workspace are read the same way.

### 1c. Denylist correction

`DenyList.ts`: `git reset (hard/mixed/soft)` → `git reset --hard` only, with
`alternative` naming `restore_file`. `--mixed`/`--soft` move HEAD/index and are
recoverable from the reflog; refusing them teaches the agent that git history
tools do not exist.

Also fix the comment at `DenyList.ts:~72`, which says `git reset --hard` "IS
recoverable via reflog". It is not: the reflog restores commits, not the
uncommitted working-tree changes `--hard` throws away. Keeping `--hard` refused is
right; the comment gives the wrong reason and invites someone to un-ban it.

`run_terminal` is **out of scope**. It pastes into a terminal and the user presses
Enter (`execTools.ts:45`), so it is not an agent shell path.

### 1d. README (see "README changes" below)

## Phase 2 — Retire `run_tests` and `run_build`

The model uses `exec_command` for these 7–15× more often. Together 536 tokens per
request.

- Callers to migrate first (grep, 2026-09-30): `src/benchmark/terminalTools.ts`,
  `src/benchmark/toolHost.ts`, `src/sidebar/compactionLedger.ts` (tool-name list),
  `src/tools/backgroundExecutionTools.ts`, `src/tools/execHelpers.ts`
  (`detectTestRunner`). Keep `detectTestRunner` if anything else uses it.
- `exec_command`'s description gains one clause: "`npm test` / `npm run <script>`
  work directly (no shell needed)".
- Measure before/after with the audit script: `exec_command` failure rate on
  npm/npx must not rise.

## Phase 3 — Native lazy groups (rare groups only; gated on phase 0)

Generalise `src/tools/lazyToolGroups.ts` from MCP-only to native tools.

- **Membership** is a static map for native groups (`computer_use`, `media`,
  `editor_ui`, `admin`, `power`, `memory`, `notebook`), next to the existing
  server → group map. `recordLazyGroupTool` stays for MCP.
- **`load_tool_group`** (`toolGroupTools.ts`): `group` enum becomes every available
  group; the description lists one line per group with its member tool names (the
  names are what lets the model pick — budget ≤ 350 tokens total; measure it). The
  `advertise` check becomes "any group available".
- **Vision:** `computer_use` is unavailable on a non-vision model (whole family,
  not only the screenshot tools as today) — `load_tool_group` refuses with the
  model name; `desktop_*` coordinate actions are unusable blind.
- **Dispatch of a hidden tool** (cloud providers do not grammar-constrain): refuse
  with "`X` is in group `Y` — call `load_tool_group` first", never a bare unknown-tool.
- **Unload at compaction:** after `runCompaction` returns `'compacted'`, clear the
  conversation's active groups (`deactivateLazyGroups(conversationId)`). Compaction
  already forces a full re-prefill, so dropping unused schemas there is free. The
  compaction summary notes which groups were loaded so the model reloads knowingly.
- **Per-model opt-out:** reuse the existing per-model `tools:` allowlist; no new
  config. A model whose allowlist names a lazy tool advertises it eagerly (explicit
  config wins over hidden behaviour).

Live acceptance (extends `test/live/LazyToolGroups.live.test.ts`): 8 groups
advertised; for each group one task that needs it and two that do not. Pass =
correct group loaded on every needing task, no load on non-needing tasks,
≤1 wrong-group load across the run.

## Phase 4 — Merge code intelligence and git reads (one family per release)

As specified in `TOOL_SCHEMA_GROWTH_PLAN.md` step 2 — not restated here. Order:
LSP read (8 tools, 1,404 tokens → one `code_intel(operation, …)`; `apply_code_action`,
`rename_symbol`, `format_file` stay separate — they write), then git read (5 tools,
761 tokens → `git_read(operation, …)`). Each merge is measured in the session logs
for two weeks before the next; revert one that raises failures.

**Amended 2026-09-30 (user decision): both merges ship in one release.** The
one-family-per-release rule existed so a regression is attributable; the merged
tools have distinct names (`code_intel`, `git_read`), so the session logs keep
per-family failure and recovery rates apart anyway. Each family is its own
commit, so either one reverts alone. Model, quant and KV cache stay fixed
(Q6 tensor vision, b11243) for the two-week data window, and results are read
by `session_start.forge_version`, never by date alone.

## Side change A — Model and effort for Forge-owned Codex/Claude sessions

Independent of phases 1–3 (touches only `src/agentMesh/` and `src/agents/`), so it
can run in parallel with phase 1. Assigned to Copilot; Claude reviews.

**Today:** `OwnedCodexFactory`/`OwnedClaudeFactory` in
`src/agentMesh/creationPreamble.ts` already accept `model`, and
`codexThreadStartParams` / `ClaudeOwnedSession` already forward it. But the
`factory.create({...})` calls in `src/agentMesh/ownedSessionFactory.ts` (Codex
~L154, Claude ~L243) never pass one. So an owned Codex always runs the
`~/.codex/config.toml` default and an owned Claude runs its CLI default. The
only other way to choose a model is to edit those global files, which would
also change the user's own terminal sessions.

**Change:** add four optional keys to `agent_bus:` (`src/config/agentBusSchema.ts`):

| Key | Type | Goes to |
|---|---|---|
| `codex_model` | `z.string().min(1).optional()` | `create({ model })` → `thread/start` `model` (existing path) |
| `codex_effort` | `z.enum(['low','medium','high','xhigh','max']).optional()` | `codexAppServerArgs`: `-c model_reasoning_effort="<v>"` (process level, same style as the sandbox `-c` pair) |
| `claude_model` | `z.string().min(1).optional()` | `create({ model })` → `--model` (existing path) |
| `claude_effort` | `z.string().min(1).optional()` | new `ClaudeOwnedSession` option → `--effort <v>` |

- **Unset keys keep today's behaviour.** Forge passes nothing and the CLI's own
  config decides. That is the user's explicit config, not a hidden fallback.
- **When a change applies:** at the next owned-session **creation**. A live
  owned session keeps its model; `forge.sh`/mesh restart (or a window reload)
  picks the new value up. Per-call model selection from a tool argument is
  **out of scope**. It would add a param to the tool schema on every turn, and
  Claude's stream-json process cannot switch model mid-process. Revisit only
  if the config keys prove too coarse.
- **Validation errors:** Codex/Claude reject an unknown model at thread start
  or first turn, and Forge surfaces that error unchanged (CLAUDE.md § No
  Fallbacks). No local allowlist of model names, because the lists change
  weekly.

**Files:** `src/config/agentBusSchema.ts`, `src/agentMesh/ownedSessionFactory.ts`,
`src/agentMesh/creationPreamble.ts` (thread `effort`), `src/agents/codexAppServerArgs.ts`,
`src/agents/ClaudeOwnedSession.ts`, `README.md` (agent_bus keys), `CHANGES.md`, tests:
`test/unit/codexAppServerArgs*.test.ts` or nearest, `ClaudeOwnedSession.test.ts`
(argv carries `--model`/`--effort`), an ownedSessionFactory test asserting the
config values reach `create()`.

**For this run:** Codex's phases run through `codex exec -m gpt-6-luna -c
model_reasoning_effort=high` from a worktree, so the run does not wait on this
change.

## README changes (ship with the phase that makes them true)

"Responsibility and Risk" (README ~L611) and the tool overview (~L120):

1. **New bullet, phase 1:** "`permissions.exec.shell_scripts` lets the agent run
   PowerShell, `cmd` and `bash` scripts. The denylist still reads every script, but
   it is pattern-matching, not a sandbox: a script can do anything your user account
   can. **Off by default. Leave it off unless you commit before every agent run.**"
2. **Amend the checkpoint bullet, phase 1:** Keep/Undo covers Forge's file tools
   only. Changes made by a command or script — `exec_command`, `run_terminal`,
   shell scripts, a build — are **not** captured; git is the only way back.
3. **Amend the denylist bullet, phase 1:** it is best-effort — interpreters that
   were never banned (`node -e`, `python -c`) can already do what a shell script
   can. Stating this is the honest version of the current wording.
4. **Tools section, phase 3:** some tool groups load on demand; the first use in a
   conversation pauses while the model re-reads its context (measured in phase 0 —
   quote the number).
5. **Browser/desktop, phase 3:** computer-use tools need a vision model and
   `permissions.browser`/`desktop.enabled`; desktop tools click and type into
   whatever window is focused.

## Files touched

| Phase | Files |
|---|---|
| 1 | `src/config/schema.ts`, `src/tools/execHelpers.ts`, `src/tools/execTools.ts`, `src/tools/DenyList.ts`, `README.md`, `CHANGES.md`, tests: `test/unit/ExecHelpers*.test.ts`, `DenyList*.test.ts`, config schema test |
| 2 | `src/tools/execTools.ts`, `src/benchmark/{terminalTools,toolHost}.ts`, `src/sidebar/compactionLedger.ts`, `src/tools/backgroundExecutionTools.ts`, tests, `README.md` L136 |
| 3 | `src/tools/lazyToolGroups.ts`, `src/tools/toolGroupTools.ts`, `src/sidebar/ModelTurn.ts`, `src/sidebar/CompactionService.ts`, `src/tools/ToolRegistry.ts` (hidden-tool refusal), tests, live test, `README.md`, `docs/OWNERS.md` |
| A | `src/config/agentBusSchema.ts`, `src/agentMesh/{ownedSessionFactory,creationPreamble}.ts`, `src/agents/{codexAppServerArgs,ClaudeOwnedSession}.ts`, tests, `README.md` |
| 4 | `src/tools/lspTools.ts`, `src/tools/gitReadTools.ts`, new `codeIntelTool.ts` / `gitReadTool.ts`, tests |

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `permissions.exec.shell_scripts` (config.yaml) | user edits config.yaml (comment-preserving writer if a setting UI is added) | user removes the key → default `false` | set `false`; takes effect on the next tool dispatch (config re-read per call) | config.yaml write is the user's editor; a half-written file fails Zod at load and Forge surfaces the error, flag reads as unset (`false`) | none — config outlives Forge by design | none — permanent until changed |
| Model-written script files (`*.ps1`, `*.sh`, `*.bat`) | agent `write_file` (checkpointed) | agent `delete_file`, or Undo of the creating turn; Forge never auto-deletes user-tree files | n/a — inert files; phase 1b scans them before any run | `write_file` is atomic temp-then-rename; a torn file fails the 1b scan or the interpreter, never half-runs past the denylist | orphaned file stays in the tree (today's litter); `git status` shows it; phase 1 reduces creation because `-Command` no longer needs a file | none |
| Active lazy groups per conversation (in-memory map) | `load_tool_group` | compaction (phase 3), conversation delete, `resetLazyToolGroups` | model allowlist removes the group's tools → not advertised even when active | not durable — nothing to tear | lost on window reload; model reloads (one round + one re-prefill) — documented, not a bug | cleared at each compaction |
| `agent_bus.{codex,claude}_{model,effort}` (config.yaml) | user edits config.yaml | user removes the key → CLI's own default | remove/change the key; applies at the next owned-session creation, never to a live session | half-written config fails Zod at load and Forge surfaces it; keys read as unset | none — config outlives Forge; a live owned session dies with its window and the next one reads the current value | none — permanent until changed |
| Session-log rows used by the audit | existing session logger | existing retention | n/a | existing logger | existing | existing — this plan adds no row types: **no new durable state** beyond the config key |

**CI-enforced row:** `permissions.exec.shell_scripts` — a unit test asserts three
things: `ForgeConfigSchema.parse({})` yields `shell_scripts: false`;
`DEFAULT_PERMISSIONS` in `src/config/StarterConfig.ts` (`exec: { terminal: false, headless: false }`)
does not enable it; and `resolveToolPermissions` on a config with **no**
`permissions` block (the legacy path) does not grant it. A later phase that flips the
default fails this test.

## Acceptance criteria

- Phase 0: prefill numbers at three context sizes recorded above, on b11243 tensor.
- Phase 1: with the flag off, every existing exec refusal test passes unchanged;
  with it on, `pwsh -Command`, `cmd /c`, `bash -c` run and the denylist still refuses
  `Remove-Item -Recurse -Force`, `rd /s`, `rm -rf`, `git reset --hard` inside them;
  `-EncodedCommand` refused in both modes; a `-File` script containing a denylisted
  line is refused in both modes; `git reset --mixed` allowed.
- Phase 1: README carries warnings 1–3 in "Responsibility and Risk".
- Phase 2: `run_tests`/`run_build` gone from the registry, benchmark harness green,
  audit script shows no rise in npm/npx `exec_command` failures over one week.
- Phase 3: tool-schema tokens drop, measured with llama-tokenize per definition.
  **Amended 2026-09-30 after measuring; the original "≥ 8K" is not met.** That
  figure came from the audit's "~11.7K in tools used ≤ 3×". The rare-only rule
  (≥ 10 audited calls stays eager) keeps `ask_live_session`, `manage_jobs`,
  `notify_user`, `ask_local_agent`, `ask_user` and three more eager, and they carry
  much of that 11.7K. Measured: the user's config (79 tools, browser/desktop off)
  saves ~4.8K of grouped schemas, minus the larger `load_tool_group` description,
  so about 4.5K net. StarterConfig defaults save 1,725 (6,987 → 5,262); with
  browser+desktop on, 4,272 (9,534 → 5,262). Shipped anyway: the cost is a
  one-time re-read in the rare conversations that need a group.
  Live test passes the criteria above; a compaction clears
  active groups; a non-vision model cannot load `computer_use`.
- Side change A: with the keys unset, owned-session argv and `thread/start` params are
  byte-identical to today (test); with them set, `codex_model`/`codex_effort` reach
  `thread/start`/app-server argv and `claude_model`/`claude_effort` reach `--model`/`--effort`;
  live: an owned Codex with `codex_model: gpt-6-luna`, `codex_effort: high` answers, and an
  unknown model name surfaces the CLI's error in chat.
- Phase 4: per growth-plan step 2.
- Every phase: `npm run ci` and `npm run package` green; `CHANGES.md` entry.

## Phase 0 results

Measured 2026-09-30 against the live server (no restart, no `config.yaml` edit).

**Server build & flags** (from the running process, PID 7032):

- Build: `llama.cpp-b11243` (`llama-server.exe`)
- Model: `Qwen3.8-27B-UD-Q6_K.gguf` + `mmproj-BF16.gguf`
- `--ctx-size 131072` (128K per-slot context, `--parallel 1`) → all three sizes, including 120K, fit; none was truncated
- `--n-gpu-layers 99`, `--batch-size 8192`, `--ubatch-size 512`
- `--split-mode tensor --tensor-split 1,1` on `--device CUDA0,CUDA1` (tensor split)
- `--cache-type-k q8_0 --cache-type-v q8_0`, `--flash-attn on`
- `--spec-type draft-mtp --spec-draft-n-max 5` (MTP), `--ctx-checkpoints 8 --checkpoint-min-step 1024`

Content: real `FORGE.md` + `src/**/*.{ts,md}`, sized to ~20K / ~70K / ~120K prompt
tokens. Four `/v1/chat/completions` requests per size, `max_tokens=1`, real tool
schema: (1) cold base tools, (2) identical, (3) base + one git group appended to
the END of `tools`, (4) back to base. `prompt_n` / `cache_n` are read from the
response `timings` object: `prompt_n` = tokens newly processed, `cache_n` = tokens
reused from the KV cache (total prompt ≈ `prompt_n + cache_n`). `prefill tok/s` is
`prompt_n / prompt_ms` and is only meaningful for the cold/partial rows, not the
fully-cached ones.

| size | request | prompt_n | cache_n | prompt_ms | prefill tok/s |
|------|---------|---------:|--------:|----------:|--------------:|
| 20000 | 1 cold base | 10264 | 9333 | 14245.8 | 720 |
| 20000 | 2 identical | 4 | 19593 | 413.9 | 10 |
| 20000 | 3 base+git | 11729 | 8828 | 16836.1 | 697 |
| 20000 | 4 back base | 4 | 19593 | 351.4 | 11 |
| 70000 | 1 cold base | 51152 | 19081 | 94169.5 | 543 |
| 70000 | 2 identical | 70233 | 0 | 115176.5 | 610 |
| 70000 | 3 base+git | 71193 | 0 | 104347.8 | 682 |
| 70000 | 4 back base | 70233 | 0 | 101260.8 | 694 |
| 120000 | 1 cold base | 120984 | 0 | 193110.7 | 627 |
| 120000 | 2 identical | 120984 | 0 | 192242.0 | 629 |
| 120000 | 3 base+git | 121944 | 0 | 194285.5 | 628 |
| 120000 | 4 back base | 120984 | 0 | 192363.7 | 629 |

Cold-base prefill throughput is ~720 tok/s at 20K, falling to ~540–630 tok/s at
70K/120K (larger context / memory pressure). Wall time exceeds `prompt_ms` by a
variable ~1–3× at 120K (MTP draft verification is not counted in `prompt_ms`).

**Does a tool-list change still force a re-prefill?** Yes, of everything after the
tool block. The measurer first recorded "partial reuse now works"; that reading is
corrected here (Claude, supervisor review):

- At 20K, request 3 (base + git group appended to the END of `tools`) reused only
  `cache_n=8828`, the system-prompt prefix, and re-processed `prompt_n=11729`, the
  whole conversation. Qwen3.8's chat template renders the tool list inside the
  system block, **ahead of** the conversation, so any change to `tools`
  invalidates every token after that point wherever the new group sits in the
  array. What b11243 reuses is the prefix before the tool block, which saves little.
- So a group load costs roughly a full re-read of the conversation: at the
  measured ~550–700 tok/s, about **100 s at 70K and ~190 s at 120K**, the same
  order as b10894's 95 s. **Phase 3 ships as designed (rare groups only); the
  growth plan's "out of bounds" list is NOT reopened.**
- The 70K and 120K rows are **void as a reuse test**. `--ctx-size 131072` on one
  slot holds a 120K prompt, so capacity is not the cause. The measurement ran in
  the background while the measuring chat's own ~60–120K requests went to the same
  single slot (`--parallel 1`) between measurement requests and evicted the
  measurement prompt; the identical request 2 coming back `cache_n=0` shows the
  contamination. Those rows are still valid as **cold prefill times**: 70K
  ≈ 94–115 s, 120K ≈ 192–194 s. No re-run is needed: the 20K rows settle the
  mechanism, and since a group load re-reads the conversation, its stall **is** the
  cold-prefill time for that size. The README quotes these: ~100 s at 70K,
  ~190 s at 120K on this server.

## Phase 3 live results (2026-09-30, 0.16.66, qwen38-27b-mtp-ud-q6k-tensor-vision on b11243)

`test/live/LazyToolGroups.live.test.ts`: **22 of 23 pass** (39deb6b harness).

- Loaded the right group unprompted for `computer_use`, `media`, `editor_ui`,
  `system`, `memory` and `halluscribe`; never loaded a group it did not need
  (`wrongGroupLoads` 0).
- **Notebook, failing, accepted as model choice.** The prompt asks it to read a
  `.ipynb`; the model calls `read_file`, gets the JSON, answers correctly, and
  never loads `notebook`. That answers the question, so it is not a defect in
  the tool or the grouping. For file-format groups (media, notebook) the model
  reaches for the built-in file tools first; `read_file` on an image now names
  the `media` group (5886609) for that reason.
- **Exact-string recovery passes only with a 600 s budget**: the model loops on
  `search_raw_transcripts` to the 10-step limit instead of stopping at the hit.
  A model convergence issue, not a lazy-group one.
- Three harness defects found and fixed on the way, none in Forge: no workspace
  folder or vision flag in the tool context (8ebb372); a thrown tool ended the run
  instead of returning `Error:` to the model (7103235); a structured tool result
  (`view_image`) was sent as the message object and got HTTP 400 (39deb6b).
- Not covered by this run: "a compaction clears active groups" and "a non-vision
  model cannot load `computer_use`" are covered by unit tests, not live.
