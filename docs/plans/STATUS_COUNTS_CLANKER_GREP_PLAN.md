# Tool counts, clanker persistence, and the grep dead end

> **Status: implemented.** Decisions taken during implementation are recorded
> inline below, marked **DECIDED**. `npm run ci` green (2056 tests).

Three unrelated-looking reports from one session. Two are display bugs, one is a
missing capability hint. Written before implementation; nothing here is applied yet.

---

## 1. `/status` should report how many tools were executed

`/status` is the **Telegram remote** command — the only `/status` in the tree,
at `src/remote/RemoteSessionCommands.ts:42`. Its `Forge:` line already counts
active requests, queued prompts, streams, crash-unknowns and notifications; it
has no tool figure at all.

Nothing currently counts tool calls per conversation. The nearest thing is
`ToolBudget` (`src/tools/ToolBudget.ts`), which only counts tools carrying a
`tool_call_limits` entry — it is an enforcement counter, not a usage one, and
reading it would under-report every unbudgeted tool.

The right owner is `applyUsage` in `src/sidebar/transcriptMutations.ts:43`,
which already folds per-request totals into the conversation. Add a sibling:

- `conv.tool_call_count` on `ConversationRuntime` (`sessionTypes.ts`), Zod-
  optional and persisted the same way `model_request_count` is
  (`sessionPersistence.ts`, three sites).
- A `recordToolCalls(conv, n)` mutation beside `applyUsage`, called from the
  one dispatch site in `src/sidebar/ModelTurn.ts:334` where `conv` and
  `toolCalls` are both already in scope. Count what was **dispatched**, so a
  refused or failed call still counts — the figure answers "how much did this
  turn do", and a failed call spent a round like any other.
- Surface it through `sidebarPayloads.ts:123` next to `requestCount`, then in
  the `/status` `Forge:` line.

**DECIDED:** per-conversation, matching every other figure on that line. It
reads as "tools run in this chat".

## 2. Same figure in the status bar

`src/vscode/SessionTimeStatusBar.ts` already renders per-conversation usage and
takes a `SessionTimeSnapshot` fed from `SendPipeline.ts:339`, which reads
`conv.model_request_count`. So this is one more optional field on the snapshot
and one more tooltip line — the counter from §1 does all the work.

- Tooltip: `Tool calls: N` beside the existing `Model requests: N`.
- Status bar text: leave it alone. The visible string is already three figures
  wide (`timer · ctx · session out`); a fourth pushes it past what a glance
  reads. Tooltip only, unless the owner wants it inline.
- `lastSignature` must include the new field or the bar will not repaint when
  only the tool count changed.

**DECIDED:** the VS Code status bar — confirmed by the owner, and the surface
already showing `Model requests`. Tooltip only; the visible text is unchanged.

## 3. `/clanker` persistence — the help text is wrong, and so is the storage

The Telegram help at `src/remote/remoteHelpText.ts:65` says clanker lasts
"until the window reloads". That is accurate **only for the remote path**, and
the asymmetry is deliberate — `src/sidebar/SidebarProvider.ts:204-212`:

- Sidebar toggle → `rememberClankerMode(on)` → persists **both** on and off to
  `workspaceState['forge.clankerMode']`, restored at
  `src/sidebar/sidebarWiring.ts:123`.
- Remote `/clanker on` → **not** persisted, on purpose ("a remote ON must not
  silently outlive the window it was set from").
- Remote `/clanker off` → persists `false`, so it cannot be re-armed by the
  sidebar's memory on the next reload.

So the reporter is right that it persists — they were seeing the sidebar path —
and right that the help text misdescribes it.

**DECIDED:** drop the asymmetry — remote `/clanker on` persists exactly as the
sidebar toggle does, to `workspaceState`. Scope stays per-workspace; the move
to `globalState` was considered and not taken, so clanker still has to be armed
once per project rather than following the owner everywhere.

The safety argument that motivated the old asymmetry is real but was buying
less than it looked. It protected only the remote path, while the sidebar
toggle armed clanker across reloads in the same window — so the two surfaces
disagreed about what a reload meant, and the only way to discover which rule
was in force was to reload and see. A default nobody can observe is not much of
a default. Both help texts now state the single rule instead.

## 4. The agent ran `exec_command grep` and got nothing useful

`grep` is **not on the Windows PATH** — verified: `Get-Command grep` finds
nothing; the only copy is `C:\Program Files\Git\usr\bin\grep.exe`, reachable
from Git Bash only. So the spawn failed with `ENOENT` and the model received
Node's raw `spawn grep ENOENT` from `src/util/processSpawn.ts:114`.

This is the failure shape CLAUDE.md already names: **a refusal that does not
name the sanctioned alternative**, the same thing that left `delete_file`
uncalled across ~3,000 tool calls. The agent had `search_code` (bundled
ripgrep) available the whole time and no way to learn that from the error.

Two contributing causes, both worth fixing, and **neither is "allow grep"** —
there is no grep to allow, and shipping one would duplicate `search_code`'s
bundled ripgrep for a strictly worse result surface.

**4a. The error must name the tool.** `CMD_BUILTIN_ALTERNATIVES` in
`src/tools/execProgramResolver.ts` already does exactly this job for `dir`,
`type`, `del` and friends. Its name and doc comment scope it to cmd.exe
builtins; widen it to "programs that do not exist here, and the tool that
replaces them" and add the Unix text utilities a model reaches for on reflex:

| command | message |
|---|---|
| `grep`, `egrep`, `fgrep`, `rg`, `ripgrep`, `findstr`, `select-string` | Use `search_code` (literal/regex, bundled ripgrep) or `search_codebase` (semantic). |
| `find` | Use `find_files`. |
| `cat`, `head`, `tail`, `more` | Use `read_file`. |
| `sed`, `awk` | Use `edit_file` / `apply_line_edits`. |
| `wc` | Use `read_file` and count. |

`findstr` is a real executable on Windows, so it will not hit the
`missing_executable` branch — it needs redirecting on the way in, not on the
error path. Keep the existing branch for the ENOENT cases and add an up-front
check for the ones that would otherwise succeed badly.

**4b. The prompt literally tells it to grep.**
`config/templates/builtin/execute.njk:11` reads *"Grep before creating anything
new"*. Line 12 does name `search_code`, but line 11 puts the verb `Grep` in
imperative position, and a local model reaching for `exec_command grep` after
reading it is following instructions. Reword to *"Search before creating
anything new"* — the rule is unchanged, the bait is gone.

Do **not** add a prohibition ("grep is not available"). Per CLAUDE.md, a prompt
rule costs every turn; the error-string fix arrives only when relevant and
costs nothing on the turns it does not.

---

## What shipped

All three, in that order. Tests added: `describeShellBuiltin` coverage for the
grep spellings, the `.exe` suffix, and the deliberate `find`/`findstr`
omissions (`test/unit/execProgramResolver.test.ts`); `applyToolCalls`
accumulation and the absent-vs-zero distinction
(`test/unit/toolCallCount.test.ts`).

Left undone, knowingly: a model that writes `find . -name '*.ts'` still reaches
Windows' unrelated `find.exe` and gets `FIND: Parameter format not correct`.
Fixing that needs an intercept *before* the spawn, not on the error path, which
means refusing a command that would otherwise run — a bigger decision than this
change, and one worth its own evidence.
