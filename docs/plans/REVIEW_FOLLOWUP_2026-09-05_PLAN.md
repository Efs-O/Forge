# Review follow-up (2026-09-05) — implementation plan

Status: **DRAFT — evaluated and corrected 2026-09-05; implementation not started by this review.**

Source: [architecture review](../FORGE_ARCHITECTURE_REVIEW_2026-09-05.md).
This plan supersedes its original implementation sketches where they disagree.
It covers the immediate correctness, instruction-loading and documentation work,
keeps parallel tools and resource work gated, and adds compaction fidelity as
priority work following the user's clarification.

## Review decisions and scope

The user delegated the Git and instruction-budget decisions and identified the
main compaction problem: lost task details lead to repeated work or unnecessary
re-investigation. Useful verification must remain possible.

- **B:** use `runGit` for the remaining tool execution methods; keep the VS Code
  Git API as a discovery aid. Do not fabricate a partially implemented API object.
- **C:** allocate the instruction budget root-first. Preserve repository-wide
  rules ahead of nested guidance; disclose every truncation or omission.
- **H:** prioritize preservation of completed work and the exact continuation
  point. Do not start by raising thresholds, summary size or the resume cap.
- **D:** publish runtime documentation under `docs/LOCAL_MODEL_OPTIMIZATIONS.md`.
  Plan status classification requires evidence; it is not a mechanical header edit.
- **E:** measure before adding concurrency; no implementation regardless of data.

This revision changes only this plan. It does not authorize installation, live
configuration changes or commits. Existing unrelated working-tree changes must
be preserved. Source work below is future implementation scope; optional schema
additions in H require evidence and backward-compatible parsing.

## A — Make `format_file` independent of editor focus

**Priority: HIGH.** Owner: `src/tools/fileEditTools.ts`.

### Evidence and correction

The current handler opens an editor, runs `editor.action.formatDocument`, saves
its original document and may close the active editor. Focus changes can make
those editor commands act on another document. Closing a tab is disruptive but
is not inherently irreversible; remove the original draft's contrary claim.

### Design

1. Resolve the requested URI and call `workspace.openTextDocument` only.
2. Obtain document-scoped, language-aware formatting options. Reuse a matching
   visible editor's resolved options when available without activating it.
   Otherwise resolve the document's editor configuration and validate types;
   a TypeScript generic does not convert a configuration string into a number.
   Specify handling of automatic indentation settings explicitly rather than
   hardcoding `4` and `true` as hidden overrides.
3. Capture the document version and request edits through
   `vscode.executeFormatDocumentProvider`. Use the installed VS Code API typings
   and an extension-host probe to verify provider selection and no-result
   behavior, including multiple formatters and the configured default formatter.
4. Before applying returned edits, reject a stale document version or cancelled
   operation. Apply a URI-scoped `WorkspaceEdit`; check the boolean result.
   This version check guards the provider await; do not claim that it makes
   every concurrent editor/save operation transactional.
5. Check `doc.save()` and report an unsaved change explicitly if it returns
   false. Never report `Formatted` before successful save. Preserve the buffer
   and checkpoint when applying succeeds but saving fails.

Retain `mutation: { paths, showDiff: true }`; static mutation metadata already
provides the checkpoint path. Do not add a duplicate snapshot implementation.
Do not use `showTextDocument`, active-editor commands or close-editor commands.

An empty edit list means no edits were returned. An undefined result must not
be advertised as proof that the file was already formatted. If the provider
command cannot distinguish absence from no edits, report the ambiguity plainly:
`No formatting edits returned; a formatter may not be available.` Surface actual
provider errors. Do not add a second formatter-selection subsystem just to
produce a more specific message.

### Validation

- Unit tests for rejected edits, false save, provider error, stale version and
  cancellation. No success report on these failure paths.
- Extension-host integration test with a registered formatter: content saved,
  unrelated editor remains active and open, visible editors unchanged.
- No-provider, no-op provider and multiple-provider cases. A provider stub in an
  extension host is an integration test, not a unit test.
- Retain Keep/Undo behavior and avoid unexpectedly discarding dirty buffers.

## B — Git tools without the VS Code Git extension

**Priority: HIGH.** Owner: `src/tools/gitRepo.ts`.

### Evidence and corrected scope

`repositories()` currently throws when the API is absent or reports no repos.
Three execution sites still use API methods: `repo.log`, `repo.createBranch`
and `repo.checkout`. Other commands already use Git directly.

Discovery changes have more than four callers. `getRepoForPaths()` also calls
`repositories()`, and `gitCwd()` calls `getRepo()`. Callers in `gitReadTools.ts`,
`gitTools.ts` and `sidebar/repoSnapshot.ts` must be included in the async audit.
Existing handlers being async does not mean they already await these helpers.

### B1 — One execution path

Move the three methods to `runGit`, preserving error context and visible tool
semantics. Narrow the shared repository handle to the fields actually consumed
by tools after auditing uses. Adapt API roots to that handle; do not retain
unused mandatory methods and then force-cast `{ rootUri }` to satisfy them.

- Log: preserve count/ref handling, author and commit date, first-line message
  display, and explicitly test the no-commit case. Validate count and refs before
  passing argv. Use unambiguous record framing; control separators such as
  `\x1f`/`\x1e` are not guaranteed absent from commit messages. Test separator
  characters, Unicode, multiline messages and empty history. Do not silently
  change from first message line to a differently normalized subject.
- Branch creation/switch: use branch-only semantics with no path-checkout
  ambiguity, option injection or unintended detached HEAD. A plain
  `git checkout <name>` sketch is insufficient because `<name>` can be a path.
  Validate branch/start-point inputs, choose supported Git commands explicitly,
  and preserve the permission/confirmation gate.
- Keep process spawning argument-based, with bounded execution/output and clear
  errors. Reuse the existing helper rather than duplicate shell execution.

### B2 — Discovery and selection

Activate the Git extension when available before requesting its API. Handle
unavailable/throwing APIs visibly in diagnostics and use CLI discovery for the
explicitly supported API-absent/no-matching-repository cases.

For an explicit path/cwd, resolve the directory (including files and nonexistent
new-file paths) and use Git to identify its nearest enclosing repository.
Account for partially discovered API repositories so an outer API root does not
silently capture work intended for a nested repo. Preserve explicit-target and
cross-repository protections on both paths.

Without a location, consider the workspace-folder roots and API-discovered
roots, deduplicate using platform-aware path identity, and reject ambiguity.
Do not recursively scan arbitrary workspace trees. If a non-repository workspace
contains undiscovered child repositories, require an explicit cwd; probing only
the workspace root cannot discover them. Support worktrees with `.git` files.

`getRepoForPaths` must resolve every stage path against a consistent discovery
view and reject batches spanning repositories. Preserve the invariant through
async propagation; do not swallow an ambiguity error in `gitCwd` and select an
arbitrary workspace root. Audit the optional repo-snapshot caller separately:
its best-effort policy must not become the policy for user-invoked Git tools.

Distinguish missing Git, non-repository paths, invalid cwd, permissions and Git
trust errors. Preserve relevant stderr and the attempted location. The original
catch-all example erased these distinctions. Give an actionable remedy, such
as installing Git or supplying cwd, without advertising a possibly unavailable
`run_command` tool or bypassing Git trust checks.

### Files and validation

- `gitRepo.ts`, `gitReadTools.ts`, `gitTools.ts`, affected `repoSnapshot.ts`
  wiring and their tests. Split helpers only if the owner becomes impractical;
  the original no-new-modules promise was premature.
- Extend `test/integration/GitCwdAndLocation.test.ts`: API absent, activation
  failure, empty/partial discovery, nested repos, worktrees, multiple workspace
  roots, explicit files/directories and cross-repository staging.
- Mutation tests: a file sharing the requested branch name is never restored;
  invalid/option-like refs are rejected; create/switch/stage/commit stay gated.
- Log framing and failure diagnostics; exercise all tools through CLI discovery,
  not just status/log/diff. Account for async changes in every caller.

## C — Hierarchical `FORGE.md` inheritance

**Priority: HIGH.** Owner: `src/llm/ForgeInstructionsLoader.ts`.

Today `instructionsFor(target)` selects the nearest repository root bounded by
the workspace, then loads one file. `turnModelBehavior.ts` supplies the active
file; this change does not make instructions follow every tool's target path.

### Design

Keep the repository-boundary semantics of `resolveInstructionScopeRoot` and
collect directories from that root to the resolved target directory. At each
level prefer `FORGE.md`, otherwise `AGENTS.md`. Skip absent levels. Nested Git
repositories start their own chain; do not inherit from unrelated outer roots.
Preserve outside-workspace fallback behavior and verify symlink boundaries so
an in-workspace instruction path cannot read outside the permitted boundary.

Render root-to-leaf with source-relative paths and scopes. State that deeper
instructions are more specific and override conflicting project guidance only
within their scope. This expresses intended instruction precedence; it is not
a guarantee that the model will comply. Do not imply precedence over host
permissions or higher-priority instructions.

Use one **15,000-byte total rendered budget**, including delimiters and omission
markers. Allocate root-first, then ancestors toward the leaf. Truncate at valid
UTF-8 boundaries. A 14 KB root plus 4 KB leaf preserves the root and includes
only the leaf portion that fits with its delimiters and warning. If no leaf
content fits, mark it omitted. A root larger than the total remains truncated
with a visible warning; root-first is not a promise to retain unlimited rules.
Preserve single-file content/limits where possible and document any delimiter
cost rather than promising byte-for-byte unchanged behavior.

Cache file contents and assembled chains separately. File-content caching must
not retain a version truncated to another chain's remaining allocation. Clear
both caches on instruction create/change/delete; recompute repository scope or
include it in the chain key so changing `.git` boundaries does not reuse stale
inheritance. Reset warning suppression when the relevant content changes.
Distinguish normal absence from unreadable files; report actual read failures.

### Validation

Root/leaf/intermediate chains, per-level file preference, nested repositories,
outside targets, directories and new file paths; root-first budget with
multibyte text and exact rendered-size assertions; oversized single file;
create/change/delete invalidation, changed repository boundary, unreadable file
and symlink escape. Extend `test/unit/ForgeInstructionsLoader.test.ts`.

Keep `(target?: string) => string | undefined`; prefer internal helpers over new
exports unless needed. Update the owner description and release notes. Per-tool
scope injection and include/import directives remain out of scope.

## D — Document shipped runtime optimizations

**Priority: MEDIUM.** README plus `docs/LOCAL_MODEL_OPTIMIZATIONS.md`.

Explain truncation-aware recovery, temporary thinking suppression, lazy tool
groups, bounded tool results, prefix stability, per-slot context budgets and the
compaction ledger. Link canonical owners and existing measurements. Distinguish
native Forge behavior from CLI agents' own context/session management.

Correct the original README proposal: a truncated tool call is not dispatched
as complete, and a recovery request is not guaranteed to finish the partial
arguments. Describe bounded retries with smaller write chunks and temporary
thinking suppression; do not promise exactly one retry or that the partial call
is safely completed. Verify wording against the recovery owner before publishing.

For compaction, explain what survives, what can be omitted and when a targeted
recheck remains appropriate. H's proposed improvements must not be described as
shipped until implemented and verified.

Audit the review's allegedly status-less plans before assigning statuses. A
header alone does not prove implementation. Use ACTIVE, COMPLETE, HISTORICAL or
SUPERSEDED with evidence; unresolved cases stay explicitly unverified. Do not
claim a fixed count or completed implementation without checking. Keep status
cleanup separate from runtime documentation. No archive moves/deletions here.

## E — Parallel independent tool calls (measurement gate)

**Priority: MEDIUM, gated.** Owner: `src/sidebar/ToolDispatch.ts` and registry.

### E0 — Measure attainable benefit

Existing `toolMs` measures the entire dispatch iteration, including approval
waiting and bookkeeping, and is absent for zero-duration calls. It is not pure
handler execution time. Inspect log schema and coverage before computing rates.
Do not deduplicate globally by row content minus timestamp: legitimate repeated
calls can be identical. Use stable conversation/message/call identity and
verified replay boundaries, preserving genuine repeats. Attribute versions only
where logged evidence supports them; exclude or label unknown versions.

Measure contiguous eligible runs and estimated savings at the proposed cap
(initial candidate: 4), rather than all safe calls anywhere in a round. Exclude
approval time from claims of parallelizable work. Report missing timings and
whether round-wall-clock timing can actually be reconstructed. If not, add a
small local measurement probe; do not manufacture a precise ratio.

Proposed engineering gate, fixed before measurement: at least 30 eligible
multi-call runs from at least 5 representative conversations, with estimated
median savings of both 1 second and 10% of the enclosing model/tool round.
These are decision thresholds, not observed results. Insufficient coverage means
inconclusive; negligible benefit closes the item with evidence. H has priority.

### E1 — Only if measured benefit justifies it

Use bounded **contiguous batches**, with serial barriers for every other call.
Do not pre-approve, charge budgets or apply stateful failure decisions for the
whole round before execution. Resolve those decisions at each batch/barrier in
call order, preserving the existing charging behavior even for declined calls.

`parallelSafe?: boolean` defaults false. Registration and runtime checks reject
mutation metadata, approvals, write/terminal/headless/git-write access and
unresolved dynamic permissions for a parallel batch. Audit each candidate's
actual side effects and handler state; read permissions alone do not prove
safety. Start with a small verified subset of file/search/Git reads; LSP tools
need their own audit. No MCP, terminal or delegate calls by default.

Handlers in a batch receive a stable transcript view from its start; tools that
need preceding same-batch results remain serial. Commit exactly one result per
call in original order, update failure tracking in that order, and keep
checkpoints and mutation UI at serial barriers.

On cancellation stop scheduling, signal in-flight handlers, and settle them
before advancing the lifecycle. Use per-call error capture/all-settled behavior;
a fast rejection must not leave background handlers racing the next turn.
Do not overwrite a known completed result with a synthetic cancellation.

Extract cohesive helpers if needed. The repository guideline is **350 LOC where
practical**, not a 500-line hard stop. Planning with approvals is not pure.

Tests must prove overlap, cap enforcement, reverse completion order, serial
barriers, permission rejection, once-only budget charging, ordered failures,
transcript snapshot semantics and cancellation with a slow/non-cooperative
handler. Existing serial behavior must remain unchanged when no tools opt in.

## F — Disk-backed per-turn checkpoints (gated)

**Priority: MEDIUM.** Existing `DiskCheckpointStore`, `CheckpointStack` and
`CheckpointSession` are the owners; memory-backed per-tool capture still exists.

Reuse the disk store rather than creating a second subsystem, but do not call
this a trivial callback swap before checking synchronous capture signatures,
dirty editor buffers, pre-write timing, binary content, missing files, cleanup,
error handling and Keep/Undo restoration. Disk-read snapshots must not replace
newer unsaved buffer content. Preserve `.forge` and `.forge-*` exclusions.
Promote on measured memory pressure or a separately agreed implementation pass.

## G — VRAM fleet scheduling (separate audit)

**Priority: MEDIUM-HIGH strategic.** Rewrite
`FUTURE_VRAM_FLEET_SCHEDULING.md` against the current pool, delegation admission,
shared runtime and telemetry owners before proposing implementation. Separate
hard constraints from heuristic estimates. No model starts, eviction policy or
new scheduling subsystem in this plan revision.

## H — Preserve task details across auto-compaction

**Priority: HIGH — user-reported repeated work/token waste.** This is fidelity
work, not a proposal to eliminate useful verification or rebuild the ledger.

### H0 — Existing behavior and source-backed risks

Already implemented: separate model summary and host-recorded outcomes,
verbatim user context, optional last reply, a bounded protocol tail, persisted
full transcript, conversation-addressed continuation, and a two-auto-resume cap.
User-history rendering already says old requests are not new requests. Preserve
that safeguard. The active `conv.plan` is separate state used by model turns;
do not create a competing plan inside `CompactionState`.

The current code exposes concrete candidate failure mechanisms:

1. `compactionRecordedState.capActions` prioritizes non-successes, then durable
   evidence, then fills remaining slots in insertion order. Since merged entries
   are oldest-to-newest, older entries can evict recent successful work. Enough
   old failures can fill all 24 slots per kind. The omission count is not retained
   by the merge, so later rendering of already-capped state cannot disclose it.
2. `compactionLedger` derives command identity from a shortened label or the
   first apparent artifact path. Working directory is not part of that identity.
   Distinct commands/cwds can collapse, while failure and success observations
   can acquire different keys. Path keys are lowercased on every platform.
3. Summary source uses a bounded head/tail excerpt, so completed investigation
   findings in the middle can disappear. The deterministic ledger records writes
   and commands, not the semantic conclusions of all reads/searches.
4. `collectLastReply` keeps the beginning of a long message; its final next step
   can be lost. Visible commentary can also be followed by tool execution, but
   the renderer currently says nothing has happened since that message unless
   later context says otherwise. Temporal wording must respect those tool results.
5. Summary, user context, ledger, repo state and last reply have separate caps.
   `retainedTailCost` omits tool-call arguments and returns zero for non-string
   content. A 4,000-character tail allowance is not a complete request budget.

These are verified code properties, **not proof of which caused the user's
particular session**. No live affected transcript was examined in this review.

### H1 — Evidence retention and identity first

Create transcript fixtures reproducing ledger saturation, repeated compactions
and command-key collisions before changing retention. Prefer a user-identified
incident if available, but synthetic fixtures can establish the code defects.
Record source message/tool-call identity and sequence where needed using
optional, backward-compatible fields. Existing saved conversations must load.

Keep operation identity separate from display labels and quoted output paths.
Use complete structured command arguments plus cwd and relevant execution
options for stable identity; use platform-aware path rules. Output mentioning a
path is evidence, not a reliable universal identifier. A successful `read` or
`exists` probe must not erase the distinct operation that installed/wrote it.
Repeated test runs after changes remain separate observations or carry clear
latest-run ordering. Legacy keys must not be upgraded by inventing missing cwd.

Replace oldest-first retention with an explicit bounded policy that protects
recent successful work, latest relevant failures/unknowns and durable outcomes.
Use fixtures to choose category reserves; do not let any category consume every
slot. Merge newer outcomes for the same operation without retaining a stale
failure as an unresolved blocker. Persist bounded omission metadata so missing
entries are not interpreted as proof an action never happened.

A recorded successful command means it exited successfully at that time; it
must not assert that current files are unchanged or that all tasks are complete.
An unknown terminal paste must remain unknown. External Undo, edits and changed
inputs can legitimately invalidate earlier conclusions.

### H2 — Carry completed findings and the continuation point

Extend the existing summary structure rather than add a speculative facts
subsystem. Give State a concise account of completed steps and investigation
conclusions with their supporting file/tool references. Next must name the
actual pending action, pending user answer or completion state. Errors must
separate unresolved blockers from historical failures already resolved.

Supply the existing plan snapshot to summarization if the request does not
already carry it. Label it agent-maintained; tool outcomes are separate evidence.
A stale plan item is not authority to rerun a recorded successful action.
Reserve source space for recent completion reports and decision-bearing exchanges
instead of relying solely on a raw head/tail character slice. Do not fabricate
host-confirmed facts from model-authored reasoning or copy every read result.

Preserve the ending of long last replies along with enough opening context to
identify the message, using explicit truncation markers and the existing cap.
Label commentary as last visible text at its recorded point, not necessarily the
last event. Later recorded tool outcomes must remain authoritative about what
executed after it. Preserve commentary separately from reasoning.

Resume guidance should say: continue from the recorded Next; avoid rerunning
completed operations solely because compaction occurred. If verification is
needed, identify the stale/unknown/contradictory fact and check that narrowly.
Do not add a blanket 'trust everything' instruction, mandatory opening audit,
extra model call or prohibition on re-reading code before a new edit.
Keep the short internal resume trigger; place task state in replacement context.

### H3 — Fit and continuation safeguards

Measure the fully assembled replacement request through the existing budgeting
path, including system/project instructions, current plan, schemas, preserved
state, protocol arguments, attachments and output room. Reuse per-slot context
and reasoning/output accounting; do not subtract the reasoning reserve twice.

Compare original and candidate windows before committing compaction. Reserve
space for the next useful request and configured output using existing budget
owners. Estimates must be labeled; do not call a locally estimated count exact.
If the candidate does not reduce context or still cannot fit, do not enter an
automatic compact/resume loop. Keep the prior usable state and report the reason.
Define explicit bounded trimming with visible omissions; never remove completed
work wholesale just to make the token bar look smaller.

Keep current opt-in controls, threshold and two-resume cap for this pass.
Retain post-turn execution, cancellation/ownership checks, queued-user-input
ordering, complete tool-call/result pairs and full transcript persistence.
Any threshold or cap change needs separate measurements after fidelity fixes.
This scope is Forge-native compaction; do not imply it controls CLI agents'
internal compaction algorithms.

### Owners and acceptance

Extend `compactionLedger.ts`, `compactionRecordedState.ts`,
`compactionUserContext.ts`, `compactionLastReply.ts`, `compactionPrompt.ts`,
`compactionSplit.ts`, `compactionWindow.ts` and `CompactionService.ts` at their
existing boundaries; touch `compactionTypes.ts`/persistence only for demonstrated
provenance/omission needs. Reuse `ContextBudgetPublisher`, request-budget owners
and `autoCompactionPolicy.ts`. Split oversized owners by concern as needed.

Extend the corresponding CompactionLedger, CompactionLastReply, CompactionBudget,
CompactionWindow, CompactionUserContext, CompactionService and AutoCompactionPolicy
suites with these behavior-level cases:

- More than 24 actions, including stale failures and recent successes: completed
  work survives, omitted history is disclosed, and newer outcomes supersede
  older observations of the same operation.
- Same command in different cwd; long shared prefixes; same artifact referenced
  by different operations; case-sensitive paths; legacy saved state.
- Two or more compactions retain a completed edit/test outcome, a resolved error,
  the user's correction and the actual next action without turning history into
  a fresh request. Reload preserves the same evidence.
- Long reply with Next at the end; commentary followed by successful tools;
  successful install versus pasted/unexecuted command; stale evidence after Undo.
- Large arguments, images and a saturated ledger: full request accounting,
  valid protocol, useful reduction or an explicit no-resume outcome.
- New user input during compaction, cancellation, failure and conversation
  switching preserve the existing lifecycle guarantees.

For model behavior, replay matched continuation cases through Forge's configured
control API/model path, following AGENTS.md and releasing test holds. Do not
launch a configured executable directly. Compare multiple baseline/candidate
runs with the same model and sampling settings. Record retained task facts,
incorrect repeats, justified targeted checks, time/tokens to the first genuinely
new action, and total replacement-context cost. A prompt inspection alone cannot
prove the model stopped repeating work. No automatic ban on repeated tool calls:
identical reads can be legitimate after edits. Ship no claim of reduced waste
without recording the comparison and its limitations.

## Implementation sequence and gates

1. **H0/H1:** reproduce retention/identity failures and fix evidence loss.
2. **H2/H3:** preserve continuation details, enforce fit, then compare resumed
   behavior. Keep these as separately reviewable changes.
3. **A, B:** independent correctness fixes; may be interleaved with H validation.
4. **C:** instruction inheritance with the selected root-first policy.
5. **D:** document verified final behavior; classify old plans separately.
6. **E0:** measure parallelism after fidelity work; E1 only if its gate passes.
7. **F/G:** separate promotion; no automatic expansion into runtime scheduling.

Before implementation, inspect current status and applicable instructions;
recheck referenced owners rather than trust historical line numbers. Preserve
unrelated changes and the live `.forge` configuration. Source fixes need focused
regressions and both canonical gates: `npm run ci` and `npm run package` before
finishing. Stage only named intended files if commits are later requested.
Packaging success is not evidence of live model behavior or editor integration.

No unanswered product-policy questions block this draft. Remaining investigations
are explicitly identified acceptance work, not permission to implement all gated
items. This document records recommendations; runtime changes are not yet made.
