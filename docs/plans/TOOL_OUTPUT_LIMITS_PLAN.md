# Window-scaled tool output limits (2026-10-07)

## Problem

Several tool output caps are fixed numbers sized for small llama.cpp windows
(16-32K per slot). They are applied unchanged to a 200K single-slot model,
where they cost rounds and protect nothing. Measured over 122 sessions since
2026-10-01:

| Cap | Where | Value | Hit |
|---|---|---|---|
| `search_code` emitted lines | `src/tools/dirTools.ts` `OUTPUT_LINE_LIMIT` | 50 | 109 of 1,091 calls |
| `search_code` per-file snippets | `dirTools.ts` `SNIPPETS_PER_FILE_LIMIT` | 8 | (inside the above) |
| `read_tool_result` page | `src/tools/toolResultTools.ts` `MAX_TOOL_RESULT_READ_CHARS` | 6,000 chars | 73 calls in 10 sessions, 22 in one |
| `shell` / `git_read` inline output | `src/tools/shellOutput.ts` `SHELL_OUTPUT_CAP` (head 10K + tail 20K) | 30,000 chars | 227 of 4,109 calls cut |
| background exec default output | `src/tools/execHelpers.ts` `MAX_OUTPUT_CHARS` | 16,000 chars | (same population) |

Worse than the size: `search_code` cuts **silently**. The loop in its handler
`break`s at 50 lines with no note, so the model cannot tell a complete answer
from a truncated one. It either trusts a partial result or re-searches blind.

## Decision

### 1. `search_code` says what it dropped (all models)

When the line cap or the per-file snippet cap drops anything, the result ends
with one line naming it, e.g.
`[Output capped at 50 lines: 37 more matching lines in 6 more files not shown. Narrow with an include glob or a more specific query.]`
and a file whose snippets were cut by `SNIPPETS_PER_FILE_LIMIT` carries
`(+K more matches in this file)` after its last snippet. The counts come from
the matches ripgrep already returned; no second search. A result that dropped
nothing is byte-identical to today.

### 2. One owner for per-model output limits

New module `src/tools/toolOutputLimits.ts` (add its row to `docs/OWNERS.md`):

```ts
export interface ToolOutputLimits {
  searchLines: number;      // search_code OUTPUT_LINE_LIMIT
  resultPageChars: number;  // read_tool_result max page
  shellInlineChars: number; // capShellOutput cap (head = 1/3, tail = 2/3)
  execOutputChars: number;  // background exec default max_output_chars
}
export const DEFAULT_TOOL_OUTPUT_LIMITS: ToolOutputLimits; // today's values
export function toolOutputLimits(model, server, autoCompact): ToolOutputLimits;
```

Derived from configuration only, exactly like `writeChunkLimit`
(`src/tools/writeChunking.ts`): stable for a model selection, never per round.
Let `window = perSlotContext(model, server)` and `tokens(f) = window * f`,
`chars = tokens * 2.5` (`COMPACTION_CHARS_PER_TOKEN`):

| Limit | Floor (today) | Formula | Ceiling | 200K Strata |
|---|---|---|---|---|
| `searchLines` | 50 | `window / 1000` | 200 | 200 |
| `resultPageChars` | 6,000 | `chars(tokens(0.04))` | 24,000 | 20,000 |
| `shellInlineChars` | 30,000 | `chars(tokens(0.10))` | 60,000 | 50,000 |
| `execOutputChars` | 16,000 | `chars(tokens(0.06))` | 32,000 | 30,000 |

Unknown window (`perSlotContext` = 0, cloud providers) or `auto_compact`
disabled: the defaults, today's values. The ceilings keep a single tool result
from dominating even the largest window. Near the 0.85 trigger a 200K slot has
~30K tokens free; a maximal shell result (60K chars, ~24K tokens) there leaves
too little for the next answer, and the existing "next request cannot fit"
path compacts before that request — the same path a 120K-char `read_file`
already relies on. No new overflow mode.

### 3. Delivery through `ToolHandlerContext`

`ToolHandlerContext` (`src/tools/ToolRegistry.ts`) gains
`outputLimits?: ToolOutputLimits`. `ModelTurn` computes it once per turn next
to `writeLimit` and passes it the same way `isVisionModel` and `modelName`
travel. Every consumer reads `context?.outputLimits?.x ?? DEFAULT...x`, so
callers without a context (tests, benchmark host) keep today's behaviour.

Consumers: `search_code` handler (`dirTools.ts`), `read_tool_result`
(`toolResultTools.ts` — the clamp and its "clamped to N" note use the scaled
value), `capShellOutput` (`shellOutput.ts`, called from `shellTool.ts` and
`gitReadTool.ts` — takes the cap as a parameter, head/tail split 1:2), and the
background exec default (`execHelpers.ts` `parseExecOutputOptions` /
`backgroundExecutionTools.ts`).

Tool **schemas do not change**: a schema `maximum` stays the fixed ceiling
constant (e.g. `max_output_chars` maximum = 32,000), and the handler clamps a
requested value to the model's scaled limit with a note naming the clamp (as
`read_tool_result` already does) — so a small model cannot get more than
today by asking. Descriptions that quote a default say "default scales with
the model's context". This keeps the tool list
— the cached prompt prefix — identical across models and rounds. Any
description text that currently quotes 6,000 / 16,000 must be reworded so it
is not wrong on a large model.

### 4. Cleanups found on the way

- `src/benchmark/toolHost.ts` has its own `MAX_WRITE_CHARS = 6_000`: import
  `MAX_SINGLE_WRITE_CHARS` from `writeChunking.ts` instead.
- `SUMMARY_OUTPUT_TOKENS` (`src/sidebar/compactionPrompt.ts`) has no caller in
  `src/` since the percentage budgets in `compactionBudget.ts`: delete it (and
  any test that only pins it).

### 5. Edit-tool friction seen in the 2026-10-07 pagoda runs

- **`append_file` is lazy, but `write_file` sends the model to it.** Its
  description says to split large content into `write_file` + `append_file`
  chunks, yet `append_file` lives in the `files` lazy group
  (`src/tools/lazyToolGroups.ts`). Both pagoda runs called `append_file`, got
  "is in group `files` — call `load_tool_group` first", and spent a round
  loading the group. Move `append_file` into the core set; it is the documented
  second half of `write_file`. The other `files` members stay lazy.
- **`edit_file`'s result miscounts.** A multi-edit call reports
  `Replaced N occurrences in <path>` (`src/tools/editFileTool.ts`), where N is
  the number of `edits[]` entries, each of which replaced exactly one match. It
  reads as "one string replaced N times". Report
  `Applied N edits to <path>` instead (single edit: unchanged
  `Replaced in <path>`). Update any test that pins the old text.
- **A failed batch hides which edits were fine.** `edits[]` is atomic, so one
  bad `old_str` discards the rest, and the error named only the failing index.
  The wl1 run's call #11 (edit 2 of 4 missed) answered with a read plus an
  `apply_line_edits` rewrite of the whole region. The error now lists which
  other edits matched and which also missed, so the model resends one fix.
- **A mid-line slip got no location.** Call #34's single-line `old_str` had
  `6.283` where the file had `6.28`; neither the exact first-line nor the
  substring hint fires, so the model spent a `grep` round to find the line.
  `describeEditMiss` now names the line with the longest shared prefix (at least
  12 characters and a third of the line) and the character where they part.

### 6. Compaction on 0.17

Every compaction in the logs before this plan ran on 0.16.x, before the core
tool set, lazy groups and the `shell` tool. The internal compaction bench
(24,576-token window, 8,192 output, `auto_compact.at` 0.85; task: document
every export of a 17-export repo and add JSDoc) was run on 0.17.0 on
2026-10-07. It passed every grader check in 21 requests and compacted twice,
both via the "next request cannot fit" path at ~17.3K used (an 8K output
reserve makes that the effective trigger on this window; working as designed).

What it showed:

- **The summary underfills its budget and drops the facts the next step
  needs.** Both summaries were ~2,950 chars (~1,180 tokens) against a
  `summaryTargetTokens` of 3,072. Their State/Next/Files sections were accurate,
  but the Next step ("write docs/api.md with each export's signature") needed
  the signatures, and none were kept. The first three requests after
  compaction re-read all 17 source files through `shell cat` — about 31K
  prompt tokens and 3 rounds of repeated work, on a run of 21.
- **Lazy groups are dropped at compaction.** `files` was loaded before the
  first compaction, `deactivateLazyGroups` cleared it, and the summary carried
  the "reload with load_tool_group" note. This run did not need it again, but
  any run that does pays a round. Compaction already re-prefills the whole
  prompt, so keeping the loaded groups costs no extra cold prefill.
- The `edit_file` miscount (§5) leaked into the summary verbatim
  ("5 occurrences replaced").

Changes:

1. **Summary prompt: carry the working set.** In `buildSummaryPrompt`
   (`src/sidebar/compactionPrompt.ts`) add a seventh heading, `Reference`:
   the concrete data the Next step depends on, copied exactly from the
   transcript — signatures, identifiers, file paths with line numbers, command
   results — so the resumed agent does not re-read sources it already read.
   Tell the model to use the room up to the target for Reference material
   that Next actually needs — never padding, never whole files — and the
   ceiling stays the hard limit. `Reference` may be "none
   recorded" when Next needs nothing. Update `RESUME_PROMPT`/`SUMMARY_PREAMBLE`
   if they enumerate headings, and the tests that pin "six headings".
2. **Keep loaded lazy groups across compaction.** Stop calling
   `deactivateLazyGroups` from the compaction path, and drop the summary note
   (`lazyGroupSummaryNote`, delete it). `CompactionService` is today the only
   caller of `deactivateLazyGroups`; move that call to where a conversation is
   cleared or deleted (find the existing hook — `/clearChat` and conversation
   deletion), so the per-conversation map still shrinks and the export keeps a
   caller. Do not add a new hook if one exists.
3. Re-run the compaction bench after 1-2. Pass bar: grader passes, and no
   source file read before a compaction is re-read in the three requests after
   it unless that file was modified since.

## Out of scope

Per-round (used-context) sizing — changes nothing in the tool list, but makes
results unpredictable mid-turn and is not needed while compaction bounds the
worst case. `MAX_READ_FILE_CHARS` (120K) and `MAX_SEARCH_RESULT_CHARS` (60K)
already exceed what the line caps produce. MCP `max_result_chars` is already
per-server config.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| Shell spill file `~/.forge/shell-output/<conv>/<call>.log` (existing; only its threshold moves) | `capShellOutput` when output exceeds the scaled cap | `sweepShellOutput` past TTL | none — written only when a cap is exceeded | partial file; the inline text still carries head+tail, the hint names the path | file stays; swept by TTL on next activation | `SHELL_OUTPUT_TTL_MS` (24 h), unchanged |
| `ToolOutputLimits` value | computed per turn in `ModelTurn` | dropped with the turn | n/a — memory only | n/a | n/a | n/a |
| Loaded lazy groups (`activeByConversation`, in memory) | `load_tool_group` | conversation clear/delete (moved from compaction) | survives compaction by design | n/a — memory only | lost with the extension host; the model reloads on refusal, as today | none |
| Session-log `compaction` row (existing; summary text gains `Reference`) | `CompactionService` | never (session log is append-only) | n/a | partial last line; readers already skip unparseable rows | row not written; transcript intact | none |

Everything else is in-memory and config-derived; nothing new is persisted. The
CI-enforced row: a unit test that `capShellOutput` with a raised cap still
spills to the same `shellOutputRoot()` path and the sweep still removes it, so
moving the threshold cannot orphan spill files.

## Acceptance criteria

- `search_code` appends the dropped-matches note when (and only when) a cap
  dropped lines or snippets; counts are exact. Unit-tested both ways.
- `toolOutputLimits` returns `DEFAULT_TOOL_OUTPUT_LIMITS` for an unknown
  window, for `auto_compact` off, and for a 32,768-ctx / 4-slot entry; returns
  the 200K column above for the Strata shape (200,000 ctx, one slot,
  auto_compact 0.85). Unit-tested.
- Each consumer honours `context.outputLimits` and falls back to today's value
  without it. Unit-tested per consumer.
- The tool definitions this plan touches are byte-identical for a 24K and a
  200K model (a test compares every registered definition except
  `write_file`/`append_file`, whose advice already varies per model by
  `WRITE_CHUNK_LIMIT_PLAN.md`).
- `append_file` is advertised without a group load; a test pins it in the core
  set. A multi-edit `edit_file` result reads `Applied N edits to <path>`.
- `src/benchmark/toolHost.ts` imports the write constant; `SUMMARY_OUTPUT_TOKENS`
  is gone.
- The summary prompt names seven headings including `Reference` and asks for
  the data Next depends on; tests updated. Compaction no longer clears loaded
  lazy groups (unit-tested); clearing/deleting a conversation still does.
- A failed multi-edit `edit_file` names the other edits that matched; a
  mid-line `old_str` slip names the closest line and the departing character.
  Unit-tested, including a boilerplate-prefix negative.
- When the user requests and assistant replies alone overflow the summary
  prompt (a long tool-heavy turn on a small window — the 24K pagoda chat), the
  attempt is a typed `budget-refusal` naming both sizes, not `unknown`.
- `docs/OWNERS.md` has the new row; `CHANGES.md` has a bullet.
- `npm run ci` is green.
