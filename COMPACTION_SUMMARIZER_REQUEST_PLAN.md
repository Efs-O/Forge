# Compaction summarizer: its own request shape (impl plan)

Status: proposed, awaiting go/no-go.

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
  /** Send enable_thinking:false when the model's template supports the kwarg. */
  disableThinking?: boolean;
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

### Thinking

`enable_thinking:false` is per-request and needs no reload — `--jinja` is
unconditional ([LlamaServerArgs.ts:32](src/backend/LlamaServerArgs.ts#L32)), the
efso template gates `<|think|>` on `enable_thinking is defined and
enable_thinking`, and `ToolCallingLoop` already flips it mid-turn on a live
server for truncation recovery ([ToolCallingLoop.ts:171-177](src/agent/ToolCallingLoop.ts#L171-L177)).

Gated on `canUseThinkingKwargs(model, runtimeCaps)`, the same guard `ModelTurn`
uses. `PromptRunContext` gains an optional `capabilities` member; `TurnServices`
already supplies one ([turnServices.ts:48](src/sidebar/turnServices.ts#L48)), so
the existing `runPromptToMarkdown(this.services, …)` call satisfies it with no
wiring change. Absent capabilities → kwarg omitted, `max_tokens` covers it.

### Summarizer system prompt

New export in `CompactionService.ts`, next to the prompt it pairs with:

```
You compress a software-engineering conversation into a factual summary.
Report only what the transcript states. Do not offer help, ask questions, or
call tools.
```

`injectSystemPrompt(messages, undefined, undefined, SUMMARY_SYSTEM_PROMPT, 'replace')`
— the `replace` branch ([SystemPromptInjector.ts:36-41](src/llm/SystemPromptInjector.ts#L36-L41))
skips the template engine entirely, so no FORGE.md and no workspace context.

## Changes

### `src/sidebar/PromptRun.ts`

- `runPromptToMarkdown(ctx, text, conversationId?, options?)`.
- Resolve `options.modelName ?? config.active_model`. `resolveRequestModel`
  already handles an `@profile` suffix, so a pinned profile survives.
- When `options.systemPrompt` is set, call `injectSystemPrompt` with it in
  `replace` mode and no template engine/context.
- After `mergeSampling`, override `max_tokens` when `options.outputTokens` is set.
- Add the `chat_template_kwargs.enable_thinking = false` merge when
  `options.disableThinking` and `canUseThinkingKwargs` agree. Merge into any
  existing kwargs — `normalizeRequestForModel` also writes `reasoning_effort`
  there ([RequestNormalizer.ts:27-32](src/llm/RequestNormalizer.ts#L27-L32)) and
  must not be clobbered. Apply before `normalizeRequestForModel`.
- `sanitizeText(content, options.alwaysStripThinking || shouldStripThinking(...))`.
- `PromptRunContext` gains `capabilities?: (model, baseUrl) => Promise<RuntimeModelCapabilities>`.

Estimated +35 LOC; file is 98 today, well under the limit.

### `src/sidebar/CompactionService.ts`

- Export `SUMMARY_SYSTEM_PROMPT` and `SUMMARY_OUTPUT_TOKENS = 2048` (the 5000-char
  `COMPACTION_SUMMARY_MAX_CHARS` is ~1600 tokens at 3.1 chars/token; 2048 leaves
  margin without inviting a rambling summary).
- Widen the `runPromptToMarkdown` dep signature to carry `PromptRunOptions`.
- `runCompaction` passes `{ modelName: conv.active_model, systemPrompt,
  disableThinking: true, outputTokens, alwaysStripThinking: true }`.
- Fix the leftover `EARLIER CHECKPOINT:` label at
  [line 160](src/sidebar/CompactionService.ts#L160) → `EARLIER SUMMARY:`. Missed
  when the other two sites were renamed; same noun collision with Forge's
  Keep/Undo checkpoints that sent agents hunting for a file.

**File-size blocker.** `CompactionService.ts` is **361 lines**, already over the
350 limit before this change (353 at HEAD). This plan adds ~15 more. It must be
split in the same pass — proposed seam: move `truncateForSummary`,
`formatSummaryMessage`, `capSummarySource`, `buildSummaryPrompt`,
`SUMMARY_SYSTEM_PROMPT` and their constants into a new
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
- System prompt is exactly `SUMMARY_SYSTEM_PROMPT` — no FORGE.md, no template
  context.
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
  is the check; `disableThinking` is one flag to flip back if summaries degrade.
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
