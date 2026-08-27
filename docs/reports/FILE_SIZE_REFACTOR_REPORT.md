# File-Size Refactor Report — Forge

Status: REPORT ONLY (grounded in code at commit 01fe99c / v0.12.29). No changes
made. Implementation plan to be drafted in a new session.

## Why
CLAUDE.md sets a **hard 350-LOC limit per source file** (no exceptions except
generated files). 8 files currently violate it; another 11 sit in a 300–350
"about to break" band. This report inventories each, proposes a grounded split,
and gives a suggested order + risk. It does **not** implement anything.

## The rule (verbatim intent)
- 350 LOC max per source file — split into modules if exceeded.
- Single Point of Truth: every concern has one canonical owner file
  (`docs/OWNERS.md`). Splits must **extend the owner map**, not create siblings
  that duplicate logic. Add a row to `docs/OWNERS.md` for each new module.

---

## Offenders (over 350 LOC)

| # | File | LOC | Over by | Split difficulty |
| - | ---- | --- | ------- | ---------------- |
| 1 | `src/sidebar/AgentLoop.ts` | 779 | +429 | High |
| 2 | `src/sidebar/SidebarProvider.ts` | 591 | +241 | Medium |
| 3 | `src/vscode/nativeCommands.ts` | 502 | +152 | Low |
| 4 | `src/backend/ControlServer.ts` | 452 | +102 | Medium |
| 5 | `src/sidebar/SlashCommandHandler.ts` | 388 | +38 | Low |
| 6 | `src/backend/BackendPool.ts` | 362 | +12 | Medium |
| 7 | `src/tools/gitTools.ts` | 357 | +7 | Low |
| 8 | `src/extension.ts` | 356 | +6 | Low |

---

### 1. AgentLoop.ts (779) — highest priority, highest value
The turn engine. Grew with worker + CLI-daemon wiring. Distinct clusters:
- **Turn orchestration**: `runTurn`, `runAgentLoop`, `commitUserPrompt`,
  streaming lifecycle (`stopStreamingIfNeeded`, `resolveStreamingLifecycle`,
  settled maps).
- **Worker/coordinator path**: `runWorkerTurn`, `runCoordinatorReview`.
- **CLI path**: `runCliTurn` (+ `cliSessions` registry, `cliDriver`).
- **Capability probing**: `getRuntimeCapabilities`, `canUseThinkingKwargs`,
  `shouldStripThinking`, capability caches/warnings.
- **Markdown one-shot**: `runPromptToMarkdown`.

Proposed split (owner stays `AgentLoop`, delegates to collaborators):
- `AgentLoopCapabilities.ts` — capability cache + thinking/strip decisions (~90).
- `AgentLoopCli.ts` — `runCliTurn` + CLI session glue (~110).
- `AgentLoopWorker.ts` — `runWorkerTurn` + `runCoordinatorReview` (~90).
- `AgentStreamingLifecycle.ts` — the settled/cancel/streaming maps (~70).
- `AgentLoop.ts` keeps `runTurn`/`runAgentLoop` core (~350, at limit — verify).
Risk: high — shared private state (`activeBackends`, `cancelControllers`,
capability caches). Extract as injected collaborators holding their own maps,
not as free functions reaching into `this`. Do this one **alone**, its own PR.

### 2. SidebarProvider.ts (591)
Webview provider + message router + session/token bookkeeping.
- **Message routing**: `handleMessage` (the big switch), `handleSend`.
- **Session state**: `getActive`, `activeMessages`, `persistSession`,
  `postSessionSync`, `applySwitchConversation`, `newConversation`.
- **Token/context budget**: `estimateTokens`, `writeForgeBridge`,
  `postTokenBudget`, `flushSessionLog`, session loggers.
Proposed split:
- `SidebarMessageRouter.ts` — `handleMessage`/`handleSend` dispatch (~140).
- `SidebarSessionState.ts` — conversation get/switch/persist/new (~120).
- `SidebarTokenBudget.ts` — token estimate + bridge + budget posting (~80).
- `SidebarProvider.ts` keeps VS Code `WebviewViewProvider` wiring (~250).
Risk: medium — `handleMessage` touches many privates; pass a typed context
object. Note overlap with existing `messageBridge.ts` (keep it the owner of
message *types*; router owns *dispatch*).

### 3. nativeCommands.ts (502) — easy win
Already almost all free functions. Registration block + prefill helpers +
diagnostic/selection prompt runners are cleanly separable.
Proposed split:
- `nativeCommands.ts` — `registerNativeCommands` registration only (~180).
- `commandPrefill.ts` — `prefillSelection/Blocks/ManyBlocks/Diagnostic` (~120).
- `commandPrompts.ts` — `draftScratch`, `runSelectionPrompt`,
  `runDiagnosticPrompt`, `runBackendAction` (~150).
Risk: low — functions already parameterized via `NativeCommandDeps`.

### 4. ControlServer.ts (452)
HTTP control server + model lifecycle (ensure/evict/hold).
- **HTTP layer**: `handle`, request routing, `modelCatalog`, serialize.
- **Lifecycle**: `ensure`, `resolveBase`, `waitReady`, `makeRoom`,
  `releaseBase`, `unload`, holds/loading maps.
Proposed split:
- `ControlModelLifecycle.ts` — ensure/makeRoom/waitReady/unload + hold maps (~200).
- `ControlServer.ts` keeps HTTP server + routing + serialize chain (~230).
Risk: medium — lifecycle mutates hold/loading/lastAcquired maps under the
`serialize` chain; move the maps with the lifecycle class and keep the single
serialization queue in the server. Cross-check `docs/OWNERS.md` (control API is
the Relay compat contract — behavior must not change).

### 5. SlashCommandHandler.ts (388) — easy win
`handle` switch is thin; the bulk is `initForge` + workspace-context collection.
Proposed split:
- `InitForgeCommand.ts` — `initForge`, `collectWorkspaceContext`,
  `buildInitForgePrompt`, `extractMarkdownFromToolCall` (~180).
- `SlashCommandHandler.ts` keeps the dispatch switch + small handlers (~210).
Risk: low.

### 6. BackendPool.ts (362) — small trim
llama.cpp slot pool + Ollama slots interleaved.
Proposed split:
- `OllamaSlotPool.ts` — `isOllamaModel`, `acquireOllama`, `ollamaSlots`,
  `ollamaStarting` (~70).
- `BackendPool.ts` keeps llama.cpp slot lifecycle + LRU (~300).
Risk: medium — `stopAll`/`release` iterate both maps; keep a thin facade.
Alternative: pull just LRU helpers (`getLruEntry`, `getMostRecentSlot`,
`allocatePort`) into `poolEviction.ts` (~60) for a lower-risk trim.

### 7. gitTools.ts (357) — trivial
9 independent `makeGit*Tool` factories + 5 helpers. Purely mechanical.
Proposed split:
- `gitReadTools.ts` — status/log/diff/blame/show (~180).
- `gitWriteTools.ts` — createBranch/switchBranch/stage/commit (~130).
- `gitTools.ts` — shared helpers (`getRepo`, `resolveFilePath`,
  `statusLetter`) + re-export barrel (~60).
Risk: trivial — no shared mutable state.

### 8. extension.ts (356) — trivial (6 over)
`activate` is a long wiring sequence.
Proposed: extract the tool-registration + command-registration blocks into
`registerExtension.ts` (`wireCommands(context, deps)`), or move the
`registerAllTools(...)` argument assembly into a `buildToolRegistry.ts` (~80).
Risk: trivial. Lowest urgency (only 6 over) but cheapest possible fix.

---

## Watch list (300–350 — will break next feature)
`ToolDispatch.ts` (349), `WorkerOrchestrationService.ts` (347),
`CodexAppServerSession.ts` (341), `dirTools.ts` (337),
`OllamaNativeClient.ts` (330), `LocalDelegationService.ts` (326),
`config/schema.ts` (326), `ConfigResolver.ts` (326), `DirectBackend.ts` (324),
`IndexManager.ts` (309), `config/types.ts` (302).
Not violations yet — do **not** refactor now, but any edit that pushes one over
350 must split in the same change. `ToolDispatch.ts` at 349 is one line from
breaking.

---

## Suggested sequencing (for the impl-plan session)
Order by value/risk, one PR each, `npm run ci` green between every step:
1. **gitTools.ts** (trivial, proves the pattern + OWNERS.md workflow).
2. **extension.ts** + **nativeCommands.ts** + **SlashCommandHandler.ts**
   (low-risk mechanical extractions, can batch).
3. **BackendPool.ts** + **ControlServer.ts** (medium; lifecycle care;
   ControlServer must preserve the Relay control-API contract — lean on
   `test/unit/ControlServer.test.ts`).
4. **SidebarProvider.ts** (medium; typed context object for handlers).
5. **AgentLoop.ts** (high; alone; injected collaborators, not free functions).

## Constraints for the implementer
- Each new module gets a `docs/OWNERS.md` row. Grep before creating — extend an
  existing owner if the concern already has one.
- No behavior change. These are pure extractions; tests must pass unchanged.
  Where a test asserts on a private, prefer testing the new module directly.
- Keep every resulting file **under 350** with headroom (aim ≤300) so the next
  feature edit doesn't immediately re-break it.
- Webview-side TS stays free of Node imports (CLAUDE.md).
