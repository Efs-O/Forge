# Token bar: provider-reported usage only (impl plan)

Status: IMPLEMENTED 2026-08-22. `npm run ci` and `npm run package` green.

## Goal

The sidebar token bar, the VS Code status bar, the HalluMeter bridge, and the
auto-compaction trigger must all render **one number**, and that number must be
the one the inference server reported — never Forge's chars/token estimate.

Decisions taken (2026-08-22):

- Empty state: bar shows `0 / max` until the first response reports usage.
- Auto-compact + the manual warning key off the **same** value as the bar.
- HalluMeter bridge is written from that same value.
- The warning threshold rises from 75% to 85% (`auto_compact.at` in
  `.forge/config.yaml` is already `0.85`, so this only moves `WARN_AT`).

## The single value

```
contextUsed(conv) = (conv.last_input_tokens ?? 0) + (conv.last_output_tokens ?? 0)
```

Both halves are already provider-reported, already persisted
(`sessionTypes.ts:168-171`, `sessionPersistence.ts:64-65`), and already the
status bar's source. Their sum equals llama-server's `usage.total_tokens` for
the last request, which is exactly the slot occupancy the next request inherits.

Why the sum and not `total_tokens` directly: it needs no new schema field, and
it survives a window reload, which the current in-memory `exactTokens` map does
not.

Why not `prompt_tokens` alone (what the status bar text shows today): it
under-reports by the whole last completion, which becomes prompt on the next
round. For a thinking model that is thousands of tokens of silent under-report
feeding the compaction trigger.

`max` is unchanged: `perSlotContext(model, server)` — `num_ctx / n_parallel`.

## New owner

`contextUsed` lands in `src/util/contextBudget.ts` as
`reportedContextTokens(conv)`, next to `perSlotContext`. `docs/OWNERS.md` gets
the row. Every consumer below calls it; nobody re-derives it.

## Changes

### 1. `src/util/contextBudget.ts`

- Add `reportedContextTokens(conv)` (above).
- **Keep** `estimateTokens`, `estimateToolTokens`, `CHARS_PER_TOKEN`,
  `SYSTEM_AND_TEMPLATE_OVERHEAD`, `computeContextBudget`. They are NOT display
  code: `ModelTurn.ts:269` uses `computeContextBudget().outputRoom` to size
  `max_tokens` for a request that has not been sent yet, and truncation
  recovery depends on it (`TOOL_CALL_TRUNCATION_PLAN.md`). Deleting them breaks
  the output budget.
- Retitle the file docstring so the split is explicit: estimator = *predicting
  the next request*; `reportedContextTokens` = *measuring the last one*.

### 2. `src/sidebar/ContextBudgetPublisher.ts`

- Delete the `exactTokens` map, `publishExact()`, and `forget()`.
- `publish()` stops calling `computeContextBudget` and the `ToolBudget` /
  `resolveToolPermissions` / `applyCompactionWindow` machinery that only fed
  it. `used = reportedContextTokens(conv)`; `max = perSlotContext(...)`.
  This removes the `toolRegistry` dep from `ContextBudgetDeps`.
- `onTurnContextChanged(convId, promptChanged)` loses its `promptChanged`
  parameter — there is no estimate to invalidate any more. Keep the 500 ms
  leading+trailing throttle: `onUsage` fires once per tool round, so a long
  agentic turn still ticks often.
- `writeForgeBridge` is already fed from `used`; with the above it now carries
  provider-reported tokens. No change beyond the value it receives.
- `WARN_AT`: `0.75` → `0.85`.
- `evaluateThresholds` is unchanged in shape and still only runs from the
  post-turn `publish(conv, true)`.

### 3. `src/sidebar/ModelTurn.ts`

- Drop the `onExactContextTokens` call and the `provider !== 'llama.cpp'`
  guard around it. `onUsage` alone now carries everything.
- `includeUsage: model.provider !== 'ollama'` becomes `includeUsage: true`,
  paired with step 5.

### 4. `src/sidebar/AgentLoop.ts` / `turnServices.ts` / `SidebarProvider.ts`

- Remove the `onExactContextTokens` wiring (`AgentLoop.ts:244`,
  `ModelTurn.ts` ctx type, `turnServices.ts`).
- `onUsage` (`AgentLoop.ts:245-251`) is unchanged — it stays the sole writer of
  the four counters — but now also triggers the bar tick.
- `getActiveSessionMetrics()` gains `contextTokens: reportedContextTokens(conv)`
  in place of `last_input_tokens`, so the status bar's `ctx` and the sidebar bar
  read identically. `inputTokens` / `outputTokens` / `currentOutputTokens` /
  `requestCount` are untouched.

### 5. `src/llm/OllamaNativeClient.ts` — recommended, strike if unwanted

Without this, Ollama models show `0 / max` forever and never auto-compact,
which is a regression rather than a design.

- Extend `OllamaStreamChunk` with `prompt_eval_count?: number` and
  `eval_count?: number` (Ollama emits both on the `done: true` frame).
- On the `done` frame (and the trailing-buffer twin at line ~298), call
  `handlers.onUsage?.({ prompt_tokens, completion_tokens, total_tokens })`
  when both counts are finite. Same validation posture as
  `OpenAIClient.ts:281-289`.

### 6. `src/vscode/SessionTimeStatusBar.ts`

- Tooltip line `Current request context:` now reads prompt+completion; reword to
  `Context in use (last request):`. Add the prompt/completion split underneath
  so nothing is lost: `Last request: N prompt + M completion`.
- `formatTokenCount` unchanged.

### 7. `webview-ui/src/components/Header.tsx`

- `showBudget` stays `tokenMax > 0` — a model with no configured window still
  hides the bar. `0 / max` is the pre-first-response state, which falls out of
  `tokenUsed` starting at 0.
- `formatTokens` gains the M/B branches so it matches
  `SessionTimeStatusBar.formatTokenCount` (today `1048576` renders `1048.6k`).
  Better: export one formatter and import it in both. Owner:
  `src/util/formatTokens.ts` (new, ~15 LOC), row added to `docs/OWNERS.md`.

## Files touched

| File | Change |
|---|---|
| `src/util/contextBudget.ts` | + `reportedContextTokens`, docstring split |
| `src/util/formatTokens.ts` | new, shared `formatTokens` |
| `src/sidebar/ContextBudgetPublisher.ts` | strip estimate path, `WARN_AT` 0.85 |
| `src/sidebar/ModelTurn.ts` | drop `onExactContextTokens`, `includeUsage: true` |
| `src/sidebar/AgentLoop.ts` | drop `onExactContextTokens` wiring |
| `src/sidebar/turnServices.ts` | drop `onExactContextTokens` from the type |
| `src/sidebar/SidebarProvider.ts` | `contextTokens` from `reportedContextTokens` |
| `src/llm/OllamaNativeClient.ts` | emit `onUsage` from the `done` frame |
| `src/vscode/SessionTimeStatusBar.ts` | tooltip wording + split line |
| `webview-ui/src/components/Header.tsx` | shared formatter |
| `docs/OWNERS.md` | two new rows |

All stay under the 350 LOC limit; `ContextBudgetPublisher.ts` drops from 250 to
roughly 170.

## Test plan

- `test/unit/ContextBudgetToolFilter.test.ts` — asserts the tool-filtered
  *estimate* reaches the bar. That behaviour is being removed; the test is
  rewritten to assert the estimate reaches `getOutputRoom` instead, which is
  where tool filtering still matters.
- New: `reportedContextTokens` sums the two counters, treats missing as 0.
- New: `publish()` posts `{used: 0, max: N}` for a conversation with no usage yet.
- New: `evaluateThresholds` fires auto-compact at exactly `at`, and the warning
  at 0.85 not 0.75.
- New: Ollama `done` frame with `prompt_eval_count`/`eval_count` reaches
  `onUsage`; a frame missing them does not.
- `test/unit/SessionTimeStatusBar.test.ts` — update for the new tooltip lines.
- `npm run ci` and `npm run package`.

## Manual verification

1. llama.cpp model, fresh tab: bar reads `0 / <per-slot>`; after one turn it
   matches the status bar `ctx` exactly.
2. `~/.forge/hallumeter-bridge.json` `used_tokens` equals both displays.
3. Ollama model: same, non-zero after the first turn.
4. Drive a conversation past 85% with `auto_compact.enabled: false` and confirm
   the warning fires once, at 85%.

## Out of scope

- Changing `auto_compact.at` (already 0.85 in `.forge/config.yaml`).
- The output-room / truncation-recovery estimate — untouched by design.
- Cloud providers that omit `usage`: they will read `0 / max` and never
  auto-compact. Follow-on if it bites.
