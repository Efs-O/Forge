# Compaction, memory lifecycle, and ripgrep recovery plan

**Status: IMPLEMENTED, PENDING LIVE 200K REPLAY (2026-10-04).** The three workstreams are implemented in 0.16.81. The live `.forge/config.yaml` sets Strata `num_ctx: 200000` and `auto_compact.at: 0.85`. Focused tests cover the percentage policy, source selection, memory lifecycle, and command resolution. A real near-170K Strata compaction and installed-VSIX command smoke still need a live agent session; the replacement ceiling remains an estimate until provider usage confirms it. Evidence and prior measurements are in `docs/reports/COMPACTION_HANDOFF_COMPARISON_2026-10-03.md`.

## Goal and boundaries

At a long-task compaction, Forge must carry enough verified task state for the same agent to continue without rediscovering completed evidence. Task-specific memories must be removable when they are no longer useful. A local agent that calls bare `rg` through `exec_command` must reach Forge's existing bundled ripgrep, while `search_code` remains available.

Preserve the full visible transcript and existing compaction schema compatibility. Keep tool arguments structured JSON. Do not add cloud calls, telemetry, a second search implementation, or a blanket memory-clear operation. Use the existing owners named below and split only when the file-size lint boundary or ownership warrants it.

## Baseline and selected budgets

The failed October 3 audit compacted at message index 309 into a 3,018-character model summary. The current fixed limits are a 24,000-character summarizer transcript excerpt, 3,000 characters per ordinary message, 2,000 per tool result, a 600-word instruction, an 8,000-character summary cap, a 3,072-token output target, and a 4,000-costed-character recent tail. Host-preserved facts and memory keys are separate from the model summary. The current auto trigger is 85% of Strata's 200,000-token context, about 170,000 tokens of measured use.

Let `P` be the last provider-reported context tokens immediately before compaction, not the maximum window. That report may be unavailable or stale before the first request; estimate the active window in that case and mark the budget as estimated. Proposed policy, subject to live validation:

| Component | Rule | At `P = 170,000` |
| --- | ---: | ---: |
| Summarizer transcript source | Up to 80% of `P`, reduced further to fit the complete request and generation reserve | Up to 136,000 tokens |
| Visible summary target | 3.5–4% of `P` | 5,950–6,800 tokens |
| Visible summary ceiling | 5% of `P` | 8,500 tokens |
| Verbatim protocol tail ceiling | 1.5% of `P` | 2,550 tokens |
| Host-preserved user requests, actions, repo state, memory keys, and other facts | Budget up to 3.5% of `P` | Up to 5,950 tokens |
| Whole model-facing replacement target | About 7% of `P` | About 11,900 tokens |
| Whole replacement ceiling | 10% of `P`, including all components | 17,000 tokens |

The 10% ceiling is a capacity limit, not a request to generate 17,000 tokens every time. It is exact only when the active backend can tokenize the proposed replacement; otherwise use a conservative estimate and verify against the next provider usage report. Remove the 600-word instruction. Preserve essential task findings and evidence before trimming routine tool output. The model may write less than the target when the task is simple. Define a small-window exception for manual `/compact` so a near-zero `P` cannot create a zero or unusable summary allowance; preserve the current ability to compact a small conversation.

## Phase 1 — token-aware compaction budget and handoff

**Owners:** `src/sidebar/CompactionService.ts`, `compactionPrompt.ts`, `compactionSplit.ts`, `compactionWindow.ts`, `src/sidebar/PromptRun.ts`, and the existing context-budget helpers. A focused budget helper may be extracted; it must not become a second compaction policy owner.

1. Define the accounting contract for `P`, the full summarization request, visible summary, host facts, protocol tail, and final replacement window. Reuse provider-reported token use for `P`. Check whether the active backend offers exact preflight tokenization; otherwise use the existing calibrated estimate with explicit safety margin and report the ceiling as estimated. Never claim an exact token cap from character counts.
2. Select source messages within the 80%-of-`P` upper bound and the model's remaining request room. Keep whole messages and valid assistant-call/tool-result groups. Keep original and later user decisions outside the lossy transcript excerpt as today. Pin identified active-task evidence, findings, verification status, and unresolved questions before allocating room to routine tool output; head/tail selection alone cannot preserve findings in the middle. Define how the selector identifies these records from the existing transcript or an explicit task artifact. If required evidence is outside the selected source, refuse that compaction rather than claim it survived. Record any dropped middle span explicitly.
3. Replace the fixed 600-word and 8,000-character summary policy with the percentage target and ceiling. Account for thinking separately from visible output: `PromptRun` currently takes the maximum of the requested output budget and model `sampling.max_tokens`, so raising `SUMMARY_OUTPUT_TOKENS` alone does not enforce a visible-summary budget. Bound the complete replacement context, including already-host-preserved facts and the tail, before committing the new compaction state.
4. If required user instructions or host-recorded evidence cannot fit, leave the previous context unchanged and surface a clear refusal. Do not silently discard required state or enter a compact/resume loop. Preserve the existing failed-auto-compaction hold until a new user message.
5. Log local measurements for source tokens (or estimated tokens), summary, host facts, tail, full replacement, omitted content, and refusal reason. Do not log new private transcript text or add telemetry.

**Acceptance:** A fixture matching the failed audit's order and volume, with essential evidence placed in the dropped-middle region, preserves the full commit list, every candidate finding's evidence and verification status, unresolved work, and the correct next step through one and then two compactions; if the evidence cannot be selected within budget, compaction refuses without altering state. The replacement stays within its stated budget (exact where a tokenizer is available, otherwise conservatively estimated), shrinks the previous context, survives reload, and preserves valid tool-call protocol. Exercise a very small manual `/compact`, unavailable or stale provider usage, an over-budget host-fact block, a thinking-heavy summarizer, and a failed compaction without mutating the prior state.

## Phase 2 — task-specific memory lifecycle

**Owners:** `src/tools/memoryTools.ts`, `src/tools/ToolRegistry.ts`, `src/sidebar/ToolDispatch.ts`, `src/tools/registerAllTools.ts`, `src/tools/lazyToolGroups.ts`, `src/sidebar/CompactionService.ts`, the persisted conversation owner, `src/sidebar/compactionWindow.ts`, and `FORGE.md`.

1. Add a strict, key-only `forget` tool to the existing memory group. It removes one `forge.memory.<key>` value and the same key from `forge.memory.__keys__`. Give it the `delete` capability and normal per-call confirmation. The current registry rejects `write`/`delete` tools without file mutation metadata, while Memento has no file path to checkpoint: add an explicit, narrow workspace-state mutation classification to the registry/dispatcher instead of inventing a file path or mislabeling `forget` as `read`. Keep file mutation checkpoint behavior unchanged. Missing keys should return a clear, idempotent outcome; no bulk delete.
2. Serialize memory index mutations with `remember` so concurrent writes and forgets do not lose keys. For a new key, write the index first and then the value; for `forget`, delete the value first and then remove the index. Filter indexed keys whose values are absent, including during compaction key collection. An interrupted write can then leave a filterable stale index entry; the current value-first `remember` order can leave an undiscoverable orphan value, so do not promise recovery of legacy orphans without an explicit migration. Keep older indexed values readable.
3. A compaction record currently snapshots `memoryKeys`, and `compactionWindow.ts` renders that saved list. On successful `forget`, remove the key from any active conversation compaction snapshot and persist that change, or filter against current live keys when constructing the model request. Test the immediate next request and reload, not only a future compaction. Do not mutate the saved snapshot before the Memento deletion succeeds.
4. Add the agreed instruction to `FORGE.md`: when a task used memories, review its task-specific notes at completion; update durable facts, remove pending-only notes, and leave unrelated tasks' memories alone. Do not make automatic task completion delete every memory.

**Acceptance:** Remember/recall/list/forget work for one key, overwrite, duplicate forget, concurrent remember/forget, failed first or second persistence write, reload, and compaction after deletion. A removed key no longer appears in `list_memories` or the model-facing compaction key list. The older bug-hunt notes remain untouched unless the task that owns them explicitly cleans them.

## Phase 3 — bare `rg` through `exec_command`

**Owners:** `src/tools/RipgrepResolver.ts` for binary discovery, `src/tools/execProgramResolver.ts` for translating a bare command, and `src/tools/execTools.ts` for the VS Code app-root dependency. Keep `src/tools/dirTools.ts` as the existing `search_code`/`find_files` user of the resolver.

1. Resolve bare `rg` and `rg.exe` to the same VS Code-bundled executable that backs `search_code`. Do not modify global `PATH` or rewrite explicit executable paths. Keep command and argument arrays separate, shell-free, and subject to the existing denylist, permission gate, timeout, and output cap.
2. If the bundled executable is absent, return an actionable missing-executable error or explicitly resolve and identify a PATH executable. The current resolver returns bare `rg` when its candidates are absent, which silently defers selection to PATH; do not use that fallback implicitly for `exec_command`. Update the unavailable-program hint so it no longer says bare `rg` is always unavailable.
3. Keep `search_code`: it has scope, exclusion, and bounded-result behavior that a raw `rg` invocation does not provide. The initial change exposes an additional command path, not a replacement or duplicate search engine. Add concise tool guidance that `search_code` is ripgrep-backed and is the safe default for scoped repository searches.

**Acceptance:** On the installed Windows VSIX, `exec_command` with `rg --version` and a bounded repository search succeeds; `search_code` still produces its existing results. Unit coverage checks bare `rg`/`rg.exe`, explicit paths, missing bundled binary, non-Windows behavior, argument preservation, denylist ordering, and output caps. The failure in the audited transcript must no longer reproduce.

## Phase 4 — integration and handoff

Run focused tests for each phase, then `npm run ci` and `npm run package` after the last source, test, changelog, or plan edit, as required by `AGENTS.md`. The current workspace has unrelated concurrent edits; stage only this feature's files by name and do not touch another worker's files. One phase should yield one reviewable commit with CI green. Update `CHANGES.md` with the matching release entry if `package.json` version changes. Run `git diff --check` and inspect `git status` before handoff.

For the compaction live check, measure provider-reported pre-compaction context and the first resumed request after compaction at the 200k Strata setting, then compare the result to the synthetic failed-audit replay. The provider's post value describes the entire resumed request, including system instructions and tool schemas; report replacement-only estimates separately. Report the observed numbers and any tokenizer-estimation error. Do not mark the feature complete merely because the summary is longer or unit tests pass.

## State × lifecycle ledger

| Durable state | Creation or update | Read and use | Retry or duplicate | Crash and restart | Cleanup or deletion | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| Conversation compaction record | Commit the new summary, cut point, generation, and host blocks only after source and replacement fit checks pass | `compactionWindow.ts` constructs model input; transcript remains visible | A refused retry leaves the prior record intact; repeated compaction summarizes only the active window | Persisted optional fields load through the existing session schema; interrupted tool calls retain current repair behavior | A later compaction replaces the prior record; deleting a conversation follows existing session lifecycle | `CompactionService.ts`, session persistence, compaction window |
| Memory value `forge.memory.<key>` | `remember` writes a new value after indexing its key, or overwrites an indexed value; `forget` removes only the named value before index removal | `recall` returns the value; missing key returns the existing not-found form | Duplicate forget is idempotent; concurrent mutations are serialized | A partial new write or deletion can leave a stale index, which is filtered; legacy orphan values are not discoverable from the index | `forget` removes the value; unrelated keys remain | `memoryTools.ts` and VS Code workspace state |
| Memory key index `forge.memory.__keys__` | `remember` adds a new key before its value; `forget` removes it after value disposition | `list_memories` and compaction collect only keys with present values | Repeated updates do not duplicate keys or resurrect a forgotten value | On reload, stale index entries are hidden or repaired; failed Memento updates surface errors | Remove only the requested key; no bulk cleanup | `memoryTools.ts`, `CompactionService.ts` key snapshot |
| Compaction memory-key snapshot | Compaction captures live indexed keys; successful `forget` updates the active snapshot or the model-facing render uses live keys | `compactionWindow.ts` includes only live keys on the next request | Duplicate forget leaves it absent | Reload cannot reintroduce a forgotten key from a saved compaction record | Later compaction replaces the snapshot | Conversation persistence and compaction window |
| Live `.forge/config.yaml` | The owner already changed Strata context to 200,000 and auto threshold to 0.85 | Forge reads it on reload; managed Strata uses `{num_ctx}` on next start | Repeated reloads read the same values | Backup exists in `Documents/Forge-config-recovery` | Future config changes follow existing config lifecycle | User-owned live config; no schema change planned |

## Open implementation checks

- Strata's OpenAI-compatible path has no preflight tokenizer in this implementation. The proposed request and replacement use 2.5 characters per token, plus a 6,000-token prompt margin; the next provider usage is needed to measure the error. The 80% source allowance and latency need a live 170K replay before tuning.
- Unit tests inject failures on either Memento write. New keys are indexed before values; deletion removes values before index entries. Indexed keys without values are filtered on reads.
- `forget` reconciles all loaded conversation snapshots and persists them; loading a conversation also filters its saved keys against live values. The next model request therefore cannot resurrect a deleted key from a snapshot.
- `test/unit/CompactionPolicy.test.ts`, `CompactionService.test.ts`, `CompactionWindow.test.ts`, `MemoryTools.test.ts`, and `execProgramResolver.test.ts` cover the synthetic policy, mutation, and command paths. A live two-compaction 170K audit replay and installed Windows VSIX `rg` smoke remain unverified; do not infer their results from unit tests.
