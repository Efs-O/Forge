# Compaction recovery, direct Telegram file send, and audit fixes

Status: approved by the owner for Copilot implementation and Codex supervision on 2026-10-04.
The finding-level fix list is in
`C:/Users/efso office/.forge/agent-bus/audit-2026-10-04-fix-spec.md`.
Findings and evidence: `docs/reports/DEEP_AUDIT_2026-10-04_FINDINGS.md`.
Baseline HEAD `b0abd8b`. Green baseline 147 tests (CompactionPolicy 8, ConversationOps 32,
SendPipeline 31, CompactionService 62, MidTurnCompaction 14).

Implementation progress: phase 0 is committed as `8cdab83`; phase 1 direct-send
is committed as `c7be4e9`. Phase 2's bounded retry policy and recovery-path tests
are implemented and awaiting its full-CI-gated commit. Phase 1's CLI-to-route
test exercises bearer authentication through `forge.sh`, while the runtime
fake-channel test verifies exact bytes, bound-chat delivery, refusal gates, and
ambiguous-send handling without creating a model turn.

Retry-policy contract (supersedes the flat two-failures limit): one transient
failure (`model-error`/`unknown`) allows an immediate second attempt; after that
automatic compaction is held until context grows by `max(1024, 2% of slot)` tokens
or a 30 s cooldown (doubling, 5 min cap) elapses. Deterministic categories
(`budget-refusal`, `invalid-summary`, `incomplete-output`) rearm on context growth
only, so they cannot retry-storm. Success of any trigger clears the hold. Phase 5
persists the same categories in `SessionLogger`.

Phase 5 (F11/F12/F17, A24, A46–A50): every compaction attempt writes a
`compaction_attempt` row (`start`, then `finished` or — for a policy hold —
`suppressed`) sharing one `attemptId`, with trigger, category, call count, finish
reason and context size, and never any source or summary text; an unmatched
`start` identifies a crash. Holds are in-memory by design, so a reload re-admits
automatic compaction. F11: `ContextBudgetPublisher.evaluateAtAdmission` enforces
`auto_compact.at` on prior history before the next non-internal prompt runs
(trigger `admission`, no resume), covering stopped, interrupted and reloaded
turns; Stop itself never compacts. F17: a mid-turn refusal says the turn
continues instead of advising a new chat. A24 regression: heavy recorded actions
at P=170,000 refuse before any model call with `conv.compaction` unchanged (the
fixture's exact size is whatever the real renderers produce; it does not
reproduce the 20,674-character figure byte for byte). A46: `AGENTS.md` and
`CLAUDE.md` carry the `send-file` text but are gitignored, so it cannot appear
in a commit. Tests: `CompactionAttemptLog.test.ts`, `CompactionAdmission.test.ts`,
`CompactionHostFit.test.ts`.

Phase 4 (F1): `compactionHostFit.ts` sheds optional facts (repo state → memory keys →
last reply) against the real rendered host block before refusing; required user
requests and recorded actions are never shed, and a refusal names the largest
component before any model call or mutation. Staged summaries also pin every
file identifier from the recorded facts and an ordered user-request manifest, or
refuse. Tests: `CompactionHostFit.test.ts`, `CompactionStaged.test.ts`.
`CompactionService.ts` contract types moved to `compactionServiceTypes.ts`
(re-exported) to stay under the 500-line limit.

Phase 3 output contract: request `max_tokens` = visible target + reasoning reserve
(thinking and prose share one budget), bounded by the provider cap and counted once
in request-fit checks (`planOutput`). Length-stopped output is never stored; it
falls back to staged compression. Staged note size is derived from the whole summary
budget over the chunk count. Coverage: `test/unit/CompactionStaged.test.ts`
(synthetic 400k/200k only; **no live 400k verification**).

## Scope

| # | Finding | Change |
|---|---|---|
| 1 | verdict loss | `meshVerdictPoll.ts` keeps only `slice(0,500)` then unlinks the full file |
| 2 | F6 | Clear Chat retains stale `compaction` state → first new message hidden |
| 3 | F10 (+F16) | one failed automatic compaction mutes all three recovery paths |
| 4 | F13 | generated-summary allowance vs nominal ceiling vs whole-replacement budget |
| 4a | F13 length stop | a nonempty summary at `finish_reason=length` can be incomplete; the 16,384-token request cap was reached live |
| 5 | F1 | per-block host-fact caps exceed `hostMaxChars` |
| 6 | F8 | a claim whose settle fails leaves `running` forever and jams the queue |
| 7 | direct file send | `forge.sh send` only relays agents; `send_file` needs a model turn, which can itself trigger compaction |
| 8 | F11 | a cancelled/interrupted turn skips the post-turn context check, including during reload |
| 9 | F12 | failed compactions and their generation stop reasons leave no durable diagnostic row |
| 10 | F17 | a failed automatic mid-turn shrink can tell the active agent to start a new chat |

No fix in this plan: F2, F4, F5, F7, F9. F11/F12/F17 are included because the
owner wants a complete recovery path and a live verification of why an attempt failed.

## State × lifecycle ledger

Every row is state or a budget this plan changes. Each lifecycle cell is an implementation
obligation; in-memory and source constants are identified explicitly.

| Artifact | create | delete | pause / disable | crash mid-write | owner-process death | TTL / expiry |
|---|---|---|---|---|---|---|
| `conv.compaction` (persisted JSON, `sessionPersistence.ts`) | written only after the candidate is proven smaller (`CompactionService.ts:430`) | Clear Chat clears it (F6) — `ConversationOps.test.ts` "clear chat"; reload — `sessionPersistence` round-trip test | `auto_compact.enabled:false` / `resume:false` leave it untouched — `MidTurnCompaction.test.ts` policy rows | never mid-write: assignment is one synchronous field set, persist follows — no partial state possible; assert `compaction` is `undefined` when any guard refuses — F1/F13 refuse tests | reload restores it unchanged — existing persistence test + new F6 reload assertion | none by design; generations replace in place |
| `last_input_tokens` / `last_output_tokens` (persisted counters) | `applyUsage` per model round | Clear Chat resets them (F6) — assert after `opClearMessages` | n/a | n/a | survive reload by design (`sessionPersistence.ts:140`) | reset by `opResetReportedContext` after compaction |
| automatic-compaction hold (`failedAutoAt`, in-memory `WeakMap`) | set on `'failed'` from an `auto` attempt | cleared by any **automatic success** and, new, by any **manual or remote success**; and by attempt-count/time decay — `CompactionService.test.ts` hold rows | `auto` attempts only; manual never sets and never reads it | lost on reload by design (WeakMap on the runtime object) — assert a reload re-arms — `ConversationTabs`/persistence path | same as reload | new: bounded attempts per visible-user turn, so a transient failure recovers mid-turn — F10 tests |
| verdict artifact (new file in agent-bus folder) | written by `meshVerdictPoll` before the event is recorded — `meshVerdictPoll.test.ts` "verdict > 500 chars" | removed only after authenticated read/ack; an unacknowledged artifact is retained and surfaced for cleanup review | orphan verdicts still discarded with the existing warning — "orphan" test | atomic tmp+rename, then idempotent event append under the exchange lock; a crash between them is reconciled on restart | a second window polling the same file must not lose it — "duplicate polling" test | acknowledged artifacts follow bus retention; unacknowledged artifacts are not silently expired |
| remote request record (`running` / `queued`, shared state file) | claim sets `running` with owner/epoch under the state lock | settle writes terminal state | drain disabled while a record is `running` **for the same claim owner** | crash between claim and settle → recover only after proving owner dead — F8 "crash/restart" | a second window's `load()` must not mark a live claim unknown — F8 "concurrent windows" test | no fixed-age expiry of `running`; recovery uses owner liveness |
| compaction budget constants (source, not state) | n/a | n/a | n/a | n/a | n/a | one owner per cap; caps derived from `policyTokens`, not independent literals |
| compaction attempt record (`SessionLogger`, durable JSONL) | append start and terminal rows under one attempt ID, with trigger, reported/estimated usage, candidate/replacement sizes, finish reason and failure category; no transcript or secrets | normal session-log retention only | record a distinct policy-suppressed decision when a threshold is crossed but the hold blocks an attempt | an unmatched start row after a crash remains diagnosable; a log-write failure must not change the compaction result and must raise a local warning | existing rows survive reload and distinguish policy suppression from attempted failure | same retention as existing session logs |
| direct file send (no new durable queue) | authenticated request selects one existing Telegram binding; resolved file is read and sent through the active transport | no new stored artifact; user owns the source file | disabled remote, unbound chat, expired auth, unavailable transport, or ambiguous binding refuse before send | crash before transport acceptance yields no success response; crash after acceptance but before response is explicitly ambiguous and manual retry may duplicate | no resume/replay of an uncertain file send; a new request revalidates binding and file | no retained command grant or file copy; existing Telegram servers retain delivered document |

## Phases

0. **Split `CompactionService.ts` (498 lines, hard stop 500).** Move the automatic-attempt policy
   (`runCompaction` wrapper + `failedAutoAt`) and the budget/refusal helpers into their own
   modules at existing seams. No behaviour change. Existing 62 tests stay green.
1. **Direct file send (recovery milestone).** Add `forge.sh send-file <sender> --to
   <conversation-id> <workspace-relative-path> [--caption-file <file>]` and an authenticated
   `POST /agent/send-file` route with a strict Zod request schema. The command must bypass
   the Forge inbox and model entirely;
   wire `AgentRoutes` through a lazy `activeRemoteRuntime` callback in `extension.ts`, so
   startup ordering and remote disable/reload are checked at call time. Put destination
   selection and active-lease checks in `RemoteRuntime`, the transport lifecycle owner;
   it must not call `send_file` as a model tool. Reuse the existing sender validation, live
   conversation lookup, realpath-aware workspace containment, 50 MB file limit, 1,024-code-point
   caption limit, remote binding, `RemoteAuth.canDeliver`, and Telegram transport's
   `sendPhoto`/`sendDocument` implementation. Require the sender's established Forge chat
   to match `--to`; require exactly one active Telegram binding for that chat in this
   workspace. Do not accept a caller-supplied Telegram chat ID. The active transport must
   own its lease. Await the Bot API result and report `sent` only on acceptance; errors and
   ambiguous transport outcomes must be explicit. No direct Bot API call, copied token,
   unguarded JSON-state edit, or second MIME/upload implementation. Refactor shared file
   validation from `sendFileTool.ts` if needed, while keeping its screenshot-directory
   exception tool-only. Document that a retry after an ambiguous crash may duplicate a file.
   Teach Codex and Claude the verb through the generated `forge.sh` usage header and
   `BUS_README` (both written by Forge on startup), plus `AGENTS.md` and `CLAUDE.md` where
   those agents learn the mesh workflow; distinguish `send-file` from agent relay `send`.
   Update the client/README again for `read-verdict` and `ack-verdict` in phase 8.
2. **F10/F16 (recovery milestone).** Hold becomes bounded and re-arms; manual + remote success clears it; the three
   recovery paths stay coherent. Deterministic-failure protection retained.
3. **F13 and length stop (recovery milestone).** Coordinate generation allowance, visible
   summary allowance, host facts, tail and the 10%-of-P whole-replacement limit. Propagate
   summarizer `finish_reason` to the compaction caller (a typed result or a dedicated typed
   length error); preserve existing non-compaction prompt behaviour. Treat every `length`
   stop as incomplete, even with nonempty visible prose. Never persist that candidate.
   Use a one-shot summary only when the estimated source and output fit with a safety margin;
   send a near-full 200k source directly to staged compression so the known five-minute
   16,384-token failure is not repeated on every attempt. On a length stop, missing/unknown
   finish reason, or oversized complete draft, use bounded staged compression: partition the full
   source into ordered chunks sized from the model's usable slot, with no unexamined gap;
   extract bounded notes for each chunk; then synthesize them with pinned host facts,
   previous summary and the exact pending action. At large slots, assemble the validated
   section notes plus a short cross-chunk index as the final summary; do not require one
   model response to emit the whole replacement. Derive each generation cap from its
   allocated visible section budget, reasoning reserve, provider limit and remaining slot
   room, rather than carrying the 16,384-token request cap as a universal constant.
   Bound chunk count, model calls and total
   generated tokens per compaction attempt; refuse if the source cannot be covered within
   those bounds. Validate Goal, State, Next, Files, Constraints and Errors, the required
   evidence manifest (user requests, recorded actions, file/state identifiers) and the
   original exact pending action. If the final request reaches `length`, has no trustworthy
   completion signal, or the result
   loses required facts, or the complete replacement exceeds its budget, refuse with an
   actionable notice and leave the old compaction untouched. Do not use `capSummary` to cut
   off the tail or simply increase the request cap to 32k. Bound model calls per attempt and
   coordinate with F10 so a failure neither storms nor permanently disables auto recovery.
   Do not silently lose an earlier chunk or trust an incomplete first-pass draft as the sole
   evidence. Compare the whole replacement, including host facts and tail, against the
   10%-of-P budget before changing `conv.compaction`. Use the effective **per-conversation
   slot** (`num_ctx / n_parallel`), not the total server allocation, for every threshold,
   request-fit and replacement calculation.
4. **F1 (recovery milestone).** Derive every host-fact cap from one budget owner. The caps are
   individual maxima, not a promise that simultaneously maximal optional blocks fit. Allocate
   room to required facts first; omit or shorten optional facts with an explicit marker. If
   the required facts alone exceed the available host budget, refuse before mutating existing
   state and name the limiting component. Test actual rendered facts, not the nominal maxima.
5. **F11/F12/F17 (recovery milestone).** On next turn admission after reload or interruption,
   check the reported context before the next model request; do not launch a fresh model
   round into an already over-threshold window. Use the existing policy lock and trigger
   identity so admission, mid-turn and post-turn checks cannot duplicate one attempt.
   Preserve Stop semantics: do not resume or
   compact after the user deliberately cancels. Log each compaction attempt's terminal
   outcome and finish reason to the existing session JSONL, without logging source text or
   secrets; append a start row before generation and a terminal row after it, and classify
   policy suppression separately from attempted failure. Use a context-appropriate
   refusal notice during a live mid-turn attempt, never a false instruction to abandon the
   chat while the turn continues.
6. **Recovery VSIX.** Replace the relevant scratch repros with permanent tests, run CI and
   package, obtain Codex review, commit, install the VSIX, then have the owner reload. Verify
   a successful compact and resumed turn in the existing Forge conversation before declaring
   recovery. Verify `send-file` on a bound Telegram chat without a model turn, and distinguish
   Telegram acceptance from the owner's receipt. The current failed attempt must never be
   treated as a valid summary.
7. **F6.** `opClearMessages` clears `compaction` and the reported-context counters, keeps
   `active_model`. Regression through the real `applyCompactionWindow` path.
8. **Verdict loss.** Write the full verdict atomically as an exchange-scoped artifact and
   append only a bounded pointer to the exchange log. Add `forge.sh read-verdict <exchange-id>`
   and a separate `forge.sh ack-verdict <exchange-id>` so a lost read response cannot delete
   the only full copy. A recipient reads, verifies, then acknowledges. Coordinate competing
   pollers with the exchange log
   lock and an idempotent event ID; recovery must find an artifact written before its event
   and append the missing event once. A terminal log event alone is not a read receipt.
   Test >500 chars, consumption, duplicate polling, crash/restart, and orphan handling.
9. **F8.** Add an owner/epoch identity to each running claim, tied to the active transport
   lease; perform claim and settle under the existing remote-state lock. After a failed
   settle, retry/reconcile the same record before claiming its successor; if persistence is
   unavailable, stop that conversation's drain with a visible error rather than leaving an
   invisible permanent `running` block. On load, recover a running record only after its
   owner is proven dead; a live window's claim must remain running. Preserve order and
   the documented at-least-once delivery bound, including a crash after the external send.
10. Replace all remaining `test/unit/ZZ_scratch_*.test.ts` with permanent regressions; correct the report's
   categorical causal language and its ripgrep-timeout diagnosis.
11. **Supervised release.** Copilot implements only after owner approval. Codex reviews each
   phase against this plan and the working diff, checks source ownership and durable-state
   transitions, and requests corrections before accepting it. Each implementation phase is
   its own scoped commit with `npm run ci` green, per `AGENTS.md`; release checkpoints have
   no code commit. Run focused tests, then final
   `npm run ci`, `npm run package`, `git diff --check` and status after the last edit; commit
   only reviewed files. Phase 6 installs the recovery VSIX; install the final VSIX after
   phases 7–10, then ask the owner to reload VS Code again. A successful build alone
   does not establish live recovery.

## Live 16,384-token failure, 2026-10-04

The Strata summarizer request correlated with the failed compaction at reported 176,429/200,000
had a 122,081-token prompt and generated exactly 16,384 tokens in 307,871 ms. Forge then
reported `Summary exceeds the estimated 22053-character ceiling`. The request/output logs
do not share a durable request ID, so this is a sequence correlation, not proof of its exact
finish reason. `PromptRun.ts` currently throws on `finish_reason=length` only if reasoning
consumed the budget and visible content is empty; nonempty incomplete prose can be returned.
The 16,384 generation tokens include thinking. Raising the cap to 32k alone could double
generation time and still leave a partial or oversized handoff. See
`C:/Users/efso office/.forge/agent-bus/audit-2026-10-04-length-observation.md`.

## Direct-send command contract

`forge.sh send-file codex --to <conversation-id> docs/plans/COMPACT_CLEAR_REMOTE_VERDICT_FIXES_2026-10-04.md`
is the initial live use case. The caller names a workspace-relative existing regular file;
the host resolves its real path under this window's workspace and rejects symlink/junction
escape, empty files, files over 50 MB, missing/archived/foreign sender conversations,
multiple or absent Telegram bindings, and disabled/unavailable/unauthenticated Telegram.
The command receives no arbitrary chat ID or bot token. The optional caption comes from a
file so shell quoting cannot reinterpret its contents, and is limited to 1,024 Unicode code
points. The route returns a structured outcome only after the Telegram transport resolves:
`sent` means the Bot API accepted the document; a timeout or lost response is `unknown`,
never `sent`. It never creates a Forge turn or touches its context, hold, or compaction state.
No automatic retry follows an `unknown` outcome because Telegram has no idempotency key for
the document call; the caller decides whether to retry. This command is intended for a
trusted, authenticated local agent acting on the owner's explicit file-send request, and
must not expose a general arbitrary-chat or external-path exfiltration endpoint.

## Acceptance criteria

Each row maps to a test or a named manual step. Invariants first, then edge cases.

| # | Invariant / edge case | Verification |
|---|---|---|
| A1 | A verdict longer than 500 chars survives polling in full | `test/unit/MeshVerdictPoll.test.ts` "preserves a verdict longer than the event-detail cap" |
| A2 | The sole full copy is never deleted before an authenticated recipient reads and acknowledges it | same file plus `AgentRoutes.test.ts`, "read verdict then acknowledge" |
| A3 | Two windows polling one verdict: exactly one terminal event and one readable full artifact | same file, "duplicate polling" |
| A4 | A verdict file removed between listing and reading is skipped, not fatal | same file, "unreadable verdict" |
| A5 | An orphan verdict (unknown/terminal exchange) is discarded with the existing warning | same file, "orphan verdict" |
| A6 | Exchange-log event detail stays bounded; a crash after artifact rename and before event append is recovered once | same file, pointer bound and restart injection tests |
| A7 | Clear Chat removes `compaction` and the reported-context counters | `ConversationOps.test.ts` "clear chat also clears compaction state" |
| A8 | Clear Chat preserves the pinned `active_model` and Keep/Undo semantics | same file, existing pinned-model rows still green |
| A9 | The first new user message after Clear Chat reaches the model | new test through `prepareModelTurnMessages`/`applyCompactionWindow` with a non-zero old `fromIndex` |
| A10 | A later `/compact` after Clear Chat summarizes only new messages, never the old summary | same test asserts the second window contains no old summary text |
| A11 | One failed automatic attempt does not permanently mute automatic compaction | `CompactionService.test.ts` "transient failure then success in the same visible-user turn" |
| A12 | A deterministic refusal still cannot produce a retry storm | same file, "repeated deterministic refusal issues at most N summarizer calls" |
| A13 | A successful manual `/compact` clears the automatic hold | same file, "manual success clears the hold" |
| A14 | A successful remote `/compact` clears the automatic hold | same file, `trigger: 'remote'` variant (F16) |
| A15 | An internal resume/nudge prompt never counts as a new visible user request | same file, existing internal-prompt row retained |
| A16 | One failure must not disable all three recovery paths | new test replacing `ZZ_scratch_f10chain`: mid-turn, post-turn and exhaustion rescue each still able to act |
| A17 | `MAX_CONSECUTIVE_AUTO_CONTINUES` bound and no duplicate resumptions preserved | `autoCompactionPolicy` tests unchanged and green |
| A18 | A 22,076-char candidate at P=170,000 is accepted when the whole replacement fits | `CompactionPolicy.test.ts` / `CompactionService.test.ts` boundary rows at 170,000 and 176,608 |
| A19 | The same candidate is refused when host facts and tail consume the room, without mutating prior state | same tests assert `conv.compaction` unchanged and a refusal naming the limiting component |
| A20 | Thinking-heavy output is accounted for; generation tokens are not treated as visible-summary tokens | new budget test with a reasoning reserve at P=170,000 |
| A21 | No silent truncation of final findings or Next | test asserts a refused candidate is never stored, and any accepted candidate's summary keeps required findings and the exact pending action in Next |
| A22 | Source and replacement sizes are labelled estimates until provider usage confirms them | existing `budget.estimated` rows plus a new assertion on the log/notice wording |
| A23 | Required host facts fit or cause an explicit refusal at every slot size; optional caps share the remaining budget | new rows for 8k/16k/32k/64k/128k/200k with a substantial verbatim user block |
| A24 | A constructed 20,674-char host block at P=170,000 refuses and leaves the old state intact | new 200k regression with real `RecordedCompactionAction` objects, repo state, memory keys |
| A25 | A case that must compact does so without losing required facts (user requests, actions, Next) | paired positive regression with a smaller host-fact fixture than A24; do not claim the impossible A24 fixture fits |
| A26 | Persisted compaction schema stays backward compatible | `compactionPersisted`/persistence tests unchanged and green |
| A27 | A failed settle leaves the record recoverable, not permanently `running` | `RemoteRequestStore`/`RemoteQueueDrain` test with an injected settle failure |
| A28 | Later queued work for the same conversation proceeds in order after a failed settle | same test asserts the next queued record is claimed and its order |
| A29 | A legitimately long active request in another window is not stolen, including during `load()` | new ownership/liveness test; no fixed-age expiry of `running` |
| A30 | Restart recovers a stranded `running` record after its owner is proven dead | existing `load()` behaviour test extended to the injected-failure case and the live-owner countercase |
| A31 | Duplicate delivery stays bounded by the existing at-least-once contract | existing outbox/abandoned tests unchanged and green |
| A32 | Disposition-before-ack/cursor ordering preserved | existing ordering tests unchanged and green |
| A33 | No `.ts` file exceeds 500 lines; nothing above 350 is left unsplit at a real seam | `npx eslint <file>` per changed file |
| A34 | Prettier clean | `npx eslint --fix` then `npm run lint` |
| A35 | Scratch repros are gone; every finding has a named permanent test file | `rg --files test/unit | rg 'ZZ_scratch_'` returns no matches; coverage map in the report updated |
| A36 | Full gates green | `npm run ci` then `npm run package`, exact counts reported |
| A37 | Report's causal language corrected; rg-timeout diagnosis corrected | manual read of the two report sections |
| A38 | A nonempty summary ending in `finish_reason=length` is never stored | `PromptRun` and `CompactionService` regressions with nonempty prose and a length stop |
| A39 | A thinking-heavy 16,384-token output can recover through bounded staged compression or explicitly refuse; a near-full source chooses staging first | injected result sequence verifies the call bound, preserved prior state on refusal, and no retry storm |
| A40 | A complete oversized result is compressed to fit only when all required facts survive | fixture with multiple findings and an exact Next action; assert full replacement <= 10% of P, otherwise refuse |
| A41 | Live recovery is verified after VSIX install and reload in the existing Forge chat | record package/install result, user reload, actual compaction outcome and resumed turn; if live test cannot run, report the risk rather than claiming success |
| A42 | `send-file` starts zero model turns and sends the exact Markdown bytes to the bound Telegram chat | `AgentRoutes.test.ts` + `RemoteRuntime`/fake-channel integration; assert zero inbox accepts, zero compaction attempts, one document send and exact bytes |
| A43 | Wrong token/sender, foreign or archived conversation, unbound/multiple chat, disabled transport, expired auth and bad caption all refuse before upload | route/runtime tests with each gate and zero channel calls |
| A44 | Missing/empty/oversized/non-regular file and symlink/junction escape refuse; real in-workspace Markdown uses `sendDocument` | shared file-validator tests plus `TelegramPhoto.test.ts`; no caller-supplied chat ID or token is accepted |
| A45 | A Telegram failure or ambiguous timeout is never reported as `sent`, and no automatic resend occurs | injected channel failure/timeout test; verify a deliberate second CLI call is the only retry |
| A46 | Codex and Claude see the command and its no-model-turn semantics | `AgentBus.test.ts` asserts generated `forge.sh` header and `BUS_README`; inspect `AGENTS.md` and `CLAUDE.md` instructions; regenerated bus files match shipped text |
| A47 | A stopped turn stays stopped; next admission after reload at >=85% checks context before model generation | `SendPipeline.test.ts` and admission-path test for completed, cancelled, interrupted and reloaded conversations; update the old assertion deliberately |
| A48 | Every attempted compaction has start and terminal diagnostic rows under one ID, including length stop and refusal; a crash leaves a recognizable unmatched start, and a policy hold is a distinct decision | `SessionLogger` and `CompactionService` tests; no source text or secrets, old session rows still parse, log-write failure cannot corrupt `conv.compaction` |
| A49 | A multi-chunk source has no uncovered gap or forgotten first/last chunk; exhausted call/chunk bound refuses without mutation | staged-summarizer fixtures at 200k with sentinel findings in first, middle and final chunks, plus bounded-failure case |
| A50 | Mid-turn shrink refusal gives an accurate active-turn notice | `CompactionService.test.ts` automatic mid-turn refusal test, plus manual/post-turn variants |
| A51 | An older remote-state file without claim-owner fields loads and migrates without stealing a live claim | `RemoteRequestStore` schema/migration tests across two windows |
| A52 | `read-verdict` returns the full body without deleting it; only a separate authenticated `ack-verdict` permits cleanup | `AgentRoutes.test.ts` with lost response, retry, wrong token/sender, duplicate read and crash-before-ack cases; `AgentBus.test.ts` documents both verbs |
| A53 | A null/unknown summarizer finish reason is never assumed complete, and admission/mid-turn/post-turn cannot start duplicate compactions | `PromptRun`, `CompactionService`, `SendPipeline` and policy-lock tests |
| A54 | At a simulated 400k per-conversation slot, the 85% trigger is 340k and the whole replacement fits <=34k estimated tokens without one generation needing to produce it all | synthetic budget/staged-summarizer tests with a source spanning first, middle and final chunks, thinking-heavy finishes and required facts in each; live 400k validation deferred because this model is unavailable |
| A55 | A 400k server allocation with two parallel slots is treated as 200k per conversation, with a 170k trigger and <=17k replacement | per-slot policy and staged-summarizer regression; no 340k trigger on either chat |

## Known limitations carried forward

- Earlier failed attempts behind the 97.97% firing have no durable log, so F13+F10 remains
  the strongest explanation, not proof. New diagnostics make future attempts auditable;
  they cannot reconstruct events that were never recorded.
- Telegram's document API has no request idempotency key. A direct send whose response is
  lost after acceptance is ambiguous; an explicit retry may deliver the document twice.
- A model cannot prove semantic completeness of arbitrary prose. The staged compactor
  preserves deterministic host evidence, checks structural coverage and required IDs,
  and refuses when it cannot establish a safe replacement within its bounded work.
- A configured 400k total context is only 400k for one chat when the backend gives that
  chat the full slot; parallel slots divide it. The 400k acceptance case assumes an actual
  400k slot and a provider able to handle the bounded chunk requests. The owner confirmed
  that a live 400k model is unavailable now; do synthetic tests and report this live gap.
- `exec_command` leaving child stdin open (the rg timeout) is out of this set unless it blocks
  these tests.
