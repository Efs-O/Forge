# Harness comparison: Forge vs OpenCode on the same Strata model

## Why

We believe Forge gets more out of a local Qwen than a generic harness does,
because its tools and prompts were tuned for slow, expensive rounds on local
hardware. Nobody has measured that. Before telling anyone else (the Strata
author, Strata users) that Forge is the better client for this model, we need
numbers they can check.

The question is narrow: **same model, same server, same tasks, with only the
harness changing.** Which harness finishes correctly, in fewer rounds and
less wall time?

## What is held fixed

- **Server:** Strata on `localhost:8090`, the model Forge's
  `strata-flashnext-iq3s` entry serves. It is one server and one slot, and the
  harnesses run one at a time, never concurrently.
- **Tasks:** identical prompt text, pasted verbatim into each harness.
- **Starting tree:** a fresh copy of the bench repo at the same commit for every
  run.
- **Grading:** a check script the model never sees, run after the harness
  says it is done.
- **Model settings:** the same for both. Context 200000, output cap 32000
  per response, reasoning effort `xhigh`. OpenCode cannot ask for more than
  32000, so Forge's Strata entry is pinned to 32000 too (the starter's
  `defaults.max_tokens` of 200000 is a ceiling the entry overrides). Task 5 changes
  this for both: context 64K, output cap 16K.
- **Out-of-the-box setup:** each harness is used as a new user would get it.
  - **Forge** runs on the starter config a new install writes (0.16.91 or later:
    file edits and deletes, command execution and git writes on, all behind the
    confirmation gate), with only the Strata model entry added. It runs in a
    separate VS Code instance (`--user-data-dir` and `--extensions-dir` under
    the grader dir) with the release VSIX installed there, and reads the bench
    config copied into the run workspace's `.forge/config.yaml`. Our own
    VS Code profile and `config.yaml` are never touched. That means no HalluScribe, no delegation to
    Claude Code or Codex, no search, browser or desktop tools, and no tuned
    compaction or sampling. It gets the `FORGE.md` that its own `/init`
    produces (0.16.91), generated once per start branch and copied into every
    run, exactly as OpenCode gets its `AGENTS.md`. The bench window has no
    slash-command route, so the `/init` prompt text is sent through the agent
    bus, with the same prefix as the tasks.
  - **OpenCode** runs with its defaults plus a provider config, passed through
    `OPENCODE_CONFIG`, that only names Strata (also as `small_model`, so its
    title request stays local), denies `webfetch` (matching Forge's fetch
    being off) and denies `external_directory` (matching Forge's workspace
    boundary, so a run cannot read or delete outside its folder). It is
    launched with `OPENCODE_DISABLE_CLAUDE_CODE`, `_PROMPT`, `_SKILLS` and
    `OPENCODE_DISABLE_EXTERNAL_SKILLS` set, because otherwise it loads our
    personal `~/.claude` skills, which no other user has. It gets the
    `AGENTS.md` that its own `/init` produces, generated once per start branch
    and copied into every run, as a user following OpenCode's docs would have.
  - **Both `/init` files are generated before task 1 is written.** OpenCode's
    first `AGENTS.md` for the base branch quoted the answer to the original
    task 1, so task 1 is replaced by a lookup whose answer appears in neither
    harness's file. The results disclose this order.
  - Neither gets extra prompting. Forge's shipped tuning counts, because it is
    part of the product. Our personal 26 KB `FORGE.md` and `config.yaml` do not,
    because no other user has them.
  - **The one known prompt difference:** Forge receives the task through the
    agent bus, which prefixes `**claude says:**`. The results disclose it.
  - **The one known tool difference the bench adds:** driving Forge needs the
    control server and agent bus on, which also registers `ask_live_session`.
    A new install does not have it. The results disclose it, and every Forge
    session JSONL is checked for calls to it; any run that called it is
    flagged in the table.
  - Confirmation prompts are on in Forge by default, so the bench runs it with
    `/clanker` (approvals off). That is the closest equivalent to OpenCode's
    allow-by-default permissions, and the time a human takes to click must
    not count. Clanker is stored per workspace, so every Forge run reuses one
    fixed path (`hb-runs/forge`), reset in place between runs.

## Harnesses

| Harness | How it is driven | Cost |
|---|---|---|
| Forge (current VSIX) | `forge.sh say claude --new <task file>` in the bench workspace window | Free: local model |
| OpenCode | `opencode run "<task>"` in the bench clone, with an `@ai-sdk/openai-compatible` provider pointed at `http://localhost:8090/v1` | **Free: no OpenCode credits used.** Credits apply only to OpenCode's hosted models (Zen); a custom local provider never touches them. |
| Cline (optional) | Manual: the user pastes each task into the VS Code panel | Free: local model |

Cline is optional because it cannot be driven from the shell. It is worth one
pass only if OpenCode and Forge come out close.

## The bench repo

`N:\vs code apps\harness-bench` is a small TypeScript project of about 15
files, with `npm test` (vitest). It is a separate git repo, not inside Forge,
so no harness can read Forge's source or its `FORGE.md`. Every run works in a
standalone clone (`git clone --no-hardlinks`, origin removed), never a
worktree, so nothing a run does can reach the bench repo's own `.git`.
OpenCode runs use a new clone `hb-runs/<run>`, deleted after grading. Forge
runs use the fixed clone `hb-runs/forge`, reset with a forced fetch,
`checkout -f` and `clean -fdx` (keeping `node_modules` and `.forge/`), then
given that branch's `/init` `FORGE.md` and a fresh copy of the bench config.
The bench repo and grader were backed up (git bundle and tar) before any run.

The seeded content includes:
- a known bug that spans two files, with a failing test;
- a function with a documented missing feature;
- enough files and a long enough log fixture for task 4 to fill the context.

## Tasks

There are two sets. Our four tasks test what we care about, but we wrote them,
and a skeptic will say so. A **third-party set** answers that.

### Third-party set

Ten exercises from the Aider polyglot benchmark (Exercism problems with their
own tests). They are picked by a rule fixed before any run: the first ten
JavaScript exercises in alphabetical order (the set has no TypeScript track),
from `Aider-AI/polyglot-benchmark@7e0611e`. They sit on their own branch
`pg-start` of the bench repo, one folder each, sharing one jest install. Each
exercise's `.meta/` (which holds the reference solution) is removed, and
`xtest` is turned into `test` so every case counts. Every exercise fails all
its tests untouched and passes all of them with its reference solution, which
the grader keeps outside the bench repo. The prompt is the same for each:
"Make the tests in the `<exercise>` folder pass without changing them." The
grade is the exercise's own test suite, plus a check that the spec file is
unchanged. Neither of us chose which ones.

### Our set

1. **Lookup (read-only).** A question about the code whose answer appears in
   neither harness's `/init` file (the original retry-delay question was
   quoted by OpenCode's `AGENTS.md`). Graded against the known answer.
2. **Bug fix across two files.** "`npm test` fails in `queue.test.ts`. Fix the
   cause, not the test." Graded by `npm test` passing and the check script
   confirming the test file is unchanged.
3. **Feature plus test.** "Add `--dry-run` to the CLI: print the actions, change
   nothing. Add a test." Graded by a hidden test.
4. **Log triage.** "Find every dead-lettered job in `logs/` and write
   `reports/dead-letters.md`, one section per distinct root cause, with job
   ids." Graded against a hidden answer key: every id present, none extra,
   grouped correctly. The variants of a cause differ only by host, port, delay
   or position, so there is one right grouping.
5. **Compaction.** Task 4 again, with the context set to 64K and the output
   cap to 16K for **both** harnesses. The logs are well over 64K tokens, so each harness must compact,
   chunk or fail, and whichever it does is the result.

The tasks run **five times** per harness. A sampled model makes two runs
noise; five gives a median and a spread. The harness that goes first
alternates from run to run.

A **pilot** of one run per task per harness comes first. It checks that every
pipe works and gives the time per run. Only the pilot is approved; whether the
full schedule runs is decided with the user from the pilot's results. The only
arm is each harness as shipped plus its own `/init` file; arms without `/init`,
or with our personal setup, are not run.

## What is measured

Both harnesses are measured from **Strata's own request log**, so the same
ruler applies to each. A run is the window between the task being sent and the
harness reporting done.

| Metric | Source |
|---|---|
| Model rounds (chat requests) | Strata log, requests in the window |
| Prompt tokens and generated tokens | Strata log |
| Wall time | Timestamps on send and on the done report |
| Tool calls and failed tool calls | Forge: session JSONL. OpenCode: `opencode export` of the session |
| Correct? | The check script (pass/fail). Graded only by script, never by hand |
| Compacted? (task 5) | Each harness's own transcript |
| Title / housekeeping requests | Counted apart from task rounds (OpenCode sends one title request per session) |

## Output

`N:\vs code apps\harness-bench\results\results.md` holds one table row per run
and a short reading of the result.

Write the result as found. If OpenCode wins a task, the next step is to read how
it did it, not to rerun until Forge wins. A run is never discarded or repeated
unless the pipe itself broke (Strata down, harness crash before the task was
sent), and any such repeat is listed.

Everything needed to check the claim is published with it: the bench repo,
the task prompts, both harness configs, the grader, and the raw Strata log
lines for every run.

## Phases

0. Install OpenCode and point it at Strata. One smoke prompt ("list the files
   here") proves the provider and the tool calls work. Get the user's OK before
   anything uses Strata, since Strata may be mid-turn for Forge.
1. Build the bench repo, its four tasks and the check scripts. The check
   scripts must pass on a hand-made reference solution and fail on the untouched
   tree before any harness run counts.
2. Pilot: one run per task per harness. Then the full schedule: five runs per
   task per harness, alternating which harness goes first.
3. Write `results.md`, then decide with the user whether to contact the Strata
   author.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause / disable | Crash mid-write | Owner-process death | TTL / expiry |
|---|---|---|---|---|---|---|
| Bench repo `N:\vs code apps\harness-bench` | Phase 1, by hand | User decides after phase 3; kept by default as the reproducible record | N/A: inert files | Rebuilt from its own git history | N/A: no process owns it | None: kept until the user deletes it |
| Per-run OpenCode clones `hb-runs/<run>` | `new-run.sh` (standalone clone, origin removed, `npm ci`) | `end-run.sh` after grading; it refuses a path without `.git` | A paused run leaves its clone; `new-run.sh` refuses to start while one exists | Harness crash: the clone is graded as-is (a fail) and then removed | Same as crash | Removed in the same phase it was created |
| `/init` instruction files (Forge `FORGE.md`, OpenCode `AGENTS.md`, per start branch) | Generated once per harness and branch before task 1 is written; saved in the grader dir | With the grader dir | N/A: inert files | Regenerated whole | Regenerated whole | None |
| Backup (`harness-bench-backup-<stamp>`: bundle + grader tar) | Before the first run | By the user after phase 3 | N/A | Re-made | N/A | None |
| `results/results.md` | Appended after each graded run | Kept with the bench repo | N/A | A row is written only after grading, so a crash loses at most the current run's row, which is re-run | N/A | None |
| Grader-side `opencode.json` (via `OPENCODE_CONFIG`) | Phase 0 | With the grader dir. The user-global OpenCode config is never written | Unset the env var | Re-written whole | N/A | None |
| Bench Forge config (`forge-bench-config.yaml`, copied to `hb-runs/forge/.forge/config.yaml`) | Phase 0, from the starter config; copied before every Forge run | With the grader dir; the copy goes with the worktree. Our own `config.yaml` is never written | N/A: only the bench window reads it | Re-copied whole before the next run | N/A | None |
| Bench VS Code profile (`vscode-profile/`, `vscode-ext/` in the grader dir) | Phase 0, with the release VSIX installed | With the grader dir after phase 3 | Close the bench window | Reinstall the VSIX | Bench window crash: the run is a pipe failure and is repeated and listed | None |
| Fixed Forge clone `hb-runs/forge` | `reset-forge-run.sh`, first Forge run | Deleted after the last Forge run | Left as-is; the next run resets it | Reset by the next run's `checkout -f` + `clean -fdx` | Same as crash | Removed at the end of phase 2 |
| Polyglot exercise copies | Phase 1, copied into the bench repo at a fixed commit | With the bench repo | N/A: inert files | Re-copied | N/A | None |
| OpenCode session store (its own data dir) | OpenCode, on every run | Left in place. It belongs to OpenCode, and `opencode export` reads from it | N/A | OpenCode's concern | OpenCode's concern | OpenCode's policy |
| Forge session JSONL for bench chats | Forge, as for any chat | Never deleted: it is the forensic record | N/A | Forge's existing cursor rows | Existing behaviour | None |

The cheapest check to make enforceable is the clone row: `new-run.sh` refuses
to start a run while any OpenCode clone from an earlier run still exists.

## Acceptance criteria

- The Forge runs used VSIX 0.16.91 or later, the version that ships the
  starter setup and the agent-turn `/init` being tested.
- No Forge session JSONL from a counted run contains an `ask_live_session`
  call, or the run is flagged in `results.md`.
- OpenCode completes a smoke prompt against Strata with at least one successful
  tool call, using no OpenCode credits.
- Every check script fails on the untouched tree and passes on the reference
  solution.
- The pilot: the ten third-party exercises and the five tasks each have one
  graded run per harness, with every measured column filled. The full five-run
  schedule happens only if the user approves it after the pilot.
- The Forge runs used the starter config plus the Strata entry and nothing
  else; the OpenCode runs used defaults plus the provider entry. Both configs
  are published.
- `results.md` states which harness won each metric per task, and says so
  plainly where the runs disagree or the gap is within run-to-run spread.
- No run touched Forge's repo, the user-global OpenCode config, or `config.yaml`.
