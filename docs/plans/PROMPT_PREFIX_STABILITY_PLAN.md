# Prompt Prefix Stability & KV-Cache Reuse

Status: **implemented** (0.13.18). Measurements below are real, taken against
llama.cpp b10430 before the change landed.

---

## 1. The problem, measured

llama-server keeps each slot's KV cache and reuses the longest common prefix
between the incoming prompt and the one that slot last held. Everything after
the first divergent token is re-evaluated from scratch.

Forge injected two pieces of **volatile** state near the **head** of the prompt:

1. `activeFile` rendered into the system prompt (`execute.njk`).
2. The task plan folded into the first user message (`withPlan`), carrying
   time-dependent age text (`updated about 2 min ago`).

Either one changing invalidates the entire conversation behind it.

Measured twice, reading `usage.prompt_tokens_details.cached_tokens` off the
OpenAI-compatible endpoint. First on gemma-4-E2B (CPU, `-ngl 0`, 4.9K-token
prompt, other GPU work running):

| turn | prompt | cached | evaluated | prompt_ms |
| --- | ---: | ---: | ---: | ---: |
| 1 - cold | 4912 | 0 | 4912 | 9177 |
| 2 - append-only | 4925 | 4912 | 13 | **538** |
| 3 - one line changed in the system prompt | 4931 | 0 | 4931 | **9163** |
| 4 - repeat of turn 2 | 4925 | 4920 | 5 | 314 |

Then on Qwen3.8-27B-UD-Q3_K_XL (GPU, `-ngl 999`, q8_0 KV, idle machine), to rule
out both CPU contention and a gemma-specific quirk:

| turn | prompt | cached | evaluated | prompt_ms |
| --- | ---: | ---: | ---: | ---: |
| 1 - cold | 4949 | 0 | 4949 | 7706 |
| 2 - append-only | 4966 | 4945 | 21 | **618** |
| 3 - one line changed in the system prompt | 4971 | 0 | 4971 | **7605** |
| 4 - repeat of turn 2 | 4966 | 4962 | 4 | 282 |

**A single changed line inside the system prompt costs a 12-17x prompt-eval
penalty and a cache hit of exactly zero.** That is the `activeFile` case. Both
model families, CPU and GPU. At 30-60K context the absolute cost scales with it.

> **Design rule:** stable facts at the prompt head, volatile state at the prompt
> tail. Historical content is append-only unless context survival requires
> rewriting it.

### 1.1 `--cache-reuse` is not available, so it is not a mitigation

llama.cpp's `--cache-reuse N` shifts KV chunks across a localized edit, which
would in principle absorb a swapped `Active file:` line. It cannot be used:

```
srv load_model: cache_reuse is not supported by this context, it will be disabled
```

b10430 emits that on **every** configuration tried - gemma-4-E2B and
Qwen3.8-27B, with `--context-shift` both on and off. Re-running the table above
with `--cache-reuse 256` reproduced turn 3 unchanged (cached=0, 8554 ms).

No config surface is exposed for it. A knob that silently does nothing is worse
than no knob, and if a later llama.cpp build enables the feature the flag can go
through `extra_llama_server_args` in the meantime.

The prompt layout change is the fix, because it works on every model and does
not depend on the server build.

---

## 2. What was already cache-friendly

Unchanged by this work:

- Core Forge system instructions are stable text.
- Workspace root is stable for a normal workspace.
- FORGE.md / AGENTS.md contents are byte-stable until the file changes.
- Conversation messages are append-oriented.
- Tool definitions come from an insertion-ordered registry.

---

## 3. Deliberate history rewrites that stay

These break the prefix on purpose and are documented exceptions, not bugs:

- **`supersedeStaleReads`** — replaces a superseded `read_file` result with a
  short marker. Removes a competing stale copy of a file and reclaims tokens;
  worth the invalidation.
- **`prepareToolResultContext` excerpting** — head/tail excerpting of large
  historical tool results under context pressure. Correctness and output room
  beat a warm prefix at the ceiling.
- **Compaction** — intentionally changes the window. A full cache reset is
  expected.
- **Scoped project instructions** — `forgeLoader.instructionsFor(activeFile)`
  is activeFile-derived and renders *above* the old `Active file:` line. In a
  workspace with nested repos, switching between subprojects still swaps the
  system prompt. This is semantically load-bearing and stays; see §6.

---

## 4. Target architecture

**Layer A — stable prefix.** System message: persona, tool-use rules, workspace
root, repository instructions.

**Layer B — append-only conversation.** user / assistant / tool, never
retroactively rewritten except for §3.

**Layer C — volatile turn context.** Active file, task plan. Rebuilt from live
state every round, folded into the **latest** user message.

```
SYSTEM     stable persona + workspace + repo instructions
USER       historical request
ASSISTANT  historical response
TOOL       historical result
...
LATEST USER
  [Forge turn context]
  Active file: src/foo.ts
  Task plan:
  - [x] done: inspect BackendPool
  - [>] in progress: fix lease release
  [/Forge turn context]
  actual user request
```

### 4.1 Why "latest user message" and not a standalone tail message

`withPlan`'s original head-placement was deliberate: a `user` message inserted
between an assistant's `tool_calls` and the continuation is exactly the shape
strict chat templates (gemma among them) reject, and after a compaction the
first non-system message is the summary preamble, so inserting beside it
produced two consecutive user turns on every compacted conversation.

Tail placement does not escape that. The injector therefore **folds into the
last non-internal user message** rather than appending a new one. On tool round
8 that message is the turn's opening request — still deep in the prompt, but
everything before it survives, which is the whole win. A standalone
`internal: true` user message is used only when there is nothing to fold into.

**Consequence, accepted:** an `update_plan` mid-turn invalidates that turn's own
tool rounds. It no longer invalidates the conversation.

---

## 5. Implementation

### Phase 1 — observability (no LCP differ needed)

b10430 reports cache reuse directly on the OpenAI-compatible endpoint:
`usage.prompt_tokens_details.cached_tokens`, and `timings.cache_n` on the
native one. Forge already parses `usage`.

`src/llm/promptCacheStats.ts` extracts it; `ModelTurn` logs one debug line per
request:

```
[cache] prompt=24610 cached=24102 (97.9%) evaluated=508
```

No full prompts are logged.

### Phase 2 — remove `activeFile` from the system prefix

- Drop `{% if activeFile %}Active file: {{ activeFile }}{% endif %}` from
  `config/templates/builtin/execute.njk`.
- `buildTemplateContext` stops setting `ctx['activeFile']`. It keeps taking the
  parameter, because `instructionsFor(activeFile)` still needs it (§3).

### Phase 3 — deterministic plan rendering

`renderPlan(items)` drops `describeAge`. `updatedAt` stays on
`ConversationPlan` for the webview and for debugging, but is never serialized
into model-facing text.

Acceptance: `renderPlan(items)` at t1 and t2 are byte-identical.

### Phase 4 — unified turn-context injector

`src/sidebar/turnContext.ts` owns Layer C. `injectTurnContext(messages, { activeFile, plan })`
replaces `withPlan` at the `prepareMessages` choke point, after
`injectSystemPrompt` and before `supersedeStaleReads`.

`withPlan` is deleted. The stored `conv.messages` transcript is never touched —
only the model-facing copy.

### Phase 5 — regression suite

`test/unit/promptPrefixStability.test.ts` asserts, on the model-facing copy:

- **A** normal turn extension — every earlier message byte-identical.
- **B** active file change — system message and all history unchanged;
  divergence confined to the latest user message.
- **C** plan unchanged, clock advanced — prompt byte-identical.
- **D** plan changed — divergence begins at the latest user message, not the
  first.
- **E** FORGE.md change — system prefix changes (legitimate).
- **F/G/H** superseded reads, excerpting, compaction — divergence allowed and
  documented.

Plus: strict alternation preserved, multimodal content parts preserved, stored
transcript untouched, empty context adds nothing.

---

## 6. Acceptance criteria

- [x] Switching active files does not alter the stable system prefix — **for a
      single instruction scope.** Nested-repo workspaces still re-render scoped
      project instructions; documented in §3, not fixed.
- [x] The same plan produces identical model-facing text regardless of elapsed
      time.
- [x] Updating the plan does not rewrite the first user message.
- [x] Volatile editor/task state is injected only at the latest user message.
- [x] Stored conversation history remains untouched.
- [x] Strict user/assistant alternation remains valid (gemma-family templates).
- [x] Live llama.cpp A/B at 30K-50K on GPU. **Measured at a 31.2K prompt on
      b10621 / Qwen3.8-27B / RTX 5060 Ti: the old shape re-evaluated 31207
      tokens in 40.8 s at `cached_tokens: 0`; the new shape re-evaluated 32
      tokens in 0.40 s. 975x fewer tokens, 102x less prompt time.** The 4.9K
      measurement in §1 understated it by 8x — the penalty scales with
      conversation length. Full tables in
      `docs/plans/SLOT_AFFINITY_AND_CHECKPOINTS_PLAN.md` §8.

---

## 7. Remaining work

- ~~GPU A/B at representative context sizes~~ — done, §6.
- ~~Re-test `--cache-reuse` on a newer llama.cpp build~~ — done. Still disabled
  on b10621 for both SWA and hybrid/recurrent architectures, because it needs
  `can_shift`. Nothing to configure; see
  `SLOT_AFFINITY_AND_CHECKPOINTS_PLAN.md` §4.
- Measure the `supersedeStaleReads` tradeoff — it is a deliberate invalidation,
  but nobody has priced it.
- **`--checkpoint-min-step` is the follow-on.** Prefix stability keeps the
  common prefix long; checkpoint spacing decides how much of it llama.cpp can
  actually rewind to. At the default 8192 the first edit at a new position still
  costs ~7.3K tokens even when only the last message changed. See
  `SLOT_AFFINITY_AND_CHECKPOINTS_PLAN.md`.
