# Fix plan — open issues from the 2026-10-02 bug hunt

Source list: `docs/local/open-issues-2026-10-02.md` (items 1–21; 19–21 are from the Q6 arm).
Every item there has been verified against 1951a60 by Claude. This plan says in which order they
get fixed, how, and how we know each fix worked.

**Priority call: Phase 1 (issue #8, context trimming) comes first, ahead of everything else.**
It is the only defect that costs time on *every* long turn of the local model. Measured on the
Q6 eval run: ~140 s per tool round for ~70 minutes, with no way out short of a manual
`/compact`.

## Ordering

| Phase | Items | Why this order |
| --- | --- | --- |
| 0 | 1, 2, 3 (Strata's shelved fixes) | Already written and tested. They only need re-applying after the eval. |
| 1 | 8a, 8b | The largest cost by far; touches only the model-facing copy, no persisted state. |
| 2 | 9, 10, 11, 14, 15, 16, 17, 18 | Small, independent and local; each is one file plus one test. |
| 3 | 12, 13 | Change the session-log row format (durable state), so they need the ledger. |
| 4 | 4, 5, 6, 7 | Agent-bus routing. Annoying but rare, and it only affects agent-to-agent use. |
| 5 | 19, 20, 21 | Q6's findings, verified. All three are small and local, so they run like Phase 2. |

Phases 2–4 are independent of Phase 1, and can run in parallel with it on separate files.

---

## Phase 0 — re-apply Strata's fixes (items 1–3)

1. `git apply --check ~/.forge/eval/strata-2026-10-02/fixes.patch`, then apply it. Verify the four
   files against `files.sha256`. Restore the 2 tests from `hidden/`.
2. `npm run ci`.
3. Commit only when the user says so (stage by name: ProviderTurn.ts, HealthCheck.ts,
   OllamaAdapter.ts, the 4th patched file, and the 2 tests).

Item 15 (HealthCheck, probes overlapping) extends the same function. Do it in Phase 2 *on top of*
this patch, not mixed into it, so the eval's patch stays attributable.

---

## Phase 1 — context trimming that keeps the prompt prefix stable (items 8a + 8b)

### What is wrong, precisely

`prepareModelTurnMessages` (src/sidebar/prepareModelTurnMessages.ts) rebuilds the model-facing
copy from the full transcript **every round**. When the estimate exceeds
`inputBudget = perSlotContext − (reasoning_budget + MIN_ROUND_HEADROOM_TOKENS)`,
`prepareToolResultContext` (src/agent/toolResultContext.ts:84) does two things:

1. **Reasoning drop** — `dropOldestReasoning` (src/agent/preserveThinking.ts:59) strips
   `reasoning_content` oldest-first *until it just fits*. The next round adds a tool result,
   so it no longer fits, and one more turn is stripped. The first byte that differs from the
   cached prompt moves forward by one assistant turn **every round**. That lands mid-prompt:
   llama-server logs LCP similarity of 0.31–0.34, and ~90K of ~109K tokens are re-evaluated.
2. **Excerpting** — the largest results are cut first, to
   `targetChars = min(12000, len − overflowChars)`. The target depends on the current
   overflow, so the *same* result is re-cut to a different length next round. That is a
   divergence even when the set of excerpts is unchanged.

Then (**8b**) mid-turn compaction compares `reportedContextTokens` (the server's count of the
*already trimmed* prompt) with `auto_compact.at`. The trimmer pins the estimate at 90.7% of the
window. The estimator over-counts (3.1 chars/token), so the server count is about 83%, which is
under `at: 0.90` in config.yaml, and under the default 0.85 at this window size. Compaction never
fires. The turn stays in the per-round re-prefill until the user intervenes.

A *stateless* low-water mark ("trim to 70%") does **not** fix 8a. The cut is still recomputed
from scratch on a transcript that grew by one round, so it moves again. The fix needs state
that persists across rounds, and hysteresis.

### Design

**1a. `ContextTrimState`: one per conversation, in memory, monotonic.**

```ts
interface ContextTrimState {
  reasoningDropped: number;            // count of reasoning-carrying assistant turns stripped, oldest first
  excerpts: Map<string, number>;       // tool_call_id → fixed excerpt size in chars
}
```

- Owned by the conversation runtime, next to the compaction window. It is passed into
  `prepareModelTurnMessages` via `PrepareModelTurnMessagesInput`.
- It is reset when the model copy's history changes shape: compaction (manual or mid-turn), a
  model switch, `/clearChat`, a window reload (lost with memory anyway).
- It is **not** reset at turn start. `attachCurrentTaskReasoning` already drops the previous
  task's reasoning there, and a carried-over `reasoningDropped` count is clamped to the carriers
  that exist.
- **Owner:** `src/agent/toolResultContext.ts` stays the single owner of trimming policy. The new
  type and the hysteresis live there, with a row added to `docs/OWNERS.md`.

**1b. Hysteresis in `prepareToolResultContext`.**

```
apply state as-is: strip reasoning on the first `reasoningDropped` carriers,
                   excerpt every id in `excerpts` to its recorded size
if used ≤ inputBudget → return               # common case: prefix byte-identical to last round
# over budget: advance ONCE, to the low-water mark
target = LOW_WATER_FRACTION × inputBudget    # 0.70; internal constant, documented
while used > target and a carrier remains:   reasoningDropped++
while used > target and a candidate remains: excerpt the largest un-excerpted result to
                                              PREFERRED_TOOL_RESULT_CHARS (fixed, never overflow-derived);
                                              record it
if still > target: second pass, re-cut recorded excerpts to MIN_TOOL_RESULT_EXCERPT_CHARS
                   (fixed); record the new sizes
return { …, trimAdvanced: true }
```

- Excerpt sizes are taken only from the two fixed constants, so an excerpt's bytes depend only
  on its own text and size. They are deterministic and stable across rounds.
- **Cost model:** one cold prefill when the watermark advances. Then each round only appends
  (LCP ≈ 1.0) until the transcript grows by `(1 − 0.70) × inputBudget` ≈ 35K tokens. At Q6's
  ~2–4K tokens per round, that is roughly one re-prefill per 10–15 rounds instead of one per
  round.

**1c. Make the trimmer and compaction work together (8b).**

- `prepareToolResultContext` returns `trimAdvanced` and the **untrimmed** estimate `rawUsed`.
  These flow out through `prepareMessages`/`measure()` in `ToolCallingLoop`.
- `compactMidTurn` decides on `max(reported, rawUsed) / max` vs `auto_compact.at`, not on the
  trimmed count alone. `at` means "how full the conversation is", not "how full the copy we sent
  was". When the trimmer had to advance and `auto_compact.enabled`, that counts as reaching the
  threshold.
- Compacting resets `ContextTrimState`. One compaction (summary call plus a cold prefill of a
  much smaller prompt) replaces the trim loop. When `auto_compact` is disabled, 1a/1b alone
  still bound the cost.

**1d. Diagnostics** — when the watermark advances, log one line:
`[context-trim] advanced reasoning=<k> excerpts=<n> raw=<rawUsed> sent=<used> budget=<inputBudget> low=<target>`.
Without it, a drop in llama-server's `f_sim` cannot be tied to a cause after the fact (see
CLAUDE.md "the session log is the only forensic record").

### Files (expected)

- `src/agent/toolResultContext.ts`: the state type and the hysteresis. This is the policy owner.
- `src/agent/preserveThinking.ts`: `dropOldestReasoning` becomes "drop the first k carriers".
  The `fits` callback goes away.
- `src/sidebar/prepareModelTurnMessages.ts`: threads the state through, and returns `rawUsed` and
  `trimAdvanced`.
- `src/agent/ToolCallingLoop.ts`, `src/sidebar/midTurnCompaction.ts`: the compaction trigger
  reads `rawUsed` / `trimAdvanced`.
- The conversation runtime type, plus the reset points: compaction, model switch, clear.
- Check that each file stays under the 500 LOC limit. ToolCallingLoop.ts is the one at risk; if it
  is, put the trigger decision in `midTurnCompaction.ts`.

### Tests (the contract, written first)

1. **Prefix stability:** a 131K window and a transcript over budget. Simulate 20 rounds, each
   appending an assistant tool call (with reasoning) and a 3K-token result. For every round
   *k+1* that did **not** report `trimAdvanced`, `prepared[k+1].slice(0, prepared[k].length)`
   deep-equals `prepared[k]`. Assert that `trimAdvanced` fired at most 3 times in the 20 rounds.
   This test fails on HEAD.
2. **Excerpt determinism:** the same result excerpted in two rounds with different overflow gives
   byte-identical text.
3. **Monotonic state:** `reasoningDropped` and the set of `excerpts` keys never shrink between
   resets.
4. **Reset:** after a mid-turn compaction the state is empty, and the next prepare matches a
   fresh prepare.
5. **Trigger (8b):** with `auto_compact {enabled:true, at:0.90}`, a reported count of 83% and a
   raw estimate of 105%, `compactMidTurn` compacts. With `enabled:false` it does not, and test 1
   still holds.
6. **No regression:** the existing toolResultContext and preserveThinking suites stay green (with
   expectations updated only where they encoded "trim to an exact fit").

### Live check (acceptance, done by the user or Claude after install)

Q6 tensor at `--ctx-size 131072`: run a turn past the trim threshold and read the llama-server
log. Pass condition: for ≥ 9 of the next 10 requests after the watermark advances,
**re-evaluated tokens ≈ the tokens appended that round** (the `[cache] … evaluated=N` line in
the Forge log), and a per-round prompt-eval time under 10 s. `f_sim_best` is not the metric:
it drops on its own whenever a round appends a large tool result. If `auto_compact` is
enabled, the turn compacts once instead of looping. HEAD fails: f_sim 0.31–0.34, ~140 s per round.

---

**Status (2026-10-02):** implemented and uncommitted; `npm run ci` green; live on Q6, rounds
re-evaluated 357–4,023 tokens and `[auto-compact] mid-turn at 91%` fired by itself at 120K.
Still open: `reasoningDropped` carries over to the next user turn when auto-compact is off, and
ToolCallingLoop.ts sits at exactly 500 lines. The trimmer-only live check (auto-compact off,
throwaway chat) has not run yet.

---

## Phase 5 — Q6's findings (items 19–21)

- **19.** `ssrfCheck` gains a DNS step: `dns.lookup(host, {all:true})`, reject any blocked
  address (v4/v6, v4-mapped, CGNAT 100.64/10, ULA fc00::/7), then connect to the vetted address
  (an undici `Agent` with a `connect.lookup` that returns it). Run it on every redirect hop.
  Test: a stubbed resolver returning 127.0.0.1 for a public-looking name is refused, and so is a
  redirect to such a name.
- **20.** POSIX: spawn with `detached: true` and kill the group (`process.kill(-pid)`), keeping
  SIGTERM → SIGKILL. Test (POSIX only, skipped on Windows): a child that forks a sleeper leaves
  no sleeper behind.
- **21.** Stale recovery re-reads the renamed file and checks the token. On a mismatch it
  renames the file back and throws "already owned". Test: two concurrent `acquire` calls on
  a stale lease yield exactly one holder.

---

## Phase 2 — small, independent defects (items 9–11, 14–18)

Each item is one commit with its own test that fails on HEAD.

- **9 — Symlink/junction escape (Medium).** Switch every `mustBeInsideWorkspace` write path to
  `resolveRealWorkspacePath` (src/util/WorkspacePaths.ts:70): write_file, append_file,
  edit_file, apply_line_edits, delete_file, the move/rename tools, format_file, and so on. Grep
  for all callers; do not trust this list. For a path that does not exist yet, resolve the
  nearest existing parent. Test: create a junction in a temp workspace that points outside it,
  and check that each write tool refuses. Skip on platforms that cannot create the link. Also
  check `ToolDispatch`'s checkpoint path, which must snapshot the same resolved path the tool
  writes.
- **10 — Ollama recovery re-thinks (Medium).** Carry `suppressThinking` through
  `normalizeRequestForModel` as an explicit `think: false` override for Ollama. Have
  `OllamaNativeClient` prefer that override to `toOllamaThink(model)`. Test: a recovery round on
  a `think:true` Ollama model sends `"think":false`.
- **11 — Foreground exec output unbounded (Medium).** In `spawnAndWait`, keep a head+tail buffer
  capped at `MAX_EXEC_STORED_CHARS` plus a dropped-bytes count, and keep draining the pipes.
  Reuse the rolling-cap helper from `BackgroundExecutionManager` instead of writing a second one
  (single point of truth). Test: a child that writes 50 MB returns at most cap + marker, and the
  dropped count is right.
- **14 — EOF mid-arguments (Low).** On the EOF path in both clients, apply
  `argumentsAreIncomplete` and raise a stream error (not `ToolCallTruncatedError`, which would
  imply an output cap) instead of flushing. Complete calls still dispatch, as now. It must not
  advance `ToolFailureTracker`. Test: SSE that ends inside `{"path":"a`, with no `[DONE]`.
- **15 — HealthCheck overlapping probes (Low).** Allow one probe in flight at a time, with a
  per-probe `AbortSignal.timeout(2000)` combined with the caller's signal. `done` aborts any
  in-flight probe and removes the proc listeners. Builds on Phase 0.
- **16 — Trailing Ollama error frame (Low).** One `handleFrame(chunk)` shared by the line path
  and the trailing-buffer path.
- **17 — Identical Ollama calls collapse (Low).** Within a *single* frame, two identical whole
  payloads at the same index are two calls. Across frames, an identical payload stays a
  retransmission (the current behaviour, which guards the ollama#15457 duplicate-frame case).
  Test both.
- **18 — format_file save race (Low).** Record `doc.version` after `applyEdit`, and refuse to
  save if it changed.

---

## Phase 3 — session-log ids and dedup (items 12, 13) — durable state

- **12.** `SessionLogger` writes `id` on each tool call and `tool_call_id` on tool rows.
  `ArchivedSessions.readLog` uses them when present. For legacy logs without ids, pair each
  assistant call with the tool rows that follow it, in order, and give both the same generated
  id, before `persistedToRuntime` runs. That way `repairInterruptedToolCalls` only fills calls
  that really have no result.
- **13.** `readLogRows` deduplicates by replay identity, not by content. From 0.13.20, rows
  after a `cursor` row that re-cover already-written positions are the replay. Before that
  (no cursor), keep the content hash but only *within a block that repeats as a run*: a replay
  re-appends the whole conversation, so a duplicate is a duplicate run, not a single equal row.
  Test: "continue" typed twice survives; a fully replayed log is still collapsed.
- Update CLAUDE.md's audit recipe ("hash each row minus `timestamp_ms`") to note that it
  collapses legitimately repeated rows, and to prefer `cursor`.

---

## Phase 4 — agent-bus routing (items 4–7)

- **4.** `interruptForge` cancels the conversation that the sender's messages route to, not
  `status.activeConversationId`. If that conversation is not streaming, interrupt nothing.
- **5.** The steer response returns `{steered:true, conversationId, title}` or
  `{steered:false, reason}`. `forge.sh steer` prints it.
- **6.** Add `--to <conversationId>` and `--to-running` to `say`/`send`. The 202 response names
  the chat the message will run in (id and title). Document it in `forge.sh` help and in the
  bus README.
- **7.** Only append the "write your verdict to outbox/…" instruction when the notice expects a
  reply. Status notices (cancelled, finished) get none.
- Tests: route resolution for steer when the visible chat ≠ the sender's chat, and the notice
  builder for each notice kind.

---

## State × lifecycle ledger

Phases 0, 1, 2 and 4 write no durable state. `ContextTrimState` is in memory, per conversation,
and is rebuilt from the transcript after a reload at the cost of one cold prefill, which a reload
already pays. Phase 3 changes one durable artifact:

| Artifact | create | delete | pause/disable | crash mid-write | owner-process death | TTL/expiry |
| --- | --- | --- | --- | --- | --- | --- |
| Session JSONL rows gaining `id` / `tool_call_id` (`~/.forge/sessions/*.jsonl`, `.forge/logs`) | Written by `SessionLogger.append` on each new message, as today; the new fields are additive | Deleted with the session log, as today (archive delete); no new deletion path | Logging disabled → no rows, same as today; readers treat missing ids as legacy | A torn last line is already skipped by `readLogRows` (`unreadable` count); the ids live inside the same line, so they are torn together and never half-paired | The next window's logger resumes from the `cursor` row; ids are generated per message, so a resumed run never reuses an id within one file | No TTL, same as the log; legacy rows without ids stay readable forever through the positional pairing path |

CI-enforceable row: a unit test feeds `readLog` a legacy log (no ids) and a new log (ids), and
asserts that every tool row is paired and that no synthetic "interrupted" result appears for a
call whose result is in the log.

## Acceptance criteria

- Phase 0: the patch applies cleanly, `files.sha256` matches, `npm run ci` is green, and the 2
  restored tests pass.
- Phase 1: tests 1–6 pass, and tests 1 and 5 fail on HEAD. Live check: ≥ 9 of 10 post-advance
  requests re-evaluate ≈ only the appended tokens at 131K ctx on Q6. A turn with `auto_compact` enabled
  compacts instead of trimming indefinitely.
- Phase 2: one test per item, each failing on HEAD. Symlink refusal is covered for every write
  tool found by grep.
- Phase 3: the ledger's CI row passes. "continue" twice survives recovery, and a fully replayed
  legacy log still collapses.
- Phase 5: one test per item, each failing on HEAD (20 skipped on Windows).
- Phase 4: steer interrupts only the sender's chat and reports what it stopped. Status notices
  carry no outbox instruction.
- Every phase: `npm run ci` is green, there are no new files over 500 LOC, `docs/OWNERS.md` is
  updated for any new module, and nothing is committed or pushed without the user's go-ahead.
