# Forge 0.16 Documentation & Roadmap Modernization Audit

**Status:** action plan for the local Forge agent  
**Baseline:** current `main`, Forge 0.16.x  
**Purpose:** bring project documentation, roadmap, plans, and architectural descriptions up to the level of the implementation that now exists.

---

## Executive assessment

Forge has evolved materially beyond the project described by the older roadmap and several older planning documents.

The current project is no longer well described as only a VS Code chat extension with local-model tooling. The implementation now includes substantial pieces of a **local-first agent runtime / orchestration layer**:

- local model lifecycle and llama.cpp integration;
- structured tool execution and checkpointed workspace mutation;
- Git-aware safety and recovery tools;
- compaction and context-management infrastructure;
- semantic codebase search;
- remote control through Telegram;
- durable remote notifications and progress handling;
- sidebar/remote shared runtime behavior;
- specialist/CLI delegation work;
- image generation as a callable specialist capability;
- multimodal result handling;
- provider/model switching and cloud interoperability.

The documentation must now describe the system that exists, not the system Forge was several months ago.

### Current assessment

- **Overall project:** 8.8/10
- **Local-first coding-agent niche:** 9.2/10
- **Documentation / roadmap alignment with current architecture:** materially below the implementation quality and now a maintenance risk.

The remaining gap to a truly top-tier agent runtime is not primarily a lack of more tools. The important work is orchestration quality, delegation, state/recovery durability, composability, context efficiency, and architectural/documentation coherence.

---

# Instructions to the implementing agent

Do **not** treat this document as permission to mechanically rewrite files.

For every documentation change:

1. Inspect current `main` implementation first.
2. Verify public behavior against the actual command registry, tool registry, configuration schemas, runtime code, tests, and relevant `CHANGES.md` entries.
3. Determine whether the existing document is:
   - **CURRENT** — accurate enough; leave it alone except for minor corrections.
   - **STALE** — useful but contains outdated behavior; update it.
   - **SUPERSEDED** — historical implementation plan whose completed design is now documented elsewhere; mark/archive or replace with a short historical note if appropriate.
   - **PARTIALLY IMPLEMENTED** — preserve unfinished work, but clearly distinguish implemented vs pending sections.
   - **OBSOLETE** — assumptions are no longer valid; remove from active guidance or replace with a current document.
4. Never mark a feature implemented based only on a plan or old report. Find the code/test evidence.
5. Never delete useful historical design rationale unless the same information survives elsewhere.
6. Prefer one authoritative current document over several overlapping documents that disagree.
7. When a plan is fully implemented, convert its useful design rationale into the appropriate permanent documentation and then mark the plan as completed/historical rather than leaving it looking actionable.
8. Preserve compatibility and safety warnings that still matter.
9. Run documentation/link/command tests where available after changes.
10. End the work with a concise report listing:
    - files changed;
    - files intentionally left unchanged;
    - documents archived/superseded;
    - unresolved documentation questions;
    - roadmap items verified as still open.

---

# Priority 0 — verify the current product surface

Before changing documentation, build a concise inventory from code.

Verify at minimum:

- current extension version;
- registered slash commands and aliases;
- registered agent tools;
- Git tools and their safety/confirmation semantics;
- compaction entry points and triggers;
- delegation / worker capabilities;
- remote-control transports and current Telegram behavior;
- image generation and `view_image` behavior;
- semantic search/indexing behavior;
- supported providers and credential paths;
- shared sidebar/remote runtime behavior;
- checkpoint behavior and recovery scope;
- model lifecycle / llama.cpp configuration surfaces;
- current FORGE.md behavior;
- current CLI-agent integration behavior.

This inventory becomes the source of truth for the documentation pass.

---

# Priority 1 — replace the obsolete roadmap model

## `ROADMAP.md`

**Expected status: STALE / structurally obsolete.**

The current roadmap is still organized around an earlier stage of Forge and currently lists a small set of UX/tooling edge cases as if they represent the primary future direction of the project.

Do not simply append newer features below it.

### Required action

Audit every existing item against current code, then rewrite `ROADMAP.md` around the architecture Forge actually has today.

Suggested top-level structure:

### 1. Agent orchestration & delegation

Examples of questions to resolve:

- Can the primary local agent delegate specialist work cleanly and cheaply?
- Are worker lifecycles, scopes, permissions, and result synthesis mature?
- Can Forge choose between local, CLI, cloud, search, and image specialists without bloating the base tool/prompt surface?
- Are delegation results inspectable, checkpointed, resumable, and attributable?
- Are concurrent independent workers safe?

### 2. Local-model efficiency & context engineering

Focus on:

- context economy;
- selective/hierarchical tool exposure;
- semantic retrieval quality;
- compaction fidelity;
- prompt-prefix stability / cache friendliness;
- model-specific quirks and recovery;
- avoiding unnecessary tool-result/context duplication;
- parallel independent reads/searches where safe.

### 3. State, recovery & long-running autonomy

Focus on:

- durable checkpoints;
- process/VS Code restart recovery;
- unfinished-turn recovery;
- worker/session state;
- crash-safe remote operation;
- resumability after compaction;
- auditability of mutations and delegated work.

### 4. Remote operation

Treat Telegram as a real remote UI, not a notification add-on.

Focus on:

- parity with sidebar workflows where sensible;
- stable long-running sessions;
- approvals and structured questions;
- model/session switching;
- transcript/navigation quality;
- attachments/multimodal interaction;
- groundwork for a future dedicated iOS client without coupling core runtime logic to Telegram.

### 5. Multimodal & specialist capabilities

Focus on:

- image generation provider abstraction;
- vision/image inspection;
- possible local ComfyUI or other local backends;
- artifact handling;
- future specialist tools only when they compose cleanly with the agent loop.

### 6. Reliability, safety & observability

Focus on:

- Git safety/recovery;
- checkpoint guarantees;
- structured errors;
- tool failure recovery;
- remote-delivery correctness;
- model/runtime telemetry;
- traceability of context/tool/delegation decisions.

### 7. UX and lower-priority backlog

Move still-valid smaller items here rather than allowing them to define the project direction.

The existing roadmap items must be individually verified. Some may remain good backlog entries, including potentially:

- FORGE.md hierarchy;
- parallel independent tool execution;
- stronger checkpoint storage;
- package-manager detection;
- formatter reliability;
- improved non-JS `/initForge` behavior;
- better HTML-to-text conversion;
- typing while a turn is running.

But **do not preserve any item merely because it is listed here or in the old roadmap**. Verify current code first.

---

# Priority 2 — reconcile plans with implementation

The `docs/` and `docs/plans/` directories now contain a mixture of permanent documentation, architecture reviews, implementation plans, progress documents, and completed design work.

That is useful during rapid development but becomes dangerous when old plans remain visually indistinguishable from current behavior.

Audit all planning documents.

## High-priority files to inspect

### `docs/REMOTE_COMPACT_PROGRESS_PLAN.md`

The document already describes itself as implemented except for a real-device progress smoke check.

Verify the remaining smoke-test status. If the design is now fully implemented and validated:

- preserve useful architecture in permanent compaction/remote documentation;
- clearly mark this file **COMPLETED / HISTORICAL**, or move its remaining actionable item to the current roadmap/testing backlog;
- do not leave it looking like an active implementation plan.

### `docs/COMPACTION_PLAN.md`

Compare against the current compaction implementation and newer compaction-related plans.

Resolve duplicated or conflicting descriptions of:

- trigger types;
- summarizer requests;
- state ledgers;
- resume behavior;
- remote progress events;
- validation/apply behavior.

There should be a clear current compaction architecture document and clearly labeled historical plans.

### `docs/CLOUD_DELEGATION_PLAN.md`
### `docs/DELEGATION_UNBLOCK_PLAN.md`
### `docs/SAFE_WORKER_TOOL_UPGRADE_PLAN.md`
### `docs/AGENT_WORKER_ORCHESTRATION_REPORT.md`
### `docs/DELEGATION.md`

These are especially important because delegation appears to have evolved through several iterations.

Determine which file should be authoritative for **current behavior**.

Recommended outcome:

- `docs/DELEGATION.md` = current user/developer-facing delegation architecture and behavior;
- historical plans/reports = clearly marked with status, implementation result, and remaining gaps;
- unresolved work = moved into the current roadmap or a single active implementation plan.

Do not let five documents describe five different generations of worker/delegation semantics without status labels.

### `docs/FORGE_ARCHITECTURE_REVIEW_2026-09-05.md`

Treat as a **dated snapshot**, not current architecture documentation.

Do not rewrite history to make the old review look current. Add a prominent note if necessary explaining that it reflects the repository on 2026-09-05 and may predate later 0.15.x/0.16.x work.

If a current architecture overview is missing, create one separately rather than mutating the historical review into one.

### `docs/LOCAL_MODEL_OPTIMIZATIONS.md`

Verify every recommendation against current runtime behavior and model configuration.

Pay particular attention to anything involving:

- context sizing;
- batching;
- KV cache types;
- flash attention;
- speculative/MTP behavior;
- multi-GPU assumptions;
- model-specific flags;
- prompt/tool exposure strategies.

Runtime recommendations age quickly. Mark version/model-specific advice explicitly.

### `docs/REMOTE_CONTROL.md`
### `docs/REMOTE_CONTROL_VALIDATION.md`

Bring these in line with the current Telegram implementation, including where verified:

- status-only progress bubble behavior;
- permanent narration/final messages;
- command cleanup;
- `/model` and `/models` behavior;
- `/view` behavior;
- album/photo handling;
- approvals and structured questions;
- compaction events;
- sidebar-started turn mirroring;
- rate-limit/FIFO handling;
- warning delivery semantics.

Separate current user-facing behavior from validation history.

### `docs/COMMANDS.md`

Compare directly with the command registry and tests.

Ensure aliases, remote availability, parameters, and behavior are current. Generate/validate from registry metadata if practical to reduce future drift.

### `docs/SHARED_RUNTIME.md`

Verify that it still accurately describes the relationship among sidebar, remote controllers, host runtime, conversation ownership, and outbound events.

If orchestration has grown beyond this document, update or replace it with a broader current architecture document.

### `docs/OWNERS.md`

Verify ownership mappings against current module layout. Remove references to moved/deleted modules and include newer major subsystems where appropriate.

### `docs/AGENT_TOOL_TRAPS.md`

Keep this practical. Remove traps that the implementation has since eliminated and add only traps that still exist in current tool semantics.

---

# Priority 3 — audit every file under `docs/plans/`

Do a full pass over `docs/plans/`.

For each file, add or normalize a compact header if one does not already exist:

```md
**Status:** proposed | active | partially implemented | implemented | superseded | abandoned
**Last verified:** YYYY-MM-DD
**Superseded by:** <path, if applicable>
```

Use statuses based on code evidence, not filenames.

Likely candidates for verification include plans concerning:

- compaction/resume/state ledger;
- CLI checkpoint architecture;
- CLI daemon behavior;
- coding benchmark smoke tests;
- configuration overhaul;
- delegate safety/tool access;
- delete/restore gaps;
- exact embedding tokenization;
- `exec_command` environment support;
- image generation;
- Telegram/remote behavior;
- worker orchestration.

Several of these areas appear to have received implementation work by 0.16.0. Completed plans should stop masquerading as future work.

### Do not mass-delete completed plans

Historical plans are useful when they explain why safety or architecture decisions exist.

Prefer:

- clear status;
- completion/result note;
- link to current implementation docs;
- link to relevant commit/CHANGES entry where useful.

Delete only documents that are pure duplication with no durable historical value.

---

# Priority 4 — create or refresh one authoritative architecture overview

If no current equivalent exists, create:

`docs/ARCHITECTURE.md`

It should describe the **current system**, not future aspirations.

Suggested sections:

1. Extension/runtime overview
2. Conversation and agent loop
3. Model/provider layer
4. Local llama.cpp model lifecycle
5. Tool registry and dispatch
6. Workspace mutation + checkpoint model
7. Git safety model
8. Context construction and compaction
9. Semantic code search/indexing
10. Delegation / workers / specialist agents
11. Remote-control architecture
12. Sidebar/remote shared runtime
13. Multimodal and image-generation flow
14. Persistence/state boundaries
15. Security and approval boundaries
16. Major extension points

Include diagrams using Mermaid if useful, but favor accuracy and maintainability over decorative complexity.

Architecture documentation should make clear which layer owns each behavior so future contributors do not reimplement the same feature in sidebar, Telegram, and worker paths independently.

---

# Priority 5 — improve README positioning

Audit `README.md` after the architecture and command inventory are verified.

The README should communicate what Forge is **now**.

Do not overload it with every internal detail, but ensure the opening accurately represents Forge as a local-first coding agent runtime/harness rather than merely a model chat UI.

The feature overview should reflect major differentiators that are genuinely implemented, for example where verified:

- local llama.cpp-first operation;
- agentic VS Code tooling;
- safe checkpointed edits and Git operations;
- semantic code search;
- compaction/long-context management;
- Telegram remote control;
- CLI/cloud delegation;
- multimodal/image tooling;
- configurable providers/models.

Avoid version-sensitive implementation claims in the opening unless they are automatically maintained.

---

# Priority 6 — documentation invariants to add where practical

The long-term fix for documentation drift is not another manual cleanup pass.

Where inexpensive, add checks that fail when documentation-critical registries drift.

Candidates:

- every visible slash command appears in generated/validated command documentation;
- aliases are documented correctly;
- public tool names in docs exist in the tool registry;
- config keys shown in sample YAML exist in the config schema;
- examples do not reference removed model/provider fields;
- current version claims are not hardcoded in multiple places;
- active-plan links resolve;
- completed plans are not linked from sections labelled "future" without their status.

Do not build a large documentation framework solely for this cleanup. Add only cheap invariants with a clear maintenance payoff.

---

# Roadmap principles for Forge after 0.16

Use these principles when deciding what remains on the roadmap.

## 1. Do not optimize for raw tool count

A local model pays a context/selection cost for every exposed capability. Prefer composable primitives and selective exposure over a huge flat registry.

## 2. Treat delegation as a first-class primitive

A strong local 27B-class model does not need to personally be the best model for every subtask. Forge should make specialist escalation cheap, bounded, inspectable, and resumable.

## 3. Preserve local-first operation

Cloud specialists should enhance Forge rather than turn the core product into a thin API frontend.

## 4. Keep safety structural

Continue preferring narrow, typed, checkpointed capabilities over granting generic shell/Git primitives simply because they are convenient.

## 5. Optimize for long-running sessions

Compaction, recovery, remote control, state persistence, and context efficiency matter more than isolated benchmark-demo features.

## 6. Keep UI transports thin

Sidebar, Telegram, and a future mobile client should sit on top of shared host/runtime capabilities wherever possible. Avoid implementing agent semantics separately in each transport.

## 7. Verify before documenting

The repository is moving quickly enough that implementation is the source of truth. Documentation should be generated or mechanically validated from registries/schemas when that is economical.

---

# Suggested final document topology

This is a target, not a mandatory rename/delete list.

```text
README.md                         # product overview + quick start
ROADMAP.md                        # current strategic future work only
CHANGES.md                        # release/change history
FORGE.md                          # agent/project instructions if applicable

docs/
  ARCHITECTURE.md                 # current architecture, authoritative
  COMMANDS.md                     # current command reference
  DELEGATION.md                   # current delegation/worker behavior
  REMOTE_CONTROL.md               # current remote behavior
  SHARED_RUNTIME.md               # retain only if distinct from ARCHITECTURE
  LOCAL_MODEL_OPTIMIZATIONS.md    # current, version-qualified runtime guidance
  AGENT_TOOL_TRAPS.md             # current known behavioral traps
  OWNERS.md                       # current code ownership/module map
  ...

  plans/
    <active plans>
    <historical plans with explicit status>
```

Avoid having an unlabelled collection of `*_PLAN.md` files where nobody can tell which ones remain actionable.

---

# Concrete acceptance criteria

The documentation modernization is complete when all of the following are true:

- [ ] `ROADMAP.md` reflects Forge's current strategic direction rather than the May-era feature set.
- [ ] Every old roadmap item has been checked against current implementation.
- [ ] Every plan under `docs/` and `docs/plans/` has an understandable current status.
- [ ] Completed plans no longer appear to be active future work.
- [ ] Delegation documentation has one authoritative current description.
- [ ] Compaction documentation has one authoritative current description.
- [ ] Remote-control docs match current Telegram behavior.
- [ ] `COMMANDS.md` matches the current command registry.
- [ ] README accurately describes Forge 0.16-era capabilities.
- [ ] A current architecture overview exists and matches the code.
- [ ] Historical reviews remain identifiable as historical snapshots.
- [ ] No documentation claims a feature exists merely because an implementation plan proposed it.
- [ ] No significant implemented 0.16-era subsystem is absent from the product/architecture documentation without a deliberate reason.
- [ ] Obsolete duplication is archived, merged, clearly superseded, or removed.
- [ ] Useful unresolved work discovered during the audit is moved into the new roadmap rather than being stranded in old plans.
- [ ] Tests/checks used by the documentation cleanup pass.

---

# Deliverable from the local agent

After completing the audit, create a report at:

`docs/DOCUMENTATION_MODERNIZATION_RESULT.md`

The report should contain:

1. **Summary** — what changed and why.
2. **Current roadmap** — top strategic priorities after verification.
3. **Files updated** — one sentence per file.
4. **Files marked historical/superseded** — and what replaced them.
5. **Files deleted** — only if any, with rationale.
6. **Still-open documentation gaps**.
7. **Code/documentation mismatches discovered**.
8. **Tests/checks run**.
9. **Recommended next engineering action** — one primary recommendation, not a large wishlist.

Do not perform unrelated feature implementation during this documentation pass. If documentation inspection exposes a real code bug or missing capability, record it in the result and roadmap unless a tiny correction is required to make documentation truthful.
