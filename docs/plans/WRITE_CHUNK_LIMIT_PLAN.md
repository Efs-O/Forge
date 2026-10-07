# Per-model write chunk limit (2026-10-07)

## Problem

`write_file` and `append_file` tell every model to split content over
`MAX_SINGLE_WRITE_CHARS` (6000) characters. The constant was sized for the
tightest llama.cpp setups (TOOL_CALL_TRUNCATION_PLAN.md): a small per-slot
window, a reasoning reserve, late-turn headroom. It is applied to every model.

On the 2026-10-07 pagoda bench (Strata Flash-Next, 200K context, one slot) a
62 KB single-file scene took 22 of the turn's 50 rounds just to write: one
`write_file` and 11 `append_file` chunks of ~6-7 KB, plus edits at the seams.
Each extra round re-sends the whole transcript; the turn processed 3.1 M prompt
tokens. A single 15 KB write through the same Strata server succeeded the same
day. The limit protects nothing on that model and costs about half the turn.

## Decision

The limit becomes a per-model value derived from configuration only, so it is
stable for the life of a model selection and the tool list (prompt prefix)
does not change between rounds:

```
room    = perSlotContext(model) * (1 - auto_compact.at)     // worst case before compaction
room    = min(room, model.sampling.max_tokens)              // when the model caps output
answer  = room - max(reasoningReserve(model), THINKING_ALLOWANCE) - MIN_ROUND_HEADROOM_TOKENS
limit   = clamp(answer * 2 chars/token, 6000, 24000)
```

- `THINKING_ALLOWANCE` = 8000 tokens: a model with no `--reasoning-budget`
  (Strata at xhigh) still thinks before it writes; the truncation plan measured
  ~4K on Qwen3.8, doubled for slack.
- 2 chars per token is the rate truncation recovery already uses for escaped
  code; real code runs denser, so this is conservative.
- Floor 6000: no model gets less than today. Cap 24000: one call still has to
  be reviewable, and a bad write wastes at most that much output.
- Unknown window (cloud providers, `perSlotContext` = 0) or `auto_compact`
  disabled (no worst-case bound on late-turn room): 6000, today's value.

Strata: 200000 * 0.15 = 30000, capped at 32768 → 30000 − 8000 − 4000 = 18000
tokens → 36000 chars → 24000.

The truncation-recovery ceiling clamps to the model's limit instead of the
constant, so the retry instruction never exceeds what the tool description says.

Owner: `src/tools/writeChunking.ts` (the formula, the advice text, and the
substitution into the two tool descriptions). `ModelTurn.buildToolDefinitions`
applies it; `ToolCallingLoop` receives the number for recovery.

## Out of scope

Changing truncation detection or recovery mechanics; per-round (used-context)
sizing, which would change tool descriptions between rounds and cost a cold
prefill each time.

## State × lifecycle ledger

No durable state: the limit is computed from configuration on every turn and
held only in memory; nothing is written, so there is no create, delete, crash
or expiry path to cover.

## Acceptance criteria

- `writeChunkLimit` returns 24000 for the Strata shape (200000 ctx, one slot,
  max_tokens 32768, auto_compact 0.85), 6000 for an unknown window, 6000 with
  auto_compact disabled, and 6000 for a 32768-ctx / 4-slot llama.cpp entry.
  Unit-tested.
- The advertised `write_file`/`append_file` descriptions carry the model's
  limit; a test fails if the registered description stops containing the
  default advice (so the substitution cannot silently stop matching).
- Truncation guidance never states a ceiling above the model's limit.
- `npm run ci` is green.
