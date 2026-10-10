# Early `length` stops, path wording, and two Strata fixes

Source: the forge-bench interview run of 2026-10-10 (session
`followup-forge-interview.session.jsonl`, build 159a3a8, model Qwen3.8-Flash-Next IQ3_S on
Strata 0.1.41). The turn delivered nothing. Two Forge defects and one Strata false positive
combined to end it.

## What happened

1. The last round thought for 34,195 tokens and was stopped by Strata with
   `finish_reason: "length"`. Forge had sent `max_tokens: 140347`; the context was 200,000.
   Strata's in-memory request record (`GET /metrics?requests=all`) confirms `finish:
   "length"`, `output_tokens: 34195`, `reasoning_repeat_coverage: 0.0`, no recoveries. The
   cause is Strata's #606 guard (`REPEAT_STOP_TOKENS = 256` in `serve/server.py`): the model
   was writing the smallest double in positional notation (`0.000…`, 323 zeros, legitimate
   content). The guard breaks before emitting the 256th token, and the logged reasoning ends
   in exactly 255 zeros. The guard's own print was lost: the hidden launcher discards
   Strata's stdout.
2. Forge treated every reasoning-only `length` round as a spent budget: it told the model
   "this round hit the output limit" (false here) and ended the turn with no retry
   (`ToolCallingLoop.ts`, the `streamed.finishReason !== 'length'` exclusion). About 106K
   tokens of room were left.
3. Earlier in the same turn, `shell {cwd: "build"}` ran before `build/` existed and returned
   `Error: spawn C:\Program Files\Git\bin\bash.exe ENOENT`. Nothing checks that the cwd
   exists (`resolveExecCwd` in `src/tools/execHelpers.ts`), Node blames the executable, and
   `processSpawn.ts` classifies it as `missing_executable`. With `shell: pwsh` the same
   mistake reads "PowerShell 7 is missing" (`shellTool.ts`, the ENOENT branch).

## 1. Forge: tell a server's early stop from a spent budget

A `length` finish means "the budget is used up" only when the output reached the cap that
was sent. Forge knows both numbers: the request's `max_tokens` (`buildRoundRequest`) and
the final frame's `usage.completion_tokens` (`stream_options.include_usage`, already
requested where `includeUsage` is set; `OpenAIClient.ts:353`).

- Capture the round's `completion_tokens` in `toolCallingStream.ts` alongside the existing
  `onUsage` pass-through, and return it on the streamed result (`completionTokens?:
  number`).
- In `ToolCallingLoop.ts`, define an early stop as: `finishReason === 'length'`, a
  `max_tokens` was sent, `completionTokens` is known, and `completionTokens < 0.9 *
  max_tokens`. The 10% margin covers servers that count draft or template tokens
  differently. Strata's engine count was 34,198 against 34,195 delivered.
- An early stop on a reasoning-only round takes the existing reasoning-stop retry (one
  retry, thinking off, the nudge quoting the reasoning tail; `MAX_REASONING_STOP_RETRIES`).
  It shares that counter (`reasoningStopRetries`), which resets after a round that does
  real work: one retry per stall, as today, not a new budget per stop type.
- When the retry is not available (already used), end the turn with a new notice that says
  what is known: "the server stopped this round at N of M tokens with `length`, before the
  output limit; the cause is the server's, not the budget." Keep
  `OUTPUT_BUDGET_EXHAUSTED_NOTICE` only for a real cap hit.
- Usage unknown (a provider that sends none, or `includeUsage` off): behaviour unchanged.
  Do not guess from character counts.
- Log one line in the Forge output channel for an early stop (`finish_reason=length
  completion_tokens=N max_tokens=M early=true`), so the next audit sees it without the
  server's log.
- Per CLAUDE.md "Output Budget": this is not a truncation of a tool call and must not
  advance `ToolFailureTracker`. A `length` with tool deltas in flight keeps its existing
  truncation path; this item touches only reasoning-only rounds.

`ToolCallingLoop.ts` is at 425 lines. If the branch pushes it past 450, move the
reasoning-only stop decision (both retry and notice) into a function in
`agent/truncationRecovery.ts`, which already owns the notices.

## 2. Forge: name a missing cwd

- `resolveExecCwd` (sole owner of exec cwd resolution) checks the resolved folder with
  `fs.statSync`. Missing: throw `shell: cwd "build" does not exist (resolved to <abs>).
  Create it first (create_directory, or mkdir in the command) or leave cwd out.` Not a
  folder: say so. Grep its callers and confirm each is a spawn site where a missing folder
  is an error.
- `processSpawn.ts`: before classifying ENOENT as `missing_executable`, check whether the
  cwd exists. If it does not, use a `missing_cwd` kind, so any other caller of
  `spawnAndWait` gets the right message too. `BackgroundExecutionManager` spawns with its
  own `normalizeSpawnCwd(options.cwd)`, so it gets the same check.
- `shellTool.ts`'s pwsh ENOENT branch then sees only a real missing executable.

## 3. Forge: render_html_to_image names the saved file by its workspace path

Evidence: pelican-svg session, rounds 3-7. Image mode answered `Rendered
20261010-003828-pelican-on-a-bicycle-svg-animation.png …` (`renderHtmlToImageTool.ts:327`
uses `path.basename`). The file was in `generated-images/`. The model passed the bare name
to `send_file`, was refused, and spent two `ls` rounds finding it: 3 of the run's 8 rounds.

Fix: the head line gives the workspace-relative path (`generated-images/<name>.png`), the
string `send_file` and `view_image` accept. If the file is outside the workspace (the
conversation's screenshot directory), give the absolute path. Test: the result line
contains a path that `send_file` resolves.

## 4. Forge: send_file says "not found" when the file is missing

Same evidence. `sendFileTool.ts` returns one `PATH_REFUSAL` ("path must be in the workspace
or this conversation's screenshot directory") for a missing file and for an outside path,
so a workspace-relative name of a file that does not exist reads like a permission problem.
Split it: a path that resolves inside the workspace but does not exist gets `Error: no file
at <relative path>`. If a file of that basename exists in `generated-images/` or the
screenshot directory, name it (`did you mean generated-images/<name>?`). The outside-path
refusal keeps its text. Tests for both strings.

## 5. Strata: launcher output and upstream PRs

### 5a. Local: keep the server's console output (not a PR)

`start-strata.bat` runs `python start_strata.py` in a hidden console, and every
`[strata] …` diagnostic (the #606 and #728 stops, the #530 hint, request lines with
`max_new=`) is lost. Redirect stdout and stderr in hidden mode to
`N:\Strata\strata-server-console.log`, appending. Apply it on the next planned restart
only; never restart Strata for this. The bat is untracked in `N:\Strata`'s git (checked
2026-10-10), so it is a plain local edit. Check that `UPDATE.bat` does not rewrite it.

### 5b. Upstream PR: the #606 guard stops legitimate digit runs, and reports it as `length`

Repro, synthetic (never the bench prompt): ask the model for the smallest positive double
written out in full positional notation, with thinking on. The answer has 323 zeros in a
row, so with the default `repeat_stop_tokens: 256` the reply ends after 255 zeros as
`length`.

Proposed change in `serve/server.py`:

- Count runs separately by token class. A token whose text is a single ASCII digit (or the
  same multi-digit token) uses a higher threshold (`repeat_stop_digit_tokens`, default
  2048). Every other token keeps 256. The #606 case (`!` forever) is unaffected, and a
  truly stuck `0` still ends, just later.
- Report the stop to the client without breaking the OpenAI `finish_reason` set:
  `finish_reason` stays `"length"`, and the final chunk carries
  `"strata": {"stop": "repeat", "token": "<text>", "run": N}`. Do the same for the #728
  loop stop (`"stop": "loop"`). Clients that ignore unknown fields see no change.
- Docs: the #606 paragraph in `docs/DETAILS.md`.
- Tests next to the existing #606 tests: a digit run of 300 passes; a `!` run of 256 still
  stops; the final chunk carries the `strata.stop` field.

Workflow:
- Work in a separate clone or worktree of the fork, never in the live `N:\Strata` tree
  while it serves (CLAUDE.md for Strata, memory).
- The repo is CRLF.
- The branch name and the PR need the user's OK. Open the PR against upstream from the
  `Efs-O/Strata` fork, and send its text to the user before posting it.
- If the maintainer ports it himself (as with #1114), that is fine. The issue text carries
  the repro and the field proposal either way.

### 5c. Upstream issue: a tool name that swallows its parameters

Evidence: matchbox session, round 59 (Forge log request id=112, `finish_reason=tool_calls`).
Strata returned a structured tool call named `read_file
<parameter=end_line` with
arguments `{}`. Its server-side parser did not end the function name at the line break,
probably because the model left out the `>` after `<function=read_file`. Forge answered
"unknown tool"; the model recovered in one 10 s round, so this is low cost. Proposal: end
the name at the first newline or `<`, and parse the parameters that follow. File it as an
issue with the raw delta if the log has it. A PR only if the parser fix is as small as it
looks.

Forge does not depend on 5b: item 1 detects the early stop from usage alone. Once 5b lands,
Forge can name the cause in the notice (`strata.stop`). That is a later, optional
follow-up, not part of this plan.

## Out of scope

- Re-running interview. The recorded run stays as evidence; NOTES.md gets the cause.
- `max_tool_rounds`, prompt changes, the bench profile.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `N:\Strata\strata-server-console.log` (5a) | Appended by the hidden launcher's redirect at each Strata start | By hand only. The file grows across restarts, so check its size at each Strata update and truncate if it is over 50 MB | Removing the redirect stops new writes; the file stays | A partial last line; the next start appends after it | Stops growing; the handle closes with the process | None. Size checked at each Strata update (above) |

Items 1-4 write nothing durable: one output-channel line and in-memory per-round
fields. Item 5b adds a config key (`repeat_stop_digit_tokens`) read at start, with a
default. It writes nothing.

## Acceptance criteria

- Item 1, unit tests in `ToolCallingLoop` tests:
  - A reasoning-only round with `length`, `completion_tokens` 34,195 and `max_tokens`
    140,347 is retried once with thinking off, and the turn continues.
  - The same at 139,000 of 140,347 ends with `OUTPUT_BUDGET_EXHAUSTED_NOTICE` and no retry.
  - With no usage, behaviour is unchanged (the turn ends with the old notice).
  - A second early stop after the retry ends with the new "server stopped" notice.
  - `ToolFailureTracker` is not advanced.
- Item 2, unit tests:
  - `resolveExecCwd` with a missing relative folder throws the message naming it.
  - A file path is refused as "not a folder".
  - `spawnAndWait` with a missing cwd reports `missing_cwd`, not `missing_executable`.
  - pwsh with a missing cwd does not say PowerShell 7 is missing.
  - Tests use `TEST_BASH`, never a bare `bash`.
- `npm run ci` green after each item's commit, and `npm run package` green at the end.
  Add a `CHANGES.md` entry, and a `docs/OWNERS.md` row if a module is added.
- Item 3: the render result names a path `send_file` accepts.
- Item 4: tests for the not-found and did-you-mean strings; the outside-path refusal is unchanged.
- 5a: after the next planned Strata restart, the console log holds `[strata]` lines.
- 5b/5c: Strata's tests pass in the clone, and the PR text is approved by the user before
  posting.
- `results/followup-2026-10-09/NOTES.md` records the interview cause, with the Strata
  request record quoted. Add a note; the raw files stay unedited.

## Implementation hand-off (review, 2026-10-10)

Self-review before handing items 1-4 to an implementer:

- Items 1-4 are the implementer's. Item 5 (Strata) is not: do not touch `N:\Strata` or any
  Strata clone.
- Item 1: first confirm that the round request always carries `max_tokens` (the
  `outputRoom` path) and that the final frame's usage reaches the loop for the OpenAI client
  and for `OllamaNativeClient` (`eval_count`). If one client has no usage, item 1 is inert
  there; say so in CHANGES.md, do not guess.
- Item 3: confirm that `send_file` and `view_image` both resolve a workspace-relative
  `generated-images/<name>.png` before changing the head line; if one does not, fix the
  resolver, not the wording.
- Item 2: `resolveExecCwd`'s callers must all be spawn sites; if a caller only formats a
  path for display, it must not throw there.
- One commit per item, each after a green `npm run ci`; `npm run package` at the end; a
  version bump and a `CHANGES.md` entry. Commit the plan file with item 1. No push, no tag,
  no VSIX install: the live test on Strata is Claude's.
