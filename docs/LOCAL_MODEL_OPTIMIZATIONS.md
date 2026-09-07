# Local-model runtime optimizations

What Forge does, at runtime, to make a 20–30B model running on one consumer GPU
behave like a usable coding agent. None of it is configurable magic: each item
below exists because a specific failure was measured, and each names the file
that owns it so the behaviour can be checked rather than believed.

This document exists because the behaviour was invisible. An architecture review
in September 2026 proposed *building* four features that had already shipped,
because they were documented only in source comments. If you add a runtime
behaviour of this kind, add a section here.

**Scope: Forge-native agent turns only.** Delegated CLI agents (`claude`,
`codex`) run their own agent loop with their own context management, session
storage and compaction. Nothing on this page describes or controls what they do
internally; Forge sees their transcript, not their window.

---

## 1. Truncation-aware tool-call recovery

**Owners:** [`src/llm/ToolCallTruncatedError.ts`](../src/llm/ToolCallTruncatedError.ts),
[`src/agent/truncationRecovery.ts`](../src/agent/truncationRecovery.ts),
[`src/agent/ToolCallingLoop.ts`](../src/agent/ToolCallingLoop.ts).

A model can run out of output room in the middle of a tool call's JSON
arguments. llama-server (with `--jinja`) parses the call after generation stops,
the unterminated JSON throws, and the server answers **HTTP 500 "Failed to parse
tool call arguments as JSON"** — byte-for-byte the same error it returns for a
genuinely malformed call.

The two need opposite responses. A malformed call means the model cannot drive
the native tool protocol, and the right move is to fall back to the prompt
format. A truncated call means the model asked for more output than the context
had room for, and the right move is to retry smaller. Conflating them downgraded
capable models and then re-issued the same oversized request.

Forge separates them two ways: the streaming client types the error directly
when it saw the partial deltas, and otherwise the parser's own wording in the
500 body (`missing closing quote`, `unexpected end of input`) identifies a cut
payload.

What recovery actually does, precisely:

- The partial call is **not dispatched**. A truncated call did not happen, and
  recording it as attempted would be a lie.
- The retry is **not** a continuation of the cut-off arguments — the model is
  not asked to finish the JSON it started. It is asked to make the call again,
  smaller, with a hard character ceiling stated for the next attempt.
- Recovery is bounded: `MAX_TRUNCATION_RECOVERIES = 2`. There is no guarantee
  the retry succeeds.
- The ceiling is stated as overriding the user's earlier instruction. A generic
  "write it in chunks" nudge loses to the user's own words.
- Truncation is an **environment limit, not a tool-calling failure**: it does
  not advance `ToolFailureTracker`, so it never contributes to a decision that
  the model cannot use tools.

## 2. Temporary thinking suppression on retry

**Owner:** [`src/agent/ToolCallingLoop.ts`](../src/agent/ToolCallingLoop.ts).

Thinking and the answer share **one** output budget. A retry that re-thinks has
*less* room than the attempt that just failed, so a naive retry after a
truncation is systematically likelier to truncate again.

After a truncation, and only for models whose backend accepts the kwarg, Forge
sends `chat_template_kwargs.enable_thinking: false` on the retry request. This is
a **per-request** flag: no server reload, no configuration change, and the
model's normal thinking setting is restored as soon as a round completes.

## 3. Lazy tool groups

**Owner:** [`src/tools/lazyToolGroups.ts`](../src/tools/lazyToolGroups.ts), applied
per round by [`src/sidebar/ModelTurn.ts`](../src/sidebar/ModelTurn.ts). Measurements: [`docs/plans/LAZY_TOOL_GROUPS_EXPERIMENT.md`](plans/LAZY_TOOL_GROUPS_EXPERIMENT.md).

Every advertised tool schema costs prompt tokens on every turn. Rarely used
groups are replaced by a single small `load_tool_group` tool that the model calls
when it needs them; the group's real schemas then appear in the **next round** of
the same turn. The tool list is rebuilt per round, not per turn, which is what
makes that possible.

## 4. Bounded tool results

**Owner:** [`src/tools/resultCap.ts`](../src/tools/resultCap.ts).

Tool results are capped (default 24,000 characters, `max_result_chars`) before
entering the conversation, with a visible truncation marker. MCP servers have
their own per-server cap: an uncapped result from a verbose server filled the
slot's context and stalled the turn silently. `isCapTruncated` — beside the
function that writes the marker — is how the rest of the codebase asks whether a
result was cut; matching the marker text anywhere in the body instead treats any
file quoting it as truncated.

`exec_command` has its own bound in
[`src/tools/execHelpers.ts`](../src/tools/execHelpers.ts): 60,000 characters per
stream, or less when the call passes `max_output_chars`. What that function
returns is what the round carries — the excerptor in `toolResultContext` shrinks
it further only once the window is genuinely tight, so on a roomy 128k window
this bound, not the excerptor, is what keeps one build log from costing tens of
thousands of tokens.

## 5. Prompt-prefix stability

**Owner:** [`src/sidebar/turnModelBehavior.ts`](../src/sidebar/turnModelBehavior.ts).
Rationale: [`docs/plans/PROMPT_PREFIX_STABILITY_PLAN.md`](plans/PROMPT_PREFIX_STABILITY_PLAN.md).

Volatile state is kept **out of the head of the system prompt**. Rendering the
active file there changed one line per turn and measured a **12–17× prompt-eval
penalty with a KV cache hit rate of zero** — every turn re-processed the whole
prefix. Turn context is injected at the tail instead.

Project instructions (`FORGE.md` / `AGENTS.md`) are part of the stable prefix and
are assembled root-to-leaf with a single total byte budget — see
[`src/llm/forgeInstructionsChain.ts`](../src/llm/forgeInstructionsChain.ts).

## 6. Per-slot context budgets

**Owner:** [`src/util/contextBudget.ts`](../src/util/contextBudget.ts).

`--ctx-size` is the **total**; `--parallel` divides it. The window one
conversation actually gets is `num_ctx / n_parallel`, which `perSlotContext()`
owns. Reading `num_ctx` alone over-reports every multi-slot model.

Two consequences worth stating because both were once bugs: the reasoning
reserve is **not** subtracted from the `max_tokens` sent (that would shrink the
answer twice — the reserve only decides whether a large write will be tight),
and a `finish_reason: "length"` arriving with tool deltas in flight must not be
flushed as a completed call.

## 7. The compaction ledger

**Owners:** [`src/sidebar/compactionLedger.ts`](../src/sidebar/compactionLedger.ts),
[`src/sidebar/compactionRecordedState.ts`](../src/sidebar/compactionRecordedState.ts),
[`src/sidebar/compactionWindow.ts`](../src/sidebar/compactionWindow.ts).

When a conversation is compacted, the model-written summary is only half of the
replacement context. The other half is **derived by Forge from the tool calls
themselves**, so it cannot be paraphrased, forgotten or hallucinated: which files
were written, which commands ran, and what each outcome was.

What survives a compaction:

- **File changes and command outcomes**, each classified `ok`, `failed` or
  `unknown`. `unknown` is a real answer, not a soft failure — a command pasted
  into the terminal has genuinely not run, and an interrupted call genuinely has
  no outcome.
- **The user's own words**, verbatim, outside the summarized transcript.
- **The agent's last message to the user**, verbatim — including its ending,
  where the next step usually is.
- **A working-tree snapshot** (`git status`, staged and unstaged diffstat) so the
  ledger can be checked against the repository without spending a tool call.
- **A count of what was dropped.** The ledger is bounded (24 entries per kind)
  and the count of omitted entries is carried across generations, so a short
  list reads as "history omitted for space", never as "this never happened".

What can be omitted, and when a targeted recheck is right:

- Entries beyond the cap; the disclosure line says how many.
- Messages from the middle of a long window; the summarization source keeps
  whole messages from each end and states how many it dropped.
- The middle of a very long final reply, which is elided with a marker while its
  opening and ending are kept.

The resumed agent is told to continue from `Next` and **not** to redo an
operation recorded as completed merely because a compaction happened — but it is
explicitly *not* told to trust everything. Where a fact is recorded as `unknown`,
is contradicted by something later, or is needed and missing, it should verify
that one thing rather than re-establishing the whole task. Re-reading a file
before editing it is ordinary care, not repeated work.

A recorded successful command means **it exited successfully at that time**. It
does not assert that the files are still unchanged: an Undo, a manual edit or a
changed input can invalidate it.

Compaction is refused rather than committed when the resulting window would not
be smaller than the one it replaces, which is how a compact/resume loop is
prevented. The comparison is a character-count **estimate**, not a token count.

---

## Related documents

- [`docs/OWNERS.md`](OWNERS.md) — canonical owner file for every concern.
- [`docs/plans/TOOL_CALL_TRUNCATION_PLAN.md`](plans/TOOL_CALL_TRUNCATION_PLAN.md) — measurements and failure transcripts behind §1 and §6.
- [`docs/plans/COMPACTION_STATE_LEDGER_PLAN.md`](plans/COMPACTION_STATE_LEDGER_PLAN.md) — the ledger's design and its rule for adding new state fields.
- [`CLAUDE.md`](../CLAUDE.md) — the constraints these behaviours are built under.
