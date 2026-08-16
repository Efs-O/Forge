# Tool-Call Truncation — Implementation Plan

**Status:** implemented; first live test failed, corrected in 0.12.42
**Verified against:** `02b6888` (Sidebar transcript cleanup)
**Owner:** unassigned

## Live test, 0.12.41 — detection passed, recovery failed

Detection behaved exactly as designed: no red JSON dump, correct `output cut off
after 10509 bytes — retrying in chunks` status, correct classification, correct
give-up message. But the model re-sent the identical call and cut at the
identical 10509 bytes three times running.

Two probes against the live server explain why:

| probe | thinking | reasoning emitted | args produced | outcome |
|-------|----------|-------------------|---------------|---------|
| 1 | off | — | 24,924 chars (8,980 tok) | fine |
| 2 | on | 12,817 chars (~4k tok) | 9,924 chars | fine, half the budget spent thinking |

There is no server-side cap. **Thinking and the tool call share one output
budget**, so a retry that re-thinks starts with LESS room than the attempt that
just failed — the same wall, the same byte count, every time. Three corrections
in 0.12.42:

1. **Recovery rounds send `enable_thinking: false`.** Frees ~4k tokens for the
   write, which is more than the shortfall was.
2. **`max_tokens` no longer double-counts the reasoning reserve.** The budget now
   exposes `outputRoom` (everything the model may emit — what `max_tokens` must
   be) separately from `headroom` (what survives the reserve). Capping at the
   reserve-adjusted figure and then letting the model think shrank the answer twice.
3. **The guidance carries a hard character ceiling** for the next call and states
   that it overrides the earlier "write the whole file" instruction. Generic
   chunking advice lost to the user's own explicit instruction.

## Deviations from the plan as written

Three choices differ from the plan above; the checkboxes are ticked against what
was actually built.

1. **`ToolCallTruncatedError` lives in `src/llm/`, not `src/agent/`.** Both the
   stream client and the agent loop raise it, and `llm/` must not import from
   `agent/`.
2. **The under-headroom round is refused only after a truncation has already
   happened this turn.** Refusing outright at <4k headroom would kill legitimate
   short replies that fit fine; after a cut-off call, a margin that thin means
   the retry cannot fit either.
3. **`applyOutputCap` only ever lowers `max_tokens`.** A deliberately small
   setting is left alone, so no existing config generates less than it does today.

## Follow-up not caused by this work

`test/unit/CliAgentSession.test.ts` — "keeps the observed session id when a turn
times out" — spawns a real fixture process against a 400 ms timeout. The four
test files added here put enough extra parallel load on the runner to tip it: it
passes on `vitest run --no-file-parallelism` and fails intermittently on the
default parallel run. The budget, not the behaviour, is the fragile part. Left
untouched deliberately.

---

## The defect

A long agent turn dies with an opaque red error in the sidebar:

```
HTTP 500: {"error":{"code":500,"message":"Failed to parse tool call arguments as JSON:
[json.exception.parse_error.101] parse error at line 1, column 10509: syntax error while
parsing value - invalid string: missing closing quote; last read: '\"\\\"use strict\\\";\\n\\n/* ...
```

The JSON is not malformed — it is **truncated**. Generation stopped mid-string because
the model ran out of room, and llama-server (`--jinja`, tools enabled) then ran its chat
parser over the partial output, threw, and returned HTTP 500 instead of a clean
`finish_reason: "length"`.

### Reproduction case

Forge session `fa97786a-32db-4fe2-8bde-b94af7534f8f` (2026-08-16), model
`qwen38-27b-mtp-q3km` — single slot, `--ctx-size 49152`, `--reasoning-budget 8192`.
The task was splitting a 1069-line `index.html` into three JS files. The `write_file`
calls, in order:

| event | file | serialized args |
|-------|------|-----------------|
| 23 | `REFACTOR_PLAN.md` | 5,229 chars |
| 37 | `js/api.js` | 8,110 chars |
| 39 | `js/bg.js` | 15,866 chars — succeeded |
| 41 | `js/ui.js` | `{}` — truncated at column 10509 |

bg.js emitted 15.8k chars successfully in the immediately preceding call, so no fixed
output cap was binding. What changed between event 39 and event 41 is only that the
prompt grew by bg.js's own 15.8k-char call. Headroom shrank until the next large write
could not finish. **Every successful large write makes the next one more likely to fail.**

What reached the dispatcher at event 41:

```json
{"role":"assistant","content":null,
 "tool_calls":[{"name":"write_file","input":{}}]}
```

### Why the existing recovery makes it worse

1. `isNativeToolJsonParseError` — `src/agent/ToolCallingLoop.ts:56-60` — matches the
   substring `Failed to parse tool call arguments as JSON` and concludes *this model
   cannot do native tool calls*.
2. It retries with tools stripped and the prompt-based fallback format
   (`src/agent/ToolCallingLoop.ts:158-172`) — **re-sending the same oversized
   conversation and asking for the same oversized output.** It truncates again, now in
   the text channel.
3. `src/sidebar/ToolDispatch.ts:121-134` reports `Error: malformed tool arguments
   (invalid JSON)` and calls `failureTracker.record()`.
4. Three of those and `ToolFailureTracker.shouldStrip()` (`src/tools/StripTools.ts:20`,
   `THRESHOLD = 3`) disables tool calling for the rest of the chat — punishing the model
   for an environment limit.
5. The tool result the model receives says only "malformed". It has no way to learn it
   was cut off, so it retries the identical write.

Separately: `src/llm/OpenAIClient.ts:125-126` skips any SSE frame with no `choices`, so
when llama-server delivers this as a mid-stream `data:` error frame rather than an HTTP
status, the turn ends in **silence** with no message at all.

---

## Design

Five parts. Parts 1, 2 and 5 are the bug fix. Part 3 makes part 2's advice actionable.
Part 4 is prevention and is the only one that touches config plumbing.

Parts 1+2+5 are independently shippable and are the recommended first slice.

### Part 1 — Classify truncation as truncation

Replace the substring test in `ToolCallingLoop.ts` with a typed `ToolCallTruncatedError`
raised when **either**:

- **(a)** the server parse error arrives *and* the accumulated tool arguments fail
  `JSON.parse` — distinguishing a genuinely malformed call from a cut-off one; or
- **(b)** `finish_reason === 'length'` with a non-empty `toolAccum`.

Case (b) is currently dispatched blind: `OpenAIClient.ts:158-164` flushes accumulated
tool calls on *any* terminal finish reason, `length` included. That is how event 41's
empty `{}` reached `ToolDispatch`.

Keep the existing native→fallback path for genuine template incompatibility, which is
what it was built for. Only truncation is rerouted.

- [x] Add `ToolCallTruncatedError` (new file `src/agent/ToolCallTruncatedError.ts`, or
      alongside `ToolLoopDetectedError` in `src/agent/ToolLoopGuard.ts` — pick one and
      note it here)
- [x] Carry `finishReason` and the partial arguments string on the error so part 2 can
      report byte counts
- [x] `OpenAIClient.ts`: on `finish_reason === 'length'` with pending `toolAccum`,
      surface truncation rather than flushing a partial call
- [x] `ToolCallingLoop.ts`: split `isNativeToolJsonParseError` into
      `isNativeToolJsonParseError` (unchanged semantics) and `isToolCallTruncation`,
      testing the accumulated args for parseability
- [x] Unit tests in `test/unit/` — a truncated-args stream must not dispatch, and a
      genuinely malformed one must still take the fallback path

### Part 2 — Recover by shrinking the ask, not downgrading the model

On `ToolCallTruncatedError`: **do not** strip native tools, **do not**
`failureTracker.record()`. Instead push a tool result the model can act on and `continue`
the round:

```
Your write_file call was cut off after N bytes — nothing was written.
About M tokens of context remain in this turn.
Re-issue it as write_file for the first <=6 KB, then append_file for each
subsequent chunk.
```

This converts a dead turn into a self-correcting one.

- [x] Catch `ToolCallTruncatedError` in the `ToolCallingLoop` round body
- [x] Build the guidance message; include actual byte count and remaining headroom
      (headroom from part 4 — until then, omit the token figure rather than guessing)
- [x] Push it as a `role: 'tool'` result against the truncated call id, then `continue`
- [x] Cap retries: two truncation recoveries per round, then fail the turn with a clear
      message so a model that ignores the advice cannot spin
- [x] `failureTracker` must **not** advance on truncation — add a regression test that
      three truncations in a row leave tool calling enabled
- [x] `AgentLoop.ts`: add an `onTruncatedToolCall` callback next to `onNativeFallback`
      (`AgentLoop.ts:797`) so the sidebar can show "output cut off — retrying in chunks"
      instead of a red error

### Part 3 — `append_file` tool

`src/tools/builtinTools.ts` exposes `read_file`, `write_file`, `replace_selection`,
`insert_code`. There is **no way to build a file across calls**, so part 2's advice is
unfollowable today.

- [x] `makeAppendFileTool()` in `builtinTools.ts` — mirrors `makeWriteFileTool()`
      (`builtinTools.ts:63-91`): `permission: 'write'`, `mutation.paths`,
      `showDiff: true`, `fs.appendFileSync`
- [x] Creates the file when absent so a chunked write can start with either tool
- [x] Register in `src/tools/registerAllTools.ts`; confirm it lands in the `write`
      permission group and inside `ToolBudget.filterDefinitions`
- [x] State a size ceiling in **both** tools' descriptions — "content over ~6 KB should
      be split across an initial `write_file` and subsequent `append_file` calls" — so
      most of these never happen
- [x] Unit test: write + two appends reconstruct the file byte-exactly

### Part 4 — Real output budget (prevention)

The `max_tokens` Forge sends is unrelated to reality **in both directions**: `4096` by
default (`SamplingMerge.ts:63-80` — too small; would have blocked bg.js) or `98304`
where configured in `.forge/config.yaml` (larger than the whole context). Neither knows
how much room is actually left.

`2832cc3` already built most of the machinery — reuse it rather than duplicating:

- `estimateTokens(messages)` — `SidebarProvider.ts:61-75`
- tool-schema token cost — `SidebarProvider.ts:429`
- group-aware ctx resolution via `mergeGroupsIntoModel` — `SidebarProvider.ts:426-432`

- [x] Extract `estimateTokens` and the used/max computation out of `SidebarProvider` into
      a shared module (`src/util/contextBudget.ts`) — it is currently private to the
      sidebar and part 2 needs it inside the agent loop
- [x] **Divide by `n_parallel`.** `SidebarProvider.ts:432` reads
      `spawn?.num_ctx ?? num_ctx` as the ceiling, but llama-server splits `--ctx-size`
      across slots. Correct per-slot ctx is `num_ctx / (spawn.n_parallel ?? 1)`. The
      repro model runs `n_parallel: 1` so it was unaffected, but every `n_parallel: 2`
      worker entry in `.forge/config.yaml` currently over-reports its window by 2x — the
      token bar and the HalluMeter bridge are both wrong for those models today
- [x] Subtract the reasoning budget when the model sets one
      (`extra_llama_server_args: ["--reasoning-budget", "8192"]`) — it is reserved output
      that never appears in the prompt estimate
- [x] Send `max_tokens = remaining − margin` instead of the config value; log once when
      a configured `max_tokens` exceeds per-slot ctx
- [x] Refuse to open a round with under ~4k headroom: return the part 2 guidance message
      immediately rather than letting the model burn the turn discovering the wall
- [x] Prefer live numbers where available — llama-server reports `n_ctx` on `/props` and
      prompt tokens in usage; `DirectBackend.ts:280` already reads `n_past`/`n_ctx` off
      `/slots`. Fall back to the estimate when the backend is not llama.cpp

### Part 5 — Handle SSE error frames

- [x] In the `OpenAIClient` stream loop, check `chunk.error` **before**
      `chunk.choices?.[0]` (`OpenAIClient.ts:125-126`) and route it to `onError`
- [x] Also handle bare `error:` SSE lines — the `startsWith('data:')` guard at
      `OpenAIClient.ts:107` drops those too
- [x] Test: an error frame mid-stream settles the turn with a message, never in silence

---

## Regression checklist

1. Genuine template incompatibility still falls back to the prompt-based tool format.
2. `ToolFailureTracker` still strips tools after 3 *real* failures; truncation is not one.
3. `ToolLoopGuard` still fires on repeated identical calls — the part 2 retry must not
   read as a loop.
4. Checkpoint/diff plumbing treats `append_file` as a mutation (undo works).
5. Cloud providers (`openai`, `xai`, `openrouter`) are unaffected by part 4's per-slot
   math — they have no `num_ctx`.
6. Ollama path (`OllamaNativeClient`) keeps working; parts 1 and 5 touch `OpenAIClient`
   only, so decide explicitly whether Ollama needs the same treatment.

## Out of scope

- Automatic re-chunking of a truncated write by Forge itself. The model reissues; Forge
  does not reassemble partial content it never fully received.
- Changing the user's `.forge/config.yaml`. 48k on a single slot is a fine setup — the
  bug is that Forge lets the model walk into the wall and then misreads the crash.
