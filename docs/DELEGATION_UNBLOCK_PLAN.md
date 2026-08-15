# Delegation Unblock Plan

**Branch:** `fix/delegation-unblock`
**Date:** 2026-08-15
**Origin:** A Qwen 3.8 session in the `Qwen testing` workspace tried to get a second
opinion from Codex and Claude Code via `ask_local_agent`. Both delegations failed.
Neither failure was logged, so the only surviving record was the model's own private
reasoning trace, recovered from `state.vscdb`.

Qwen's reasoning, verbatim:

> "the codex CLI failed due to the git repository check… *Not inside a trusted
> directory and `--skip-git-repo-check` was not specified.* … claude-code was in
> plan mode… The error said 'This command requires approval' — the delegate agent
> has its own permission system. **I can't approve it from here.**"

Both diagnoses were correct. This plan fixes the causes.

---

## F1 — Codex delegation fails in every non-git workspace

**Where:** `src/agents/adapters/codexAdapter.ts` → `buildArgs`

`buildArgs` emits `exec`, the task, `--json`, `--sandbox <level>`, and an optional
`--model`. It never emits `--skip-git-repo-check`. `codex exec` refuses to start
outside a trusted git repository, so delegation to Codex fails 100% of the time in
any scratch or non-git folder — regardless of sandbox level.

**Fix:** always pass `--skip-git-repo-check` on the non-resume path. Forge already
constrains blast radius with `--sandbox`, which is the flag that actually governs
what the delegate may touch; the git check is an interactive-CLI safety prompt that
is meaningless for a programmatic, sandboxed, non-interactive spawn.

**Verify:** unit test asserts the flag is present for all three access levels.

---

## F2 — Claude Code delegation can never complete (deadlock by construction)

**Where:** `src/agents/adapters/claudeAdapter.ts` → `buildArgs`, and
`src/tools/localAgentTool.ts` → tool schema

Two facts collide:

1. `-p` runs Claude Code **non-interactively**. No human, no UI, no approval channel.
2. `access === 'read'` maps to `--permission-mode plan`. Plan mode makes any
   side-effecting tool call **request approval before proceeding**.

An approval request inside a `-p` session is unanswerable — not by the user, not by
the orchestrating model. The delegate stalls or returns refusing to act.

This is not an edge case. `ask_local_agent` exposes **no `access` parameter**
(schema: `model`, `task`, `context_files`, `focus`, `max_output_tokens`), so `access`
is always `read`, so every Claude Code delegation lands in the unanswerable state.
There has never been a working path.

The root error is conflating *read-only* with *plan*:

| Intent | Meaning | Right primitive |
|---|---|---|
| plan | don't act, propose first, wait for a human | `--permission-mode plan` |
| read-only | act freely, but don't mutate anything | allow-list of read tools |

A delegate asked for a second opinion needs the second. The tool description already
promises the second — *"runs read-only with ITS OWN tools (it can read/list files
itself)"* — which plan mode does not deliver.

**Fix:** map `read` to `--permission-mode bypassPermissions` constrained by
`--allowedTools Read,Grep,Glob,Bash,WebFetch,WebSearch`. Nothing in that set can
mutate the workspace (no Write/Edit/NotebookEdit), so the read-only contract holds,
while investigation, search and verification actually run. `write` and `full` are
unchanged.

**Verify:** unit tests assert the read argv contains `bypassPermissions` + the
allow-list, contains no mutating tool, and that `write`/`full` are untouched.

---

## F3 — The system prompt advertises tools that are not registered

**Where:** `.forge/config.yaml:64`, and `bridge.yaml` (8 model profiles)

Every profile hardcodes:

```
You have tools available: read_file, write_file, replace_in_file,
list_directory, search_code, run_terminal, git_status, git_diff, and more.
```

But tools are permission-gated at runtime. `run_terminal` carries
`permission: 'terminal'` (`src/tools/execTools.ts`) and is not advertised unless that
permission is granted. The model is therefore told it has a terminal, plans around
having one, and discovers mid-task that it does not.

Qwen hit this exact wall and called it out:

> "the system prompt says `run_terminal` is available, but it's not in the actual
> tool list. I can't run curl."

The sentence is also redundant — the true tool list already ships in the request's
`tools` array, which is authoritative and permission-accurate.

**Fix:** delete the hardcoded sentence from all profiles in both files. Let the tool
array speak for itself.

**Verify:** grep both files for `run_terminal` returns only genuine code references.

---

## F4 — Delegation failures are invisible

**Where:** `src/agents/CliAgentDriver.ts`

The driver returns structured errors (`failed to start`, non-zero exit, timeout,
adapter-reported error) but logs none of them. Two consecutive delegation failures
produced zero output-channel lines and a 0-byte
`.coordination/events.ndjson`. Diagnosis required reading a SQLite blob.

**Fix:** log every terminal outcome — start (cli, access, argv-shape), success, and
each failure mode — through the existing `getLogger()` channel.

**Verify:** unit test asserts a failing run emits a warn line naming the CLI and the
reason.

---

## F5 — Tool calls are dropped at persist time (documented, NOT fixed here)

**Where:** `src/sidebar/sessionTypes.ts:79` → `slimPersistMessages`

```ts
.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
```

This drops:

- every `role: 'tool'` message (all tool results), and
- every assistant turn carrying `tool_calls`, because such turns have `content: null`.

Consequence: tool activity is never persisted and never restored to the webview on
resync. This is why the recovered transcript showed 34 clean user/assistant messages
and no trace whatsoever of the two delegation attempts that provoked this whole
investigation. It is data loss at write time, not merely a render bug.

**Deliberately not fixed in this change.** The repair requires widening
`SlimPersistMessage`, a persisted-schema change with a migration path, and it would
land in the same build we are about to use to test F1–F4. Changing the message
schema and the delegation behaviour simultaneously would make a failed test
ambiguous. Recommended as the next change, on its own branch, with a migration.

## Not reproduced — sidebar text vanishing after reload

The working hypothesis was that 0.12.35 broke webview rehydration. **The diff does
not support it:** `bda2f45` touches only `postTokenBudget` (token budget +
HalluMeter bridge) and nothing in the render path. The rehydration handshake is
intact — the webview posts `webviewReady`, the host answers with `postSessionSync`.

F5 explains permanently missing *tool* messages but not plain assistant text.
No fix is attempted for a mechanism that is not yet identified. F4's logging will
help characterise it if it recurs. Watch for it after this install.

---

## Execution order

1. `F1` codex flag + tests
2. `F2` claude permission mapping + tests
3. `F4` driver logging + test
4. `F3` prompt sentence removal (config + bridge)
5. `npm run type-check && npm run lint && npm test`
6. stage, commit
7. `npm run package` → vsix
8. install vsix

## Acceptance

- full CI green (type-check, lint, 565+ tests, build)
- new tests cover F1, F2, F4
- `run_terminal` gone from prompt text in both config files
- vsix built and installed; window reload + fresh Qwen chat is the live test

---

## Outcome (2026-08-15) — ALL ACCEPTED

Shipped as 0.12.36. Type-check clean, lint clean, **569 tests pass** (4 new).
Live validation, observed transcripts, and the model-behaviour notes are in
`DELEGATION_LIVE_VALIDATION.md` at the repo root.

- **F1 verified.** The git-trust error is gone; `codex exec` now starts and runs
  a full turn in a non-git workspace.
- **F2 verified.** Claude Code completed a real delegation — a live network call
  returning verified data. Before the fix this could only produce an
  unanswerable approval prompt.
- **F3 verified.** `run_terminal` no longer appears in any prompt profile.
- **F4 verified.** Terminal outcomes are logged.
- **F5 unchanged** — still not fixed, still the recommended next branch.

One defect below F1 was **not** a Forge bug and is not fixed in code: Codex's
Windows sandbox cannot execute a Store-only `pwsh`, which requires an MSI
PowerShell 7 on the host. See `DELEGATION_LIVE_VALIDATION.md` for the full
diagnosis, including why `winget --scope machine` must not be used for it.
Both layers were required — F1 alone still failed at the shell spawn.
