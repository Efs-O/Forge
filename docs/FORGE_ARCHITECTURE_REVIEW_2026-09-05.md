# Forge Architecture Review — 2026-09-05

> **Status: VERIFIED 2026-09-05 against the worktree at `34f1215`.**
>
> The original review was written without reading the code. Every item in
> "Genuinely unfinished" has since been checked against `src/`, and each now
> carries a **Verdict** line naming the file that settles it. Four items were
> already shipped and have been moved to the implemented list. The recommended
> sequence was reordered as a result. Prose without a Verdict line is from the
> original review and remains unverified.

## Executive summary

Forge has crossed the line from "VS Code extension with a local coding agent" into a local-agent runtime/orchestration platform with VS Code, Telegram and CLI-backed agents as interaction surfaces.

The strongest architectural direction is now clear:

- keep the permanent model prompt small;
- expose capabilities lazily and re-evaluate tool schemas every model round;
- make the tool loop resilient to local-model failure modes;
- keep authorization, mutation tracking, approvals, diffs and checkpoints outside the model;
- treat local inference as a finite resource that requires backend residency/admission logic;
- separate read-only consultation from writable worker orchestration;
- preserve task state independently from ordinary transcript history so compaction does not erase execution state.

The current architecture is substantially stronger than the earlier Forge 0.13/0.14 design. The next gains should come mostly from making the existing runtime faster, more context-efficient and more reliable rather than adding another large subsystem.

---

## Current architecture

At a high level, Forge now looks like this:

```text
                         ┌─ Direct llama.cpp
                         ├─ Ollama local/cloud
User / Telegram / VSCode ─ AgentLoop ─ Provider routing ─ Cloud/OpenAI-compatible
                         │                    └─ CLI agents
                         │                         ├─ Codex
                         │                         └─ Claude Code
                         │
                         ├─ ToolCallingLoop
                         │    ├─ native tools
                         │    ├─ JSON fallback
                         │    ├─ lazy tool groups
                         │    ├─ truncation recovery
                         │    ├─ loop detection
                         │    └─ per-round context budgeting
                         │
                         ├─ ToolRegistry / ToolDispatch
                         │    ├─ permissions
                         │    ├─ confirmations
                         │    ├─ checkpoints
                         │    ├─ diffs
                         │    └─ tool budgets
                         │
                         ├─ Delegation
                         │    ├─ ask_local_agent
                         │    └─ local / cloud / CLI targets
                         │
                         └─ Worker orchestration
                              ├─ worker A
                              ├─ worker B
                              └─ coordinator review
```

### AgentLoop is now primarily an orchestrator

`src/sidebar/AgentLoop.ts` owns turn lifecycle, cancellation, approvals, capability caching, provider routing and service assembly. The reusable model/tool execution loop has been extracted into `src/agent/ToolCallingLoop.ts`.

This is the correct boundary: provider/model execution details can evolve without turning AgentLoop into a monolith, while worker and future orchestration paths can reuse the same core loop.

### ToolCallingLoop is one of Forge's main differentiators

The loop has several local-model-specific behaviors that are unusually valuable:

1. **Tool definitions are re-read every round.** A `load_tool_group` call can therefore expose a tool group in the same turn and the very next request receives the new schemas.
2. **Native tool calling and fallback JSON tooling share the same execution path.** Forge can recover from providers/models that fail native tool JSON parsing without maintaining a second security/runtime model.
3. **Truncated tool calls are treated separately from malformed calls.** Running out of context is not charged as ordinary tool-call failure.
4. **Recovery rounds can suppress thinking.** After a truncated tool call, Forge can spend the remaining generation budget completing the tool call rather than burning thousands of tokens re-reasoning.
5. **Output-room checks happen per round.** Forge can refuse or recover before sending a request that has no useful answer/tool-call headroom.
6. **Repeated-call/loop detection is structural rather than relying only on system-prompt wording.**

This is exactly the engineering that can make the same 27B local model behave better in Forge than in a generic OpenAI-compatible harness.

### Truncation-aware recovery temporarily suppresses thinking

This behavior is implemented today and is worth documenting explicitly because it is easy to mistake for a model reload or a global reasoning-mode change.

When a model begins a large tool call and llama.cpp reports that the call was cut off by output/context exhaustion, Forge classifies that separately from malformed tool JSON. It preserves the protocol state, adds recovery guidance and starts another model round inside the same user turn.

For models whose runtime/chat template supports thinking kwargs, only that recovery request is sent with `chat_template_kwargs.enable_thinking: false`. Forge does **not** restart or reload `llama-server`; the toggle is part of the individual `/v1/chat/completions` request. The implementation deliberately avoids making the model reason through the same problem again when the previous reasoning was already sufficient and the immediate problem is simply that the tool payload did not fit.

Once a round completes successfully, the truncation-recovery counter is cleared. The following normal round therefore goes back to the model's configured `think` value automatically.

Conceptually:

```text
normal round:   thinking ON
      ↓
large tool call is truncated
      ↓
recovery round: thinking OFF, spend room on completing/chunking the tool call
      ↓
recovery succeeds
      ↓
next normal round: configured thinking mode is restored
```

The code comment records a real motivating observation: a retry that re-thought the operation consumed roughly 4k tokens before the tool call even began, leaving less room than the already-truncated attempt. This recovery path is therefore not cosmetic; it is a context-efficiency mechanism targeted at reasoning local models.

The request path is explicit:

```text
model.think / preserve_thinking
        ↓
turnModelBehavior.canUseThinkingKwargs()
        ↓
ModelTurn
        ↓
ToolCallingLoop
        ↓
chat_template_kwargs.enable_thinking
        ↓
OpenAIClient
        ↓
POST /v1/chat/completions
        ↓
llama-server
```

The runtime capability gate matters: Forge omits thinking kwargs when the served model does not appear to support them. The harness-side behavior is therefore implemented and wired; whether a particular GGUF/chat template obeys the flag still depends on that template and llama.cpp build.

**Documentation gap:** this is currently much better documented in source comments than in user-facing documentation. Add a short README mention under local-model/context-efficiency features, and consider a later `docs/LOCAL_MODEL_OPTIMIZATIONS.md` or equivalent for the deeper runtime details. The README explanation should stay short and user-oriented rather than exposing the whole recovery state machine.

### ToolRegistry has become a real capability system

Registered tools can carry:

- a primary permission;
- additional static permissions;
- argument-derived permissions;
- mutation metadata;
- approval metadata;
- auto-approval status;
- advertisement predicates;
- dynamic descriptions.

Authorization is checked at execution time as well as during advertisement. Hiding a tool from a model is therefore not the security boundary.

### ToolDispatch is effectively the transaction/safety layer

The dispatch path now centralizes:

- JSON argument parsing;
- permission enforcement;
- approval policy;
- destructive-operation preview;
- checkpoint snapshots;
- mutation execution;
- diff generation;
- tool-result recording;
- timing;
- failure accounting.

This is a strong design because correctness and safety remain host-owned even when a weak local model emits imperfect calls.

### FORGE.md is repository-aware, but not fully hierarchical

`ForgeInstructionsLoader` already selects instructions for the repository containing the target file and falls back from `FORGE.md` to `AGENTS.md`.

What is still missing is multi-level inheritance inside one repository, for example:

```text
repo/FORGE.md
  ↓
repo/packages/FORGE.md
  ↓
repo/packages/frontend/FORGE.md
  ↓
current task/file
```

That should remain on the roadmap.

### Delegation and workers are now distinct concepts

Forge has two separate mechanisms and should keep them separate:

#### `ask_local_agent`

Read-only consultation. The delegated model receives only the explicit task and bounded selected context. It does not receive Forge tools and cannot mutate the workspace.

#### Worker orchestration

Writable/read-only scoped subagents used for parallel work under a coordinator. Workers have constrained tool access and their writes join the coordinator turn's checkpoint/review path.

This distinction is healthy. Consultation should not be broadened until it becomes a second worker implementation.

### Forge is developing a real local-resource scheduler

The worker/delegation design already understands that models are not abstract endpoints:

- local models consume finite backend slots and memory;
- active coordinator/primary backends must not be casually evicted;
- same-backend concurrency can degrade to labelled serial execution when safe;
- incompatible simultaneous residency can be rejected explicitly;
- cloud/CLI targets have different admission constraints.

Together with `/system` GPU/process telemetry, this provides the prerequisites for more advanced VRAM-aware scheduling later.

---

## Implemented features that are easy to forget

The following are already present or substantially implemented and should not be rediscovered/rebuilt from old plan documents:

- demand-loaded tool groups with per-round schema refresh;
- native + fallback tool-call recovery through one loop;
- truncated-tool-call recovery with temporary thinking suppression and automatic restoration;
- tool-result context bounding/supersession infrastructure;
- background command execution and monitoring;
- terminal awareness;
- LSP-backed code intelligence;
- per-turn Keep/Undo checkpoints and inline diffs;
- durable agent memory;
- durable task plans surviving compaction;
- local llama.cpp lifecycle management and backend sharing;
- Ollama/local/cloud/OpenAI-compatible providers;
- Codex/Claude CLI agent integration;
- native read-only delegation (`ask_local_agent`);
- writable worker orchestration;
- backend admission/pinning logic for delegation/workers;
- Telegram remote control with TOTP locking and transport durability;
- remote workspace handoff;
- voice input via whisper.cpp and spoken replies via Piper;
- spoken approve/deny/stop correlation safeguards;
- `/system` machine/GPU/process/RAM/disk reporting;
- MCP per-tool permission classification;
- repository-aware `FORGE.md` / `AGENTS.md` selection.

Added 2026-09-05 by the verification pass, each having been proposed as new work
in the section below before the code was checked:

- composing a prompt while a turn streams, with Enter queueing the next turn
  (`InputRow.tsx`);
- `/initForge` markdown recovery from tool-style JSON output
  (`extractMarkdownFromToolCall`);
- a deterministic compaction ledger recording changed files and command
  outcomes, independent of the summarizer (`compactionLedger.ts`);
- disk-backed whole-workspace checkpoints for CLI agents
  (`DiskCheckpointStore`);
- multi-language project indicators in `/initForge` (Python, Rust, Go, Java).

The lesson generalizes: this review proposed rebuilding four shipped features
because the repository documents its capabilities mainly in source comments.
That is the argument for item 13 and for the status convention at the end.

---

## Genuinely unfinished / still worthwhile

Verified 2026-09-05. Original numbering is preserved so earlier references stay
valid, but **items 10 and 12 are already shipped** and items 3, 5 and 8 are
substantially further along than the original review assumed.

### 1. Parallel execution of independent tool calls

**Priority: HIGH -> downgraded to MEDIUM on verification**

**Verdict: OPEN, confirmed.** `ToolDispatch.dispatch()` is a plain
`for (const tc of toolCalls)` at `src/sidebar/ToolDispatch.ts:235`, and no
`parallelSafe` metadata exists anywhere in `src/`.

The goal should not be a naive `Promise.all(toolCalls)`. Add a small execution
classifier / conflict detector:

**Good parallel candidates**

- `read_file` on independent paths;
- `search_code` / file search;
- LSP reads such as definitions/references/hover;
- `git_status`, `git_diff`, `git_log`;
- independent read-only MCP tools where explicitly safe.

**Keep serial or dependency-aware**

- file mutations;
- overlapping-path reads/writes where ordering matters;
- terminal commands;
- git mutations;
- approval-gated actions;
- tools with shared mutable runtime state.

A first version can parallelize only tools explicitly marked `parallelSafe: true`
and fall back to current serial behavior for everything else.

**Why this was downgraded.** The payoff is wall-clock only, and it is claimed
against the layer that owns checkpoints, approvals and mutation ordering. On a
local 27B-class model, token generation dominates a turn by orders of magnitude
over tool dispatch, so parallelizing four `read_file` calls saves milliseconds
while putting `ToolDispatch`'s ordering guarantees at risk. The win is real only
for genuinely slow tools - ripgrep over a large tree, LSP cold start, git on a
mapped network drive. Schedule it after the cheap correctness fixes (6 and 7),
and measure a real turn before assuming the latency is there to recover.

### 2. Hierarchical FORGE.md inheritance

**Priority: HIGH - confirmed, and the strongest remaining item**

**Verdict: OPEN, confirmed.** `ForgeInstructionsLoader.instructionsFor()`
resolves exactly one scope root via `resolveInstructionScopeRoot()` (nearest
`.git`, bounded by the workspace root) and loads exactly one file. There is no
ancestor walk, no concatenation and no per-scope delimiting.

Recommended semantics:

1. load repository-root `FORGE.md` / fallback `AGENTS.md`;
2. walk from repository root toward the target directory;
3. append the nearest matching instruction files in deterministic order;
4. cap total bytes/tokens - the existing `MAX_BYTES` guard is per file and must
   become a budget across the whole assembled chain;
5. clearly delimit each scope in the injected text;
6. cache by target directory and invalidate via the existing watcher.

The file is 220 lines with the watcher, cache and truncation guard already in
place, so this is contained work against a real seam. It combines well with lazy
tool groups: keep permanent instructions small and expose package-specific
guidance only when work enters that part of the tree.

### 3. Re-audit the compaction state-ledger design

**Priority: HIGH for review -> resolved by the audit; mostly a docs problem**

**Verdict: LARGELY IMPLEMENTED.** `COMPACTION_STATE_LEDGER_PLAN.md` states
"IMPLEMENTED 2026-08-27 (0.13.15), all four phases", and the code agrees:
`src/sidebar/compactionLedger.ts` (385 lines) derives the deterministic half of
a compaction summary directly from tool calls, and `CompactionState` in
`compactionTypes.ts` carries `recordedActions` (files and commands with
`ok`/`failed`/`unknown` outcomes), `repoState`, `userMessages` and `lastReply`.
`update_plan` supplies items with `pending`/`active`/`done` status.

Against the field list this review proposed, that already covers completed
items, active item, modified files and build/test state. Genuinely absent:
`objective`, `blockers`, and `confirmed facts/decisions`.

Do not add those three speculatively. The plan's own discipline applies - add
only state fields proven useful by real failed or resumed sessions. The
actionable remainder here is documentation, not engineering: the ledger is
invisible in user-facing docs.

### 4. Re-open VRAM fleet scheduling

**Priority: MEDIUM-HIGH strategic**

**Verdict: OPEN as a plan.** `FUTURE_VRAM_FLEET_SCHEDULING.md` still says "idea
/ not scheduled". The prerequisites this review claims are real and present in
`src/backend/`: `BackendPool`, `DelegationGate`, `ModelHeuristics`,
`poolAcquisition`, `SharedRuntimeRegistry`, plus `/system` telemetry.

Before implementation, re-read the old plan and rewrite it against current
architecture instead of coding directly from the historical document.

Potential future responsibilities:

- model residency score/cost;
- GPU affinity;
- preferred placement for Whisper vs chat models;
- queueing rather than rejection when appropriate;
- warm-model reuse scoring;
- worker admission based on current telemetry plus configured limits;
- optional multi-GPU target preferences.

Avoid pretending VRAM telemetry is a perfect predictor of whether a future model
load will succeed.

### 5. Disk-backed checkpoints

**Priority: MEDIUM**

**Verdict: HALF IMPLEMENTED.** `src/checkpoint/DiskCheckpointStore.ts` exists,
is wired through `CheckpointStack`, and `mkdtemp`s under
`os.tmpdir()/forge-checkpoints-<pid>`. But the comment at
`CheckpointStack.ts:152` is explicit: *"Whole-workspace CLI snapshots are
disk-backed."* Per-turn agent file edits still route through
`captureMemoryState()` in `MemoryCheckpointState.ts`, holding full file contents
in JS memory.

So the original concern holds, but only for the tool-write path, and the
infrastructure to fix it is already built and exercised. This is a rewiring job,
not a new subsystem: move the per-turn snapshot path onto the existing disk
store while preserving the CheckpointSession/Keep/Undo API.

### 6. Make `format_file` editor-independent

**Priority: MEDIUM -> raised to HIGH; this is a live defect, not polish**

**Verdict: OPEN, and worse than described.** The `format_file` handler in
`src/tools/fileEditTools.ts:169-183` calls `openTextDocument`, then
`showTextDocument`, then `editor.action.formatDocument`, then `doc.save()` - and
then **closes the active editor** via `workbench.action.closeActiveEditor` if
the file was not already open. A tool call therefore mutates the user's window
state, and the close fires against whatever is active at that moment.

Replace with `vscode.languages.getDocumentFormattingEdits()` or the
`vscode.executeFormatDocumentProvider` command plus `workspace.applyEdit`. The
pattern is already correct in the same file: `makeRenameSymbolTool()` at
`fileEditTools.ts:221` uses `executeDocumentRenameProvider` and `applyEdit` with
no editor involvement. Copy that shape.

### 7. Git CLI fallback

**Priority: MEDIUM -> raised; the machinery is already in the file**

**Verdict: OPEN, small.** `repositories()` at `src/tools/gitRepo.ts:48-54`
throws `git_*: no git repository found in workspace` when the `vscode.git`
extension API is unavailable or empty - there is no fallback path.

But `gitRepo.ts` already imports `execFile` and runs `git` directly at line 133,
and `gitReadTools.ts:132` already spawns git for the per-file diff case the VS
Code API cannot serve. The fallback is effectively assembled and simply not
reached on the API-absent branch. Keep the VS Code Git API preferred and route
that failure into the existing spawn path.

### 8. `/initForge` multi-language project detection

**Priority: MEDIUM -> LOW after verification**

**Verdict: MOSTLY IMPLEMENTED.** The indicator list in
`src/sidebar/SlashCommandHandler.ts:420-430` already probes `pyproject.toml`,
`Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`, `tsconfig.json`,
`.eslintrc`, `vite.config.ts` and `webpack.config.js`, and feeds the hits to the
model as workspace-scan context.

What is missing is not detection but *structured* per-language handling:
`package.json` is the only manifest actually parsed (name, scripts, deps), so
Python/Rust/Go projects yield a filename and nothing else. The useful increment
is extracting build/test commands per ecosystem, not adding more filenames.

### 9. Package-manager detection for build/test tools

**Priority: LOW-MEDIUM**

**Verdict: OPEN, confirmed.** No reference to `pnpm-lock.yaml`, `yarn.lock`,
`bun.lockb` or `packageManager` exists anywhere in `src/`. Detect the manager
from lockfiles/config rather than assuming npm. Naturally pairs with item 8.

### 10. Type while streaming

**Verdict: ALREADY IMPLEMENTED - remove from the backlog.**

`webview-ui/src/components/InputRow.tsx` never disables the composer textarea
during a turn. `streaming` gates only the send button and streaming-unsafe slash
commands, which stay listed and disabled rather than vanishing
(`availableWhileStreaming`). The composer hint switches to *"Enter queues this
for the next turn"*, and the queued prompt confirms itself in the transcript as
a `QueuedPromptRow`.

That is precisely the "keep submission disabled or treat Enter according to
existing queue/steer semantics" behavior this review asked for.

### 11. Better HTML-to-text conversion for `web_fetch`

**Priority: LOW**

**Verdict: OPEN, confirmed.** `htmlToText()` strips script/style blocks and then
applies a bare tag-stripping regex. Replace with a bounded proper HTML-to-text
parser that preserves basic block spacing and decodes entities.

### 12. `/initForge` output recovery

**Verdict: ALREADY IMPLEMENTED - remove from the backlog.**

`extractMarkdownFromToolCall()` at `src/sidebar/SlashCommandHandler.ts:352` is
applied to the model's output at line 327. It strips outer code fences and
recovers markdown from tool-style JSON, which is exactly the conservative
extraction path this item requested.

### 13. Document local-model runtime optimizations

**Priority: LOW-MEDIUM -> raised to MEDIUM; it is now the largest real gap**

**Verdict: PARTIALLY OPEN.** `README.md:25` mentions "truncated-call recovery"
in passing and line 467 documents `max_result_chars`. Temporary thinking
suppression on recovery is undocumented, and so is the compaction ledger from
item 3.

This item grew in relative importance precisely because the verification pass
found so much already built. The dominant risk in this repo is no longer missing
capability - it is capability that is invisible to its users and rediscoverable
only by reading source comments. Add a short, user-oriented README mention, and
collect the deeper runtime details in a focused
`docs/LOCAL_MODEL_OPTIMIZATIONS.md` alongside lazy tool exposure, tool-result
context bounding, prompt-prefix stability and context-budget behavior.

---

## Recommended next engineering sequence

Reordered 2026-09-05 after verification. The original sequence led with parallel
tool execution; that has been pushed back in favour of two small correctness
fixes whose implementation pattern already exists in the same files.

### Phase 1 - correctness fixes with a template in-tree

1. **`format_file` editor-independence (item 6).** It currently closes the
   user's editor tab as a side effect of a tool call. `rename_symbol`, fifty
   lines below it in `fileEditTools.ts`, already demonstrates the correct
   provider-plus-`applyEdit` shape.
2. **Git CLI fallback (item 7).** `git_*` throws outright when the extension API
   is absent, while `execFile('git')` is already imported in that same file and
   already used by `gitReadTools`. Route the failure into the existing path.

Both are hours, not days, and both remove a failure the user can hit today.

### Phase 2 - the one high-value structural item

3. **Hierarchical FORGE.md (item 2).** Deterministic inheritance, a byte budget
   spanning the assembled chain rather than per file, reuse of the existing
   watcher and cache. This is the strongest remaining item in the review and the
   one that most directly serves local 27B-class models: it keeps the permanent
   prompt small while making package-specific guidance available on demand.

### Phase 3 - documentation, which the audit promoted

4. **Document the local-model runtime optimizations (item 13).** Truncation-aware
   recovery, temporary thinking suppression, the compaction ledger and lazy tool
   groups are all shipped and all effectively invisible outside source comments.
   This review is itself evidence of the cost: it proposed rebuilding four
   things that already existed.
5. **Sweep plan-file statuses** per the hygiene convention below. Same failure
   mode, same fix.

### Phase 4 - measured performance work

6. **Parallel safe tool execution (item 1).** First measure where a real turn
   actually spends wall-clock time. If tool dispatch is not a visible fraction
   against local token generation, spend the risk budget elsewhere; the layer in
   question owns checkpoints, approvals and mutation ordering.
7. **Disk-backed per-turn checkpoints (item 5).** Rewiring onto
   `DiskCheckpointStore`, which already exists and is exercised by the CLI
   snapshot path.

### Phase 5 - strategic and long-tail

8. **Re-audit `FUTURE_VRAM_FLEET_SCHEDULING.md` (item 4)** and rewrite it around
   current `BackendPool`, `DelegationGate`, worker orchestration and `/system`
   telemetry. Implement only after the new plan distinguishes hard admission
   constraints from heuristic memory estimates.
9. Structured per-ecosystem build/test extraction for `/initForge` (item 8) and
   package-manager detection (item 9), which are one piece of work.
10. HTML fetch cleanup (item 11).

Items 10 and 12 were removed from the backlog entirely; they already ship.

## Candidate relic / historical Markdown documents to review

Do **not** delete these automatically. Several are useful historical design
records, but their names/checklists can mislead an agent into reimplementing
completed work. Review each and either remove it, move it under a clearly named
archive directory, or add a strong historical/completed banner.

Verified 2026-09-05 by reading each file's own status line. The repository is
already roughly 70% compliant with the status convention proposed below, which
made this survey cheap - a good argument for finishing the convention.

### Self-declared complete, corroborated - safe to archive

These carry an explicit implemented/validated status line of their own:

- `COMPACTION_STATE_LEDGER_PLAN.md` - "IMPLEMENTED 2026-08-27 (0.13.15), all
  four phases" (corroborated in code; see item 3)
- `COMPACTION_SUMMARIZER_REQUEST_PLAN.md` - "IMPLEMENTED 2026-08-22"
- `LAZY_TOOL_GROUPS_EXPERIMENT.md` - "implemented, measured, validated live"
- `PROMPT_PREFIX_STABILITY_PLAN.md` - implemented (0.13.18)
- `TOKEN_BAR_EXACT_USAGE_PLAN.md` - "IMPLEMENTED 2026-08-22"
- `LIVE_CTX_AND_WARM_DELEGATION_PLAN.md` - implemented (2026-08-15)
- `SESSION_TIME_STATUS_PLAN.md`, `SIDEBAR_UX_PLAN.md`,
  `SIDEBAR_UX_CLEANUP_PLAN.md` - implemented
- `SLOT_AFFINITY_AND_CHECKPOINTS_PLAN.md` - "measured and validated end-to-end"
- `REMOTE_WORKSPACE_DISCOVERY_PLAN.md` - implemented 2026-09-01
- `REMOTE_HANDOFF_TARGET_ALREADY_OPEN_PLAN.md` - implemented 2026-09-04
- `REMOTE_TOTP_AUTH_PLAN.md` - implemented, real-device validation passed
- `CLI_DAEMON_PLAN.md` - "implemented, validated, packaged, installed"
- `COMBINED_UNFINISHED_IMPLEMENTATION_PLAN.md` - status says the automated
  implementation/verification work is complete. The stale title is the single
  most dangerous filename in `docs/plans/`.

### The `REMOTE_CONTROL_PLAN` chain - six files, one shipped feature

Missed by the first pass of this review and the largest single cleanup
available. `REMOTE_CONTROL_PLAN_V4.md` says "implementation complete; Telegram
and TOTP real-device validation complete". The five documents beneath it are
superseded review iterations of the same feature:

- `REMOTE_CONTROL_PLAN.md` - "changes requested before implementation"
- `REMOTE_CONTROL_PLAN_V2.md` - "remaining corrections required"
- `REMOTE_CONTROL_PLAN_V3.md` - "awaiting two Codex sequencing clarifications"
- `REMOTE_CONTROL_PLAN_V3_FINAL_CLARIFICATIONS.md`
- `REMOTE_CONTROL_PLAN_V3_REVIEW_FINDINGS.md`

Archive V1-V3 as a set; keep V4 with a COMPLETE banner. Every one of the five
reads as live work-in-progress to an agent that opens it directly.

### Corrections to the first pass of this review

Three files this review nominated for archive should **stay**, on the evidence
of their own headers:

- `DELEGATE_SAFETY_AND_TOOL_ACCESS_PLAN.md` - its header says "report for
  review - **nothing implemented**". This review speculated it was superseded by
  current ToolRegistry/ToolDispatch architecture. That may yet be true, but it
  is an audit question, not an archival one.
- `CONFIG_OVERHAUL_PLAN.md` - "APPROVED - all questions (Q1-Q8) decided; ready
  for implementation". Not complete.
- `F6_PROFILES_PLAN.md` - "PLAN (implement in a fresh session). Breaking schema
  change." Genuinely open.

`AGENT_WORKER_ORCHESTRATION_REPORT.md`, `LOCAL_AGENT_DELEGATION_PLAN.md`,
`FORGE_HARDENING_AND_ONBOARDING_PLAN.md` and `F3_CHAT_PROXY_PLAN.md` carry no
status line at all and must be read before any decision.

### Compaction plans: review carefully, not blanket-delete

- `COMPACTION_RESUME_MISREAD_PLAN.md` - no status line; opens with an observed
  failure and a session id, so it reads as an incident record.
- `COMPACTION_SUMMARIZER_REQUEST_PLAN.md` - implemented; archive.
- `COMPACTION_STATE_LEDGER_PLAN.md` - implemented; archive. This review had
  flagged it as possibly containing the next architecture step. It does not; it
  shipped in 0.13.15.

### CLI plans: review against current `src/agents/`

- `CLI_CHECKPOINT_ARCHITECTURE_PLAN.md` - "Core implementation complete (Phases
  0-3 and hardening); isolated Git worktree prototype remains". Partially open:
  keep, with the remaining scope stated at the top.
- `CLI_DAEMON_PLAN.md` - complete; archive.

### No status line at all - read before deciding

15 files, including `VRAM_ADMISSION_PLAN.md`, `WORKER_REMOVAL_PLAN.md`,
`TOKEN_EFFICIENCY_PLAN.md`, `RELIABILITY_HARDENING_PLAN.md`,
`TESTING_BUGFIX_PLAN.md`, `VIDEO_ATTACHMENT_PLAN.md`,
`VISION_HISTORY_STRIPPING_PLAN.md`, `MODEL_READINESS_DOT_PLAN.md`,
`SIDEBAR_UI_REWORK_PLAN.md`, `REMOTE_OUTBOUND_EVENTS_PLAN.md`. Adding a status
line to each is the cheapest possible pass and should precede any deletion.

### Keep active for now

- `FUTURE_VRAM_FLEET_SCHEDULING.md` - "idea / not scheduled". Not a relic in
  concept; rewrite against current architecture (item 4).
- `NOTIFY_USER_PLAN.md`, `WHISPER_RESIDENT_SERVER_PLAN.md`,
  `QUESTION_SELECTION_PLAN.md`, `REMOTE_ASK_USER_PLAN.md`,
  `REMOTE_HELD_PROMPT_PLAN.md`, `SYSTEM_INFO_COMMAND_HANDOFF.md` - all
  self-declared proposed/draft/not-implemented.
- `ROADMAP.md` - still useful as the small canonical list of agreed unscheduled
  improvements, provided completed items are removed promptly.

## Documentation hygiene recommendation

The repo now has enough historical plans that plan-state ambiguity itself is becoming an engineering risk.

Recommended convention:

```text
docs/plans/active/      # only plans that contain live implementation work
docs/plans/completed/   # retained architecture/history, clearly completed
docs/plans/obsolete/    # superseded plans kept only temporarily if needed
```

Every plan should start with one machine/human-readable status line:

```text
Status: ACTIVE
Status: COMPLETE
Status: SUPERSEDED BY <path>
Status: HISTORICAL
```

Agents should be instructed to treat only `ACTIVE` plans as implementation instructions.

This is increasingly important because several existing files contain unchecked historical acceptance matrices underneath a header that says implementation is already complete.

---

## Final assessment

Forge's strongest product identity is not "another general autonomous agent". It is:

> **A high-reliability coding-agent runtime optimized for locally hosted models and finite local compute.**

The important differentiators are the parts generic cloud-first harnesses have little incentive to optimize heavily:

- local backend lifecycle and residency;
- finite VRAM-aware admission;
- small permanent prompts;
- lazy tool schemas;
- weak-model tool-call recovery;
- truncation-aware retries;
- reasoning suppression on recovery;
- host-owned permissions and mutation safety;
- durable task state across compaction;
- workspace-native LSP, checkpoints and diffs.

The next releases should deepen those advantages rather than expanding sideways.