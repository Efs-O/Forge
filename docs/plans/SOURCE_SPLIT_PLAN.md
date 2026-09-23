# Source Split Plan

Status: Phase 0 done 2026-09-23 (watchlist deleted, CLAUDE.md CSS rule fixed);
phases 1–3 handed to Qwopus.

## Scope and baseline

This plan supersedes `docs/plans/FILE_SIZE_WATCHLIST.md`. Phase 0 deletes that watchlist so there is one size-planning source of truth. Repository evidence is committed `main` HEAD `4bdea5e04cbdc25a6d450735fa619ba6da9081a8`; watchlist commit is `9ab7cc6fcbd42ffcd6fa8bdbad6b204520e7eb02`. At initial inspection, Qwopus had working-tree edits in `src/llm/types.ts`, `ModelTurn.ts`, `SessionLogger.ts`, `sessionTypes.ts`, and `turnContext.ts`; they were not counted as the committed main baseline. The untracked `docs/plans/CLAUDE_STAND_IN_RESUME_PLAN.md` was read as the upcoming-work specification. No repo changes are part of this plan edit.

Physical-line inventory, counted from committed source, covers `src/**/*.ts`, `webview-ui/src/**/*.{ts,tsx}`, and webview CSS. The ESLint max-lines rule applies to TS/TSX under `src` and `webview-ui`; CSS is presently not linted. Every file at 480 lines or more is inventoried below with focused concern boundaries. Ranges are committed-HEAD line ranges; names identify the functions/blocks to inspect when the phase begins.

**Re-anchored by Claude on 2026-09-23 against `main` f8ab0e5**, after prefix rewrites (4bdea5e, ed70101, ad88a86) and the single-view merge (1ea94c6). The merge took `SidebarProvider.ts`, `RemoteRuntime.ts` and `RemoteRequestStore.ts` to exactly 500 lines and `messageBridge.ts` to 497. Their diffs (`git diff cc617e2 1ea94c6`) are new methods and wiring, not compression, but all three now have zero headroom, and the rows below name where their next growth goes. Line ranges in the table are starting points: every phase re-anchors before editing.

## Superseded watchlist decisions

Every candidate in the 2026-09-15 watchlist has been carried forward and decided:

- `SlashCommandHandler`: **REJECT split.** `compact()` and `compactConversation()` (lines 485–500) only forward to `runCompaction`; the long `/initForge` template is prompt content, not independent execution logic. Keep both in the existing owner `src/sidebar/SlashCommandHandler.ts`; growth in compaction execution belongs in `src/sidebar/CompactionService.ts`, and prompt text can move only if it becomes an independently parameterized prompt owner.
- `messageBridge`: **REJECT split.** It is the typed host↔webview protocol contract. Its two directions may be physically separated only if `messageBridge.ts` stays the sole import/re-export point. Current consumers and import topology must be checked before any change; phase single-view work uses the existing boundary without splitting it.
- `ModelTurn`: **VERIFY and SPLIT.** `runModelTurn` currently builds a `buildToolDefinitions` closure and a `prepareMessages` pipeline (compaction window, image aging, system prompt, turn context, tool-result context) before invoking `runToolCallingLoop`. The preparation pipeline is a real already-composed seam. Phase 1 extracts it with explicit parameters (contract below).
- `ToolCallingLoop`: **VERIFY and SPLIT.** `runToolCallingLoop` has a round-request assembly block: fallback tool instructions, native tool selection, `ChatCompletionRequest`, `mergeSampling`, output cap, and model normalization (currently roughly lines 204–237; re-anchor at phase start). Extract as `buildRoundRequest` with explicit inputs (contract below).
- CSS linting: **RECOMMEND drop `.css` from CLAUDE.md’s hard file-size rule.** CSS is deliberately excluded from `eslint src webview-ui --ext .ts,.tsx`; adding a separate CSS line-count gate would enforce a physical-line proxy rather than concerns and would create a second lint mechanism. CSS remains inventoried and component styles should be split at real selector ownership seams. `input.css` is 555 lines and its attachment selectors have a clear component seam, so split that independently.
- Other watchlist candidates: `ToolDispatch`, `App.tsx`, `config/types.ts`, `SidebarProvider`, `ToolCallingLoop`, `extension`, `RemoteRequestStore`, `RemoteRuntime`, `RemoteVoiceBridge`, `RemoteSelectionPager`, `config/schema`, `RemoteCommandHandler`, `PowerControl`, `InputRow`, `CompactionService`, `dirTools`, `execTools`, `reducer`, `compactionLedger`, `OpenAIClient`, `BackendPool`, `uxTools`, `LocalDelegationService`, `messages.css`, `videoExtract`, `DirectBackend`, `builtinTools`, `RemoteAgentProgress`, `BackgroundExecutionManager`, `tool-rows.css`, `lspTools`, `gitTools`, `OllamaNativeClient`, `ConversationTabs`, `sessionPersistence`, `SendPipeline`, `execHelpers`, and `sessionTypes`: retain or revise their current verdicts in the inventory below; no candidate is silently dropped.

## Current files at/near the enforced ceiling

There were ten source files at exactly 500 lines and one at 499 when Codex measured; after the single-view merge there are thirteen at 500 and two at 499. The check used `git diff 9ab7cc6 HEAD -- <file>` and the relevant patches, rather than assuming their present shape reveals the history. Per-file evidence:

- `meshOrchestrator.ts`, `sessionProvider.ts`, `JobScheduler.ts`, and `agentTask.ts` were added after the watchlist snapshot as new 500-line modules; their history is feature implementation, not pre-snapshot squeezing. The session-provider work includes the latest stand-in branch (`0252b14`), whose plan now moves that concern back out to `claudeStandIn.ts`.
- `config/types.ts` was already present; its patch adds/removes type fields in response to actual config features, including CLI consent, Telegram groups, and `reasoning_effort: xhigh` (`26b0449`). No line joining or comment deletion is used to hit 500.
- `extension.ts` has 36 insertions and 36 deletions since the snapshot (`03ad88f` through `e6f7bd8`); those are composition call-site rewrites as setup owners were introduced, not code packed into longer lines or a disabled lint rule. Its future setup additions still go to the setup owners named below.
- `JobScheduler.ts` and `agentTask.ts` were added as dedicated job owners, then received lifecycle/race fixes (`a3f387c`) and agent-task feature work. Their current 500-line size is accumulated implementation, not a squeeze.
- `RemoteController.ts` has 31 insertions and 30 deletions, mainly controller delegation/refactoring while Telegram contact and persistent-job behavior was added (`71fc85b`, `111e887`, `3647b54`). The inspected patch is not line compression; no newly owned contact flow should return here.
- `AgentLoop.ts` gained 70 lines and removed one, including mid-turn tells and Telegram contact prompt handling (`91990d2`, `03ad88f`). This is genuine lifecycle feature growth; future turn providers/prompts go to their existing modules.
- `SlashCommandHandler.ts` has a 19-for-19 replacement for `/unload`/`/unloadall` command behavior (`d776e1f`); it does not join lines, remove comments, inline helpers, or disable lint. The compaction forwarders remain a rejected split candidate.
- `ToolDispatch.ts` has a 4-for-4 change to avoid counting a policy denial as a repeated tool failure (`d66c9af`); no squeeze pattern.
- `TelegramChannel.ts` gained 88 lines and removed three, including attachment-to-file and photo/voice transport paths (`c79abca` and adjacent remote feature commits). This is genuine transport capability growth. Keep future focused download/mapping logic in the existing Telegram helpers.

I found no cap-reaching case in this set caused by comments deleted, lines joined, helpers inlined, or a max-lines disable. The exact-500 added modules are nevertheless at the lint boundary and may need a true seam before feature growth. This distinction does not make 500 a target: cap-reaching files must not receive unrelated responsibilities.

| Lines | File | Concerns read in file (function / line ranges) | Verdict; where next touching work goes |
|---:|---|---|---|
| 500 | `src/agentMesh/meshOrchestrator.ts` | `ask` 141–224; `tell` 225–269; `steer` 270–305; `relay` 306–370; identity/scope/disposal and queue queries 371–454; command dispatcher 455–500 | **LEAVE**, facade coordinates the mesh workflow. New tell/relay delivery policy belongs in `src/agentMesh/adapters.ts` or `src/agentMesh/aliasFifo.ts`; command parsing belongs in `src/agentMesh/meshCommands.ts`. |
| 500 | `src/agentMesh/sessionProvider.ts` | adapter resolution and observing 73–243; owned Codex lifecycle 244–323; owned Claude lifecycle 324–406; reap/park/wake/close/dispose 407–500 | **LEAVE**, single owned-session lifecycle. Stand-in resume plan’s joined Claude fallback moves to `src/agentMesh/claudeStandIn.ts`; don't put it here. |
| 498 | `src/config/schema.ts` | tool/model/profile schemas 19–136; runtime/provider/search/video/permissions schemas 137–318; root `ForgeConfigSchema` 319–500 | **LEAVE**, canonical Zod config owner; new domains go in existing schema owners such as `src/config/agentBusSchema.ts` / `jobsSchema.ts`, composed here. |
| 500 | `src/config/types.ts` | config/model interfaces and inferred public types across 1–500 | **LEAVE**, shared public config type owner; new domain declarations go beside their schema (`src/config/agentBusSchema.ts`, `src/jobs/jobSchema.ts`) and are re-exported only if consumers require the public aggregate. |
| 500 | `src/extension.ts` | `activate` composition 64–491; `deactivate` 492–500 | **LEAVE**, activation boundary. Future feature setup belongs in its existing `src/vscode/*Setup.ts` module, then only its registration call in `activate`; teardown remains in `deactivate`. |
| 500 | `src/jobs/JobScheduler.ts` | constructor/state setup 60–129; start/lease/stop/lease-loss/wake reconciliation/watch 130–224; `tick` 225–302; `runJob` 303–403; `maybeSleepIfIdle` and idle helpers 404–500 | **LEAVE**, scheduler state machine. Schedule/backoff/wake policy belongs in `src/jobs/schedule.ts`, `backoff.ts`, `schedulerWakes.ts`; agent-task behavior in `src/jobs/agentTask.ts`. |
| 500 | `src/jobs/agentTask.ts` | `canStartNow`/`schedulePeriodMs` 63–102; `AgentTaskRunner.run` 120–292; `snapshotConfig` 293–307; `buildPrompt` 308–371; `finish` 372–449; `sleepWithAbort`/`parseResult`/`formatDuration` 450–500 | **LEAVE**, orchestration is one ordered job lifecycle. Durable state and restart already belong in `src/jobs/agentTaskState.ts` and `agentTaskRestart.ts`; new step action belongs in its existing action owner. |
| 500 | `src/remote/RemoteController.ts` | construction/start-stop/options 40–231; inbound `handle` 232–500 | **LEAVE**, admission and queue execution canonical owner. Channel policy goes to channel implementations; queue ordering/state helpers stay in `src/remote/remoteQueueOrdering.ts` and related focused owners. |
| 500 | `src/sidebar/AgentLoop.ts` | listeners/state/construction 47–249; cancel/interruption/approval 250–325; `runTurn` 326–409; progress/prompt/contact lifecycle 410–500 | **LEAVE**, primary turn router. Provider-specific execution remains in `ModelTurn.ts`, `ProviderTurn.ts`, `CliTurn.ts`; prompt-only execution in `PromptRun.ts`; new lifecycle collaborator goes into `TurnLifecycle.ts` or an existing wiring owner. |
| 500 | `src/sidebar/SlashCommandHandler.ts` | `handle` routing and command implementations 73–484; compaction forwarding 485–500 | **LEAVE**, existing command dispatcher. Compaction behavior belongs in `CompactionService.ts`; `/initForge` prompt ownership stays here unless extracted as a separately testable prompt factory. |
| 500 | `src/sidebar/ToolDispatch.ts` | deletion inventory/preview and diff helpers 28–192; result conversion 196–204; `dispatch` permission/checkpoint/execute/result path 211–393; `openFile` 394–500 | **LEAVE**, tool execution boundary. New tool behavior belongs in `src/tools/<domain>Tools.ts`; approval policy belongs in `ToolApprovalService.ts`; file diff logic in existing `DiffUtils.ts`. |
| 499 | `src/remote/TelegramChannel.ts` | constants/commands/options 21–96; polling/start and send/format/progress/keyboard/edit/delete 97–400; attachment/photo/voice transport 401–499 | **LEAVE**, public transport facade and cursor/send policy stay canonical. Focused mapping, polling, download, or formatting work belongs in the already established Telegram helper modules; do not create another transport. |
| 499 | `src/sidebar/ModelTurn.ts` | types/context and model warning helpers 91–178; `runModelTurn` config/capability/tool setup 180–237; preparation closures and loop call 238–end | **SPLIT phase 1**, details below. |
| 498 | `webview-ui/src/App.tsx` | app composition/render and event-to-prop wiring, whole file | **LEAVE**, root composition. New UI behavior goes to the responsible existing component/hook (`components/*`, `usePendingPrompts.ts`, reducer/action owners); App should only wire it. |
| 500 | `src/sidebar/SidebarProvider.ts` | lifecycle and constructor/facade 1–204; webview resolve/post/message delegation 205–345; status/session/active-conversation public facade 346–500 | **LEAVE**, canonical host/webview entry. New collaborator wiring goes in `sidebarWiring.ts` or `sidebarFacadeWiring.ts`; message actions in existing router; do not re-inline moved setup. |
| 497 | `src/sidebar/messageBridge.ts` | host→webview and webview→host discriminated unions, whole module | **LEAVE**, protocol import point. Add message variants here; if physical split later, re-export both unions here and retain this as every consumer’s import. |
| 500 | `src/remote/RemoteRequestStore.ts` | dedup/load/query and queue transitions, whole store API | **LEAVE**, durable request-store owner. New record policy belongs in existing `remoteRequestTypes.ts`/store helper only when independently owned; execution remains `RemoteController.ts`. |
| 500 | `src/remote/RemoteRuntime.ts` | dependency construction/start-stop/disposal and channel/controller wiring, whole module | **LEAVE**, lifecycle owner. New remote admission belongs in `RemoteController.ts`; host setup/notifications belong in established runtime options or channel owners. |
| 487 | `src/remote/RemoteVoiceBridge.ts` | voice ingress validation/transcription/admission/delivery, whole module | **LEAVE**, voice boundary. Transcription belongs in `src/voice/*`; Telegram mapping/download in existing Telegram helpers. |
| 495 | `src/remote/TelegramContactService.ts` | non-owner/group/action/owner command handling and recovery, lines 47–477; text command helpers 478–495 | **LEAVE**, cohesive contact/consent policy. New persistence belongs in `RemoteContactStore.ts`; Telegram transport remains `TelegramChannel.ts`. |
| 488 | `src/sidebar/CompactionService.ts` | compaction cut/summary/run/resume workflow, whole module | **LEAVE**, canonical workflow. Prompt text, window application and ledger already have owners `compactionPrompt.ts`, `compactionWindow.ts`, `compactionLedger.ts`. |
| 481 | `src/remote/RemoteCommandHandler.ts` | command dispatch and per-command policy, whole module | **LEAVE**, remote command boundary. New command implementation goes here only if compact; command-specific workflow belongs in the established jobs/session service. |
| 480+ CSS | `webview-ui/styles/input.css` (555) | composer/input row; slash/status controls; attachment tray/tile selectors (inspect exact selectors at phase start) | **SPLIT phase 3**, move attachment selector block into `webview-ui/styles/attachments.css`, imported by existing style entry. Keep cascade order and selectors byte-for-byte. |

For the files above 500, current count is from `HEAD`; config schema's actual committed count is 498. CSS is over 500 but outside the current ESLint command. The proposal to remove CSS from CLAUDE.md's hard-count rule resolves that inconsistency, while the concrete attachment seam remains an independent concerns-based split.

## Additional files explicitly recovered from the watchlist

| File | Current main lines | Concerns / decision |
|---|---:|---|
| `webview-ui/src/App.tsx` | 421 | Root composition and render/event wiring; **LEAVE**. Feature behavior belongs in existing components/hooks/reducer; App only connects them. |
| `src/sidebar/ForgeHostFacade.ts` | 368 | Host-facing API facade over sidebar collaborators; **LEAVE**. Expand only the existing facade contract; collaborator construction remains in `sidebarFacadeWiring.ts`. |
| `src/tools/gitTools.ts` | 363 | Git tool schemas and handlers; **LEAVE** as one tool family. New git operations go here; shared process/result behavior goes to existing exec helpers. |
| `src/agentMesh/exchangeLog.ts` | 361 | Exchange event append/read/lock/compaction transaction; **LEAVE**. Extend this durable log owner. |

## Feature-aware phase order and concrete splits

The order follows near-term exposure rather than raw line count. Each phase starts by re-anchoring ranges against its actual checkout. An inspection that disproves a seam stops that phase before edits; it is not a reason to improvise another split.

### Phase 0 — Replace the watchlist

Delete `docs/plans/FILE_SIZE_WATCHLIST.md` in the implementation phase and mark this document as its successor. Update `CLAUDE.md` to remove `.css` from the hard 500-line rule while retaining `.ts` and `.tsx`; CSS stays eligible for concerns-based splitting. No production code changes.

### Phase 1 — `ModelTurn` preparation pipeline

Prefix rewrites Phase 2 landed at 499 lines (ed70101), so the next change to the prompt pipeline has no room. Extract the preparation pipeline from `runModelTurn` now; it is the riskiest move because the ORDER of the transformations is behaviour (see `test/unit/promptPrefixStability.test.ts`). It begins after tool-definition setup and ends at the `prepareMessages` closure passed to `runToolCallingLoop` (re-anchor exact range; in the current tracked baseline `runModelTurn` starts at line 180 and prepares through the call near EOF). Move only the ordered transformation of `ChatMessage[]`: compaction window, image age-out, system prompt, turn context, tool-result excerpting/clocks/reread annotations, and transcript clock marking.

New function contract (re-anchored 2026-09-23 against 011992c; the earlier draft named `checkpoint`/`forgeInstructions`, which the closure never reads): new file `src/sidebar/prepareModelTurnMessages.ts` exporting `prepareModelTurnMessages(messages: ChatMessage[], input: { compaction: ConversationRuntime['compaction']; isVisionModel: boolean; model: ModelConfig; templateEngine: TemplateEngine; config: ForgeConfig; forgeLoader: <type of ctx.forgeLoader>; activeFile: string | undefined; turnContext: TurnContextState; getToolDefinitions: () => ToolDefinition[]; }): ChatMessage[]`. It holds the body of the `prepareMessages` closure in `runModelTurn` (ModelTurn.ts lines 297–338) verbatim, comments included; `buildTemplateContext(...)` and `getToolDefinitions()` stay called per round inside it, exactly as now. The closure becomes one call. Keep `runModelTurn(ctx, request)` and its exports stable; the turn-context snapshot above the loop stays in `runModelTurn`.

### Phase 2 — Tool request builder

Extract the current per-round request assembly in `runToolCallingLoop` to `src/agent/buildRoundRequest.ts` only if search confirms no existing builder. Move the contiguous logic from `fallbackMessages` / `nativeDefinitions` through `normalizeRequestForModel` (presently approximately lines 204–237; re-anchor). Function contract: `buildRoundRequest(input: { model: ModelConfig; preparedMessages: ChatMessage[]; toolDefinitions: ToolDefinition[]; nativeTools: boolean; stripAllTools: boolean | undefined; includeUsage: boolean | undefined; maxOutputTokens: number | undefined; canUseThinkingKwargs: boolean | undefined; suppressThinking: boolean; outputRoom: number | undefined; }): ChatCompletionRequest`. The native-JSON-parse fallback (currently ~line 307) builds a second request from the same `base` with `stripTools` and `fallbackMessages`: return `{ base, fallbackMessages }` alongside the request, or have the helper build both, so the two paths cannot drift. Keep per-round state, exhaustion/compaction/recovery decisions and streaming loop in `runToolCallingLoop`; no behavior or ordering changes.

### Phase 3 — Attachment CSS

Move only attachment tray/tile selectors from `input.css` to `attachments.css`; import through the current stylesheet entry at the same cascade position. First confirm no existing attachment stylesheet and identify the full selector block. Keep selectors/declarations unchanged.

### Execution (who runs the phases)

Qwopus V2 runs phases 1–3; Claude does phase 0 and reviews.
- One phase per FRESH chat, with the exact function, current line range and target signature in the prompt, so no exploration is needed.
- Start from a clean tree; end with `npm run ci` green and one commit. The worst case is one `git revert`.
- Tests are not edited except import paths. A test that needs a behaviour change means the move was not a pure move: stop and report.
- No live monitoring. Claude reviews once per phase on the bus "finished" notice: removed and added lines match (a move), plus CI.
- Two failed attempts on one phase: Claude does that move directly.

### Standing constraint A — single-view owners (work landed in 1ea94c6)

Single-view touched `ConversationTabs`, `SidebarProvider`, `RemoteRuntime`, `RemoteRequestStore`, and `messageBridge`. Treat `messageBridge` as the stable central import surface; add/adjust variants in one union owner. **Do not split messageBridge**: preserving one import point is a hard protocol constraint. If either union must move, require a compatibility facade/re-export and confirm every consumer still imports `messageBridge`.

The high-count owners remain facades: `SidebarProvider` new lifecycle/UI orchestration goes to `ConversationTabs` for tab behavior, `sidebarWiring.ts`/`sidebarFacadeWiring.ts` for composition, and existing router for messages; `RemoteRuntime` wiring stays there while admission/queue logic stays in `RemoteController`; persistent request state stays in `RemoteRequestStore`. No generic line shaving.

### Standing constraint B — stand-in resume plan (not a split phase)

`docs/plans/CLAUDE_STAND_IN_RESUME_PLAN.md` touches `sessionProvider.ts`, `aliasFifo.ts`, `adapters.ts`/`MeshAdapter`, `agentMeshSetup.ts`, `ClaudeOwnedSession.ts`/`defaultClaudeFactory`, exchange/board event types and tests. Primary concern is the at-cap `sessionProvider.ts`: the plan already directs the stand-in implementation into new `src/agentMesh/claudeStandIn.ts`; keep it out of the owned-session map and ownership persistence. The plan also names `meshOrchestrator.relay`/`fifoFor` note delivery, `AliasFifo` idle disposal, permission setup, and setup notification fanout. These split-plan constraints must be reflected in its implementation; do not extract unrelated mesh orchestration simply because it is 500 lines.

## Concerns-based verdicts below 480 lines

The current 350–479 inventory remains: `RemoteContactService` at 495 is above; `RemoteCommandHandler` 481 above; `src/remote/types.ts` 476 is a cohesive remote contract (**LEAVE**, new contracts belong with owning domain type file); `ToolCallingLoop` 475 is **SPLIT phase 2**; `agentMeshSetup.ts` 471 is **LEAVE**, new mesh wiring here; `RemoteContactStore.ts` 471 **LEAVE**, contact storage here; `RemoteSelectionPager.ts` 470 **LEAVE**, pagination state here; `uxTools.ts` 463, `jobTools.ts` 458, `PowerControl.ts` 455, `dirTools.ts` 454, benchmark orchestrator 454, BackendPool 454, InputRow 450, OpenAIClient 438, execTools 433, reducer 430, compactionLedger 429, ownership 429, JobStore 428, ConversationTabs 431, SendPipeline 416, LocalDelegationService 412, messages.css 398, agentRoutes 398, builtinTools 394, DirectBackend 394, sidebarWiring 391, videoExtract 387, sessionPersistence 391, BackgroundExecutionManager 372, RemoteAgentProgress 372, CodexAppServerSession 371, tool-rows.css 370, sessionTypes 367, lspTools 367, RemoteSessionCommands 363, OllamaNativeClient 363, SessionLogger 359, CheckpointStack 360, fileEditTools 358, execHelpers 354, and DiskCheckpointStore 351: retain their established single domain/transaction owners and direct growth to those named files. Existing downstream or setup owners in `docs/OWNERS.md` remain authoritative. `turnContext.ts` (245) is below threshold and remains the volatile turn-context owner.

## State × lifecycle ledger

no durable state (a pure refactor)

## Acceptance criteria

- `docs/plans/FILE_SIZE_WATCHLIST.md` is deleted in phase 0 and this plan carries every candidate/seam forward with a verified or rejected decision.
- CLAUDE.md's hard file-size rule matches lint enforcement: `.ts`/`.tsx`, no `.css`; CSS remains covered by the concern inventory and CSS extraction phase.
- Every committed source file at 480+ lines has a file-specific concern map, function/range anchors, an explicit verdict, and a named destination for the next feature in LEAVE cases.
- Phases 1 and 2 move only the described logic; callers, public exports, request/prompt ordering, stream behavior, persisted shape, and lifecycle events remain unchanged.
- No `.ts` or `.tsx` file exceeds 500 lines after each implementation phase; no CSS rule is implied by lint.
- Every new source module receives an `OWNERS.md` row in the same implementation commit; no duplicated concern owners.
- Implementation tests and repository CI are run by the implementation owner after each phase, with the final gate after the final edit. This planning-only revision does not run CI.
- `git diff --check` and status/inventory review are done before implementation handoff.

## Revision summary

Rebased the inventory on committed `main` rather than stale branch measurements; retired the separate watchlist as a phase-0 action; decided each watchlist seam, including CSS lint policy; classified all ten 500-line files and TelegramChannel 499 by history as genuine growth rather than squeeze-to-fit; added the omitted App, ForgeHostFacade, gitTools, and corrected exchangeLog counts; moved phase priority to match prefix, single-view, and stand-in upcoming work; and replaced vague split directions with named functions, line anchors, and parameter contracts. Preserved the state ledger and acceptance criteria.

Claude review (2026-09-23): approved with corrections, applied here. Re-anchored the `agentTask` and `JobScheduler` ranges (the first draft gave `run` 103–449 and `tick` 225–500), updated the counts after the single-view merge, turned the landed prefix and single-view phases into standing constraints, renumbered the phases to 0–3, required `buildRoundRequest` to cover the native-JSON fallback request, and added the execution rules.
