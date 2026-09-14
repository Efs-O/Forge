# Forge 0.16 — Code-Grounded Documentation and Roadmap Audit

**Status:** implementation-derived maintenance report  
**Audit date:** 2026-09-14  
**Baseline:** current `main` / package version `0.16.0`  
**Audience:** local Forge agent performing the documentation cleanup

---

## Purpose

This report is derived from the current implementation, not from old plans. The task is to make the active documentation describe the code that exists now, remove already-implemented work from the roadmap, preserve genuinely open technical debt, and stop historical plans from being mistaken for current architecture.

The implementing agent MUST treat source code, tests, registries, schemas, and current config types as the source of truth. Old Markdown files are evidence of intent, not evidence of present behavior.

Do not mechanically rewrite every document. Fix factual drift first, then reorganize roadmap/history.

---

# Executive finding

Forge's codebase has advanced faster than its documentation. The current repository is no longer accurately summarized by the old `ROADMAP.md` or by several older delegation / architecture documents.

The implementation now has distinct subsystems for:

- the model/tool-calling loop and truncation recovery;
- dynamic tool registration and lazy tool exposure;
- local semantic code search;
- checkpointed workspace mutation, including disk-backed external-CLI rollback;
- CLI-agent direct chat and delegation;
- remote operation;
- compaction and conversation runtime state;
- Git-native recovery and mutation tools;
- background process execution;
- multimodal inspection and configured image generation;
- machine/system control and status.

This means the main documentation problem is no longer missing prose. It is **incorrect project state**: active documents still describe capabilities as future work after they have shipped, and some user-facing files describe CLI delegation with semantics that contradict the implementation.

### Severity summary

**P0 — factual contradictions / misleading current docs**

- `README.md`
- `docs/DELEGATION.md`
- `ROADMAP.md`
- `docs/COMMANDS.md`

**P1 — likely stale permanent/reference docs that must be checked against current code**

- `docs/SHARED_RUNTIME.md`
- `docs/REMOTE_CONTROL.md`
- `docs/LOCAL_MODEL_OPTIMIZATIONS.md`
- `docs/OWNERS.md`
- `docs/AGENT_TOOL_TRAPS.md`

**P2 — historical plans/reports that need explicit lifecycle status, not blind rewriting**

- `docs/FORGE_ARCHITECTURE_REVIEW_2026-09-05.md`
- `docs/REMOTE_COMPACT_PROGRESS_PLAN.md`
- delegation/worker plans and reports
- completed files under `docs/plans/`

---

# 1. Verified implementation facts that documentation must reflect

## 1.1 Tool surface is substantially broader than older docs imply

`src/tools/registerAllTools.ts` is the current registration source of truth. It registers file/edit tools, LSP tools, notebook tools, background execution, workspace tasks, web tools, durable memory, semantic search, Git reads/writes/recovery, system/power controls, delegation, vision/video, configured image generation, and lazy tool groups.

Important current tools include, among others:

- `get_editor_context`
- `find_implementations`
- `get_code_actions` / `apply_code_action`
- `read_tool_result`
- `update_plan`
- `search_codebase`
- `monitor_execution` / `stop_execution` / `list_executions`
- `restore_file`
- `list_delegation_targets`
- `ask_local_agent`
- `generate_image` when configured
- power/system tools

Documentation that presents an older smaller tool list must be corrected from the registry, not from memory.

## 1.2 CLI delegation is NOT read-only

This is the most important factual documentation bug found in the audit.

Current `ask_local_agent` behavior explicitly distinguishes targets:

- local/cloud model targets receive the delegated task plus optional context files and do not receive Forge's tool registry;
- CLI targets such as Claude/Codex run with their own tools;
- CLI targets are explicitly described by the implementation as unrestricted and able to edit files themselves;
- the tool description tells the primary agent it may delegate implementation, not only review;
- after CLI delegation errors/timeouts, the caller is warned to inspect Git state because the external agent may already have changed files.

`README.md` currently says external CLI agents are “read-only delegation targets”. `docs/DELEGATION.md` opens by saying CLI delegates use a read-only tool set, then later in the same document calls them full-rights external agents. Those statements cannot coexist.

### Required change

Make the implementation semantics authoritative:

- direct CLI chat: full-rights external agent using the CLI's own tools;
- CLI delegation: also allowed to inspect AND edit using the CLI's own tools;
- local/cloud delegation: bounded model call without Forge tools;
- rollback/checkpoint coverage and the warning about partial work after error/timeout must remain clearly documented.

Update both `README.md` and `docs/DELEGATION.md` in the same cleanup so they cannot drift in opposite directions again.

## 1.3 External CLI rollback is already disk-backed

The old roadmap item “CheckpointStack: disk-based snapshots” is already materially implemented.

Current `CheckpointStack`:

- owns a `DiskCheckpointStore`;
- stores `diskSnapshots` alongside in-memory file snapshots;
- can prepare whole-workspace or targeted-path disk checkpoints;
- uses a temp-backed default storage root unless configured otherwise;
- restores disk snapshots during Undo;
- keeps recovery data when an Undo is incomplete;
- discards disk recovery data after successful restoration/eviction.

This does not mean every Forge-native per-file snapshot is disk-only. The current design is hybrid: native file mutations retain memory state, while whole-workspace/external-CLI rollback is disk-backed. Documentation should describe that accurately rather than saying Forge still needs to “move CheckpointStack to disk”.

### Required change

Remove the old roadmap item in its current wording. If there is still a desired follow-up, rewrite it narrowly around a real remaining problem, for example memory pressure from very large Forge-native per-file mutations, only if current limits/tests show that is still relevant.

## 1.4 `format_file` hardening is already implemented

The roadmap says `format_file` is brittle because it operates on the active editor and suggests replacing that behavior with direct formatting-provider edits.

Current `makeFormatFileTool()` already:

- opens the target document without showing/activating an editor;
- refuses to overwrite unsaved unrelated user edits;
- invokes `vscode.executeFormatDocumentProvider` for the explicit URI;
- builds and applies a `WorkspaceEdit`;
- checks document version before applying returned ranges;
- saves the exact document;
- reports the no-formatter/no-edit cases explicitly.

The exact API differs from the old suggestion, but the underlying bug has been solved: formatting is target-file based and no longer depends on whichever tab is focused.

### Required change

Delete the old roadmap item. If formatter reliability still has a failing test/case, document the specific remaining case rather than carrying the obsolete active-editor description forward.

## 1.5 Git tools no longer depend on VS Code Git for execution

The old roadmap says Git tools fail if the VS Code Git extension is unavailable and proposes a CLI fallback.

Current `src/tools/gitRepo.ts` states and implements the opposite:

- Git commands execute through a single `runGit` path;
- `runGit` uses `execFile('git', args, ...)` without a shell;
- the VS Code Git extension remains only a discovery aid;
- missing `git` on PATH gets an explicit install/PATH error;
- repository selection is handled separately and supports nested/multiple repository correctness.

### Required change

Remove the Git-extension fallback item from `ROADMAP.md` entirely. Permanent Git docs should say the CLI is the execution source of truth and VS Code Git is optional discovery assistance, if that distinction is user-relevant.

## 1.6 Parallel tool execution is still genuinely open

Unlike the three items above, this old roadmap item is real.

`ToolCallingLoop` receives a batch of tool calls and hands it to `dispatchToolCalls`. Current `ToolDispatch.dispatch()` iterates calls with a sequential `for (const tc of toolCalls)` and awaits each tool before moving to the next.

That sequential execution is currently intertwined with:

- approval ordering;
- shared transcript mutation;
- checkpoint snapshots;
- mutation/diff rendering;
- tool budgets;
- cancellation;
- plan updates;
- failure tracking.

### Required change

Keep this as future work, but rewrite the roadmap item. Do NOT write “replace with `Promise.all`”. That is too naive for the current architecture.

The real future task should be something like:

> Add dependency-aware parallel dispatch for provably independent read-only tool calls while preserving deterministic tool-result ordering, cancellation, budgets, approvals, and mutation serialization.

Write tools, Git writes, approvals, plan changes, and stateful tools should remain serialized unless explicit dependency semantics are introduced.

## 1.7 Package-manager detection is still open

Current `run_tests` and `run_build` remain npm/npx-centric:

- `detectTestRunner()` returns `npm`/`npx` runners;
- `run_build` explicitly reads `package.json` and builds `npm run <script>`;
- Vitest/Jest/Mocha auto-detection still maps to `npx`.

### Required change

Keep the roadmap item, but update its description to current code. Add lockfile/package-manager detection for pnpm/yarn/bun only if Forge intends these structured tools to support them. Do not imply the rest of `exec_command` cannot run those executables manually.

## 1.8 `web_fetch` HTML conversion is still naive

Current `htmlToText()`:

- removes script/style blocks with regex;
- strips remaining tags with regex;
- collapses whitespace;
- does not decode entities or preserve meaningful block/line structure.

### Required change

Keep this roadmap item. Reword it around preserving readable text structure and decoding entities, with SSRF and output bounding left unchanged.

## 1.9 Tool-call truncation recovery is a real first-class subsystem

`ToolCallingLoop` now contains explicit recovery for truncated tool calls and context exhaustion. It distinguishes truncation from malformed-tool failure, avoids charging truncation to the model failure tracker, injects a protocol-correct failed tool result when needed, and temporarily suppresses thinking on the recovery round to give the retried tool call more output room.

### Required documentation consequence

`docs/LOCAL_MODEL_OPTIMIZATIONS.md` and README claims about local-model hardening should be checked against this implementation and describe this as current behavior, not experimental advice.

## 1.10 Delegation target exposure is context-aware

Current delegation code intentionally avoids putting the full target catalog in the base schema every turn. `list_delegation_targets` exists as on-demand discovery; the always-visible `ask_local_agent` schema only highlights configured CLI targets where useful.

This is an important current architectural pattern: capabilities that are expensive in prompt/KV surface are exposed on demand rather than blindly enumerated.

### Required documentation consequence

Any architecture/optimization documentation should describe this pattern as an implemented design, not merely a possible future optimization.

---

# 2. `ROADMAP.md` — exact disposition

The current file should be replaced, not appended to.

## Verified item-by-item status

| Existing roadmap item | Code-grounded verdict | Action |
| --- | --- | --- |
| Type while streaming | Not resolved by this source audit | Re-check current webview input-state code; keep only if still disabled during turns |
| FORGE.md hierarchy | Not resolved by this source audit | Verify `ForgeInstructionsLoader` behavior before keeping |
| `/initForge` model quality | Needs re-verification | Verify command still exists/current flow before retaining |
| `/initForge` non-JS projects | Needs re-verification | Verify command still exists/current flow before retaining |
| Parallel tool execution | **OPEN** | Keep, but redefine as dependency-aware parallel read dispatch, not blanket `Promise.all` |
| CheckpointStack disk snapshots | **IMPLEMENTED / OBSOLETE WORDING** | Remove from roadmap |
| `format_file` active-editor brittleness | **IMPLEMENTED / OBSOLETE** | Remove from roadmap |
| Git tools VS Code Git dependency/fallback | **IMPLEMENTED / OBSOLETE** | Remove from roadmap |
| package-manager detection | **OPEN** | Keep/update |
| `web_fetch` HTML-to-text quality | **OPEN** | Keep/update |

## New roadmap structure

The new roadmap should describe remaining product/architecture work, not old defects that have shipped.

Recommended structure:

### A. Orchestration and delegation

- richer delegation lifecycle/result attribution;
- safe composition of local, cloud and CLI specialists;
- worker/delegation observability;
- concurrency only where ownership and rollback are explicit;
- better recovery after interrupted delegated work where needed.

### B. Local-model efficiency and context economy

- preserve prompt-prefix/KV stability;
- continue demand-loaded tool exposure;
- improve semantic retrieval/compaction only where measurements justify it;
- minimize duplicated tool output/context;
- model-specific recovery kept behind generic interfaces where possible.

### C. Durable state and recovery

- clearly distinguish what already survives reload from what does not;
- unfinished-turn recovery if still incomplete;
- durable state for long-running remote/agent workflows where justified;
- memory pressure of native per-file checkpoints only if verified as a remaining issue.

### D. Remote operation

- maintain sidebar/remote semantic parity where appropriate;
- preserve durable delivery/approval correctness;
- improve remote UX without coupling core runtime to Telegram;
- keep future dedicated mobile client support as an architecture concern, not Telegram-specific hacks;
- keep basic Forge Telegram remote control independent from any wake relay: it should work whenever the PC and VS Code/Forge are already running;
- treat remote wake and machine lifecycle as an optional second layer for users who need control while the PC is asleep or Forge is offline;
- do not make HalluScribe an installation prerequisite for Forge users merely because the current Windows Host Controller implementation happens to live in that workspace;
- avoid making airOS hardware a requirement: the durable architecture should define an always-on LAN relay role that can be implemented by airOS, Raspberry Pi/Linux, OpenWrt, NAS, Home Assistant, another Windows host, or similar devices;
- prefer one signed, allow-listed Windows Host Controller implementation rather than duplicating controller servers in Forge and HalluScribe; if the controller is truly application-neutral, consider extracting it to a standalone repository;
- preserve the trust boundary: Telegram/relay inputs should select only fixed allow-listed program/action pairs, never arbitrary executable paths or shell fragments;
- document the two-level onboarding clearly: **Basic remote** = Forge Telegram only, PC already awake; **Full remote** = always-on relay + Wake-on-LAN + signed Host Controller for wake/application lifecycle, after which Forge Telegram can take over.

**Product decision still open:** exact repository ownership and packaging of the Windows Host Controller. Current discussion favors an application-neutral standalone component if it controls VS Code/HalluScribe/other approved programs, but this must be decided only after inspecting the unpushed controller implementation. Do not force this decision during the documentation cleanup.

### E. Multimodal and specialist capabilities

- current cloud/OpenAI-style image generation is shipped;
- local ComfyUI or other local image backends can remain future work if still desired;
- artifact/file lifecycle and specialist handoffs should remain composable with checkpoints and remote surfaces.

### F. Reliability / developer experience backlog

Keep verified concrete items such as:

- dependency-aware parallel read dispatch;
- package-manager detection;
- proper HTML-to-text conversion;
- any verified FORGE.md hierarchy or `/initForge` gaps;
- UI typing-while-streaming if still open.

---

# 3. `README.md` — required corrections

`README.md` is generally much closer to current Forge than the old roadmap, but it contains important drift.

## P0 fixes

### Fix CLI delegation semantics

Current README says:

> External CLI agents ... as full-rights direct-chat models and read-only delegation targets

That is false against `ask_local_agent` today. Replace with wording that makes both direct-chat and delegated CLI execution full-rights external-agent paths, while explaining that Forge checkpoints eligible workspace changes for rollback.

### Update “What's New”

The file currently summarizes 0.15/0.14/0.13 even though package version is 0.16.0 and 0.16 includes substantial new behavior. Refresh this section or make it deliberately version-agnostic and point to `CHANGES.md`.

### Update agent capability inventory

At minimum verify/add current behavior around:

- `restore_file`;
- `generate_image` when configured;
- Git commit amend semantics if intended for user docs;
- multi-question `ask_user` behavior;
- delegation target discovery;
- current Telegram command/album/progress behavior where README exposes it.

Do not blindly dump every tool into README. The registry should remain the reference source; README should describe capability classes and the highest-value tools.

---

# 4. `docs/DELEGATION.md` — required rewrite for consistency

This file currently contradicts itself.

Its opening says CLI delegates use a read-only tool set and cannot edit. Later it says a `provider: cli` model is a full-rights external agent. Current source code supports the latter.

## Required canonical behavior section

Rewrite the first section around these exact distinctions:

1. **Local llama.cpp / Ollama delegation** — task plus bounded selected context; no Forge tool loop.
2. **Cloud model delegation** — same bounded delegated-call model unless provider-specific code says otherwise.
3. **CLI agent delegation** — one-shot external CLI process with its own tools; may inspect AND modify the workspace; caller must inspect state after timeout/error because work may have occurred.
4. **Direct CLI chat** — warm per-conversation/model session with full external-agent behavior.
5. **Checkpoint model** — external CLI changes are covered by disk-backed workspace checkpointing when enabled; opt-out weakens Keep/Undo and must remain clearly warned.

Remove every “read-only CLI” claim unless a separate sandbox/permission mode actually exists in current code.

---

# 5. `docs/COMMANDS.md` — regenerate or reconcile from `package.json`

This file says it contains every command contributed to the palette, but the current `package.json` contributes many commands not present in the document excerpt, including model/config and remote-control operations.

## Required action

Compare the entire `contributes.commands` array in `package.json` against `docs/COMMANDS.md` and make the table complete.

Prefer adding an invariant test or generation/check script so a future command addition cannot silently make the reference false again.

Do not mix Telegram slash commands into this file unless it intentionally becomes a cross-surface command reference. If both are desired, use explicit VS Code and remote sections.

---

# 6. Historical architecture/plans — status them instead of rewriting history

## `docs/FORGE_ARCHITECTURE_REVIEW_2026-09-05.md`

Keep it as a dated review. Add a clear banner stating that it reflects the repository on 2026-09-05 and predates later 0.15.x/0.16 work. Do not mutate old findings until they look current.

If Forge wants a living architecture document, create/update `docs/ARCHITECTURE.md` separately.

## `docs/REMOTE_COMPACT_PROGRESS_PLAN.md`

It already labels most work implemented. Verify the remaining real-device smoke item. If complete, mark the plan `COMPLETED / HISTORICAL` and link to the permanent remote/compaction docs.

## Delegation plans/reports

Audit:

- `docs/CLOUD_DELEGATION_PLAN.md`
- `docs/DELEGATION_UNBLOCK_PLAN.md`
- `docs/SAFE_WORKER_TOOL_UPGRADE_PLAN.md`
- `docs/AGENT_WORKER_ORCHESTRATION_REPORT.md`
- related `docs/plans/*DELEGAT*` / worker files

Current code has a concrete one-shot `LocalDelegationService`, CLI runner, target eligibility/limits, CLI direct-chat sessions, and `ask_local_agent`/`list_delegation_targets`. Historical worker terminology must not override this current model.

For each old plan, add:

```md
**Status:** proposed | active | partially implemented | implemented | superseded | abandoned
**Last verified:** 2026-09-14
**Current behavior:** <canonical doc link>
**Remaining work:** <only real unfinished items>
```

Do not delete architectural rationale that still explains safety decisions.

---

# 7. Permanent docs requiring a second code-backed pass

These are not proven wrong by the specific mismatches above, but their subject areas have changed enough that they must be checked directly against code before the cleanup is considered complete.

## `docs/SHARED_RUNTIME.md`

Verify against current conversation ownership, `AgentLoop`, host facade, remote reach/progress listeners, compaction events, and transport outbound event wiring.

## `docs/REMOTE_CONTROL.md`

Verify current Telegram behavior from remote handlers/transport code, especially:

- status-only edited progress bubble;
- permanent narration/final messages;
- command auto-delete policy;
- `/model`/`/models` behavior;
- `/view` replay;
- photo album batching and image limits;
- approvals/questions;
- compaction events;
- FIFO/rate-limit behavior;
- sidebar-started turn mirroring.

Also preserve the distinction between ordinary Forge Telegram control and optional remote-wake infrastructure. The permanent docs should not imply that airOS, HalluScribe, or a wake relay is required for normal Telegram use. A future 4G/wake guide should explain generic relay-host requirements first and airOS as one implementation.

Do not rely on `REMOTE_CONTROL_VALIDATION.md` as current behavior; validation history and user-facing behavior are different document roles.

## `docs/LOCAL_MODEL_OPTIMIZATIONS.md`

Verify against current `ToolCallingLoop`, tool-result bounding, lazy groups, semantic search, context publisher and request normalization. In particular, make sure truncated-tool recovery and thinking suppression are described exactly as implemented today.

## `docs/OWNERS.md`

Reconcile with the current module topology (`agent`, `agents`, `checkpoint`, `delegation`, `remote`, `search`, `system`, etc.).

## `docs/AGENT_TOOL_TRAPS.md`

Delete traps the code has already fixed. This file should describe traps that still exist today, not a bug cemetery.

---

# 8. Suggested living architecture document

Create or refresh `docs/ARCHITECTURE.md` only after the factual corrections above.

It should be implementation-derived and cover:

1. Extension activation and runtime composition
2. Conversation/session ownership
3. Model/provider routing
4. Local llama.cpp lifecycle
5. Agent/tool-calling loop
6. Tool registry, permissions, approvals and lazy exposure
7. Workspace mutation and checkpointing
8. Git execution/safety/recovery
9. Context construction, truncation recovery and compaction
10. Semantic search/indexing
11. Delegation and CLI-agent architecture
12. Remote-control architecture
13. Background execution/system controls
14. Vision/video/image generation
15. Persistence boundaries
16. Security/trust boundaries

The architecture doc must distinguish CURRENT behavior from FUTURE roadmap work.

---

# 9. Local-agent execution order

Perform the cleanup in this order:

1. **Fix P0 factual contradictions** in `README.md` and `docs/DELEGATION.md`.
2. **Rewrite `ROADMAP.md`** using the verified disposition above; do not leave implemented bugs as future work.
3. **Reconcile `docs/COMMANDS.md`** with `package.json` and add a drift check if practical.
4. **Audit permanent subsystem docs** against their owning source modules.
5. **Status historical plans/reports** rather than rewriting them as current docs.
6. **Create/refresh `docs/ARCHITECTURE.md`** only after source-of-truth docs agree.
7. Run tests/lint/docs link checks and any catalog/registry audit scripts already present.
8. Finish with a report containing:
   - files changed;
   - factual contradictions fixed;
   - roadmap items removed as already implemented;
   - roadmap items retained as verified open work;
   - plans marked historical/superseded;
   - unresolved items that require product decisions rather than documentation edits.

---

# 10. Guardrails for the implementing agent

- Do not change production behavior merely to make old documentation true. Change the docs to match correct current code unless an actual code bug is found.
- Do not remove safety caveats around destructive tools, external CLI agents, remote auth, checkpoints or billed image generation.
- Do not mass-delete plans.
- Do not promote an old plan into the roadmap without verifying the code gap still exists.
- Do not turn `ROADMAP.md` into a release changelog.
- Do not duplicate the tool registry manually across many docs if one canonical reference can be linked.
- Where practical, add invariant tests/generation checks for command/tool catalogs so this drift is harder to recreate.

---

# Bottom line

The previous roadmap was not merely “old”; several entries are now factually obsolete against `main`.

The clearest verified examples are:

- disk-backed external-CLI checkpoints: **already implemented**;
- tab-independent direct formatter execution: **already implemented**;
- Git CLI execution independent of VS Code Git: **already implemented**;
- parallel tool execution: **still open**;
- pnpm/yarn/bun detection in structured build/test tools: **still open**;
- proper HTML-to-text conversion: **still open**;
- CLI delegation documented as read-only: **documentation is wrong; current code allows CLI delegates to edit**.

The cleanup should therefore be a source-driven reconciliation pass, not a general prose refresh.