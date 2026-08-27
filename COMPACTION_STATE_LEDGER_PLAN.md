# Compaction state ledger — stop the resumed agent re-verifying finished work (impl plan)

**Goal:** after an auto-compaction, the resumed turn must know *what is already
done* without spending tool rounds rediscovering it. Today it re-reads files and
re-runs checks to reconstruct a state the host already knew.

**Status: IMPLEMENTED 2026-08-27 (0.13.15), all four phases.** Shipped as
described below, with three revisions found during implementation — see
"Revisions from implementation" before reading the phases. `npm run ci` and
`npm run package` are green; 1207 unit tests pass.

What landed: `src/sidebar/compactionLedger.ts` (Phase A),
`src/sidebar/repoSnapshot.ts` (Phase B), `src/tools/planTools.ts` +
`plan` on `ConversationRuntime`/`conversationPersistedSchema` +
`setPlan` on `ToolHandlerContext` (Phase C), and the rewritten `RESUME_PROMPT`
(Phase D, guidance only — the `ToolBudget` enforcement option was deliberately
NOT built, see that phase). Tests: `test/unit/CompactionLedger.test.ts` (20),
`test/unit/PlanTools.test.ts` (18), four added to
`test/unit/CompactionService.test.ts`.

## Revisions from implementation

1. **`compactionLedger.ts` was split in two.** It reached 377 lines carrying
   two concerns with two different dependency sets, so the git half moved to
   `repoSnapshot.ts`. The seam is real, not cosmetic: the ledger is now
   dependency-free (no `vscode`, no child process) and its classification is
   testable without git, a workspace, or a mocked `vscode`.
2. **The plan block is folded into the first user message, not inserted beside
   it.** The plan as written said "append as one short `user` message" after
   the compaction window. But after a compaction the first non-system message
   is *always* the summary preamble — also a `user` message — so inserting
   would have produced two consecutive user turns on every compacted
   conversation, which strict chat templates (gemma among them) refuse. It now
   merges into that message and only stands alone when there is nothing to fold
   into.
3. **The plan schemas are `.strict()`.** A plain Zod object *strips* unknown
   keys rather than rejecting them, which would have quietly accepted the blob
   the advertised `additionalProperties: false` promises to refuse — and the
   model would never learn its call was malformed.

Phase C's conversation-state ownership is `ModelTurn`-owned as specified below;
no session store was introduced into `ToolDispatch`.

**Scope discipline (no complexity):** four phases.

- **A** is a pure addition to `compactionPrompt.ts` — no new tool, no schema
  change, no new dependency.
- **B** additionally needs orchestration in `CompactionService.runCompaction`
  and a git/process dependency, injected so it stays mockable. It is *not* a
  `compactionPrompt.ts`-only change.
- **C** adds one tool, one optional persisted field, and a callback threaded
  through `ModelTurn` → `ToolDispatch`.
- **D** is a prompt change plus one config-driven budget entry.

Nothing in the compaction cut-point logic, the resume policy, or
`applyCompactionWindow`'s slicing changes.

---

## Problem

`buildSummaryPrompt` ([compactionPrompt.ts:88](src/sidebar/compactionPrompt.ts#L88))
asks the model for `Goal, State, Next, Files, Constraints, Errors`. Everything
in that summary except one block is **model-authored prose derived from a
truncated transcript** — `capSummarySource` caps the source at 24 000 chars and
head/tail-slices the middle away.

A resumed agent reading `State: implemented the ledger in compactionPrompt.ts`
cannot distinguish a *claim* from a *verified fact*. Re-checking is the rational
move, so it re-reads the files. That is the token burn being reported, and it is
worst in exactly the case that triggers auto-compaction most often: compaction
fires **mid-turn**, after the tool calls landed but before the assistant said
what it accomplished, so the strongest evidence in the conversation is raw tool
output the summarizer had to interpret.

Three rounds of prompt-wording fixes are already recorded in the comment above
`RESUME_PROMPT` ([CompactionService.ts:54-66](src/sidebar/CompactionService.ts#L54-L66)).
Wording is a spent lever. The one part of the summary an agent does *not*
re-verify is `recordedFilesBlock` ([compactionPrompt.ts:150](src/sidebar/compactionPrompt.ts#L150)) —
because it is host-recorded, deterministic, and its header says so:
`**Files changed (recorded by Forge, not written by the model):**`.

**The whole plan is: extend that one working idea to cover the rest of the
state, and give the agent evidence it can check for free.**

---

## Phase A — a recorded *actions* ledger, not just files

`collectWrittenFiles` already walks `msg.tool_calls` for `WRITE_TOOLS`. Same
walk, wider net, plus the paired result.

### Pairing calls to results

`ChatMessage.tool_call_id` ([types.ts:20](src/llm/types.ts#L20)) makes this
exact — no positional guessing. Build one `Map<string, string>` of
`tool_call_id → tool result content` over the summarized messages, then join.

### Outcome classification — the correctness core of this phase

The current `collectWrittenFiles` records a write **from the call alone**. That
is wrong the moment a write fails, and shipping it into a block headed "recorded
by Forge" would make the ledger authoritatively state that a failed edit
succeeded — strictly worse than the prose it replaces. Every entry is therefore
classified from its **paired result**, with three outcomes:

| Paired result | Outcome | Rendered |
|---|---|---|
| present, reports a successful handler result | `ok` | `- wrote src/foo.ts` |
| present, reports a host failure, refusal, or budget block | `failed` | `- FAILED write src/foo.ts — <first 100 chars of the result>` |
| **no** paired result | `unknown` | `- ATTEMPTED write src/foo.ts (no result recorded — outcome unknown)` |

The classifier must use Forge's result contract, not merely `!result.startsWith('Error:')`.
In particular, `Error:` and `User declined:` are host-owned failure/refusal
prefixes (`isFailureResult` in [toolResultView.ts](src/sidebar/toolResultView.ts)),
and `Budget exhausted:` is the host-owned `ToolBudget` refusal. These, plus the
explicit interrupted-call result written by `repairInterruptedToolCalls`, must
never render as `wrote`. Treat a tool withheld as unavailable as a blocked
outcome too. A normal paired result from the registered handler is the success
case; do not attempt to infer success from model-authored prose.

`unknown` is not hypothetical: it is the normal state for a call whose result
arrived after the summarizer's message snapshot, which is precisely the
mid-turn compaction case this plan exists for.

### Commands

For `exec_command`, `run_tests`, `run_build`, `query_powershell` (the registered
name — [safePowerShellTool.ts:116](src/tools/safePowerShellTool.ts#L116); there
is no `safe_powershell`) and `run_terminal`:

```
- ran `npm run ci` → exit 0
- ran `npm test` → exit 1 (FAILED)
- ran `npm run watch` → outcome unknown (no result recorded)
```

Exit codes are recoverable verbatim: the exec result formatter appends the
literal `\n[exit code: N]` ([execHelpers.ts:183](src/tools/execHelpers.ts#L183)).
Parse with `/\[exit code: (\d+|null)\]\s*$/`. Explicitly:

- **exit 0** → `→ exit 0`. This is the only line that licenses "verified".
- **non-zero** → `→ exit N (FAILED)`. The `(FAILED)` suffix is not decoration —
  the resumed agent must not read `exit 1` as work completed, and the ledger
  must make a failure at least as loud as a success.
- **`null`** (killed/timed out/signal) → `→ did not complete (exit null)`.
- **no `[exit code: …]` match** → `→ outcome unknown`. Never infer success from
  the absence of an error.

`run_terminal` is included but always renders `outcome unknown`: it launches a
VS Code terminal and returns before the command does, so its result carries no
exit code by construction. Recording it as `ok` would be a lie the header vouches
for.

Command text comes from the call's own `arguments`, truncated to ~120 chars.

``- ran `npm run ci` → exit 0`` is the single fact that most often makes a
re-verification turn unnecessary. It costs zero model judgement and cannot be
paraphrased away.

### Shape

Rename `recordedFilesBlock` → `recordedActionsBlock` (same call site,
[CompactionService.ts:192](src/sidebar/CompactionService.ts#L192)), same
"recorded by Forge, not written by the model" framing, with the cap applied
**per section** so a 400-call turn cannot crowd out the summary. Failed and
unknown entries are never dropped by the cap before `ok` entries are — a
truncated ledger must not silently become an all-success ledger.
`collectWrittenFiles` stays exported — it is the tested primitive.

**Files:** `src/sidebar/compactionPrompt.ts` (+~90 LOC; currently 232, lands
~320, under the 350 soft threshold). If it crosses 350, the seam is a new
`compactionLedger.ts` — the deterministic recording is cleanly separable from
the prompt text. Add the `docs/OWNERS.md` row either way.

---

## Phase B — evidence, so verification is free instead of a turn

A ledger says *what happened*. Evidence lets the agent confirm it **in-window,
with zero tool calls**.

### What the snapshot actually covers

`git diff --stat` alone is **not** repo state: it shows unstaged changes to
tracked files only, and silently omits staged changes and untracked new files.
An agent that just created three files and staged them would read an empty diff
and conclude nothing happened — the exact failure this phase exists to prevent.
So capture all three, and label each for what it is:

```
**Working-tree state at compaction (recorded by Forge, `git` at <cwd>):**
Unstaged (tracked): 2 files changed, 31 insertions(+), 4 deletions(-)
Staged:             4 files changed, 106 insertions(+), 12 deletions(-)
git status --short:
 M src/sidebar/compactionPrompt.ts
 A  src/tools/planTools.ts
 ?? COMPACTION_STATE_LEDGER_PLAN.md
```

Three commands: `diff --stat`, `diff --staged --stat`, `status --short`. The
`??` rows are the untracked files a `--stat` would have hidden.

### Process discipline

- **Async only, concurrently.** `spawnSync` blocks the extension host; `gitReadTools.ts`
  already uses it in places, and this must not add another. Use the async
  `execFileAsync` path that `runGit` ([gitRepo.ts:129](src/tools/gitRepo.ts#L129))
  is built on. `runGit` currently passes **no `timeout` and no `maxBuffer`** —
  extend its options (or call `execFileAsync` directly here) with
  `timeout: 3000`, `killSignal: 'SIGKILL'`, `maxBuffer: 512 * 1024`,
  `windowsHide: true`. Start the three independent commands with `Promise.all`,
  not sequential awaits: three separate 3 s timeouts otherwise create a 9 s
  compaction stall. If any command fails or times out, discard the whole
  snapshot and return `''`.
- **Injected, not imported at the call site.** `runCompaction` takes a new
  optional dep `snapshotRepoState?: () => Promise<string>` on `CompactionDeps`.
  Real implementation lives in the ledger module; tests pass a stub, and the
  existing compaction tests keep passing with it omitted.
- **cwd from `gitCwd()`** ([gitRepo.ts:222](src/tools/gitRepo.ts#L222)), **not**
  `workspaceFolders[0]`. The workspace root is not the project root (CLAUDE.md,
  agent-ergonomics traps). The rendered header names the cwd used, so the agent
  can tell which repo was measured.
- **Caps:** `status --short` truncated to 20 lines with an `…and N more` tail;
  whole block hard-capped at ~1 200 chars and counted into `capSummary`'s
  reserve.
- **Never fail the compaction.** Git absent, not a repo, timeout, non-zero exit,
  or throw ⇒ return `''`. A missing evidence block degrades to Phase A
  behaviour; a throw here would lose the whole summary. Total added latency is
  bounded at roughly 3 s wall-clock by the concurrent timeout, and it runs
  *before* `runPromptToMarkdown` so it cannot race the cut-point snapshot logic already commented at
  [CompactionService.ts:148-154](src/sidebar/CompactionService.ts#L148-L154).

This is the highest-leverage item in the plan: it converts re-verification from
N tool rounds to zero.

**Files:** `src/sidebar/compactionLedger.ts` (the git snapshot + Phase A
recording, ~120 LOC), `src/sidebar/CompactionService.ts` (new dep on
`CompactionDeps`, one call, pass length into `capSummary`'s reserve),
`src/sidebar/sidebarWiring.ts` or wherever `CompactionDeps` is constructed
(+1 line), `docs/OWNERS.md`.

---

## Phase C — a persistent task ledger the compaction cannot touch

Phases A and B fix *evidence*. They do not fix *plan state*: which of the six
things the user asked for are finished. That is the actual complaint — "the
agent had finished tasks and hadn't had time to update the status".

Forge has **no todo/plan tool**. `src/tools/taskTools.ts` is VS Code *workspace
tasks* (`list_workspace_tasks` / `run_workspace_task`) — unrelated.

### State ownership — resolved, and it is not `ToolDispatch`

`ToolDispatch` has no conversation store: its constructor
([ToolDispatch.ts:184-198](src/sidebar/ToolDispatch.ts#L184-L198)) takes a
registry, checkpoints, code lens, failure tracker, `post`, `requestApproval` and
diff decorations. `conversationId` arrives per-dispatch and is an *identifier*,
not a handle. Giving `ToolDispatch` a session store to satisfy this tool would
invert the existing dependency direction for one feature.

The codebase already has the right pattern for exactly this, one argument along:
`recordFileDiff` ([ToolDispatch.ts:208](src/sidebar/ToolDispatch.ts#L208)) is a
callback the *caller* supplies, and `ModelTurn` supplies it as a closure over
the live `conv` ([ModelTurn.ts:251-253](src/sidebar/ModelTurn.ts#L251-L253)).
`setPlan` follows it exactly:

- **Owner:** `ModelTurn`, which already holds `conv`. `ToolHandlerContext`
  exposes `setPlan(items: PlanItem[]): void`; the handler supplies only the
  schema-validated items. `ModelTurn` passes
  `setPlan: (items) => { conv.plan = { items, updatedAt: Date.now() }; ctx.onTranscriptChanged?.(conv); }`
  down the same dispatch call, and `ToolDispatch` forwards it beside
  `conversationMessages`. This makes the host, rather than the model tool,
  the sole author of `updatedAt`.
- **`updatedAt` + persistence + sync:** already solved by that listener.
  `ctx.onTranscriptChanged` is wired to `AgentLoop.recordTranscriptMutation`
  ([AgentLoop.ts:194](src/sidebar/AgentLoop.ts#L194)), which sets
  `conv.updatedAt = Date.now()` and fires the transcript listener
  ([AgentLoop.ts:341-344](src/sidebar/AgentLoop.ts#L341-L344)) that drives
  persistence and session sync. **No new persistence path is introduced** — the
  plan rides the one the transcript already uses, so it is durable the moment
  the tool returns.
- **Reads:** the handler needs no getter. Whole-list replacement means the model
  sends the full list every time, and the render for the prompt is done by
  `ModelTurn` from `conv.plan` directly (below).

### Tool

`src/tools/planTools.ts` — one tool, `update_plan`, strict schema, **bounded**:

```jsonc
{
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "minItems": 1,
      "maxItems": 20,
      "items": {
        "type": "object",
        "properties": {
          "text":   { "type": "string", "minLength": 1, "maxLength": 200 },
          "status": { "enum": ["pending", "active", "done"] }
        },
        "required": ["text", "status"],
        "additionalProperties": false
      }
    }
  },
  "required": ["items"],
  "additionalProperties": false
}
```

The bounds are load-bearing, not defensive habit: this tool is `autoApprove`,
so a model can write workspace state without a confirmation gate. Unbounded, it
could persist an arbitrarily large blob into `session.json` *and* re-inject it
into every subsequent request — a context leak that compounds each round.

- **Schema enforcement** rejects oversize input at the boundary (Zod-validated
  in the handler, matching the config/request-boundary rule in CLAUDE.md); the
  refusal returns a tool-result string naming the limit, so the model can retry
  correctly rather than losing the round.
- **Render cap:** the injected block is additionally hard-capped at **1 500
  chars** at render time. 20 × 200 chars cannot reach it, so the cap is a
  belt-and-braces bound on the context cost, never a silent truncator in
  practice.
- **Persisted cap:** the same limits are re-asserted in the Zod persisted schema,
  so a hand-edited or corrupted `session.json` cannot reintroduce an unbounded
  plan on load.

`permission: 'read'`, `autoApprove: true` — it touches no file and spawns
nothing, so it must not hit the confirmation gate. Whole-list replacement, not
per-item patching: one round per tool call is the scarcest resource (CLAUDE.md),
and a replace is idempotent under retry.

### Persistence

Add to `ConversationRuntime` ([sessionTypes.ts:148](src/sidebar/sessionTypes.ts#L148))
and `conversationPersistedSchema` ([sessionTypes.ts:112](src/sidebar/sessionTypes.ts#L112)),
optional so existing records parse unchanged — the same forward-compatible
pattern `compaction` and `active_time_ms` already use. Also add the explicit
runtime ↔ persisted mappings in `sessionPersistence.ts`; that module does not
serialize newly declared fields automatically. No migration step: absent means
no plan.

```ts
/** Agent-maintained task ledger. Survives compaction: injected verbatim,
 *  never summarized. Bounded — see planTools.ts. */
plan?: {
  items: Array<{ text: string; status: 'pending' | 'active' | 'done' }>;
  updatedAt: number;
};
```

### Injection

In `prepareMessages` ([ModelTurn.ts:213-221](src/sidebar/ModelTurn.ts#L213-L221)),
after `applyCompactionWindow`, append the rendered plan as one short
`role: 'user', internal: true` message. Regenerated every round from current
state, so it is always live and never duplicated — the same "model-facing copy
only" discipline the existing comment there describes. Rendered with the elapsed
age of `updatedAt` (for example, "updated about 6 min ago") so a stale plan
announces itself. Do not claim a number of rounds: `updatedAt` records time, not
a round counter.

Worst case after a compaction is now **one stale item**, not a whole plan
reconstructed from prose.

### Decision recorded

Phase C proceeds with `setPlan(items)` as a `ModelTurn`-owned closure threaded
through `ToolDispatch` (mirroring `recordFileDiff`). `ModelTurn` stamps
`updatedAt`, and `recordTranscriptMutation` remains the sole
`updatedAt`/persist/sync path. Do not inject a session store into
`ToolDispatch` for this feature.

**Files (assuming the design above):** `src/tools/planTools.ts` (new, ~110 LOC),
`sessionTypes.ts` (+~14), `sessionPersistence.ts` (+~8, both conversion
directions), `ToolRegistry.ts` (+~4, the context field),
`ToolDispatch.ts` (+~3, one forwarded param), `ModelTurn.ts` (+~10, the closure
and the render), `registerAllTools.ts` (+~2), `CompactionService.ts`
(RESUME_PROMPT text), `docs/OWNERS.md` (+1 row).

---

## Phase D — timing, and a budget that is actually enforced

**Prefer a turn boundary.** Auto-compaction firing mid-turn is the case that
produces a stateless summary. `autoCompactAndResume` already reads
`incompleteTurnReason()` ([CompactionService.ts:312](src/sidebar/CompactionService.ts#L312))
before compacting, so the host already knows. Phase A largely neutralises this
(tool calls are recorded whether or not the assistant got to speak), so this is
a *nice-to-have*, not a prerequisite.

**Verification budget — two separable pieces, do not conflate them.**

1. **Prompt guidance (ships with D).** `RESUME_PROMPT` currently says "do not
   redo work it records as done" — a prohibition a model violates the moment it
   feels uncertain. Replace with a bounded allowance:

   > The recorded-actions block is ground truth, recorded by Forge, not claimed
   > by a model. Prefer it over re-checking; confirm with a tool call only when
   > an entry is marked FAILED or unknown.

   This is **advisory**. A local model may ignore it, and the plan should not
   pretend otherwise.

2. **Actual enforcement (optional, config-driven).** The mechanism already
   exists: `ToolBudget` ([ToolBudget.ts:13](src/tools/ToolBudget.ts#L13))
   enforces per-turn `tool_call_limits` and is constructed per turn at
   [ModelTurn.ts:158](src/sidebar/ModelTurn.ts#L158) from the resolved model
   config. Enforcing a read budget on a resume turn means threading an optional
   per-turn limits override into `ModelTurn` and having the resume path supply
   it.

   **Recommendation: do not build this yet.** A hard cap on `read_file` in a
   resume turn will occasionally strand a model that legitimately needs two
   reads, and Phase A+B are aimed at removing the *reason* to re-read rather
   than punishing it. Ship (1), measure re-verification rounds against sessions
   under `~/.forge/sessions/`, and only then decide whether (2) is worth the
   failure mode. If it is, it is a small change against an existing mechanism.

---

## Tests

- **Phase A** (`compactionPrompt` / `compactionLedger` tests) — an exec call and
  its `[exit code: 0]` result pair into one `ok` line; a non-zero exit renders
  `(FAILED)`; `exit code: null` renders `did not complete`; a write whose result
  starts `Error:` renders `FAILED`, **not** `wrote`; a call with **no** paired
  result renders `ATTEMPTED`/`unknown` and does not crash; `run_terminal` always
  renders `unknown`; malformed `arguments` JSON is skipped (existing `try/catch`
  behaviour); per-section caps hold and never drop a `failed`/`unknown` entry in
  favour of an `ok` one.
- **Phase B** — the injected `snapshotRepoState` stub's output reaches the
  summary; a stub that rejects, times out, or returns `''` leaves
  `runCompaction` returning `'compacted'`; untracked (`??`) rows survive into
  the block; the 20-line/1 200-char caps hold. No test may shell out to real
  git — that is what the injected dep is for.
- **Phase C** — `update_plan` round-trips through persistence; a pre-`plan`
  session record still parses; over-limit input (21 items, 201-char text,
  unknown property) is rejected with a message naming the limit; `setPlan` bumps
  `conv.updatedAt` and fires the transcript listener exactly once;
  `prepareMessages` emits exactly one plan message per round; the plan survives
  a compaction (assert present after `applyCompactionWindow` + injection).
- `npm run ci` and `npm run package` before finishing.

## Risks

- **A ledger that lies is worse than prose.** The whole value rests on the
  header claiming host-recorded truth. The outcome classification in Phase A is
  what makes that claim honest; it is not optional polish.
- **Ledger crowding the summary.** Per-section caps, plus `capSummary` already
  reserving against the recorded block's length
  ([CompactionService.ts:193](src/sidebar/CompactionService.ts#L193)) — pass the
  new, larger length the same way, including Phase B's block.
- **Git snapshot latency.** Three git invocations on the compaction path,
  bounded at 3 s total by timeout and non-fatal on failure.
- **A stale plan misleads.** Mitigated by rendering `updatedAt` as an age, and
  by keeping Phase A's ledger authoritative for *actions* — the plan is
  authoritative only for *intent*.
- **Phase C persists model-supplied data.** Bounded at three layers (tool
  schema, render cap, persisted schema).

## Out of scope

Webview rendering of the plan (a checklist UI is a later pass — model-facing
state is what fixes the token burn); changing the compaction threshold or
cut-point selection; `MAX_CONSECUTIVE_AUTO_CONTINUES`; converting
`gitReadTools.ts`'s existing `spawnSync` calls to async (real, but a separate
fix); anything in `compactionWindow.ts` beyond leaving it alone.

## Order

**PR 1 — A + B.** No schema change, no new tool, no state ownership question;
fixes most of the burn. B's git dep is injected, so it is testable without git.

**PR 2 — C + D.** The ModelTurn-owned callback design above is approved and
ready to implement.
