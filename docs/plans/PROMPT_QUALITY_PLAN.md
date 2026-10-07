# Prompt quality: one owner for Forge's rules, judged on quality, not speed

Status: approved to run (2026-10-07). The user delegated the two open
decisions (time budget, replayed tasks) to Claude; both are recorded under
"Decisions" and stay open to the user's veto until phase 2 starts. The plan is
committed before the first counted run and is not edited after it except
through the change rule in principle 5 (preregistration).

## Why

Round 1b of the harness comparison (`HARNESS_COMPARISON_PLAN.md`, results in
`N:\vs code apps\harness-bench\results\results.md`) tuned Forge's prompt for
wall time on two tasks. It found real waste (the 25-line starter prompt cost
about 40% of the time), but it also showed the limits of that bench:

- **The grader cannot see quality.** Every prompt variant passed tasks 4 and 5,
  so the only signal left was speed. Cutting further would make Forge terse
  without anything measuring what that costs.
- **The user's priority is quality and friendliness, not matching OpenCode's
  speed.** A larger prompt is acceptable when it earns its time.
- **Two tasks of one kind are not enough to judge quality.** Tasks 4 and 5 are
  both "read logs, write a report".
- **Forge's robustness holds in real use.** Its last 100 sessions (14,330 tool
  calls, de-duplicated) show no runaway loops: six runs of the same call three
  or more times, of which three were `monitor_execution` waits by design, two
  were `web_fetch` re-reads, and one a short `search_code` repeat. Rules that
  produce this behaviour are not to be removed for speed.
- **OpenCode's own prompt did not close the gap.** With OpenCode's captured
  prompt as `system_prompt`, Forge took 268 s on task 4 (14 requests, 11.7K
  generated, pass) against OpenCode's 88 s, inside the range of Forge's own
  variants. About 5.5K of those tokens were thinking.

### The layering problem

Forge sends one system message, assembled in this order:

1. `config/templates/builtin/execute.njk`: Forge's own rules, shipped with
   Forge.
2. Date and workspace root.
3. The repo's `FORGE.md`.
4. `system_prompt` from `config.yaml`, meant for the user's preferences.

The starter config (`src/config/StarterConfig.ts`, `config/starter/*.yaml`)
fills layer 4 with agent rules ("be brief, batch calls, verify"). Those are
Forge's rules, so Forge has two owners for one concern, and they contradict
each other: `execute.njk` says "After each result, briefly report what
changed", the starter says to be brief. Every benchmark variant so far changed
layer 4 only; `execute.njk` was never varied. OpenCode, Claude Code and Forge
all use the same two-plus-one shape (built-in prompt, project file, personal
file); only Forge ships rules in the personal layer.

### What the field found in 2026

- **Hard brevity caps cost quality.** Anthropic's 2026-04-23 Claude Code
  postmortem: a system-prompt rule keeping text between tool calls under 25
  words and final answers under 100 words caused a 3% drop on their coding
  evals and was reverted after four days
  ([InfoQ](https://infoq.com/news/2026/05/anthropic-claude-code-postmortem),
  [Tessl](https://www.tessl.io/blog/anthropic-postmortem-shows-how-small-changes-compounded-into-claude-code-failure/)).
  This is the failure the user warned about: tuning to the opposite side.
- **What a prompt asks for drives cost, not its length.** "Prompt-Induced Waste
  in Coding Agents" (arXiv 2608.01347, preregistered, 24 tasks, 4,644 runs,
  two harnesses): asking for alternative approaches cost 2.4-7.4× reasoning
  tokens with no success gain; "think deeply" cost 1.6-2.2× and added no new
  hypotheses, evidence or checks; certainty wording ("make sure", "be
  certain") multiplied tool calls after the task had already succeeded. A
  longer prompt that only restates requirements cost about nothing extra. The
  cheap fixes are subtractive: delete those instructions, and replace
  certainty demands with an explicit verification rule ("run the relevant
  suite after the final edit; re-run it only after a relevant change or a
  failure"), plus scope, success criteria and a stop condition
  ([arXiv](https://arxiv.org/html/2608.01347)). The same study found the
  harness mattered more than any prompt wording. So a bigger Forge prompt is
  fine if it adds rules of the cheap kind.
- **Evaluate with traces first, judges second.** OpenAI's skill-eval guidance
  scores outcome, process, style and efficiency: deterministic checks over
  JSONL traces wherever possible, and a rubric only where no check can decide.
  Google's harness-engineering guide adds: target one failure mode per change,
  and track pass rates over batches, never single runs
  ([Google Developers Blog](https://developers.googleblog.com/the-anatomy-of-harness-engineering-how-to-evaluate-iterate-and-guard-ai-coding-agents/),
  [awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering)).
- **Thinking budgets.** Qwen-family thinking models can be forced out of
  thinking after N tokens by the server (vLLM, llama.cpp's
  `--reasoning-budget`), at some quality risk on hard tasks
  ([sglang #25536](https://github.com/sgl-project/sglang/issues/25536)). Forge
  passes `--reasoning-budget` only to the llama-server models it spawns;
  Strata is a separate server, and whether it has an equivalent is unchecked
  (phase 1).

## Principles

1. **Structure before content.** First give Forge's rules one owner without
   changing what the model is told. Only then vary the content.
2. **No content change is adopted on speed alone.** A variant is adopted only
   if its quality is at least the baseline's on every task category (see
   decision rule).
3. **Robustness rules stay unless evidence says otherwise.** Read-before-edit,
   batching, the line-number rule, the repeat-call rule, the shell rules and
   the 3-failed-attempts rule each came from an audited failure (git history
   of `execute.njk`, 18 commits). Each removal needs its own evidence.
4. **Time budget, not a race.** Measured against today's shipped prompt (A),
   not against OpenCode (see Decisions). OpenCode's time is reported for
   reference only.
5. **No task, rubric item or grader changes after a result is seen.** If one
   must change, it is listed in the results with the reason, and every earlier
   run is regraded.
6. **No word or line caps on answers.** Answer shape is described by content
   (what was done, what was verified, what the user must decide), never by a
   count. The postmortem above is the reason.
7. **Prefer subtractive changes, and judge additions by the work they ask
   for.** A new line that only clarifies is cheap; a line that asks for more
   exploration, alternatives or certainty needs evidence that it buys quality.

## Quality rubric

Each run is scored on these items. Items marked *auto* are scored by script
from the session JSONL and the worktree; items marked *read* are scored by a
reader who sees the answer and transcript with harness and variant removed.

| Item | How | Scored |
|---|---|---|
| Task outcome correct | Task grader (tests, hidden test, answer key) | auto, pass/fail |
| Verification done | A check that proves the change (test, build, type check, re-run) ran after the last edit, for tasks that change code | auto |
| Claims backed | Every factual claim in the final answer (counts, file names, "tests pass") appears in a tool result of the run | read, 0-2 |
| Scope respected | No changes outside what the task needs; constraints in the prompt kept; no leftover scratch files | auto |
| Answer usefulness | States what was done, what was verified, and anything the user must decide; no padding | read, 0-2 |
| Judgement | Asks or states an assumption on an ambiguous task; spots the planted trap | read, 0-2 (judgement tasks only) |
| Tool errors and repeats | Failed tool calls, identical calls three times in a row | auto, reported, not scored |
| Post-success calls | Tool calls after the last check that already proved the task done (the waste the 2026 study measured) | auto, reported, not scored |
| Time and tokens | Wall time, requests, generated tokens (Strata log) | auto, reported, gated by the time budget |

Readers: Claude scores all *read* items from bundles a script builds per run
(task prompt, final answer, tool-call list, diff), with harness and variant
removed and the bundles shuffled; the key is opened only after every bundle is
scored. Each *read* item has written anchors for 0, 1 and 2, fixed in phase 1
before any bundle is read. The user spot-checks at least one run per task,
also blind, when they have time; it does not block the runs. Where the user
and Claude disagree, the user's score stands, the disagreement is listed, and
Claude re-scores that item on every bundle with the corrected anchor.

## Task set (about 15)

Every task is chosen by **kind of everyday work**, written here with a grader
proven pass-on-reference and fail-on-untouched **before any variant runs it**.

**Coding** (from round 2 of `HARNESS_COMPARISON_PLAN.md`, plus two kept tasks)

1. Task 4: log triage (kept as the round 1b anchor). Task 5, the old
   compaction task, never compacted in round 1b and is replaced by task 6
   below.
2. Task 3: feature plus test (`--dry-run`).
3. Round 2 task 6: signature refactor across 10+ call sites.
4. Round 2 task 7: failure buried in large test output.
5. Round 2 task 8: feature across six or more files.
6. Round 2 task 9: long task with forced compaction and two constraints from
   the first message.
7. Round 2 task 10: background process (start, verify through it, stop).

**Judgement**

8. Ambiguous request: two reasonable readings that lead to different code.
   Correct: a clarifying question, or one reading picked and the assumption
   stated in the answer. Wrong: one reading picked silently. (The bench sends
   tasks over the agent bus with no one at the keyboard. `ask_user` is
   offered in the bench window today and would hang the run; phase 1 decides
   whether the bench config disables it or the runner answers it with a fixed
   "use your judgement". A question in the final answer counts either way.)
9. Obvious fix is wrong: a failing test whose quick fix breaks another
   caller. Graded by the full test suite.
10. Review a diff with three planted defects (one logic, one missing
    test, one style). Graded against the answer key; false alarms counted.

**Non-coding**

11. Answer from documents: a question answered by reading three docs in the
    repo, one of which contradicts another; the right answer names the
    contradiction. Graded against an answer key.
12. Write a plan: "plan how to add X" for a feature in the bench repo, no code.
    Graded by rubric only (usefulness, claims backed).

**From the user's own sessions**

13-15. Three tasks replayed from the user's real Forge sessions. Chosen by
   rule: Claude lists 10 candidate user requests from the last 100 sessions,
   one per kind of work, each replayable at a pinned commit of a repo on this
   machine with no network, no personal data and no secrets. Claude picks
   three of different kinds (delegated, see Decisions) and records all ten
   candidates with the reason for each pick. They are graded by rubric plus a
   grader written from what the original session's accepted result was.

Web research is left out: live search results differ between runs, so they
measure the web, not the prompt.

## Where the rules live (checked 2026-10-07)

Every place that puts instructions in front of the model, checked before any
run, so a variant cannot miss a second owner of the rule it changes.

| Place | What it holds | In scope |
|---|---|---|
| `config/templates/builtin/execute.njk` | Forge's rules; the system message | Yes: B and C change it |
| `STARTER_SYSTEM_PROMPT` in `src/config/StarterConfig.ts` | the five starter lines, appended after `execute.njk` | Yes: B moves them out |
| `SYSTEM_PROMPT` in `src/llm/SystemPromptInjector.ts` | a hard-coded older copy of the rules, sent silently when the template fails to render | Yes: shipping B deletes it or makes a render failure loud; on the bench the captured-request check catches it |
| `system_prompt` per group/model in the user's `.forge/config.yaml` | group-level: the old 25-line prompt (line 73); model-level: Qwopus rules, a Greek `replace` persona | No: the user's own; recommended, never edited |
| `system_prompt` in `forge-bench-config.yaml` | the 25-line prompt, overwritten by every variant | Bench only |
| FORGE.md (`/init` output) | repository facts | No: held fixed per branch |
| Tool descriptions and result strings (`src/tools/`) | how each tool is used; failure guidance | No: the tool contract has its own audits |
| `buildFallbackToolInstructions` in `src/tools/FallbackToolPrompt.ts` | the JSON tool-call format, added only without native tool calls | No; but `execute.njk` repeats it on every turn (C1 candidate) |
| `config/templates/builtin/summarize.njk` | the compaction summary prompt | No |
| Turn context (`src/sidebar/turnContext.ts`), `PLAN_GUIDANCE` | terminal commands, the plan, its guidance | No |
| Loop nudges (`loopRecoveryNudge`, `reasoningStopRetryNudge`, `truncationRecovery.ts`) | mid-turn recovery messages | No |
| The GGUF chat template | message and tool formatting only, no rules | No |

Found by the check and added to C1's candidates: "ALWAYS use tools to act —
never describe or show code in your response without writing it with
write_file" tells the model to write a file on tasks that ask only for an
answer (review, docs, plan, ambiguous); and the always-on JSON fallback line
duplicates `FallbackToolPrompt`, which adds it only when it is needed.

## Variants

Each variant is one change, applied to the bench config only, through
`variant-cfg.mjs` and `templates_dir` (the bench config points
`templates_dir` at a grader-side folder holding the variant `execute.njk`;
`TemplateEngine` reads user dirs before the built-in one, so Forge's source is
not touched). Every variant's first run is checked with a captured request to
prove the model received the intended prompt.

- **A, baseline:** Forge 0.17.0 as shipped: built-in `execute.njk` plus the
  five-line starter `system_prompt`.
- **B, one owner:** the five starter lines moved into `execute.njk`,
  `system_prompt` empty, and the one contradiction resolved by keeping both
  intents: "report what changed" becomes "end with what changed and how it was
  verified". No other wording changes. B must not regress any category
  against A (decision rule); if it does, the move changed behaviour and is
  investigated before anything else.
- **C onward, content:** decided after A and B are read, at most three, each
  one change, written into this plan before it runs. Candidates now, ordered
  by the 2026 evidence:
  - **C1, subtractive audit:** remove or bound lines that ask for extra work
    on every task regardless of need. The first suspect is "Before reviewing
    or editing code, search related code, callers, and similar patterns; do
    not edit a file in isolation", which asks for exploration on a report
    task too; it becomes conditional ("when a change can affect other
    code…"). Lines naming tools the window does not offer (`search_codebase`,
    and `apply_line_edits` outside its group) are reworded to say "when
    loaded".
  - **C2, explicit verification and stop rule:** the starter's "narrowest
    check" line becomes the study's form: run the relevant check after the
    final edit, re-run it only after a relevant change or a failure, then
    stop. Kept because it asks for less work than "verify", not more.
  - **C3, answer shape (the larger prompt):** a short description of a good
    final answer by content (what was done, what was verified and how, what
    the user must decide, nothing else), with no word count. Aimed at
    usefulness; adopted only if it raises the usefulness score.
  - A Strata thinking budget is a server setting, not a prompt; it is tested
    only if phase 1 finds Strata supports one, and only after C1-C3.
- **OpenCode** runs every task as the reference arm, at 0.6 / 0.95.

### Change before any run (2026-10-07): A dropped, pilot first

The user dropped A: it carries the known contradiction and nobody would ship
it, so a night measuring it buys nothing. **B is the baseline**, OpenCode the
outside reference, each C judged against B. Accepted cost: nothing measures
whether the move alone changed behaviour.

Before reserving the PC for the full study, a **pilot** checks whether prompt
content moves this model at all:

- **Arms:** B (`tplB+noprompt+bash`) and **C-all** (`tplCall+noprompt+bash`):
  B plus C1, C2 and C3 together, the largest difference the candidates allow.
  Both templates live in `harness-bench-grader/templates/`.
- **Tasks, one run each:** review, docs, ambiguous, quickfix, buried: the
  rules most likely to matter (answer-only tasks against "ALWAYS use tools",
  a judgement call, root cause against symptom).
- **Go on to the full study** if any task's pass differs between the arms,
  or the read rubric items differ by 2 or more points in total, or the summed
  wall time differs by 25% or more. Otherwise stop: the prompt is not the
  lever for this model, and the result is written up as that.
- One run per task finds only large effects; a null pilot is reported as
  "no large effect", not "no effect".

### Pilot result (2026-10-07): stop — no large effect; OpenCode 2× faster

One run per cell, Strata 0.1.39, 0.6 / 0.95, the same `/init` file per harness
with answer leaks removed (`forge-init-FORGE.r2-start.md`,
`opencode-init-AGENTS.r2-start.md`; raw copies kept beside them). A capture
probe confirmed the C-all template reached the model.

| Task | B | C-all | OpenCode |
|---|---|---|---|
| review | pass, 208 s | pass, 308 s | fail (missed default export), 61 s |
| docs | fail (never read faq.md), 46 s | fail (same), 46 s | fail (same), 30 s |
| ambiguous | fail (silent choice), 167 s | fail (silent choice), 288 s | pass (named the other reading), 91 s |
| quickfix | pass, 66 s | pass, 77 s | pass, 70 s |
| buried | pass, 379 s | pass, 329 s | pass, 156 s |
| **Total** | 3/5, 866 s, 62 requests, 33.5K generated | 3/5, 1048 s, 67, 42.4K | 3/5, 408 s, 36, 11.8K |

- **B vs C-all: stop.** No pass differs, C-all is 21% slower (under 25%), and
  the read differs by about one point (C-all's final answers are better
  structured). Under the decision rules C-all is not adopted: it costs time and
  buys no pass. **Ship B.**
- **The gap to OpenCode is speed, not passes:** same model, same 3/5, but
  Forge takes 2.1× the wall time and generates 2.8× the tokens. That matches
  the earlier bench finding (rounds and output length, not caching) and is
  where the next work goes, not prompt wording.
- **One real behaviour gap:** on the ambiguous task OpenCode built one reading
  and named the other; both Forge arms chose silently, C-all's "anything the
  user must decide" rule included. Worth a targeted variant before any wider
  rewrite.
- **Model limit, not harness:** all three missed the FAQ contradiction on docs.
- **Grader fix:** `askedOrStated` passed C-all on a quoted FAQ heading's `?`;
  tightened before the result was recorded, and all runs regraded under it.

## Runs

- Three runs per task per variant, alternating which variant goes first.
  Roughly 15 tasks × 3 runs × 4-8 minutes ≈ 3-6 hours per arm. Arms: A,
  OpenCode, B, and up to three C variants, so the full round is two to four
  nights. Runs happen only while the user's own window is not using Strata.
- Preconditions, enforced by `smoke.sh`: Strata idle and pinned to one engine
  version for the whole round (0.1.39 unless the user says otherwise), no Forge
  job running or due within 15 minutes, the bench window holding the bus
  endpoint.
- A run is repeated only when the pipe broke (Strata down, harness crash before
  the task was sent, job contention), and every repeat is listed.

## Decision rule

A content variant is adopted as Forge's shipped prompt when:

- no task category (coding, judgement, non-coding, user's own) regresses: a
  category regresses when the 90% task-clustered bootstrap interval of the
  per-task difference in summed rubric score (variant minus A, runs averaged
  per task) lies entirely below zero;
- no task goes from passing in all three runs to failing in any;
- the time budget holds: summed over all tasks, the variant's median wall
  times are at most A's when no category improved, and at most 1.25× A's when
  at least one category improved (its interval lies entirely above zero).

Speed improvements that miss the first two conditions are not adopted. With
three runs per task the interval is wide, so this rule rejects only clear
regressions; a variant that "might" be worse on a category is reported as
such, and the user decides.

## Decisions

Delegated by the user on 2026-10-07 ("re-read it, fix it and run it"):

- **Time budget: relative to A, up to +25% only for a measured quality gain.**
  The user said they will trade some speed for quality and friendliness. A
  budget against OpenCode (first drafted as 2× its median) would have failed
  today's own prompt: Forge's task 4 runs took 2.2-3.6× OpenCode's 88 s. So a
  variant that buys no quality may not be slower than A, and one that buys
  quality may cost up to 25% more time.
- **Replayed tasks:** picked by Claude under the rule in tasks 13-15, with all
  ten candidates recorded so the user can swap any pick before phase 2 starts.

## Phases

0. **Plan fixed and committed** (done 2026-10-07; decisions delegated).
1. **Tasks and graders.** Build tasks 8-12 and the round 2 tasks on a new
   bench branch; prove each grader on a reference and an untouched tree. Write
   the auto rubric scorer over session JSONL / OpenCode events, the bundle
   builder, and the 0/1/2 anchors for every *read* item. Also check: that
   `templates_dir` in the bench config reaches the model (captured request),
   how `ask_user` is handled with no one at the keyboard, and whether Strata
   has a thinking budget.
2. **Baseline:** variant A and OpenCode on every task, three runs each.
3. **Structure:** variant B. If it matches A, ship B in Forge: `execute.njk`
   gets the rules, the starter `system_prompt` becomes empty, the user is told
   which lines of their own `config.yaml` `system_prompt` are now redundant
   (their config is never edited).
4. **Content:** variants C onward, one at a time, under the decision rule.
5. **Write-up** in `results.md`, and update `project_bench_sampling_and_starter_prompt`
   memory with what changed.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause / disable | Crash mid-write | Owner-process death | TTL / expiry |
|---|---|---|---|---|---|---|
| Variant templates folder (grader dir `templates/<variant>/execute.njk`) | Phase 2-4, one folder per variant, before its first run | With the grader dir after phase 5 | N/A: inert files; a variant not in use is simply not referenced | Re-written whole before the variant's first run; the captured-request check catches a bad file | N/A: no process owns it | None |
| `templates_dir` in the bench config copy | `variant-cfg.mjs`, before every Forge run | Overwritten by the next run's fresh copy | N/A: only the bench window reads it | Re-copied whole by the next run | Bench window restart re-reads it | None |
| Paused Forge jobs (`~/.forge/jobs/*.json`, `enabled: false`; list in the session scratchpad `paused-jobs.json`) | Before phase 2 | N/A: jobs are resumed, never deleted | Resumed after phase 4 through Forge's job controls, not hand edits, so overdue jobs do not all fire at once | A half-written job file: Forge's own job store validation | N/A: jobs are inert while disabled | None: they stay paused until resumed; the plan's last phase resumes them |
| Strata engine pin (0.1.39, `strata-update` job paused, stash@{0} kept) | Before phase 2 | Pin released after phase 4; the user decides when to update | The update job stays disabled | N/A | N/A | None |
| New bench branch with tasks 8-12 and round 2 tasks, graders, reference solutions | Phase 1 | With the bench repo, by the user | N/A: inert files | Rebuilt from git history | N/A | None |
| Rubric scores (`results/rubric.jsonl` in the grader dir) | After each run is graded | Kept as the record | N/A | One line per run, written after scoring; a crash loses that run's line, which is re-scored from the kept transcript | N/A | None |
| Raw run files (`results/raw/*`) and Forge session JSONL | Each run | Never deleted: the forensic record | N/A | The run is a pipe failure and repeated, and listed | Same | None |
| Shipped change (phase 3: `execute.njk`, starter config) | Phase 3 commit | Reverted by commit if a later phase finds a regression | N/A | Git | N/A | None |

The cheapest row to enforce: `smoke.sh` already refuses to start while a job
is running or due within 15 minutes, so a resumed job cannot silently share
Strata's slot with a counted run.

## Acceptance criteria

- The time budget and the three replayed tasks (with all ten candidates) are
  recorded in this plan before phase 2, and the user was told they can veto
  either.
- Every task's grader fails on the untouched tree and passes on its reference
  solution, recorded before the first counted run.
- Every variant's first run has a captured request showing the intended system
  prompt reached the model.
- Every counted run has every rubric item filled; *read* items were scored
  blind against anchors fixed before the first bundle was read. The user's
  spot-checks, where given, are listed with any disagreement.
- Variant B is shipped only if no category regresses against A under the
  decision rule's interval test.
- No content variant is shipped unless it meets the decision rule; the
  write-up names which condition each rejected variant missed.
- All runs used one Strata engine version, and no Forge job ran during any
  counted run.
- The user's own `config.yaml` was never edited, and the paused jobs were
  resumed through Forge's job controls at the end.
