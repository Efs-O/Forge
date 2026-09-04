# Forge Architecture Review — 2026-09-05

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
- truncated-tool-call recovery with thinking suppression;
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

---

## Genuinely unfinished / still worthwhile

### 1. Parallel execution of independent tool calls

**Priority: HIGH**

`ToolDispatch.dispatch()` currently iterates model-emitted calls sequentially.

The goal should not be a naive `Promise.all(toolCalls)`. Add a small execution classifier / conflict detector:

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

A first version can parallelize only tools explicitly marked `parallelSafe: true` and fall back to current serial behavior for everything else.

Expected benefit: lower wall-clock latency on multi-file inspection without increasing model context usage.

### 2. Hierarchical FORGE.md inheritance

**Priority: HIGH**

Extend current repository-aware scoping to path hierarchy inside a repository.

Recommended semantics:

1. load repository-root `FORGE.md` / fallback `AGENTS.md`;
2. walk from repository root toward the target directory;
3. append the nearest matching instruction files in deterministic order;
4. cap total bytes/tokens;
5. clearly delimit each scope in the injected text;
6. cache by target directory and invalidate via the existing watcher.

This should combine very well with lazy tool groups: keep permanent instructions small and expose package-specific guidance only when work enters that part of the tree.

### 3. Re-audit the compaction state-ledger design

**Priority: HIGH for review; implementation decision after audit**

Forge now has a durable plan and significant compaction fixes, so older compaction plans may be partly obsolete.

The next architecture question is whether the durable state should evolve from a simple plan into a small host-owned task ledger containing some subset of:

- objective;
- completed items;
- active item;
- blockers;
- confirmed facts/decisions;
- modified files;
- build/test state;
- next action.

Do not inject a giant ledger every round. The point is structured, selectively injected continuity after compaction, not another permanent prompt tax.

### 4. Re-open VRAM fleet scheduling

**Priority: MEDIUM-HIGH strategic**

The old fleet-scheduling idea is much more actionable now because Forge has:

- backend pool ownership;
- delegation holds;
- worker orchestration;
- model-route classification;
- process/GPU VRAM telemetry;
- local/cloud/CLI target distinctions.

Before implementation, re-read the old plan and rewrite it against current architecture instead of coding directly from the historical document.

Potential future responsibilities:

- model residency score/cost;
- GPU affinity;
- preferred placement for Whisper vs chat models;
- queueing rather than rejection when appropriate;
- warm-model reuse scoring;
- worker admission based on current telemetry plus configured limits;
- optional multi-GPU target preferences.

Avoid pretending VRAM telemetry is a perfect predictor of whether a future model load will succeed.

### 5. Disk-backed checkpoints

**Priority: MEDIUM**

Current source-code-sized checkpoints are fine, but full file contents in JS memory do not scale cleanly to large generated files or binary-ish workloads.

Move snapshots to a turn-owned temporary directory while preserving the existing CheckpointSession/Keep/Undo API.

### 6. Make `format_file` editor-independent

**Priority: MEDIUM**

Replace active-editor-command behavior with `vscode.languages.getDocumentFormattingEdits()` or equivalent direct document formatting APIs.

### 7. Git CLI fallback

**Priority: MEDIUM**

Keep the VS Code Git API as the preferred path but add a clear fallback to the installed `git` executable when the extension API is unavailable.

### 8. `/initForge` multi-language project detection

**Priority: MEDIUM**

Add project detection for at least:

- Python: `pyproject.toml`, `requirements.txt`;
- Rust: `Cargo.toml`;
- Go: `go.mod`;
- optionally .NET and Java after the architecture is generic.

### 9. Package-manager detection for build/test tools

**Priority: LOW-MEDIUM**

Detect pnpm/yarn/bun/npm from lockfiles/config rather than assuming npm.

### 10. Type while streaming

**Priority: LOW-MEDIUM UX**

Allow prompt composition while a turn is running, while keeping submission disabled or treating Enter according to existing queue/steer semantics.

### 11. Better HTML-to-text conversion for `web_fetch`

**Priority: LOW**

Replace regex-oriented conversion with a bounded proper HTML-to-text parser that preserves basic block spacing and decodes entities.

### 12. `/initForge` output recovery

**Priority: LOW**

Some local models still return tool-style JSON where raw markdown is expected. Add a conservative extraction/retry path rather than broad prompt growth.

---

## Recommended next engineering sequence

### Phase 1 — latency and context efficiency

1. **Parallel safe tool execution.**
   - implement explicit parallel-safety metadata or a small scheduler;
   - begin with read-only independent tools only;
   - preserve current serial behavior by default.
2. **Hierarchical FORGE.md.**
   - deterministic inheritance;
   - strict size budget;
   - reuse existing watcher/cache architecture.

These two changes should give immediate benefit to local 27B-class models without expanding the permanent system prompt.

### Phase 2 — long-session reliability

3. **Audit `COMPACTION_STATE_LEDGER_PLAN.md` against current code.**
4. Decide whether to extend `update_plan` into a small durable execution ledger.
5. Add only the state fields proven useful by real failed/resumed sessions.

The objective is not bigger context. It is better continuity when context has to be compacted.

### Phase 3 — local-resource orchestration

6. **Re-audit `FUTURE_VRAM_FLEET_SCHEDULING.md`.**
7. Rewrite the plan around current BackendPool, DelegationGate, worker orchestration and `/system` telemetry.
8. Implement only after the new plan distinguishes hard admission constraints from heuristic memory estimates.

### Phase 4 — hardening

9. Disk-backed checkpoints.
10. `format_file` robustness.
11. Git CLI fallback.
12. Package-manager and multi-language `/initForge` improvements.
13. HTML fetch cleanup and smaller UX items.

---

## Candidate relic / historical Markdown documents to review

Do **not** delete these automatically. Several are useful historical design records, but their names/checklists can mislead an agent into reimplementing completed work. Review each and either remove it, move it under a clearly named archive directory, or add a strong historical/completed banner.

### Strong candidates for archive/removal review

- `docs/plans/COMBINED_UNFINISHED_IMPLEMENTATION_PLAN.md`
  - Despite the filename, its status says the automated implementation/verification work is complete.
  - The stale title is particularly dangerous for future agents.

- `docs/AGENT_WORKER_ORCHESTRATION_REPORT.md` / worker orchestration planning document(s)
  - Worker orchestration is implemented; historical unchecked acceptance boxes remain in the plan.
  - Keep only if useful as architecture rationale; otherwise archive.

- `docs/plans/LOCAL_AGENT_DELEGATION_PLAN.md` if still present
  - The combined plan explicitly says its bounded read-only consultation work was completed and must not be reopened/duplicated.

- `docs/plans/FORGE_HARDENING_AND_ONBOARDING_PLAN.md`
  - Much of the hardening work was incorporated into the completed combined plan.
  - Review for remaining unique acceptance items before removal/archive.

- `docs/plans/DELEGATE_SAFETY_AND_TOOL_ACCESS_PLAN.md`
  - Current ToolRegistry/ToolDispatch and worker/delegation permission architecture may supersede most of it.
  - Audit before deletion because it may still contain rationale worth preserving.

- `docs/plans/LAZY_TOOL_GROUPS_EXPERIMENT.md`
  - Lazy/demand-loaded tool groups are already a shipped core feature.
  - Likely a good archive candidate unless it contains benchmark evidence still referenced elsewhere.

- `docs/plans/F3_CHAT_PROXY_PLAN.md`
  - `ControlChatProxy` now exists; likely historical implementation plan.

- `docs/plans/F6_PROFILES_PLAN.md`
  - Profiles are in current runtime/config flows; check whether any acceptance item remains genuinely open.

- `docs/plans/CONFIG_OVERHAUL_PLAN.md`
  - Candidate historical plan; verify against current config resolver/writer/wizard architecture.

### Compaction plans: review carefully, not blanket-delete

- `docs/plans/COMPACTION_RESUME_MISREAD_PLAN.md`
- `docs/plans/COMPACTION_SUMMARIZER_REQUEST_PLAN.md`
- `docs/plans/COMPACTION_STATE_LEDGER_PLAN.md`

The first two may be mostly completed incident/implementation records. `COMPACTION_STATE_LEDGER_PLAN.md` may still contain the next genuinely useful architecture step, so audit it before archiving anything.

### CLI plans: review against current `src/agents/`

- `docs/plans/CLI_CHECKPOINT_ARCHITECTURE_PLAN.md`
- `docs/plans/CLI_DAEMON_PLAN.md`

Current code already contains persistent CLI session machinery, Codex app-server support and workspace checkpoint integration. Determine whether these plans are completed, partially superseded or still contain live work.

### Keep active for now

- `docs/plans/FUTURE_VRAM_FLEET_SCHEDULING.md`
  - This is not a relic in concept. It should be rewritten against current architecture and may become a major future feature.

- `ROADMAP.md`
  - Still useful as the small canonical list of agreed unscheduled improvements, provided completed items are removed promptly.

---

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
