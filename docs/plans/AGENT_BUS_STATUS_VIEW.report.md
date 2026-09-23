# Agent bus status/view implementation report

## Phase 1 — pure modules and unit tests

- **Takeover:** Codex took over after the monitor detected condition (c): 30 consecutive read-only tool rounds (session rows 98–243) with no file edit or commit. Evidence was recorded at `C:/Users/efso office/.forge/agent-bus/outbox/qwopus-loop-evidence.md`; Qwopus was steered to stop and confirmed it had ended before implementation resumed.
- **Commit:** `fc6ecc8` (`feat(agent-bus): turn watcher, sender-scoped chat lookup, status/view renderers`).
- **Files and line counts:**
  - `src/agentBus/busTarget.ts` — 54
  - `src/agentBus/busTurnWatch.ts` — 128
  - `src/agentBus/busStatusView.ts` — 79
  - `test/unit/busTarget.test.ts` — 108
  - `test/unit/busTurnWatch.test.ts` — 74
  - `test/unit/busStatusView.test.ts` — 85
  - `docs/plans/AGENT_BUS_STATUS_VIEW_PLAN.md` — 487
- **Gate:** `npm run ci` exited 0. Summary: 318 test files passed, 5 skipped; 3,058 tests passed, 18 skipped. Type-check, lint, production build, and bundle-load check passed. `git diff --check` was clean.
- **Deviations:** none from Phase 1 requirements.

## Phase 2 — routes, wiring, client and docs

- **Takeover:** Codex completed the phase after Qwopus stopped. The monitor triggered takeover after the 30 read-only rounds described above.
- **Commit:** this report is included in the Phase 2 commit; see `git log` for its hash.
- **Files and line counts:**
  - `docs/plans/AGENT_BUS_STATUS_VIEW_PLAN.md` — 487
  - `docs/plans/AGENT_BUS_STATUS_VIEW.report.md` — 41
  - `docs/TODO-agent-bus-steer-and-queue-visibility.md` — 102
  - `src/agentBus/agentInbox.ts` — 222
  - `src/agentBus/busContent.ts` — 195
  - `src/agentBus/busStatusView.ts` — 79
  - `src/agentBus/forge.sh` — 113
  - `src/backend/agentRoutes.ts` — 398
  - `src/backend/controlHttp.ts` — 167
  - `src/vscode/agentMessagingSetup.ts` — 205
  - `test/unit/AgentBus.test.ts` — 264
  - `test/unit/AgentInbox.test.ts` — 272
  - `test/unit/AgentRoutes.test.ts` — 670
- **Gate:** `npm run ci` exited 0. Summary: 318 test files passed, 5 skipped; 3,064 tests passed, 18 skipped. Type-check, lint, production build, and bundle-load check passed. `git diff --check` was clean. `FORGE_ALLOW_VSIX_OVERWRITE=1 npm run package` exited 0 and packaged `forge-llm-0.16.36.vsix`; it was not installed.
- **Deviations:** `ForgeConversationSummary.activeModel` is `string | null` in the repository type, so the renderer accepts `null` as well as `undefined` and displays `default` for either. Live check §7 was skipped as explicitly instructed. No live-system output or behavior is claimed.

## Why Qwopus stopped — root cause (Claude, 2026-09-23)

The takeover above was right to fire, but the 30 read-only rounds were not a
model loop. From session `30b44107`:

1. **Config rejected.** `.forge/config.yaml` set `reasoning_effort: xhigh` for
   Qwopus, and the schema only allowed `high|medium|low|none`. One bad value
   fails the whole file, so Forge kept the last valid config: ctx **76,800**
   instead of the intended 131K, and the old model path (a hard link to the V2
   GGUF stood in for it). Fixed in `26b0449`.
2. **Compaction.** Qwopus was on track: it read the plan and 14 files, edited
   `busTarget.ts` and wrote `busTurnWatch.ts` in about 4 minutes. Those reads
   filled 65,530 of 76,800 tokens, and auto-compaction fired at 05:30:55.
3. **Re-reading.** The compaction summary was accurate: it listed the files
   read, both edits, and "next: write the Phase 1 tests". The file contents
   were gone, though, so Qwopus re-read the same files in the same order, which
   filled the small context again, and it then drifted into `agentMesh/`.

**Verdict:** not evidence that Qwopus V2 loops. Its second chance runs at 131K
after the reload that loads `26b0449`. Check the loaded context in `GET /models`
before judging the result.

## Qwopus V2 second chance — observations (Claude, 2026-09-23)

The run used the 131K context and the fixed config. Two tasks were given.

**MID_TURN_TELL Phase 2 (research task): good.** It made 53 tool calls in one
turn with no loop. All four mid-turn tell cases passed (see
`MID_TURN_TELL_PLAN.md` § "Phase 2 result"), and its Phase 4 inventory was
accurate and verified.

**MID_TURN_TELL Phase 4 (coding task), first attempt: a thinking loop. This is
a bad sign.**

- **What happened.** Chat `bcf86347` made 41 reads plus two line counts, then
  spent a single round thinking. It ran to the 16,384-token output limit
  (8.4 min, 84K characters) and ended with no tool call and no edit.
- **What it repeated.** Two sentences cycled 223 times:
  - "The plan's instruction to replace the list with a single pending row
    applies to the attachment-only case…"
  - "I'm realizing the `tell` prop is still necessary…"
- **What triggered it.** The model could not settle one open design question
  (whether task item 6 removes the `tell` flag). It neither decided nor asked,
  even though the task said "ask me instead of guessing".
- **Why it ran so long.** The V2 config entry had no `--reasoning-budget`. The
  Q6 entry has 8192 plus the budget message, and V2 was set up without them.
  This is now fixed: the entry has 8192 and `*reasoning_budget_message`, and
  the respawn was verified on the command line.
- **The cap contains the loop; it does not cure it.** A budget cuts the round
  off at 8K. It does not make the model resolve an ambiguity. This is a second
  failure shape, next to the overnight read loop: that one was context
  pressure, while this one is a genuine loop inside a single thought. Neither
  cause is reachable by prompting.

**Retry:** chat `c095313c`, with the cap live. The task is split into sidebar
first, then Telegram, and says "decide one item at a time". If it loops again
on a coding task, the verdict is that Qwopus V2 is fit for research and not for
unattended coding.

**Retry result: done, no loop.** One 49-minute turn produced the whole phase:
142 tool calls (54 reads, 42 edits, 10 CI runs), 23 files changed, CI green.
The largest single round was 12,958 reasoning characters, and it never reached
the cap.

- **Quality.** The removals were correct, and it kept everything the plan said
  to keep.
- **Not independent yet.** Its first review request had four defects, and
  Claude sent them back:
  - It resolved the same `tell` ambiguity it looped on, but the wrong way round.
  - It missed the matching Telegram split.
  - It left unreachable steer code in place.
  - It cited a skip-only test as proof of delivery.
- **Recovery.** Given the list, it fixed all four in one pass without looping.
- **Verdict.** It is a capable implementer under review, not an unattended one.

### Speed and quality compared with the Q6 (Claude, 2026-09-23)

| | Qwopus V2 Q5_K_M | Qwen3.8 Q6_K |
|---|---|---|
| Generation, short context | ~44 t/s | 21–25 t/s |
| Generation, 45–50K | 31–33 t/s | — |
| Generation, ~100K (this run, median) | 27 t/s | — |
| Prefill | 700–1,100 t/s | not measured here |
| Context | 131K | 198K |
| Research task (Phase 2) | clean, 53 calls | — |
| Coding task | one thinking loop (uncapped); retry clean, four review defects | — |

Generation is roughly double the Q6's, as the user observed. Quality at this
scale looks comparable, but the Q6 has not run this exact task, so this table
compares speed, not quality head to head. Tuning levers for the next run:

- `reasoning_effort` below xhigh. The Qwopus template accepts only `xhigh`,
  `medium` (its default) and `low`; `high` fails every request with HTTP 400
  (tried 2026-09-23 and reverted). The next step down is `medium`.
- The prompt re-read finding below, which is a Forge bug and not a model one.

**Where 10 minutes of the 49 went: full-prompt re-reads, caused by Forge.**
The llama-server log shows four rounds that re-evaluated the *entire*
~100K-token prompt, at 142–150 s each. Every one follows a `read_file` of a path
first read about 40 minutes earlier (`RemotePromptAdmission.ts`,
`RemoteCore.test.ts`).

- **The mechanism.** `supersedeStaleReads` (`src/agent/staleReadSupersede.ts`)
  replaces the earlier copy of the file with a notice. That rewrites the prompt
  at the first read (`f_keep = 0.425`).
- **Why it re-reads from zero.** On this hybrid model llama-server can only
  resume from a saved context checkpoint. The checkpoints all sat near the end
  of the prompt, so it reprocessed from token 0 rather than from the change.
- **Status.** This is the same family as the open turn-start re-read. It is to
  be planned together with it before 0.16.38.

## State × lifecycle ledger

This feature adds no durable state. The watcher's bounded map is in memory only and clears on disposal or window reload. Route calls read existing conversation, queue, budget, and transcript state; they do not advance cursors or acknowledge bus messages.
