# Mid-Turn Compaction Plan

Status: implementing (2026-09-15)

## Problem

Auto-compaction only runs **between** turns (`ContextBudgetPublisher.evaluateThresholds`,
reached from `evaluateAfterTurn`). A long agent turn can start at 60% and reach
100% inside a single turn, so `auto_compact.at` never gets a chance to fire. What
the user sees (Telegram, 2026-09-15 15:03):

1. A tool call is cut off; the loop retries twice (`MAX_TRUNCATION_RECOVERIES`)
   in a context that cannot hold the retry either — two wasted rounds.
2. The turn throws `CONTEXT_EXHAUSTED_MESSAGE` ("Use /compact or start a new chat").
3. `turnMirrorWiring` says "Nothing further is running. Send a new instruction".
4. The post-turn exhaustion path then compacts and resumes anyway — contradicting (2) and (3).

Lowering `at` does not help: the check never runs mid-turn.

## Why it is cheap to fix

Compaction is already non-destructive and **read per round**: `ModelTurn`'s
`prepareMessages` calls `applyCompactionWindow(messages, conv.compaction)` on every
round. Setting `conv.compaction` between two rounds shrinks the very next request
with no change to `conv.messages` or the loop's array.

## Traps found in the code (the reason this needs its own mode)

- `runCompaction` refuses while `isStreaming(conv)` — true for the whole turn.
- `beginCompaction` → `TurnLifecycle.beginBackgroundWork` **deletes** the
  conversation from `streamingConvIds` on release. Called mid-turn, it would mark
  the running turn as not streaming.
- `runCompaction` posts `generationStarted` / `done` to the webview, which would
  end the turn's streaming bubble.
- `selectCompactionSplit` keeps a tail only from a user message within 4000 chars.
  Mid-turn that is almost never true, so the window becomes
  `[user summary, assistant ack]` — ending on an **assistant** message, which
  llama-server treats as a prefill. An internal user-role nudge must follow, as the
  post-turn path does with `RESUME_PROMPT`.

## Design

### 1. `runCompaction(..., { midTurn: true })` — `CompactionService.ts`
Skips exactly the three traps above: the streaming guard, `beginCompaction`, and
the `generationStarted`/`done` posts. Everything else is unchanged — both
did-it-shrink guards, the log row, `emitCompactionEvent` (so Telegram shows
"compacting…"). Trigger stays `'auto'` so remote delivery policy is untouched.

### 2. Policy — new `src/sidebar/midTurnCompaction.ts`
`compactMidTurn(conv, { exhausted })` returns `true` only when it compacted:
- gated on `auto_compact.enabled` and `auto_compact.resume !== false` (mid-turn
  compaction continues the task, which is exactly what `resume: false` opts out of);
- fires when `exhausted` OR `reportedContextTokens / perSlotContext >= at`
  (same measured number and default as the post-turn trigger — `budget.snapshot`,
  `DEFAULT_AUTO_COMPACT_AT` exported from `ContextBudgetPublisher`);
- after `'compacted'`, pushes an `internal: true` user message
  (`MID_TURN_RESUME_NUDGE`) so the window ends on a user turn.
  `invalidateExactTokenBudget` zeroes the counters, so it cannot re-fire until the
  next round reports real usage.

### 3. Loop — `ToolCallingLoop.ts`
- New option `compactMidTurn?: (req: { exhausted: boolean }) => Promise<boolean>`.
- At the top of every round, after measuring: call it with
  `exhausted = the pre-flight guards would throw || forceCompaction`. On `true`,
  re-measure. Capped at `MAX_MID_TURN_COMPACTIONS = 2` per turn (a compaction that
  does not buy room must not loop; `runCompaction`'s shrink guard is the first line).
- Truncation retries exhausted: if the hook exists and the cap is not spent, set
  `forceCompaction` and retry after compacting instead of throwing. If compaction
  does not happen, throw `CONTEXT_EXHAUSTED_MESSAGE` as today.
- The three pre-flight guards move to `contextExhaustionReason()` in
  `truncationRecovery.ts` (needed twice now; also keeps the loop under 500 LOC).
- Truncation stays out of `ToolFailureTracker` (CLAUDE.md).

### 4. Messaging — `turnMirrorWiring.ts` + `truncationRecovery.ts`
- A context-exhaustion failure with auto-compact+resume on no longer says "Nothing
  further is running"; it says Forge will compact and resume.
- `CONTEXT_EXHAUSTED_MESSAGE` no longer instructs "/compact or new chat" when it is
  only reached after compaction was tried; wording made neutral.

### 5. Wiring
`sidebarWiring` extracts the compaction deps it already builds for
`SlashCommandHandler` into one `compactionDeps` object (single owner), and
registers the compactor via `agentLoop.setMidTurnCompactor(...)` (setter, like
`setContextChangedListener`). `ModelTurnContext.compactMidTurn` passes it to the loop.

## Not doing
- Compacting while a round is streaming — only at round boundaries.
- A separate `mid_turn` config key. `auto_compact.enabled/at/resume` already
  express the intent; add one only if someone needs post-turn-only.
- Touching `src/remote/*` (another session is editing it).

## Tests
- `runCompaction` midTurn: no streaming refusal, no `beginCompaction`, no `done` post.
- Policy: disabled / resume:false / below threshold → false; exhausted → compacts;
  pushes internal nudge only on `'compacted'`.
- Loop: hook compacts at threshold and the next request is re-prepared;
  truncation retries exhausted + hook → compacts and continues; cap of 2; no hook →
  old throw.

## Smoke
Long local turn past `at` on Qwen3.8: expect "compacting…" mid-turn on Telegram,
no "turn stopped", the same turn continuing, and a `compaction` log row whose
`used_tokens` ≥ threshold.
