# Compaction summarizer: its own request shape (impl plan)

Status: **IMPLEMENTED 2026-08-22.** Shipped as described below, with one
revision from measurement: one hypothesis confirmed, one refuted. See "Measured
results" before reading the Design section — the `disableThinking` option
described there was NOT implemented, deliberately.

What landed: `config/templates/builtin/summarize.njk`, `PromptRunOptions` in
`src/sidebar/PromptRun.ts`, `SUMMARY_OUTPUT_TOKENS` and the summary validation
guard in the new `src/sidebar/compactionPrompt.ts`, the summarizer options in
`CompactionService.ts` (which the split brought back under the LOC threshold),
the `EARLIER SUMMARY` label fix, and the `docs/OWNERS.md` row.

Scope: item 3 of the compaction review only. The tail-sizing cliff, the 73%
source truncation, goal anchoring, and summary layering are **not** in this
plan — see "Out of scope".

## Problem

`runCompaction` produces the summary via `runPromptToMarkdown`
([PromptRun.ts:40](src/sidebar/PromptRun.ts#L40)), which is a general one-shot
prompt runner shared with `/review`, `/initForge`, and `commandHelpers`. Four
defects follow from summarization borrowing a shape built for something else:

1. **Wrong model.** [PromptRun.ts:47-49](src/sidebar/PromptRun.ts#L47-L49)
   resolves `config.active_model` — the picker's global default — not
   `conv.active_model`. A conversation pinned to another model is summarized by
   whatever the picker last defaulted to. Identical to the token-bar bug fixed in
   [ContextBudgetPublisher.ts:105-108](src/sidebar/ContextBudgetPublisher.ts#L105-L108).

2. **Empty summaries on thinking models.** `mergeSampling` supplies
   `max_tokens: 4096` ([SamplingMerge.ts:67](src/llm/SamplingMerge.ts#L67)) and
   thinking spends from that same budget. With `--reasoning-budget 3072` on the
   efso and gemma4 groups (`.forge/config.yaml`):

   ```
   3072 (worst-case thinking) + ~1600 (summary) = 4672 > 4096
   ```

   The model can exhaust the ceiling before emitting prose. `capSummary` then
   returns empty, `runCompaction` returns `'failed'`, and — with no backoff —
   the 85% threshold re-fires the same doomed request every following turn.

3. **Agent persona on a prose task.** `injectSystemPrompt` prefixes the full
   execute template + FORGE.md + workspace context, priming a tool-calling
   coding agent to write a summary.

4. **Leaked thinking is stored forever.** [PromptRun.ts:90](src/sidebar/PromptRun.ts#L90)
   passes `shouldStripThinking(model, config)`, which returns **false** whenever
   `model.think !== false`. Any `<think>` channel arriving as `content` rather
   than `reasoning_content` is written into `conv.compaction.summary` — and that
   string is the model's working context for the rest of the conversation.

## Design

Add an options bag to `runPromptToMarkdown` rather than forking a second copy of
the backend-acquire / stream / controller plumbing (~60 lines). Existing callers
pass nothing and are unchanged.

```ts
export interface PromptRunOptions {
  /** Model to serve this run. Defaults to config.active_model. */
  modelName?: string;
  /** Replaces the agent system prompt entirely. */
  systemPrompt?: string;
  /** Output room ON TOP of the model's reasoning reserve. */
  outputTokens?: number;
  /** Strip thinking channels regardless of model.think. */
  alwaysStripThinking?: boolean;
}
```

### max_tokens

```ts
max_tokens = reasoningReserve(model) + (options.outputTokens ?? 0)
```

`reasoningReserve` already parses `--reasoning-budget` out of spawn args
([contextBudget.ts](src/util/contextBudget.ts)) and returns 0 when absent.

One formula, correct in both worlds: if `enable_thinking:false` takes effect the
reserve simply goes unspent (an unused ceiling costs nothing); if the model's
template ignores the kwarg, the room is already there and the summary still
lands. The kwarg is the optimisation; the formula is the guarantee.

Applied only when `outputTokens` is set, so `/review` and `/initForge` keep the
4096 default.

### Thinking — STAYS ON (revised after measurement)

An earlier draft of this plan added `disableThinking`. **Do not.** Measurement
put it at −0.39 to −0.42 writtenFileRecall (see "Measured results"). Thinking is
the single largest quality factor in the summarizer and must be left alone.

`enable_thinking:false` IS technically per-request and needs no model reload
(`--jinja` is unconditional at [LlamaServerArgs.ts:32](src/backend/LlamaServerArgs.ts#L32);
`ToolCallingLoop` already flips it mid-turn for truncation recovery). That
question was settled — the answer is simply that we should not use it here.

### Summarizer system prompt — a template, not a constant

`TemplateEngine.render(name)` resolves `<name>.njk` **user dirs first, then
builtin** ([TemplateEngine.ts:30](src/llm/TemplateEngine.ts#L30)). Today the only
template is `config/templates/builtin/execute.njk`. Add a second:

**`config/templates/builtin/summarize.njk`** — content must be EXACTLY the string
the winning arm C measured with, or the result does not carry over:

```
You compress a software-engineering conversation into a factual summary. Report only what the transcript states. Do not offer help, ask questions, or call tools.
```

(161 characters, one line, no trailing newline inside the sentence run.)

Rendered with no template context, then passed as the system message in
`replace` mode ([SystemPromptInjector.ts:36-41](src/llm/SystemPromptInjector.ts#L36-L41)),
which skips the execute template entirely — no FORGE.md, no workspace facts.

Why a template rather than a `const` in `CompactionService.ts`: it is tunable by
editing a file with no rebuild, a user copy overrides the builtin, and it matches
the pattern already in the repo. Note `src/templates/builtin/` is DEAD (see
CLAUDE.md) — the live directory is `config/templates/builtin/`.

## Changes

### `src/sidebar/PromptRun.ts`

- `runPromptToMarkdown(ctx, text, conversationId?, options?)`.
- Resolve `options.modelName ?? config.active_model`. `resolveRequestModel`
  already handles an `@profile` suffix, so a pinned profile survives.
- When `options.systemPrompt` is set, call `injectSystemPrompt` with it in
  `replace` mode and no template engine/context.
- After `mergeSampling`, override `max_tokens` when `options.outputTokens` is set.
- No thinking kwarg. `canUseThinkingKwargs` / `chat_template_kwargs` are NOT
  touched by this change; leave the request's thinking behaviour exactly as it
  is today.
- `sanitizeText(content, options.alwaysStripThinking || shouldStripThinking(...))`.
- `PromptRunContext` gains `capabilities?: (model, baseUrl) => Promise<RuntimeModelCapabilities>`.

Estimated +35 LOC; file is 98 today, well under the limit.

### `src/sidebar/CompactionService.ts`

- Export `SUMMARY_OUTPUT_TOKENS = 3072` (the 8000-char
  `COMPACTION_SUMMARY_MAX_CHARS` is ~2600 tokens at 3.1 chars/token; 3072 leaves
  room for a detailed, structured implementation handoff).
- Widen the `runPromptToMarkdown` dep signature to carry `PromptRunOptions`.
- `runCompaction` passes `{ modelName: conv.active_model, systemPromptTemplate:
  'summarize', outputTokens: SUMMARY_OUTPUT_TOKENS, alwaysStripThinking: true }`.
- **Validate before storing** (new — see "the persona emits a tool call"):
  reject a candidate summary that parses as JSON, matches a tool-call shape
  (`{"tool":` / `"arguments":` / a lone fenced JSON block), or is under ~200
  chars. Return `'failed'` instead of persisting it. `capSummary` only rejects
  the empty string today, which is why a 117-char tool call would be stored as
  the conversation's permanent working context.
- Fix the leftover `EARLIER CHECKPOINT:` label at
  [line 160](src/sidebar/CompactionService.ts#L160) → `EARLIER SUMMARY:`. Missed
  when the other two sites were renamed; same noun collision with Forge's
  Keep/Undo checkpoints that sent agents hunting for a file.

**File-size blocker.** `CompactionService.ts` is **361 lines**, already over the
350 limit before this change (353 at HEAD). This plan adds ~15 more. It must be
split in the same pass — proposed seam: move `truncateForSummary`,
`formatSummaryMessage`, `capSummarySource`, `buildSummaryPrompt`,
and their constants into a new
`src/sidebar/compactionPrompt.ts` (~110 LOC), leaving `CompactionService.ts` as
execution + resume (~265 LOC). `docs/OWNERS.md` gains the row.

### `src/sidebar/AgentLoop.ts` / `sidebarWiring.ts`

Thread the optional `options` argument through the two forwarders
([AgentLoop.ts:409](src/sidebar/AgentLoop.ts#L409),
[sidebarWiring.ts:132](src/sidebar/sidebarWiring.ts#L132)). `SidebarProvider`,
`SlashCommandHandler`, and `commandHelpers` are untouched.

## Files touched

| File | Change |
|---|---|
| `src/sidebar/PromptRun.ts` | `PromptRunOptions`; model, system prompt, max_tokens, thinking, strip |
| `src/sidebar/compactionPrompt.ts` | new — summary prompt building, split out for the LOC limit |
| `src/sidebar/CompactionService.ts` | pass the summarizer options; `EARLIER SUMMARY`; shrink by the split |
| `src/sidebar/AgentLoop.ts` | forward `options` |
| `src/sidebar/sidebarWiring.ts` | forward `options` |
| `docs/OWNERS.md` | row for `compactionPrompt.ts` |

## Test plan

- `max_tokens` = reserve + outputTokens for a model with `--reasoning-budget
  3072`; = outputTokens when no budget is configured; **unchanged at 4096** for a
  caller passing no options (regression guard for `/review`, `/initForge`).
- `enable_thinking:false` present when capabilities allow, absent when
  `likelySupportsThinking === false`, and **`reasoning_effort` still present
  alongside it** — the kwarg-merge regression.
- The summarizer run resolves `conv.active_model`, not `config.active_model`,
  including with an `@profile` suffix.
- System prompt is exactly the rendered `summarize.njk` — no FORGE.md, no
  workspace context, no execute template.
- A candidate summary that is a tool-call JSON blob, or 117 chars, is REJECTED
  and never reaches `conv.compaction.summary`.
- A response containing an inline `<think>` block is stripped from the stored
  summary even when `model.think === true`.
- Existing `CompactionService.test.ts` and `SlashCommandHandler.test.ts` pass
  with their dep signatures widened.
- `npm run ci` and `npm run package`.

## Manual verification

1. Pin a conversation to a non-default model, force `/compact`, confirm the log
   names the pinned model.
2. `/compact` on efso (`--reasoning-budget 3072`) returns a summary rather than
   *"compaction returned no summary."*
3. The stored summary contains no `<think>` text and no "How can I help?" opener.

## Risks

- **Summary quality without thinking is unmeasured.** Compression is judgment
  work and this is the one place thinking might earn its 3 000 tokens. `2` above
  is the check. RESOLVED by measurement: thinking is worth ~0.40 recall and
  stays on. The remaining risk is the opposite one — 104s per compaction,
  mid-task, which only a smaller input can fix (see Out of scope).
- **The split is mechanical but touches a hot file.** Pure moves, no logic
  changes, covered by the existing suite.

## Out of scope

Deliberately excluded, each still open from the review:

- The zero-tail cliff past three tool rounds (measured) — the biggest quality
  item, wants token-budgeted tail selection.
- `SUMMARY_SOURCE_MAX_CHARS` dropping ~73% of the transcript middle (measured).
- Anchoring the first user message; layering summaries instead of
  re-summarizing; deterministic file/error facts appended by code.
- Backoff after a failed compaction.

---

## Evidence harness (built 2026-08-22, before implementing)

`npm run ab:compaction` — `scripts/compaction-ab.mjs`. Runs both request shapes
back to back against a model that is **already loaded**; it spawns nothing.

Arm B is only a different set of request parameters, so the plan can be judged
on measurements before a line of it is written.

```
node scripts/compaction-ab.mjs --densest --runs 3 --base-url http://127.0.0.1:8080
node scripts/compaction-ab.mjs --dry-run --densest     # inputs only, no model needed
```

| flag | meaning |
|---|---|
| `--dry-run` | print window/split/ground truth and stop |
| `--densest` | summarize the window with the most write calls, not the tail |
| `--tokens N` | window size, default 40000 |
| `--runs N` | runs per arm, default 3 |
| `--end N` | window ends at message N instead of the last |
| `--arm-a-max-tokens` / `--arm-b-output-tokens` / `--reasoning-budget` | request sizing |

Both arms go through the shipping `selectCompactionSplit` and
`buildSummaryPrompt`, bundled out of `src/` with the unit tests' `vscode` stub
(`compaction-ab-bridge.mjs`) so the harness cannot drift from the real code.

### Metrics

Ground truth comes from the transcript itself — every path in a `tool_calls`
argument — so recall and confabulation are measured, not eyeballed:

- **writtenFileRecall** — of the files actually modified, how many the summary names
- **topReferencedRecall** — same for the 10 most-referenced files
- **inventedPaths** — path-shaped tokens appearing nowhere in the transcript
- empty/error count, completion tokens, wall-clock, label coverage, leaked `<think>`

### Dry run on a real qwen3.8 session

```
session       51c25020-…jsonl   (qwen38-27b-mtp-ud-q3kxl-no-mmproj)
messages      1540 total -> 88 in window     window ~39,154 tokens
split         summarize=88   retainedVerbatim=0
prompt chars  24,344
groundTruth   written=12  topReferenced=10
arm A system  788 chars    arm B system  161 chars
```

Two review findings reproduce on real data before any model is called:

- `retainedVerbatim=0` — the zero-tail cliff, on a genuine 40k qwen3.8 window.
- 88 messages (~39k tokens ≈ 121k chars) reduced to a 24,344-char prompt: the
  `SUMMARY_SOURCE_MAX_CHARS` cap silently drops ~80% of the source.

Neither is addressed by this plan — both are in Out of scope, and the harness
can now measure a fix for them as a third arm.

### Caveats

- Arm A uses `injectSystemPrompt`'s hardcoded fallback (788 chars). The live
  extension renders the `execute` template plus FORGE.md, which is larger — so
  the persona effect measured here **understates** the real one.
- `llamacpp-qwen3` sets `sampling.max_tokens: 16384`, so the empty-summary
  failure does **not** reproduce on qwen3.8. That defect belongs to
  `llamacpp-gemma4`, which sets no `max_tokens` and falls back to 4096. Test
  efso to see it.
- `llamacpp-qwen3` configures no seed; the harness passes an explicit one per
  run index so both arms see identical sampling.


---

## Measured results (2026-08-22, qwen3.8-27B UD-Q3_K_XL, 3 runs/cell)

`npm run ab:compaction -- --densest --runs 3`, 40k window, 88 messages, 12
ground-truth written files. Full 2x2 because the first A/B moved two variables
at once and could attribute nothing.

**writtenFileRecall** (of the 12 files actually modified, how many the summary names):

| system prompt | thinking ON | thinking OFF |
|---|---|---|
| agent persona (current) | **A: 0.81** — 97s, 3561 out, 0.3 invented | **D: 0.39** — 8.9s, 249 out |
| minimal summarizer | **C: 1.00** — 104s, 3823 out, 0.0 invented | **B: 0.61** — 12.8s, 505 out |

Effects are consistent and separable:

- **Thinking is worth ~0.40 recall** (D→A +0.42, B→C +0.39). It dominates.
- **The persona costs ~0.20 recall** (A→C +0.19, D→B +0.22).
- **C is the only cell with no variance**: 12/12 on all three runs. A and B are
  bimodal — 5/12 or 12/12 depending on the draw.
- C also invents nothing (A averaged 0.3 fabricated paths per run).
- C costs the same as A (104s vs 97s), so the persona fix is free.

### Decisions

1. **Minimal system prompt — CONFIRMED, ship it.** +0.19 recall, −0.3 invented
   paths, zero cost.
2. **`disableThinking` — REFUTED, do NOT implement.** The reasoning in the
   Design section ("summarization is compression, not reasoning") is wrong on
   this model: turning thinking off costs 0.39-0.42 recall. Drop the option.
3. **`max_tokens = reserve + 3072` — validated.** The worst thinking run emitted
   4060 tokens against a 5120 ceiling; 26% headroom. Keep the formula.
4. `conv.active_model` and `alwaysStripThinking` stand (no thinking leaked in 12
   runs, but the guard is free).

### New finding: the persona makes the model emit a TOOL CALL as the summary

D runs 2 and 3 returned 150 and 117 characters. In full:

```
{ "tool": "read_file", "arguments": { "path": "…/UPGRADES_PLAN.md" } }
```

The persona's JSON-fallback instruction ("emit exactly one fenced JSON block
with { \"tool\": ... }") beat the summarization request. That string would have
been stored as `conv.compaction.summary` and become the model's working context
for the rest of the conversation. Thinking partially masks this — arm A never
did it — so the danger is a config where the persona survives and thinking is
weak or off.

**Therefore an additional change, not in the original plan:** `runCompaction`
must validate before storing. Reject a summary that parses as JSON, matches a
tool-call shape, or falls under a plausible floor (~200 chars), and treat it as
`'failed'` rather than persisting it. `capSummary` currently only checks for the
empty string, which is why a 117-char tool call sailed through.

### Not reproduced

The empty-summary failure (defect 2) did not occur on qwen3.8, as predicted —
`llamacpp-qwen3` sets `max_tokens: 16384`. It remains a live risk on
`llamacpp-gemma4`, which sets none. Re-run against efso to confirm.

---

## Implementation checklist (read this first after a context reset)

Ordered, and each item is the *revised* decision — where this list disagrees
with the Design section above, this list wins.

1. **`config/templates/builtin/summarize.njk`** — the exact 161-char string in
   "Summarizer system prompt". Not a code constant. Not `src/templates/`.
2. **`PromptRunOptions`** on `runPromptToMarkdown`: `modelName`,
   `systemPromptTemplate`, `outputTokens`, `alwaysStripThinking`.
   **No `disableThinking`.** Existing callers (`/review`, `/initForge`,
   `commandHelpers`) pass nothing and must be unaffected — assert this in a test.
3. **`modelName: conv.active_model`** in `runCompaction`; falls back to
   `config.active_model`. `resolveRequestModel` handles an `@profile` suffix.
4. **`max_tokens = reasoningReserve(model) + 3072`**, applied only when
   `outputTokens` is set.
5. **`alwaysStripThinking: true`** for the summarizer path.
6. **Validate before storing** — reject tool-call-shaped / JSON / <200-char
   candidates as `'failed'`.
7. **Split `CompactionService.ts`** (361 lines, over the 350 limit) into
   `compactionPrompt.ts`; add the `docs/OWNERS.md` row.
8. **`EARLIER CHECKPOINT:`** → `EARLIER SUMMARY:` (line ~160).
9. `npm run ci` and `npm run package`.
10. **Re-run the harness** and confirm arm C's numbers still hold through the
    real code path, not just the raw HTTP one.

## Reproducing the measurement

```bash
curl -s -X POST http://127.0.0.1:8799/ensure -H "Content-Type: application/json" \
  -d '{"model":"qwen38-27b-mtp-ud-q3kxl-no-mmproj"}'      # -> baseUrl :8081

npm run ab:compaction -- --base-url http://127.0.0.1:8081 \
  --model qwen38-27b-mtp-ud-q3kxl-no-mmproj --densest --tokens 40000 --runs 3
```

Fixed inputs for comparability: session
`51c25020-201c-459f-b33f-2b77aa43c341.jsonl`, `--densest` window (88 messages,
~39,154 tokens), 12 ground-truth written files, seeds 42/43/44.

The four cells live in `scripts/compaction-ab.mjs`; `--arms A,C` runs just the
current-vs-winner pair.

## Repo state at the time of writing

- **Committed** (`26bd1de`): the RESUME_PROMPT / "conversation summary" rename.
- **UNCOMMITTED**: `scripts/compaction-ab*.mjs` (3 files), the
  `ab:compaction` entry in `package.json`, and this document. Commit them before
  or alongside the implementation — the harness is the evidence for every
  decision here.
- `webview-ui/src/App.tsx` and `test/webview/AppHeavyStream.dom.test.ts` are
  being modified by a session OTHER than this one. Do not touch or commit them.

## CORRECTION: the 80% source truncation DOES lose files

Measured on a second, independent session (weather-app `39c9bf42`, 2026-08-22,
the first live compaction on the shipped implementation):

```
written ground-truth files: 6
  survive the 24k cap: 4
  DROPPED by the cap:   2   (index.html, test/fixtures/forecast.js)
source chars 229,715 -> prompt 24,344 (11% kept)
```

Both files the summary "missed" were never in its input. Recall on what the
model was actually shown was 6/6. The single-session result below generalized
badly: at 230k source chars the cap keeps 11%, not 20%, and file identity stops
surviving. Truncation is now the dominant error term, not the summarizer.

## The earlier single-session measurement (superseded by the above)

```
written ground-truth files: 12
  survive the 24k cap: 12
  DROPPED by the cap:   0
source chars 121,142 -> prompt 24,344 (20% kept)
```

Paths recur throughout a transcript, so 35%-head + 65%-tail retention catches
them even when the middle is discarded.

**Do not over-read this.** It measures file IDENTITY only. It says nothing about
whether the decisions, constraints, error states and exact next action survived
— and those are what the discarded 80% actually contains. There is no cheap
objective proxy for them, which is why "compaction is fixed" is NOT a claim this
evidence supports.

## Honest assessment of where this leaves compaction

Arm C is unambiguously better than what ships today: +0.19 recall over current,
fabricated paths 0.3 -> 0.0, zero variance across runs, same wall-clock. Ship it.

It is not a solved problem:

- `retainedVerbatim=0` still holds — the model gets prose and no concrete
  exchange. C is a better summary of a still-impoverished input.
- 80% of the source is still discarded, proven harmless only for file names.
- 104 s per compaction, mid-task. Thinking-off was the obvious lever and is now
  ruled out; the honest fix is a smaller, better-chosen input.
- One session, one window, one model, three runs. Enough to detect a 0.4 effect,
  not enough to certify quality.

The tail-sizing and chunked-summarization items under "Out of scope" are the
bigger prize, and the harness can now A/B them as a fifth arm.

---

# Part 2: the input, not the request shape

Part 1 (above) is SHIPPED. It fixed how the summarizer is *asked*. Everything
below is about what it is *handed*, which the 2026-08-22 live compaction showed
is now the dominant error term.

## What shipped alongside Part 1 (no measurement needed)

These are code reading a data structure - no model judgement, so nothing to be
wrong about. Both are in `compactionPrompt.ts`.

- **Recorded file facts.** `collectWrittenFiles` / `recordedFilesBlock` read
  every changed file off the `tool_calls` and append them to the stored summary
  after the model returns. Derived from ALL summarized messages, not the capped
  prompt, so truncation cannot reach them. Verified on session `39c9bf42`:
  6/6 files recovered including `index.html`, which the model itself missed
  because the cap hid it.
- **Anchored first user message.** `anchorRequest` pins the opening user message
  outside `capSummarySource` under `ORIGINAL REQUEST`, where the head/tail slice
  cannot cut it.
- **Next is mandatory.** `buildSummaryPrompt` no longer says "omit empty
  sections" unqualified; Next must always be emitted, "nothing pending - the
  task is complete" when there is none. `RESUME_PROMPT` no longer assumes what
  Next says. Third instance of the resume prompt naming something absent from
  the window - see the comment above `RESUME_PROMPT`.

## Hypotheses - DO NOT IMPLEMENT BEFORE MEASURING

Recorded because they are plausible and untested, not because they are agreed.
Two confident recommendations in this document have already been refuted by the
harness (thinking-off, "truncation is harmless"). Each item below states what
would falsify it and how to run that test.

Add each as a new arm in `scripts/compaction-ab.mjs` alongside the existing
A/B/C/D cells, scored with `compaction-ab-score.mjs`. Baseline to beat: arm C
plus the shipped Part 1 changes.

### H1. Size the source cap from the model's real context window

**Claim.** `SUMMARY_SOURCE_MAX_CHARS = 24000` is a constant that predates the
summarizer having its own request shape. It is unrelated to the window the model
actually has. Derive it from `perSlotContext(model, server)` instead, minus the
system prompt, the previous summary, and `max_tokens`.

**Evidence it matters.** Session `39c9bf42`: 229,715 source chars -> 24,344
prompt chars (11% kept) on a model with a **58,000-token** window
(`llamacpp-qwen3`, `n_parallel: 1`). The summarize request used roughly 8,000
tokens of 58,000. About 45,000 tokens - ~140,000 chars - sat unused while two
changed files were being discarded. Headroom is not in dispute.

**Why it could still be wrong.**
- Long-context degradation. Recall of a specific detail can FALL as input grows
  ("lost in the middle"). 4x the text may produce a worse summary, not better.
- Wall clock. Compaction already costs ~100 s mid-task; this pushes it up
  roughly with input size. A better summary that takes 5 minutes may be worse
  in practice than a good one that takes 100 s.
- `perSlotContext` reads CONFIG, not what llama-server actually loaded. If the
  two disagree the request overflows and compaction fails outright - worse than
  a truncated summary. Needs a floor and a safety margin, and possibly
  `/props` rather than config.
- Thinking spends from the same budget. A 45k-token prompt plus a 3072-token
  reasoning budget plus 2048 of prose has to fit; the arithmetic must be
  explicit, not assumed.

**How to measure.** New arm E: arm C's request shape with the cap at 25%, 50%
and 75% of per-slot context. Same session, same window, 3 runs each.

**Decision rule.** Adopt only if writtenFileRecall improves AND invented paths
do not rise AND wall-clock stays under a ceiling the user sets. If recall is
flat, keep 24k - the recorded-files block already covers file identity, and the
remaining value is decisions and constraints, which the scorer cannot see.
Judge those by reading, and say so.

### H3. Drop cheap material before expensive material

**Claim.** `capSummarySource` slices one concatenated string: 35% head, 65%
tail, blind to what it cuts. A 30-word user instruction is exactly as likely to
be dropped as a 2,000-char file dump. Budget by role instead - user messages
first, then assistant text and tool-call metadata, then tool results - and drop
from the bottom until it fits.

**Evidence it matters.** Session `39c9bf42`: 70 of 145 rows were tool results,
each capped at `TOOL_RESULT_MAX_CHARS = 2000`. Tool output is the bulk and the
least valuable per character.

**Why it could still be wrong.**
- Tool results are where the concrete facts live - the error text, the failing
  test, the actual file content. Starving them could cost more than the space
  buys. The good 2026-08-22 summary quoted a truncated test result accurately.
- Ordering matters to a transcript. Reassembling by role risks handing the model
  a scrambled conversation, which may hurt more than dropped bulk.
- Partly subsumed by H1: with 4x the budget there may be nothing to rank.

**How to measure.** Arm F, at the CURRENT 24k budget so it is a fair test of
selection rather than of size. Then re-test on top of the winning H1 budget -
the two interact and must not be measured together first.

**Decision rule.** Adopt if it beats arm C at equal budget. If it only wins when
combined with H1, prefer H1 alone - fewer moving parts.

### H5. Token-budget the verbatim tail

**Claim.** `RETAINED_TAIL_MAX_CHARS = 4000` is a character cap on the
last-user-message tail. One large exchange blows it and the tail collapses to
**nothing**, exactly when concrete context matters most. Budget it in tokens
against the same window as H1, keeping as many trailing messages as fit.

**Evidence it matters.** Harness dry run on a 40k qwen3.8 window:
`retainedVerbatim=0`. The live 2026-08-22 compactions retained 18 and 17
messages, so this is bimodal, not uniformly broken - it fails on exactly the
large-exchange sessions that need compaction most.

**Why it could still be wrong.**
- Every token of retained tail is a token not available to the summary source.
  This trades against H1 for the same budget; they cannot both be maximised.
- A large retained tail can defeat the compaction that just ran - the original
  reason for the cap.
- The two live sessions did NOT exhibit the failure, so the fix may be
  addressing a case that is rarer than the dry run implied.

**How to measure.** Needs a harness change: the current scorer measures the
SUMMARY only, and the tail's value is that it is not summarized. Score the
summary plus the retained tail as one context blob against the same ground
truth, and pick sessions where the current code yields `retainedVerbatim=0`.

**Decision rule.** Adopt if it removes the zero-tail case without reducing
writtenFileRecall. Do not adopt on the strength of the dry run alone.

## Ordering

1. Measure H1 first - largest effect, and H3/H5 both trade against its budget.
2. H5 next, since it needs a harness change that H3 does not.
3. H3 last, and only if H1 did not already dissolve it.

Do not implement any of the three from this document alone. Each needs its arm,
its three runs, and its numbers written back here.
