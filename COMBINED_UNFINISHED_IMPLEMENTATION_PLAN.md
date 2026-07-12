# Forge Combined Unfinished Implementation Plan

## Purpose

This document consolidates the unfinished work identified in:

- `LOCAL_AGENT_DELEGATION_PLAN.md`
- `FORGE_HARDENING_AND_ONBOARDING_PLAN.md`
- `docs/OWNERS.md`

It contains only missing work, incomplete acceptance criteria, and required
verification. Existing functionality should be reused rather than rebuilt.

## Status Update — 2026-07-13

The implementation and automated verification portions of this plan are now
complete. The checklist below is retained as the original planning baseline;
the completed work is represented by commits `b91b516` through `3680efd`.

Completed after the original baseline:

- native local delegation (A1–A3), including primary-turn cancellation;
- MCP per-tool permission classification with a real stdio MCP fixture (A4);
- delegation activity labels, documentation, and ownership updates (A5, A7);
- first-run validated config generation and non-destructive Add Model merging
  (B2);
- checkpoint rollback/Keep coverage and pending-mutation cancellation (B3);
- automated release checks, plus local Ollama and direct llama.cpp smoke tests
  (B4);
- the stale confirmation-owner correction and ownership audit (C).

Remaining release verification requires interaction in a VS Code extension host:

- first-run UI with several real GGUF files and Ollama tags;
- Add Model UI confirmation/backup behavior against an existing user config;
- native `ask_local_agent` UI smoke cases (same model/profile, two direct
  models, capacity rejection, and Stop during a consultation).

### Live UI finding — 2026-07-13

`permissions.agents.delegate: true` was enabled in the workspace config and
validated. The configured local targets were eligible, and direct llama.cpp
plus local Ollama chat requests were both smoke-tested successfully. However,
two primary models tested in the Extension Development Host (a local Gemma and
Qwen-3 Coder 480B through the local Ollama daemon) replied that they lacked
`ask_local_agent` access instead of emitting a native or fallback tool call.
They also incorrectly claimed terminal permission was required; it is not.

This does not invalidate the service, schema, permission, or dispatch tests,
which are green. It does mean tool selection by the primary model is not a
reliable manual entry point for this feature. Before calling native delegation
production-ready, choose one of these follow-ups:

- add a direct, user-invoked `Ask Local Agent` command/UI that calls the
  existing `LocalDelegationService` and retains the same `delegate` gate; or
- qualify and document one primary model/template that reliably calls the
  existing native tool.

## Current Baseline

Forge already has the following delegation prerequisites:

- `permissions.agents.delegate`, defaulting to `false`;
- the `delegate` `ToolPermission` capability;
- permission-resolution tests proving delegation is opt-in;
- `BackendPool.canDelegate(primaryModel, targetModel)` as a read-only capacity
  and non-eviction query;
- same-base-model/profile handling in `BackendPool`;
- best-effort classification for Ollama delegation targets;
- the neutral `src/tools/resultCap.ts` result-capping owner.

Historical clarification: commit `6af836b` added the opt-in delegation
permission. It did not add `BackendPool.canDelegate`, which already existed.

Native delegation is not usable yet. There is no `ask_local_agent` tool or
`LocalDelegationService`.

## Scope and Version-One Contract

Version one is bounded, read-only consultation:

- the primary Forge agent asks one configured local model for analysis;
- the delegated model receives only the explicit task and selected context;
- the delegated model receives no tools and cannot edit files or run commands;
- the primary agent remains responsible for subsequent actions;
- the primary backend must not be evicted to satisfy delegation;
- no recursive or parallel delegation;
- no separate conversation tab or long-lived worker history;
- no cloud-model delegation;
- no dependency on Forge Relay or an additional MCP server.

Requests such as "have qwen write this function" mean that qwen returns proposed
code or analysis. The delegated model does not write the function into the
workspace itself.

## Workstream A: Native Local-Agent Delegation

### A1. Complete backend safety primitives

- [x] Review `BackendPool.canDelegate` against the final service call flow.
- [x] Ensure the safety check and backend acquisition cannot race into an LRU
      eviction of the active primary backend. (`DelegationGate` pins
      primary+target; LRU eviction skips pinned keys.)
- [x] Add a non-evicting acquire/hold operation to `BackendPool` if the existing
      `acquire()` cannot enforce that guarantee atomically.
      (`acquireForDelegation()` → `DelegationHold`; check+pin+slot-claim are one
      synchronous segment.)
- [x] Keep alias and `model@profile` normalization owned by
      `ConfigResolver`/`BackendPool`; do not duplicate it in the service.
      (`DelegationGate` only sees pool keys via `poolKey()`.)
- [x] Track and release delegation holds without stopping a backend still used by
      another request. (Hold release only unpins — never stops; idempotent.
      `BackendPool.release()` refuses models pinned by a live hold.)
- [x] Preserve Ollama's best-effort status and surface daemon load failures or
      stalls clearly.
- [x] Make error text distinguish slot capacity from actual RAM/VRAM headroom.

Acceptance:

- Capacity `1` rejects a different llama.cpp model without eviction.
- Capacity `2` permits a different llama.cpp model when a slot is available.
- Two profiles of the same base model reuse the same backend.
- An already loaded target is reusable.
- Ollama is explicitly reported and documented as best-effort.
- Success, cancellation, and failure release all holds.

### A2. Implement `LocalDelegationService`

Canonical location: a new `src/delegation/` module directory, split to respect
the 350 LOC limit:

- `src/delegation/LocalDelegationService.ts` — orchestration (acquire, dispatch,
  stream, release);
- `src/delegation/eligibility.ts` — target eligibility + alias/profile
  resolution glue (delegates actual normalization to `ConfigResolver`);
- `src/delegation/limits.ts` — all named limits and the consultation
  system-prompt builder.

Create the canonical service module and inject its dependencies. It must:

- [ ] Resolve aliases and `model@profile` through the existing config resolver.
- [ ] Accept configured local llama.cpp and local Ollama targets only.
- [ ] Reject xAI, OpenAI, OpenRouter, generic OpenAI-compatible, Ollama cloud,
      unknown, and otherwise ineligible targets with clear errors.
- [ ] Identify the primary base model separately from its request-time profile.
- [ ] Call the backend pool's non-mutating safety query before acquisition.
- [ ] Acquire/reuse a backend without evicting the primary backend.
- [ ] Read only explicitly requested, workspace-contained context files.
- [ ] Reuse the existing path-containment guard rather than creating a second
      implementation.
- [ ] Build a consultation system prompt requiring analysis only, no tool calls,
      no claims of edits/execution, and filename citations for supplied context.
- [ ] Dispatch through the existing chat/request-normalization/streaming owners.
- [ ] Send no tool definitions to the delegated model.
- [ ] Stream internally into a bounded result buffer.
- [ ] Cap returned text through `src/tools/resultCap.ts`.
- [ ] Propagate the primary turn's cancellation signal through startup and
      streaming.
- [ ] Enforce one named delegation timeout and abort timed-out work.
- [ ] Surface capacity, startup, template, timeout, cancellation, and provider
      errors in the primary conversation.

Named, tested limits:

- maximum context files: 8;
- maximum bytes per file: 256 KiB;
- maximum combined context: 1 MiB;
- maximum task length: 4,000 characters;
- maximum returned text: 24,000 characters — deliberately aligned with the MCP
  `max_result_chars` default, since oversized tool results have previously
  blown 32K-token slot contexts and caused silent stalls;
- maximum output tokens: default 1,024, hard cap 4,096 (the tool's
  `max_output_tokens` arg may lower but never exceed the cap);
- delegation-duration timeout: 120 seconds, covering startup plus streaming.

### A3. Add the native `ask_local_agent` tool

- [ ] Create `src/tools/localAgentTool.ts`.
- [ ] Define a strict JSON schema with `additionalProperties: false`.
- [ ] Require `model` and a length-bounded `task`.
- [ ] Support optional bounded `context_files`, `focus`, and
      `max_output_tokens`.
- [ ] Restrict `focus` to a small enum: `correctness`, `security`, `tests`,
      `architecture`, `performance`, and `second-opinion`.
- [ ] Assign the tool the existing `delegate` permission.
- [ ] Inject `LocalDelegationService` through `registerAllTools`; do not access
      global extension state from the handler.
- [ ] Advertise the tool only when delegation is enabled and at least one
      eligible local target exists.
- [ ] Ensure native and fallback tool-call paths enforce the same permission.
- [ ] Keep the delegated request tool-free so recursion is structurally
      impossible.

### A4. Close the MCP permission bypass

External MCP delegation is separate from the native feature, but it must not
bypass the same capability gate.

- [ ] Extend each `mcp_servers` entry with optional per-tool permission
      classification, defaulting to `read` for backward compatibility.
- [ ] Support configuration such as:

```yaml
mcp_servers:
  - name: forgerelay
    tool_permissions:
      dispatch_subagent: delegate
```

- [ ] Validate permission values at the config boundary.
- [ ] Resolve the classification through the canonical permission mechanism.
- [ ] Stop registering every bridged MCP tool unconditionally as `read`.
- [ ] Test that a delegation-classified MCP tool is hidden and blocked unless
      `permissions.agents.delegate: true`. The test must use a stub/fake MCP
      server — the suite must not depend on Forge Relay running.

### A5. Delegation conversation UX

- [ ] Show the target model and consultation focus in the existing tool-activity
      card.
- [ ] Label returned text clearly as delegated analysis.
- [ ] Store only the final tool result in the primary conversation history.
- [ ] Do not create a separate tab or expose the delegated internal exchange.
- [ ] Ensure stopping the primary turn cancels delegated startup and streaming.
- [ ] Make all resource and model errors visible rather than leaving a spinner.

### A6. Delegation tests

- [ ] Alias and profile resolution.
- [ ] Same-model/profile delegation.
- [ ] Different-model delegation with capacity available.
- [ ] Rejection when delegation would evict the primary model.
- [ ] Atomic protection against check/acquire races.
- [ ] Local Ollama and direct llama.cpp routing.
- [ ] Rejection of Ollama cloud and all direct cloud providers.
- [ ] Permission disabled/enabled advertisement and dispatch behavior.
- [ ] Native and fallback call-path permission enforcement.
- [ ] MCP per-tool delegation permission enforcement.
- [ ] Workspace traversal and out-of-workspace symlink rejection.
- [ ] File-count, per-file-size, combined-size, task, result, and token limits.
- [ ] Cancellation during backend startup and response streaming.
- [ ] Timeout behavior.
- [ ] Delegated requests contain no tool definitions.
- [ ] Recursive delegation is impossible.
- [ ] Backend holds are released after success, cancellation, timeout, and error.

### A7. Delegation documentation and configuration

- [ ] Add a disabled native-delegation example to
      `config/config.example.yaml`.
- [ ] Document that delegation is advisory and read-only.
- [ ] Explain that profiles of one base model share a backend.
- [ ] Explain `max_simultaneous_models`, RAM/VRAM requirements, and the fact that
      slot availability does not guarantee sufficient memory.
- [ ] Document Ollama targets as best-effort.
- [ ] Document MCP per-tool permission classification.
- [ ] Add the delegation service and tool to `docs/OWNERS.md` only after their
      canonical modules exist.

## Workstream B: Remaining Hardening and Onboarding Work

### B1. Restore the canonical CI gate

Current known failure: `npm run ci` stops at Prettier linting in
`src/backend/ControlServer.ts` near the import on line 5.

- [ ] Triage and commit the pre-existing uncommitted worktree changes first
      (the Ollama cloud-alias probe removal + chat-error surfacing work across
      `DirectBackend`, `OllamaAdapter`, `OllamaNativeClient`, `AgentLoop`,
      `reducer`, and tests) as their own commit, so the CI baseline is
      established against a known tree.
- [ ] Fix the formatting violation without changing behavior.
- [ ] Run the complete `npm run ci` command so tests and the normal build run,
      rather than relying on the earlier type-check-only portion.
- [ ] Keep `npm run package` passing.
- [ ] Confirm the worktree's pre-existing unrelated changes are preserved.

### B2. Finish first-run config-generation architecture

Multi-model selection and `Forge: Add Model` exist, but first-run generation is
still embedded in `FirstRunWizard.ts`.

- [ ] Extract first-run config generation into a small canonical tested module.
- [ ] Generate structured config data, validate with `ForgeConfigSchema`, and
      write through `ConfigWriter` rather than maintaining a separate raw-YAML
      write path.
- [ ] Reuse model heuristics for conservative llama.cpp suggestions.
- [ ] Add focused tests for multi-model llama.cpp and Ollama generation.
- [ ] Verify both global and current-workspace destinations are offered
      explicitly during first-run and add-model workflows.
- [ ] Verify conflict handling requires confirmation and never removes existing
      profiles, aliases, or models.
- [ ] Evaluate comment preservation for merges; if it cannot be guaranteed,
      retain preview plus backup behavior and document the limitation.

### B3. Complete Keep/Undo acceptance coverage

Mutation metadata and checkpoint plumbing exist. Complete or verify the edge
cases before declaring the plan done.

- [ ] Audit every registered `write` and `delete` tool for mutation metadata.
- [ ] Verify every mutation reports all affected paths before its first write,
      including editor-derived paths supplied through `beforeMutate`.
- [ ] Define and document directory creation/deletion rollback semantics.
- [ ] Add or confirm tests for partial failure after one of several paths changes.
- [ ] Add or confirm cancellation tests during mutation.
- [ ] Add or confirm repeated writes to the same file in one turn snapshot only
      the original state.
- [ ] Add or confirm new-file, deleted-file, move source/destination, format,
      rename, selection insertion, and multi-file rollback tests.
- [ ] Verify Keep removes exactly one completed turn checkpoint.
- [ ] Verify diff cards, editor decorations, and checkpoint paths use the same
      mutation metadata.

### B4. Complete onboarding/release verification

- [ ] Verify generated configs contain no API keys or machine-specific
      maintainer paths.
- [ ] Verify starter templates remain minimal, sanitized, and schema-valid.
- [ ] Run the planned one-time repository-history secret scan before release.
- [ ] Rewrite history only if a real secret is found and credential rotation is
      coordinated.
- [ ] Manually smoke-test first-run setup for several GGUF files.
- [ ] Manually smoke-test first-run setup for several Ollama tags.
- [ ] Manually verify adding models preserves existing configuration.

## Workstream C: Ownership Map Corrections

- [ ] Resolve the stale `src/tools/ConfirmationGate.ts` entry in
      `docs/OWNERS.md`: either point the concern to the actual confirmation-gate
      owner or create the module only if a real extraction boundary requires it.
- [ ] Recheck every documented owner path after delegation modules are added.
- [ ] Keep `src/tools/resultCap.ts` as the single result-capping owner.
- [ ] Add no delegation owner entries before the corresponding implementation
      exists.

## Recommended Implementation Order

1. Commit the pre-existing WIP, fix the CI formatting failure, and establish a
   green baseline.
2. Make backend delegation safety atomic and fully tested.
3. Implement `LocalDelegationService` with limits, cancellation, and no tools.
4. Register `ask_local_agent` behind the `delegate` permission.
5. Close the MCP per-tool permission bypass.
6. Add delegation UX, tests, configuration examples, and documentation.
7. Finish first-run config-generation extraction and tests.
8. Complete Keep/Undo edge-case coverage and release verification.
9. Correct and re-audit `docs/OWNERS.md`.

## Required Final Gates

```bash
npm run ci
npm run package
```

Manual delegation smoke cases:

1. one model consulting another profile of itself;
2. two llama.cpp models with `max_simultaneous_models: 2`;
3. capacity `1`, producing a clear rejection without eviction;
4. local Ollama delegation, including a visible daemon-side load failure;
5. cancellation during startup and streaming;
6. delegation disabled, confirming the tool is hidden and blocked;
7. Relay MCP delegation classified as `delegate`, confirming the same gate.

## Definition of Done

- `ask_local_agent` performs bounded, local, tool-free consultation.
- The primary backend cannot be evicted by a delegation request.
- Cloud and unknown delegation targets are rejected.
- Permissions are enforced for native, fallback, and MCP-bridged delegation.
- Cancellation, timeout, capacity, startup, and memory-related failures are
  visible and release resources.
- First-run and add-model configuration paths validate before atomic writes.
- Every workspace mutation has complete Keep/Undo coverage.
- `docs/OWNERS.md` matches the actual source tree.
- `npm run ci` and `npm run package` both pass.
