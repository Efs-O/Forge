# CLI Agent Delegation — Live Validation (2026-08-15)

End-to-end validation of `ask_local_agent` → Claude Code / Codex, driven by a
real Qwen 3.8 session in a separate workspace (`N:\vs code apps\Qwen testing`).

**Result: both delegates verified working.** Four defects were fixed (three in
Forge, one in the host environment); one Forge data-loss bug is documented and
deliberately unfixed. Fix rationale lives in `docs/DELEGATION_UNBLOCK_PLAN.md`;
this file records what was observed and how it was proven.

---

## How this started

A Qwen session was asked to review a file. It tried to get a second opinion from
Codex and from Claude Code. Both delegations failed, neither failure was logged,
and the sidebar lost the reply. The only surviving record was the model's own
private reasoning, recovered from
`%APPDATA%\Code\User\workspaceStorage\<hash>\state.vscdb`, key `Efsoo.forge-llm`.

Its two diagnoses were both correct:

> "the codex CLI failed due to the git repository check… *Not inside a trusted
> directory and `--skip-git-repo-check` was not specified.* … claude-code was in
> plan mode… **I can't approve it from here.**"

---

## Forge defects found and fixed (0.12.36)

| ID | Defect | Fix |
|---|---|---|
| F1 | `codexAdapter.buildArgs` never passed `--skip-git-repo-check`, so every delegation from a non-git workspace failed regardless of sandbox level | flag added on both exec and resume paths |
| F2 | `claudeAdapter` mapped `read` access to `--permission-mode plan`, which deadlocks under `-p` — a non-interactive session cannot answer plan mode's approval prompt | `read` now maps to `bypassPermissions` + `--allowedTools Read,Grep,Glob,Bash,WebFetch,WebSearch` |
| F3 | Prompt profiles hardcoded `You have tools available: … run_terminal …` while tools are permission-gated at runtime | sentence removed from `.forge/config.yaml` and all 8 `bridge.yaml` profiles (local config, untracked) |
| F4 | `CliAgentDriver` logged no terminal outcome — two consecutive failures produced zero output-channel lines | every outcome (completed / failed / cancelled / timed_out) now logged |

F2 is the important one. `ask_local_agent` exposes **no `access` parameter**, so
`access` is always `read`; before this fix there was never a working Claude Code
delegation path at all.

The root error in F2 was conflating two different intents:

| Intent | Meaning | Correct primitive |
|---|---|---|
| plan | don't act, propose first, wait for a human | `--permission-mode plan` |
| read-only | act freely, but mutate nothing | allow-list of non-mutating tools |

A delegate asked for a second opinion needs the second.

---

## Host environment defect (not a Forge bug)

After F1, Codex still failed — with a different error:

```
windows sandbox: CreateProcessAsUserW failed: 5 (Access is denied.)
cwd=N:\vs code apps\Qwen testing
```

**Cause:** Codex's sandbox spawns its shell as dedicated local accounts
(`CodexSandboxOffline` / `CodexSandboxOnline`, members of `CodexSandboxUsers`).
`pwsh` on this machine existed **only** as the Microsoft Store package, reached
through an app-execution alias in `%LOCALAPPDATA%\Microsoft\WindowsApps`. Store
packages are ACL'd so other accounts cannot execute them, so the sandbox account
could not launch the shell.

**Fix:** install PowerShell 7 from the **MSI**, giving
`C:\Program Files\PowerShell\7\pwsh.exe` with normal Program Files ACLs
(`BUILTIN\Users: ReadAndExecute`) that the sandbox accounts can execute.

**Do not use `winget --scope machine` for this.** It resolves the **MSIX bundle**,
stages it (displacing the registered Store package and its `pwsh` alias), then
fails device-wide provisioning on Windows 10 19045:

```
Deployment ProvisionPackageOperation … failed with error 0x80070005
Device wide install for msix type is not supported in packaged context on this OS version.
```

That sequence leaves the machine with **no PowerShell 7 at all**. Recovery is the
MSI from the GitHub release, installed with `msiexec /i … ADD_PATH=1`.
`--scope user` does not work either: it installs under the user profile, whose
ACLs deny the sandbox accounts just as the Store package did.

Both layers were required. F1 alone still failed at the shell spawn; the MSI
alone would still have failed the git-trust gate.

---

## Verification

Forge's exact argv, in the non-git workspace on the `N:` volume:

```
codex exec "<task>" --json --skip-git-repo-check --sandbox read-only
→ "C:\Program Files\PowerShell\7\pwsh.exe" -Command 'Get-ChildItem -Force …'
→ exit_code: 0
```

Live delegations, observed in the Forge sidebar:

- **Claude Code** — asked to curl the Open-Meteo forecast endpoint, returned
  `"utc_offset_seconds": 7200` and correctly reported that
  `timezone_offset_seconds` does not exist. Independently confirmed. This call
  could only ever produce an unanswerable approval prompt before F2.
- **Codex** — returned a genuine line-accurate review of a 800-line file, with
  findings the primary model had not produced on its own.

Suite: type-check clean, lint clean, **569 tests pass** (4 new covering F1/F2).

---

## F5 — known data loss, deliberately NOT fixed

`src/sidebar/sessionTypes.ts` → `slimPersistMessages`:

```ts
.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
```

This drops **every `role: 'tool'` message** and **every assistant turn carrying
`tool_calls`** (those have `content: null`). Tool activity is therefore never
persisted and never restored to the webview on resync.

Observed consequence: a recovered transcript showed 34 clean user/assistant
messages and **no trace whatsoever** of the two delegation attempts that started
this investigation. A later transcript contained an empty assistant message with
truncated reasoning — the tool-call turn, with its content dropped. Diagnosing
the real Codex error required re-running the CLI by hand, because the error had
never been written to disk.

This is data loss at write time, not a render bug. The repair needs a widened
`SlimPersistMessage` plus a persisted-schema migration, and was deliberately kept
out of the build used to validate F1–F4 so a failed test could not be ambiguous.
**Recommended as the next change, on its own branch.**

---

## Not reproduced — sidebar text vanishing after reload

Working hypothesis was that 0.12.35 broke webview rehydration. **The diff refutes
it:** `bda2f45` touches only `postTokenBudget` and nothing in the render path,
and the handshake is intact (`webviewReady` → `postSessionSync`). F5 explains
missing *tool* messages but not plain assistant text. No fix attempted for an
unidentified mechanism; F4's logging will help characterise it if it recurs.

---

## Model behaviour notes

Relevant to Forge because they shape what the delegation feature is *for*.

**Local coordinator (qwen38-27b-mtp-q3km).** Asked to "validate the code", it
produced a 100-item numbered checklist and concluded "the code is valid and
sound" — for a file where every API call was returning HTTP 400. Items 15–17
explicitly affirmed, with "Yes", the three Open-Meteo parameter names that were
causing the failure. Roughly 95 of the 100 checks were padding
("`bgCtx.fill()` — no problem"); the four that mattered were confabulated.

The same model, in the same tool-less state, later **correctly refused** to edit
and asked the user to run a command for it. The variable was the prompt: the
second request said *"do not reason from memory about what fields the API
returns."* One instruction line flipped it from confabulating to accurately
reporting its own limits.

**Practical implication for Forge:** a local coordinator's self-validation is not
evidence. This is precisely the gap `ask_local_agent` exists to close — and why
F4's logging matters, since a silent delegation failure sends the coordinator
straight back to confabulating.

**Cloud delegates.** Claude Code returned verified fact from a live network call.
Codex returned an accurate review but reported one **false positive**: it claimed
the source contained corrupted characters (`øC`, `S?o Paulo`, `??`). Byte-level
check showed clean UTF-8 — `S 303 243 o` is `São`, 11 correctly-encoded `C2 B0`
degree signs, no BOM. Codex had decoded UTF-8 through this machine's **cp1253
(Greek) console codepage**. The same codepage broke Python writes during this
session until `PYTHONIOENCODING=utf-8` was set.

**Implication:** delegate output is evidence, not truth. Encoding-dependent
claims from any CLI agent on this machine should be re-checked at byte level.

---

## Method note

Three wrong hypotheses preceded the correct sandbox diagnosis: the `N:` volume
(it is a local NTFS disk, not a network drive), workspace ACLs (granting
`CodexSandboxUsers` changed nothing), and ancestor traverse rights. Each was
plausible and survived until a test varied exactly one thing. The one that
resolved it was trivial: strip `WindowsApps` from `PATH` and re-run.

Same failure mode as the 100-item checklist above — confident reasoning over an
unverified assumption. Prefer the cheap single-variable experiment.
