# Deep read-only audit — 2026-10-04 (Qwen Flash-Next / Strata session)

Task from live Codex session. Audit only: no source edits, no commits.
Scratch test file `test/unit/ZZ_scratch_audit_repro.test.ts` is a repro
harness, NOT a deliverable — delete before any fix commit.

**Implementation follow-up (2026-10-04):** The later fix plan and permanent
tests supersede the scratch harnesses. This report preserves what the audit
observed. No durable failure row exists for the earlier missed 85% attempt, so
F13 plus F10 is a demonstrated mechanism consistent with the timeline, not a
proven historical cause. The initial ripgrep timeout's exact cause was also not
isolated because the successful retry changed both the glob and the path scope.

## Baseline

- HEAD at audit start: `15d4877` "Clarify send_file requires the media tool group to be loaded first" (1 line, `src/tools/sendFileTool.ts`).
- Prior commits in scope: `db11ac9` feat(compaction): preserve long handoffs and manage workspace memories (0.16.81?); `716542b` docs(audit); `4601c6d` /unload external (0.16.80); `3c093fc` seven 2026-10-03 audit fixes.
- Working tree clean except two untracked docs under `docs/reports/` (gitignored by policy).
- Bundled ripgrep: `exec_command` bare `rg --version` → `ripgrep 15.0.0 (rev 3a612f88b8)`, resolved through
  `N:\VScode\Microsoft VS Code\07f806f999\resources\app\node_modules.asar.unpacked\@vscode\ripgrep-universal\bin\win32-x64\rg.exe`
  (visible in the timeout error path). The `db11ac9` rg-resolution path WORKS.
  Note: first bounded search (`-l --glob src/**/*.ts autoCompact|auto_compact`) TIMED OUT at the
  30 s default; re-run as `rg -l --glob *.ts auto_compact src` finished instantly. The retry
  changed both glob and path scope, so the timeout's exact cause is unproven. Ripgrep resolution
  itself succeeded in the same environment.

---

## Area 1 — compaction, memory, tool execution

### F1 — CONFIRMED (High). The host-facts floor check can be unsatisfiable, so compaction permanently fails on small-context models.

- File/line: `src/sidebar/CompactionService.ts:313-322` (floor check), constants in
  `src/sidebar/compactionBudget.ts:57` (`hostMaxChars: Math.max(6_000, chars(0.035))`) and
  `src/sidebar/compactionUserContext.ts:14` (`USER_CONTEXT_MAX_CHARS = 12000`).
- Mechanism: `floorChars = compactionWindowChars(conv.messages, candidateWithSummary(''))`,
  `hostChars = floorChars - tailChars`, then `if (hostChars > budget.hostMaxChars) throw`.
  The candidate carries `userMessages` capped at **12,000 chars** (plus `SUMMARY_PREAMBLE`
  ≈ 700 and the user-context header ≈ 600), `recordedActions` (24+24 lines, each up to 800
  chars), `repoState` (up to 2,000), `memoryKeys` (40 keys × 200 chars) and `lastReply`
  (1,200). `hostMaxChars` has a **floor of 6,000** and only exceeds 12,000 when
  `policyTokens > 137,143` (i.e. per-slot ctx ≳ 161k at `at: 0.85`).
- Measured (scratch repro, `npx vitest run` equivalent via `node node_modules/vitest/vitest.mjs`):
  - `hostMaxChars` = 6,000 for policyTokens 20k–68,571; 6,125 at 70k; 14,875 at 170k.
  - Verbatim user block at cap alone → `hostChars = 12,996` vs `hostMaxChars = 6,000`.
  - A realistic ledger alone (24 action lines + 2,000-char repoState + 40 keys, NO user block)
    → `hostChars = 6,079` vs `6,000`.
- Conditions to hit: any model whose per-slot window is under ~161k (all common local configs:
  8k/16k/32k/64k/128k slots), once either (a) ≥ ~12k chars of non-internal user text has been
  summarized, or (b) the action ledger + repoState + memoryKeys exceed 6k chars. A long audit
  session with several 2k-char user prompts reaches (a) in ~6 prompts.
- User impact: every compaction — `/compact`, auto-compact, and mid-turn compaction — fails with
  "Host-preserved compaction facts need an estimated N characters, above the 6000-character
  budget; previous context kept." The window never shrinks, so the turn eventually dies with
  `CONTEXT_EXHAUSTED_MESSAGE` / `CONTEXT_INPUT_EXHAUSTED_MESSAGE`. The failure is deterministic
  and unrecoverable from inside the session; the user must start a new chat. `failedAutoAt`
  suppresses retries until a new user message, so it is not a cost loop (the floor check runs
  before the model call), but it is a silent-until-fatal dead end.
- Predates current commit? **No — introduced by `db11ac9`** (`git log -S "hostMaxChars" -- src/sidebar`
  and `-S "Host-preserved compaction facts"` both return only `db11ac9`). The 12,000-char user
  block predates it (`48d34d8`), but the 6,000 floor that contradicts it is new.
- Fix direction (not applied): make the host budget a function of the host facts it must hold —
  e.g. `hostMaxChars = max(userContextCap + ledger caps, chars(0.035))`, or budget user messages
  against `hostMaxChars` in `collectCompactionUserMessages` instead of a fixed 12,000. One owner
  for the cap, not two constants.

### F2 — CONFIRMED (Low, cosmetic/misleading). `rg` denylist error is misclassified as `missing_executable`.

- File/line: `src/tools/execProgramResolver.ts:276-287` throws when the bundled rg cannot be
  found; `src/tools/execTools.ts:216-226` wraps ANY throw from `resolveExecInvocation` as
  `ExecCommandError('missing_executable', …)`.
- The thrown text says "search_code is also unavailable until the bundled executable is
  installed", but the model is told the class is `missing_executable`. Minor, but it is the one
  case where the resolver's own policy message is labelled a spawn-lookup failure.

### F3 — RULED OUT (was: hypothesis). `describeShellBuiltin` masking a real `rg`.

- The concern was that removing `rg` from `UNAVAILABLE_PROGRAM_ALTERNATIVES` (`db11ac9`) would
  leave a bare `spawn rg ENOENT` with no guidance. It does not, on any reachable path:
  - `exec_command` bare `rg`/`rg.exe` is refused before any spawn
    (`execProgramResolver.ts:276-287`) when the bundled binary is absent.
  - `search_code` / `find_files` own their spawn errors:
    `dirTools.ts:161` `child.once('error', …)` → `"find_files: failed to start ripgrep: <msg>"`,
    and the close handler (`dirTools.ts:196`) reports rg's own stderr/exit code.
  - `resolveRipgrep`'s `'rg'` fallback is therefore only ever consumed by `dirTools`, which names
    the failure itself. No user-visible defect. Dropped from the fix list.

### F4 — CONFIRMED (Low). `forget` reconciliation is O(all sessions) and re-persists the whole blob per key.

- `src/sidebar/SidebarProvider.ts:394-399` (`forgetMemoryKey`) ignores `_key` and rescans every
  conversation in `conversations` + `history`, then `persistSession()` + `postSessionSync()`.
  Correct but quadratic in a batch forget (N keys → N full rescans + N full transcript writes).
  Also note `ConversationTabs.restore` (`src/sidebar/ConversationTabs.ts:378-382`) calls
  `retainLiveMemoryKeys` and assigns `if (retained)` — `retainLiveMemoryKeys` never returns
  falsy, so the guard is always true and re-assigns the same object when nothing changed. Harmless.

### F5 — CONFIRMED (Low). `forget` can leave the index inconsistent with the value.

- `src/tools/memoryTools.ts:150-176`: inside `serialize`, the value is deleted first
  (`state.update(KEY_PREFIX+key, undefined)`) and then the index is rewritten. If the second
  `update` rejects, the catch rethrows after `onForgot` — the value is gone but the key may
  remain in `__keys__`. `listMemoryKeys` filters index entries whose value is not a string, so
  the stale index entry is invisible to every reader. Net effect: no user-visible defect, but
  the index can accumulate dead entries (each `remember` of the same key re-adds nothing).
  Severity low; note only.

### Ruled out (Area 1)

- `failedAutoAt` retry storm: works as documented (WeakMap keyed by conversation, keyed on
  user-message count; `finally` sets on failure and deletes on success).
- `capActions` reserve math: `RESERVE` sums to 8+4+12 = 24 = `RECORDED_ACTION_MAX_PER_KIND`;
  the final `take(() => true, cap)` redistributes unclaimed reserve. No over-cap path
  (`kept.size >= cap` breaks every take).
- `mergeRecordedActions` omission counting: carried across generations via `previousOmitted`,
  so a capped list cannot report zero. Correct.
- `buildCompactionWindow` orphan-tool drop: leading `tool` messages are skipped; the retained
  tail always starts at a `user` message from `selectCompactionSplit`, so the while-loop is a
  belt-and-braces path, not a live bug.
- `memoryKeys` lifecycle: `boundMemoryKeys` (newest 40, ≤200 chars) matches
  `compactionPersistedSchema.ts:60` bounds and `compactionTypes` constants; `retainLiveMemoryKeys`
  is wired at load (`SidebarProvider.ts:118`), on forget (`:395`), on tab restore
  (`ConversationTabs.ts:379`), and via `sidebarWiring.ts:342`.
- `ToolRegistry.register` new guard: `workspaceStateMutation` + `mutation` mix is rejected;
  `forget` declares only `workspaceStateMutation`, and `ToolDispatch.ts:289` reads
  `reg.mutation?.paths(args)` so no undefined deref.
- `strictOutputTokens` (`PromptRun.ts:119-127`): `strict || reserve > 0 || think === false`
  → summarization gets `reserve + outputTokens`. Correct for the stated defect.

---

## Area 2 — agent turns, persistence, checkpoints

### F6 — CONFIRMED (High). `/clearChat` leaves the compaction window in place, so a "cleared" chat keeps talking to the old task — and the stale `fromIndex` hides the FIRST new messages from the model.

- Files/lines: `src/sidebar/ConversationOps.ts:246-253` (`opClearMessages` resets `messages`,
  `displayDiffs`, `title`, context counters and trim state — never `conv.compaction`);
  sole caller `src/sidebar/ConversationTabs.ts:143-152` (`clearActive`, reached from
  `SlashCommandHandler.ts:145` `/clearChat` and the webview clear action).
- Request path verified: `src/sidebar/prepareModelTurnMessages.ts:46`
  (`applyCompactionWindow(messages, input.compaction)`), fed from
  `src/sidebar/ModelTurn.ts` `prepareMessages: (messages) => prepareModelTurnMessages(messages, { compaction: conv.compaction, … })`.
  So a non-null `conv.compaction` on an empty transcript still produces the two synthetic
  replacement rows on EVERY round of every later turn.
- Reproduction output (scratch test, `applyCompactionWindow` after `opClearMessages`):
  - F6: transcript emptied, `conv.compaction` still defined; model copy = 2 rows, 1,142 chars,
    first row begins "Compacted replacement context. Continue the same conversation and active
    task from this state…" and includes the old `userMessages`, `recordedActions` and summary.
  - F6b (the worse half): old transcript of 4 messages compacted at `fromIndex: 2`; after the
    clear the user sends 3 new messages. Model-visible tail = `["NEW-INSTRUCTION-2"]` — the
    first new instruction and the assistant's reply to it are **behind the stale cut point and
    never sent**. A later `/compact` computes `from = min(compaction.fromIndex, len)`
    (`CompactionService.ts:204`) so `pending = ["NEW-INSTRUCTION-2"]`: the hidden messages are
    never summarised either — they are permanently invisible to the model while remaining
    visible in the sidebar.
- Conditions: compact a chat at least once (auto-compact at 85% does this silently), then use
  `/clearChat` (or the webview clear) in that same tab. Any `fromIndex > 0` state does it.
- User impact: (a) the agent resumes a task the user deliberately discarded and says so; (b) the
  user's first new instructions after clearing are silently dropped from the model's view, so the
  agent answers the second one as if it were the first. Both read to the user as "Forge ignored
  me / won't let go of the old task". This is a data-loss-shaped bug in the model-facing view
  only — the stored transcript is intact, which also makes it invisible to the user.
- Predates current commit? **Yes.** The non-destructive window landed `fc97956` (2026-08-15) and
  `opClearMessages` dates to `14021db` (2026-05-18); no commit touched `conv.compaction` in
  `ConversationOps.ts` (`git log -S conv.compaction -- src/sidebar/ConversationOps.ts` → empty).
  Not caused by `db11ac9`.
- Fix direction (not applied): `opClearMessages` should drop `conv.compaction` alongside the
  transcript (it already drops the counters and trim state for exactly this reason), or clamp
  `fromIndex` to 0. Test: after `opClearMessages`, `applyCompactionWindow` must return the input
  unchanged, and a subsequent `/compact` must see all new messages in `pending`.

### F7 — DOWNGRADED to Latent/Low (was Medium). `beginTurn` keeps a single `legacySession` field.

- File/lines: `src/checkpoint/CheckpointStack.ts:173-194` — `beginTurn` overwrites
  `this.legacySession`; `snapshotBefore` (`:186-189`) and `readSnapshotContent` (`:311`) write to /
  read from whatever `legacySession` currently is; `commitTurn(session)` clears the field only
  `if (this.legacySession === session)`.
- Reachability checked (this is why it is downgraded): every production caller passes its own
  session explicitly — `ModelTurn.ts:321-331` (`ctx.toolDispatch.dispatch(..., checkpoint, ...)`),
  `CliTurn.ts:79-98` (session handed to the CLI runner), and `ToolDispatch.ts:384-389` prefers the
  passed session. `grep` for other `dispatch(`/`snapshotBefore` callers found only
  `src/benchmark/toolHost.ts`, which owns its own capture path. So the `legacySession` fallback is
  currently **unreached in production**.
- Why it still belongs on the list: with two concurrent turns on two tabs, `legacySession` ends up
  pointing at whichever `beginTurn` ran last, and the earlier session is never cleared from it. Any
  future caller that dispatches without a session would silently snapshot into another
  conversation's session — or throw `"turn already committed"` in `CheckpointSession.snapshotBefore`,
  which `ToolDispatch`'s catch turns into a tool error while the mutation proceeds unsnapshotted,
  making Undo unable to restore it. It is a single-owner-state trap, not a live defect.
- Predates current commit? Yes (checkpoint stack predates the audit range).

### Ruled out / verified sound (Area 2 so far)

- `runLocalProviderTurn` lease release: explicit `turnLease?.release()` on the aborted early
  return, on the acquire-failure catch, in the inner `finally` before `settle`, plus an outer
  `finally` net; `release()` is documented idempotent. The 0.16.x pin-leak fix is intact.
- `TurnLifecycle.beginCancellation`: `cancellingConvIds` cleared in `.finally`, settlement promises
  tracked in a set with `waitForCancelledTurns` looping until empty — no stuck-cancelling state on
  the paths read.
- `CheckpointStack.undo`: refuses on any missing/changed fingerprint BEFORE restoring anything
  (all-or-nothing on the conflict check), retains recovery data when a restore partially fails
  (does not `stack.pop()`), and discards disk references only after a complete success. Correct
  ordering for the crash/partial cases.
- `commitSession`: skips empty sessions; `evictBeyondDepth` results are discarded asynchronously
  with a logged catch — no unbounded disk growth on the read path.
- Mid-turn compaction (`ToolCallingLoop`): `midTurnCompactions` reset after
  `MID_TURN_COMPACTION_RESET_ROUNDS`; `forceCompaction` throws `CONTEXT_EXHAUSTED_MESSAGE` when
  compaction is unavailable or the cap is hit — no infinite retry loop.

## Area 3 — backend startup, pooling, cancellation

(not started)

## Area 4 — remote delivery, agent mesh handoffs

### F8 — CONFIRMED (Medium-High). A remote request left in `running` by a failed settle permanently jams that conversation's queue in a live window; only a window reload recovers.

- Files/lines:
  - `src/remote/remoteQueueOrdering.ts:56-58` — `claimNextInDraft` returns `undefined` while ANY
    record for the conversation is `running` ("A conversation already running keeps its claim").
  - `src/remote/remoteStateRetention.ts:12-14` — `pruneRemoteState` exempts `queued` and `running`
    from the 30-day age-out, so the record never ages away.
  - `src/remote/RemoteRequestStore.ts:69-85` — the ONLY `running` → `unknown` reconciliation is in
    `load()`, i.e. at window start. Nothing reconciles it while the window lives.
  - `src/remote/RemoteMidTurnTells.ts:44-63` — the claim (`claimMidTurnTell` → `running`) and the
    `settle` (`store.finish`) are separate steps.
  - `src/agent/ToolCallingLoop.ts:391-404` — between them sits
    `options.onMessagesChanged?.()`; if that persist throws, `await drained?.settle?.()` never runs.
    `MidTurnTellDrain.settle` (`src/agent/MidTurnTellDrain.ts:44-49`) also stops at the first
    rejecting source, leaving later records `running`.
  - `src/remote/RemoteQueueDrain.ts:41-52,96-105` — same shape on the ordinary drain path: a throw
    from `store.finish` (e.g. the documented 15 s state-lock timeout in `remoteStateFile.ts:14,42`)
    leaves the record `running` with no recovery.
- Reproduction (scratch test, real `RemoteRequestStore` on a temp file):
  ```
  claimed=none queued=next-2 health={"queued":1,"running":1,"unknown":0}
  after reload health={"queued":1,"running":0,"unknown":1}
  ```
  After one unsettled mid-turn tell, `claimNext('conv-A','telegram')` returns `undefined` on every
  retry, the second queued prompt is never served, and `requestHealthForConversation` keeps
  reporting `running: 1`. A fresh `load()` converts it to `unknown` and the queue drains again.
- Conditions: any throw between claim and settle — transcript persist failure, a state-file lock
  timeout under concurrent windows, or a settle source that rejects. Also any `store.finish`
  failure in the ordinary drain.
- User impact: from the phone it looks like Forge stopped listening — new Telegram/WhatsApp
  prompts for that conversation sit `queued` forever with no error and no timeout. `/drop`
  (`cancelQueued`, `remoteQueueOrdering.ts:29-41`) only cancels `queued` records, so there is no
  user-facing recovery; the only fix is Reload Window. Severity Medium-High: silent, permanent
  for the session, and reachable from an ordinary persist/lock failure.
- Predates current commit? **Yes.** The mid-turn tell claim/settle split is `03ad88f` (2026-09-23);
  the `claimNextInDraft` running-guard is older. Neither was touched by the 2026-10-03/04 commits.
- Fix direction (not applied): give `running` an in-window lease — e.g. a bounded age past which a
  `running` record becomes `unknown` (the same state `load()` chooses), applied inside
  `claimNextInDraft`/a periodic reconcile rather than only at load. `unknown` already unblocks the
  queue, so the recovery state exists; it is simply unreachable without a restart.

### Verified sound (Area 4 so far)

- `remoteStateFile.ts` — lock with pid+timestamp record, 60 s stale reclaim, 15 s wait, atomic
  temp+rename with bounded EPERM/EBUSY retries (the Windows rename-over-open reader case), temp
  cleanup on failure. `mutate()` reloads from disk inside the lock, so two windows cannot erase
  each other's writes.
- `RemoteOutboxDelivery` — at-least-once with `sending`→`delivered`/`pending`, `MAX_ATTEMPTS` 10 →
  `abandoned`, exponential backoff capped at 60 s; `speak` and `armEphemeral` deliberately outside
  the try that owns delivery state, so a speech/cleanup failure cannot requeue a sent message.
  `load()` resets `sending`→`pending`.
- `claimNextInDraft` cross-window claim guard (a conversation already running is not double-claimed)
  is correct — the defect in F8 is its missing timeout, not the guard.
- `compareQueuedRequests` is the single sort owner; `claimMidTurnTellInDraft` re-checks `queued`
  inside the serialized mutation, so a drain/tell race cannot double-inject.
- Handoff state machine (`RemoteHandoffState.ts` + `RemoteHandoffCoordinator.ts`): 5-minute TTL,
  `replaceHandoffForChat` (one in-flight switch per chat), claim/complete/fail-unclaimed with
  reread-inside-mutation, and the rollback timer that guarantees the chat is never stranded
  between two windows. Expiry is handled by `pruneRemoteState` on handoffs.
- Mesh delivery state (`agentMesh/deliveryState.ts`): transitions are an explicit table, terminal
  states are absorbing (`deriveLatestState` stops at the first terminal — F-03), and `unknown`/
  `stalled` are deliberately non-terminal. Transport exit codes may only advance to `accepted`.
- `agentMesh/lock.ts`: hard-link publish (no empty-lock window), rename-aside reclaim (only one
  recoverer wins, judged bytes re-compared before deleting), self-deadlock reclaim, pid+start-time
  liveness so a recycled pid cannot hold a lock forever.
- `RemoteAgentProgress`: one bubble per conversation, `owns`/`has`/`hostChat` split documented and
  consistent, narration seen-set bounded at 32, warnings latched; edits (not sends) avoid per-tick
  notifications.

---

## Test-coverage map for the confirmed findings (what a fix must not silently break)

| Finding | Existing tests that touch the code | Do they pin the buggy behaviour? |
|---|---|---|
| F1 host-facts floor | `test/unit/CompactionPolicy.test.ts` (asserts `replacementMaxChars`, `tailMaxChars`, `summaryCeilingChars` — **never `hostMaxChars`**); `test/unit/CompactionService.test.ts` (never exercises the floor throw) | **No.** `hostMaxChars` has zero assertions anywhere in `test/`. A fix is unconstrained by existing tests and needs a new one. |
| F6 `/clearChat` + compaction | `test/unit/ConversationOps.test.ts:251-265` asserts `messages`, `active_model`, `contextTrimState` after `opClearMessages` — **`conv.compaction` is not asserted at all** | **No.** The test simply omits the field, which is how the defect survived. Fix needs `expect(conv.compaction).toBeUndefined()`. |
| F7 `legacySession` | No test references `legacySession` (searched `test/`) | **No.** Unconstrained. Note: no production caller reaches the fallback, so a fix is a hardening change, not a behaviour fix. |
| F8 `running` lease | `test/unit/RemoteMidTurnTells.test.ts` uses a **stub store** (its own `claimMidTurnTell`), so the real `claimNextInDraft` running-guard is not covered there; `test/unit/RemoteHardening.test.ts:497-498` covers concurrent `claimNext` (cross-channel, not the stale-`running` case) | **No.** No test asserts that a stale `running` record blocks forever, so adding a lease/timeout will not break a pinned expectation. |
| F2 rg error class | `test/unit/execProgramResolver.test.ts:68-82` covers the resolver's rg branch (including the throw at `:80-82`) | Resolver-level behaviour is pinned; the *error class* chosen by `execTools.ts:216-226` is not. Changing the class needs no test change. |

Note: the two scratch repro files (`ZZ_scratch_audit_*.test.ts`) are currently the only tests that
demonstrate F1, F6 and F8. They are deliberately left in place so Codex can run them
(`node node_modules/vitest/vitest.mjs run test/unit/ZZ_scratch_audit_repro.test.ts`), and must be
deleted or replaced by real tests before any fix commit.

## F9 — INTENTIONAL LIMITATION (tested), but it compounds F1: a long session can also be refused by the source budget.

- File/line: `src/sidebar/compactionPrompt.ts:104-110` — `capSummarySource` keeps **every**
  user/assistant message untruncated (`formatSummaryMessage` truncates only `role === 'tool'`
  bodies, `:52-55`) and throws
  `"Compaction source cannot retain all user decisions and assistant findings within the estimated prompt budget."`
  when those alone exceed `sourceMaxChars`.
- Measured boundary: `sourceMaxChars = max(24_000, min(0.8·P·2.5, (modelMax − target − reasoning − 6_000)·2.5))`.
  At a 64k slot (P ≈ 54,400) that is ≈ **108,800 chars** of combined user+assistant prose; a session
  past that refuses compaction outright, on every trigger, forever. On this 200k slot the same
  budget is ≈ 371,000 chars, which is why it has not bitten here.
- Verified intentional and tested: the comment states the policy ("refuse compaction instead of
  manufacturing a partial handoff") and `test/unit/CompactionPolicy.test.ts:120-135`
  ("refuses when indispensable messages cannot fit the source budget") pins it. So this is NOT
  reported as a defect — it is reported because (a) the user-visible result is identical to F1
  (compaction never succeeds, window grows, turn dies) and (b) `fitSummaryPrompt`'s 0.75-step
  shrinking (`compactionBudget.ts:66-83`) makes this throw *more* likely as the model window gets
  tighter. Any F1 fix should be checked against this path so a fix does not quietly convert one
  refusal into the other.

## Compaction-recovery log

### Live confirmation of F1's boundary (this session, 02:44)

- `.forge/config.yaml`: `auto_compact: { enabled: true, at: 0.85, resume: true }`.
- Bridge: `strata-flashnext-iq3s`, `max_tokens 200000`, `used_tokens 185641` → **92.8%**.
  `policyTokens = max(185641, 20_000) = 185641` → `hostMaxChars = floor(185641 × 0.035 × 2.5)`
  = **16,243** > `USER_CONTEXT_MAX_CHARS` 12,000, so the floor check passes on THIS model.
- That is F1's predicted boundary exactly: the defect only bites below
  `policyTokens ≈ 137,143` (per-slot ctx ≲ 161k at `at: 0.85`). A 200k slot compacts; a 32k or 64k
  slot with the same conversation would be refused. This is why the bug has not been seen on this
  machine and would be seen on any smaller local config.

### Turn 1 (ended ~02:16)
- Provider-reported size at turn end: **~96K / 200K** (figure supplied by Codex from the harness; the bridge file is per-active-conversation and was not sampled during that turn).
- No compaction fired (96K < 0.85 × 200K = 170K). State survived in-chat only; I re-derived
  F1–F5 from my own notes, so nothing was lost, but nothing was durable either — which is why the
  findings doc + `remember` key `audit-2026-10-04-state` now exist.

### Turn 2 (started ~02:17, still running at 02:40)
- Bridge reading (`~/.forge/hallumeter-bridge.json`, model `strata-flashnext-iq3s`, max 200000):
  **used_tokens 177157** at 02:40 → **88.6%**, above `auto_compact.at` (0.85 → 170K).
- Handoff written to disk before the expected compaction:
  - this file (`docs/reports/DEEP_AUDIT_2026-10-04_FINDINGS.md`) — findings F1–F8 + ruled-out lists
  - `remember` key `audit-2026-10-04-state` — same summary + exact next step
  - scratch repros: `test/unit/ZZ_scratch_audit_repro.test.ts` (5 tests), `test/unit/ZZ_scratch_audit_remote.test.ts` (1 test)
- Post-compaction check owed: confirm F1–F8 numbers, the two scratch file names, the HEAD baseline
  `15d4877`, and the "PAUSE for Codex before fixing/committing" constraint all survive. Report any
  loss or distortion here.

### Status by area
- Area 1 (compaction/memory/tool exec): **complete** — F1 (High, new in `db11ac9`), F2, F3 (hyp), F4, F5.
- Area 2 (turns/persistence/checkpoints): **complete** — F6 (High, pre-existing), F7 (Med, pre-existing).
- Area 3 (backend startup/pooling/cancellation): **reviewed, no new confirmed defect.** Read
  `BackendPool`, `poolStart`, `poolSlots`, `poolAcquisition`, `poolReadiness`,
  `poolStructuralConfig`, `DirectBackend` (stop/hotSwap/detach ordering), `llamaProcess`
  (tree teardown, `LlamaTerminationError` port retention), `deferredStop` watcher,
  `ExternalModelServers` (start single-flight, unload generation guard, busy-409 cancel,
  stop-on-exit watcher ordering). Verified: `freeSlot` single-owner guard prevents port
  double-free; eviction is awaited before the replacement spawn; `applyForgeConfig` pins
  structural settings to the physical slot inventory; `turnPins` release ordering on every
  early-return path in `runLocalProviderTurn`.
- Area 4 (remote delivery/mesh handoffs): **complete** — F8 (Med-High, pre-existing). Verified
  sound: state-file lock + atomic write, outbox at-least-once with `abandoned`, queue ordering
  single owner, handoff TTL + rollback guarantee, mesh delivery-state transition table with
  absorbing terminal states, `agentMesh/lock.ts` reclaim protocol, `AliasFifo` (queue bound,
  durable-`accepted` rollback on write failure, drain never wedges, dispose writes terminal
  `timeout` per queued message, steer admitted before interrupt), `agentRoutes` auth + sender
  validation + blocked-answer 409, `AwaitedAnswers` finally-cleanup, exchange log compaction
  (whole terminal exchanges, 24 h non-terminal deadline, tmp+rename under lock).

### Exact next step
1. Append the post-compaction recovery verdict to this file.
2. Delete both scratch test files (they are repro evidence, not deliverables).
3. `tell_live_session` → codex: name both reports, list confirmed findings F1, F6, F8 (+F7, F2)
   with severity and whether each predates HEAD, then **PAUSE**.
4. Fix only what Codex verifies; run focused tests then `npm run ci`; report; **PAUSE**;
   commit only on Codex's explicit go-ahead.

## F10 — CONFIRMED (High): one failed automatic compaction silences every later automatic attempt for the rest of the conversation

- File/line: `src/sidebar/CompactionService.ts:136` (`const failedAutoAt = new WeakMap<ConversationRuntime, number>()`),
  gate at `:156-160`, set at `:166`.
- Mechanism: `runCompaction(..., {auto:true})` records the conversation's **visible**
  user-message count at the moment an automatic attempt returns `'failed'`, and every later
  automatic attempt is skipped (`'skipped'`) while that count is unchanged. Both automatic
  triggers re-fire constantly — mid-turn on every round (`midTurnCompaction.ts:47`) and
  post-turn at turn end (`ContextBudgetPublisher.ts:253`) — so once one attempt fails, the
  context keeps growing and **neither trigger can try again** until the user types a new
  visible message.
- Confirmed by repro: `test/unit/ZZ_scratch_autohold.test.ts` (5 tests, pass). Attempt 1
  `'failed'` → attempts 2 and 3 `'skipped'` with **zero summarizer calls** and
  `conv.compaction` still `undefined`. A manual `/compact` is never held back (`:155`).
- F10b (same repro): a **successful manual `/compact` does not clear the hold** — the
  `finally` at `:167` only clears it when an *automatic* attempt succeeds. So the user can
  rescue the window by hand and automatic protection is still off.
- Boundary of the hold: cleared by a new **visible** user message only. `userMessageCount`
  (`:138-140`) excludes `internal: true`, so the compaction resume prompt and the
  mid-turn nudge do **not** clear it — confirmed in the repro. A window reload does clear
  it, because the key is a `WeakMap` on the in-memory `ConversationRuntime` object, and a
  reload builds a new one (`sessionPersistence.ts:120-144`).
- Severity: High. User impact: the exact situation auto-compact exists for — a long unattended
  agent turn — is the one where a single transient summarizer failure (a thinking model that
  overshoots the summary ceiling, one `isUsableSummary` rejection, one provider hiccup) turns
  auto-compact off for hours. The window then grows to exhaustion and the turn dies with
  "context exhausted", which is the failure `docs/COMPACTION_PLAN.md` T3 promised 0.85 would
  leave headroom against.
- Predates current HEAD: introduced in `d97ab74` (2026-09-22, "release: 0.16.33 — a thinking
  cloud model writes its compaction summary, and a failure no longer loops"). Not new in the
  audited range `15d4877..b0abd8b`.
- Test coverage: `rg -n "failedAutoAt|the last attempt failed|no new user message" test` →
  **no matches**. The hold has no test at all.
- Why this is not simply "intentional": the comment at `:126-135` documents the intent
  (don't burn seven paid summarizations in two minutes), and that intent is legitimate. The
  defect is the **scope and the lifetime** — a permanent, per-conversation, in-memory mute
  keyed on a counter that a long agent turn never changes, with no attempt-count decay, no
  time decay, no distinction between a config-caused failure (which does repeat identically)
  and a transient one, and no re-arm on a large context increase.

## F11 — CONFIRMED (Medium): an interrupted/cancelled turn never reaches the post-turn auto-compact check

- File/line: `src/sidebar/SendPipeline.ts:295-298` —
  `if (turn.kind !== 'completed' && !recoverableContextFailure) return toRequestOutcome(turn);`
  with `recoverableContextFailure` limited to `isContextExhaustionReason(turn.error)`.
- Consequence: `cancelled` and `interrupted` turns (Stop pressed, or a window reload mid-turn)
  return **before** `evaluateAfterTurn` at `:301`, so the 85% check never runs for them. The
  2026-09-22 fix that let context-exhaustion failures reach the policy did not cover
  interruption.
- Observed in this session: the log row `session_start … ts=1791073272` (03:21, forge 0.16.81)
  is a host reload during a running turn; the next compaction row is 5 minutes later.
- Severity: Medium. Impact: reloading the window during a long turn — the normal way to pick up
  a new VSIX — leaves a 90%+ conversation with no compaction, and the fresh host then starts its
  first turn already near the ceiling.
- Predates HEAD: the `kind !== 'completed'` return predates the exhaustion carve-out in the same
  commit range check; `git log -S recoverableContextFailure` → `d97ab74`-era code, unchanged since.

## F12 — CONFIRMED (Medium): a failed automatic compaction leaves no durable record, so F10 is undiagnosable

- `logCompaction` (`SessionLogger.ts:193-206`) writes a `type: 'compaction'` row **only** on the
  success path (`CompactionService.ts:437`, inside the try, after the shrink guards pass).
  Verified against this conversation's own log:
  `C:/Users/efso office/.forge/sessions/8c170fd7-….jsonl` contains exactly **one** compaction
  row (line 647) for a session that crossed 85% at least twice.
- A failure produces: one ephemeral webview `error` notice (`CompactionService.ts:475-479`), one
  `log.info` line in the **in-memory** Output Channel (`util/logger.ts:17` — `createOutputChannel`,
  nothing on disk), and the invisible `failedAutoAt` entry.
- Consequence: after the fact it is impossible to tell "auto-compact never fired because of a
  silent hold" from "auto-compact fired and was refused" from "the trigger was never reached".
  This audit could not determine, from disk, which of F10/F11 caused the missed 85% firing below.

## Live evidence: what this session actually did (the user's question)

Config (`.forge/config.yaml`): `auto_compact: { enabled: true, at: 0.85, resume: true }`.
Model `strata-flashnext-iq3s`, per-slot `max_tokens 200000`.

| time | reading | source |
|---|---|---|
| 02:40 | 177,157 / 200,000 = **88.6%** | `~/.forge/hallumeter-bridge.json` |
| 02:44 | 185,641 / 200,000 = **92.8%** | same |
| 02:48 | turn 2 ends (assistant final row, `model_request_count 113`) | session log 639 |
| 02:50 | new user message (turn 3) | session log 641 |
| 03:21 | host reload (`session_start`, forge 0.16.81) + resume prompt | session log 643-644 |
| 03:26 | **compaction row**: `generation 1, from_index 296, used_tokens 195945, max_tokens 200000, summary_chars 22076, trigger "auto", threshold 0.85` | session log 647 |
| 03:26 | `MID_TURN_RESUME_NUDGE` user row follows | session log 648 |
| 03:27 | 29,877 / 200,000 = 14.9% | bridge |

Verdict: **auto-compaction does fire — but it fired at 98%, not at the configured 85%.**
The 85% line was crossed at 88.6% (02:40) and still exceeded at 92.8% (02:44), and no
compaction happened then; the one compaction row sits at 195,945/200,000 = **97.97%**, reached
only through the mid-turn path (the `MID_TURN_RESUME_NUDGE` row, not the post-turn
`RESUME_PROMPT`). Recovery after that compaction was clean: 185,641 → 29,877 tokens, and the
replacement context carried findings F1–F9, both scratch filenames, HEAD `15d4877`, and the
PAUSE-before-committing constraint intact (checked against the doc at 03:27).

Why the 85% firing was missed cannot be proven from disk — that is F12. F10 and F11 are the two
code paths that can each produce exactly this timeline, and F10 is the only mechanism in the
codebase that can silence **both** triggers for an entire conversation while context keeps
growing. The 98% firing is what a conversation looks like once the mute is cleared (here, by the
02:50 user message and again by the 03:21 reload, both of which reset the `WeakMap` key or the
counter).

Safety consequence: firing at 98% leaves the summarizer request ~4,000 tokens of headroom, so
`fitSummaryPrompt`'s 0.75-step shrinking is doing all the work. `docs/COMPACTION_PLAN.md` T3
chose 0.85 explicitly because "at 95% there is none and auto-compact would fail exactly when it
is needed" — F10 defeats that margin, and on a 32k/64k slot F1/F9 would turn the same sequence
into a hard failure instead of a late success.

## Compaction-recovery log — compaction #1 (03:26, generation 1)

- Provider-reported size at the trigger: **195,945 / 200,000 (97.97%)**; on resume,
  **29,877 / 200,000 (14.9%)**.
- Survived intact: F1 numbers (`hostChars=12996`/`12,000`, `hostMaxChars` floor 6,000),
  F6/F6b (`ConversationOps.ts:246-253`, `prepareModelTurnMessages.ts:46`), F8
  (`remoteQueueOrdering.ts:56-58`, `remoteStateRetention.ts:12-14`), F9, both scratch
  filenames, HEAD baseline `15d4877`, and the "PAUSE for Codex before fixing/committing"
  constraint. The findings doc was re-read at 03:27 and matched the summary line for line.
- Lost or distorted: none of the recorded findings. Two things the summary stated that the
  on-disk record now corrects: (a) the summary said the trigger was "awaiting post-turn
  auto-compact" — the firing was actually **mid-turn**, and (b) the working tree had changed
  under the audit: the six unstaged files were committed as `b0abd8b` (03:30), so the audit
  baseline moved from `15d4877` to `b0abd8b` mid-session. Both are recorded here rather than
  silently adopted.

## F13 — CONFIRMED defect (High), plausible cause of late firing: the summary ceiling can reject a handoff at the 0.85 trigger point, and F10 can then mute later attempts

- File/line: `src/sidebar/CompactionService.ts:379-383` —
  `if (proposed.length > budget.summaryCeilingChars) throw new Error('Summary exceeds the estimated …-character ceiling; previous context kept.')`
  which returns `'failed'` through the outer catch at `:474-480`.
- Ceiling: `compactionBudget.ts:56` → `summaryCeilingChars = max(8_000, floor(policyTokens × 0.05 × 2.5))`
  = **0.125 chars per context token**, so it grows with the context *at the moment the attempt runs*.
- Measured against this session's own compaction row (`summary_chars: 22076`), via
  `test/unit/ZZ_scratch_ceiling.test.ts` (4 tests, pass), real `compactionBudget`, 200k slot:

  | context at attempt | summaryCeilingChars | fits 22,076? |
  |---|---|---|
  | 170,000 (= 0.85 × 200k, the configured trigger) | **21,250** | **NO → throw → 'failed'** |
  | 176,607 | 22,075 | NO |
  | 176,608 (= 88.3%) | 22,076 | yes (exact boundary) |
  | 185,000 | 23,125 | yes |
  | 195,945 (the one row that succeeded) | 24,493 | yes, by 2,417 chars |

- A 22,076-character handoff generated at **170,000 tokens** would fail the 21,250-character
  ceiling. That failure would engage F10 and suppress later automatic attempts until a new
  visible user message or reload. This mechanism fits the observed 97.97% success, but the
  earlier failed attempt was not logged and its generated size is unknown. The successful
  handoff's size cannot establish what an earlier attempt would have generated.
- F13b — the ceiling and the request cap disagree by 2×. `b0abd8b` raised the summarizer request
  to `COMPACTION_REQUEST_OUTPUT_TOKENS = 16_384` (`compactionBudget.ts:7`) but left
  `summaryCeilingChars` at 0.05·policyTokens. At policyTokens 170,000: `summaryCeilingTokens` =
  8,500 while the request **invites 16,384 output tokens**. The model is asked to write up to
  twice what the next check will accept, so a thorough handoff is rejected by construction.
  `b0abd8b` fixed the *request* half of this pair and not the *ceiling* half.
- F13c — the throw is self-inflicted: `capSummary(proposed, budget.summaryCeilingChars)` on the
  very next line (`:384`) already truncates to that exact ceiling, and
  `test/unit/CompactionPolicy.test.ts:102-106` proves `capSummary('a'.repeat(30_000), 21_250)`
  returns a 21,250-char summary with a `…[truncated]` marker. So the code path is: reject the
  summary fatally, when the next line is tested to handle it non-fatally.
- Predates HEAD: the ceiling check and the 0.05 factor are from `db11ac9`
  (2026-10-04, "preserve long handoffs"); the request-cap half is `b0abd8b` (2026-10-04).
  F10's mute is `d97ab74` (2026-09-22). All three predate the audit's fix window but two are
  inside the audited commit range `15d4877`/`db11ac9`.
- Severity: High. User impact: on any model that writes a detailed handoff, auto-compact fails
  once at the threshold, goes quiet, and then either fires at ~98% with almost no summarizer
  headroom or hits exhaustion. On a smaller slot (32k/64k) the ceiling is 8,000 chars flat — the
  floor — so a model that writes 22k of handoff can never pass, and F1/F9 close the other exits.
- Test coverage: `rg -n "exceeds the estimated" test` → **no matches**. The ceiling throw has no
  test, and `CompactionPolicy.test.ts:26` only pins the 8,000-char floor case.

## Coverage-gap map (deeper pass)

| finding | production path | test that pins it | gap |
|---|---|---|---|
| F1 host-floor refusal | `CompactionService.ts:322` | none | scratch only |
| F6 stale `compaction` after clear | `ConversationOps.ts:246-253` | `ConversationOps.test.ts` tests the clear, never the compaction field | gap |
| F8 running-record jam | `remoteQueueOrdering.ts:56-58` | `RemoteMidTurnTells.test.ts` uses a fake store | gap |
| F10 `failedAutoAt` hold | `CompactionService.ts:156-160` | **none** | gap |
| F11 interrupted turn skips check | `SendPipeline.ts:295-298` | `SendPipeline.test.ts:431-439` asserts `evaluateAfterTurn` is **not** called for a thrown turn; `:293-300` covers `cancelled` logging only | the assertion encodes the gap |
| F13 ceiling throw | `CompactionService.ts:379` | **none** | gap |
| F13b cap vs ceiling | `compactionBudget.ts:7,56` | `CompactionPolicy.test.ts:41-48` pins the request cap fits the window; nothing pins ceiling ≥ what the cap invites | gap |
| F9 source-budget refusal | `compactionPrompt.ts` `capSummarySource` | `CompactionPolicy.test.ts:88-100` | covered (intentional) |
| mid-turn policy | `midTurnCompaction.ts` | `MidTurnCompaction.test.ts` (policy + loop + cap) | covered |

Note on F11: `SendPipeline.test.ts:438` (`expect(h.deps.evaluateAfterTurn).not.toHaveBeenCalled()`)
is an existing test that **pins the behaviour F11 reports as a defect** — for a thrown turn. The
context-exhaustion carve-out at `:295-296` is what lets exhaustion reach the policy; a
`cancelled`/`interrupted` turn has no such carve-out, and no test asserts what should happen to
its context. Any F11 fix must update that test deliberately rather than by accident.

## F14 — F1's host-floor gate: NOT this session's cause, but CONFIRMED to bite on a 200k slot too (corrected measurement)

- Hypothesis: the `hostChars > hostMaxChars` floor check (`CompactionService.ts:322`) also refuses
  at the 0.85 trigger, making it a second cause of the missed firing.
- **Measurement correction (recorded because the first number was wrong).** The first pass built
  the ledger with `{kind, label, outcome}` — not the real shape. `renderRecordedActionsBlock` reads
  `key`/`line`/`toolCallId` (`compactionTypes.ts:10-17`, renderer `compactionRecordedState.ts:140-152`),
  so that ledger rendered to 398 chars for 60 rows and produced a false negative. Re-measured with
  the real `RecordedCompactionAction` shape in `test/unit/ZZ_scratch_hostfacts.test.ts` (2 tests, pass):

  | context (200k slot) | hostMaxChars | worst-case hostChars | refuses? |
  |---|---|---|---|
  | 170,000 (0.85 trigger) | 14,875 | **20,674** | **yes** |
  | 176,608 | 15,453 | 20,674 | yes |
  | 185,641 | 16,243 | 20,674 | yes |
  | 195,945 (this session's success point) | 17,145 | 20,674 | **yes** |

  Worst case = user block at its 12,000 cap (12,701 rendered) + a full 24-file/24-command ledger
  (4,744) + repoState at its 2,000 cap + 40 memory keys (1,229).
- So F1 is **not** confined to per-slot ctx ≲ 161k. On this 200k slot, a conversation that fills
  the user block, the ledger, the repo snapshot and the key list at their documented caps is
  refused even at 98%. The caps in `compactionTypes.ts:2-7` and `compactionUserContext.ts:12-14`
  and the budget in `compactionBudget.ts:57` are **not coordinated**: their maxima sum to ≈ 60,400
  chars (12,000 + 48×800 + 2,000 + 40×200) while `hostMaxChars` on this slot tops out at 17,145.
- Why this session still compacted successfully at 195,945: its actual host facts were well under
  the caps — ~5 verbatim user requests (~4.5k) and ~20 listed commands + 4 file rows (~3.2k),
  ≈ 8.5k total, against a 17,145 budget. F1 would not have refused that particular measured
  block. Whether F13 actually failed an earlier attempt is unknown without a failure row.
- Severity of F1 unchanged (High), but its reach is wider than first recorded: it needs the fact
  block near its caps, not a small window.

## Self-consistency check: the audit predicts its own next compaction

With F13 + F10 in place, this conversation's next automatic attempt is predictable: it will fire
at the next 85% crossing, the summarizer will produce a ~20–25k-char handoff, the ceiling at
170,000 is 21,250, and the attempt will fail and mute. The prediction is testable on the next
crossing: either a second `type: 'compaction'` row appears in
`C:/Users/efso office/.forge/sessions/8c170fd7-….jsonl`, or none does and the next compaction row
appears only above 176,608 tokens (88.3%). Recording the prediction before observing it, so the
observation is evidence rather than post-hoc.

## F13d — CONFIRMED (High, quantifies F13b): the summarizer request can never be fully accepted by its own ceiling

- The request invites `COMPACTION_REQUEST_OUTPUT_TOKENS = 16_384` output tokens
  (`compactionBudget.ts:7`, set by `b0abd8b`); the acceptance check is
  `summaryCeilingChars = max(8_000, policyTokens × 0.05 × 2.5)` (`:56`).
- At the repo's own measured 3.15 chars/token (`util/contextBudget.ts:48-50`, tokenizer-measured),
  16,384 tokens ≈ **51,610 chars**. The ceiling only reaches that at
  **policyTokens ≈ 413,000** — beyond any window Forge serves today.
- At a 200k slot the ceiling is 25,000 chars = **7,936 output tokens**, i.e. the request invites
  **2.06× what the next check will accept**. At a 32k slot the ceiling is the 8,000-char floor
  (2,540 tokens), inviting **6.4×**.
- So this is not a tuning gap that a bigger context escapes: the two constants are in a fixed
  2.06:1 ratio at every window size above the floor. Any model that writes a thorough handoff
  fails F13 deterministically; a model that writes a terse one passes. The failure is a property
  of the model's verbosity, not of the user's config.
- F13's throw at `CompactionService.ts:379` is therefore the *only* non-fatal option being
  declined: `capSummary` on `:384` truncates to exactly `summaryCeilingChars`, and
  `CompactionPolicy.test.ts:102-106` proves it produces a valid, marked-truncated summary. The
  guard converts "model wrote too much" into "compaction fails and, via F10, auto-compact goes
  quiet for the rest of the conversation".

## F11 — now repro-confirmed (was code-read only)

`test/unit/ZZ_scratch_f11.test.ts` (4 tests, pass), using the real `SendPipeline` +
`RequestChainLifecycle`:

| turn outcome | `evaluateAfterTurn` called? |
|---|---|
| `cancelled` | **no** |
| `interrupted` | **no** |
| `failed` with `CONTEXT_EXHAUSTED_MESSAGE` | yes (the carve-out works) |
| `completed` | yes |

This pins both halves: the gap for cancelled/interrupted, and the fact that the exhaustion
carve-out at `SendPipeline.ts:295-296` is the intended pattern an F11 fix would extend.

## F10c — CONFIRMED (High, worst consequence of F10): one failed attempt disables all three recovery paths at once

- Repro: `test/unit/ZZ_scratch_f10chain.test.ts` (1 test, pass), wiring the real
  `runCompaction`, `compactMidTurn` and `runAddressedAutoCompact` together.
- Sequence: one automatic attempt fails (in the wild this is F13's ceiling throw) →
  1. **mid-turn compaction** returns `false` on every later round (the mute answers
     `'skipped'`, so `MAX_MID_TURN_COMPACTIONS` is never even reached),
  2. **post-turn auto-compact** returns `undefined` — no compaction, no resume action —
     even with `incompleteTurnReason = 'context exhausted'` and `resume: true`,
  3. so the **context-exhaustion rescue** added by `SendPipeline.ts:295-296` cannot work:
     the carve-out deliberately routes exhaustion to this same policy, which is now muted.
- Net: `conv.compaction` stays `undefined` through all three, and the only trace is one
  ephemeral webview error notice (F12). The user's documented recovery — "Forge will compact
  and resume" (`midTurnCompaction.ts` / `truncationRecovery.ts` messaging) — is asserted to the
  user while the code path that would honour it is switched off.
- This is the reason F10 is High rather than Medium: it is not a retry-throttling detail, it is
  the single point of failure for every compaction recovery route, and the F13/F13d ceiling
  mismatch makes such a failure plausible for verbose output.

## F10/F13 interaction — the combined defect, stated once

If F13 (or F1 at the caps) makes the **first** automatic attempt fail at the configured 0.85 point,
F10 converts that failure into a conversation-wide mute of all three recovery paths.
F12 makes the mute invisible afterwards. Fixing only one of them leaves a real failure mode:
- fix F13 only → auto-compact works until any other transient failure arms F10;
- fix F10 only → the 85% attempt still fails, retries now allowed, so it burns repeated
  summarizer calls at a ceiling the model cannot satisfy (the exact 2026-09-22 regression
  `d97ab74` was written to stop);
- fix F12 only → diagnosable, still broken.
They need one coordinated change: the ceiling must accept what the request invites (or the throw
must yield to `capSummary`), the hold must decay/re-arm rather than persist, and a failed
automatic attempt must leave a durable row.

## Green baseline for the fix phase (measured at HEAD `b0abd8b`, 08:47)

`node node_modules\vitest\vitest.mjs run test/unit/CompactionPolicy.test.ts
test/unit/CompactionService.test.ts test/unit/MidTurnCompaction.test.ts
test/unit/SendPipeline.test.ts test/unit/ConversationOps.test.ts`
→ **5 files, 147 tests, all pass** (CompactionPolicy 8, ConversationOps 32, SendPipeline 31,
CompactionService 62, MidTurnCompaction 14). Any fix-phase regression is measured against this.

## F15 — measurement caveat that protects the F13 claim (recorded so it cannot be mis-cited)

The compaction row's `used_tokens` is read at `CompactionService.ts:436`, **after** the summarizer
call. If the summarizer's usage flowed into `last_input_tokens`, then 195,945 would be the
*post*-summarizer figure and the real trigger point would be much lower — which would weaken F13.
Checked: `applyUsage` (`transcriptMutations.ts:55-65`) is called only from
`turnServicesAssembly.ts:113-116` (`onUsage`), which belongs to the **turn** path;
`PromptRun.ts` contains no `usage`/`onUsage`/`last_input` reference at all, so
`runPromptToMarkdown` (the summarizer) never touches those counters.
Therefore 195,945 is the last real model round's usage and is the correct figure for the trigger
point. F13's arithmetic stands.

## F16 — CONFIRMED (Low, note): the remote `/compact` path is the manual path, so it is never muted — and never muted-cleared either

`src/remote/RemoteCommandHandler.ts:154-157` calls `context.host.compact(...)` with
`trigger: 'remote'`. `SlashCommandHandler.compactConversation` (`:302-311`) forwards
`options`, and `/compact` (`:161`) passes `{ auto: false }`. So a remote `/compact` runs with
`auto` false → bypasses `failedAutoAt` entirely (the intended design), and also never clears it,
since only an `auto` success reaches the `finally` delete at `CompactionService.ts:167`.
Net: a Telegram user can always rescue a conversation manually, but cannot re-arm automatic
compaction — the same asymmetry as F10b, reachable from the phone.

## F17 — CONFIRMED (Low-Med): the shrink guards post a "start a new chat" notice inside a live turn, and also arm the F10 mute

- `return 'failed'` appears at five points in `compactOnce`: `:205`, `:336`, `:392`, `:423`, `:480`.
  Every one of them arms `failedAutoAt` (`runCompaction`'s `finally`, `:166`).
- Two of them are the **shrink guards** (`:327-336` pre-summary floor, `:414-423` post-summary
  candidate), and both call `deps.post({ type: 'notice', message: refusalNotice(...) })`
  unconditionally — including when `options.auto === true` and `options.midTurn === true`.
  `refusalNotice` (`:118-124`) reads: *"…so the previous state was kept. Start a new chat, or
  remove large attachments, if this repeats."*
- So an automatic mid-turn compaction that cannot shrink injects a "start a new chat" instruction
  into the middle of a running turn. That is the same class of contradiction
  `docs/MID_TURN_COMPACTION_PLAN.md` was written to remove ("turn stopped" messaging during a turn
  that is still running), reached from the other side.
- `:392` (`isUsableSummary` rejection — the model answered with a tool-call-shaped blob) is a
  **per-attempt model behaviour**, not a config property, yet it arms the same conversation-wide
  mute. One bad summarizer response out of a long session is enough to disable auto-compaction for
  the rest of it. That is the cheapest path from F10 to a dead turn, and it is unrelated to F13.
- Guarded by `MIN_WINDOW_CHARS_FOR_FIT_GUARD = 24_000` (`:115`), so only substantial windows hit
  the notice path — which is exactly the long-session case.
- Coverage nuance (correcting an earlier draft of this finding): the notice itself **is** tested —
  `CompactionService.test.ts:970-977` asserts `'would not have reduced the context'` is posted for
  `{ auto: true }`. The untested part is the **mid-turn** variant: no test passes
  `{ auto: true, midTurn: true }` to a shrink-guard refusal, so nothing pins whether a "start a new
  chat" notice should reach the user (or the phone) inside a live turn. Severity stays Low-Med: the
  message is wrong for the context, not new behaviour.
