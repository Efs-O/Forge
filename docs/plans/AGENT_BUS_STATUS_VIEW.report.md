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

## State × lifecycle ledger

This feature adds no durable state. The watcher's bounded map is in memory only and clears on disposal or window reload. Route calls read existing conversation, queue, budget, and transcript state; they do not advance cursors or acknowledge bus messages.
