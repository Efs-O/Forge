# File Size Watchlist

Snapshot: 2026-09-15, after `0c07237`. Line counts are raw (`max-lines` counts
blank lines and comments too). Regenerate before acting on it — the numbers drift
every commit.

The rule (CLAUDE.md → File Size Limit) is **concerns per file, not lines**. This
list is the smoke detector, not the verdict: split only where a real seam exists,
and a file on this list that does one thing may stay long with a stated reason.

## What is actually enforced

- `max-lines: 500` applies to `.ts`/`.tsx` under `src/` and `webview-ui/` only
  (`npm run lint` = `eslint src webview-ui --ext .ts,.tsx`).
- **CSS is not linted** despite CLAUDE.md naming `.css` — `webview-ui/styles/input.css`
  is already over.
- **Tests are not linted** for size. They are listed below for awareness, not as
  violations.
- `src/config/types.ts` and `src/config/schema.ts` are config schemas — CLAUDE.md
  exempts those as mechanical. They still trip the lint rule, so the day either
  crosses 500 it needs a deliberate disable with a reason, or a split by config
  section.

## Tier 1 — over 500 (lint failing or disabled)

| Lines | File | Notes |
|---:|---|---|
| 555 | `webview-ui/styles/input.css` | Not linted. Unexamined; CSS usually splits by component. |
| 518 | `src/remote/RemoteController.ts` | **Currently failing `npm run lint`** — uncommitted jobs/remote work from another session pushed it over. That work has to split it before it can land. |

## Tier 2 — at the cap (497–500): the next addition breaks lint

| Lines | File | Notes |
|---:|---|---|
| 500 | `src/sidebar/SlashCommandHandler.ts` | Candidate seam: the compaction entry points (`compact`/`compactConversation`) only forward to `runCompaction`; the `/initForge` prompt builder is a long template string. Unverified. |
| 500 | `src/sidebar/messageBridge.ts` | Discriminated unions. Natural split is host→webview vs webview→host types, as long as one import point remains (Architecture Rules: single typed bridge). |
| 500 | `src/sidebar/ToolDispatch.ts` | Unexamined. |
| 498 | `webview-ui/src/App.tsx` | Unexamined. |
| 497 | `src/sidebar/ModelTurn.ts` | Seam: the `prepareMessages` pipeline (compaction window → image aging → system prompt → turn context → tool-result excerpting) is one concern, ~50 lines, and every step is already its own module. |
| 497 | `src/config/types.ts` | Config schema — see above. |

## Tier 3 — close (450–496)

| Lines | File | Notes |
|---:|---|---|
| 477 | `src/sidebar/SidebarProvider.ts` | **Split done** (was 681 with lint disabled): host facade → `sidebarFacadeWiring.ts`, compaction closures + construction-time registrations → `sidebarWiring.ts`, `contextBudgetOf` de-duplicated onto `ContextBudgetPublisher.resolvedSnapshot`, four dead public methods removed. The disable is gone — keep new wiring out of it. |
| 494 | `src/agent/ToolCallingLoop.ts` | Pre-flight guards and truncation rows already moved to `truncationRecovery.ts` (0c07237). Remaining seam: request assembly (`base` → `mergeSampling` → `applyOutputCap` → `normalizeRequestForModel`, plus the fallback-tool message) as a `buildRoundRequest()`. |
| 489 | `src/extension.ts` | Activation wiring; uncommitted jobs setup is landing here too. |
| 483 | `src/remote/RemoteRequestStore.ts` | Unexamined. |
| 483 | `src/remote/RemoteRuntime.ts` | Unexamined. |
| 482 | `src/remote/RemoteVoiceBridge.ts` | Unexamined. |
| 459 | `src/remote/RemoteSelectionPager.ts` | Unexamined. |
| 457 | `src/config/schema.ts` | Config schema — see above. |
| 454 | `src/benchmark/orchestrator.ts` | Unexamined. |
| 452 | `src/system/PowerControl.ts` | Recent (Phase A2 power work). |
| 451 | `webview-ui/src/components/InputRow.tsx` | Unexamined. |

## Tier 4 — past the 350 soft threshold (400–449)

A reviewer should ask whether these are one concern. No action implied.

| Lines | File |
|---:|---|
| 442 | `src/sidebar/CompactionService.ts` |
| 437 | `src/tools/dirTools.ts` |
| 433 | `src/tools/execTools.ts` |
| 431 | `src/sidebar/AgentLoop.ts` |
| 431 | `src/remote/RemoteCommandHandler.ts` |
| 430 | `webview-ui/src/reducer.ts` |
| 429 | `src/sidebar/compactionLedger.ts` |
| 428 | `src/llm/OpenAIClient.ts` |
| 428 | `src/jobs/JobScheduler.ts` (uncommitted) |
| 426 | `src/backend/BackendPool.ts` |
| 416 | `src/tools/uxTools.ts` |
| 414 | `src/remote/TelegramChannel.ts` |
| 405 | `src/delegation/LocalDelegationService.ts` |

350–399 (soft threshold only): `webview-ui/styles/messages.css` 398,
`src/tools/videoExtract.ts` 387, `src/backend/DirectBackend.ts` 378,
`src/tools/builtinTools.ts` 378, `src/remote/RemoteAgentProgress.ts` 372,
`src/tools/BackgroundExecutionManager.ts` 372, `webview-ui/styles/tool-rows.css` 370,
`src/tools/lspTools.ts` 367, `src/tools/gitTools.ts` 363,
`src/llm/OllamaNativeClient.ts` 362, `src/sidebar/ConversationTabs.ts` 359,
`src/sidebar/sessionPersistence.ts` 358, `src/sidebar/SendPipeline.ts` 354,
`src/tools/execHelpers.ts` 354, `src/sidebar/sessionTypes.ts` 353.

## Tests over 500 (not enforced)

`RemoteCore.test.ts` 1440, `TelegramChannel.test.ts` 1007,
`CompactionService.test.ts` 952, `RemoteHardening.test.ts` 918,
`ToolDispatch.test.ts` 846, `RemoteSelectionPager.test.ts` 751,
`AgentLoop.test.ts` 743, `ControlServer.test.ts` 737, `BackendPool.test.ts` 726,
`ConfigLoader.test.ts` 629, `sessionTypes.test.ts` 614, `videoExtract.test.ts` 590,
`ImageSearchTool.test.ts` 538, `UserQuestion.test.ts` 534,
`VisionHistoryStrip.test.ts` 513, `RemoteCommandCleanup.test.ts` 509,
`localAgentTool.test.ts` 500 — all under `test/unit/`. A 1,440-line test file is
hard to navigate, but split it by `describe` block only when someone is working in it.

## Suggested order

1. `RemoteController.ts` — blocks CI; belongs to whoever lands the jobs/remote work.
2. The Tier 2 files, as each is next touched. Any feature that adds lines to one of
   them pays for its split in the same change.
3. ~~`SidebarProvider.ts` collaborator factory~~ — done.
4. Decide on CSS: either lint it or drop `.css` from the CLAUDE.md rule.

## Regenerate

```powershell
git ls-files -co --exclude-standard -- 'src/*.ts' 'src/*.tsx' 'src/*.css' 'webview-ui/*.ts' 'webview-ui/*.tsx' 'webview-ui/*.css' |
  ForEach-Object { [pscustomobject]@{ Lines = (Get-Content $_).Count; File = $_ } } |
  Where-Object Lines -ge 350 | Sort-Object Lines -Descending
```
